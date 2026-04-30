import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProgressivePowerDialWorker,
    type ProgressivePowerDialWorkerDeps,
    type PowerDialAgent,
    type PowerDialCampaign,
    type PowerDialReserveResult,
} from '../services/progressive-power-dial-worker';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Recorder {
    legsCreated: Array<{ id: string; batchId: string; contactId: string; legIndex: number }>;
    batchesCreated: Array<{ id: string; campaignId: string; agentId: string; legCount: number; targetRef: string }>;
    notifications: Array<{ agentId: string; batchId: string; targetRef: string }>;
    legsOriginated: Array<{ to: string; from: string; batchId: string; legId: string; campaignId: string; callerId: string }>;
    legsFailed: string[];
    legProviderCallIds: Record<string, string>;
    agentsClaimed: string[];
    agentsReverted: string[];
    confirmedDials: string[];
    failedReservations: string[];
}

function makeDeps(overrides: Partial<ProgressivePowerDialWorkerDeps> & {
    agents?: PowerDialAgent[];
    campaigns?: PowerDialCampaign[];
    contactQueue?: PowerDialReserveResult[][];
    originateReturn?: (i: number) => { providerCallId: string } | null;
    claimAgentReturn?: (agentId: string) => boolean;
} = {}): { deps: ProgressivePowerDialWorkerDeps; rec: Recorder } {
    const rec: Recorder = {
        legsCreated: [],
        batchesCreated: [],
        notifications: [],
        legsOriginated: [],
        legsFailed: [],
        legProviderCallIds: {},
        agentsClaimed: [],
        agentsReverted: [],
        confirmedDials: [],
        failedReservations: [],
    };

    let idCounter = 0;
    const newId = () => `id-${++idCounter}`;

    // Track per-campaign reservation queues; each call to reserveNext pops one.
    const queues = (overrides.contactQueue || []).map((q) => [...q]);
    let queueIdx = 0;

    let originateCount = 0;

    const deps: ProgressivePowerDialWorkerDeps = {
        listAvailableAgents: async () => overrides.agents || [],
        listActivePowerDialCampaigns: async () => overrides.campaigns || [],
        reserveNext: async (_campaign) => {
            const q = queues[queueIdx];
            if (!q || q.length === 0) {
                // advance to next campaign queue if exhausted, else null
                queueIdx += 1;
                const nq = queues[queueIdx];
                if (!nq || nq.length === 0) return null;
                return nq.shift() || null;
            }
            return q.shift() || null;
        },
        confirmDial: async (contactId, _token) => { rec.confirmedDials.push(contactId); },
        failReservation: async (contactId) => { rec.failedReservations.push(contactId); },
        claimAgent: async (agentId) => {
            const ok = overrides.claimAgentReturn ? overrides.claimAgentReturn(agentId) : true;
            if (ok) rec.agentsClaimed.push(agentId);
            return ok;
        },
        revertAgent: async (agentId) => { rec.agentsReverted.push(agentId); },
        createBatch: async (params) => { rec.batchesCreated.push(params); },
        notifyAgentOfBatch: async (params) => {
            rec.notifications.push({ agentId: params.agentId, batchId: params.id, targetRef: params.targetRef });
        },
        createLeg: async (params) => { rec.legsCreated.push(params); },
        updateLegProviderCallId: async (legId, providerCallId) => {
            rec.legProviderCallIds[legId] = providerCallId;
        },
        markLegFailed: async (legId) => { rec.legsFailed.push(legId); },
        originateLeg: async (params) => {
            const i = originateCount++;
            const got = overrides.originateReturn ? overrides.originateReturn(i) : { providerCallId: `pcid-${i}` };
            if (got) {
                // Pull the URL params off the SWML to verify wiring.
                const cond = params.swml.sections.main.find((s: any) => s.cond !== undefined) as any;
                const humanReq = cond.cond.find((b: any) => b.then).then.find((s: any) => s.request);
                const url = humanReq.request.url as string;
                const sp = new URLSearchParams(url.split('?')[1] || '');
                rec.legsOriginated.push({
                    to: params.to,
                    from: params.from,
                    batchId: sp.get('batchId') || '',
                    legId: sp.get('legId') || '',
                    campaignId: sp.get('campaignId') || '',
                    callerId: sp.get('callerId') || '',
                });
            }
            return got;
        },
        pickDid: async () => '+13467760336',
        sweepExpiredWrapUps: async () => 0, // no-op for tests
        callbackUrl: 'https://api.test',
        enabled: true,
        batchTtlSeconds: 60,
        intervalMs: 1000,
        clock: () => new Date('2026-04-28T00:00:00Z'),
        newId,
    };

    // Apply explicit overrides last (so a test can replace a default fully).
    return { deps: { ...deps, ...overrides }, rec };
}

