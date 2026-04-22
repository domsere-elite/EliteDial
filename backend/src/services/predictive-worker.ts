import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../utils/logger';
import { providerRegistry } from './provider-registry';
import { callSessionService } from './call-session-service';
import { phoneNumberService } from './phone-number-service';
import { campaignReservationService } from './campaign-reservation-service';
import { computeDialerGuardrails, DIALER_STATS_WINDOW_MINUTES } from './dialer-guardrails';
import { callAuditService } from './call-audit';
import { isWithinCallingWindow, getContactTimezone } from './tcpa';

type WorkerStats = {
    cycleStartedAt: string;
    campaignsChecked: number;
    contactsDialed: number;
    campaignsBlocked: number;
};

const DIALER_MODE = config.dialer.mode;
const POLL_INTERVAL_MS = config.dialer.pollIntervalMs;

type CampaignWithCount = {
    id: string;
    name: string;
    status: string;
    dialMode: string;
    timezone: string;
    maxAttemptsPerLead: number;
    abandonRateLimit: number;
    dialRatio: number;
    retryDelaySeconds: number;
    maxConcurrentCalls: number;
    aiTargetEnabled: boolean;
    aiTarget: string | null;
    _count: { contacts: number };
};

type CampaignContactRow = {
    id: string;
    externalId: string | null;
    primaryPhone: string;
    accountId: string | null;
    attemptCount: number;
    timezone: string | null;
};

type ReservedWorkerContact = CampaignContactRow & {
    reservationToken: string;
};

export class PredictiveWorker {
    private interval: NodeJS.Timeout | null = null;
    private isRunning = false;
    private cycleLock = false; // Mutex to prevent overlapping cycles
    private lastRunAt: string | null = null;
    private lastError: string | null = null;
    private lastStats: WorkerStats | null = null;
    private skippedCycles = 0;

    start() {
        if (this.interval) return;
        logger.info('PredictiveWorker starting', { mode: DIALER_MODE, pollIntervalMs: POLL_INTERVAL_MS });
        this.interval = setInterval(() => {
            void this.cycle();
        }, POLL_INTERVAL_MS);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        logger.info('PredictiveWorker stopped');
    }

    getStatus() {
        return {
            running: !!this.interval,
            mode: DIALER_MODE,
            pollIntervalMs: POLL_INTERVAL_MS,
            cycleInProgress: this.isRunning,
            cycleLocked: this.cycleLock,
            skippedCycles: this.skippedCycles,
            lastRunAt: this.lastRunAt,
            lastError: this.lastError,
            lastStats: this.lastStats,
        };
    }

    async runNow(): Promise<WorkerStats | null> {
        await this.cycle();
        return this.lastStats;
    }

    private async cycle() {
        // Mutex: skip if a previous cycle is still running
        if (this.cycleLock) {
            this.skippedCycles += 1;
            logger.warn('PredictiveWorker cycle skipped — previous cycle still running', {
                skippedCycles: this.skippedCycles,
            });
            return;
        }

        this.cycleLock = true;
        this.isRunning = true;
        this.lastRunAt = new Date().toISOString();

        try {
            const stats = await this.processCampaigns();
            this.lastStats = stats;
            this.lastError = null;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : 'unknown_cycle_error';
            logger.error('PredictiveWorker cycle error', { error: err });
        } finally {
            this.isRunning = false;
            this.cycleLock = false;
        }
    }

    private async processCampaigns() {
        const activeCampaigns = await prisma.campaign.findMany({
            where: {
                status: 'active',
                dialMode: { in: ['predictive', 'progressive'] },
            },
            include: {
                _count: { select: { contacts: true } },
            },
        });

        const stats: WorkerStats = {
            cycleStartedAt: this.lastRunAt || new Date().toISOString(),
            campaignsChecked: activeCampaigns.length,
            contactsDialed: 0,
            campaignsBlocked: 0,
        };

        for (const campaign of activeCampaigns) {
            const result = await this.processCampaign(campaign as CampaignWithCount);
            stats.contactsDialed += result.contactsDialed;
            if (result.blocked) {
                stats.campaignsBlocked += 1;
            }
        }

        return stats;
    }

