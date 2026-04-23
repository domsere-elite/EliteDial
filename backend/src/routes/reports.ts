import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { buildComplianceCsv, CallExportRow } from '../services/compliance-export';

const router = Router();

// GET /api/reports/summary — aggregate stats
router.get('/summary', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(new Date().setHours(0, 0, 0, 0));
    const end = endDate ? new Date(endDate as string) : new Date();

    const where = { createdAt: { gte: start, lte: end } };
    const eventWhere = { createdAt: { gte: start, lte: end } };

    const [totalCalls, outbound, inbound, completed, noAnswer, busy, failed, voicemail, avgDuration, dispositions, abandonedEvents, guardrailBlocks, aiCallCount, aiCompletedCount, aiAvgDuration] = await Promise.all([
        prisma.call.count({ where }),
        prisma.call.count({ where: { ...where, direction: 'outbound' } }),
        prisma.call.count({ where: { ...where, direction: 'inbound' } }),
        prisma.call.count({ where: { ...where, status: 'completed' } }),
        prisma.call.count({ where: { ...where, status: 'no-answer' } }),
        prisma.call.count({ where: { ...where, status: 'busy' } }),
        prisma.call.count({ where: { ...where, status: 'failed' } }),
        prisma.call.count({ where: { ...where, status: 'voicemail' } }),
        prisma.call.aggregate({ where: { ...where, status: 'completed' }, _avg: { duration: true } }),
        prisma.call.groupBy({
            by: ['dispositionId'],
            where: { ...where, dispositionId: { not: null } },
            _count: true,
        }),
        prisma.callEvent.count({ where: { ...eventWhere, type: 'call.abandoned' } }),
        prisma.callEvent.count({ where: { ...eventWhere, type: 'dialer.guardrail.blocked' } }),
        prisma.call.count({ where: { ...where, channel: 'ai' } }),
        prisma.call.count({ where: { ...where, channel: 'ai', status: 'completed' } }),
        prisma.call.aggregate({ where: { ...where, channel: 'ai', status: 'completed' }, _avg: { duration: true } }),
    ]);

    const answerRate = totalCalls > 0 ? ((completed / totalCalls) * 100).toFixed(1) : '0.0';
    const abandonRate = outbound > 0 ? ((abandonedEvents / outbound) * 100).toFixed(1) : '0.0';

    res.json({
        period: { start, end },
        totalCalls,
        outbound,
        inbound,
        completed,
        noAnswer,
        busy,
        failed,
        voicemail,
        abandonedEvents,
        guardrailBlocks,
        answerRate,
        abandonRate,
        avgDuration: Math.round(avgDuration._avg.duration || 0),
        dispositions,
        aiCalls: aiCallCount,
        aiCompleted: aiCompletedCount,
        aiAvgDuration: Math.round(aiAvgDuration._avg?.duration || 0),
    });
});

// GET /api/reports/agents — per-agent breakdown
router.get('/agents', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const agents = await prisma.user.findMany({
        where: { role: { in: ['agent', 'supervisor'] } },
        select: { id: true, firstName: true, lastName: true, username: true, status: true },
    });

    const agentIds = agents.map(a => a.id);

    const [totalByAgent, answeredByAgent, avgByAgent] = await Promise.all([
        prisma.call.groupBy({
            by: ['agentId'],
            where: { agentId: { in: agentIds }, createdAt: { gte: today } },
            _count: true,
        }),
        prisma.call.groupBy({
            by: ['agentId'],
            where: { agentId: { in: agentIds }, status: 'completed', createdAt: { gte: today } },
            _count: true,
        }),
        prisma.call.groupBy({
            by: ['agentId'],
            where: { agentId: { in: agentIds }, status: 'completed', createdAt: { gte: today } },
            _avg: { duration: true },
        }),
    ]);

    // Build lookup maps
    const totalMap = new Map(totalByAgent.map(r => [r.agentId, r._count]));
    const answeredMap = new Map(answeredByAgent.map(r => [r.agentId, r._count]));
    const avgMap = new Map(avgByAgent.map(r => [r.agentId, r._avg.duration || 0]));

    const agentStats = agents.map(agent => {
        const total = totalMap.get(agent.id) || 0;
        const answered = answeredMap.get(agent.id) || 0;
        return {
            ...agent,
            totalCalls: total,
            answeredCalls: answered,
            answerRate: total > 0 ? ((answered / total) * 100).toFixed(1) : '0.0',
            avgDuration: Math.round(avgMap.get(agent.id) || 0),
        };
    });

    res.json(agentStats);
});

// GET /api/reports/hourly — calls by hour
router.get('/hourly', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [calls, abandonedEvents, guardrailBlocks] = await Promise.all([
        prisma.call.findMany({
            where: { createdAt: { gte: today } },
            select: { createdAt: true, status: true, direction: true },
        }),
        prisma.callEvent.findMany({
            where: { createdAt: { gte: today }, type: 'call.abandoned' },
            select: { createdAt: true },
        }),
        prisma.callEvent.findMany({
            where: { createdAt: { gte: today }, type: 'dialer.guardrail.blocked' },
            select: { createdAt: true },
        }),
    ]);

    const hourly: Record<number, { total: number; inbound: number; outbound: number; answered: number; abandoned: number; blocked: number }> = {};
    for (let h = 0; h < 24; h++) {
        hourly[h] = { total: 0, inbound: 0, outbound: 0, answered: 0, abandoned: 0, blocked: 0 };
    }

    calls.forEach((call) => {
        const hour = new Date(call.createdAt).getHours();
        hourly[hour].total++;
        if (call.direction === 'inbound') hourly[hour].inbound++;
        if (call.direction === 'outbound') hourly[hour].outbound++;
        if (call.status === 'completed') hourly[hour].answered++;
    });

    abandonedEvents.forEach((event) => {
        const hour = new Date(event.createdAt).getHours();
        hourly[hour].abandoned++;
    });

    guardrailBlocks.forEach((event) => {
        const hour = new Date(event.createdAt).getHours();
        hourly[hour].blocked++;
    });

    res.json(Object.entries(hourly).map(([hour, data]) => ({ hour: parseInt(hour), ...data })));
});

// GET /api/reports/compliance-export — audit-grade CSV of calls with compliance flags
router.get('/compliance-export', authenticate, requireMinRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate as string) : new Date();

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        res.status(400).json({ error: 'invalid_date_range' });
        return;
    }

    const calls = await prisma.call.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: {
            id: true,
            createdAt: true,
            direction: true,
            fromNumber: true,
            toNumber: true,
            duration: true,
            status: true,
            mode: true,
            channel: true,
            agentId: true,
            accountId: true,
            dispositionId: true,
            dispositionNote: true,
            fdcpaNotice: true,
            dncChecked: true,
            recordingUrl: true,
        },
        orderBy: { createdAt: 'asc' },
    });

    const csv = buildComplianceCsv(calls as CallExportRow[]);
    const filename = `compliance-export_${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

export default router;
