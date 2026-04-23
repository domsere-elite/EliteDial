import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCampaignReservationService } from '../services/campaign-reservation-service';

type ContactRow = {
    id: string;
    campaignId: string;
    primaryPhone: string;
    status: string;
    priority: number;
    nextAttemptAt: Date | null;
    reservationExpiresAt: Date | null;
    reservedByUserId: string | null;
    reservationType: string | null;
    reservationToken: string | null;
    lastAttemptAt: Date | null;
    attemptCount: number;
    createdAt: Date;
};

const makeStore = (initial: ContactRow[] = []) => {
    const rows = [...initial];
    const updateManyLog: any[] = [];

    const prisma = {
        campaignContact: {
            findFirst: async ({ where, orderBy }: any) => {
                const candidates = rows.filter((r) => {
                    if (r.campaignId !== where.campaignId) return false;
                    if (!where.status.in.includes(r.status)) return false;
                    return true;
                });
                candidates.sort((a, b) => {
                    if (a.priority !== b.priority) return a.priority - b.priority;
                    const aNext = a.nextAttemptAt?.getTime() ?? 0;
                    const bNext = b.nextAttemptAt?.getTime() ?? 0;
                    if (aNext !== bNext) return aNext - bNext;
                    return a.createdAt.getTime() - b.createdAt.getTime();
                });
                return candidates[0] || null;
            },
            updateMany: async ({ where, data }: any) => {
                updateManyLog.push({ where, data });
                let count = 0;
                for (const r of rows) {
                    if (r.id === where.id) {
                        if (where.status?.in && !where.status.in.includes(r.status)) continue;
                        Object.assign(r, data);
                        count += 1;
                    }
                }
                return { count };
            },
            findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
        },
    };
    return { rows, prisma, updateManyLog };
};

const makeContact = (overrides: Partial<ContactRow> = {}): ContactRow => ({
    id: 'c1',
    campaignId: 'camp-1',
    primaryPhone: '+14085550001',
    status: 'queued',
    priority: 5,
    nextAttemptAt: null,
    reservationExpiresAt: null,
    reservedByUserId: null,
    reservationType: null,
    reservationToken: null,
    lastAttemptAt: null,
    attemptCount: 0,
    createdAt: new Date('2026-04-23T10:00:00Z'),
    ...overrides,
});

describe('CampaignReservationService — reserveNextContact with Reg F check', () => {
    it('reserves a contact when Reg F check passes', async () => {
        const store = makeStore([makeContact()]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async () => ({ blocked: false, count: 0 }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.ok(result);
        assert.equal(result!.contact.id, 'c1');
    });

    it('skips a contact blocked by Reg F and reserves the next eligible one', async () => {
        const store = makeStore([
            makeContact({ id: 'blocked', primaryPhone: '+14085550001', priority: 1 }),
            makeContact({ id: 'eligible', primaryPhone: '+14085550002', priority: 2 }),
        ]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async (phone: string) => ({
                blocked: phone === '+14085550001',
                count: phone === '+14085550001' ? 7 : 0,
            }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.ok(result);
        assert.equal(result!.contact.id, 'eligible');
        const blocked = store.rows.find((r) => r.id === 'blocked')!;
        assert.equal(blocked.status, 'suppressed-reg-f');
    });

    it('marks a blocked contact as suppressed-reg-f so it is not re-checked', async () => {
        const store = makeStore([makeContact({ id: 'blocked' })]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async () => ({ blocked: true, count: 7 }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.equal(result, null);
        const row = store.rows.find((r) => r.id === 'blocked')!;
        assert.equal(row.status, 'suppressed-reg-f');
    });

    it('returns null when all contacts are Reg F blocked', async () => {
        const store = makeStore([
            makeContact({ id: 'a', primaryPhone: '+14085550001', priority: 1 }),
            makeContact({ id: 'b', primaryPhone: '+14085550002', priority: 2 }),
        ]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async () => ({ blocked: true, count: 7 }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.equal(result, null);
        assert.equal(store.rows.filter((r) => r.status === 'suppressed-reg-f').length, 2);
    });

    it('returns null when no contacts match the query at all', async () => {
        const store = makeStore([]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async () => ({ blocked: false, count: 0 }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.equal(result, null);
    });

    it('fail-safe: skips and suppresses a contact when Reg F check errors', async () => {
        const store = makeStore([makeContact()]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async () => ({ blocked: true, count: null, error: true }),
        });
        const result = await svc.reserveNextWorkerContact({ id: 'camp-1' });
        assert.equal(result, null);
        assert.equal(store.rows[0].status, 'suppressed-reg-f');
    });

    it('reserveNextAgentContact also applies Reg F check', async () => {
        const store = makeStore([
            makeContact({ id: 'blocked', primaryPhone: '+14085550001', priority: 1 }),
            makeContact({ id: 'eligible', primaryPhone: '+14085550002', priority: 2 }),
        ]);
        const svc = buildCampaignReservationService({
            prisma: store.prisma as any,
            regFCheck: async (phone: string) => ({ blocked: phone === '+14085550001', count: 7 }),
        });
        const result = await svc.reserveNextAgentContact({ id: 'camp-1' }, 'agent-1');
        assert.ok(result);
        assert.equal(result!.contact.id, 'eligible');
    });
});
