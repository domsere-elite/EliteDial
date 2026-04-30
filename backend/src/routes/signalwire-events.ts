import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { webhookEngine } from '../services/webhook-engine';
import { callSessionService } from '../services/call-session-service';
import { callAuditService } from '../services/call-audit';
import { crmAdapter } from '../services/crm-adapter';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { logger } from '../utils/logger';
import { eventBus } from '../lib/event-bus';
import { broadcastCallStatus } from '../lib/realtime';
import { wrapUpService } from '../services/wrap-up-service';
import { scheduleAutoResume } from '../services/wrap-up-scheduler';

const SIGNALWIRE_STATE_MAP: Record<string, string> = {
    queued: 'initiated',
    created: 'initiated',
    ringing: 'ringing',
    answered: 'in-progress',
    ended: 'completed',
};

const TERMINAL_STATES = new Set(['completed', 'failed', 'no-answer', 'busy']);

export interface SignalwireEventsDeps {
    callSessionUpdate: typeof defaultCallSessionUpdate;
    callSessionAddRecording: typeof defaultAddRecording;
    dispatchWebhook: typeof defaultDispatchWebhook;
    auditTrack: typeof defaultAuditTrack;
    prismaUpdateCall: typeof defaultPrismaUpdateCall;
    prismaUpdateCampaignAttempt: typeof defaultPrismaUpdateCampaignAttempt;
    prismaFindCallWithAttempt: typeof defaultFindCallWithAttempt;
    prismaFindCompletedCall: typeof defaultFindCompletedCall;
    enterWrapUp: typeof defaultEnterWrapUp;
    crmPostCallEvent: typeof defaultCrmPostCallEvent;
    reservationComplete: typeof defaultReservationComplete;
}

async function defaultCallSessionUpdate(params: {
    provider: string;
    providerCallId: string;
    status: string;
    duration: number;
    answeredAt: Date | null;
    completedAt: Date | null;
}) {
    await callSessionService.updateProviderStatus(params);
}

async function defaultAddRecording(params: {
    provider: string;
    providerCallId: string;
    callId?: string;
    url: string;
    status: string;
}) {
    await callSessionService.addRecording(params);
}

async function defaultDispatchWebhook(event: string, payload: unknown) {
    // ⚠️ DEVIATION 1: webhookEngine.dispatch expects (WebhookEvent, Record<string, any>);
    // cast the inputs since the deps interface uses looser types for testability.
    await webhookEngine.dispatch(event as any, payload as any);
}

async function defaultAuditTrack(params: Parameters<typeof callAuditService.track>[0]) {
    await callAuditService.track(params);
}

async function defaultPrismaUpdateCall(callId: string, data: Record<string, unknown>) {
    await prisma.call.updateMany({
        where: { signalwireCallId: callId },
        data,
    });
}

async function defaultPrismaUpdateCampaignAttempt(attemptId: string, data: Record<string, unknown>) {
    await prisma.campaignAttempt.update({ where: { id: attemptId }, data });
}

