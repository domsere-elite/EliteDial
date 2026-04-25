import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventBus } from '../lib/event-bus';

test('event-bus: subscribe + emit delivers payload to listener', () => {
    const bus = buildEventBus();
    const received: any[] = [];
    bus.on('call.terminal', (p) => received.push(p));
    bus.emit('call.terminal', { callId: 'c1', signalwireCallId: 'sw-1', campaignId: 'k1', status: 'completed' });
    assert.deepEqual(received, [{ callId: 'c1', signalwireCallId: 'sw-1', campaignId: 'k1', status: 'completed' }]);
});

test('event-bus: off stops further delivery', () => {
    const bus = buildEventBus();
    const received: any[] = [];
    const fn = (p: any) => received.push(p);
    bus.on('campaign.activated', fn);
    bus.emit('campaign.activated', { campaignId: 'k1' });
    bus.off('campaign.activated', fn);
    bus.emit('campaign.activated', { campaignId: 'k2' });
    assert.equal(received.length, 1);
});

test('event-bus: multiple listeners all receive', () => {
    const bus = buildEventBus();
    const a: any[] = [];
    const b: any[] = [];
    bus.on('campaign.paused', (p) => a.push(p));
    bus.on('campaign.paused', (p) => b.push(p));
    bus.emit('campaign.paused', { campaignId: 'k1' });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
});
