import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildAIAutonomousWorker } from '../services/ai-autonomous-worker';
import { buildProcessLocalLimiter } from '../services/concurrency-limiter';
import { buildDialPrecheck } from '../services/dial-precheck';
import { eventBus } from '../lib/event-bus';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

let findCallResult: {
    id: string;
    agentId: string | null;
    accountId: string | null;
    campaignAttempts: Array<{
        id: string;
        contactId: string;
        campaignId: string;
        contact: { id: string; attemptCount: number; campaign: { id: string; maxAttemptsPerLead: number; retryDelaySeconds: number; wrapUpSeconds: number } };
    }>;
} | null = null;

const eventsApp = express();
eventsApp.use(express.json());
eventsApp.use('/signalwire/events', createSignalwireEventsRouter({
    callSessionUpdate: async () => undefined,
    callSessionAddRecording: async () => undefined,
    dispatchWebhook: async () => undefined,
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaUpdateCampaignAttempt: async () => undefined,
    prismaFindCallWithAttempt: async () => findCallResult,
    prismaFindCompletedCall: async () => null,
    enterWrapUp: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
    resolveAgentFromRoomName: async () => null,
    defaultWrapUpSeconds: 30,
}));

test('integration-e2e: HTTP completed webhook releases AI worker slot via shared eventBus', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => false },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    let queue = 1;
    const initiated: string[] = [];

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 1,
            retryDelaySeconds: 60, timezone: null,
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example',
        }),
        listActiveAiCampaigns: async () => [{ id: 'camp-e2e-1' }],
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: 'k1', primaryPhone: '+15551234567', timezone: null }, reservationToken: 'tok' };
        },
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async () => undefined,
        writeBlockedCallRow: async () => undefined,
        writeInitiatedCallRow: async (_c, _k, r) => { initiated.push(r.providerCallId); },
        initiateCall: async () => ({ provider: 'mock', providerCallId: 'sw-e2e-1' }),
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    findCallResult = {
        id: 'internal-1', agentId: null, accountId: null,
        campaignAttempts: [{
            id: 'att-1', contactId: 'k1', campaignId: 'camp-e2e-1',
            contact: { id: 'k1', attemptCount: 1, campaign: { id: 'camp-e2e-1', maxAttemptsPerLead: 3, retryDelaySeconds: 60, wrapUpSeconds: 30 } },
        }],
    };

    await worker.start();
    try {
        await worker.tick('camp-e2e-1');
        assert.equal(initiated.length, 1, 'call initiated');
        assert.equal(limiter.active('camp-e2e-1'), 1, 'slot held after dial');

        const res = await request(eventsApp)
            .post('/signalwire/events/call-status')
            .send({ call_id: 'sw-e2e-1', call_state: 'ended', duration: 20 });
        assert.equal(res.status, 200);

        await new Promise<void>(r => setImmediate(r));

        assert.equal(limiter.active('camp-e2e-1'), 0, 'slot released after HTTP terminal webhook');
    } finally {
        worker.stop();
        findCallResult = null;
    }
});

test('integration-e2e: DNC error in real precheck → blocked row written, no dial, no slot held', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => { throw new Error('DNC service timeout'); } },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    const blocked: Array<{ contactId: string; reasons: string[] }> = [];
    const appliedStatuses: string[] = [];

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 2,
            retryDelaySeconds: 60, timezone: 'America/Chicago',
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example',
        }),
        listActiveAiCampaigns: async () => [{ id: 'camp-e2e-2' }],
        reserveNext: (() => {
            let n = 1;
            return async () => n-- > 0
                ? { contact: { id: 'k2', primaryPhone: '+15559876543', timezone: null }, reservationToken: 'tok2' }
                : null;
        })(),
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async (contactId) => { appliedStatuses.push(contactId); },
        writeBlockedCallRow: async (_c, contact, reasons) => { blocked.push({ contactId: contact.id, reasons }); },
        writeInitiatedCallRow: async () => { throw new Error('should not be called'); },
        initiateCall: async () => { throw new Error('should not be called'); },
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    await worker.start();
    try {
        await worker.tick('camp-e2e-2');

        assert.equal(blocked.length, 1, 'blocked row written');
        assert.ok(
            blocked[0].reasons.includes('dnc_check_failed'),
            `expected dnc_check_failed, got: ${JSON.stringify(blocked[0].reasons)}`,
        );
        assert.equal(appliedStatuses.length, 1, 'applyBlockedStatus called');
        assert.equal(limiter.active('camp-e2e-2'), 0, 'no concurrency slot acquired');
    } finally {
        worker.stop();
    }
});

test('integration-e2e: campaign.activated event triggers worker tick without polling interval', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => false },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    let queue = 1;
    const initiated: string[] = [];
    let notifyDone: () => void = () => {};
    const tickDone = new Promise<void>(r => { notifyDone = r; });

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 1,
            retryDelaySeconds: 60, timezone: null,
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example',
        }),
        listActiveAiCampaigns: async () => [],
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: 'k3', primaryPhone: '+15551112222', timezone: null }, reservationToken: 'tok3' };
        },
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async () => undefined,
        writeBlockedCallRow: async () => undefined,
        writeInitiatedCallRow: async (_c, _k, r) => { initiated.push(r.providerCallId); notifyDone(); },
        initiateCall: async () => ({ provider: 'mock', providerCallId: 'sw-e2e-3' }),
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    await worker.start();
    try {
        assert.equal(initiated.length, 0, 'no calls before activation');

        eventBus.emit('campaign.activated', { campaignId: 'camp-e2e-3' });

        await Promise.race([
            tickDone,
            new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('tick did not complete within 2s')), 2_000)),
        ]);

        assert.equal(initiated.length, 1, 'tick triggered by campaign.activated');
    } finally {
        worker.stop();
    }
});
