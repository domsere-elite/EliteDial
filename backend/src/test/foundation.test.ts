import test from 'node:test';
import assert from 'node:assert/strict';

import { providerRegistry } from '../services/provider-registry';
import { computeDialerGuardrails } from '../services/dialer-guardrails';
import { normalizePhone, resolveFallbackOutboundNumber } from '../services/phone-number-service';

test('normalizePhone standardizes US 10-digit and 11-digit inputs', () => {
    assert.equal(normalizePhone('2145550100'), '+12145550100');
    assert.equal(normalizePhone('12145550100'), '+12145550100');
    assert.equal(normalizePhone('+12145550100'), '+12145550100');
});

test('resolveFallbackOutboundNumber prefers configured default and preserves hard fallback', () => {
    assert.equal(resolveFallbackOutboundNumber('+18335550100'), '+18335550100');
    assert.equal(resolveFallbackOutboundNumber(null), '+15551000002');
    assert.equal(resolveFallbackOutboundNumber(undefined), '+15551000002');
});

test('provider registry exposes signalwire and retell as the default providers', () => {
    const telephonyProvider = providerRegistry.getPrimaryTelephonyProvider();
    const aiProvider = providerRegistry.getPrimaryAIProvider();

    assert.ok(['signalwire', 'mock'].includes(telephonyProvider.name));
    assert.ok(['retell', 'mock-ai'].includes(aiProvider.name));
    assert.equal(providerRegistry.getTelephonyProvider(telephonyProvider.name), telephonyProvider);
    assert.equal(providerRegistry.getAIProvider(aiProvider.name), aiProvider);
    assert.ok(providerRegistry.getTelephonyProvider('mock'));
    assert.ok(providerRegistry.getAIProvider('mock-ai'));
});

test('dialer guardrails cap predictive live dispatch to available agents', () => {
    const controls = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 3,
        maxConcurrentCalls: 0,
        availableAgents: 2,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 10,
        recentAbandonedAttempts: 0,
        predictiveOverdialEnabled: false,
    });

    assert.equal(controls.baseConcurrentLimit, 6);
    assert.equal(controls.effectiveConcurrentLimit, 2);
    assert.equal(controls.dispatchCapacity, 2);
    assert.deepEqual(controls.warnings, ['safe_predictive_cap']);
});

test('dialer guardrails warn but do not block when abandon rate exceeds limit', () => {
    const controls = computeDialerGuardrails({
        dialMode: 'predictive',
        dialRatio: 1,
        maxConcurrentCalls: 0,
        availableAgents: 3,
        activeCalls: 0,
        abandonRateLimit: 0.03,
        recentCompletedAttempts: 20,
        recentAbandonedAttempts: 2,
        predictiveOverdialEnabled: false,
    });

    // Dispatch continues — abandon rate is informational only under the new model
    assert.ok(controls.dispatchCapacity > 0);
    assert.ok(controls.warnings.includes('abandon_rate_exceeded'));
    assert.ok(!controls.blockedReasons.includes('abandon_rate_limit'));
});
