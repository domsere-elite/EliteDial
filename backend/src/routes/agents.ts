import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { signalwireService } from '../services/signalwire';
import { validate, updateAgentStatusSchema } from '../lib/validation';

const router = Router();
const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

// GET /api/agents — list all agents (supervisor+)
router.get('/', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const agents = await prisma.profile.findMany({
        select: {
            id: true, email: true, firstName: true, lastName: true,
            role: true, status: true, extension: true, createdAt: true,
        },
        orderBy: { lastName: 'asc' },
    });
    res.json(agents);
});

// PATCH /api/agents/:id/status — update availability
router.patch('/:id/status', authenticate, validate(updateAgentStatusSchema), async (req: Request, res: Response): Promise<void> => {
    const id = paramValue(req.params.id);
    const { status } = req.body;

    // Agents can only update their own status; supervisors/admins can update anyone
    if (req.user!.role === 'agent' && req.user!.id !== id) {
        res.status(403).json({ error: 'Cannot update another agent\'s status' });
        return;
    }

    const agent = await prisma.profile.update({
        where: { id },
        data: { status },
        select: { id: true, email: true, status: true },
    });

    res.json(agent);
});

// GET /api/agents/:id/stats — per-agent performance
router.get('/:id/stats', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const id = paramValue(req.params.id);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalCalls, answeredCalls, avgDuration, dispositions] = await Promise.all([
        prisma.call.count({ where: { agentId: id, createdAt: { gte: today } } }),
        prisma.call.count({ where: { agentId: id, status: 'completed', createdAt: { gte: today } } }),
        prisma.call.aggregate({ where: { agentId: id, status: 'completed' }, _avg: { duration: true } }),
        prisma.call.groupBy({
            by: ['dispositionId'],
            where: { agentId: id, createdAt: { gte: today }, dispositionId: { not: null } },
            _count: true,
        }),
    ]);

    res.json({
        agentId: id,
        today: {
            totalCalls,
            answeredCalls,
            answerRate: totalCalls > 0 ? ((answeredCalls / totalCalls) * 100).toFixed(1) : '0.0',
            avgDuration: Math.round(avgDuration._avg?.duration || 0),
        },
        dispositions,
    });
});

// GET /api/agents/token — get SignalWire browser token for current agent
router.get('/token/signalwire', authenticate, async (req: Request, res: Response): Promise<void> => {
    const user = await prisma.profile.findUnique({
        where: { id: req.user!.id },
        select: { id: true, email: true, extension: true },
    });

    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }

    const result = await signalwireService.generateBrowserToken(user.id, user.email, user.email, user.extension || user.id);
    if (!result.token) {
        if (result.error === 'subscriber_provisioning_disabled') {
            res.status(403).json({ error: 'SignalWire subscriber provisioning is disabled for new endpoints. Existing approved subscribers can still connect.' });
            return;
        }
        if (result.error === 'insufficient_balance') {
            res.status(402).json({ error: 'SignalWire account has insufficient balance for softphone token generation' });
            return;
        }
        res.status(500).json({ error: 'Failed to generate browser token', reason: result.error || 'unknown' });
        return;
    }
    res.json({ token: result.token, spaceUrl: process.env.SIGNALWIRE_SPACE_URL || '' });
});

export default router;
