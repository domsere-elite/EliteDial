import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSwmlRouter, SwmlRouteDeps } from '../routes/swml';

const noopTrack = async () => undefined as any;
const fakeEnsure = async () => 'fake-internal-call-id';
const fakeReserve = async () => ({ id: 'agent-1', extension: '1001' });
const fakeLoadCampaign = async (_id: string) => null;

// All routes share this deps shape now; tests that exercise specific routes
// override only the fields they care about. Power-dial-specific routes
// (claim / voicemail) have dedicated overrides further down.
function mkDeps(overrides: Partial<SwmlRouteDeps> = {}): SwmlRouteDeps {
    return {
        ensureInboundCallRecord: fakeEnsure,
        reserveAvailableAgent: fakeReserve,
        callAuditTrack: noopTrack,
        loadCampaignForBridge: fakeLoadCampaign,
        claimPowerDialLeg: async () => ({ won: false, targetRef: null, agentId: null, contactName: null, contactPhone: null, providerCallId: null }),
        loadCampaignForOverflow: async () => null,
        loadCampaignForVoicemail: async () => null,
        markPowerDialLegOverflow: async () => undefined,
        markPowerDialLegMachine: async () => undefined,
        notifyAgentOfBridgeWinner: async () => undefined,
        ...overrides,
    };
}

const app = express();
app.use(express.json());
app.use('/swml', createSwmlRouter(mkDeps()));

