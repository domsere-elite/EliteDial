import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AICallProvider, AICallRequest, AICallResult } from './providers/types';

export interface RetellAgent {
    agent_id: string;
    agent_name: string;
    voice_id?: string;
    language?: string;
    response_engine?: { type: string; llm_id?: string };
    last_modification_timestamp?: number;
    [key: string]: unknown;
}

const MOCK_AGENTS: RetellAgent[] = [
    {
        agent_id: 'mock-agent-001',
        agent_name: 'Collections Agent - English',
        voice_id: 'eleven_turbo_v2',
        language: 'en-US',
        response_engine: { type: 'retell-llm', llm_id: 'mock-llm-001' },
        last_modification_timestamp: Date.now(),
    },
    {
        agent_id: 'mock-agent-002',
        agent_name: 'Payment Reminder Agent',
        voice_id: 'eleven_turbo_v2',
        language: 'en-US',
        response_engine: { type: 'retell-llm', llm_id: 'mock-llm-002' },
        last_modification_timestamp: Date.now(),
    },
    {
        agent_id: 'mock-agent-003',
        agent_name: 'Collections Agent - Spanish',
        voice_id: 'eleven_multilingual_v2',
        language: 'es-ES',
        response_engine: { type: 'retell-llm', llm_id: 'mock-llm-003' },
        last_modification_timestamp: Date.now(),
    },
];

class RetellService implements AICallProvider {
    readonly name = 'retell';

    get isConfigured(): boolean {
        return config.isRetellConfigured;
    }

    async launchOutboundCall(request: AICallRequest): Promise<AICallResult | null> {
        if (!this.isConfigured) {
            logger.warn('Retell not configured; returning mock AI call identifier');
            return {
                provider: this.name,
                providerCallId: `mock-retell-${Date.now()}`,
                status: 'registered',
                raw: {
                    from_number: request.fromNumber,
                    to_number: request.toNumber,
                    metadata: request.metadata,
                },
            };
        }

        try {
            const response = await axios.post(
                `${config.retell.baseUrl}/v2/create-phone-call`,
                {
                    from_number: request.fromNumber,
                    to_number: request.toNumber,
                    override_agent_id: request.agentId || config.retell.defaultAgentId,
                    metadata: request.metadata || {},
                    retell_llm_dynamic_variables: request.dynamicVariables || {},
                    custom_sip_headers: request.customSipHeaders || {},
                },
                {
                    headers: {
                        'Authorization': `Bearer ${config.retell.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15000,
                },
            );

            const payload = response.data as Record<string, unknown>;
            const providerCallId = String(payload.call_id || payload.callId || '');
            const status = String(payload.call_status || payload.status || 'registered');
            return {
                provider: this.name,
                providerCallId,
                status,
                raw: payload,
            };
        } catch (error) {
            logger.error('Retell outbound call failed', { error });
            return null;
        }
    }

    async listAgents(): Promise<RetellAgent[]> {
        if (!this.isConfigured) {
            return MOCK_AGENTS;
        }
        try {
            const response = await axios.get(`${config.retell.baseUrl}/v2/list-agents`, {
                headers: { 'Authorization': `Bearer ${config.retell.apiKey}` },
                timeout: 10000,
            });
            return (response.data || []) as RetellAgent[];
        } catch (error) {
            logger.error('Retell listAgents failed', { error });
            return [];
        }
    }

    async getAgent(agentId: string): Promise<RetellAgent | null> {
        if (!this.isConfigured) {
            return MOCK_AGENTS.find(a => a.agent_id === agentId) || null;
        }
        try {
            const response = await axios.get(`${config.retell.baseUrl}/v2/get-agent/${encodeURIComponent(agentId)}`, {
                headers: { 'Authorization': `Bearer ${config.retell.apiKey}` },
                timeout: 10000,
            });
            return response.data as RetellAgent;
        } catch (error) {
            logger.error('Retell getAgent failed', { agentId, error });
            return null;
        }
    }
}

export const retellService = new RetellService();
