import { createHmac, timingSafeEqual } from 'crypto';

// HMAC-SHA256 signed URLs for SWML routes that must be parameterised by
// agent id but cannot rely on a Bearer token (SignalWire fetches the URL
// server-to-server, no Authorization header from the agent's session).
//
// Format: `?sig=<hex>&exp=<unix-seconds>`
// Secret: process.env.SWML_URL_SIGNING_SECRET (or apiToken fallback in dev).

function computeSignature(agentId: string, exp: number, secret: string): string {
    return createHmac('sha256', secret).update(`${agentId}:${exp}`).digest('hex');
}

export function signAgentRoomUrl(agentId: string, ttlSeconds: number, secret: string): { sig: string; exp: number } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = computeSignature(agentId, exp, secret);
    return { sig, exp };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'expired' | 'invalid_signature' };

export function verifyAgentRoomSignature(agentId: string, sig: string, exp: number, secret: string): VerifyResult {
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: 'expired' };
    }
    const expected = computeSignature(agentId, exp, secret);
    const expectedBuf = Buffer.from(expected, 'hex');
    let actualBuf: Buffer;
    try {
        actualBuf = Buffer.from(sig, 'hex');
    } catch {
        return { ok: false, reason: 'invalid_signature' };
    }
    if (actualBuf.length !== expectedBuf.length) {
        return { ok: false, reason: 'invalid_signature' };
    }
    if (!timingSafeEqual(actualBuf, expectedBuf)) {
        return { ok: false, reason: 'invalid_signature' };
    }
    return { ok: true };
}
