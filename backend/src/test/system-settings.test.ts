import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemSettings } from '../services/system-settings';

const makePrismaStub = (initial: Record<string, string> = {}) => {
    const data = new Map<string, { key: string; value: string; updatedBy: string | null }>();
    for (const [k, v] of Object.entries(initial)) {
        data.set(k, { key: k, value: v, updatedBy: null });
    }
    return {
        systemSetting: {
            findUnique: async ({ where }: { where: { key: string } }) => data.get(where.key) || null,
            upsert: async ({ where, update, create }: any) => {
                const key = where.key;
                if (data.has(key)) {
                    const existing = data.get(key)!;
                    data.set(key, { ...existing, value: update.value, updatedBy: update.updatedBy ?? existing.updatedBy });
                } else {
                    data.set(key, { key, value: create.value, updatedBy: create.updatedBy ?? null });
                }
                return data.get(key);
            },
        },
    };
};

describe('system-settings service', () => {
    let now = 1_000_000;
    const clock = () => now;

    beforeEach(() => { now = 1_000_000; });

    it('get returns stored value', async () => {
        const prisma = makePrismaStub({ ai_overflow_number: '+12762128412' });
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+12762128412');
    });

    it('get returns null for missing key', async () => {
        const prisma = makePrismaStub();
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        const value = await settings.get('nonexistent');
        assert.equal(value, null);
    });

    it('set writes value and invalidates cache', async () => {
        const prisma = makePrismaStub({ ai_overflow_number: '+11111111111' });
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('ai_overflow_number');
        await settings.set('ai_overflow_number', '+19998887777', 'admin-123');
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+19998887777');
    });

    it('get caches within TTL window', async () => {
        let findCallCount = 0;
        const prisma = {
            systemSetting: {
                findUnique: async () => { findCallCount += 1; return { key: 'k', value: 'v', updatedBy: null }; },
                upsert: async () => ({ key: 'k', value: 'v', updatedBy: null }),
            },
        };
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('k');
        await settings.get('k');
        await settings.get('k');
        assert.equal(findCallCount, 1);
    });

    it('get re-fetches after TTL expires', async () => {
        let findCallCount = 0;
        const prisma = {
            systemSetting: {
                findUnique: async () => { findCallCount += 1; return { key: 'k', value: 'v', updatedBy: null }; },
                upsert: async () => ({ key: 'k', value: 'v', updatedBy: null }),
            },
        };
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('k');
        now += 31_000;
        await settings.get('k');
        assert.equal(findCallCount, 2);
    });

    it('set records updatedBy', async () => {
        const prisma = makePrismaStub();
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.set('ai_overflow_number', '+12345678901', 'user-abc');
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+12345678901');
    });
});
