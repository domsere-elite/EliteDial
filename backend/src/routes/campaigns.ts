import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { computeDialerGuardrails } from '../services/dialer-guardrails';
import { complianceFrequency } from '../services/compliance-frequency';
import { classifyImportCandidates } from '../services/campaign-import';
import { validate, createCampaignSchema, updateCampaignSchema, createCampaignListSchema, importContactsSchema } from '../lib/validation';
import { eventBus } from '../lib/event-bus';

const router = Router();

interface AiAutonomousActivationCheck {
    ok: boolean;
    missing: string[];
}

export function checkAiAutonomousActivation(c: {
    dialMode: string;
    status: string;
    retellAgentId: string | null;
    retellSipAddress: string | null;
}): AiAutonomousActivationCheck {
    if (c.dialMode !== 'ai_autonomous' || c.status !== 'active') {
        return { ok: true, missing: [] };
    }
    const missing: string[] = [];
    if (!c.retellAgentId) missing.push('retellAgentId');
    if (!c.retellSipAddress) missing.push('retellSipAddress');
    return { ok: missing.length === 0, missing };
}

const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

type ImportRow = {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    accountId?: string;
    externalId?: string;
    timezone?: string;
    priority?: number;
};

const normalizePhone = (input: string): string | null => {
    const digits = input.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
};

const parseCsvRows = (csv: string): ImportRow[] => {
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    const header = lines[0].split(',').map((x) => x.trim().toLowerCase());
    const idx = {
        firstName: header.findIndex((h) => ['firstname', 'first_name', 'first'].includes(h)),
        lastName: header.findIndex((h) => ['lastname', 'last_name', 'last'].includes(h)),
        phone: header.findIndex((h) => ['phone', 'phone_number', 'number', 'mobile'].includes(h)),
        email: header.findIndex((h) => ['email'].includes(h)),
        accountId: header.findIndex((h) => ['accountid', 'account_id'].includes(h)),
        externalId: header.findIndex((h) => ['externalid', 'external_id', 'leadid', 'lead_id'].includes(h)),
        timezone: header.findIndex((h) => ['timezone', 'tz'].includes(h)),
        priority: header.findIndex((h) => ['priority', 'score'].includes(h)),
    };

    return lines.slice(1).map((line) => {
        const cols = line.split(',').map((x) => x.trim());
        return {
            firstName: idx.firstName >= 0 ? cols[idx.firstName] : undefined,
            lastName: idx.lastName >= 0 ? cols[idx.lastName] : undefined,
            phone: idx.phone >= 0 ? cols[idx.phone] : undefined,
            email: idx.email >= 0 ? cols[idx.email] : undefined,
            accountId: idx.accountId >= 0 ? cols[idx.accountId] : undefined,
            externalId: idx.externalId >= 0 ? cols[idx.externalId] : undefined,
            timezone: idx.timezone >= 0 ? cols[idx.timezone] : undefined,
            priority: idx.priority >= 0 ? Number(cols[idx.priority]) : undefined,
        };
    });
};

