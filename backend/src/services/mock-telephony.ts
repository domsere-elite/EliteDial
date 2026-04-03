import {
    BrowserTokenResult,
    OutboundCallRequest,
    OutboundCallResult,
    RedirectCallRequest,
    TelephonyProvider,
} from './providers/types';
import { mockCallLifecycleService } from './mock-call-lifecycle';

class MockTelephonyService implements TelephonyProvider {
    readonly name = 'mock';
    readonly isConfigured = true;

    async generateBrowserToken(agentId: string): Promise<BrowserTokenResult> {
        return {
            token: `mock-browser-token-${agentId}`,
            metadata: { provider: this.name },
        };
    }

    async initiateOutboundCall(request: OutboundCallRequest): Promise<OutboundCallResult> {
        const providerCallId = `mock-call-${Date.now()}`;
        const callId = typeof request.metadata?.callId === 'string' ? request.metadata.callId : undefined;
        const scenario = typeof request.metadata?.mockScenario === 'string' ? request.metadata.mockScenario : undefined;

        mockCallLifecycleService.scheduleOutboundLifecycle({
            provider: this.name,
            providerCallId,
            callId,
            fromNumber: request.fromNumber,
            toNumber: request.toNumber,
            channel: 'human',
            scenario,
        });

        return {
            provider: this.name,
            providerCallId,
            raw: {
                mock: true,
                scenario: scenario || 'answer',
            },
        };
    }

    async redirectLiveCall(_request: RedirectCallRequest): Promise<boolean> {
        return true;
    }
}

export const mockTelephonyService = new MockTelephonyService();
