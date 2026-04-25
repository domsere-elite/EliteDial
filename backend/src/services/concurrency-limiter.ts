import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

export interface ConcurrencyLimiter {
    acquire(campaignId: string, cap: number): boolean;
    release(campaignId: string): void;
    active(campaignId: string): number;
    rebuildFromDb(): Promise<void>;
    sweepStuck(): number;
}

export interface ConcurrencyLimiterDeps {
    rebuildSource: () => Promise<Map<string, number>>;
    clock?: () => number;
    stuckTimeoutMs?: number;
}

export function buildProcessLocalLimiter(deps: ConcurrencyLimiterDeps): ConcurrencyLimiter {
    const counts = new Map<string, number>();
    const acquiredAt = new Map<string, number[]>();
    const clock = deps.clock || Date.now;
    const stuckTimeoutMs = deps.stuckTimeoutMs ?? 600_000;

    return {
        acquire(campaignId, cap) {
            const current = counts.get(campaignId) || 0;
            if (current >= cap) return false;
            counts.set(campaignId, current + 1);
            const stamps = acquiredAt.get(campaignId) || [];
            stamps.push(clock());
            acquiredAt.set(campaignId, stamps);
            return true;
        },
        release(campaignId) {
            const current = counts.get(campaignId) || 0;
            if (current <= 0) return;
            counts.set(campaignId, current - 1);
            const stamps = acquiredAt.get(campaignId) || [];
            stamps.shift();
            acquiredAt.set(campaignId, stamps);
        },
        active(campaignId) {
            return counts.get(campaignId) || 0;
        },
        async rebuildFromDb() {
            const seeded = await deps.rebuildSource();
            counts.clear();
            acquiredAt.clear();
            const now = clock();
            for (const [id, n] of seeded.entries()) {
                counts.set(id, n);
                acquiredAt.set(id, new Array(n).fill(now));
            }
        },
        sweepStuck() {
            const now = clock();
            let released = 0;
            for (const [id, stamps] of acquiredAt.entries()) {
                const surviving = stamps.filter(t => now - t <= stuckTimeoutMs);
                const removed = stamps.length - surviving.length;
                if (removed > 0) {
                    released += removed;
                    acquiredAt.set(id, surviving);
                    counts.set(id, Math.max(0, (counts.get(id) || 0) - removed));
                    logger.warn('concurrency-limiter: released stuck slots', { campaignId: id, count: removed });
                }
            }
            return released;
        },
    };
}

const defaultRebuildSource = async (): Promise<Map<string, number>> => {
    const rows = await prisma.campaignAttempt.findMany({
        where: {
            call: {
                status: { in: ['initiated', 'ringing', 'in-progress'] },
                mode: 'ai_outbound',
            },
        },
        select: { campaignId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
        counts.set(r.campaignId, (counts.get(r.campaignId) || 0) + 1);
    }
    return counts;
};

export const concurrencyLimiter: ConcurrencyLimiter = buildProcessLocalLimiter({
    rebuildSource: defaultRebuildSource,
});
