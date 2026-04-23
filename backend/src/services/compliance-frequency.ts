import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

export const REG_F_CAP = 7;
export const REG_F_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ComplianceFrequencyDeps {
    prisma: {
        call: {
            count: (args: { where: { toNumber: string; createdAt: { gte: Date } } }) => Promise<number>;
        };
    };
    clock?: () => number;
}

export interface RegFCheckResult {
    blocked: boolean;
    count: number | null;
    error?: boolean;
}

export interface ComplianceFrequencyService {
    checkRegF(phone: string): Promise<RegFCheckResult>;
    filterBlockedPhones(phones: string[]): Promise<Set<string>>;
}

export function buildComplianceFrequency(deps: ComplianceFrequencyDeps): ComplianceFrequencyService {
    const clock = deps.clock || Date.now;

    const windowStart = () => new Date(clock() - REG_F_WINDOW_MS);

    return {
        async checkRegF(phone: string): Promise<RegFCheckResult> {
            try {
                const count = await deps.prisma.call.count({
                    where: { toNumber: phone, createdAt: { gte: windowStart() } },
                });
                return { blocked: count >= REG_F_CAP, count };
            } catch (err) {
                logger.error('Reg F check failed — fail-safe blocking call', { phone, error: err });
                return { blocked: true, count: null, error: true };
            }
        },

        async filterBlockedPhones(phones: string[]): Promise<Set<string>> {
            const blocked = new Set<string>();
            const since = windowStart();
            for (const phone of phones) {
                try {
                    const count = await deps.prisma.call.count({
                        where: { toNumber: phone, createdAt: { gte: since } },
                    });
                    if (count >= REG_F_CAP) blocked.add(phone);
                } catch (err) {
                    logger.error('Reg F bulk check failed — fail-safe blocking phone', { phone, error: err });
                    blocked.add(phone);
                }
            }
            return blocked;
        },
    };
}

export const complianceFrequency = buildComplianceFrequency({ prisma });
