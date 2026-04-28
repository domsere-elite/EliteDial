import dotenv from 'dotenv';
dotenv.config();

const toInt = (value: string | undefined, fallback: number): number => {
    const parsed = parseInt(value || '', 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    return value === 'true';
};

export const config = {
    port: parseInt(process.env.PORT || '5000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    signalwire: {
        projectId: process.env.SIGNALWIRE_PROJECT_ID || '',
        apiToken: process.env.SIGNALWIRE_API_TOKEN || '',
        spaceUrl: process.env.SIGNALWIRE_SPACE_URL || '',
        allowSubscriberProvisioning: toBool(process.env.SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING, false),
        softphoneTransport: process.env.SIGNALWIRE_SOFTPHONE_TRANSPORT || 'fabric-v3',
    },
    crm: {
        baseUrl: process.env.CRM_BASE_URL || '',
        apiKey: process.env.CRM_API_KEY || '',
        webhookUrl: process.env.CRM_WEBHOOK_URL || '',
        webhookSecret: process.env.CRM_WEBHOOK_SECRET || '',
    },
    retell: {
        apiKey: process.env.RETELL_API_KEY || '',
        baseUrl: process.env.RETELL_API_BASE_URL || 'https://api.retellai.com',
        defaultAgentId: process.env.RETELL_AGENT_ID || '',
        webhookSecret: process.env.RETELL_WEBHOOK_SECRET || '',
        defaultFromNumber: process.env.RETELL_DEFAULT_FROM_NUMBER || '',
        fallbackNumber: process.env.RETELL_FALLBACK_NUMBER || '',
    },
    supabase: {
        url: process.env.SUPABASE_URL || '',
        anonKey: process.env.SUPABASE_ANON_KEY || '',
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    },
    providers: {
        telephony: process.env.TELEPHONY_PROVIDER || '',
        ai: process.env.AI_PROVIDER || '',
    },
    publicUrls: {
        backend: process.env.BACKEND_PUBLIC_URL || '',
    },
    telephony: {
        defaultOutboundNumber: process.env.DEFAULT_OUTBOUND_NUMBER || '',
    },
    storage: {
        recordingArchiveBaseUrl: process.env.RECORDING_ARCHIVE_BASE_URL || '',
        transcriptArchiveBaseUrl: process.env.TRANSCRIPT_ARCHIVE_BASE_URL || '',
    },
    dialer: {
        mode: (process.env.DIALER_MODE || 'mock') as 'mock' | 'live',
        pollIntervalMs: toInt(process.env.DIALER_POLL_INTERVAL_MS, 5000),
    },
    powerDial: {
        // Feature flag for Phase 2 power-dial worker. Default off — the worker
        // and routes are deployed dark and turned on per-environment after a
        // smoke run. Disabling reverts behaviour to strict 1:1 progressive.
        workerEnabled: toBool(process.env.POWER_DIAL_WORKER_ENABLED, false),
        // Batch TTL in seconds. After this, in-flight legs are cleanup-eligible.
        // 60s covers PSTN ring (max ~30s) + AMD detection (max ~10s) + headroom.
        batchTtlSeconds: toInt(process.env.POWER_DIAL_BATCH_TTL_SECONDS, 60),
    },
    get isSignalWireConfigured(): boolean {
        return !!(this.signalwire.projectId && this.signalwire.apiToken && this.signalwire.spaceUrl);
    },
    get isSignalWireHumanBrowserOutboundSupported(): boolean {
        return ['sip-endpoint', 'relay-v2'].includes(this.signalwire.softphoneTransport);
    },
    get isRetellConfigured(): boolean {
        return !!this.retell.apiKey;
    },
    get isRetellOutboundConfigured(): boolean {
        return !!(this.retell.apiKey && this.retell.defaultAgentId);
    },
    get isCrmConfigured(): boolean {
        return !!(this.crm.baseUrl && this.crm.apiKey);
    }
};
