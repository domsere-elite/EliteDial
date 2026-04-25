import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessLocalLimiter } from '../services/concurrency-limiter';

test('concurrency-limiter: acquire below cap returns true and increments active', () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map(), clock: () => 0 });
    assert.equal(limiter.acquire('camp-a', 3), true);
    assert.equal(limiter.acquire('camp-a', 3), true);
    assert.equal(limiter.active('camp-a'), 2);
});

test('concurrency-limiter: acquire at cap returns false and does not increment', () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map(), clock: () => 0 });
    limiter.acquire('camp-a', 1);
    assert.equal(limiter.acquire('camp-a', 1), false);
    assert.equal(limiter.active('camp-a'), 1);
});

test('concurrency-limiter: release decrements but never goes below 0', () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map(), clock: () => 0 });
    limiter.acquire('camp-a', 5);
    limiter.release('camp-a');
    limiter.release('camp-a'); // extra release is a no-op
    assert.equal(limiter.active('camp-a'), 0);
});

test('concurrency-limiter: rebuildFromDb seeds counters per campaign', async () => {
    const limiter = buildProcessLocalLimiter({
        rebuildSource: async () => new Map([['camp-a', 2], ['camp-b', 5]]),
        clock: () => 0,
    });
    await limiter.rebuildFromDb();
    assert.equal(limiter.active('camp-a'), 2);
    assert.equal(limiter.active('camp-b'), 5);
    assert.equal(limiter.active('camp-c'), 0);
});

test('concurrency-limiter: stuck-slot sweeper releases slots older than timeout', () => {
    let now = 0;
    const limiter = buildProcessLocalLimiter({
        rebuildSource: async () => new Map(),
        clock: () => now,
        stuckTimeoutMs: 1000,
    });
    limiter.acquire('camp-a', 5);
    limiter.acquire('camp-a', 5);
    now = 500;
    limiter.acquire('camp-a', 5);
    now = 1500; // first two are now stuck (>1000ms old), third is 1000ms old (boundary, not yet stuck)
    const released = limiter.sweepStuck();
    assert.equal(released, 2);
    assert.equal(limiter.active('camp-a'), 1);
});
