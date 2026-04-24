import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSwmlRouter } from '../routes/swml';

const noopTrack = async () => undefined as any;
const fakeEnsure = async () => 'fake-internal-call-id';
const fakeReserve = async () => ({ id: 'agent-1', extension: '1001' });

const app = express();
app.use(express.json());
app.use('/swml', createSwmlRouter({
    ensureInboundCallRecord: fakeEnsure,
    reserveAvailableAgent: fakeReserve,
    callAuditTrack: noopTrack,
}));

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
