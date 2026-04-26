import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-srk';
process.env.SUPABASE_ANON_KEY = 'test-anon';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildAuthenticate } = require('../middleware/auth') as typeof import('../middleware/auth');

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let goodJwks: JWTVerifyGetKey;

before(async () => {
    const pair = await generateKeyPair('ES256');
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    // Naive resolver: any header → return the test key. Sufficient because the
    // tests sign with `privateKey` and we want jose to verify with `publicKey`.
    goodJwks = (async () => publicKey) as JWTVerifyGetKey;
});

type ProfileLookup = (id: string) => Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    extension: string | null;
} | null>;

function makeApp(profileLookup: ProfileLookup, jwks: JWTVerifyGetKey = goodJwks) {
    const app = express();
    app.get('/protected', buildAuthenticate({ profileLookup, jwks }), (req, res) => {
        res.json({ user: req.user });
    });
    return app;
}

async function signToken(claims: Partial<{ sub: string; email: string; aud: string; exp: number }> = {}, key: CryptoKey = privateKey) {
    const fullClaims: Record<string, unknown> = {
        sub: 'user-1',
        email: 'user@example.com',
        aud: 'authenticated',
        ...claims,
    };
    const exp = claims.exp ?? Math.floor(Date.now() / 1000) + 3600;
    return new SignJWT(fullClaims)
        .setProtectedHeader({ alg: 'ES256' })
        .setExpirationTime(exp)
        .sign(key);
}

test('authenticate: valid token populates req.user from Profile', async () => {
    const app = makeApp(async (id) => ({
        id, email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'admin', extension: '101',
    }));
    const token = await signToken({ sub: 'user-1' });
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
    const wrongPair = await generateKeyPair('ES256');
    const badToken = await signToken({}, wrongPair.privateKey);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: expired token returns 401', async () => {
    const app = makeApp(async () => null);
    const expired = await signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: valid token but no Profile returns 401', async () => {
    const app = makeApp(async () => null);
    const token = await signToken({ sub: 'unknown-user' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Profile not found/);
});
