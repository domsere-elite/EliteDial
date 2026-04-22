import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class DNCService {
    // Check if a phone number is on the DNC list
    // FAIL-SAFE: If the database query fails, treat as DNC (deny the call)
    async isOnDNC(phoneNumber: string): Promise<boolean> {
        const normalized = this.normalizeNumber(phoneNumber);
        try {
            const entry = await prisma.dNCEntry.findUnique({
                where: { phoneNumber: normalized },
            });
            return !!entry;
        } catch (err) {
            logger.error('DNC check failed — fail-safe blocking call', { phoneNumber: normalized, error: err });
            return true;
        }
    }

    // Add a number to the DNC list
    async addToDNC(phoneNumber: string, reason?: string, addedBy?: string): Promise<void> {
        const normalized = this.normalizeNumber(phoneNumber);
        await prisma.dNCEntry.upsert({
            where: { phoneNumber: normalized },
            create: { phoneNumber: normalized, reason, addedBy },
            update: { reason, addedBy },
        });
        logger.info('Number added to DNC', { phoneNumber: normalized, reason });
    }

    // Remove a number from the DNC list
    async removeFromDNC(phoneNumber: string): Promise<boolean> {
        const normalized = this.normalizeNumber(phoneNumber);
        try {
            await prisma.dNCEntry.delete({ where: { phoneNumber: normalized } });
            logger.info('Number removed from DNC', { phoneNumber: normalized });
            return true;
        } catch {
            return false;
        }
    }

    // Get all DNC entries with pagination
    async listDNC(page: number = 1, limit: number = 50): Promise<{ entries: any[]; total: number }> {
        const [entries, total] = await Promise.all([
            prisma.dNCEntry.findMany({
                skip: (page - 1) * limit,
                take: limit,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.dNCEntry.count(),
        ]);
        return { entries, total };
    }

    // Bulk import DNC numbers
    async bulkImport(numbers: string[], reason?: string, addedBy?: string): Promise<number> {
        let imported = 0;
        for (const num of numbers) {
            const normalized = this.normalizeNumber(num);
            if (normalized.length >= 10) {
                try {
                    await prisma.dNCEntry.upsert({
                        where: { phoneNumber: normalized },
                        create: { phoneNumber: normalized, reason: reason || 'bulk import', addedBy },
                        update: {},
                    });
                    imported++;
                } catch (err) {
                    logger.warn('Failed to import DNC number', { number: normalized, error: err });
                }
            }
        }
        return imported;
    }

    private normalizeNumber(phone: string): string {
        const digits = phone.replace(/\D/g, '');
        if (digits.length === 11 && digits.startsWith('1')) return digits;
        if (digits.length === 10) return '1' + digits;
        return digits;
    }
}

export const dncService = new DNCService();
