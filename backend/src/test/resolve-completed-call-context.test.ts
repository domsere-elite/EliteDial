// Phase 3b regression — resolveCompletedCallContext must find the agent
// for a power-dial leg as well as for a Call row, otherwise the terminal
// webhook fails to invoke enterWrapUp and the agent stays stuck on-call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompletedCallContext } from '../routes/signalwire-events';

test('resolveCompletedCallContext: returns Call context when Call row exists', async () => {
    const result = await resolveCompletedCallContext(
        {
            findCallByProviderId: async () => ({ id: 'call-1', agentId: 'agent-A', accountId: 'acct-9' }),
            findPowerDialLegByProviderId: async () => null,
        },
        'sw-call-id-1',
    );
    assert.deepEqual(result, { id: 'call-1', agentId: 'agent-A', accountId: 'acct-9' });
});

test('resolveCompletedCallContext: falls back to PowerDialLeg when no Call row', async () => {
    const result = await resolveCompletedCallContext(
        {
            findCallByProviderId: async () => null,
            findPowerDialLegByProviderId: async () => ({ id: 'leg-7', batch: { agentId: 'agent-B' } }),
        },
        'sw-call-id-2',
    );
    assert.deepEqual(result, { id: 'leg-7', agentId: 'agent-B', accountId: null });
});

test('resolveCompletedCallContext: returns null when neither table has a match', async () => {
    const result = await resolveCompletedCallContext(
        {
            findCallByProviderId: async () => null,
            findPowerDialLegByProviderId: async () => null,
        },
        'unknown-call-id',
    );
    assert.equal(result, null);
});

test('resolveCompletedCallContext: prefers Call row over PowerDialLeg if both somehow match', async () => {
    // Defensive: in the unlikely case both tables hold a row with the same
    // providerCallId, prefer the richer Call context (has accountId).
    const result = await resolveCompletedCallContext(
        {
            findCallByProviderId: async () => ({ id: 'call-1', agentId: 'agent-A', accountId: 'acct-9' }),
            findPowerDialLegByProviderId: async () => ({ id: 'leg-7', batch: { agentId: 'agent-B' } }),
        },
        'sw-call-id-3',
    );
    assert.equal(result?.id, 'call-1');
    assert.equal(result?.agentId, 'agent-A');
    assert.equal(result?.accountId, 'acct-9');
});
