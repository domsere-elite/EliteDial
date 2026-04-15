import { TelnyxClient } from './telnyx-client';
import { logger } from '../utils/logger';

export interface PredictiveAnsweredContext {
    callControlId: string;
    campaignId: string;
    contactId: string;
    attemptId: string;
    answeringMachineDetected: boolean;
}

export interface AiOverflowBridgeAnsweredContext {
    callControlId: string;
    bridgeWith: string;
    campaignId: string;
    contactId: string;
}

export interface PredictiveAnswerHandlerDeps {
    client: Pick<TelnyxClient, 'createCall' | 'hangup' | 'bridge'>;
    prisma: {
        user: {
            findFirst: (args: any) => Promise<{ id: string; telnyxSipUsername: string | null } | null>;
            updateMany: (args: any) => Promise<{ count: number }>;
        };
        campaign: {
            findUnique: (args: { where: { id: string } }) => Promise<{ id: string; aiOverflowNumber: string | null } | null>;
        };
        campaignAttempt: {
            update: (args: { where: { id: string }; data: Record<string, any> }) => Promise<any>;
        };
    };
    systemSettings: {
        get: (key: string) => Promise<string | null>;
    };
    callAudit: {
        track: (event: Record<string, any>) => Promise<void>;
    };
    config: {
        connectionId: string;
        sipDomain: string;
        fromNumber: string;
    };
}

export interface PredictiveAnswerHandler {
    onPredictiveAnswered(ctx: PredictiveAnsweredContext): Promise<void>;
    onAiOverflowBridgeAnswered(ctx: AiOverflowBridgeAnsweredContext): Promise<void>;
}

export function buildPredictiveAnswerHandler(deps: PredictiveAnswerHandlerDeps): PredictiveAnswerHandler {
    const { client, prisma, systemSettings, callAudit, config } = deps;

    async function markAttempt(attemptId: string, data: Record<string, any>) {
        try {
            await prisma.campaignAttempt.update({ where: { id: attemptId }, data });
        } catch (err) {
            logger.warn('predictive-answer-handler: failed to update attempt', { attemptId, error: (err as Error).message });
        }
    }

    async function releaseAgent(agentId: string) {
        try {
            await prisma.user.updateMany({ where: { id: agentId }, data: { status: 'available' } });
        } catch (err) {
            logger.warn('predictive-answer-handler: failed to release agent', { agentId, error: (err as Error).message });
        }
    }

    async function reserveAgent(): Promise<{ id: string; telnyxSipUsername: string | null } | null> {
        // Atomic reservation via find-then-conditional-update loop. If another webhook races us,
        // the updateMany count will be 0 and we retry up to 3 times with a fresh candidate.
        for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = await prisma.user.findFirst({
                where: { status: 'available', role: { in: ['agent', 'supervisor', 'admin'] } },
                orderBy: { updatedAt: 'asc' },
                select: { id: true, telnyxSipUsername: true },
            });
            if (!candidate) return null;
            const claim = await prisma.user.updateMany({
                where: { id: candidate.id, status: 'available' },
                data: { status: 'on-call' },
            });
            if (claim.count === 1) return candidate;
        }
        return null;
    }

    return {
        async onPredictiveAnswered(ctx) {
            if (ctx.answeringMachineDetected) {
                await client.hangup({ callControlId: ctx.callControlId });
                await markAttempt(ctx.attemptId, { status: 'completed', outcome: 'voicemail', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.voicemail',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.attemptId}:voicemail`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId },
                });
                return;
            }

            const agent = await reserveAgent();

            if (agent && agent.telnyxSipUsername) {
                try {
                    await client.createCall({
                        connectionId: config.connectionId,
                        to: `sip:${agent.telnyxSipUsername}@${config.sipDomain}`,
                        from: config.fromNumber,
                        clientState: {
                            stage: 'agent-bridge',
                            bridgeWith: ctx.callControlId,
                            campaignId: ctx.campaignId,
                            contactId: ctx.contactId,
                            attemptId: ctx.attemptId,
                        },
                    } as any);
                    await markAttempt(ctx.attemptId, { status: 'in-progress', outcome: 'bridged-to-agent' });
                    await callAudit.track({
                        type: 'dialer.predictive.bridged-agent',
                        source: 'predictive.answer',
                        status: 'ok',
                        idempotencyKey: `predictive:${ctx.attemptId}:bridged-agent`,
                        details: { campaignId: ctx.campaignId, contactId: ctx.contactId, agentId: agent.id },
                    });
                    return;
                } catch (err) {
                    await releaseAgent(agent.id);
                    await client.hangup({ callControlId: ctx.callControlId }).catch(() => { /* best-effort */ });
                    await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                    await callAudit.track({
                        type: 'dialer.predictive.bridge-failed',
                        source: 'predictive.answer',
                        status: 'failed',
                        idempotencyKey: `predictive:${ctx.attemptId}:bridge-failed`,
                        details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                    });
                    return;
                }
            }

            // No agent — route to AI overflow
            const campaign = await prisma.campaign.findUnique({ where: { id: ctx.campaignId } });
            const overflowNumber = campaign?.aiOverflowNumber || (await systemSettings.get('ai_overflow_number'));

            if (!overflowNumber) {
                await client.hangup({ callControlId: ctx.callControlId });
                await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.attemptId}:no-overflow`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: 'no_overflow_configured' },
                });
                return;
            }

            try {
                await client.createCall({
                    connectionId: config.connectionId,
                    to: overflowNumber,
                    from: config.fromNumber,
                    clientState: {
                        stage: 'ai-overflow-bridge',
                        bridgeWith: ctx.callControlId,
                        campaignId: ctx.campaignId,
                        contactId: ctx.contactId,
                        attemptId: ctx.attemptId,
                    },
                } as any);
                await markAttempt(ctx.attemptId, { status: 'in-progress', outcome: 'bridged-to-ai' });
                await callAudit.track({
                    type: 'dialer.predictive.overflow-to-ai',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.attemptId}:overflow-to-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, overflowNumber },
                });
            } catch (err) {
                await client.hangup({ callControlId: ctx.callControlId }).catch(() => { /* best-effort */ });
                await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.attemptId}:ai-bridge-failed`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                });
            }
        },

        async onAiOverflowBridgeAnswered(ctx) {
            try {
                await client.bridge({ callControlId: ctx.bridgeWith, bridgeWith: ctx.callControlId });
                await callAudit.track({
                    type: 'dialer.predictive.bridged-ai',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.campaignId}:${ctx.contactId}:bridged-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId },
                });
            } catch (err) {
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.campaignId}:${ctx.contactId}:bridge-failed-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                });
                await client.hangup({ callControlId: ctx.bridgeWith }).catch(() => { /* best-effort */ });
                await client.hangup({ callControlId: ctx.callControlId }).catch(() => { /* best-effort */ });
            }
        },
    };
}
