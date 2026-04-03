import { AICallProvider, AICallRequest, AICallResult } from './providers/types';
import { mockCallLifecycleService } from './mock-call-lifecycle';

class MockAIService implements AICallProvider {
    readonly name = 'mock-ai';
    readonly isConfigured = true;

    async launchOutboundCall(request: AICallRequest): Promise<AICallResult> {
        const providerCallId = `mock-ai-${Date.now()}`;
        const callId = typeof request.metadata?.call_id === 'string' ? request.metadata.call_id : undefined;
        const scenario = typeof request.metadata?.mock_scenario === 'string' ? request.metadata.mock_scenario : undefined;

        mockCallLifecycleService.scheduleOutboundLifecycle({
            provider: this.name,
            providerCallId,
            callId,
            fromNumber: request.fromNumber,
            toNumber: request.toNumber,
            channel: 'ai',
            scenario,
        });

        return {
            provider: this.name,
            providerCallId,
            status: 'registered',
            raw: {
                mock: true,
                scenario: scenario || 'transfer',
            },
        };
    }
}

export const mockAIService = new MockAIService();
