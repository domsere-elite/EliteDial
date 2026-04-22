import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { validate, assignVoicemailSchema } from '../lib/validation';

const router = Router();
const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

// GET /api/voicemails — list voicemails
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    const { page = '1', limit = '25', unreadOnly } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const where: any = {};
    if (req.user!.role === 'agent') {
        where.assignedToId = req.user!.id;
    }
    if (unreadOnly === 'true') {
        where.isRead = false;
    }

    const [voicemails, total, unreadCount] = await Promise.all([
        prisma.voicemail.findMany({
            where,
            include: { assignedTo: { select: { id: true, firstName: true, lastName: true } } },
            orderBy: { createdAt: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        }),
        prisma.voicemail.count({ where }),
        prisma.voicemail.count({ where: { ...where, isRead: false } }),
    ]);

    res.json({ voicemails, total, unreadCount, page: pageNum, limit: limitNum });
});

// PATCH /api/voicemails/:id/read — mark as read
router.patch('/:id/read', authenticate, async (req: Request, res: Response): Promise<void> => {
    const voicemailId = paramValue(req.params.id);

    // Agents can only mark their own voicemails as read
    const vm = await prisma.voicemail.findUnique({ where: { id: voicemailId } });
    if (!vm) {
        res.status(404).json({ error: 'Voicemail not found' });
        return;
    }
    if (req.user!.role === 'agent' && vm.assignedToId !== req.user!.id) {
        res.status(403).json({ error: 'Cannot modify another agent\'s voicemail' });
        return;
    }

    const updated = await prisma.voicemail.update({
        where: { id: voicemailId },
        data: { isRead: true },
    });
    res.json(updated);
});

// PATCH /api/voicemails/:id/assign — assign to agent (supervisor+)
router.patch('/:id/assign', authenticate, requireMinRole('supervisor'), validate(assignVoicemailSchema), async (req: Request, res: Response): Promise<void> => {
    const voicemailId = paramValue(req.params.id);
    const { agentId } = req.body;
    const vm = await prisma.voicemail.update({
        where: { id: voicemailId },
        data: { assignedToId: agentId },
    });
    res.json(vm);
});

export default router;
