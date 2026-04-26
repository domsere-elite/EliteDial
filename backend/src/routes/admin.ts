import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { dncService } from '../services/dnc';
import { generateApiKey } from '../utils/jwt';
import {
    validate, updateAgentSchema, resetPasswordSchema, createPhoneSchema,
    addDncSchema, bulkDncImportSchema, updateQueueSchema, createDispositionSchema,
    createApiKeySchema, createWebhookSchema,
} from '../lib/validation';

const router = Router();
const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

// ─── Agent Management ─────────────────────────
// GET /api/admin/agents
router.get('/agents', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const agents = await prisma.profile.findMany({
        select: {
            id: true, username: true, email: true, firstName: true, lastName: true,
            role: true, status: true, extension: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
    });
    res.json(agents);
});

// PUT /api/admin/agents/:id
router.put('/agents/:id', authenticate, requireRole('admin'), validate(updateAgentSchema), async (req: Request, res: Response): Promise<void> => {
    const agentId = paramValue(req.params.id);
    const { firstName, lastName, email, role, extension } = req.body;
    const agent = await prisma.profile.update({
        where: { id: agentId },
        data: { firstName, lastName, email, role, extension },
    });
    res.json(agent);
});

// DELETE /api/admin/agents/:id
router.delete('/agents/:id', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const agentId = paramValue(req.params.id);
    await prisma.profile.delete({ where: { id: agentId } });
    res.json({ success: true });
});

// POST /api/admin/agents/:id/reset-password
router.post('/agents/:id/reset-password', authenticate, requireRole('admin'), validate(resetPasswordSchema), async (req: Request, res: Response): Promise<void> => {
    const agentId = paramValue(req.params.id);
    const { newPassword } = req.body;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.profile.update({ where: { id: agentId }, data: { passwordHash } });
    res.json({ success: true });
});

// ─── Phone Numbers ────────────────────────────
// GET /api/admin/phones
router.get('/phones', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const phones = await prisma.phoneNumber.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(phones);
});

// POST /api/admin/phones
router.post('/phones', authenticate, requireRole('admin'), validate(createPhoneSchema), async (req: Request, res: Response): Promise<void> => {
    const { number, label, type, assignedTo } = req.body;
    const phone = await prisma.phoneNumber.create({ data: { number, label, type, assignedTo } });
    res.status(201).json(phone);
});

// DELETE /api/admin/phones/:id
router.delete('/phones/:id', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const phoneId = paramValue(req.params.id);
    await prisma.phoneNumber.delete({ where: { id: phoneId } });
    res.json({ success: true });
});

// ─── DNC List ─────────────────────────────────
// GET /api/admin/dnc
router.get('/dnc', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const { page = '1', limit = '50' } = req.query;
    const result = await dncService.listDNC(parseInt(page as string), parseInt(limit as string));
    res.json(result);
});

// POST /api/admin/dnc
router.post('/dnc', authenticate, requireRole('admin'), validate(addDncSchema), async (req: Request, res: Response): Promise<void> => {
    const { phoneNumber, reason } = req.body;
    await dncService.addToDNC(phoneNumber, reason, req.user!.username);
    res.status(201).json({ success: true });
});

// DELETE /api/admin/dnc/:phoneNumber
router.delete('/dnc/:phoneNumber', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const phoneNumber = paramValue(req.params.phoneNumber);
    const removed = await dncService.removeFromDNC(phoneNumber);
    res.json({ success: removed });
});

// GET /api/admin/dnc/check/:phoneNumber
router.get('/dnc/check/:phoneNumber', authenticate, async (req: Request, res: Response): Promise<void> => {
    const phoneNumber = paramValue(req.params.phoneNumber);
    const isDNC = await dncService.isOnDNC(phoneNumber);
    res.json({ phoneNumber, isDNC });
});

// POST /api/admin/dnc/import
router.post('/dnc/import', authenticate, requireRole('admin'), validate(bulkDncImportSchema), async (req: Request, res: Response): Promise<void> => {
    const { numbers, reason } = req.body;
    const imported = await dncService.bulkImport(numbers, reason, req.user!.username);
    res.json({ imported });
});

// ─── Queue Configuration ──────────────────────
// GET /api/admin/queues
router.get('/queues', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const queues = await prisma.queueConfig.findMany();
    res.json(queues);
});

// PUT /api/admin/queues/:id
router.put('/queues/:id', authenticate, requireRole('admin'), validate(updateQueueSchema), async (req: Request, res: Response): Promise<void> => {
    const queueId = paramValue(req.params.id);
    const { holdTimeout, overflowAction, holdMusicUrl, maxQueueSize, isActive } = req.body;
    const queue = await prisma.queueConfig.update({
        where: { id: queueId },
        data: { holdTimeout, overflowAction, holdMusicUrl, maxQueueSize, isActive },
    });
    res.json(queue);
});

// ─── Disposition Codes ────────────────────────
// GET /api/admin/dispositions
router.get('/dispositions', authenticate, async (req: Request, res: Response): Promise<void> => {
    const codes = await prisma.dispositionCode.findMany({
        where: { isActive: true },
        orderBy: { category: 'asc' },
    });
    res.json(codes);
});

// POST /api/admin/dispositions
router.post('/dispositions', authenticate, requireRole('admin'), validate(createDispositionSchema), async (req: Request, res: Response): Promise<void> => {
    const { code, label, category } = req.body;
    const disposition = await prisma.dispositionCode.create({ data: { code, label, category } });
    res.status(201).json(disposition);
});

// ─── API Keys ─────────────────────────────────
// GET /api/admin/api-keys
router.get('/api-keys', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const keys = await prisma.aPIKey.findMany({
        select: { id: true, key: true, label: true, isActive: true, createdAt: true, lastUsed: true },
        orderBy: { createdAt: 'desc' },
    });
    res.json(keys);
});

// POST /api/admin/api-keys
router.post('/api-keys', authenticate, requireRole('admin'), validate(createApiKeySchema), async (req: Request, res: Response): Promise<void> => {
    const { label } = req.body;
    const key = generateApiKey();
    const apiKey = await prisma.aPIKey.create({ data: { key, label: label || 'CRM Integration' } });
    res.status(201).json(apiKey);
});

// ─── Webhook Config ───────────────────────────
// GET /api/admin/webhooks
router.get('/webhooks', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const webhooks = await prisma.webhookConfig.findMany();
    res.json(webhooks);
});

// POST /api/admin/webhooks
router.post('/webhooks', authenticate, requireRole('admin'), validate(createWebhookSchema), async (req: Request, res: Response): Promise<void> => {
    const { url, secret, events } = req.body;
    const webhook = await prisma.webhookConfig.create({ data: { url, secret, events } });
    res.status(201).json(webhook);
});

export default router;
