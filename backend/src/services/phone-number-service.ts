import { prisma } from '../lib/prisma';
import { config } from '../config';
import { didRouter, SelectedDID } from './did-router';
import { didHealthManager } from './did-health';
import { didSyncService } from './did-sync';
import { logger } from '../utils/logger';

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
    /**
     * Resolve the outbound number for a call.
     *
     * When campaign context is available, delegates to the DID Router for
     * proximity matching and rotation. Otherwise falls back to simple
     * DID lookup or the global default.
     */
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

    /**
     * Resolve the outbound number using the DID Router (proximity + rotation).
     * Falls back to the simple resolver if the DID Router returns nothing.
     */
    async resolveOutboundDID(params: {
        toNumber: string;
        campaignId?: string | null;
        contactId?: string | null;
        preferredFromNumber?: string | null;
    }): Promise<{ number: string; didResult: SelectedDID | null }> {
        // If a specific fromNumber was requested, try to honor it
        if (params.preferredFromNumber) {
            const normalized = normalizePhone(params.preferredFromNumber);
            const exact = await prisma.phoneNumber.findFirst({
                where: { number: normalized, isActive: true },
                select: { number: true },
            });
            if (exact?.number) {
                return { number: exact.number, didResult: null };
            }
        }

        // Use DID Router for campaign-aware proximity matching
        if (params.campaignId) {
            const didResult = await didRouter.selectOutboundDID({
                toNumber: params.toNumber,
                campaignId: params.campaignId,
                contactId: params.contactId,
                excludeLastUsedForContact: true,
            });

            if (didResult) {
                logger.debug('DID Router selected outbound number', {
                    number: didResult.number,
                    matchTier: didResult.matchTier,
                    areaCode: didResult.areaCode,
                    state: didResult.state,
                    campaignId: params.campaignId,
                });
                return { number: didResult.number, didResult };
            }
        }

        // Fallback to simple resolution
        const simple = await this.resolveOutboundNumber();
        return { number: simple, didResult: null };
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

    /**
     * Provision a new phone number with automatic geo-enrichment from the AreaCodeMap.
     */
    async provisionNumber(data: {
        number: string;
        label?: string | null;
        type?: string;
        assignedTo?: string | null;
    }) {
        const normalized = normalizePhone(data.number);
        const digits = normalized.replace(/\D/g, '');
        const areaCode = digits.length === 11 && digits.startsWith('1')
            ? digits.substring(1, 4)
            : digits.length === 10 ? digits.substring(0, 3) : null;

        const geo = areaCode
            ? await prisma.areaCodeMap.findUnique({ where: { areaCode } })
            : null;

        const tollFreeAreaCodes = ['800', '833', '844', '855', '866', '877', '888'];
        const isTollFree = areaCode ? tollFreeAreaCodes.includes(areaCode) : false;

        const phone = await prisma.phoneNumber.create({
            data: {
                number: normalized,
                label: data.label ?? null,
                type: data.type ?? (isTollFree ? 'toll-free' : 'local'),
                assignedTo: data.assignedTo ?? null,
                areaCode: areaCode ?? null,
                state: geo?.state ?? null,
                region: geo?.region ?? null,
                isActive: true,
                healthScore: 100,
                totalCallsToday: 0,
                totalCallsWeek: 0,
            },
        });

        logger.info('Phone number provisioned', { number: normalized, areaCode, state: geo?.state });
        return phone;
    }

    /**
     * Update mutable fields on a phone number record.
     */
    async updateNumber(
        phoneId: string,
        data: { label?: string | null; assignedTo?: string | null; isActive?: boolean },
    ) {
        return prisma.phoneNumber.update({
            where: { id: phoneId },
            data,
        });
    }

    /**
     * Soft-deactivate a phone number (keeps history intact).
     */
    async deactivateNumber(phoneId: string): Promise<void> {
        await prisma.phoneNumber.update({
            where: { id: phoneId },
            data: { isActive: false },
        });
        logger.info('Phone number deactivated', { phoneId });
    }

    /**
     * Flag a DID and reduce its health score (e.g., spam report).
     */
    async flagNumber(phoneId: string, reason: string, penaltyPoints?: number): Promise<void> {
        return didHealthManager.flagDID(phoneId, reason, penaltyPoints);
    }

    /**
     * Restore a flagged DID to full health and clear its cooldown.
     */
    async unflagNumber(phoneId: string): Promise<void> {
        return didHealthManager.unflagDID(phoneId);
    }

    /**
     * Return a health summary of the DID pool for diagnostics.
     */
    async getPoolHealth() {
        return didHealthManager.getPoolSummary();
    }

    /**
     * Sync the DID inventory from SignalWire and return a change summary.
     */
    async syncInventory() {
        return didSyncService.syncFromSignalWire();
    }
}

export const phoneNumberService = new PhoneNumberService();
