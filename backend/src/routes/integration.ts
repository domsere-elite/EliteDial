import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateApiKey } from '../middleware/auth';
import { callSessionService } from '../services/call-session-service';

const router = Router();
const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

// All routes here use API key authentication
router.use(authenticateApiKey);

// POST /api/integration/calls/initiate — trigger call from CRM
router.post('/calls/initiate', async (req: Request, res: Response): Promise<void> => {
    const { toNumber, fromNumber, agentId, accountId, accountName } = req.body;
    if (!toNumber || !agentId) {
        res.status(400).json({ error: 'toNumber and agentId are required' });
        return;
    }

    const { call, session } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: 'manual',
        direction: 'outbound',
        fromNumber: fromNumber || 'crm-initiated',
        toNumber,
        status: 'initiated',
        agentId,
        accountId,
        accountName,
        dncChecked: true,
        fdcpaNotice: true,
    });

    res.json({ callId: call.id, callSessionId: session.id, status: 'initiated' });
});

// GET /api/integration/calls — call history for account
router.get('/calls', async (req: Request, res: Response): Promise<void> => {
    const { account_id, limit = '50' } = req.query;
    const where: any = {};
    if (account_id) where.accountId = account_id;

    const calls = await prisma.call.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string),
        include: { agent: { select: { id: true, firstName: true, lastName: true } } },
    });

    res.json(calls);
});

// PATCH /api/integration/agents/:id/status — control agent availability from CRM
router.patch('/agents/:id/status', async (req: Request, res: Response): Promise<void> => {
    const agentId = paramValue(req.params.id);
    const { status } = req.body;
    const validStatuses = ['available', 'break', 'offline'];
    if (!validStatuses.includes(status)) {
        res.status(400).json({ error: `Status must be: ${validStatuses.join(', ')}` });
        return;
    }

    const agent = await prisma.user.update({
        where: { id: agentId },
        data: { status },
        select: { id: true, username: true, status: true },
    });
    res.json(agent);
});

export default router;
