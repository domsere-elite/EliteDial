import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBootEnv } from '../lib/env-validation';

test('env-validation: all empty → ok=true (mock mode boots)', () => {
    const r = checkBootEnv({
        signalwire: { projectId: '', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
});

test('env-validation: partial SignalWire → ok=false with clear error', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: '', spaceUrl: '' },
        retell: { apiKey: '' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].match(/SIGNALWIRE_/));
});

test('env-validation: SignalWire configured, Retell missing → ok=true with warning', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: 't', spaceUrl: 's' },
        retell: { apiKey: '' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.ok(r.warnings.some(w => w.match(/Retell/)));
});

test('env-validation: full config → ok=true, no warnings', () => {
    const r = checkBootEnv({
        signalwire: { projectId: 'p', apiToken: 't', spaceUrl: 's' },
        retell: { apiKey: 'k' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 0);
});
