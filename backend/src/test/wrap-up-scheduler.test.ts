import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWrapUpScheduler } from '../services/wrap-up-scheduler';

test('scheduleAutoResume: invokes exitWrapUp after delay', async () => {
    let exited: string[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async (id) => { exited.push(id); return { transitioned: true }; },
    });
    sched.schedule('agent-1', 1); // 1s
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(exited, ['agent-1']);
});

test('cancelAutoResume: prevents the scheduled exit', async () => {
    let exited: string[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async (id) => { exited.push(id); return { transitioned: true }; },
    });
    sched.schedule('agent-1', 1);
    sched.cancel('agent-1');
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(exited, []);
});

test('scheduleAutoResume: re-scheduling same agent replaces existing timer', async () => {
    let exitedAt: number[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async () => { exitedAt.push(Date.now()); return { transitioned: true }; },
    });
    const t0 = Date.now();
    sched.schedule('agent-1', 5); // 5s
    sched.schedule('agent-1', 1); // overrides
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(exitedAt.length, 1);
    assert.ok(exitedAt[0] - t0 < 2000, 'should fire on the 1s schedule, not the 5s');
});
