/**
 * AIAutonomousWorker — dispatch loop for AI Autonomous dial mode.
 *
 * Responsibilities:
 *  - Poll active ai_autonomous campaigns on an interval
 *  - For each campaign, reserve contacts up to the concurrency cap
 *  - Run precheck; on fail write blocked row and skip (no slot acquired)
 *  - Acquire a concurrency slot, initiate the call via SignalWire → Retell bridge
 *  - On REST failure: release the slot and re-queue the contact
 *  - Release slots when calls reach a terminal state (via event bus)
 *  - Per-campaign serialisation: concurrent tick() calls for the same campaign
 *    await the in-progress tick rather than double-dispatching
 */

import { logger } from '../utils/logger';
import type { ConcurrencyLimiter } from './concurrency-limiter';
import type { EventBus } from '../lib/event-bus';
import type { DialPrecheck, DialPrecheckResult } from './dial-precheck';
import type { CampaignContact } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignSlim {
    id: string;
    dialMode: string;
    status: string;
    maxConcurrentCalls: number;
    retryDelaySeconds: number;
    timezone: string | null;
    retellAgentId: string | null;
    retellSipAddress: string | null;
    retellAgentPromptVersion: string | null;
}

export interface ReserveResult {
    contact: Pick<CampaignContact, 'id' | 'primaryPhone' | 'timezone'>;
    reservationToken: string;
}

export interface AIAutonomousWorkerDeps {
    limiter: ConcurrencyLimiter;
    eventBus: EventBus;
    precheck: DialPrecheck;
    loadCampaign: (id: string) => Promise<CampaignSlim | null>;
    listActiveAiCampaigns: () => Promise<{ id: string }[]>;
    reserveNext: (campaign: CampaignSlim) => Promise<ReserveResult | null>;
    confirmDial: (contactId: string, token: string) => Promise<void>;
    failReservation: (contactId: string, status: 'queued' | 'failed', nextAttemptAt: Date | null) => Promise<void>;
    applyBlockedStatus: (contactId: string, pre: DialPrecheckResult) => Promise<void>;
    writeBlockedCallRow: (campaign: CampaignSlim, contact: ReserveResult['contact'], reasons: string[]) => Promise<void>;
    writeInitiatedCallRow: (campaign: CampaignSlim, contact: ReserveResult['contact'], result: { provider: string; providerCallId: string }) => Promise<void>;
    initiateCall: (req: {
        fromNumber: string;
        toNumber: string;
        callbackUrl: string;
        swmlQuery: Record<string, string>;
        metadata?: Record<string, unknown>;
    }) => Promise<{ provider: string; providerCallId: string } | null>;
    pickDid: (campaign: CampaignSlim, contact: ReserveResult['contact']) => Promise<string | null>;
    callbackUrl: string;
    intervalMs?: number;
    clock?: () => Date;
}

