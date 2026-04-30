import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWrapUpService } from '../services/wrap-up-service';

interface FakeProfile { id: string; status: string; wrapUpUntil: Date | null; }

function makeFakes() {
    const profiles = new Map<string, FakeProfile>();
    const emitted: Array<{ userId: string; event: string; data: any }> = [];
    let now = new Date('2026-04-29T12:00:00Z');

    const deps = {
        prismaProfileFindUnique: async (id: string) => profiles.get(id) || null,
        prismaProfileUpdate: async (id: string, data: Partial<FakeProfile>) => {
            const p = profiles.get(id);
            if (!p) throw new Error('not found');
            const updated = { ...p, ...data };
            profiles.set(id, updated);
            return updated;
        },
        prismaProfileUpdateMany: async (where: { status: string }, data: Partial<FakeProfile>) => {
            let count = 0;
            for (const [id, p] of profiles.entries()) {
                if (p.status === where.status) {
                    profiles.set(id, { ...p, ...data });
                    count++;
                }
            }
            return { count };
        },
        prismaFindExpiredWrapUps: async (asOf: Date) => {
            return [...profiles.values()].filter(
                (p) => p.status === 'wrap-up' && p.wrapUpUntil !== null && p.wrapUpUntil <= asOf,
            );
        },
        emitToUser: (userId: string, event: string, data: any) => { emitted.push({ userId, event, data }); },
        now: () => now,
    };

    return { profiles, emitted, deps, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('enterWrapUp: flips on-call → wrap-up, sets wrapUpUntil, emits profile.status', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'on-call', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    await svc.enterWrapUp('agent-1', 30);

    const p = profiles.get('agent-1')!;
    assert.equal(p.status, 'wrap-up');
    assert.ok(p.wrapUpUntil !== null);
    assert.equal(p.wrapUpUntil!.getTime(), new Date('2026-04-29T12:00:30Z').getTime());

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'profile.status');
    assert.equal(emitted[0].data.status, 'wrap-up');
    assert.equal(emitted[0].data.wrapUpSeconds, 30);
});

test('enterWrapUp: refuses to flip if agent is not on-call', async () => {
    const { profiles, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'available', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    const result = await svc.enterWrapUp('agent-1', 30);

    assert.equal(result.transitioned, false);
    assert.equal(profiles.get('agent-1')!.status, 'available');
});

test('exitWrapUp: flips wrap-up → available, clears wrapUpUntil, emits', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:30Z') });

    const svc = buildWrapUpService(deps);
    const result = await svc.exitWrapUp('agent-1');

    assert.equal(result.transitioned, true);
    const p = profiles.get('agent-1')!;
    assert.equal(p.status, 'available');
    assert.equal(p.wrapUpUntil, null);

    const last = emitted[emitted.length - 1];
    assert.equal(last.event, 'profile.status');
    assert.equal(last.data.status, 'available');
});

test('exitWrapUp: noop when agent already available', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'available', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    const result = await svc.exitWrapUp('agent-1');

    assert.equal(result.transitioned, false);
    assert.equal(emitted.length, 0);
});

test('sweepExpiredWrapUps: flips all wrap-up agents whose wrapUpUntil <= now to available', async () => {
    const { profiles, emitted, deps, advance } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:10Z') });
    profiles.set('agent-2', { id: 'agent-2', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:60Z') });
    advance(15_000); // now is 12:00:15Z

    const svc = buildWrapUpService(deps);
    const swept = await svc.sweepExpiredWrapUps();

    assert.equal(swept, 1);
    assert.equal(profiles.get('agent-1')!.status, 'available');
    assert.equal(profiles.get('agent-2')!.status, 'wrap-up');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].userId, 'agent-1');
});