    private async processCampaign(campaign: CampaignWithCount): Promise<{ contactsDialed: number; blocked: boolean }> {
        const statsWindowStart = new Date(Date.now() - DIALER_STATS_WINDOW_MINUTES * 60 * 1000);
        const [availableAgents, activeCalls, recentCompletedAttempts, recentAbandonedAttempts] = await Promise.all([
            prisma.user.count({ where: { role: { in: ['agent', 'supervisor', 'admin'] }, status: 'available' } }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    status: { in: ['initiated', 'ringing', 'in-progress'] },
                    completedAt: null,
                },
            }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    completedAt: { gte: statsWindowStart },
                },
            }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    completedAt: { gte: statsWindowStart },
                    outcome: 'abandoned',
                },
            }),
        ]);

        const controls = computeDialerGuardrails({
            dialMode: campaign.dialMode,
            dialRatio: campaign.dialRatio,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
            availableAgents,
            activeCalls,
            abandonRateLimit: campaign.abandonRateLimit || 0.03,
            recentCompletedAttempts,
            recentAbandonedAttempts,
            predictiveOverdialEnabled: true,
        });

        if (controls.dispatchCapacity <= 0) {
            logger.info('Predictive campaign blocked by guardrails', {
                campaignId: campaign.id,
                campaign: campaign.name,
                mode: campaign.dialMode,
                availableAgents,
                activeCalls,
                blockedReasons: controls.blockedReasons,
                warnings: controls.warnings,
                effectiveConcurrentLimit: controls.effectiveConcurrentLimit,
                recentAbandonRate: controls.recentAbandonRate,
            });
            if (controls.blockedReasons.length > 0) {
                await callAuditService.track({
                    type: 'dialer.guardrail.blocked',
                    source: 'predictive.worker',
                    status: 'blocked',
                    idempotencyKey: `predictive:${campaign.id}:${this.lastRunAt}:guardrail:${controls.blockedReasons.join(',')}`,
                    details: {
                        campaignId: campaign.id,
                        mode: campaign.dialMode,
                        availableAgents,
                        activeCalls,
                        effectiveConcurrentLimit: controls.effectiveConcurrentLimit,
                        dispatchCapacity: controls.dispatchCapacity,
                        queuePressure: Number(controls.queuePressure.toFixed(2)),
                        recentAbandonRate: Number(controls.recentAbandonRate.toFixed(4)),
                        blockedReasons: controls.blockedReasons.join(','),
                        warnings: controls.warnings.join(','),
                    },
                });
            }
            return { contactsDialed: 0, blocked: controls.blockedReasons.length > 0 };
        }

        // TCPA: Check campaign-level calling window first
        const campaignTz = campaign.timezone || 'America/Chicago';
        if (!isWithinCallingWindow(campaignTz)) {
            logger.info('Predictive campaign blocked by TCPA calling window', {
                campaignId: campaign.id,
                campaign: campaign.name,
                timezone: campaignTz,
            });
            await callAuditService.track({
                type: 'dialer.tcpa.window_blocked',
                source: 'predictive.worker',
                status: 'blocked',
                idempotencyKey: `predictive:${campaign.id}:${this.lastRunAt}:tcpa_window`,
                details: {
                    campaignId: campaign.id,
                    timezone: campaignTz,
                    reason: 'outside_calling_window',
                },
            });
            return { contactsDialed: 0, blocked: true };
        }

        const capacity = controls.dispatchCapacity;

        const contacts: ReservedWorkerContact[] = [];
        for (let i = 0; i < capacity; i += 1) {
            const reserved = await campaignReservationService.reserveNextWorkerContact(campaign);
            if (!reserved) break;
            contacts.push({
                id: reserved.contact.id,
                externalId: reserved.contact.externalId,
                primaryPhone: reserved.contact.primaryPhone,
                accountId: reserved.contact.accountId,
                attemptCount: reserved.contact.attemptCount,
                timezone: reserved.contact.timezone || null,
                reservationToken: reserved.reservationToken,
            });
        }

        if (contacts.length === 0) {
            return { contactsDialed: 0, blocked: false };
        }

        logger.info('Predictive campaign dispatch', {
            campaignId: campaign.id,
            campaign: campaign.name,
            mode: campaign.dialMode,
            workerMode: DIALER_MODE,
            availableAgents,
            activeCalls,
            capacity,
            effectiveConcurrentLimit: controls.effectiveConcurrentLimit,
            blockedReasons: controls.blockedReasons,
            warnings: controls.warnings,
            selectedContacts: contacts.length,
        });

        for (const contact of contacts) {
            // TCPA: Per-contact timezone check
            const contactTz = getContactTimezone(contact.timezone, campaignTz);
            if (!isWithinCallingWindow(contactTz)) {
                logger.info('Skipping contact — outside TCPA calling window', {
                    contactId: contact.id,
                    timezone: contactTz,
                });
                continue;
            }

            if (DIALER_MODE === 'mock') {
                await this.mockDial(campaign, contact);
            } else {
                await this.liveDial(campaign, contact);
            }
        }

        return { contactsDialed: contacts.length, blocked: false };
    }

    private async mockDial(campaign: CampaignWithCount, contact: ReservedWorkerContact) {
        const retryDelayMs = Math.max(30, campaign.retryDelaySeconds) * 1000;
        const duration = Math.floor(Math.random() * 120) + 20;
        const outcomePick = Math.random();
        const status = outcomePick > 0.55 ? 'completed' : outcomePick > 0.25 ? 'no-answer' : 'failed';
        const nextStatus = status === 'completed'
            ? 'completed'
            : (contact.attemptCount + 1 >= campaign.maxAttemptsPerLead ? 'failed' : 'queued');
        const { number: fromNumber, didResult } = await phoneNumberService.resolveOutboundDID({
            toNumber: contact.primaryPhone,
            campaignId: campaign.id,
            contactId: contact.id,
        });
        const claimedContact = await campaignReservationService.confirmDialReservation(contact.id, {
            type: 'worker',
            token: contact.reservationToken,
        });
        if (!claimedContact) return;

        const { call } = await callSessionService.createUnifiedCall({
            provider: 'mock',
            channel: 'human',
            mode: campaign.dialMode as 'predictive' | 'progressive',
            direction: 'outbound',
            fromNumber,
            toNumber: contact.primaryPhone,
            status,
            accountId: contact.accountId,
            campaignId: campaign.id,
            contactId: contact.id,
            leadExternalId: contact.externalId,
            dncChecked: true,
            fdcpaNotice: true,
            duration: status === 'completed' ? duration : 0,
            completedAt: ['completed', 'no-answer', 'failed'].includes(status) ? new Date() : null,
            providerMetadata: { workerMode: DIALER_MODE, didMatchTier: didResult?.matchTier || 'fallback', didAreaCode: didResult?.areaCode || null },
        });

        await prisma.campaignAttempt.create({
            data: {
                campaignId: campaign.id,
                contactId: contact.id,
                callId: call.id,
                status,
                outcome: status === 'completed' ? 'human' : status,
                completedAt: ['completed', 'no-answer', 'failed'].includes(status) ? new Date() : null,
            },
        });

        if (nextStatus === 'completed') {
            await campaignReservationService.completeReservation(contact.id, 'completed');
            return;
        }

        await campaignReservationService.failReservation(contact.id, nextStatus, new Date(Date.now() + retryDelayMs));
    }

    private async liveDial(campaign: CampaignWithCount, contact: ReservedWorkerContact) {
        const retryDelayMs = Math.max(30, campaign.retryDelaySeconds) * 1000;
        const { number: fromNumber } = await phoneNumberService.resolveOutboundDID({
            toNumber: contact.primaryPhone,
            campaignId: campaign.id,
            contactId: contact.id,
        });

        try {
            const claimedContact = await campaignReservationService.confirmDialReservation(contact.id, {
                type: 'worker',
                token: contact.reservationToken,
            });
            if (!claimedContact) return;

            const { call } = await callSessionService.createUnifiedCall({
                provider: providerRegistry.getPrimaryTelephonyProvider().name,
                channel: 'human',
                mode: campaign.dialMode as 'predictive' | 'progressive',
                direction: 'outbound',
                fromNumber,
                toNumber: contact.primaryPhone,
                status: 'initiated',
                accountId: contact.accountId,
                campaignId: campaign.id,
                contactId: contact.id,
                leadExternalId: contact.externalId,
                dncChecked: true,
                fdcpaNotice: true,
            });

            const attempt = await prisma.campaignAttempt.create({
                data: {
                    campaignId: campaign.id,
                    contactId: contact.id,
                    callId: call.id,
                    status: 'initiated',
                },
            });

            const callbackUrl = config.publicUrls.backend || `http://localhost:${config.port}`;

            const result = await providerRegistry.getPrimaryTelephonyProvider().initiateOutboundCall({
                fromNumber,
                toNumber: contact.primaryPhone,
                callbackUrl,
                amdEnabled: config.amd.enabled,
                metadata: {
                    campaignId: campaign.id,
                    contactId: contact.id,
                    callId: call.id,
                    attemptId: attempt.id,
                },
                clientState: {
                    stage: 'predictive-pending',
                    campaignId: campaign.id,
                    contactId: contact.id,
                    attemptId: attempt.id,
                    callId: call.id,
                },
            });

            if (!result?.providerCallId) {
                await prisma.call.update({
                    where: { id: call.id },
                    data: { status: 'failed', completedAt: new Date() },
                });
                await callSessionService.syncCall(call.id, {
                    status: 'failed',
                    provider: providerRegistry.getPrimaryTelephonyProvider().name,
                });
                await prisma.campaignAttempt.update({
                    where: { id: attempt.id },
                    data: { status: 'failed', outcome: 'failed', completedAt: new Date() },
                });

                const maxedOut = contact.attemptCount + 1 >= campaign.maxAttemptsPerLead;
                await campaignReservationService.failReservation(
                    contact.id,
                    maxedOut ? 'failed' : 'queued',
                    maxedOut ? null : new Date(Date.now() + retryDelayMs),
                );
                return;
            }

            await callSessionService.attachProviderIdentifiers(call.id, {
                provider: result.provider,
                providerCallId: result.providerCallId,
                providerMetadata: result.raw || undefined,
            });
            await prisma.call.update({
                where: { id: call.id },
                data: { status: 'ringing' },
            });
            await prisma.campaignAttempt.update({
                where: { id: attempt.id },
                data: { status: 'ringing' },
            });

            logger.info('Predictive live dial initiated (over-dial, no pre-reserve)', {
                campaignId: campaign.id,
                contactId: contact.id,
                callId: call.id,
                providerCallId: result.providerCallId,
            });
        } catch (error) {
            logger.error('Predictive live dial failed', { error, campaignId: campaign.id, contactId: contact.id });
            const maxedOut = contact.attemptCount + 1 >= campaign.maxAttemptsPerLead;
            await campaignReservationService.failReservation(
                contact.id,
                maxedOut ? 'failed' : 'queued',
                maxedOut ? null : new Date(Date.now() + retryDelayMs),
            );
        }
    }
}

export const predictiveWorker = new PredictiveWorker();
