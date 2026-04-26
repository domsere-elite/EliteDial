import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBootEnv } from '../lib/env-validation';

const supabaseOk = { url: 'https://x.supabase.co', serviceRoleKey: 'srk' };

test('env-validation: all empty (except supabase) → ok=true (mock mode boots)', () => {
    const r = checkBootEnv({
        signalwire: { projectId: '', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
        supabase: supabaseOk,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
});

test('env-validation: partial SignalWire → ok=false with clear error', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
        supabase: supabaseOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].match(/SIGNALWIRE_/));
});

test('env-validation: SignalWire configured, Retell missing → ok=true with warning', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: 't', spaceUrl: 's' },
        retell: { apiKey: '' },
        supabase: supabaseOk,
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.ok(r.warnings.some(w => w.match(/Retell/)));
});

test('env-validation: full config → ok=true, no warnings', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: 't', spaceUrl: 's' },
        retell: { apiKey: 'k' },
        supabase: supabaseOk,
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 0);
});

test('env-validation: missing SUPABASE_SERVICE_ROLE_KEY → ok=false with explicit error', () => {
    const r = checkBootEnv({
        signalwire: { projectId: '', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
        supabase: { url: 'https://x.supabase.co', serviceRoleKey: '' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /Missing required Supabase env vars.*SUPABASE_SERVICE_ROLE_KEY/.test(e)));
});

test('env-validation: all Supabase vars missing → single error listing all required', () => {
    const r = checkBootEnv({
        signalwire: { projectId: '', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
        supabase: { url: '', serviceRoleKey: '' },
    });
    assert.equal(r.ok, false);
    const supaErr = r.errors.find(e => e.startsWith('Missing required Supabase'));
    assert.ok(supaErr);
    assert.match(supaErr!, /SUPABASE_URL/);
    assert.match(supaErr!, /SUPABASE_SERVICE_ROLE_KEY/);
});
