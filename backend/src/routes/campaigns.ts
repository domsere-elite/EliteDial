import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { predictiveWorker } from '../services/predictive-worker';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { computeDialerGuardrails, DIALER_STATS_WINDOW_MINUTES } from '../services/dialer-guardrails';
import { config } from '../config';

const router = Router();

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
    let validRecords = 0;
    let invalidRecords = 0;
    let duplicateSuppressed = 0;
    let dncSuppressed = 0;

    const seen = new Set<string>();
    const prepared: Array<ImportRow & { normalizedPhone: string }> = [];

    for (const row of rows) {
        const phone = row.phone ? normalizePhone(row.phone) : null;
        if (!phone) {
            invalidRecords += 1;
            continue;
        }

        if (seen.has(phone)) {
            duplicateSuppressed += 1;
            continue;
        }

        seen.add(phone);
        prepared.push({ ...row, normalizedPhone: phone });
    }

    const candidatePhones = prepared.map((r) => r.normalizedPhone);

    const [existingContacts, dncEntries] = await Promise.all([
        prisma.campaignContact.findMany({
            where: { campaignId, primaryPhone: { in: candidatePhones } },
            select: { primaryPhone: true },
        }),
        prisma.dNCEntry.findMany({
            where: { phoneNumber: { in: candidatePhones } },
            select: { phoneNumber: true },
        }),
    ]);

    const existingSet = new Set(existingContacts.map((x) => x.primaryPhone));
    const dncSet = new Set(dncEntries.map((x) => x.phoneNumber));

    const toCreate = [] as Array<{
        campaignId: string;
        listId: string;
        externalId?: string;
        accountId?: string;
        firstName?: string;
        lastName?: string;
        primaryPhone: string;
        email?: string;
        timezone?: string;
        priority: number;
        status: string;
    }>;

    for (const row of prepared) {
        if (existingSet.has(row.normalizedPhone)) {
            duplicateSuppressed += 1;
            continue;
        }

        if (dncSet.has(row.normalizedPhone)) {
            dncSuppressed += 1;
            continue;
        }

        toCreate.push({
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
        });
    }

    if (toCreate.length > 0) {
        await prisma.campaignContact.createMany({ data: toCreate });
    }

    validRecords = toCreate.length;

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

router.post('/', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const {
        name,
        description,
        dialMode = 'predictive',
        timezone = 'America/Chicago',
        maxAttemptsPerLead = 6,
        abandonRateLimit = 0.03,
        dialRatio = 3,
        retryDelaySeconds = 600,
        maxConcurrentCalls = 0,
        aiTargetEnabled,
        aiTarget,
    } = req.body;

    if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
    }

    const campaign = await prisma.campaign.create({
        data: {
            name,
            description,
            dialMode,
            timezone,
            maxAttemptsPerLead,
            abandonRateLimit,
            dialRatio: Math.max(0.5, toNumber(dialRatio, 3)),
            retryDelaySeconds: Math.max(30, Math.round(toNumber(retryDelaySeconds, 600))),
            maxConcurrentCalls: Math.max(0, Math.round(toNumber(maxConcurrentCalls, 0))),
            aiTargetEnabled: aiTargetEnabled || false,
            aiTarget,
            createdById: req.user?.id,
        },
    });

    res.status(201).json(campaign);
});

router.get('/active/next-contact', authenticate, async (req: Request, res: Response): Promise<void> => {
    const campaign = await prisma.campaign.findFirst({
        where: {
            status: 'active',
            dialMode: { in: ['preview', 'progressive'] },
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
    const worker = predictiveWorker.getStatus();

    const activeCampaigns = await prisma.campaign.findMany({
        where: {
            status: 'active',
            dialMode: { in: ['predictive', 'progressive'] },
        },
        select: {
            id: true,
            name: true,
            dialMode: true,
            status: true,
            abandonRateLimit: true,
            dialRatio: true,
            retryDelaySeconds: true,
            maxConcurrentCalls: true,
            _count: { select: { contacts: true, attempts: true } },
        },
        orderBy: { updatedAt: 'desc' },
    });

    const campaigns = await Promise.all(activeCampaigns.map(async (campaign) => {
        const statsWindowStart = new Date(Date.now() - DIALER_STATS_WINDOW_MINUTES * 60 * 1000);
        const [queued, dialing, completed, failed, activeAttempts, availableAgents, recentCompletedAttempts, recentAbandonedAttempts] = await Promise.all([
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
            prisma.user.count({ where: { role: { in: ['agent', 'supervisor', 'admin'] }, status: 'available' } }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    completedAt: { gte: statsWindowStart },
                },
            }),
            prisma.campaignAttempt.count({
                where: {
                    campaignId: campaign.id,
                    completedAt: { gte: statsWindowStart },
                    outcome: 'abandoned',
                },
            }),
        ]);

        const controls = computeDialerGuardrails({
            dialMode: campaign.dialMode,
            dialRatio: campaign.dialRatio,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
            availableAgents,
            activeCalls: activeAttempts,
            abandonRateLimit: campaign.abandonRateLimit,
            recentCompletedAttempts,
            recentAbandonedAttempts,
            predictiveOverdialEnabled: config.dialer.mode === 'mock',
        });

        return {
            id: campaign.id,
            name: campaign.name,
            dialMode: campaign.dialMode,
            status: campaign.status,
            abandonRateLimit: campaign.abandonRateLimit,
            dialRatio: campaign.dialRatio,
            retryDelaySeconds: campaign.retryDelaySeconds,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
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
            recentAbandonRate: controls.recentAbandonRate,
            recentCompletedAttempts: controls.recentCompletedAttempts,
            blockedReasons: controls.blockedReasons,
            warnings: controls.warnings,
        };
    }));

    res.json({ worker, campaigns });
});

router.post('/dialer/run-now', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const stats = await predictiveWorker.runNow();
    res.json({ ok: true, stats, worker: predictiveWorker.getStatus() });
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

router.patch('/:id', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            name: req.body.name,
            description: req.body.description,
            dialMode: req.body.dialMode,
            timezone: req.body.timezone,
            maxAttemptsPerLead: req.body.maxAttemptsPerLead,
            abandonRateLimit: req.body.abandonRateLimit,
            dialRatio: req.body.dialRatio === undefined ? undefined : Math.max(0.5, toNumber(req.body.dialRatio, 3)),
            retryDelaySeconds: req.body.retryDelaySeconds === undefined ? undefined : Math.max(30, Math.round(toNumber(req.body.retryDelaySeconds, 600))),
            maxConcurrentCalls: req.body.maxConcurrentCalls === undefined ? undefined : Math.max(0, Math.round(toNumber(req.body.maxConcurrentCalls, 0))),
            aiTargetEnabled: req.body.aiTargetEnabled,
            aiTarget: req.body.aiTarget,
        },
    });

    res.json(campaign);
});

router.post('/:id/start', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'active' },
    });

    res.json(campaign);
});

router.post('/:id/pause', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'paused' },
    });

    res.json(campaign);
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

router.post('/:id/lists', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const campaignId = paramValue(req.params.id);
    const { name, sourceType = 'upload' } = req.body;
    if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
    }

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
