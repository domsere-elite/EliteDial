import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAIAutonomousWorker } from '../services/ai-autonomous-worker';
import { buildProcessLocalLimiter } from '../services/concurrency-limiter';
import { buildEventBus } from '../lib/event-bus';
import { buildDialPrecheck } from '../services/dial-precheck';

// End-to-end smoke: worker loads a campaign, reserves a contact, passes precheck,
// acquires a slot, "dials" via a mock initiateCall, writes the initiated row.
test('ai-autonomous-worker mock-mode integration: full path produces an initiated call', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const eventBus = buildEventBus();
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => false },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    const initiated: any[] = [];
    let queue = 1;

    const w = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 1,
            retryDelaySeconds: 600, timezone: 'America/Chicago',
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@y',
        }),
        listActiveAiCampaigns: async () => [{ id: 'camp-1' }],
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: 'k1', primaryPhone: '15551234567', timezone: null }, reservationToken: 'tok' };
        },
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async () => undefined,
        writeBlockedCallRow: async () => undefined,
        writeInitiatedCallRow: async (campaign, contact, result) => {
            initiated.push({ campaignId: campaign.id, contactId: contact.id, providerCallId: result.providerCallId });
        },
        initiateCall: async () => ({ provider: 'mock', providerCallId: `mock-call-${Date.now()}` }),
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.example',
        intervalMs: 60_000, // long interval so it doesn't fire during the test
    });

    // start() registers the call.terminal event listener and calls rebuildFromDb()
    await w.start();

    try {
        await w.tick('camp-1');

        assert.equal(initiated.length, 1);
        assert.equal(initiated[0].campaignId, 'camp-1');
        assert.equal(initiated[0].contactId, 'k1');
        assert.match(initiated[0].providerCallId, /^mock-call-/);
        assert.equal(limiter.active('camp-1'), 1);

        // Now simulate the terminal webhook → limiter releases
        eventBus.emit('call.terminal', {
            callId: 'internal-1', signalwireCallId: initiated[0].providerCallId, campaignId: 'camp-1', status: 'completed',
        });
        // Give the microtask queue a tick to process the listener
        await new Promise(r => setImmediate(r));
        assert.equal(limiter.active('camp-1'), 0);
    } finally {
        w.stop();
    }
});
