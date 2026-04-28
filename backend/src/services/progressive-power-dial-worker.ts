/**
 * ProgressivePowerDialWorker — Phase 2 multi-leg dispatch loop.
 *
 * Responsibilities:
 *  - Poll active progressive campaigns with dialRatio > 1.0 on an interval.
 *  - For each available agent, originate floor(dialRatio) parallel PSTN legs to
 *    queued contacts. The legs share an inline SWML doc that runs detect_machine,
 *    then for human answers POSTs back to /swml/power-dial/claim — the first
 *    leg to win the atomic claim gets the agent bridge; others fall through to
 *    AI overflow (when configured) or hang up.
 *  - Strict 1:1 (dialRatio == 1.0) is intentionally untouched so the existing
 *    softphone path is unaffected.
 *  - Disabled by default via config.powerDial.workerEnabled. The whole module
 *    is deployed dark; turn it on per-environment after smoke testing.
 *
 * Why a separate worker (not folded into ai-autonomous-worker):
 *  - Different dispatch shape: agent-batched, not concurrency-pool-driven.
 *  - Different reservation model: legCount contacts reserved per agent per tick.
 *  - Touching ai-autonomous-worker risks regressing the AI autonomous path,
 *    which is in production and stable.
 */

import { logger } from '../utils/logger';
import {
    powerDialDetectSwml,
    type SwmlDocument,
} from './swml/builder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PowerDialAgent {
    id: string;
    email: string;
}

export interface PowerDialCampaign {
    id: string;
    dialMode: string;
    status: string;
    dialRatio: number;
    maxConcurrentCalls: number;
}

export interface PowerDialContact {
    id: string;
    primaryPhone: string;
    timezone: string | null;
}

export interface PowerDialReserveResult {
    contact: PowerDialContact;
    reservationToken: string;
}

export interface PowerDialBatchInsert {
    id: string;
    campaignId: string;
    agentId: string;
    targetRef: string;
    legCount: number;
    expiresAt: Date;
}

export interface PowerDialLegInsert {
    id: string;
    batchId: string;
    contactId: string;
    legIndex: number;
}

export interface ProgressivePowerDialWorkerDeps {
    listAvailableAgents: () => Promise<PowerDialAgent[]>;
    listActivePowerDialCampaigns: () => Promise<PowerDialCampaign[]>;
    reserveNext: (campaign: PowerDialCampaign) => Promise<PowerDialReserveResult | null>;
    confirmDial: (contactId: string, token: string) => Promise<void>;
    failReservation: (contactId: string) => Promise<void>;
    claimAgent: (agentId: string) => Promise<boolean>; // atomic 'available' → 'on-call'
    revertAgent: (agentId: string) => Promise<void>;
    createBatch: (params: PowerDialBatchInsert) => Promise<void>;
    createLeg: (params: PowerDialLegInsert) => Promise<void>;
    updateLegProviderCallId: (legId: string, providerCallId: string) => Promise<void>;
    markLegFailed: (legId: string) => Promise<void>;
    originateLeg: (params: {
        to: string;
        from: string;
        swml: SwmlDocument;
        statusUrl: string;
    }) => Promise<{ providerCallId: string } | null>;
    pickDid: (campaign: PowerDialCampaign, contact: PowerDialContact) => Promise<string | null>;
    callbackUrl: string;
    enabled: boolean;
    batchTtlSeconds: number;
    intervalMs?: number;
    clock?: () => Date;
    newId?: () => string;
}

