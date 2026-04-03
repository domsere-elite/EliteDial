import { prisma } from '../lib/prisma';
import { config } from '../config';

export const normalizePhone = (value: string): string => {
    const digits = value.replace(/\D/g, '');
    if (!digits) return value;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return value.startsWith('+') ? value : `+${digits}`;
};

export const resolveFallbackOutboundNumber = (configuredDefault?: string | null): string =>
    configuredDefault || '+15551000002';

class PhoneNumberService {
    async resolveOutboundNumber(preferred?: string | null): Promise<string> {
        if (preferred) {
            const normalized = normalizePhone(preferred);
            const exact = await prisma.phoneNumber.findFirst({
                where: { number: normalized, isActive: true },
                select: { number: true },
            });
            if (exact?.number) return exact.number;
        }

        const fallback = await prisma.phoneNumber.findFirst({
            where: {
                isActive: true,
                OR: [
                    { assignedTo: 'outbound' },
                    { type: 'local' },
                    { assignedTo: 'agents' },
                ],
            },
            orderBy: [{ assignedTo: 'asc' }, { createdAt: 'asc' }],
            select: { number: true },
        });

        return fallback?.number || resolveFallbackOutboundNumber(config.telephony.defaultOutboundNumber);
    }

    async listActiveOutboundNumbers(): Promise<string[]> {
        const numbers = await prisma.phoneNumber.findMany({
            where: {
                isActive: true,
                OR: [{ assignedTo: 'outbound' }, { type: 'local' }, { assignedTo: 'agents' }],
            },
            orderBy: [{ assignedTo: 'asc' }, { createdAt: 'asc' }],
            select: { number: true },
        });

        return numbers.map((item) => item.number);
    }
}

export const phoneNumberService = new PhoneNumberService();