export interface AIAutonomousWorker {
    start(): Promise<void>;
    stop(): void;
    tick(campaignId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildAIAutonomousWorker(deps: AIAutonomousWorkerDeps): AIAutonomousWorker {
    const {
        limiter,
        eventBus,
        precheck,
        loadCampaign,
        listActiveAiCampaigns,
        reserveNext,
        confirmDial,
        failReservation,
        applyBlockedStatus,
        writeBlockedCallRow,
        writeInitiatedCallRow,
        initiateCall,
        pickDid,
        callbackUrl,
        intervalMs = 5_000,
        clock = () => new Date(),
    } = deps;

    // Per-campaign in-flight promise for serialisation.
    const inFlight = new Map<string, Promise<void>>();

    // One-time-per-session log flags to avoid log spam.
    const loggedSkip = new Set<string>();

    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    // Bound event handlers (stored so we can unsubscribe).
    let onTerminal: ((p: { callId: string; signalwireCallId: string; campaignId: string | null; status: string }) => void) | null = null;
    let onActivated: ((p: { campaignId: string }) => void) | null = null;
    let onPaused: ((p: { campaignId: string }) => void) | null = null;

    // -----------------------------------------------------------------------
    // Core campaign tick
    // -----------------------------------------------------------------------

    async function runOnce(campaignId: string): Promise<void> {
        // Load and validate campaign.
        const campaign = await loadCampaign(campaignId);
        if (!campaign || campaign.status !== 'active' || campaign.dialMode !== 'ai_autonomous') {
            return;
        }

        // Skip if Retell config missing.
        if (!campaign.retellAgentId || !campaign.retellSipAddress || !campaign.retellAgentPromptVersion) {
            const skipKey = `retell-missing:${campaignId}`;
            if (!loggedSkip.has(skipKey)) {
                loggedSkip.add(skipKey);
                logger.warn('ai-autonomous-worker: skipping campaign — missing Retell config', { campaignId });
            }
            return;
        }

        const cap = campaign.maxConcurrentCalls;

        // Skip if cap is 0.
        if (cap <= 0) {
            const skipKey = `cap-zero:${campaignId}`;
            if (!loggedSkip.has(skipKey)) {
                loggedSkip.add(skipKey);
                logger.warn('ai-autonomous-worker: skipping campaign — maxConcurrentCalls=0', { campaignId });
            }
            return;
        }

        // Dispatch loop: fill slots up to the cap.
        while (limiter.active(campaignId) < cap) {
            const reserved = await reserveNext(campaign);
            if (!reserved) break;

            const { contact, reservationToken } = reserved;

            // Precheck (DNC, TCPA, Reg F).
            // CampaignSlim.timezone may be null; DialPrecheck expects Pick<Campaign, 'timezone'>
            // where Campaign.timezone is string. Cast to satisfy the interface — the implementation
            // handles null internally (falls back to contact timezone).
            const pre = await precheck.precheck(
                campaign as unknown as import('@prisma/client').Campaign,
                contact,
            );
            if (!pre.allowed) {
                // Write blocked Call row and update contact status. No slot acquired.
                await writeBlockedCallRow(campaign, contact, pre.blockedReasons);
                await applyBlockedStatus(contact.id, pre);
                continue;
            }

            // Acquire a concurrency slot.
            if (!limiter.acquire(campaignId, cap)) {
                // Cap was reached between the while-check and now (shouldn't happen
                // in a single-threaded JS tick, but guard anyway).
                await failReservation(contact.id, 'queued', null);
                break;
            }

            // Attempt to initiate the call. Release the slot on any failure.
            try {
                await confirmDial(contact.id, reservationToken);

                const did = await pickDid(campaign, contact);
                const fromNumber = did || '';

                const result = await initiateCall({
                    fromNumber,
                    toNumber: contact.primaryPhone,
                    callbackUrl,
                    swmlQuery: {
                        mode: 'ai_autonomous',
                        campaignId: campaign.id,
                        from: fromNumber,
                    },
                    metadata: {
                        campaignId: campaign.id,
                        contactId: contact.id,
                        retellAgentId: campaign.retellAgentId!,
                    },
                });

                if (!result) {
                    // REST call returned null — treat as failure.
                    limiter.release(campaignId);
                    const retryAt = new Date(clock().getTime() + campaign.retryDelaySeconds * 1000);
                    await failReservation(contact.id, 'queued', retryAt);
                    continue;
                }

                await writeInitiatedCallRow(campaign, contact, result);
            } catch (err) {
                logger.error('ai-autonomous-worker: call initiation error', { campaignId, contactId: contact.id, error: err });
                limiter.release(campaignId);
                const retryAt = new Date(clock().getTime() + campaign.retryDelaySeconds * 1000);
                await failReservation(contact.id, 'queued', retryAt);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public tick (serialised per campaign)
    // -----------------------------------------------------------------------

    async function tick(campaignId: string): Promise<void> {
        const existing = inFlight.get(campaignId);
        if (existing) {
            // Await the running tick, then return without launching another.
            await existing;
            return;
        }

        const promise = runOnce(campaignId).finally(() => {
            inFlight.delete(campaignId);
        });
        inFlight.set(campaignId, promise);
        await promise;
    }

    // -----------------------------------------------------------------------
    // start / stop
    // -----------------------------------------------------------------------

    async function start(): Promise<void> {
        await limiter.rebuildFromDb();

        // Event: call reached terminal state → release slot + re-tick.
        onTerminal = (payload) => {
            if (payload.campaignId) {
                limiter.release(payload.campaignId);
                tick(payload.campaignId).catch((err) => {
                    logger.error('ai-autonomous-worker: tick error on terminal event', { error: err });
                });
            }
        };

        // Event: campaign activated → tick immediately.
        onActivated = (payload) => {
            tick(payload.campaignId).catch((err) => {
                logger.error('ai-autonomous-worker: tick error on campaign.activated', { error: err });
            });
        };

        // Event: campaign paused → clear its skip-log entries so we re-log if reactivated.
        onPaused = (payload) => {
            for (const key of loggedSkip) {
                if (key.endsWith(`:${payload.campaignId}`)) {
                    loggedSkip.delete(key);
                }
            }
        };

        eventBus.on('call.terminal', onTerminal);
        eventBus.on('campaign.activated', onActivated);
        eventBus.on('campaign.paused', onPaused);

        intervalHandle = setInterval(async () => {
            try {
                const campaigns = await listActiveAiCampaigns();
                await Promise.all(campaigns.map((c) => tick(c.id).catch((err) => {
                    logger.error('ai-autonomous-worker: tick error in interval', { campaignId: c.id, error: err });
                })));
                limiter.sweepStuck();
            } catch (err) {
                logger.error('ai-autonomous-worker: interval error', { error: err });
            }
        }, intervalMs);
    }

    function stop(): void {
        if (intervalHandle) {
            clearInterval(intervalHandle);
            intervalHandle = null;
        }
        if (onTerminal) { eventBus.off('call.terminal', onTerminal); onTerminal = null; }
        if (onActivated) { eventBus.off('campaign.activated', onActivated); onActivated = null; }
        if (onPaused) { eventBus.off('campaign.paused', onPaused); onPaused = null; }
    }

    return { start, stop, tick };
}

// ---------------------------------------------------------------------------
// Default singleton wiring
// ---------------------------------------------------------------------------

import { prisma } from '../lib/prisma';
import { concurrencyLimiter } from './concurrency-limiter';
import { eventBus } from '../lib/event-bus';
import { dialPrecheck } from './dial-precheck';
import { campaignReservationService } from './campaign-reservation-service';
import { callSessionService } from './call-session-service';
import { signalwireService } from './signalwire';
import { didRouter } from './did-router';
import { config } from '../config';

const defaultCallbackUrl =
    config.publicUrls?.backend || `http://localhost:${config.port}`;

const defaultLoadCampaign = async (id: string): Promise<CampaignSlim | null> => {
    return prisma.campaign.findUnique({
        where: { id },
        select: {
            id: true,
            dialMode: true,
            status: true,
            maxConcurrentCalls: true,
            retryDelaySeconds: true,
            timezone: true,
            retellAgentId: true,
            retellSipAddress: true,
            retellAgentPromptVersion: true,
        },
    });
};

const defaultListActiveAiCampaigns = async (): Promise<{ id: string }[]> => {
    return prisma.campaign.findMany({
        where: { dialMode: 'ai_autonomous', status: 'active' },
        select: { id: true },
    });
};

const defaultReserveNext = async (campaign: CampaignSlim): Promise<ReserveResult | null> => {
    return campaignReservationService.reserveNextWorkerContact({ id: campaign.id });
};

const defaultConfirmDial = async (contactId: string, token: string): Promise<void> => {
    await campaignReservationService.confirmDialReservation(contactId, { type: 'worker', token });
};

const defaultFailReservation = async (
    contactId: string,
    status: 'queued' | 'failed',
    nextAttemptAt: Date | null,
): Promise<void> => {
    await campaignReservationService.failReservation(contactId, status, nextAttemptAt);
};

const defaultApplyBlockedStatus = async (
    contactId: string,
    pre: DialPrecheckResult,
): Promise<void> => {
    const nextAttemptAt = pre.deferUntil || null;
    const nextStatus = pre.blockedReasons.includes('tcpa_quiet_hours') ? 'queued' : 'failed';
    await campaignReservationService.failReservation(contactId, nextStatus as 'queued' | 'failed', nextAttemptAt);
};

const defaultWriteBlockedCallRow = async (
    campaign: CampaignSlim,
    contact: ReserveResult['contact'],
    reasons: string[],
): Promise<void> => {
    const { call } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'ai',
        mode: 'ai_outbound',
        direction: 'outbound',
        fromNumber: '',
        toNumber: contact.primaryPhone,
        status: 'blocked-precheck',
        campaignId: campaign.id,
        contactId: contact.id,
    });
    await prisma.call.update({
        where: { id: call.id },
        data: {
            precheckBlockedReasons: reasons.join(','),
            retellAgentPromptVersion: campaign.retellAgentPromptVersion,
        },
    });
};

const defaultWriteInitiatedCallRow = async (
    campaign: CampaignSlim,
    contact: ReserveResult['contact'],
    result: { provider: string; providerCallId: string },
): Promise<void> => {
    const { call } = await callSessionService.createUnifiedCall({
        provider: result.provider,
        channel: 'ai',
        mode: 'ai_outbound',
        direction: 'outbound',
        fromNumber: '',
        toNumber: contact.primaryPhone,
        status: 'initiated',
        providerCallId: result.providerCallId,
        campaignId: campaign.id,
        contactId: contact.id,
    });
    await prisma.call.update({
        where: { id: call.id },
        data: {
            signalwireCallId: result.provider === 'signalwire' ? result.providerCallId : undefined,
            retellAgentPromptVersion: campaign.retellAgentPromptVersion,
        },
    });
    await prisma.campaignAttempt.create({
        data: {
            campaignId: campaign.id,
            contactId: contact.id,
            callId: call.id,
            status: 'initiated',
        },
    });
};

const defaultPickDid = async (
    campaign: CampaignSlim,
    contact: ReserveResult['contact'],
): Promise<string | null> => {
    const selected = await didRouter.selectOutboundDID({
        toNumber: contact.primaryPhone,
        campaignId: campaign.id,
        contactId: contact.id,
    });
    return selected?.number || config.telephony.defaultOutboundNumber || null;
};

const defaultInitiateCall = async (req: {
    fromNumber: string;
    toNumber: string;
    callbackUrl: string;
    swmlQuery: Record<string, string>;
    metadata?: Record<string, unknown>;
}): Promise<{ provider: string; providerCallId: string } | null> => {
    const result = await signalwireService.initiateOutboundCall({
        fromNumber: req.fromNumber,
        toNumber: req.toNumber,
        callbackUrl: req.callbackUrl,
        swmlQuery: req.swmlQuery,
        metadata: req.metadata,
    });
    if (!result) return null;
    return { provider: result.provider, providerCallId: result.providerCallId };
};

export const aiAutonomousWorker: AIAutonomousWorker = buildAIAutonomousWorker({
    limiter: concurrencyLimiter,
    eventBus,
    precheck: dialPrecheck,
    loadCampaign: defaultLoadCampaign,
    listActiveAiCampaigns: defaultListActiveAiCampaigns,
    reserveNext: defaultReserveNext,
    confirmDial: defaultConfirmDial,
    failReservation: defaultFailReservation,
    applyBlockedStatus: defaultApplyBlockedStatus,
    writeBlockedCallRow: defaultWriteBlockedCallRow,
    writeInitiatedCallRow: defaultWriteInitiatedCallRow,
    initiateCall: defaultInitiateCall,
    pickDid: defaultPickDid,
    callbackUrl: defaultCallbackUrl,
    intervalMs: config.dialer.pollIntervalMs,
});
