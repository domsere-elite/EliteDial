import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { RequestHandler } from 'express';
import request from 'supertest';
import { buildAgentsRouter } from '../routes/agents';

function appAsAgent(agentId: string, role: 'agent' | 'supervisor' | 'admin' = 'agent') {
    process.env.SWML_URL_SIGNING_SECRET = 'test-secret';
    process.env.BACKEND_PUBLIC_URL = 'https://backend.test';
    const stubAuth: RequestHandler = (req, _res, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).user = { id: agentId, email: 'a@b', role, firstName: 'A', lastName: 'B', extension: null };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/agents', buildAgentsRouter({
        exitWrapUp: async () => ({ transitioned: false }),
        cancelAutoResume: () => undefined,
        authenticate: stubAuth,
    }));
    return app;
}

test('GET /api/agents/:id/room-url — same agent gets a signed URL', async () => {
    const app = appAsAgent('agent-1');
    const res = await request(app).get('/api/agents/agent-1/room-url');
    assert.equal(res.status, 200);
    assert.match(res.body.url, /\/swml\/agent-room\/agent-1\?sig=[a-f0-9]+&exp=\d+/);
    assert.ok(res.body.exp > Math.floor(Date.now() / 1000));
});

test('GET /api/agents/:id/room-url — agent cannot mint for another agent (403)', async () => {
    const app = appAsAgent('agent-1');
    const res = await request(app).get('/api/agents/agent-2/room-url');
    assert.equal(res.status, 403);
});

test('GET /api/agents/:id/room-url — supervisor can mint for any agent', async () => {
    const app = appAsAgent('agent-1', 'supervisor');
    const res = await request(app).get('/api/agents/agent-2/room-url');
    assert.equal(res.status, 200);
    assert.match(res.body.url, /\/swml\/agent-room\/agent-2\?sig=/);
});