test('POST /swml/inbound returns JSON SWML document with IVR prompt', async () => {
    const res = await request(app)
        .post('/swml/inbound')
        .send({ call_id: 'test-call-1', from: '+15551112222', to: '+15553334444' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal(res.body.version, '1.0.0');
    assert.ok(Array.isArray(res.body.sections.main));
    assert.ok(res.body.sections.main.some((s: any) => s.prompt !== undefined));
});

test('POST /swml/ivr-action with digit=2 returns connect-agent request', async () => {
    const res = await request(app)
        .post('/swml/ivr-action')
        .send({ digit: '2', call_id: 'test-call-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.version, '1.0.0');
    const main = res.body.sections.main;
    assert.ok(main.some((s: any) => s.request !== undefined));
});

test('POST /swml/ivr-action with invalid digit hangs up', async () => {
    const res = await request(app)
        .post('/swml/ivr-action')
        .send({ digit: '9', call_id: 'test-call-3' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sections.main.some((s: any) => s.hangup !== undefined));
});

test('POST /swml/voicemail returns a record-then-hangup document', async () => {
    const res = await request(app).post('/swml/voicemail').send({ call_id: 'test-call-vm' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    assert.ok(main.some((s: any) => s.record !== undefined));
    assert.ok(main.some((s: any) => s.hangup !== undefined));
});

test('POST /swml/bridge returns a connect-with-record document', async () => {
    const res = await request(app)
        .post('/swml/bridge')
        .query({ to: '+15557776666', from: '+15559998888' })
        .send({ call_id: 'test-call-b' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, '+15557776666');
});

test('POST /swml/transfer returns a connect document targeting the query param', async () => {
    const res = await request(app)
        .post('/swml/transfer')
        .query({ to: 'sip:ai@example.sip.signalwire.com' })
        .send({ call_id: 'test-call-t' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, 'sip:ai@example.sip.signalwire.com');
});

test('POST /swml/transfer with missing "to" returns hangup document (not 500)', async () => {
    const res = await request(app)
        .post('/swml/transfer')
        .send({ call_id: 'test-call-t2' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sections.main.some((s: any) => s.hangup !== undefined));
});

test('swml-routes: /bridge with mode=ai_autonomous returns Retell SIP doc', async () => {
    const baseDeps = mkDeps({
        ensureInboundCallRecord: async () => 'call-1',
        reserveAvailableAgent: async () => null,
        loadCampaignForBridge: async (id: string) =>
            id === 'c-ok' ? { id, retellSipAddress: 'sip:agent_x@retell.example' } : null,
    });
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter(baseDeps));

    const res = await request(app)
        .post('/swml/bridge?mode=ai_autonomous&campaignId=c-ok&from=%2B15551234567')
        .send({});
    assert.equal(res.status, 200);
    const connect = res.body.sections.main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, 'sip:agent_x@retell.example');
    assert.equal(connect.connect.from, '+15551234567');
});

test('swml-routes: /bridge with mode=ai_autonomous + missing campaign returns hangup', async () => {
    const baseDeps = mkDeps({
        ensureInboundCallRecord: async () => 'call-1',
        reserveAvailableAgent: async () => null,
        loadCampaignForBridge: async (id: string) =>
            id === 'c-ok' ? { id, retellSipAddress: 'sip:agent_x@retell.example' } : null,
    });
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter(baseDeps));

    const res = await request(app)
        .post('/swml/bridge?mode=ai_autonomous&campaignId=c-missing&from=%2B15551234567')
        .send({});
    assert.equal(res.status, 200);
    const hangup = res.body.sections.main.find((s: any) => s.hangup !== undefined);
    assert.ok(hangup, 'hangup step present when campaign missing');
});

test('swml-routes: /bridge with to+from (progressive path) still works', async () => {
    const baseDeps = mkDeps({
        ensureInboundCallRecord: async () => 'call-1',
        reserveAvailableAgent: async () => null,
        loadCampaignForBridge: async (_id: string) => null,
    });
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter(baseDeps));

    const res = await request(app)
        .post('/swml/bridge?to=%2B15551234567&from=%2B15559998888')
        .send({});
    assert.equal(res.status, 200);
    const connect = res.body.sections.main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, '+15551234567');
});

test('swml-routes: AI bridge SWML doc has required SignalWire contract fields', async () => {
    const baseDeps = mkDeps({
        ensureInboundCallRecord: async () => 'call-shape-1',
        reserveAvailableAgent: async () => null,
        loadCampaignForBridge: async (id: string) =>
            id === 'c-shape' ? { id, retellSipAddress: 'sip:agent_test@retell.example' } : null,
    });
    const shapeApp = express();
    shapeApp.use(express.json());
    shapeApp.use('/swml', createSwmlRouter(baseDeps));

    const res = await request(shapeApp)
        .post('/swml/bridge?mode=ai_autonomous&campaignId=c-shape&from=%2B15551234567')
        .send({});

    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);

    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.timeout, 30, 'timeout=30 (SignalWire default answer window)');
    assert.equal(connect.connect.answer_on_bridge, true, 'answer_on_bridge required for recording to start at correct time');
    assert.ok(
        Array.isArray(connect.on_failure) && connect.on_failure.some((s: any) => s.hangup !== undefined),
        'on_failure must terminate the call gracefully',
    );

    const recorder = main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call required for compliance audit trail');
    assert.equal(recorder.record_call.stereo, true, 'stereo recording for both legs');
    assert.equal(recorder.record_call.format, 'mp3');
});

test('swml-routes: progressive bridge SWML doc has record_call and correct from', async () => {
    const res = await request(app)
        .post('/swml/bridge?to=%2B15551234567&from=%2B15559998888')
        .send({});

    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);

    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.from, '+15559998888', 'caller ID threaded through');
    assert.equal(connect.connect.timeout, 30);

    const recorder = main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call present for progressive bridge');
});

// ---- Power-dial Phase 2 routes ---------------------------------------------

function makePowerDialApp(deps: SwmlRouteDeps): express.Express {
    const a = express();
    a.use(express.json());
    a.use('/swml', createSwmlRouter(deps));
    return a;
}

test('swml-routes: /power-dial/claim — winner returns { outcome: "bridge" } and notifies the agent with customer info', async () => {
    const calls: any[] = [];
    const notifications: any[] = [];
    const a = makePowerDialApp(mkDeps({
        claimPowerDialLeg: async ({ batchId, legId }) => {
            calls.push({ batchId, legId });
            return {
                won: true,
                targetRef: 'dominic',
                agentId: 'agent-uuid-1',
                contactName: 'John Doe',
                contactPhone: '+15551234567',
                providerCallId: 'pcid-99',
            };
        },
        notifyAgentOfBridgeWinner: async (params) => { notifications.push(params); },
    }));

    const res = await request(a)
        .post('/swml/power-dial/claim?batchId=batch-1&legId=leg-1&campaignId=c-1&callerId=%2B13467760336')
        .send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { outcome: 'bridge' });
    assert.deepEqual(calls, [{ batchId: 'batch-1', legId: 'leg-1' }]);
    // Allow the fire-and-forget Socket.IO emit to flush.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], {
        agentId: 'agent-uuid-1',
        batchId: 'batch-1',
        legId: 'leg-1',
        contactName: 'John Doe',
        contactPhone: '+15551234567',
        providerCallId: 'pcid-99',
    });
});

