import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { callAuditService } from '../services/call-audit';
import { callSessionService } from '../services/call-session-service';
import { prisma } from '../lib/prisma';
import {
    inboundIvrSwml,
    ivrSelectionSwml,
    connectAgentSwml,
    voicemailSwml,
    queueHoldSwml,
    bridgeOutboundSwml,
    bridgeOutboundAiSwml,
    transferSwml,
    hangupSwml,
    powerDialBridgeAgentSwml,
    powerDialOverflowSwml,
} from '../services/swml/builder';

const backendBase = (req: Request): string =>
    config.publicUrls.backend || `${req.protocol}://${req.get('host')}`;

const swmlUrl = (req: Request, path: string): string => `${backendBase(req)}${path}`;

const defaultReserveAvailableAgent = async (): Promise<{ id: string; extension: string } | null> => {
    for (let i = 0; i < 5; i += 1) {
        const agent = await prisma.profile.findFirst({
            where: {
                role: { in: ['agent', 'supervisor', 'admin'] },
                status: 'available',
            },
            select: { id: true, extension: true },
            orderBy: { updatedAt: 'asc' },
        });
        if (!agent) return null;
        const claim = await prisma.profile.updateMany({
            where: { id: agent.id, status: 'available' },
            data: { status: 'on-call' },
        });
        if (claim.count === 1) {
            return { id: agent.id, extension: agent.extension || agent.id };
        }
    }
    return null;
};

const defaultEnsureInboundCallRecord = async (params: {
    callId?: string;
    fromNumber?: string;
    toNumber?: string;
    agentId?: string | null;
}): Promise<string | null> => {
    const callId = (params.callId || '').trim();
    if (!callId) return null;

    const existing = await prisma.call.findFirst({
        where: { signalwireCallId: callId },
        select: { id: true, agentId: true },
    });

    if (existing) {
        if (!existing.agentId && params.agentId) {
            await prisma.call.update({
                where: { id: existing.id },
                data: { agentId: params.agentId },
            });
            await callSessionService.syncCall(existing.id, {
                provider: 'signalwire',
                providerCallId: callId,
                mode: 'inbound',
                channel: 'human',
            });
        }
        return existing.id;
    }

    const { call } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: 'inbound',
        direction: 'inbound',
        fromNumber: params.fromNumber || 'unknown',
        toNumber: params.toNumber || 'unknown',
        status: 'initiated',
        providerCallId: callId,
        agentId: params.agentId || null,
    });

    return call.id;
};

export interface PowerDialClaimResult {
    won: boolean;
    targetRef: string | null; // populated when won
}

export interface PowerDialVoicemailContext {
    voicemailBehavior: string;
    voicemailMessage: string | null;
}

export interface SwmlRouteDeps {
    ensureInboundCallRecord: typeof defaultEnsureInboundCallRecord;
    reserveAvailableAgent: typeof defaultReserveAvailableAgent;
    callAuditTrack: (...args: Parameters<typeof callAuditService.track>) => ReturnType<typeof callAuditService.track>;
    loadCampaignForBridge: (campaignId: string) => Promise<{ id: string; retellSipAddress: string | null } | null>;
    // Power-dial Phase 2:
    claimPowerDialLeg: (params: { batchId: string; legId: string }) => Promise<PowerDialClaimResult>;
    loadCampaignForOverflow: (campaignId: string) => Promise<{ retellSipAddress: string | null } | null>;
    loadCampaignForVoicemail: (campaignId: string) => Promise<PowerDialVoicemailContext | null>;
    markPowerDialLegOverflow: (params: { legId: string; overflowTarget: 'ai' | 'hangup' }) => Promise<void>;
    markPowerDialLegMachine: (params: { legId: string; detectResult: string }) => Promise<void>;
}

const defaultLoadCampaignForBridge = async (
    campaignId: string,
): Promise<{ id: string; retellSipAddress: string | null } | null> => {
    if (!campaignId) return null;
    return prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, retellSipAddress: true },
    });
};

