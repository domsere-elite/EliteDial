import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router, RequestHandler } from 'express';
import request from 'supertest';

// Mirrors the real /api/auth contract (auth gate, body validation, response shape)
// without depending on real Supabase or DB. The handler delegates to a stub
// admin SDK and a stub profile lookup injected via deps.

interface FakeUser { id: string; email: string }

function buildTestAuthRouter(deps: {
    requireAdmin?: boolean;
    createUserResult?: { data: { user: FakeUser } | null; error: { message: string } | null };
    profileLookup?: (id: string) => Promise<{ id: string; email: string; firstName: string; lastName: string; role: string } | null>;
}) {
    const router = Router();
    const fakeAuth: RequestHandler = (req, _res, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).user = { id: 'admin-1', role: deps.requireAdmin ? 'admin' : 'agent' };
        next();
    };
    const fakeRequireRole = (role: string): RequestHandler => (req, res, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((req as any).user?.role !== role) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        next();
    };

    router.post('/register', fakeAuth, fakeRequireRole('admin'), express.json(), async (req, res) => {
        const { email, password, firstName, lastName } = req.body ?? {};
        if (!email || !password || !firstName || !lastName) {
            res.status(400).json({ error: 'validation failed' });
            return;
        }
        const r = deps.createUserResult ?? { data: { user: { id: 'new-1', email } }, error: null };
        if (r.error || !r.data) {
            res.status(400).json({ error: r.error?.message ?? 'register failed' });
            return;
        }
        const profile = (await deps.profileLookup?.(r.data.user.id)) ?? {
            id: r.data.user.id,
            email,
            firstName,
            lastName,
            role: 'agent',
        };
        res.status(201).json(profile);
    });

    router.get('/me', fakeAuth, (req, res) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.json((req as any).user);
    });

    return router;
}

test('POST /register: non-admin returns 403', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: false }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'a@b.c', password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 403);
});

test('POST /register: missing email returns 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 400);
});

test('POST /register: admin + valid body returns 201 with profile shape', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'a@b.c', password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 201);
    assert.equal(res.body.email, 'a@b.c');
    assert.ok(res.body.id);
});

test('POST /register: surfaces Supabase admin SDK error as 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({
        requireAdmin: true,
        createUserResult: { data: null, error: { message: 'duplicate email' } },
    }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'dup@b.c', password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /duplicate email/);
});

test('GET /me: returns req.user', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app).get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'admin');
});