test('swml-routes: /power-dial/claim — race loser with retellSipAddress returns { outcome: "overflow" }', async () => {
    let overflowMarked: any = null;
    const a = makePowerDialApp(mkDeps({
        claimPowerDialLeg: async () => ({ won: false, targetRef: null, agentId: null, contactName: null, contactPhone: null, providerCallId: null }),
        loadCampaignForOverflow: async (id) =>
            id === 'c-1' ? { retellSipAddress: 'sip:agent_x@retell.example' } : null,
        markPowerDialLegOverflow: async (params) => { overflowMarked = params; },
    }));

    const res = await request(a)
        .post('/swml/power-dial/claim?batchId=batch-1&legId=leg-2&campaignId=c-1&callerId=%2B13467760336')
        .send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { outcome: 'overflow' });
    assert.deepEqual(overflowMarked, { legId: 'leg-2', overflowTarget: 'ai' });
});

test('swml-routes: /power-dial/claim — race loser without retellSipAddress returns { outcome: "hangup" }', async () => {
    let overflowMarked: any = null;
    const a = makePowerDialApp(mkDeps({
        claimPowerDialLeg: async () => ({ won: false, targetRef: null, agentId: null, contactName: null, contactPhone: null, providerCallId: null }),
        loadCampaignForOverflow: async () => ({ retellSipAddress: null }),
        markPowerDialLegOverflow: async (params) => { overflowMarked = params; },
    }));

    const res = await request(a)
        .post('/swml/power-dial/claim?batchId=batch-1&legId=leg-3&campaignId=c-1')
        .send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { outcome: 'hangup' });
    assert.deepEqual(overflowMarked, { legId: 'leg-3', overflowTarget: 'hangup' });
});

test('swml-routes: /power-dial/claim — missing batchId/legId returns { outcome: "hangup" }', async () => {
    const a = makePowerDialApp(mkDeps());
    const res = await request(a).post('/swml/power-dial/claim').send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { outcome: 'hangup' });
});

test('swml-routes: /power-dial/voicemail — marks leg as machine and acks', async () => {
    let machineMarked: any = null;
    const a = makePowerDialApp(mkDeps({
        markPowerDialLegMachine: async (params) => { machineMarked = params; },
    }));

    const res = await request(a)
        .post('/swml/power-dial/voicemail?campaignId=c-1&legId=leg-9')
        .send({ detect_result: 'machine' });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ack: true });
    assert.deepEqual(machineMarked, { legId: 'leg-9', detectResult: 'machine' });
});

test('swml-routes: /power-dial/voicemail — missing legId returns { ack: false }', async () => {
    const a = makePowerDialApp(mkDeps());
    const res = await request(a).post('/swml/power-dial/voicemail').send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ack: false });
});

// ---- /swml/agent-room/:agentId — Phase 3c per-agent pre-warm room ---------

test('POST /swml/agent-room/:agentId — returns agentRoomSwml when sig is valid', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/swml', createSwmlRouter(mkDeps()));

    const { signAgentRoomUrl } = await import('../lib/signed-url');
    const { sig, exp } = signAgentRoomUrl('agent-uuid-1', 60, SECRET);

    const res = await request(localApp).post(`/swml/agent-room/agent-uuid-1?sig=${sig}&exp=${exp}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, '1.0.0');
    assert.equal(res.body.sections.main[1].join_room.name, 'agent-room-agent-uuid-1');
    assert.equal(res.body.sections.main[1].join_room.moderator, true);
});

test('POST /swml/agent-room/:agentId — 403 on missing sig', async () => {
    process.env.SWML_URL_SIGNING_SECRET = 'test-secret-room';
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/swml', createSwmlRouter(mkDeps()));
    const res = await request(localApp).post('/swml/agent-room/agent-uuid-1');
    assert.equal(res.status, 403);
});

test('POST /swml/agent-room/:agentId — 403 on tampered sig', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const { signAgentRoomUrl } = await import('../lib/signed-url');
    const { exp } = signAgentRoomUrl('agent-uuid-1', 60, SECRET);
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/swml', createSwmlRouter(mkDeps()));
    const res = await request(localApp).post(`/swml/agent-room/agent-uuid-1?sig=deadbeef&exp=${exp}`);
    assert.equal(res.status, 403);
});

test('POST /swml/agent-room/:agentId — 403 on expired sig', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const { signAgentRoomUrl } = await import('../lib/signed-url');
    const { sig } = signAgentRoomUrl('agent-uuid-1', -60, SECRET); // already expired
    const exp = Math.floor(Date.now() / 1000) - 30;
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/swml', createSwmlRouter(mkDeps()));
    const res = await request(localApp).post(`/swml/agent-room/agent-uuid-1?sig=${sig}&exp=${exp}`);
    assert.equal(res.status, 403);
});