// Atomic claim: the first leg in a batch to reach this query wins the agent slot.
// Implemented as a single UPDATE … WHERE NOT EXISTS … RETURNING so concurrent
// callers (multiple SignalWire SWML executions hitting /swml/power-dial/claim
// for the same batch) cannot both succeed. If RETURNING is empty, the leg lost.
//
// We also load the batch's targetRef in the same call so the route can return
// the bridge SWML without a follow-up roundtrip. The batch row exists from
// dispatch time; the join is a fast PK lookup.
const defaultClaimPowerDialLeg = async (params: {
    batchId: string;
    legId: string;
}): Promise<PowerDialClaimResult> => {
    if (!params.batchId || !params.legId) return { won: false, targetRef: null };

    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE "PowerDialLeg"
        SET "claimedAgent" = true,
            "status" = 'human-claimed',
            "detectResult" = 'human',
            "completedAt" = NOW()
        WHERE "id" = ${params.legId}
          AND "batchId" = ${params.batchId}
          AND NOT EXISTS (
            SELECT 1 FROM "PowerDialLeg"
            WHERE "batchId" = ${params.batchId} AND "claimedAgent" = true
          )
        RETURNING "id"
    `;

    if (claimed.length === 0) {
        return { won: false, targetRef: null };
    }

    const batch = await prisma.powerDialBatch.findUnique({
        where: { id: params.batchId },
        select: { targetRef: true },
    });

    // Mark the batch as claimed for observability; non-blocking on failure.
    void prisma.powerDialBatch.update({
        where: { id: params.batchId },
        data: { status: 'claimed', claimedAt: new Date() },
    }).catch((err) => logger.warn('Failed to mark batch claimed', { batchId: params.batchId, err }));

    return { won: true, targetRef: batch?.targetRef || null };
};

const defaultLoadCampaignForOverflow = async (
    campaignId: string,
): Promise<{ retellSipAddress: string | null } | null> => {
    if (!campaignId) return null;
    return prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { retellSipAddress: true },
    });
};

const defaultLoadCampaignForVoicemail = async (
    campaignId: string,
): Promise<PowerDialVoicemailContext | null> => {
    if (!campaignId) return null;
    const c = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { voicemailBehavior: true, voicemailMessage: true },
    });
    if (!c) return null;
    return { voicemailBehavior: c.voicemailBehavior, voicemailMessage: c.voicemailMessage };
};

const defaultMarkPowerDialLegOverflow = async (params: {
    legId: string;
    overflowTarget: 'ai' | 'hangup';
}): Promise<void> => {
    if (!params.legId) return;
    await prisma.powerDialLeg.updateMany({
        where: { id: params.legId, claimedAgent: false },
        data: {
            status: 'human-overflow',
            detectResult: 'human',
            overflowTarget: params.overflowTarget,
            completedAt: new Date(),
        },
    });
};

const defaultMarkPowerDialLegMachine = async (params: {
    legId: string;
    detectResult: string;
}): Promise<void> => {
    if (!params.legId) return;
    await prisma.powerDialLeg.updateMany({
        where: { id: params.legId, claimedAgent: false },
        data: {
            status: 'machine',
            detectResult: params.detectResult,
            completedAt: new Date(),
        },
    });
};

const defaultDeps: SwmlRouteDeps = {
    ensureInboundCallRecord: defaultEnsureInboundCallRecord,
    reserveAvailableAgent: defaultReserveAvailableAgent,
    callAuditTrack: (...args) => callAuditService.track(...args),
    loadCampaignForBridge: defaultLoadCampaignForBridge,
    claimPowerDialLeg: defaultClaimPowerDialLeg,
    loadCampaignForOverflow: defaultLoadCampaignForOverflow,
    loadCampaignForVoicemail: defaultLoadCampaignForVoicemail,
    markPowerDialLegOverflow: defaultMarkPowerDialLegOverflow,
    markPowerDialLegMachine: defaultMarkPowerDialLegMachine,
};

export function createSwmlRouter(deps: SwmlRouteDeps = defaultDeps): Router {
    const router = Router();

    // POST /swml/inbound
    router.post('/inbound', (req: Request, res: Response): void => {
        const { call_id, from, to } = req.body || {};
        void deps.ensureInboundCallRecord({
            callId: call_id as string | undefined,
            fromNumber: from as string | undefined,
            toNumber: to as string | undefined,
        }).then((callId) => {
            void deps.callAuditTrack({
                type: 'inbound.received',
                callId: callId || undefined,
                callSid: call_id as string | undefined,
                details: { fromNumber: from || 'unknown', toNumber: to || 'unknown' },
                source: 'signalwire.inbound',
            });
        });

        res.json(inboundIvrSwml({ actionUrl: swmlUrl(req, '/swml/ivr-action') }));
    });

    // POST /swml/ivr-action
    router.post('/ivr-action', async (req: Request, res: Response): Promise<void> => {
        const { digit, call_id, from, to } = req.body || {};
        const callId = await deps.ensureInboundCallRecord({
            callId: call_id as string | undefined,
            fromNumber: from as string | undefined,
            toNumber: to as string | undefined,
        });
        await deps.callAuditTrack({
            type: 'inbound.ivr.selection',
            callId: callId || undefined,
            callSid: call_id as string | undefined,
            details: { digit: (digit || '').toString() || 'none' },
            source: 'signalwire.ivr_action',
        });

        res.json(ivrSelectionSwml({
            digit: (digit || '').toString(),
            connectAgentUrl: swmlUrl(req, '/swml/connect-agent'),
            voicemailUrl: swmlUrl(req, '/swml/voicemail'),
        }));
    });

    // POST /swml/connect-agent
    router.post('/connect-agent', async (req: Request, res: Response): Promise<void> => {
        const { call_id, from, to } = req.body || {};
        const reserved = await deps.reserveAvailableAgent();

        if (!reserved || !config.signalwire.spaceUrl) {
            res.json(queueHoldSwml({ voicemailUrl: swmlUrl(req, '/swml/voicemail') }));
            return;
        }

        const callId = await deps.ensureInboundCallRecord({
            callId: call_id as string | undefined,
            fromNumber: from as string | undefined,
            toNumber: to as string | undefined,
            agentId: reserved.id,
        });

        await deps.callAuditTrack({
            type: 'inbound.agent.reserved',
            callId: callId || undefined,
            callSid: call_id as string | undefined,
            details: { agentId: reserved.id, endpoint: reserved.extension },
            source: 'signalwire.connect_agent',
        });

        res.json(connectAgentSwml({
            extension: reserved.extension,
            spaceUrl: config.signalwire.spaceUrl,
            fallbackVoicemailUrl: swmlUrl(req, '/swml/voicemail'),
        }));
    });

    // POST /swml/queue-hold
    router.post('/queue-hold', (req: Request, res: Response): void => {
        res.json(queueHoldSwml({ voicemailUrl: swmlUrl(req, '/swml/voicemail') }));
    });

    // POST /swml/voicemail
    router.post('/voicemail', (_req: Request, res: Response): void => {
        res.json(voicemailSwml());
    });

    // POST /swml/bridge
    router.post('/bridge', async (req: Request, res: Response): Promise<void> => {
        // Diagnostic log for Fabric Resource → SWML handler shape discovery.
        // Reveals where userVariables from client.dial() lands in the POST body
        // (vars / params / user_variables / elsewhere). Remove once design is locked.
        logger.info('swml.bridge invoked', { query: req.query, body: req.body });

        const mode = (req.query.mode as string) || '';
        const from = (req.query.from as string) || '';

        if (mode === 'ai_autonomous') {
            const campaignId = (req.query.campaignId as string) || '';
            try {
                const campaign = await deps.loadCampaignForBridge(campaignId);
                if (!campaign || !campaign.retellSipAddress) {
                    logger.warn('swml.bridge ai_autonomous: campaign or retellSipAddress missing — returning hangup', { campaignId });
                    res.json(hangupSwml('AI agent not available.'));
                    return;
                }
                res.json(bridgeOutboundAiSwml({
                    retellSipAddress: campaign.retellSipAddress,
                    from,
                }));
            } catch (err) {
                logger.error('swml.bridge ai_autonomous: loadCampaignForBridge threw — returning hangup', { campaignId, err });
                res.json(hangupSwml('AI agent not available.'));
            }
            return;
        }

        const to = (req.query.to as string) || '';
        if (!to) {
            res.json(hangupSwml('Destination number missing.'));
            return;
        }
        res.json(bridgeOutboundSwml({ to, from }));
    });

    // POST /swml/transfer
    router.post('/transfer', (req: Request, res: Response): void => {
        const to = (req.query.to as string) || '';
        const from = (req.query.from as string) || config.telephony.defaultOutboundNumber || undefined;
        if (!to) {
            logger.warn('swml.transfer: missing target, returning hangup');
            res.json(hangupSwml('Transfer target unavailable.'));
            return;
        }
        res.json(transferSwml({ to, from }));
    });

    // ---- Power-dial Phase 2 routes ------------------------------------------

    // POST /swml/power-dial/claim
    // The customer leg's SWML branched to 'human' and is now requesting routing.
    // We run an atomic claim against the batch; the first leg to win gets the
    // agent bridge, others overflow to AI (when configured) or hang up.
    router.post('/power-dial/claim', async (req: Request, res: Response): Promise<void> => {
        const batchId = (req.query.batchId as string) || '';
        const legId = (req.query.legId as string) || '';
        const campaignId = (req.query.campaignId as string) || '';
        // callerId comes from the worker via the SWML detect URL (see
        // powerDialDetectSwml). Falling back to the configured default DID lets
        // tests + legacy paths still work.
        const callerId = (req.query.callerId as string) || config.telephony.defaultOutboundNumber || '';

        if (!batchId || !legId) {
            logger.warn('swml.power-dial/claim: missing batchId/legId, returning hangup', { batchId, legId });
            res.json(hangupSwml());
            return;
        }

        try {
            const result = await deps.claimPowerDialLeg({ batchId, legId });

            if (result.won && result.targetRef) {
                await deps.callAuditTrack({
                    type: 'power_dial.bridge.claimed',
                    details: { batchId, legId, targetRef: result.targetRef },
                    source: 'signalwire.power_dial_claim',
                });
                res.json(powerDialBridgeAgentSwml({
                    targetRef: result.targetRef,
                    callerId,
                }));
                return;
            }

            // Race lost. Fall back to AI overflow if the campaign has one,
            // otherwise hang up cleanly.
            const campaign = campaignId ? await deps.loadCampaignForOverflow(campaignId) : null;
            if (campaign?.retellSipAddress && callerId) {
                await deps.markPowerDialLegOverflow({ legId, overflowTarget: 'ai' });
                await deps.callAuditTrack({
                    type: 'power_dial.bridge.overflow_ai',
                    details: { batchId, legId, retellSipAddress: campaign.retellSipAddress },
                    source: 'signalwire.power_dial_claim',
                });
                res.json(powerDialOverflowSwml({
                    mode: 'ai',
                    retellSipAddress: campaign.retellSipAddress,
                    callerId,
                }));
                return;
            }

            await deps.markPowerDialLegOverflow({ legId, overflowTarget: 'hangup' });
            await deps.callAuditTrack({
                type: 'power_dial.bridge.overflow_hangup',
                details: { batchId, legId, reason: campaign ? 'no_retell_address' : 'no_campaign' },
                source: 'signalwire.power_dial_claim',
            });
            res.json(hangupSwml());
        } catch (err) {
            logger.error('swml.power-dial/claim error — returning hangup', { batchId, legId, err });
            res.json(hangupSwml());
        }
    });

    // POST /swml/power-dial/voicemail
    // The customer leg's SWML branched non-human (machine, fax, unknown).
    // Per campaign config: hang up silently or play voicemailMessage as TTS.
    router.post('/power-dial/voicemail', async (req: Request, res: Response): Promise<void> => {
        const campaignId = (req.query.campaignId as string) || '';
        const legId = (req.query.legId as string) || '';

        if (!legId) {
            logger.warn('swml.power-dial/voicemail: missing legId, returning hangup', { campaignId, legId });
            res.json(hangupSwml());
            return;
        }

        try {
            // Best-effort: capture the detect_result if SignalWire posted it in the body.
            const detectResult = (req.body?.detect_result as string) || 'machine';
            await deps.markPowerDialLegMachine({ legId, detectResult });

            const ctx = campaignId ? await deps.loadCampaignForVoicemail(campaignId) : null;
            if (ctx?.voicemailBehavior === 'leave_message' && ctx.voicemailMessage) {
                await deps.callAuditTrack({
                    type: 'power_dial.voicemail.leave_message',
                    details: { campaignId, legId, detectResult },
                    source: 'signalwire.power_dial_voicemail',
                });
                res.json(powerDialOverflowSwml({
                    mode: 'leave_message',
                    voicemailMessage: ctx.voicemailMessage,
                }));
                return;
            }

            await deps.callAuditTrack({
                type: 'power_dial.voicemail.hangup',
                details: { campaignId, legId, detectResult },
                source: 'signalwire.power_dial_voicemail',
            });
            res.json(hangupSwml());
        } catch (err) {
            logger.error('swml.power-dial/voicemail error — returning hangup', { campaignId, legId, err });
            res.json(hangupSwml());
        }
    });

    return router;
}

export default createSwmlRouter();
