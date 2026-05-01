import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

type AttemptUpdate = { id: string; data: Record<string, unknown> };

function makeApp(deps: Parameters<typeof createSignalwireEventsRouter>[0]) {
    const app = express();
    app.use(express.json());
    app.use('/signalwire/events', createSignalwireEventsRouter(deps));
    return app;
}

const noop = {
    callSessionUpdate: async () => undefined,
    callSessionAddRecording: async () => undefined,
    dispatchWebhook: async () => undefined,
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaFindCompletedCall: async () => null,
    enterWrapUp: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
    resolveAgentFromRoomName: async () => null,
    defaultWrapUpSeconds: 30,
} as const;

test('integration-progressive: ringing webhook updates attempt status to ringing', async () => {
    const attemptUpdates: AttemptUpdate[] = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async (id, data) => { attemptUpdates.push({ id, data }); },
        prismaFindCallWithAttempt: async () => ({
            id: 'call-r1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-r1', contactId: 'k-r1', campaignId: 'camp-r1',
                contact: { id: 'k-r1', attemptCount: 0, campaign: { id: 'camp-r1', maxAttemptsPerLead: 3, retryDelaySeconds: 60, wrapUpSeconds: 30 } },
            }],
        }),
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-r1', call_state: 'ringing' });

    assert.equal(res.status, 200);
    const ringUpdate = attemptUpdates.find(u => u.data.status === 'ringing');
    assert.ok(ringUpdate, 'attempt updated to ringing');
    assert.equal(ringUpdate!.id, 'att-r1');
    assert.equal((ringUpdate!.data as any).outcome, undefined, 'no outcome set at ringing');
});

test('integration-progressive: answered webhook updates attempt to in-progress with outcome=human', async () => {
    const attemptUpdates: AttemptUpdate[] = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async (id, data) => { attemptUpdates.push({ id, data }); },
        prismaFindCallWithAttempt: async () => ({
            id: 'call-a1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-a1', contactId: 'k-a1', campaignId: 'camp-a1',
                contact: { id: 'k-a1', attemptCount: 0, campaign: { id: 'camp-a1', maxAttemptsPerLead: 3, retryDelaySeconds: 60, wrapUpSeconds: 30 } },
            }],
        }),
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-a1', call_state: 'answered' });

    assert.equal(res.status, 200);
    const inProgressUpdate = attemptUpdates.find(u => u.data.status === 'in-progress');
    assert.ok(inProgressUpdate, 'attempt updated to in-progress');
    assert.equal((inProgressUpdate!.data as any).outcome, 'human', 'outcome=human on answered');
});

test('integration-progressive: no-answer + non-exhausted contact → queued with future retryAt', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-na1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-na1', contactId: 'k-na1', campaignId: 'camp-na1',
                contact: { id: 'k-na1', attemptCount: 1, campaign: { id: 'camp-na1', maxAttemptsPerLead: 3, retryDelaySeconds: 300, wrapUpSeconds: 30 } },
            }],
        }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-na1', call_state: 'no-answer' });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].contactId, 'k-na1');
    assert.equal(reservationCalls[0].status, 'queued', 'non-exhausted contact re-queued');
    assert.ok(reservationCalls[0].retryAt instanceof Date, 'retryAt is a Date');
    assert.ok(
        reservationCalls[0].retryAt! > new Date(),
        'retryAt is in the future',
    );
});

test('integration-progressive: no-answer + exhausted contact → failed with no retryAt', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-ex1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-ex1', contactId: 'k-ex1', campaignId: 'camp-ex1',
                contact: { id: 'k-ex1', attemptCount: 3, campaign: { id: 'camp-ex1', maxAttemptsPerLead: 3, retryDelaySeconds: 300, wrapUpSeconds: 30 } },
            }],
        }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-ex1', call_state: 'no-answer' });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].status, 'failed', 'exhausted contact marked failed');
    assert.equal(reservationCalls[0].retryAt, null, 'no retry for exhausted contact');
});

test('integration-progressive: completed call always marks contact completed (ignores exhaustion)', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-cmp1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-cmp1', contactId: 'k-cmp1', campaignId: 'camp-cmp1',
                contact: { id: 'k-cmp1', attemptCount: 3, campaign: { id: 'camp-cmp1', maxAttemptsPerLead: 3, retryDelaySeconds: 60, wrapUpSeconds: 30 } },
            }],
        }),
        prismaFindCompletedCall: async () => ({ id: 'call-cmp1', agentId: null, accountId: null }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-cmp1', call_state: 'ended', duration: 45 });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].status, 'completed', 'completed call → contact completed');
    assert.equal(reservationCalls[0].retryAt, null);
});