const toNumber = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const importContacts = async (campaignId: string, listId: string, rows: ImportRow[]) => {
    let totalRecords = rows.length;
    let invalidRecords = 0;
    let intraBatchDuplicates = 0;

    const seen = new Set<string>();
    const prepared: Array<ImportRow & { normalizedPhone: string }> = [];

    for (const row of rows) {
        const phone = row.phone ? normalizePhone(row.phone) : null;
        if (!phone) {
            invalidRecords += 1;
            continue;
        }

        if (seen.has(phone)) {
            intraBatchDuplicates += 1;
            continue;
        }

        seen.add(phone);
        prepared.push({ ...row, normalizedPhone: phone });
    }

    const candidatePhones = prepared.map((r) => r.normalizedPhone);

    const [existingContacts, dncEntries, regFBlockedPhones] = await Promise.all([
        prisma.campaignContact.findMany({
            where: { campaignId, primaryPhone: { in: candidatePhones } },
            select: { primaryPhone: true },
        }),
        prisma.dNCEntry.findMany({
            where: { phoneNumber: { in: candidatePhones } },
            select: { phoneNumber: true },
        }),
        complianceFrequency.filterBlockedPhones(candidatePhones),
    ]);

    const classified = classifyImportCandidates(prepared, {
        existingPhones: new Set(existingContacts.map((x) => x.primaryPhone)),
        dncPhones: new Set(dncEntries.map((x) => x.phoneNumber)),
        regFBlockedPhones,
    });

    const duplicateSuppressed = intraBatchDuplicates + classified.duplicateSuppressed;
    const dncSuppressed = classified.dncSuppressed;
    const regFSuppressed = classified.regFSuppressed;

    const toCreate = classified.toCreate.map((row) => ({
        campaignId,
        listId,
        externalId: row.externalId,
        accountId: row.accountId,
        firstName: row.firstName,
        lastName: row.lastName,
        primaryPhone: row.normalizedPhone,
        email: row.email,
        timezone: row.timezone,
        priority: typeof row.priority === 'number' && !Number.isNaN(row.priority) ? row.priority : 5,
        status: 'queued',
    }));

    if (toCreate.length > 0) {
        await prisma.campaignContact.createMany({ data: toCreate });
    }

    const validRecords = toCreate.length;

    await prisma.campaignList.update({
        where: { id: listId },
        data: {
            totalRecords,
            validRecords,
            invalidRecords,
            duplicateSuppressed,
            dncSuppressed,
            uploadStatus: 'imported',
        },
    });

    return {
        totalRecords,
        validRecords,
        invalidRecords,
        duplicateSuppressed,
        dncSuppressed,
        regFSuppressed,
    };
};

router.get('/', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaigns = await prisma.campaign.findMany({
        include: {
            _count: { select: { lists: true, contacts: true, attempts: true } },
        },
        orderBy: { createdAt: 'desc' },
    });

    res.json(campaigns);
});

router.post('/', authenticate, requireMinRole('supervisor'), validate(createCampaignSchema), async (req: Request, res: Response): Promise<void> => {
    const {
        name,
        description,
        dialMode,
        timezone,
        maxAttemptsPerLead,
        retryDelaySeconds,
        maxConcurrentCalls,
        dialRatio,
        voicemailBehavior,
        voicemailMessage,
        skipAmd,
        retellAgentId,
        retellSipAddress,
    } = req.body;

    const campaign = await prisma.campaign.create({
        data: {
            name,
            description,
            dialMode,
            timezone,
            maxAttemptsPerLead,
            retryDelaySeconds: Math.max(30, Math.round(toNumber(retryDelaySeconds, 600))),
            maxConcurrentCalls: Math.max(0, Math.round(toNumber(maxConcurrentCalls, 0))),
            dialRatio: Math.max(1.0, Math.min(5.0, toNumber(dialRatio, 1.0))),
            voicemailBehavior: voicemailBehavior ?? 'hangup',
            voicemailMessage: voicemailMessage ?? null,
            skipAmd: skipAmd ?? true,
            retellAgentId: retellAgentId ?? null,
            retellSipAddress: retellSipAddress ?? null,
            createdById: req.user?.id,
        },
    });

    res.status(201).json(campaign);
});

router.get('/active/next-contact', authenticate, async (req: Request, res: Response): Promise<void> => {
    const campaign = await prisma.campaign.findFirst({
        where: {
            status: 'active',
            dialMode: 'progressive',
        },
        orderBy: { updatedAt: 'desc' }
    });

    if (!campaign) {
        res.json({ contact: null, message: 'No active campaigns found.' });
        return;
    }

    const reserved = await campaignReservationService.reserveNextAgentContact(campaign, req.user!.id);
    if (!reserved) {
        res.json({ contact: null, message: 'No contacts available in current campaign.' });
        return;
    }

    res.json({ contact: reserved.contact, campaign, reservationToken: reserved.reservationToken });
});

