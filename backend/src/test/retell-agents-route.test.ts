import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildRetellAgentsRouter } from '../routes/retell-agents';

function appWith(deps: { listAgents: () => Promise<any> }) {
    const app = express();
    app.use('/api/retell', buildRetellAgentsRouter({
        listAgents: deps.listAgents,
        authenticate: (_req, _res, next) => next(),
    }));
    return app;
}

test('GET /api/retell/agents: 200 with mapped list on success', async () => {
    const app = appWith({
        listAgents: async () => ([{ id: 'a1', name: 'A1', sipAddress: 'sip:a1@h' }]),
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { agents: [{ id: 'a1', name: 'A1', sipAddress: 'sip:a1@h' }] });
});

test('GET /api/retell/agents: 503 with error message when service throws', async () => {
    const app = appWith({
        listAgents: async () => { throw new Error('Retell list-agents upstream error: 502 bad gateway'); },
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /Retell list-agents upstream error: 502/);
});

test('GET /api/retell/agents: 503 with config message when key missing', async () => {
    const app = appWith({
        listAgents: async () => { throw new Error('RETELL_API_KEY not configured'); },
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /RETELL_API_KEY not configured/);
});
