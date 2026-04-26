import api from './api';

export interface RetellAgent {
    id: string;
    name: string;
    sipAddress: string;
}

export async function fetchRetellAgents(): Promise<RetellAgent[]> {
    const res = await api.get<{ agents: RetellAgent[] }>('/retell/agents');
    return res.data.agents;
}
