import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-jwt-secret';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-srk';
process.env.SUPABASE_ANON_KEY = 'test-anon';

// Import after env is set so config.supabase.jwtSecret picks up TEST_SECRET.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticate } = require('../middleware/auth-supabase') as typeof import('../middleware/auth-supabase');

type ProfileLookup = (id: string) => Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    extension: string | null;
} | null>;

function makeApp(profileLookup: ProfileLookup) {
    const app = express();
    app.get('/protected', authenticate({ profileLookup }), (req, res) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.json({ user: (req as any).user });
    });
    return app;
}

function signToken(claims: Partial<{ sub: string; email: string; aud: string; exp: number }> = {}, secret = TEST_SECRET) {
    const fullClaims = {
        sub: 'user-1',
        email: 'user@example.com',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
    };
    return jwt.sign(fullClaims, secret, { algorithm: 'HS256' });
}

test('authenticate: valid token populates req.user from Profile', async () => {
    const app = makeApp(async (id) => ({
        id, email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'admin', extension: '101',
    }));
    const token = signToken({ sub: 'user-1' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, 'user-1');
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.extension, '101');
});

test('authenticate: missing Authorization header returns 401', async () => {
    const app = makeApp(async () => null);
    const res = await request(app).get('/protected');
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Missing or malformed Authorization header/);
});

test('authenticate: malformed Bearer prefix returns 401', async () => {
    const app = makeApp(async () => null);
    const res = await request(app).get('/protected').set('Authorization', 'Token xyz');
    assert.equal(res.status, 401);
});

test('authenticate: invalid signature returns 401', async () => {
    const app = makeApp(async () => null);
    const badToken = signToken({}, 'wrong-secret');
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: expired token returns 401', async () => {
    const app = makeApp(async () => null);
    const expired = signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: valid token but no Profile returns 401', async () => {
    const app = makeApp(async () => null);
    const token = signToken({ sub: 'unknown-user' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Profile not found/);
});
