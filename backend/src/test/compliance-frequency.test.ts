import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildComplianceFrequency, REG_F_CAP, REG_F_WINDOW_MS } from '../services/compliance-frequency';

type FakeCall = { toNumber: string; createdAt: Date };

const makePrismaStub = (calls: FakeCall[]) => ({
    call: {
        count: async ({ where }: { where: any }) => {
            const phone = where.toNumber;
            const since: Date = where.createdAt.gte;
            return calls.filter((c) => c.toNumber === phone && c.createdAt >= since).length;
        },
    },
});

const makeFailingPrismaStub = () => ({
    call: {
        count: async () => { throw new Error('db exploded'); },
    },
});

const NOW = new Date('2026-04-23T12:00:00.000Z').getTime();
const clock = () => NOW;
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describe('compliance-frequency service', () => {
    describe('REG_F_CAP and REG_F_WINDOW_MS constants', () => {
        it('REG_F_CAP is 7', () => {
            assert.equal(REG_F_CAP, 7);
        });
        it('REG_F_WINDOW_MS is 7 days', () => {
            assert.equal(REG_F_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
        });
    });

    describe('checkRegF', () => {
        it('returns not blocked with count 0 when no prior calls', async () => {
            const prisma = makePrismaStub([]);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: false, count: 0 });
        });

        it('returns not blocked at 6 prior calls in window (under cap)', async () => {
            const calls = Array.from({ length: 6 }, (_, i) => ({
                toNumber: '+14085551234',
                createdAt: daysAgo(i),
            }));
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: false, count: 6 });
        });

        it('returns blocked at exactly 7 prior calls in window (at cap)', async () => {
            const calls = Array.from({ length: 7 }, (_, i) => ({
                toNumber: '+14085551234',
                createdAt: daysAgo(i),
            }));
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: true, count: 7 });
        });

        it('returns blocked when above cap', async () => {
            const calls = Array.from({ length: 10 }, (_, i) => ({
                toNumber: '+14085551234',
                createdAt: daysAgo(i % 7),
            }));
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: true, count: 10 });
        });

        it('excludes calls older than 7 days', async () => {
            const calls: FakeCall[] = [
                ...Array.from({ length: 6 }, (_, i) => ({
                    toNumber: '+14085551234',
                    createdAt: daysAgo(i), // 0..5 days ago: in window
                })),
                // 5 more from 8 days ago: out of window
                ...Array.from({ length: 5 }, () => ({
                    toNumber: '+14085551234',
                    createdAt: daysAgo(8),
                })),
            ];
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: false, count: 6 });
        });

        it('includes a call at 6d 23h 59m (just inside window)', async () => {
            const almostSeven = new Date(NOW - (7 * 24 * 60 * 60 * 1000 - 60_000));
            const calls: FakeCall[] = Array.from({ length: 7 }, (_, i) =>
                i === 0
                    ? { toNumber: '+14085551234', createdAt: almostSeven }
                    : { toNumber: '+14085551234', createdAt: daysAgo(i) }
            );
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: true, count: 7 });
        });

        it('only counts calls to the given phone number (cross-phone isolation)', async () => {
            const calls: FakeCall[] = [
                ...Array.from({ length: 7 }, (_, i) => ({ toNumber: '+19999999999', createdAt: daysAgo(i) })),
                { toNumber: '+14085551234', createdAt: daysAgo(0) },
            ];
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.deepEqual(result, { blocked: false, count: 1 });
        });

        it('counts calls to the phone across all campaigns (cross-campaign)', async () => {
            // Service queries Call.toNumber globally — no campaign filter
            // 7 calls to the same phone from any campaigns should trigger block
            const calls: FakeCall[] = Array.from({ length: 7 }, (_, i) => ({
                toNumber: '+14085551234',
                createdAt: daysAgo(i),
            }));
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.equal(result.blocked, true);
        });

        it('fail-safe: blocks on DB error', async () => {
            const prisma = makeFailingPrismaStub();
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const result = await svc.checkRegF('+14085551234');
            assert.equal(result.blocked, true);
            assert.equal(result.error, true);
        });
    });

    describe('filterBlockedPhones', () => {
        it('returns set of phones that are at-or-over cap', async () => {
            // +14085551234: 7 calls → blocked
            // +14085559999: 3 calls → not blocked
            // +14085550000: 0 calls → not blocked
            const calls: FakeCall[] = [
                ...Array.from({ length: 7 }, (_, i) => ({ toNumber: '+14085551234', createdAt: daysAgo(i) })),
                ...Array.from({ length: 3 }, (_, i) => ({ toNumber: '+14085559999', createdAt: daysAgo(i) })),
            ];
            const prisma = makePrismaStub(calls);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const blocked = await svc.filterBlockedPhones(['+14085551234', '+14085559999', '+14085550000']);
            assert.deepEqual(blocked, new Set(['+14085551234']));
        });

        it('returns empty set when nothing is blocked', async () => {
            const prisma = makePrismaStub([]);
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const blocked = await svc.filterBlockedPhones(['+14085551234', '+14085559999']);
            assert.equal(blocked.size, 0);
        });

        it('fail-safe: returns all phones as blocked on DB error', async () => {
            const prisma = makeFailingPrismaStub();
            const svc = buildComplianceFrequency({ prisma: prisma as any, clock });
            const blocked = await svc.filterBlockedPhones(['+14085551234', '+14085559999']);
            assert.deepEqual(blocked, new Set(['+14085551234', '+14085559999']));
        });
    });
});
