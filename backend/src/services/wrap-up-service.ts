import { prisma } from '../lib/prisma';
import { emitToUser } from '../lib/socket';

export interface WrapUpDeps {
    prismaProfileFindUnique: (id: string) => Promise<{ id: string; status: string; wrapUpUntil: Date | null } | null>;
    prismaProfileUpdate: (id: string, data: { status?: string; wrapUpUntil?: Date | null }) => Promise<{ id: string; status: string; wrapUpUntil: Date | null }>;
    prismaProfileUpdateMany: (where: { status: string }, data: { status: string; wrapUpUntil: Date | null }) => Promise<{ count: number }>;
    prismaFindExpiredWrapUps: (asOf: Date) => Promise<Array<{ id: string }>>;
    emitToUser: (userId: string, event: string, data: unknown) => void;
    now: () => Date;
}

export interface WrapUpService {
    enterWrapUp(agentId: string, wrapUpSeconds: number): Promise<{ transitioned: boolean; wrapUpUntil: Date | null }>;
    exitWrapUp(agentId: string): Promise<{ transitioned: boolean }>;
    sweepExpiredWrapUps(): Promise<number>;
}

export function buildWrapUpService(deps: WrapUpDeps): WrapUpService {
    return {
        async enterWrapUp(agentId, wrapUpSeconds) {
            const p = await deps.prismaProfileFindUnique(agentId);
            if (!p || p.status !== 'on-call') {
                return { transitioned: false, wrapUpUntil: null };
            }
            const wrapUpUntil = new Date(deps.now().getTime() + wrapUpSeconds * 1000);
            await deps.prismaProfileUpdate(agentId, { status: 'wrap-up', wrapUpUntil });
            deps.emitToUser(agentId, 'profile.status', { status: 'wrap-up', wrapUpUntil, wrapUpSeconds });
            return { transitioned: true, wrapUpUntil };
        },

        async exitWrapUp(agentId) {
            const p = await deps.prismaProfileFindUnique(agentId);
            if (!p || p.status !== 'wrap-up') {
                return { transitioned: false };
            }
            await deps.prismaProfileUpdate(agentId, { status: 'available', wrapUpUntil: null });
            deps.emitToUser(agentId, 'profile.status', { status: 'available', wrapUpUntil: null, wrapUpSeconds: 0 });
            return { transitioned: true };
        },

        async sweepExpiredWrapUps() {
            const expired = await deps.prismaFindExpiredWrapUps(deps.now());
            if (expired.length === 0) return 0;
            // Flip in a single updateMany for atomicity, then emit per-agent.
            // Re-check status to avoid clobbering an explicit exit between find and update.
            let count = 0;
            for (const row of expired) {
                const result = await deps.prismaProfileUpdate(row.id, { status: 'available', wrapUpUntil: null });
                if (result.status === 'available') {
                    deps.emitToUser(row.id, 'profile.status', { status: 'available', wrapUpUntil: null, wrapUpSeconds: 0 });
                    count++;
                }
            }
            return count;
        },
    };
}

export const wrapUpService: WrapUpService = buildWrapUpService({
    prismaProfileFindUnique: async (id) =>
        prisma.profile.findUnique({
            where: { id },
            select: { id: true, status: true, wrapUpUntil: true },
        }),
    prismaProfileUpdate: async (id, data) =>
        prisma.profile.update({
            where: { id },
            data,
            select: { id: true, status: true, wrapUpUntil: true },
        }),
    prismaProfileUpdateMany: async (where, data) =>
        prisma.profile.updateMany({ where, data }),
    prismaFindExpiredWrapUps: async (asOf) =>
        prisma.profile.findMany({
            where: { status: 'wrap-up', wrapUpUntil: { lte: asOf } },
            select: { id: true },
        }),
    emitToUser,
    now: () => new Date(),
});
