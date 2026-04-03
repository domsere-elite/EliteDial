import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AICallProvider, AICallRequest, AICallResult } from './providers/types';

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
}

export const retellService = new RetellService();
