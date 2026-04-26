export interface RetellAgent {
    id: string;
    name: string;
    sipAddress: string;
}

export interface ListAgentsDeps {
    fetchImpl: typeof fetch;
    apiKey: string;
    baseUrl: string;
}

export function mapAgentResponse(raw: any): RetellAgent | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.agent_id === 'string' ? raw.agent_id : null;
    if (!id) return null;
    const name = (typeof raw.agent_name === 'string' && raw.agent_name) ? raw.agent_name : id;
    const sipAddress =
        (typeof raw.sip_uri === 'string' && raw.sip_uri) ||
        (typeof raw.sip_address === 'string' && raw.sip_address) ||
        (typeof raw.voice_phone_number_sip_uri === 'string' && raw.voice_phone_number_sip_uri) ||
        null;
    if (!sipAddress) return null;
    return { id, name, sipAddress };
}

export async function listRetellAgents(deps: ListAgentsDeps): Promise<RetellAgent[]> {
    if (!deps.apiKey) {
        throw new Error('RETELL_API_KEY not configured');
    }
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/list-agents`;
    const res = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${deps.apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Retell list-agents upstream error: ${res.status} ${body}`);
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
        throw new Error('Retell list-agents returned non-array body');
    }
    return json.map(mapAgentResponse).filter((a): a is RetellAgent => a !== null);
}
