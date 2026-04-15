import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { systemSettings } from '../services/system-settings';
import { prisma } from '../lib/prisma';

const router = Router();

const E164 = /^\+[1-9]\d{1,14}$/;

router.get('/ai-overflow-number', authenticate, requireMinRole('admin'), async (_req: Request, res: Response) => {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_overflow_number' } });
    res.json({
        value: row?.value ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
    });
});

router.put('/ai-overflow-number', authenticate, requireMinRole('admin'), async (req: Request, res: Response) => {
    const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';

    if (!E164.test(value)) {
        res.status(400).json({ error: 'value must be a valid E.164 phone number (e.g. +12762128412)' });
        return;
    }

    const userId = req.user?.id;
    await systemSettings.set('ai_overflow_number', value, userId);

    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_overflow_number' } });
    res.json({
        value: row?.value ?? value,
        updatedAt: row?.updatedAt ?? new Date(),
        updatedBy: row?.updatedBy ?? userId ?? null,
    });
});

// Supervisor-readable version (for campaign form placeholder). Returns only the value.
router.get('/ai-overflow-number/public', authenticate, requireMinRole('supervisor'), async (_req: Request, res: Response) => {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_overflow_number' } });
    res.json({ value: row?.value ?? null });
});

export default router;
