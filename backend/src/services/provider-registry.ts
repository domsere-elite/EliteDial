import { config } from '../config';
import { mockAIService } from './mock-ai';
import { mockTelephonyService } from './mock-telephony';
import { signalwireService } from './signalwire';
import { retellService } from './retell';
import { AICallProvider, TelephonyProvider } from './providers/types';

class ProviderRegistry {
    private readonly telephonyProviders = new Map<string, TelephonyProvider>([
        [signalwireService.name, signalwireService],
        [mockTelephonyService.name, mockTelephonyService],
    ]);

    private readonly aiProviders = new Map<string, AICallProvider>([
        [retellService.name, retellService],
        [mockAIService.name, mockAIService],
    ]);

    getPrimaryTelephonyProvider(): TelephonyProvider {
        const forced = config.providers.telephony;
        if (forced) return this.telephonyProviders.get(forced) || mockTelephonyService;
        if (signalwireService.isConfigured) return signalwireService;
        return mockTelephonyService;
    }

    getPrimaryAIProvider(): AICallProvider {
        const forced = config.providers.ai;
        if (forced) return this.aiProviders.get(forced) || mockAIService;
        if (retellService.isConfigured) return retellService;
        return mockAIService;
    }

    getTelephonyProvider(name: string): TelephonyProvider | undefined {
        return this.telephonyProviders.get(name);
    }

    getAIProvider(name: string): AICallProvider | undefined {
        return this.aiProviders.get(name);
    }
}

export const providerRegistry = new ProviderRegistry();
