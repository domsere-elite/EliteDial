import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRetellAgents, mapAgentResponse } from '../services/retell-agents-service';

test('mapAgentResponse: extracts id/name/sipAddress from common shapes', () => {
    const mapped = mapAgentResponse({
        agent_id: 'agent_abc',
        agent_name: 'Sales Bot',
        sip_uri: 'sip:agent_abc@retell.sip.livekit.cloud',
    });
    assert.deepEqual(mapped, { id: 'agent_abc', name: 'Sales Bot', sipAddress: 'sip:agent_abc@retell.sip.livekit.cloud' });
});

test('mapAgentResponse: falls back to id when name missing', () => {
    const mapped = mapAgentResponse({
        agent_id: 'agent_abc',
        agent_name: null,
        sip_address: 'sip:agent_abc@host',
    });
    assert.equal(mapped?.name, 'agent_abc');
});

test('mapAgentResponse: returns null when agent_id missing', () => {
    assert.equal(mapAgentResponse({ agent_name: 'X' }), null);
});

test('mapAgentResponse: returns null when no sip variant present', () => {
    assert.equal(mapAgentResponse({ agent_id: 'agent_abc', agent_name: 'X' }), null);
});

test('listRetellAgents: happy path returns mapped list', async () => {
    const mockFetch = async (url: string, init?: any) => {
        assert.equal(url, 'https://api.retellai.com/list-agents');
        assert.equal(init.headers.Authorization, 'Bearer key123');
        return {
            ok: true,
            status: 200,
            json: async () => ([
                { agent_id: 'a1', agent_name: 'Agent 1', sip_uri: 'sip:a1@h' },
                { agent_id: 'a2', agent_name: 'Agent 2', sip_uri: 'sip:a2@h' },
                { agent_id: 'a3', agent_name: null }, // dropped: no sip
            ]),
        } as any;
    };
    const result = await listRetellAgents({
        fetchImpl: mockFetch as any,
        apiKey: 'key123',
        baseUrl: 'https://api.retellai.com',
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a1');
    assert.equal(result[1].id, 'a2');
});

test('listRetellAgents: throws ConfigError when apiKey empty', async () => {
    await assert.rejects(
        () => listRetellAgents({ fetchImpl: (async () => { throw new Error('should not be called'); }) as any, apiKey: '', baseUrl: 'https://api.retellai.com' }),
        /RETELL_API_KEY not configured/,
    );
});

test('listRetellAgents: throws UpstreamError on 5xx', async () => {
    const mockFetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' } as any);
    await assert.rejects(
        () => listRetellAgents({ fetchImpl: mockFetch as any, apiKey: 'k', baseUrl: 'https://api.retellai.com' }),
        /Retell list-agents upstream error: 502/,
    );
});
