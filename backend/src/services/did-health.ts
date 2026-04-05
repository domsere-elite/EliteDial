/**
 * DID Health & Cooldown Manager
 *
 * Manages DID lifecycle:
 *   - Daily counter reset (totalCallsToday → 0)
 *   - Weekly counter reset (totalCallsWeek → 0)
 *   - Cooldown enforcement when DID exceeds daily cap
 *   - Health score management (flag/unflag DIDs)
 */

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const COOLDOWN_HOURS = 24;
const HEALTH_RECOVERY_DAYS = 7;
const HEALTH_RECOVERY_POINTS = 5;
const MIN_HEALTH_SCORE = 0;
const MAX_HEALTH_SCORE = 100;

class DIDHealthManager {
    /**
     * Reset daily call counters for all DIDs.
     * Should be called at midnight via a cron or on server start.
     */
    async resetDailyCounters(): Promise<number> {
        const result = await prisma.phoneNumber.updateMany({
            where: { totalCallsToday: { gt: 0 } },
            data: { totalCallsToday: 0 },
        });

        // Clear expired cooldowns
        const cleared = await prisma.phoneNumber.updateMany({
            where: {
                cooldownUntil: { lt: new Date() },
            },
            data: { cooldownUntil: null },
        });

        logger.info('DID daily reset completed', {
            countersReset: result.count,
            cooldownsCleared: cleared.count,
        });

        return result.count;
    }

    /**
     * Reset weekly call counters for all DIDs.
     * Should be called Sunday midnight.
     */
    async resetWeeklyCounters(): Promise<number> {
        const result = await prisma.phoneNumber.updateMany({
            where: { totalCallsWeek: { gt: 0 } },
            data: { totalCallsWeek: 0 },
        });

        logger.info('DID weekly reset completed', { countersReset: result.count });
        return result.count;
    }

    /**
     * Put a DID into cooldown (e.g., hit daily cap).
     */
    async triggerCooldown(phoneId: string): Promise<void> {
        const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000);
        await prisma.phoneNumber.update({
            where: { id: phoneId },
            data: { cooldownUntil },
        });

        logger.info('DID placed in cooldown', { phoneId, cooldownUntil });
    }

    /**
     * Check all DIDs and trigger cooldown for those that exceeded their cap.
     * Called periodically or after each call batch.
     */
    async enforceCapCooldowns(defaultMaxCallsPerDay = 50): Promise<number> {
        // Find all active DIDs that have exceeded the default cap and aren't already cooling
        const overCapDIDs = await prisma.phoneNumber.findMany({
            where: {
                isActive: true,
                totalCallsToday: { gte: defaultMaxCallsPerDay },
                cooldownUntil: null,
            },
            select: { id: true, number: true, totalCallsToday: true },
        });

        for (const did of overCapDIDs) {
            await this.triggerCooldown(did.id);
        }

        if (overCapDIDs.length > 0) {
            logger.info('DIDs placed in cooldown for exceeding daily cap', {
                count: overCapDIDs.length,
                cap: defaultMaxCallsPerDay,
            });
        }

        return overCapDIDs.length;
    }

    /**
     * Manually flag a DID (reduce health score).
     * Used when a number is reported as spam, etc.
     */
    async flagDID(phoneId: string, reason: string, penaltyPoints = 30): Promise<void> {
        const did = await prisma.phoneNumber.findUnique({ where: { id: phoneId } });
        if (!did) return;

        const newHealth = Math.max(MIN_HEALTH_SCORE, did.healthScore - penaltyPoints);
        await prisma.phoneNumber.update({
            where: { id: phoneId },
            data: { healthScore: newHealth },
        });

        logger.warn('DID flagged — health reduced', {
            phoneId,
            number: did.number,
            reason,
            previousHealth: did.healthScore,
            newHealth,
        });
    }

    /**
     * Manually unflag / restore a DID's health score.
     */
    async unflagDID(phoneId: string): Promise<void> {
        await prisma.phoneNumber.update({
            where: { id: phoneId },
            data: {
                healthScore: MAX_HEALTH_SCORE,
                cooldownUntil: null,
            },
        });

        logger.info('DID unflagged — health restored', { phoneId });
    }

    /**
     * Gradually recover health for DIDs that haven't been flagged recently.
     * Called weekly.
     */
    async recoverHealth(): Promise<number> {
        const cutoff = new Date(Date.now() - HEALTH_RECOVERY_DAYS * 24 * 60 * 60 * 1000);

        // Find DIDs with reduced health that haven't been updated recently
        const degradedDIDs = await prisma.phoneNumber.findMany({
            where: {
                healthScore: { lt: MAX_HEALTH_SCORE },
                updatedAt: { lt: cutoff },
            },
            select: { id: true, healthScore: true },
        });

        for (const did of degradedDIDs) {
            const newHealth = Math.min(MAX_HEALTH_SCORE, did.healthScore + HEALTH_RECOVERY_POINTS);
            await prisma.phoneNumber.update({
                where: { id: did.id },
                data: { healthScore: newHealth },
            });
        }

        if (degradedDIDs.length > 0) {
            logger.info('DID health recovery applied', { count: degradedDIDs.length });
        }

        return degradedDIDs.length;
    }

    /**
     * Get a summary of DID pool health for diagnostics.
     */
    async getPoolSummary() {
        const [total, active, inCooldown, lowHealth, usedToday] = await Promise.all([
            prisma.phoneNumber.count(),
            prisma.phoneNumber.count({ where: { isActive: true } }),
            prisma.phoneNumber.count({ where: { cooldownUntil: { gt: new Date() } } }),
            prisma.phoneNumber.count({ where: { healthScore: { lt: 50 } } }),
            prisma.phoneNumber.count({ where: { totalCallsToday: { gt: 0 } } }),
        ]);

        return { total, active, inCooldown, lowHealth, usedToday };
    }
}

export const didHealthManager = new DIDHealthManager();
