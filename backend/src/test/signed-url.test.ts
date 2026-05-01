import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAgentRoomUrl, verifyAgentRoomSignature } from '../lib/signed-url';

const SECRET = 'test-secret-do-not-use-in-prod';

test('signAgentRoomUrl: returns sig + exp params and they verify round-trip', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    assert.ok(sig.length > 0);
    assert.ok(exp > Math.floor(Date.now() / 1000));
    const result = verifyAgentRoomSignature('agent-1', sig, exp, SECRET);
    assert.equal(result.ok, true);
});

test('verifyAgentRoomSignature: rejects expired sig', () => {
    const { sig } = signAgentRoomUrl('agent-1', 60, SECRET);
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    const result = verifyAgentRoomSignature('agent-1', sig, expiredExp, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'expired');
});

test('verifyAgentRoomSignature: rejects mismatched agentId', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-2', sig, exp, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_signature');
});

test('verifyAgentRoomSignature: rejects tampered signature', () => {
    const { exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-1', 'deadbeef', exp, SECRET);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_signature');
});

test('verifyAgentRoomSignature: rejects when secret differs', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-1', sig, exp, 'different-secret');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_signature');
});
