/**
 * DID Sync — SignalWire Inventory Auto-Sync
 *
 * Pulls the full DID inventory from your SignalWire space and upserts
 * each number into the PhoneNumber table with geo metadata resolved
 * from the AreaCodeMap.
 */

import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../utils/logger';

interface SignalWirePhoneNumber {
    sid: string;
    phone_number: string;
    friendly_name?: string;
    capabilities?: {
        voice?: boolean;
        sms?: boolean;
        mms?: boolean;
    };
}

interface SignalWireListResponse {
    incoming_phone_numbers: SignalWirePhoneNumber[];
    next_page_uri?: string | null;
    page: number;
    page_size: number;
    total: number;
}

const extractAreaCode = (phoneNumber: string): string | null => {
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.substring(1, 4);
    if (digits.length === 10) return digits.substring(0, 3);
    return null;
};

class DIDSyncService {
    /**
     * Fetch all DIDs from SignalWire and upsert into the local database.
     * Returns a summary of what was created/updated/deactivated.
     */
    async syncFromSignalWire(): Promise<{
        fetched: number;
        created: number;
        updated: number;
        deactivated: number;
    }> {
        if (!config.isSignalWireConfigured) {
            logger.warn('DID Sync: SignalWire not configured, skipping');
            return { fetched: 0, created: 0, updated: 0, deactivated: 0 };
        }

        const allNumbers = await this.fetchAllDIDs();
        logger.info('DID Sync: Fetched DIDs from SignalWire', { count: allNumbers.length });

        // Pre-load area code map for geo resolution
        const areaCodeMap = new Map<string, { state: string; region: string; city: string | null }>();
        const mapEntries = await prisma.areaCodeMap.findMany();
        for (const entry of mapEntries) {
            areaCodeMap.set(entry.areaCode, {
                state: entry.state,
                region: entry.region,
                city: entry.city,
            });
        }

        let created = 0;
        let updated = 0;
        const syncedNumbers = new Set<string>();

        for (const swNumber of allNumbers) {
            const number = swNumber.phone_number;
            syncedNumbers.add(number);

            const areaCode = extractAreaCode(number);
            const geo = areaCode ? areaCodeMap.get(areaCode) : null;

            const isTollFree = areaCode
                ? ['800', '833', '844', '855', '866', '877', '888'].includes(areaCode)
                : false;

            const existing = await prisma.phoneNumber.findUnique({
                where: { number },
            });

            if (existing) {
                // Update geo fields if they're missing
                if (!existing.areaCode || !existing.state) {
                    await prisma.phoneNumber.update({
                        where: { id: existing.id },
                        data: {
                            areaCode: areaCode || existing.areaCode,
                            state: geo?.state || existing.state,
                            region: geo?.region || existing.region,
                            type: isTollFree ? 'toll-free' : 'local',
                            label: swNumber.friendly_name || existing.label,
                            isActive: true,
                        },
                    });
                    updated++;
                }
            } else {
                await prisma.phoneNumber.create({
                    data: {
                        number,
                        label: swNumber.friendly_name || null,
                        type: isTollFree ? 'toll-free' : 'local',
                        areaCode: areaCode || null,
                        state: geo?.state || null,
                        region: geo?.region || null,
                        isActive: true,
                        healthScore: 100,
                        totalCallsToday: 0,
                        totalCallsWeek: 0,
                    },
                });
                created++;
            }
        }

        // Deactivate numbers no longer in SignalWire
        const allLocal = await prisma.phoneNumber.findMany({
            where: { isActive: true },
            select: { id: true, number: true },
        });

        let deactivated = 0;
        for (const local of allLocal) {
            if (!syncedNumbers.has(local.number)) {
                await prisma.phoneNumber.update({
                    where: { id: local.id },
                    data: { isActive: false },
                });
                deactivated++;
            }
        }

        logger.info('DID Sync complete', {
            fetched: allNumbers.length,
            created,
            updated,
            deactivated,
        });

        return { fetched: allNumbers.length, created, updated, deactivated };
    }

    /**
     * Fetch all pages of DIDs from SignalWire's LAML API.
     */
    private async fetchAllDIDs(): Promise<SignalWirePhoneNumber[]> {
        const allNumbers: SignalWirePhoneNumber[] = [];
        let page = 0;
        const pageSize = 100;
        let hasMore = true;

        while (hasMore) {
            const url = `https://${config.signalwire.spaceUrl}/api/laml/2010-04-01/Accounts/${config.signalwire.projectId}/IncomingPhoneNumbers.json?Page=${page}&PageSize=${pageSize}`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64'),
                },
            });

            if (!response.ok) {
                const body = await response.text();
                logger.error('DID Sync: SignalWire API error', { status: response.status, body });
                break;
            }

            const data = (await response.json()) as SignalWireListResponse;
            allNumbers.push(...(data.incoming_phone_numbers || []));

            if (!data.next_page_uri || data.incoming_phone_numbers.length < pageSize) {
                hasMore = false;
            } else {
                page++;
            }
        }

        return allNumbers;
    }
}

export const didSyncService = new DIDSyncService();
