export type HumanCallMode = 'manual' | 'preview' | 'progressive' | 'predictive' | 'inbound';
export type UnifiedCallMode = HumanCallMode | 'ai_outbound';
export type UnifiedCallChannel = 'human' | 'ai';

export interface BrowserTokenResult {
    token: string | null;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface OutboundCallRequest {
    fromNumber: string;
    toNumber: string;
    agentId?: string;
    callbackUrl: string;
    aiTransferTarget?: string;
    amdEnabled?: boolean;
    metadata?: Record<string, unknown>;
}

export interface OutboundCallResult {
    provider: string;
    providerCallId: string;
    raw?: Record<string, unknown>;
}

export interface RedirectCallRequest {
    providerCallId: string;
    callbackUrl: string;
}

export interface TelephonyProvider {
    readonly name: string;
    readonly isConfigured: boolean;
    generateBrowserToken?(agentId: string, agentName: string, agentEmail?: string, endpointReference?: string): Promise<BrowserTokenResult>;
    initiateOutboundCall(request: OutboundCallRequest): Promise<OutboundCallResult | null>;
    redirectLiveCall?(request: RedirectCallRequest): Promise<boolean>;
}

export interface AICallRequest {
    fromNumber: string;
    toNumber: string;
    agentId?: string;
    metadata?: Record<string, string>;
    dynamicVariables?: Record<string, string>;
    customSipHeaders?: Record<string, string>;
}

export interface AICallResult {
    provider: string;
    providerCallId: string;
    status: string;
    raw?: Record<string, unknown>;
}

export interface AICallProvider {
    readonly name: string;
    readonly isConfigured: boolean;
    launchOutboundCall(request: AICallRequest): Promise<AICallResult | null>;
}
