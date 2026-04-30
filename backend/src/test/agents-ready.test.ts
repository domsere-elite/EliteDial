import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { RequestHandler } from 'express';
import request from 'supertest';
import { buildAgentsRouter } from '../routes/agents';

const captured: { exitedAgents: string[]; cancelledAgents: string[] } = { exitedAgents: [], cancelledAgents: [] };

function appAsAgent(agentId: string) {
    const stubAuth: RequestHandler = (req: any, _res, next) => {
        req.user = { id: agentId, email: 'a@b', role: 'agent', firstName: 'A', lastName: 'B', extension: null };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/agents', buildAgentsRouter({
        exitWrapUp: async (id) => { captured.exitedAgents.push(id); return { transitioned: true }; },
        cancelAutoResume: (id) => { captured.cancelledAgents.push(id); },
        authenticate: stubAuth,
    }));
    return app;
}

test('POST /api/agents/:id/ready as the same agent — calls cancelAutoResume + exitWrapUp', async () => {
    captured.exitedAgents = [];
    captured.cancelledAgents = [];
    const app = appAsAgent('agent-1');
    const res = await request(app).post('/api/agents/agent-1/ready');
    assert.equal(res.status, 200);
    assert.deepEqual(captured.exitedAgents, ['agent-1']);
    assert.deepEqual(captured.cancelledAgents, ['agent-1']);
    assert.equal(res.body.id, 'agent-1');
    assert.equal(res.body.transitioned, true);
});

test('POST /api/agents/:id/ready as a different agent — 403 and no service calls', async () => {
    captured.exitedAgents = [];
    captured.cancelledAgents = [];
    const app = appAsAgent('agent-1');
    const res = await request(app).post('/api/agents/agent-2/ready');
    assert.equal(res.status, 403);
    assert.deepEqual(captured.exitedAgents, []);
    assert.deepEqual(captured.cancelledAgents, []);
});

test('POST /api/agents/:id/ready returns transitioned:false when not in wrap-up', async () => {
    captured.exitedAgents = [];
    captured.cancelledAgents = [];
    const stubAuth: RequestHandler = (req: any, _res, next) => {
        req.user = { id: 'agent-1', email: 'a@b', role: 'agent', firstName: 'A', lastName: 'B', extension: null };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/agents', buildAgentsRouter({
        exitWrapUp: async (id) => { captured.exitedAgents.push(id); return { transitioned: false }; },
        cancelAutoResume: (id) => { captured.cancelledAgents.push(id); },
        authenticate: stubAuth,
    }));
    const res = await request(app).post('/api/agents/agent-1/ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.transitioned, false);
    // cancelAutoResume still called (idempotent)
    assert.deepEqual(captured.cancelledAgents, ['agent-1']);
});