const agentA: PowerDialAgent = { id: 'agent-uuid-a', email: 'dominic@exec-strategy.com' };
const agentB: PowerDialAgent = { id: 'agent-uuid-b', email: 'someoneelse@exec-strategy.com' };

const campRatio2: PowerDialCampaign = {
    id: 'camp-2x',
    dialMode: 'progressive',
    status: 'active',
    dialRatio: 2.0,
    maxConcurrentCalls: 0,
    retellSipAddress: null,
    voicemailBehavior: 'hangup',
    voicemailMessage: null,
    skipAmd: false,
};
const campRatio1: PowerDialCampaign = {
    id: 'camp-1x',
    dialMode: 'progressive',
    status: 'active',
    dialRatio: 1.0,
    maxConcurrentCalls: 0,
    retellSipAddress: null,
    voicemailBehavior: 'hangup',
    voicemailMessage: null,
    skipAmd: false,
};
const campRatio3: PowerDialCampaign = {
    id: 'camp-3x',
    dialMode: 'progressive',
    status: 'active',
    dialRatio: 3.0,
    maxConcurrentCalls: 0,
    retellSipAddress: null,
    voicemailBehavior: 'hangup',
    voicemailMessage: null,
    skipAmd: false,
};

function contact(id: string, phone: string): PowerDialReserveResult {
    return { contact: { id, primaryPhone: phone, timezone: null }, reservationToken: `t-${id}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('power-dial-worker: disabled flag → no work, no claims, no originations', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
        enabled: false,
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    assert.equal(rec.agentsClaimed.length, 0);
    assert.equal(rec.legsOriginated.length, 0);
    assert.equal(rec.batchesCreated.length, 0);
});

test('power-dial-worker: dialRatio=1.0 campaign is skipped (stays on softphone path)', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio1],
        contactQueue: [[contact('c1', '+15551110001')]],
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    assert.equal(rec.legsOriginated.length, 0, 'no legs originated for 1:1');
    assert.equal(rec.batchesCreated.length, 0, 'no batch created for 1:1');
    assert.equal(rec.agentsClaimed.length, 0, 'agent not claimed for 1:1');
});

test('power-dial-worker: dialRatio=2.0, 1 agent → 2 legs originate in one batch', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();

    assert.equal(rec.batchesCreated.length, 1);
    assert.equal(rec.batchesCreated[0].agentId, 'agent-uuid-a');
    assert.equal(rec.batchesCreated[0].targetRef, 'dominic', 'targetRef = email local-part');
    assert.equal(rec.batchesCreated[0].legCount, 2);

    // Frontend pre-arm: agent gets a Socket.IO event with the batch info BEFORE
    // any leg originates, so the auto-accept handler is ready when the bridge fires.
    assert.equal(rec.notifications.length, 1);
    assert.deepEqual(rec.notifications[0], {
        agentId: 'agent-uuid-a',
        batchId: rec.batchesCreated[0].id,
        targetRef: 'dominic',
    });

    assert.equal(rec.legsOriginated.length, 2);
    assert.deepEqual(rec.legsOriginated.map((l) => l.to).sort(), ['+15551110001', '+15551110002']);
    assert.equal(rec.legsOriginated[0].from, '+13467760336');
    assert.equal(rec.legsOriginated[0].callerId, '+13467760336');
    assert.equal(rec.legsOriginated[0].campaignId, 'camp-2x');

    assert.deepEqual(rec.confirmedDials.sort(), ['c1', 'c2']);
    assert.equal(rec.legsFailed.length, 0);
});

test('power-dial-worker: dialRatio=3.0, 2 agents → 6 legs across two batches (one per agent)', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA, agentB],
        campaigns: [campRatio3],
        contactQueue: [[
            contact('c1', '+15551110001'),
            contact('c2', '+15551110002'),
            contact('c3', '+15551110003'),
            contact('c4', '+15551110004'),
            contact('c5', '+15551110005'),
            contact('c6', '+15551110006'),
        ]],
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();

    assert.equal(rec.batchesCreated.length, 2, 'one batch per agent');
    assert.deepEqual(
        rec.batchesCreated.map((b) => b.agentId).sort(),
        ['agent-uuid-a', 'agent-uuid-b'],
    );
    assert.equal(rec.batchesCreated[0].legCount, 3);
    assert.equal(rec.batchesCreated[1].legCount, 3);
    assert.equal(rec.legsOriginated.length, 6);
});

test('power-dial-worker: dispatchCapacity short-supply → reserves what is available, only one batch', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio3],
        contactQueue: [[contact('c1', '+15551110001')]], // only 1 contact for ratio 3
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    assert.equal(rec.batchesCreated.length, 1);
    assert.equal(rec.batchesCreated[0].legCount, 1, 'legCount reflects what was actually reserved');
    assert.equal(rec.legsOriginated.length, 1);
});

test('power-dial-worker: empty queue → agent reverted to available, no batch created', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[]], // empty queue
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    assert.equal(rec.batchesCreated.length, 0);
    assert.deepEqual(rec.agentsReverted, ['agent-uuid-a']);
});

test('power-dial-worker: agent claim race lost → no work for that agent', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
        claimAgentReturn: () => false, // someone else got the agent first
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    assert.equal(rec.agentsClaimed.length, 0, 'agent not claimed (the lock failed)');
    assert.equal(rec.batchesCreated.length, 0);
    assert.equal(rec.legsOriginated.length, 0);
});

test('power-dial-worker: every leg origination fails → batch row exists but legs marked failed and agent reverted', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
        originateReturn: () => null, // every origination fails
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();

    assert.equal(rec.batchesCreated.length, 1, 'batch row created before originating');
    assert.equal(rec.legsCreated.length, 2, 'leg rows created before originating');
    assert.equal(rec.legsFailed.length, 2, 'both legs marked failed');
    assert.deepEqual(rec.failedReservations.sort(), ['c1', 'c2']);
    assert.deepEqual(rec.agentsReverted, ['agent-uuid-a'], 'agent reverted because no leg made it out');
});

test('power-dial-worker: providerCallId stored on each successfully originated leg', async () => {
    const { deps, rec } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
        originateReturn: (i) => ({ providerCallId: `sw-${i}` }),
    });
    const w = buildProgressivePowerDialWorker(deps);
    await w.tick();
    const stored = Object.values(rec.legProviderCallIds).sort();
    assert.deepEqual(stored, ['sw-0', 'sw-1']);
});

test('power-dial-worker: tick is serialised — concurrent ticks share the same in-flight promise', async () => {
    let listAgentsCalls = 0;
    const { deps } = makeDeps({
        agents: [agentA],
        campaigns: [campRatio2],
        contactQueue: [[contact('c1', '+15551110001'), contact('c2', '+15551110002')]],
        listAvailableAgents: async () => {
            listAgentsCalls += 1;
            await new Promise((r) => setTimeout(r, 10));
            return [agentA];
        },
    });
    const w = buildProgressivePowerDialWorker(deps);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    assert.equal(listAgentsCalls, 1, 'overlapping ticks reuse one inFlight promise');
});
