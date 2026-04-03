import { randomUUID } from 'crypto';
import { Campaign, CampaignContact } from '@prisma/client';
import { prisma } from '../lib/prisma';

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

class CampaignReservationService {
    async reserveNextAgentContact(campaign: Pick<Campaign, 'id'>, userId: string): Promise<ReservedContactResult | null> {
        return this.reserveNextContact(campaign, {
            type: 'agent',
            userId,
            token: randomUUID(),
        });
    }

    async reserveNextWorkerContact(campaign: Pick<Campaign, 'id'>): Promise<ReservedContactResult | null> {
        return this.reserveNextContact(campaign, {
            type: 'worker',
            token: randomUUID(),
        });
    }

    async confirmDialReservation(contactId: string, reservation: ReservationOwner): Promise<CampaignContact | null> {
        const now = new Date();
        const filters = this.buildReservationFilters(now, reservation);
        const claim = await prisma.campaignContact.updateMany({
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
        return prisma.campaignContact.findUnique({ where: { id: contactId } });
    }

    async releaseReservation(contactId: string) {
        await prisma.campaignContact.updateMany({
            where: { id: contactId },
            data: {
                reservedByUserId: null,
                reservationType: null,
                reservationToken: null,
                reservationExpiresAt: null,
            },
        });
    }

    async completeReservation(contactId: string, nextStatus: 'dialing' | 'connected' | 'completed' | 'queued' | 'failed', nextAttemptAt: Date | null = null) {
        await prisma.campaignContact.update({
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
    }

    async failReservation(contactId: string, nextStatus: 'queued' | 'failed', nextAttemptAt: Date | null) {
        await this.completeReservation(contactId, nextStatus, nextAttemptAt);
    }

    private async reserveNextContact(campaign: Pick<Campaign, 'id'>, owner: ReservationOwner): Promise<ReservedContactResult | null> {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const now = new Date();
            const contact = await prisma.campaignContact.findFirst({
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

            const reservationExpiresAt = new Date(now.getTime() + PREVIEW_RESERVATION_MINUTES * 60 * 1000);
            const claim = await prisma.campaignContact.updateMany({
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
                const reserved = await prisma.campaignContact.findUnique({ where: { id: contact.id } });
                if (!reserved) return null;
                return {
                    contact: reserved,
                    reservationToken: owner.token || '',
                };
            }
        }

        return null;
    }

    private buildReservationFilters(now: Date, reservation: ReservationOwner) {
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
    }
}

export const campaignReservationService = new CampaignReservationService();
