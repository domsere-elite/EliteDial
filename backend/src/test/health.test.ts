import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeHealth } from '../services/health';

describe('computeHealth', () => {
    it('returns ok + 200 when DB reachable', async () => {
        const result = await computeHealth({
            checkDb: async () => true,
            providers: { signalwire: true, retell: true, crm: true },
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.status, 'ok');
        assert.equal(result.body.db, 'connected');
    });

    it('returns degraded + 503 when DB unreachable', async () => {
        const result = await computeHealth({
            checkDb: async () => false,
            providers: { signalwire: true, retell: true, crm: true },
        });
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.status, 'degraded');
        assert.equal(result.body.db, 'error');
    });

    it('returns degraded + 503 when DB check throws', async () => {
        const result = await computeHealth({
            checkDb: async () => { throw new Error('boom'); },
            providers: { signalwire: true, retell: true, crm: true },
        });
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.status, 'degraded');
        assert.equal(result.body.db, 'error');
    });

    it('body includes provider configuration flags', async () => {
        const result = await computeHealth({
            checkDb: async () => true,
            providers: { signalwire: false, retell: true, crm: false },
        });
        assert.equal(result.body.signalwire, false);
        assert.equal(result.body.retell, true);
        assert.equal(result.body.crm, false);
    });

    it('body includes an ISO 8601 timestamp', async () => {
        const result = await computeHealth({
            checkDb: async () => true,
            providers: { signalwire: true, retell: true, crm: true },
        });
        assert.match(result.body.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('DB reachability alone determines status (providers missing is OK)', async () => {
        const result = await computeHealth({
            checkDb: async () => true,
            providers: { signalwire: false, retell: false, crm: false },
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.status, 'ok');
    });
});