router.get('/dialer/status', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    // Placeholder until the Phase 2 AI Autonomous worker ships; shape matches
    // the former predictiveWorker.getStatus() so the admin dashboard still renders.
    const worker: { running: boolean; lastRunAt: Date | null; note: string } = {
        running: false,
        lastRunAt: null,
        note: 'pending-phase-2',
    };

    const activeCampaigns = await prisma.campaign.findMany({
        where: {
            status: 'active',
            dialMode: { in: ['progressive', 'ai_autonomous'] },
        },
        select: {
            id: true,
            name: true,
            dialMode: true,
            status: true,
            retryDelaySeconds: true,
            maxConcurrentCalls: true,
            dialRatio: true,
            _count: { select: { contacts: true, attempts: true } },
        },
        orderBy: { updatedAt: 'desc' },
    });

    const campaigns = await Promise.all(activeCampaigns.map(async (campaign) => {
        const [queued, dialing, completed, failed, activeAttempts, availableAgents] = await Promise.all([
            prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'queued' } }),
            prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'dialing' } }),
            prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'completed' } }),
            prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'failed' } }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    status: { in: ['initiated', 'ringing', 'in-progress'] },
                    completedAt: null,
                },
            }),
            prisma.profile.count({ where: { role: { in: ['agent', 'supervisor', 'admin'] }, status: 'available' } }),
        ]);

        const controls = computeDialerGuardrails({
            dialMode: campaign.dialMode,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
            availableAgents,
            activeCalls: activeAttempts,
            dialRatio: campaign.dialRatio,
        });

        return {
            id: campaign.id,
            name: campaign.name,
            dialMode: campaign.dialMode,
            status: campaign.status,
            retryDelaySeconds: campaign.retryDelaySeconds,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
            dialRatio: campaign.dialRatio,
            totals: campaign._count,
            queue: {
                queued,
                dialing,
                completed,
                failed,
            },
            activeAttempts,
            availableAgents,
            effectiveConcurrentLimit: controls.effectiveConcurrentLimit,
            dispatchCapacity: controls.dispatchCapacity,
            queuePressure: controls.queuePressure,
            blockedReasons: controls.blockedReasons,
            warnings: controls.warnings,
        };
    }));

    res.json({ worker, campaigns });
});

router.get('/:id', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: {
            lists: {
                orderBy: { createdAt: 'desc' },
            },
            _count: {
                select: {
                    contacts: true,
                    attempts: true,
                },
            },
        },
    });

    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    res.json(campaign);
});

router.patch('/:id', authenticate, requireMinRole('supervisor'), validate(updateCampaignSchema), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);

    const current = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!current) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    const validated = req.body;
    const merged = { ...current, ...validated };
    const check = checkAiAutonomousActivation(merged as any);
    if (!check.ok) {
        res.status(400).json({
            error: 'ai_autonomous_missing_fields',
            missing: check.missing,
            message: `Cannot activate ai_autonomous campaign without: ${check.missing.join(', ')}`,
        });
        return;
    }

    const updated = await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            name: validated.name,
            description: validated.description,
            dialMode: validated.dialMode,
            timezone: validated.timezone,
            maxAttemptsPerLead: validated.maxAttemptsPerLead,
            retryDelaySeconds: validated.retryDelaySeconds === undefined ? undefined : Math.max(30, Math.round(toNumber(validated.retryDelaySeconds, 600))),
            maxConcurrentCalls: validated.maxConcurrentCalls === undefined ? undefined : Math.max(0, Math.round(toNumber(validated.maxConcurrentCalls, 0))),
            dialRatio: validated.dialRatio === undefined ? undefined : Math.max(1.0, Math.min(5.0, toNumber(validated.dialRatio, 1.0))),
            voicemailBehavior: validated.voicemailBehavior,
            voicemailMessage: validated.voicemailMessage,
            skipAmd: validated.skipAmd,
            retellAgentId: validated.retellAgentId,
            retellSipAddress: validated.retellSipAddress,
        },
    });

    if (current.status !== updated.status) {
        if (updated.status === 'active') eventBus.emit('campaign.activated', { campaignId: updated.id });
        if (updated.status === 'paused') eventBus.emit('campaign.paused', { campaignId: updated.id });
    }

    res.json(updated);
});

