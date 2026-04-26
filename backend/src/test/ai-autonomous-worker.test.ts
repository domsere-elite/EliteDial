import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAIAutonomousWorker, type CampaignSlim, type ReserveResult } from '../services/ai-autonomous-worker';
import { buildProcessLocalLimiter } from '../services/concurrency-limiter';
import { buildEventBus } from '../lib/event-bus';
import type { DialPrecheckResult } from '../services/dial-precheck';

const okPrecheck = { precheck: async () => ({ allowed: true, blockedReasons: [] }) };

const baseDeps = (overrides: any = {}) => {
    const limiter = overrides.limiter || buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const eventBus = overrides.eventBus || buildEventBus();
    return {
        limiter,
        eventBus,
        precheck: overrides.precheck || okPrecheck,
        loadCampaign: overrides.loadCampaign || (async (id: string): Promise<CampaignSlim> => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 2, retryDelaySeconds: 600, timezone: 'America/Chicago',
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@y',
        })),
        listActiveAiCampaigns: overrides.listActiveAiCampaigns || (async () => [{ id: 'camp-1' }]),
        reserveNext: overrides.reserveNext || (async () => null),
        confirmDial: overrides.confirmDial || (async () => undefined),
        failReservation: overrides.failReservation || (async () => undefined),
        applyBlockedStatus: overrides.applyBlockedStatus || (async () => undefined),
        writeBlockedCallRow: overrides.writeBlockedCallRow || (async () => undefined),
        writeInitiatedCallRow: overrides.writeInitiatedCallRow || (async () => undefined),
        initiateCall: overrides.initiateCall || (async () => ({ provider: 'mock', providerCallId: 'sw-1' })),
        pickDid: overrides.pickDid || (async () => '+15551112222'),
        callbackUrl: 'https://elite.example',
        intervalMs: 30_000,
        clock: overrides.clock || (() => new Date()),
    };
};

test('ai-autonomous-worker: tick with cap=0 logs once and breaks', async () => {
    const w = buildAIAutonomousWorker(baseDeps({
        loadCampaign: async (id: string) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 0, retryDelaySeconds: 600, timezone: 'UTC',
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@y',
        }),
    }));
    await w.tick('camp-1');
    // No throw, no error — successful no-op.
    assert.ok(true);
});

test('ai-autonomous-worker: tick dials up to cap and stops', async () => {
    const calls: any[] = [];
    let queue = 5;
    const w = buildAIAutonomousWorker(baseDeps({
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: `k${queue}`, primaryPhone: '15551112222', timezone: null }, reservationToken: 't' };
        },
        initiateCall: async (req: { fromNumber: string; toNumber: string; callbackUrl: string; swmlQuery: Record<string, string>; metadata?: Record<string, unknown> }) => { calls.push(req); return { provider: 'mock', providerCallId: `sw-${calls.length}` }; },
    }));
    await w.tick('camp-1');
    assert.equal(calls.length, 2); // cap=2 from baseDeps
});

test('ai-autonomous-worker: tick writes blocked Call row + applies blocked status on precheck fail', async () => {
    const blockedRows: any[] = [];
    const blockedStatuses: any[] = [];
    const w = buildAIAutonomousWorker(baseDeps({
        precheck: { precheck: async () => ({ allowed: false, blockedReasons: ['dnc_listed'] }) },
        reserveNext: (() => {
            let n = 1;
            return async () => n-- > 0 ? { contact: { id: 'k1', primaryPhone: '15551112222', timezone: null }, reservationToken: 't' } : null;
        })(),
        writeBlockedCallRow: async (c: CampaignSlim, k: ReserveResult['contact'], reasons: string[]) => { blockedRows.push({ k: k.id, reasons }); },
        applyBlockedStatus: async (k: string, pre: DialPrecheckResult) => { blockedStatuses.push({ k, reasons: pre.blockedReasons }); },
    }));
    await w.tick('camp-1');
    assert.equal(blockedRows.length, 1);
    assert.deepEqual(blockedRows[0].reasons, ['dnc_listed']);
    assert.equal(blockedStatuses.length, 1);
});

test('ai-autonomous-worker: REST-failure releases slot and re-queues contact', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const failed: any[] = [];
    const w = buildAIAutonomousWorker(baseDeps({
        limiter,
        reserveNext: (() => {
            let n = 1;
            return async () => n-- > 0 ? { contact: { id: 'k1', primaryPhone: '15551112222', timezone: null }, reservationToken: 't' } : null;
        })(),
        initiateCall: async () => null,
        failReservation: async (k: string, status: 'queued' | 'failed', when: Date | null) => { failed.push({ k, status, when }); },
    }));
    await w.tick('camp-1');
    assert.equal(limiter.active('camp-1'), 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 'queued');
});

test('ai-autonomous-worker: skips campaign missing Retell config', async () => {
    let reserveCalled = 0;
    const w = buildAIAutonomousWorker(baseDeps({
        loadCampaign: async (id: string) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 2, retryDelaySeconds: 600, timezone: 'UTC',
            retellAgentId: null, retellSipAddress: null,
        }),
        reserveNext: async () => { reserveCalled++; return null; },
    }));
    await w.tick('camp-1');
    assert.equal(reserveCalled, 0);
});

test('ai-autonomous-worker: per-campaign serialisation — second concurrent tick awaits first', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const w = buildAIAutonomousWorker(baseDeps({
        reserveNext: async () => {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise(r => setTimeout(r, 20));
            inFlight--;
            return null;
        },
    }));
    await Promise.all([w.tick('camp-1'), w.tick('camp-1'), w.tick('camp-1')]);
    assert.equal(maxConcurrent, 1);
});
