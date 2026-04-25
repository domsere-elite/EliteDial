import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDialPrecheck } from '../services/dial-precheck';

const baseDeps = {
    tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date('2026-04-25T13:00:00Z') },
    dnc: { isOnDNC: async () => false },
    regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
};

const campaign = { id: 'c1', timezone: 'America/Chicago' } as any;
const contact = { id: 'k1', primaryPhone: '15551234567', timezone: null } as any;

test('dial-precheck: all checks pass → allowed', async () => {
    const dp = buildDialPrecheck(baseDeps);
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.blockedReasons, []);
    assert.equal(r.deferUntil, undefined);
});

test('dial-precheck: TCPA-blocked → reason and deferUntil', async () => {
    const dp = buildDialPrecheck({
        ...baseDeps,
        tcpa: { isWithinCallingWindow: () => false, nextCallingWindowStart: () => new Date('2026-04-25T13:00:00Z') },
    });
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, false);
    assert.deepEqual(r.blockedReasons, ['tcpa_quiet_hours']);
    assert.deepEqual(r.deferUntil, new Date('2026-04-25T13:00:00Z'));
});

test('dial-precheck: DNC-blocked → reason, no deferUntil', async () => {
    const dp = buildDialPrecheck({ ...baseDeps, dnc: { isOnDNC: async () => true } });
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, false);
    assert.deepEqual(r.blockedReasons, ['dnc_listed']);
    assert.equal(r.deferUntil, undefined);
});

test('dial-precheck: Reg F-blocked → reason, no deferUntil', async () => {
    const dp = buildDialPrecheck({
        ...baseDeps,
        regF: { checkRegF: async () => ({ blocked: true, count: 7 }) },
    });
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, false);
    assert.deepEqual(r.blockedReasons, ['reg_f_cap']);
    assert.equal(r.deferUntil, undefined);
});

test('dial-precheck: all three blocked → all reasons + deferUntil', async () => {
    const dp = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => false, nextCallingWindowStart: () => new Date('2026-04-25T13:00:00Z') },
        dnc: { isOnDNC: async () => true },
        regF: { checkRegF: async () => ({ blocked: true, count: 7 }) },
    });
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, false);
    assert.deepEqual(r.blockedReasons.sort(), ['dnc_listed', 'reg_f_cap', 'tcpa_quiet_hours']);
    assert.deepEqual(r.deferUntil, new Date('2026-04-25T13:00:00Z'));
});

test('dial-precheck: DNC dep throws → fail-safe block with reason dnc_check_failed', async () => {
    const dp = buildDialPrecheck({
        ...baseDeps,
        dnc: { isOnDNC: async () => { throw new Error('db down'); } },
    });
    const r = await dp.precheck(campaign, contact);
    assert.equal(r.allowed, false);
    assert.ok(r.blockedReasons.includes('dnc_check_failed'));
});

test('dial-precheck: contact timezone overrides campaign timezone for tcpa check', async () => {
    let tzPassed: string | null | undefined = undefined;
    const dp = buildDialPrecheck({
        ...baseDeps,
        tcpa: {
            isWithinCallingWindow: (tz) => { tzPassed = tz; return true; },
            nextCallingWindowStart: () => new Date('2026-04-25T13:00:00Z'),
        },
    });
    await dp.precheck({ ...campaign, timezone: 'America/Chicago' }, { ...contact, timezone: 'America/New_York' });
    assert.equal(tzPassed, 'America/New_York');
});