router.post('/:id/start', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);

    const current = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!current) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    const check = checkAiAutonomousActivation({ ...current, status: 'active' });
    if (!check.ok) {
        res.status(400).json({
            error: 'ai_autonomous_missing_fields',
            missing: check.missing,
            message: `Cannot activate ai_autonomous campaign without: ${check.missing.join(', ')}`,
        });
        return;
    }

    const updated = await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'active' },
    });

    if (current.status !== updated.status) {
        eventBus.emit('campaign.activated', { campaignId: updated.id });
    }

    res.json(updated);
});

router.post('/:id/pause', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);

    const current = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!current) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    const updated = await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'paused' },
    });

    if (current.status !== updated.status) {
        eventBus.emit('campaign.paused', { campaignId: updated.id });
    }

    res.json(updated);
});

router.get('/:id/contacts', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const { page = '1', limit = '50', status } = req.query;
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);

    const where = {
        campaignId,
        ...(status ? { status: status as string } : {}),
    };

    const [contacts, total] = await Promise.all([
        prisma.campaignContact.findMany({
            where,
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        }),
        prisma.campaignContact.count({ where }),
    ]);

    res.json({
        contacts,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
    });
});

router.get('/:id/attempts', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const { limit: limitParam = '50', offset: offsetParam = '0' } = req.query;
    const limit = Math.min(Math.max(parseInt(limitParam as string, 10), 1), 200);
    const offset = Math.max(parseInt(offsetParam as string, 10), 0);

    const [attempts, total] = await Promise.all([
        prisma.campaignAttempt.findMany({
            where: { campaignId },
            include: {
                contact: { select: { firstName: true, lastName: true, primaryPhone: true } },
                call: { select: { id: true, duration: true, status: true, recordingUrl: true } },
            },
            orderBy: { startedAt: 'desc' },
            take: limit,
            skip: offset,
        }),
        prisma.campaignAttempt.count({ where: { campaignId } }),
    ]);

    res.json({ attempts, total, limit, offset });
});

router.post('/:id/lists', authenticate, requireMinRole('supervisor'), validate(createCampaignListSchema), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const { name, sourceType } = req.body;

    const list = await prisma.campaignList.create({
        data: {
            campaignId,
            name,
            sourceType,
        },
    });

    res.status(201).json(list);
});

router.post('/:id/lists/:listId/import', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const listId = paramValue(req.params.listId);
    const { rows, csv } = req.body as { rows?: ImportRow[]; csv?: string };

    const list = await prisma.campaignList.findFirst({
        where: {
            id: listId,
            campaignId,
        },
    });

    if (!list) {
        res.status(404).json({ error: 'Campaign list not found' });
        return;
    }

    const normalizedRows = Array.isArray(rows)
        ? rows
        : (typeof csv === 'string' ? parseCsvRows(csv) : []);

    if (normalizedRows.length === 0) {
        res.status(400).json({ error: 'rows array or csv payload is required' });
        return;
    }

    const result = await importContacts(campaignId, listId, normalizedRows);
    res.json({ listId, ...result });
});

router.post('/:id/import', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const { listName, rows, csv } = req.body as { listName?: string; rows?: ImportRow[]; csv?: string };

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
    }

    const list = await prisma.campaignList.create({
        data: {
            campaignId,
            name: listName || `Upload ${new Date().toISOString()}`,
            sourceType: 'upload',
        },
    });

    const normalizedRows = Array.isArray(rows)
        ? rows
        : (typeof csv === 'string' ? parseCsvRows(csv) : []);

    if (normalizedRows.length === 0) {
        await prisma.campaignList.update({
            where: { id: list.id },
            data: { uploadStatus: 'failed' },
        });
        res.status(400).json({ error: 'rows array or csv payload is required' });
        return;
    }

    const result = await importContacts(campaignId, list.id, normalizedRows);
    res.status(201).json({ listId: list.id, ...result });
});

export default router;