export interface ProgressivePowerDialWorker {
    start(): void;
    stop(): void;
    tick(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildProgressivePowerDialWorker(
    deps: ProgressivePowerDialWorkerDeps,
): ProgressivePowerDialWorker {
    const {
        listAvailableAgents,
        listActivePowerDialCampaigns,
        reserveNext,
        confirmDial,
        failReservation,
        claimAgent,
        revertAgent,
        createBatch,
        createLeg,
        updateLegProviderCallId,
        markLegFailed,
        originateLeg,
        pickDid,
        callbackUrl,
        enabled,
        batchTtlSeconds,
        intervalMs = 5_000,
        clock = () => new Date(),
        newId = defaultNewId,
    } = deps;

    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let tickInFlight: Promise<void> | null = null;

    function targetRefFromEmail(email: string): string {
        // /private/<ref> resolves against the Fabric subscriber's display_name,
        // which SignalWire auto-derives as the email's local-part. The
        // softphone session burned three days finding this.
        const at = email.indexOf('@');
        return at > 0 ? email.slice(0, at) : email;
    }

    async function runOnce(): Promise<void> {
        if (!enabled) return;

        const [agents, campaigns] = await Promise.all([
            listAvailableAgents(),
            listActivePowerDialCampaigns(),
        ]);

        if (agents.length === 0 || campaigns.length === 0) return;

        // Naive assignment: every available agent serves every active power-dial
        // campaign. Picks the first campaign with capacity. If multi-campaign
        // assignment is needed later, replace with a Profile.assignedCampaignIds
        // lookup (see Phase 2 design § "Open questions").
        for (const agent of agents) {
            for (const campaign of campaigns) {
                const dispatched = await dispatchOneBatch(agent, campaign);
                if (dispatched) break; // one batch per agent per tick
            }
        }
    }

    async function dispatchOneBatch(
        agent: PowerDialAgent,
        campaign: PowerDialCampaign,
    ): Promise<boolean> {
        // Belt-and-suspenders: dialRatio = 1.0 stays on the softphone path.
        if (!(campaign.dialRatio > 1.0)) return false;

        const legCountTarget = Math.floor(campaign.dialRatio);
        if (legCountTarget < 2) return false;

        // Atomically claim the agent. If lost the race (another tick or a
        // softphone dial already grabbed them), skip.
        const claimed = await claimAgent(agent.id);
        if (!claimed) return false;

        // Reserve up to legCountTarget contacts. May come up short; that's OK
        // if at least one originates. Empty queue → revert and skip.
        const reserved: PowerDialReserveResult[] = [];
        for (let i = 0; i < legCountTarget; i += 1) {
            const r = await reserveNext(campaign);
            if (!r) break;
            reserved.push(r);
        }

        if (reserved.length === 0) {
            await revertAgent(agent.id);
            return false;
        }

        const targetRef = targetRefFromEmail(agent.email);
        const batchId = newId();
        const expiresAt = new Date(clock().getTime() + batchTtlSeconds * 1000);

        await createBatch({
            id: batchId,
            campaignId: campaign.id,
            agentId: agent.id,
            targetRef,
            legCount: reserved.length,
            expiresAt,
        });

        let originatedAny = false;
        for (let legIndex = 0; legIndex < reserved.length; legIndex += 1) {
            const { contact, reservationToken } = reserved[legIndex];
            const legId = newId();

            try {
                await createLeg({ id: legId, batchId, contactId: contact.id, legIndex });
                await confirmDial(contact.id, reservationToken);

                const did = await pickDid(campaign, contact);
                const fromNumber = did || '';
                if (!fromNumber) {
                    logger.warn('power-dial-worker: no DID available, marking leg failed', {
                        batchId, legId, contactId: contact.id,
                    });
                    await markLegFailed(legId);
                    await failReservation(contact.id);
                    continue;
                }

                const swml = powerDialDetectSwml({
                    claimUrl: `${callbackUrl}/swml/power-dial/claim`,
                    voicemailUrl: `${callbackUrl}/swml/power-dial/voicemail`,
                    batchId,
                    legId,
                    campaignId: campaign.id,
                    callerId: fromNumber,
                });

                const result = await originateLeg({
                    to: contact.primaryPhone,
                    from: fromNumber,
                    swml,
                    statusUrl: `${callbackUrl}/signalwire/events/call-status`,
                });

                if (!result) {
                    await markLegFailed(legId);
                    await failReservation(contact.id);
                    continue;
                }

                await updateLegProviderCallId(legId, result.providerCallId);
                originatedAny = true;
            } catch (err) {
                logger.error('power-dial-worker: leg dispatch error', {
                    batchId, legId, contactId: contact.id, err,
                });
                await markLegFailed(legId);
                await failReservation(contact.id);
            }
        }

        if (!originatedAny) {
            // No legs went out at all — revert the agent so they can be picked
            // again next tick. Batch row stays for diagnostics.
            await revertAgent(agent.id);
            return false;
        }

        return true;
    }

    async function tick(): Promise<void> {
        if (tickInFlight) {
            await tickInFlight;
            return;
        }
        tickInFlight = runOnce().finally(() => { tickInFlight = null; });
        await tickInFlight;
    }

    function start(): void {
        if (!enabled) {
            logger.info('power-dial-worker: disabled by config; not starting');
            return;
        }
        if (intervalHandle) return;
        intervalHandle = setInterval(() => {
            tick().catch((err) => {
                logger.error('power-dial-worker: tick error', { err });
            });
        }, intervalMs);
        logger.info('power-dial-worker: started', { intervalMs, batchTtlSeconds });
    }

    function stop(): void {
        if (intervalHandle) {
            clearInterval(intervalHandle);
            intervalHandle = null;
        }
    }

    return { start, stop, tick };
}

// crypto.randomUUID is fine; isolated to one helper so tests can inject a
// deterministic id generator.
import { randomUUID } from 'crypto';
function defaultNewId(): string { return randomUUID(); }

// ---------------------------------------------------------------------------
// Default singleton wiring
// ---------------------------------------------------------------------------

import { prisma } from '../lib/prisma';
import { config } from '../config';
import { campaignReservationService } from './campaign-reservation-service';
import { signalwireService } from './signalwire';
import { didRouter } from './did-router';

const defaultCallbackUrl =
    config.publicUrls?.backend || `http://localhost:${config.port}`;

const defaultListAvailableAgents = async (): Promise<PowerDialAgent[]> => {
    const rows = await prisma.profile.findMany({
        where: {
            status: 'available',
            role: { in: ['agent', 'supervisor', 'admin'] },
        },
        select: { id: true, email: true },
        orderBy: { updatedAt: 'asc' },
    });
    return rows;
};

const defaultListActivePowerDialCampaigns = async (): Promise<PowerDialCampaign[]> => {
    return prisma.campaign.findMany({
        where: {
            dialMode: 'progressive',
            status: 'active',
            dialRatio: { gt: 1.0 },
        },
        select: {
            id: true,
            dialMode: true,
            status: true,
            dialRatio: true,
            maxConcurrentCalls: true,
        },
    });
};

const defaultReserveNext = async (
    campaign: PowerDialCampaign,
): Promise<PowerDialReserveResult | null> => {
    return campaignReservationService.reserveNextWorkerContact({ id: campaign.id });
};

const defaultConfirmDial = async (contactId: string, token: string): Promise<void> => {
    await campaignReservationService.confirmDialReservation(contactId, { type: 'worker', token });
};

const defaultFailReservation = async (contactId: string): Promise<void> => {
    await campaignReservationService.failReservation(contactId, 'queued', null);
};

// Atomic 'available' → 'on-call' transition. Same pattern the SWML
// connect-agent route uses; returns true if we won the slot.
const defaultClaimAgent = async (agentId: string): Promise<boolean> => {
    const result = await prisma.profile.updateMany({
        where: { id: agentId, status: 'available' },
        data: { status: 'on-call' },
    });
    return result.count === 1;
};

const defaultRevertAgent = async (agentId: string): Promise<void> => {
    await prisma.profile.updateMany({
        where: { id: agentId, status: 'on-call' },
        data: { status: 'available' },
    });
};

const defaultCreateBatch = async (p: PowerDialBatchInsert): Promise<void> => {
    await prisma.powerDialBatch.create({ data: p });
};

const defaultCreateLeg = async (p: PowerDialLegInsert): Promise<void> => {
    await prisma.powerDialLeg.create({ data: p });
};

const defaultUpdateLegProviderCallId = async (legId: string, providerCallId: string): Promise<void> => {
    await prisma.powerDialLeg.update({
        where: { id: legId },
        data: { providerCallId },
    });
};

const defaultMarkLegFailed = async (legId: string): Promise<void> => {
    await prisma.powerDialLeg.update({
        where: { id: legId },
        data: { status: 'failed', completedAt: new Date() },
    });
};

const defaultOriginateLeg = async (params: {
    to: string;
    from: string;
    swml: SwmlDocument;
    statusUrl: string;
}): Promise<{ providerCallId: string } | null> => {
    const r = await signalwireService.originatePowerDialLeg(params);
    if (!r) return null;
    return { providerCallId: r.providerCallId };
};

const defaultPickDid = async (
    campaign: PowerDialCampaign,
    contact: PowerDialContact,
): Promise<string | null> => {
    const selected = await didRouter.selectOutboundDID({
        toNumber: contact.primaryPhone,
        campaignId: campaign.id,
        contactId: contact.id,
    });
    return selected?.number || config.telephony.defaultOutboundNumber || null;
};

export const progressivePowerDialWorker: ProgressivePowerDialWorker = buildProgressivePowerDialWorker({
    listAvailableAgents: defaultListAvailableAgents,
    listActivePowerDialCampaigns: defaultListActivePowerDialCampaigns,
    reserveNext: defaultReserveNext,
    confirmDial: defaultConfirmDial,
    failReservation: defaultFailReservation,
    claimAgent: defaultClaimAgent,
    revertAgent: defaultRevertAgent,
    createBatch: defaultCreateBatch,
    createLeg: defaultCreateLeg,
    updateLegProviderCallId: defaultUpdateLegProviderCallId,
    markLegFailed: defaultMarkLegFailed,
    originateLeg: defaultOriginateLeg,
    pickDid: defaultPickDid,
    callbackUrl: defaultCallbackUrl,
    enabled: config.powerDial.workerEnabled,
    batchTtlSeconds: config.powerDial.batchTtlSeconds,
    intervalMs: config.dialer.pollIntervalMs,
});
