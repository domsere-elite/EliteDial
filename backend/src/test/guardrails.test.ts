import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeDialerGuardrails,
    DIALER_STATS_WINDOW_MINUTES,
} from '../services/dialer-guardrails';

// ─── DIALER_STATS_WINDOW_MINUTES ────────────────

test('DIALER_STATS_WINDOW_MINUTES is 15', () => {
    assert.equal(DIALER_STATS_WINDOW_MINUTES, 15);
});

// ─── Progressive mode ───────────────────────────

test('progressive mode: effectiveConcurrentLimit equals availableAgents (ratio not applied)', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        dialRatio: 3,
        maxConcurrentCalls: 0,
        availableAgents: 5,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 0,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: false,
    });

    // Progressive is not predictive, so ratio is not applied: base = agents * 1
    assert.equal(result.baseConcurrentLimit, 5);
    assert.equal(result.effectiveConcurrentLimit, 5);
});

// ─── No agents ──────────────────────────────────

test('no agents: blocked with no_available_agents', () => {
    const result = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 2,
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 0,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: false,
    });

    assert.ok(result.blockedReasons.includes('no_available_agents'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Queue backpressure ─────────────────────────

test('queue backpressure: blocked when activeCalls >= effectiveConcurrentLimit', () => {
    const result = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 1,
        maxConcurrentCalls: 0,
        availableAgents: 3,
        activeCalls: 3,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 0,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: false,
    });

    assert.ok(result.blockedReasons.includes('queue_backpressure'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Overdial enabled ───────────────────────────

test('mock mode with overdial enabled: effectiveConcurrentLimit can exceed availableAgents', () => {
    const result = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 3,
        maxConcurrentCalls: 0,
        availableAgents: 2,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 0,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: true,
    });

    // With overdial enabled, the safe_predictive_cap is NOT applied
    assert.equal(result.baseConcurrentLimit, 6);       // 2 * 3
    assert.equal(result.effectiveConcurrentLimit, 6);   // no cap
    assert.ok(!result.warnings.includes('safe_predictive_cap'));
});

// ─── Multiple blocked reasons ───────────────────

test('multiple blocked reasons can coexist', () => {
    const result = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 1,
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 5,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 10,
        recentAbandonedAttempts: 5,
        predictiveOverdialEnabled: false,
    });

    // no_available_agents because availableAgents is 0
    assert.ok(result.blockedReasons.includes('no_available_agents'));
    // abandon_rate_limit because 5/10 = 0.5 >= 0.03
    assert.ok(result.blockedReasons.includes('abandon_rate_limit'));
    assert.ok(result.blockedReasons.length >= 2);
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Zero completed attempts ────────────────────

test('zero completed attempts: abandon rate is 0', () => {
    const result = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 2,
        maxConcurrentCalls: 0,
        availableAgents: 3,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 0,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: false,
    });

    assert.equal(result.recentAbandonRate, 0);
    // Should NOT be blocked by abandon_rate_limit
    assert.ok(!result.blockedReasons.includes('abandon_rate_limit'));
});