async function defaultFindCallWithAttempt(callId: string) {
    return prisma.call.findFirst({
        where: { signalwireCallId: callId },
        select: {
            id: true,
            agentId: true,
            accountId: true,
            campaignAttempts: {
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: {
                    id: true,
                    contactId: true,
                    campaignId: true,
                    contact: {
                        select: {
                            id: true,
                            attemptCount: true,
                            campaign: {
                                select: {
                                    id: true,
                                    maxAttemptsPerLead: true,
                                    retryDelaySeconds: true,
                                    wrapUpSeconds: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    });
}

// Resolve the agent + (optionally) call/account context for a terminal
// call-status webhook. Calls live in two tables:
//   1. Call — created by manual softphone outbound, inbound, AI-autonomous
//   2. PowerDialLeg — created by the progressive power-dial worker; no
//      Call row is ever written. The agent owning the leg is derived via
//      the parent PowerDialBatch.agentId.
// We must check both, otherwise power-dial answers leave the agent stuck
// in `on-call` state because enterWrapUp is never invoked.
export interface CompletedCallContext {
    id: string | null;
    agentId: string | null;
    accountId: string | null;
}

export interface CompletedCallLookupDeps {
    findCallByProviderId: (providerCallId: string) => Promise<{ id: string; agentId: string | null; accountId: string | null } | null>;
    findPowerDialLegByProviderId: (providerCallId: string) => Promise<{ id: string; batch: { agentId: string } } | null>;
}

export async function resolveCompletedCallContext(
    deps: CompletedCallLookupDeps,
    providerCallId: string,
): Promise<CompletedCallContext | null> {
    const call = await deps.findCallByProviderId(providerCallId);
    if (call) return { id: call.id, agentId: call.agentId, accountId: call.accountId };
    const leg = await deps.findPowerDialLegByProviderId(providerCallId);
    if (leg) return { id: leg.id, agentId: leg.batch.agentId, accountId: null };
    return null;
}

async function defaultFindCompletedCall(callId: string): Promise<CompletedCallContext | null> {
    return resolveCompletedCallContext(
        {
            findCallByProviderId: (id) =>
                prisma.call.findFirst({
                    where: { signalwireCallId: id },
                    select: { id: true, agentId: true, accountId: true },
                }),
            findPowerDialLegByProviderId: (id) =>
                prisma.powerDialLeg.findFirst({
                    where: { providerCallId: id },
                    select: { id: true, batch: { select: { agentId: true } } },
                }),
        },
        callId,
    );
}

async function defaultEnterWrapUp(agentId: string, wrapUpSeconds: number) {
    const result = await wrapUpService.enterWrapUp(agentId, wrapUpSeconds);
    if (result.transitioned) {
        scheduleAutoResume(agentId, wrapUpSeconds);
    }
}

async function defaultCrmPostCallEvent(payload: Parameters<typeof crmAdapter.postCallEvent>[0]) {
    await crmAdapter.postCallEvent(payload);
}

async function defaultReservationComplete(contactId: string, status: string, retryAt: Date | null) {
    await campaignReservationService.completeReservation(contactId, status as any, retryAt);
}

const defaultDeps: SignalwireEventsDeps = {
    callSessionUpdate: defaultCallSessionUpdate,
    callSessionAddRecording: defaultAddRecording,
    dispatchWebhook: defaultDispatchWebhook,
    auditTrack: defaultAuditTrack,
    prismaUpdateCall: defaultPrismaUpdateCall,
    prismaUpdateCampaignAttempt: defaultPrismaUpdateCampaignAttempt,
    prismaFindCallWithAttempt: defaultFindCallWithAttempt,
    prismaFindCompletedCall: defaultFindCompletedCall,
    enterWrapUp: defaultEnterWrapUp,
    crmPostCallEvent: defaultCrmPostCallEvent,
    reservationComplete: defaultReservationComplete,
};

export function createSignalwireEventsRouter(deps: SignalwireEventsDeps = defaultDeps): Router {
    const router = Router();

    router.post('/call-status', async (req: Request, res: Response): Promise<void> => {
        const { call_id, call_state, duration } = req.body || {};
        if (!call_id || typeof call_id !== 'string') {
            res.status(200).json({ status: 'ignored', reason: 'missing_call_id' });
            return;
        }

        const mappedStatus = SIGNALWIRE_STATE_MAP[call_state as string] || (call_state as string) || 'unknown';
        const durationSec = typeof duration === 'number' ? duration : parseInt(duration || '0', 10);

        await deps.auditTrack({
            type: 'call.status',
            callSid: call_id,
            details: { status: mappedStatus, duration: durationSec },
            source: 'signalwire.call_status',
            status: mappedStatus,
            idempotencyKey: `signalwire:${call_id}:status:${mappedStatus}:${durationSec}`,
        });

        await deps.callSessionUpdate({
            provider: 'signalwire',
            providerCallId: call_id,
            status: mappedStatus,
            duration: durationSec,
            answeredAt: mappedStatus === 'in-progress' ? new Date() : null,
            completedAt: TERMINAL_STATES.has(mappedStatus) ? new Date() : null,
        });

        await deps.prismaUpdateCall(call_id, {
            status: mappedStatus,
            duration: durationSec,
            ...(TERMINAL_STATES.has(mappedStatus) ? { completedAt: new Date() } : {}),
        });

        const withAttempt = await deps.prismaFindCallWithAttempt(call_id);
        const attempt = withAttempt?.campaignAttempts?.[0];
        if (attempt) {
            if (mappedStatus === 'ringing' || mappedStatus === 'in-progress') {
                await deps.prismaUpdateCampaignAttempt(attempt.id, {
                    status: mappedStatus,
                    ...(mappedStatus === 'in-progress' ? { outcome: 'human' } : {}),
                });
            }
            if (TERMINAL_STATES.has(mappedStatus)) {
                const outcomeMap: Record<string, string> = {
                    completed: 'human',
                    failed: 'failed',
                    'no-answer': 'no-answer',
                    busy: 'busy',
                };
                await deps.prismaUpdateCampaignAttempt(attempt.id, {
                    status: mappedStatus,
                    outcome: outcomeMap[mappedStatus] || mappedStatus,
                    completedAt: new Date(),
                });
                const maxAttempts = attempt.contact.campaign.maxAttemptsPerLead;
                const retryMs = Math.max(30, attempt.contact.campaign.retryDelaySeconds) * 1000;
                const exhausted = attempt.contact.attemptCount >= maxAttempts;
                const nextContactStatus = mappedStatus === 'completed' ? 'completed' : exhausted ? 'failed' : 'queued';
                await deps.reservationComplete(
                    attempt.contactId,
                    nextContactStatus,
                    nextContactStatus === 'queued' ? new Date(Date.now() + retryMs) : null,
                );
            }
        }

        if (TERMINAL_STATES.has(mappedStatus)) {
            const completed = await deps.prismaFindCompletedCall(call_id);
            if (completed?.agentId) {
                const wrapUpSeconds = withAttempt?.campaignAttempts?.[0]?.contact?.campaign?.wrapUpSeconds ?? 30;
                await deps.enterWrapUp(completed.agentId, wrapUpSeconds);
            }
            if (completed?.id) {
                await deps.crmPostCallEvent({
                    event_type: 'call.completed',
                    call_id: completed.id,
                    provider: 'signalwire',
                    provider_call_id: call_id,
                    status: mappedStatus,
                    duration: durationSec,
                    account_id: completed.accountId || null,
                });
            }
        }

        if (TERMINAL_STATES.has(mappedStatus)) {
            const campaignId = withAttempt?.campaignAttempts?.[0]?.campaignId ?? null;
            const internalCallId = withAttempt?.id ?? '';
            eventBus.emit('call.terminal', {
                callId: internalCallId,
                signalwireCallId: call_id,
                campaignId,
                status: mappedStatus,
            });
        }

        if (mappedStatus === 'in-progress') {
            await deps.dispatchWebhook('call.answered', { callId: call_id, status: mappedStatus });
        } else if (mappedStatus === 'completed') {
            await deps.dispatchWebhook('call.completed', { callId: call_id, status: mappedStatus, duration: durationSec });
        }

        if (withAttempt?.id) {
            broadcastCallStatus({
                callId: withAttempt.id,
                status: mappedStatus,
                agentId: withAttempt.agentId || undefined,
                providerCallId: call_id,
                duration: durationSec,
            });
        }

        res.status(200).json({ status: 'ok' });
    });

    router.post('/recording', async (req: Request, res: Response): Promise<void> => {
        const { call_id, url, state } = req.body || {};
        if (!call_id || !url) {
            res.status(200).json({ status: 'ignored' });
            return;
        }
        try {
            await deps.prismaUpdateCall(call_id, { recordingUrl: url });
            await deps.callSessionAddRecording({
                provider: 'signalwire',
                providerCallId: call_id,
                url,
                status: state === 'finished' ? 'available' : 'pending',
            });
            await deps.auditTrack({
                type: 'call.recording.ready',
                callSid: call_id,
                details: { recordingUrl: url },
                source: 'signalwire.recording',
            });
            logger.info('Recording URL saved', { callId: call_id });
        } catch (err) {
            logger.error('Failed to persist recording', { error: err, call_id });
        }
        res.status(200).json({ status: 'ok' });
    });

    return router;
}

export default createSignalwireEventsRouter();
