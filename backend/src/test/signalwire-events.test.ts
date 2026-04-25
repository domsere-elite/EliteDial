import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

type Update = {
    provider: string;
    providerCallId: string;
    status: string;
    duration: number;
    answeredAt: Date | null;
    completedAt: Date | null;
};

const captured: { statusUpdates: Update[]; webhooksDispatched: Array<{ event: string; payload: unknown }>; recordingAttached: unknown[] } = {
    statusUpdates: [],
    webhooksDispatched: [],
    recordingAttached: [],
};

const fakeDeps = {
    callSessionUpdate: async (u: Update) => { captured.statusUpdates.push(u); },
    callSessionAddRecording: async (r: unknown) => { captured.recordingAttached.push(r); },
    dispatchWebhook: async (event: string, payload: unknown) => { captured.webhooksDispatched.push({ event, payload }); },
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaUpdateCampaignAttempt: async () => undefined,
    prismaFindCallWithAttempt: async () => null,
    prismaFindCompletedCall: async () => null,
    releaseAgent: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
};

const app = express();
app.use(express.json());
app.use('/signalwire/events', createSignalwireEventsRouter(fakeDeps));

test('POST /signalwire/events/call-status "answered" maps to in-progress and dispatches call.answered', async () => {
    captured.statusUpdates = [];
    captured.webhooksDispatched = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({
            call_id: 'c-abc-123',
            call_state: 'answered',
            from: '+15551112222',
            to: '+15553334444',
            direction: 'outbound',
            timestamp: '2026-04-22T12:00:00Z',
        });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates.length, 1);
    assert.equal(captured.statusUpdates[0].status, 'in-progress');
    assert.equal(captured.statusUpdates[0].providerCallId, 'c-abc-123');
    assert.ok(captured.webhooksDispatched.some((w) => w.event === 'call.answered'));
});

test('POST /signalwire/events/call-status "ended" maps to completed and dispatches call.completed', async () => {
    captured.statusUpdates = [];
    captured.webhooksDispatched = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({
            call_id: 'c-xyz-999',
            call_state: 'ended',
            from: '+15551112222',
            to: '+15553334444',
            direction: 'outbound',
            timestamp: '2026-04-22T12:05:00Z',
            duration: 42,
        });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates[0].status, 'completed');
    assert.equal(captured.statusUpdates[0].duration, 42);
    assert.ok(captured.webhooksDispatched.some((w) => w.event === 'call.completed'));
});

test('POST /signalwire/events/call-status "ringing" does not dispatch call.answered', async () => {
    captured.webhooksDispatched = [];
    await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'c-r', call_state: 'ringing', from: '', to: '' });
    assert.equal(captured.webhooksDispatched.filter((w) => w.event === 'call.answered').length, 0);
});

test('POST /signalwire/events/call-status with missing call_id returns 200 and no-ops', async () => {
    captured.statusUpdates = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_state: 'answered' });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates.length, 0);
});

test('POST /signalwire/events/recording attaches recording URL', async () => {
    captured.recordingAttached = [];
    const res = await request(app)
        .post('/signalwire/events/recording')
        .send({
            call_id: 'c-rec-1',
            state: 'finished',
            url: 'https://example.test/recordings/abc.mp3',
            duration: 90,
        });
    assert.equal(res.status, 200);
    assert.equal(captured.recordingAttached.length, 1);
});

test('signalwire-events: completed status emits call.terminal with campaignId from attempt', async () => {
    const { eventBus } = await import('../lib/event-bus');
    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventBus.on('call.terminal', listener);

    const { createSignalwireEventsRouter } = await import('../routes/signalwire-events');
    const app = express();
    app.use(express.json());
    app.use('/signalwire/events', createSignalwireEventsRouter({
        callSessionUpdate: async () => undefined,
        callSessionAddRecording: async () => undefined,
        dispatchWebhook: async () => undefined,
        auditTrack: async () => undefined,
        prismaUpdateCall: async () => undefined,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'a1', contactId: 'k1', campaignId: 'camp-x',
                contact: { id: 'k1', attemptCount: 1, campaign: { maxAttemptsPerLead: 6, retryDelaySeconds: 600 } },
            }],
        }),
        prismaFindCompletedCall: async () => ({ id: 'call-1', agentId: null, accountId: null }),
        releaseAgent: async () => undefined,
        crmPostCallEvent: async () => undefined,
        reservationComplete: async () => undefined,
    }));

    await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-call-1', call_state: 'ended', duration: 42 });

    eventBus.off('call.terminal', listener);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].signalwireCallId, 'sw-call-1');
    assert.equal(seen[0].campaignId, 'camp-x');
    assert.equal(seen[0].status, 'completed');
});
