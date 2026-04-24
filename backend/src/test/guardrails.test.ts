import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeDialerGuardrails,
    DIALER_STATS_WINDOW_MINUTES,
} from '../services/dialer-guardrails';

// ─── DIALER_STATS_WINDOW_MINUTES ───────────────

test('DIALER_STATS_WINDOW_MINUTES is 15', () => {
    assert.equal(DIALER_STATS_WINDOW_MINUTES, 15);
});

// ─── Progressive mode: 1 call per available agent ───

test('progressive: baseConcurrentLimit equals availableAgents when maxConcurrentCalls=0', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 5,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 5);
    assert.equal(result.effectiveConcurrentLimit, 5);
    assert.equal(result.dispatchCapacity, 5);
    assert.deepEqual(result.blockedReasons, []);
});

test('progressive: maxConcurrentCalls caps the limit when lower than agent count', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 3,
        availableAgents: 10,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 3);
    assert.equal(result.dispatchCapacity, 3);
});

test('progressive: no agents blocks with no_available_agents', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.ok(result.blockedReasons.includes('no_available_agents'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── AI Autonomous mode: maxConcurrentCalls is the cap; agents are irrelevant ───

test('ai_autonomous: uses maxConcurrentCalls directly; availableAgents ignored', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 10,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 10);
    assert.equal(result.dispatchCapacity, 10);
    assert.ok(!result.blockedReasons.includes('no_available_agents'));
});

test('ai_autonomous: maxConcurrentCalls=0 blocks with no_concurrency_configured', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.ok(result.blockedReasons.includes('no_concurrency_configured'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Manual mode: no worker-driven dispatch expected ───

test('manual: dispatchCapacity is 0 (manual does not auto-dispatch)', () => {
    const result = computeDialerGuardrails({
        dialMode: 'manual',
        maxConcurrentCalls: 0,
        availableAgents: 5,
        activeCalls: 0,
    });
    assert.equal(result.dispatchCapacity, 0);
    assert.ok(result.blockedReasons.includes('manual_mode'));
});

// ─── Queue backpressure ───

test('queue backpressure: blocked when activeCalls >= effectiveConcurrentLimit', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 3,
        activeCalls: 3,
    });
    assert.ok(result.blockedReasons.includes('queue_backpressure'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Queue pressure metric ───

test('queuePressure: activeCalls / availableAgents for progressive', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 4,
        activeCalls: 2,
    });
    assert.equal(result.queuePressure, 0.5);
});

test('queuePressure: activeCalls / maxConcurrentCalls for ai_autonomous', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 10,
        availableAgents: 0,
        activeCalls: 4,
    });
    assert.equal(result.queuePressure, 0.4);
});
