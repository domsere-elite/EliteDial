import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { retellService } from '../services/retell';
import { dncService } from '../services/dnc';
import { callSessionService } from '../services/call-session-service';
import { phoneNumberService } from '../services/phone-number-service';
import { callAuditService } from '../services/call-audit';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/ai-agents — list all Retell agents with local call stats
router.get('/', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const agents = await retellService.listAgents();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const enriched = await Promise.all(agents.map(async (agent) => {
        const [callsToday, totalCalls, avgDuration] = await Promise.all([
            prisma.call.count({
                where: { channel: 'ai', provider: 'retell', createdAt: { gte: today } },
            }),
            prisma.call.count({
                where: { channel: 'ai', provider: 'retell' },
            }),
            prisma.call.aggregate({
                where: { channel: 'ai', provider: 'retell', status: 'completed' },
                _avg: { duration: true },
            }),
        ]);

        return {
            ...agent,
            stats: {
                callsToday,
                totalCalls,
                avgDuration: Math.round(avgDuration._avg?.duration || 0),
            },
        };
    }));

    res.json(enriched);
});

// GET /api/ai-agents/:id — single agent detail + recent calls + transcripts
router.get('/:id', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const agentId = String(req.params.id);
    const agent = await retellService.getAgent(agentId);

    if (!agent) {
        res.status(404).json({ error: 'AI agent not found' });
        return;
    }

    const [recentCalls, transcripts] = await Promise.all([
        prisma.call.findMany({
            where: { channel: 'ai', provider: 'retell' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                id: true, toNumber: true, fromNumber: true, status: true,
                duration: true, createdAt: true, completedAt: true, accountId: true,
            },
        }),
        prisma.callTranscript.findMany({
            where: { provider: 'retell' },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
                id: true, callId: true, text: true, summary: true, createdAt: true,
            },
        }),
    ]);

    res.json({ agent, recentCalls, transcripts });
});

// POST /api/ai-agents/:id/launch — launch AI outbound call with this agent
router.post('/:id/launch', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const agentId = String(req.params.id);
    const { toNumber, fromNumber, campaignId, accountId, metadata } = req.body;

    if (!toNumber) {
        res.status(400).json({ error: 'toNumber is required' });
        return;
    }

    const isDNC = await dncService.isOnDNC(toNumber);
    if (isDNC) {
        res.status(403).json({ error: 'Number is on the Do Not Call list', dncBlocked: true });
        return;
    }

    const selectedFrom = await phoneNumberService.resolveOutboundNumber(fromNumber || null);

    const { call, session } = await callSessionService.createUnifiedCall({
        provider: 'retell',
        channel: 'ai',
        mode: 'ai_outbound',
        direction: 'outbound',
        fromNumber: selectedFrom,
        toNumber,
        status: 'initiated',
        agentId: null,
        accountId: accountId || null,
        campaignId: campaignId || null,
        dncChecked: true,
        fdcpaNotice: true,
    });

    try {
        const result = await retellService.launchOutboundCall({
            fromNumber: selectedFrom,
            toNumber,
            agentId,
            metadata: {
                call_id: call.id,
                call_session_id: session.id,
                account_id: accountId || '',
                campaign_id: campaignId || '',
                ...(metadata || {}),
            },
        });

        if (result?.providerCallId) {
            await callSessionService.attachProviderIdentifiers(call.id, {
                provider: 'retell',
                providerCallId: result.providerCallId,
                providerMetadata: result.raw || undefined,
            });
        }

        await callAuditService.track({
            type: 'call.ai_outbound.initiated',
            callId: call.id,
            callSid: result?.providerCallId,
            details: { agentId, toNumber, fromNumber: selectedFrom },
            source: 'api.ai-agents.launch',
            status: 'initiated',
        });

        res.json({
            callId: call.id,
            sessionId: session.id,
            providerCallId: result?.providerCallId || null,
            status: 'initiated',
            agentId,
        });
    } catch (error) {
        logger.error('AI agent launch failed', { error, agentId });
        await prisma.call.update({
            where: { id: call.id },
            data: { status: 'failed', completedAt: new Date() },
        });
        res.status(502).json({ error: 'Failed to launch AI outbound call' });
    }
});

export default router;
