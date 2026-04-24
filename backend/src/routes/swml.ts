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
    transferSwml,
    hangupSwml,
} from '../services/swml/builder';

const backendBase = (req: Request): string =>
    config.publicUrls.backend || `${req.protocol}://${req.get('host')}`;

const swmlUrl = (req: Request, path: string): string => `${backendBase(req)}${path}`;

const defaultReserveAvailableAgent = async (): Promise<{ id: string; extension: string } | null> => {
    for (let i = 0; i < 5; i += 1) {
        const agent = await prisma.user.findFirst({
            where: {
                role: { in: ['agent', 'supervisor', 'admin'] },
                status: 'available',
            },
            select: { id: true, extension: true },
            orderBy: { updatedAt: 'asc' },
        });
        if (!agent) return null;
        const claim = await prisma.user.updateMany({
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
        where: { signalwireCallSid: callId },
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

export interface SwmlRouteDeps {
    ensureInboundCallRecord: typeof defaultEnsureInboundCallRecord;
    reserveAvailableAgent: typeof defaultReserveAvailableAgent;
    callAuditTrack: (...args: Parameters<typeof callAuditService.track>) => ReturnType<typeof callAuditService.track>;
}

const defaultDeps: SwmlRouteDeps = {
    ensureInboundCallRecord: defaultEnsureInboundCallRecord,
    reserveAvailableAgent: defaultReserveAvailableAgent,
    callAuditTrack: (...args) => callAuditService.track(...args),
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
    router.post('/bridge', (req: Request, res: Response): void => {
        const to = (req.query.to as string) || '';
        const from = (req.query.from as string) || '';
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

    return router;
}

export default createSwmlRouter();
