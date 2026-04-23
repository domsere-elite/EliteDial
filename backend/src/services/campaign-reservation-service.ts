import { randomUUID } from 'crypto';
import { Campaign, CampaignContact } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { complianceFrequency, RegFCheckResult } from './compliance-frequency';

const PREVIEW_RESERVATION_MINUTES = 5;

type ReservationOwner = {
    type: 'agent' | 'worker';
    userId?: string | null;
    token?: string | null;
};

type ReservedContactResult = {
    contact: CampaignContact;
    reservationToken: string;
};

export interface ReservationDeps {
    prisma: {
        campaignContact: {
            findFirst: (args: any) => Promise<CampaignContact | null>;
            updateMany: (args: any) => Promise<{ count: number }>;
            findUnique: (args: any) => Promise<CampaignContact | null>;
            update?: (args: any) => Promise<CampaignContact>;
        };
    };
    regFCheck: (phone: string) => Promise<RegFCheckResult>;
}

export interface CampaignReservationService {
    reserveNextAgentContact(campaign: Pick<Campaign, 'id'>, userId: string): Promise<ReservedContactResult | null>;
    reserveNextWorkerContact(campaign: Pick<Campaign, 'id'>): Promise<ReservedContactResult | null>;
    confirmDialReservation(contactId: string, reservation: ReservationOwner): Promise<CampaignContact | null>;
    releaseReservation(contactId: string): Promise<void>;
    completeReservation(
        contactId: string,
        nextStatus: 'dialing' | 'connected' | 'completed' | 'queued' | 'failed',
        nextAttemptAt?: Date | null,
    ): Promise<void>;
    failReservation(contactId: string, nextStatus: 'queued' | 'failed', nextAttemptAt: Date | null): Promise<void>;
}

export function buildCampaignReservationService(deps: ReservationDeps): CampaignReservationService {
    const buildReservationFilters = (now: Date, reservation: ReservationOwner) => {
        const filters: Array<Record<string, unknown>> = [
            { reservationExpiresAt: null },
            { reservationExpiresAt: { lte: now } },
        ];

        if (reservation.type === 'agent' && reservation.userId) {
            filters.push({ reservedByUserId: reservation.userId });
        }

        if (reservation.token) {
            filters.push({ reservationToken: reservation.token });
        }

        return filters;
    };

    const markSuppressedRegF = async (contactId: string) => {
        await deps.prisma.campaignContact.updateMany({
            where: { id: contactId },
            data: {
                status: 'suppressed-reg-f',
                reservedByUserId: null,
                reservationType: null,
                reservationToken: null,
                reservationExpiresAt: null,
            },
        });
    };

    const reserveNextContact = async (
        campaign: Pick<Campaign, 'id'>,
        owner: ReservationOwner,
    ): Promise<ReservedContactResult | null> => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const now = new Date();
            const contact = await deps.prisma.campaignContact.findFirst({
                where: {
                    campaignId: campaign.id,
                    status: { in: ['queued', 'skipped'] },
                    AND: [
                        {
                            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
                        },
                        {
                            OR: [
                                { reservationExpiresAt: null },
                                { reservationExpiresAt: { lte: now } },
                            ],
                        },
                    ],
                },
                orderBy: [{ priority: 'asc' }, { nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
            });

            if (!contact) return null;

            const regF = await deps.regFCheck(contact.primaryPhone);
            if (regF.blocked) {
                await markSuppressedRegF(contact.id);
                continue;
            }

            const reservationExpiresAt = new Date(now.getTime() + PREVIEW_RESERVATION_MINUTES * 60 * 1000);
            const claim = await deps.prisma.campaignContact.updateMany({
                where: {
                    id: contact.id,
                    status: { in: ['queued', 'skipped'] },
                    OR: [
                        { reservationExpiresAt: null },
                        { reservationExpiresAt: { lte: now } },
                    ],
                },
                data: {
                    reservedByUserId: owner.type === 'agent' ? owner.userId || null : null,
                    reservationType: owner.type,
                    reservationToken: owner.token || null,
                    reservationExpiresAt,
                },
            });

            if (claim.count === 1) {
                const reserved = await deps.prisma.campaignContact.findUnique({ where: { id: contact.id } });
                if (!reserved) return null;
                return {
                    contact: reserved,
                    reservationToken: owner.token || '',
                };
            }
        }

        return null;
    };

    return {
        async reserveNextAgentContact(campaign, userId) {
            return reserveNextContact(campaign, { type: 'agent', userId, token: randomUUID() });
        },

        async reserveNextWorkerContact(campaign) {
            return reserveNextContact(campaign, { type: 'worker', token: randomUUID() });
        },

        async confirmDialReservation(contactId, reservation) {
            const now = new Date();
            const filters = buildReservationFilters(now, reservation);
            const claim = await deps.prisma.campaignContact.updateMany({
                where: {
                    id: contactId,
                    status: { in: ['queued', 'skipped'] },
                    OR: filters,
                },
                data: {
                    status: 'dialing',
                    lastAttemptAt: now,
                    attemptCount: { increment: 1 },
                    reservedByUserId: reservation.type === 'agent' ? reservation.userId || null : null,
                    reservationType: reservation.type,
                    reservationToken: reservation.token || null,
                    reservationExpiresAt: new Date(now.getTime() + PREVIEW_RESERVATION_MINUTES * 60 * 1000),
                },
            });

            if (claim.count !== 1) return null;
            return deps.prisma.campaignContact.findUnique({ where: { id: contactId } });
        },

        async releaseReservation(contactId) {
            await deps.prisma.campaignContact.updateMany({
                where: { id: contactId },
                data: {
                    reservedByUserId: null,
                    reservationType: null,
                    reservationToken: null,
                    reservationExpiresAt: null,
                },
            });
        },

        async completeReservation(contactId, nextStatus, nextAttemptAt = null) {
            if (deps.prisma.campaignContact.update) {
                await deps.prisma.campaignContact.update({
                    where: { id: contactId },
                    data: {
                        status: nextStatus,
                        nextAttemptAt,
                        reservedByUserId: null,
                        reservationType: null,
                        reservationToken: null,
                        reservationExpiresAt: null,
                    },
                });
                return;
            }
            await deps.prisma.campaignContact.updateMany({
                where: { id: contactId },
                data: {
                    status: nextStatus,
                    nextAttemptAt,
                    reservedByUserId: null,
                    reservationType: null,
                    reservationToken: null,
                    reservationExpiresAt: null,
                },
            });
        },

        async failReservation(contactId, nextStatus, nextAttemptAt) {
            await this.completeReservation(contactId, nextStatus, nextAttemptAt);
        },
    };
}

export const campaignReservationService = buildCampaignReservationService({
    prisma,
    regFCheck: (phone) => complianceFrequency.checkRegF(phone),
});
