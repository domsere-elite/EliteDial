import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../lib/event-bus';
import { checkAiAutonomousActivation } from '../routes/campaigns';

test('campaigns-activation: non-ai_autonomous always passes', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'progressive', status: 'active',
        retellAgentId: null, retellSipAddress: null,
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: ai_autonomous + draft passes (not yet activating)', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'draft',
        retellAgentId: null, retellSipAddress: null,
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: ai_autonomous + active + missing → reports missing fields', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'active',
        retellAgentId: 'ag1', retellSipAddress: null,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['retellSipAddress']);
});

test('campaigns-activation: ai_autonomous + active + complete passes', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'active',
        retellAgentId: 'ag1', retellSipAddress: 'sip:x@y',
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: campaign.activated event flows through eventBus', () => {
    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventBus.on('campaign.activated', listener);
    eventBus.emit('campaign.activated', { campaignId: 'k1' });
    eventBus.off('campaign.activated', listener);
    assert.deepEqual(seen, [{ campaignId: 'k1' }]);
});
