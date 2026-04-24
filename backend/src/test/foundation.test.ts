import test from 'node:test';
import assert from 'node:assert/strict';

import { providerRegistry } from '../services/provider-registry';
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

