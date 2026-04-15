import { prisma } from '../lib/prisma';

export interface SystemSettingsDeps {
    prisma: {
        systemSetting: {
            findUnique: (args: { where: { key: string } }) => Promise<{ key: string; value: string; updatedBy: string | null } | null>;
            upsert: (args: {
                where: { key: string };
                update: { value: string; updatedBy?: string | null };
                create: { key: string; value: string; updatedBy?: string | null };
            }) => Promise<{ key: string; value: string; updatedBy: string | null }>;
        };
    };
    clock?: () => number;
    ttlMs?: number;
}

export interface SystemSettingsService {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, updatedBy?: string): Promise<void>;
}

interface CacheEntry {
    value: string | null;
    expiresAt: number;
}

export function buildSystemSettings(deps: SystemSettingsDeps): SystemSettingsService {
    const clock = deps.clock || Date.now;
    const ttlMs = deps.ttlMs ?? 30_000;
    const cache = new Map<string, CacheEntry>();

    return {
        async get(key: string): Promise<string | null> {
            const cached = cache.get(key);
            if (cached && cached.expiresAt > clock()) {
                return cached.value;
            }
            const row = await deps.prisma.systemSetting.findUnique({ where: { key } });
            const value = row?.value ?? null;
            cache.set(key, { value, expiresAt: clock() + ttlMs });
            return value;
        },

        async set(key: string, value: string, updatedBy?: string): Promise<void> {
            await deps.prisma.systemSetting.upsert({
                where: { key },
                update: { value, updatedBy: updatedBy ?? null },
                create: { key, value, updatedBy: updatedBy ?? null },
            });
            cache.delete(key);
        },
    };
}

export const systemSettings = buildSystemSettings({ prisma });
