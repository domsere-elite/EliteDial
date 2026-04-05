/**
 * DID Router — Local Presence & Caller ID Rotation Engine
 *
 * ReadyMode-style 4-tier proximity cascade:
 *   1. Exact area code match → least-recently-used
 *   2. Same state           → least-recently-used
 *   3. Same region          → least-recently-used
 *   4. Fallback             → campaign/global default
 *
 * Supports:
 *   - Campaign-locked DID groups
 *   - Per-DID daily call caps with cooldown
 *   - Health score filtering (skip flagged DIDs)
 *   - Contact-level DID avoidance (use different number than last attempt)
 */

import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../utils/logger';

export type MatchTier = 'exact_area_code' | 'same_state' | 'same_region' | 'fallback';

export interface SelectedDID {
    number: string;
    phoneId: string;
    matchTier: MatchTier;
    areaCode: string | null;
    state: string | null;
    region: string | null;
}

export interface DIDSelectionParams {
    toNumber: string;
    campaignId?: string | null;
    contactId?: string | null;
    excludeLastUsedForContact?: boolean;
}

const extractAreaCode = (phoneNumber: string): string | null => {
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.substring(1, 4);
    if (digits.length === 10) return digits.substring(0, 3);
    return null;
};

class DIDRouter {
    /**
     * Select the best outbound DID based on proximity to destination,
     * campaign DID group restrictions, rotation, and health.
     */
    async selectOutboundDID(params: DIDSelectionParams): Promise<SelectedDID | null> {
        const { toNumber, campaignId, contactId, excludeLastUsedForContact } = params;
        const destAreaCode = extractAreaCode(toNumber);

        if (!destAreaCode) {
            logger.warn('DID Router: Could not extract area code', { toNumber });
            return null;
        }

        // Resolve destination geography
        const destGeo = await prisma.areaCodeMap.findUnique({
            where: { areaCode: destAreaCode },
        });

        // Load campaign DID settings if campaignId provided
        let campaign: {
            proximityMatchEnabled: boolean;
            autoRotateEnabled: boolean;
            maxCallsPerDIDPerDay: number;
            avoidRepeatDID: boolean;
            defaultDIDId: string | null;
        } | null = null;

        let campaignDIDGroupIds: string[] = [];

        if (campaignId) {
            campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                select: {
                    proximityMatchEnabled: true,
                    autoRotateEnabled: true,
                    maxCallsPerDIDPerDay: true,
                    avoidRepeatDID: true,
                    defaultDIDId: true,
                },
            });

            // Get campaign-locked DID group phone IDs
            const groups = await prisma.campaignDIDGroup.findMany({
                where: { campaignId },
                select: { groupId: true },
            });
            campaignDIDGroupIds = groups.map((g) => g.groupId);
        }

        const maxCallsPerDay = campaign?.maxCallsPerDIDPerDay ?? 50;
        const shouldAvoidRepeat = excludeLastUsedForContact ?? campaign?.avoidRepeatDID ?? true;
        const proximityEnabled = campaign?.proximityMatchEnabled ?? true;

        // Find the last DID used for this contact (for avoidance)
        let lastUsedDIDNumber: string | null = null;
        if (shouldAvoidRepeat && contactId) {
            const lastCall = await prisma.call.findFirst({
                where: {
                    direction: 'outbound',
                    OR: [
                        {
                            campaignAttempts: {
                                some: { contactId },
                            },
                        },
                    ],
                },
                orderBy: { createdAt: 'desc' },
                select: { fromNumber: true },
            });
            lastUsedDIDNumber = lastCall?.fromNumber || null;
        }

        // Build base DID filter
        const now = new Date();
        const baseWhere: Record<string, unknown> = {
            isActive: true,
            healthScore: { gte: 50 },
            totalCallsToday: { lt: maxCallsPerDay },
            OR: [
                { cooldownUntil: null },
                { cooldownUntil: { lt: now } },
            ],
        };

        // Restrict to campaign DID groups if any are assigned
        if (campaignDIDGroupIds.length > 0) {
            baseWhere.didGroupMembers = {
                some: {
                    groupId: { in: campaignDIDGroupIds },
                },
            };
        }

        // Exclude the last-used DID for this contact
        if (lastUsedDIDNumber) {
            baseWhere.number = { not: lastUsedDIDNumber };
        }

        if (proximityEnabled && destGeo) {
            // Tier 1: Exact area code match
            const tier1 = await this.queryDIDs({ ...baseWhere, areaCode: destAreaCode });
            if (tier1) {
                await this.recordUsage(tier1.id);
                return this.toResult(tier1, 'exact_area_code');
            }

            // Tier 2: Same state
            const tier2 = await this.queryDIDs({ ...baseWhere, state: destGeo.state, type: 'local' });
            if (tier2) {
                await this.recordUsage(tier2.id);
                return this.toResult(tier2, 'same_state');
            }

            // Tier 3: Same region
            const tier3 = await this.queryDIDs({ ...baseWhere, region: destGeo.region, type: 'local' });
            if (tier3) {
                await this.recordUsage(tier3.id);
                return this.toResult(tier3, 'same_region');
            }
        }

        // Tier 4: Fallback — campaign default or any available DID
        if (campaign?.defaultDIDId) {
            const defaultDID = await prisma.phoneNumber.findFirst({
                where: { id: campaign.defaultDIDId, isActive: true },
            });
            if (defaultDID) {
                await this.recordUsage(defaultDID.id);
                return this.toResult(defaultDID, 'fallback');
            }
        }

        // Last resort: any active DID (respecting group lock if set)
        const anyDID = await this.queryDIDs(baseWhere);
        if (anyDID) {
            await this.recordUsage(anyDID.id);
            return this.toResult(anyDID, 'fallback');
        }

        logger.warn('DID Router: No DID available', {
            destAreaCode,
            campaignId,
            campaignDIDGroupIds,
        });
        return null;
    }

    /**
     * Query available DIDs with least-recently-used rotation (auto-rotate).
     */
    private async queryDIDs(where: Record<string, unknown>) {
        return prisma.phoneNumber.findFirst({
            where: where as any,
            orderBy: [
                { lastUsedAt: { sort: 'asc', nulls: 'first' } },
                { totalCallsToday: 'asc' },
                { healthScore: 'desc' },
            ],
        });
    }

    /**
     * Atomically record usage: increment counters, update lastUsedAt.
     */
    private async recordUsage(phoneId: string) {
        await prisma.phoneNumber.update({
            where: { id: phoneId },
            data: {
                lastUsedAt: new Date(),
                totalCallsToday: { increment: 1 },
                totalCallsWeek: { increment: 1 },
            },
        });
    }

    /**
     * Map a PhoneNumber row to a SelectedDID result.
     */
    private toResult(
        did: { id: string; number: string; areaCode: string | null; state: string | null; region: string | null },
        tier: MatchTier,
    ): SelectedDID {
        return {
            number: did.number,
            phoneId: did.id,
            matchTier: tier,
            areaCode: did.areaCode,
            state: did.state,
            region: did.region,
        };
    }
}

export const didRouter = new DIDRouter();
