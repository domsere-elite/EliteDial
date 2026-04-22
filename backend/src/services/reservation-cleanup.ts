import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const CLEANUP_INTERVAL_MS = 60 * 1000; // Run every 60 seconds

export class ReservationCleanup {
    private interval: NodeJS.Timeout | null = null;
    private isRunning = false;
    private lastRunAt: string | null = null;
    private lastCleanedCount = 0;

    start() {
        if (this.interval) return;
        logger.info('ReservationCleanup starting', { intervalMs: CLEANUP_INTERVAL_MS });
        // Run immediately on start, then on interval
        void this.cleanup();
        this.interval = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        logger.info('ReservationCleanup stopped');
    }

    getStatus() {
        return {
            running: !!this.interval,
            lastRunAt: this.lastRunAt,
            lastCleanedCount: this.lastCleanedCount,
        };
    }

    private async cleanup() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastRunAt = new Date().toISOString();

        try {
            const now = new Date();

            // Release expired reservations — set them back to 'queued' so they can be re-reserved
            const result = await prisma.campaignContact.updateMany({
                where: {
                    reservationExpiresAt: { lte: now, not: null },
                    status: { in: ['queued', 'skipped'] },
                },
                data: {
                    reservedByUserId: null,
                    reservationType: null,
                    reservationToken: null,
                    reservationExpiresAt: null,
                },
            });

            this.lastCleanedCount = result.count;

            if (result.count > 0) {
                logger.info('ReservationCleanup released expired reservations', {
                    count: result.count,
                });
            }
        } catch (err) {
            logger.error('ReservationCleanup error', { error: err });
        } finally {
            this.isRunning = false;
        }
    }
}

export const reservationCleanup = new ReservationCleanup();
