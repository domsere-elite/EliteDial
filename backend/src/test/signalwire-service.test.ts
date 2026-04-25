import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SignalWireService } from '../services/signalwire';

type FetchMock = (url: string, init?: any) => Promise<Response>;

function makeFetch(handler: FetchMock) {
    return mock.fn(handler) as unknown as typeof fetch;
}

function makeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const config = {
    projectId: 'test-project',
    apiToken: 'test-token',
    spaceUrl: 'test.signalwire.com',
    allowSubscriberProvisioning: false,
};

test('initiateOutboundCall posts to /api/calling/calls with dial command', async () => {
    const fetchMock = mock.fn(async (url: string, init?: any) => {
        assert.equal(url, 'https://test.signalwire.com/api/calling/calls');
        const body = JSON.parse(init.body);
        assert.equal(body.command, 'dial');
        assert.equal(body.params.to, '+15551234567');
        assert.equal(body.params.from, '+15559998888');
        assert.equal(body.params.caller_id, '+15559998888');
        assert.match(body.params.url, /\/swml\/bridge/);
        assert.match(body.params.status_url, /\/signalwire\/events\/call-status/);
        return makeResponse(200, { call_id: 'c-new-1', status: 'queued' });
    });

    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15559998888',
        toNumber: '+15551234567',
        agentId: 'agent-alice',
        callbackUrl: 'https://backend.test',
    });

    assert.ok(result);
    assert.equal(result!.providerCallId, 'c-new-1');
    assert.equal(result!.provider, 'signalwire');
    assert.equal(fetchMock.mock.calls.length, 1);
});

test('initiateOutboundCall returns null on non-2xx', async () => {
    const fetchMock = mock.fn(async () => makeResponse(422, { error: 'invalid_caller_id' }));
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://backend.test',
    });
    assert.equal(result, null);
});

test('transferCall updates live call to fetch /swml/transfer document', async () => {
    const fetchMock = mock.fn(async (url: string, init?: any) => {
        const body = JSON.parse(init.body);
        const callIdInPath = url.includes('/c-live-1');
        const callIdInBody = body.call_id === 'c-live-1';
        assert.ok(callIdInPath || callIdInBody, 'request references the call_id');
        const swmlUrl = body.params?.url || body.url;
        assert.match(swmlUrl, /\/swml\/transfer/);
        assert.match(swmlUrl, /to=/);
        return makeResponse(200, { call_id: 'c-live-1', status: 'updated' });
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const ok = await svc.transferCall('c-live-1', '+15557776666', 'https://backend.test');
    assert.equal(ok, true);
});

test('transferCall returns false on failure', async () => {
    const fetchMock = mock.fn(async () => makeResponse(404, { error: 'call_not_found' }));
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const ok = await svc.transferCall('c-missing', '+15557776666', 'https://backend.test');
    assert.equal(ok, false);
});

test('generateBrowserToken calls fabric subscriber tokens endpoint and returns JWT', async () => {
    const fetchMock = mock.fn(async (url: string) => {
        if (url.endsWith('/api/fabric/subscribers/tokens')) {
            return makeResponse(200, { token: 'sat-jwt-abc' });
        }
        return makeResponse(404, {});
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.generateBrowserToken('agent-1', 'Agent One', 'a@x.test', 'ext-1001');
    assert.equal(result.token, 'sat-jwt-abc');
});

test('generateRelayJwt calls /api/relay/rest/jwt and returns jwt_token', async () => {
    const fetchMock = mock.fn(async (url: string) => {
        assert.ok(url.endsWith('/api/relay/rest/jwt'));
        return makeResponse(200, { jwt_token: 'relay-jwt-xyz' });
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.generateRelayJwt('sip:1001');
    assert.equal(result.token, 'relay-jwt-xyz');
});

test('unconfigured service returns mock call id without calling fetch', async () => {
    const fetchMock = mock.fn(async () => { throw new Error('should not be called'); });
    const svc = new SignalWireService({ ...config, projectId: '' }, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://backend.test',
    });
    assert.ok(result);
    assert.match(result!.providerCallId, /^mock-call-/);
    assert.equal(fetchMock.mock.calls.length, 0);
});

test('signalwire-service: initiateOutboundCall serializes swmlQuery into URL', async () => {
    const fetchCalls: any[] = [];
    const fakeFetch = (async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ call_id: 'sw-1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const { SignalWireService } = await import('../services/signalwire');
    const svc = new SignalWireService(
        { projectId: 'p', apiToken: 't', spaceUrl: 'space.signalwire.com', allowSubscriberProvisioning: false },
        { fetch: fakeFetch },
    );
    await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://elite.example',
        swmlQuery: { mode: 'ai_autonomous', campaignId: 'c1', from: '+15551112222' },
    });
    const body = fetchCalls[0].body;
    assert.match(body.params.url, /\/swml\/bridge\?/);
    assert.match(body.params.url, /mode=ai_autonomous/);
    assert.match(body.params.url, /campaignId=c1/);
    assert.match(body.params.url, /from=%2B15551112222/);
});

test('signalwire-service: initiateOutboundCall without swmlQuery falls back to to+from query', async () => {
    const fetchCalls: any[] = [];
    const fakeFetch = (async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ call_id: 'sw-2' }), { status: 200 });
    }) as unknown as typeof fetch;

    const { SignalWireService } = await import('../services/signalwire');
    const svc = new SignalWireService(
        { projectId: 'p', apiToken: 't', spaceUrl: 'space.signalwire.com', allowSubscriberProvisioning: false },
        { fetch: fakeFetch },
    );
    await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://elite.example',
    });
    const url = fetchCalls[0].body.params.url;
    assert.match(url, /to=%2B15553334444/);
    assert.match(url, /from=%2B15551112222/);
    assert.ok(!url.match(/mode=/));
});
