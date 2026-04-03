import { config } from '../config';
import { logger } from '../utils/logger';
import {
    BrowserTokenResult,
    OutboundCallRequest,
    OutboundCallResult,
    RedirectCallRequest,
    TelephonyProvider,
} from './providers/types';

class SignalWireService implements TelephonyProvider {
    readonly name = 'signalwire';

    private projectId: string;
    private apiToken: string;
    private spaceUrl: string;

    constructor() {
        this.projectId = config.signalwire.projectId;
        this.apiToken = config.signalwire.apiToken;
        this.spaceUrl = config.signalwire.spaceUrl;
    }

    get isConfigured(): boolean {
        return config.isSignalWireConfigured;
    }

    private get authHeader() {
        return 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64');
    }

    async generateRelayJwt(resource: string, expiresInMinutes = 15): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            return {
                token: null,
                error: 'signalwire_not_configured',
            };
        }

        try {
            const response = await fetch(`https://${this.spaceUrl}/api/relay/rest/jwt`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.authHeader,
                },
                body: JSON.stringify({
                    resource,
                    expires_in: expiresInMinutes,
                }),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire relay JWT generation failed', { status: response.status, body: bodyText, resource });
                return {
                    token: null,
                    error: `relay_jwt_failed_${response.status}`,
                    metadata: {
                        provider: this.name,
                        resource,
                        responseStatus: response.status,
                        responseBody: bodyText,
                    },
                };
            }

            const data = await response.json() as { jwt_token?: string };
            return {
                token: data.jwt_token || null,
                metadata: {
                    provider: this.name,
                    resource,
                    transport: 'relay-v2',
                },
            };
        } catch (error) {
            logger.error('SignalWire relay JWT generation error', { error, resource });
            return {
                token: null,
                error: 'relay_jwt_exception',
                metadata: {
                    provider: this.name,
                    resource,
                    transport: 'relay-v2',
                },
            };
        }
    }

    private async requestSubscriberToken(reference: string): Promise<BrowserTokenResult> {
        const tokenUrl = `https://${this.spaceUrl}/api/fabric/subscribers/tokens`;
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': this.authHeader,
            },
            body: JSON.stringify({ reference }),
        });

        if (response.ok) {
            const data = await response.json() as { token?: string };
            return {
                token: data.token || null,
                metadata: { provider: this.name, spaceUrl: this.spaceUrl, endpointReference: reference, reusedSubscriber: true },
            };
        }

        const errBody = await response.text();
        logger.warn('SignalWire SAT generation failed', { status: response.status, body: errBody, reference });

        if (errBody.includes('insufficient_balance')) {
            return { token: null, error: 'insufficient_balance' };
        }

        return {
            token: null,
            error: `sat_generation_failed_${response.status}`,
            metadata: {
                provider: this.name,
                endpointReference: reference,
                responseStatus: response.status,
                responseBody: errBody,
            },
        };
    }

    private async createSubscriber(reference: string, agentName: string, subscriberEmail: string): Promise<{ ok: boolean; error?: string }> {
        const subscribersUrl = `https://${this.spaceUrl}/api/fabric/subscribers`;
        const subscriberRes = await fetch(subscribersUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': this.authHeader,
            },
            body: JSON.stringify({
                reference,
                name: agentName,
                email: subscriberEmail,
            }),
        });

        if (subscriberRes.ok || subscriberRes.status === 409 || subscriberRes.status === 422) {
            return { ok: true };
        }

        const errBody = await subscriberRes.text();
        logger.error('SignalWire fabric subscriber create failed', { status: subscriberRes.status, body: errBody, reference });
        return { ok: false, error: `subscriber_create_failed_${subscriberRes.status}` };
    }

    async generateBrowserToken(agentId: string, agentName: string, agentEmail?: string, endpointReference?: string): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock browser token');
            return {
                token: `mock-browser-token-${endpointReference || agentId}`,
                metadata: { provider: this.name, endpointReference: endpointReference || agentId },
            };
        }

        try {
            const subscriberEmail = agentEmail || `${agentId}@users.elitedial.local`;
            const reference = endpointReference || agentId;
            const existingTokenResult = await this.requestSubscriberToken(reference);
            if (existingTokenResult.token) {
                return existingTokenResult;
            }

            if (!config.signalwire.allowSubscriberProvisioning) {
                logger.warn('SignalWire subscriber provisioning blocked for missing subscriber', {
                    agentId,
                    endpointReference: reference,
                });
                return {
                    token: null,
                    error: 'subscriber_provisioning_disabled',
                    metadata: {
                        provider: this.name,
                        endpointReference: reference,
                        existingSubscriberReuseAttempted: true,
                    },
                };
            }

            const createResult = await this.createSubscriber(reference, agentName, subscriberEmail);
            if (!createResult.ok) {
                return { token: null, error: createResult.error || 'subscriber_create_failed' };
            }

            const createdTokenResult = await this.requestSubscriberToken(reference);
            if (createdTokenResult.token) {
                return {
                    ...createdTokenResult,
                    metadata: {
                        ...(createdTokenResult.metadata || {}),
                        reusedSubscriber: false,
                        subscriberCreated: true,
                    },
                };
            }

            return createdTokenResult;
        } catch (err) {
            logger.error('SignalWire token generation failed', { error: err });
            return { token: null, error: 'token_generation_exception' };
        }
    }

    async initiateOutboundCall(params: OutboundCallRequest): Promise<OutboundCallResult | null> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock call identifier');
            return {
                provider: this.name,
                providerCallId: `mock-call-${Date.now()}`,
                raw: params.metadata,
            };
        }

        try {
            const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Calls.json`;
            const hasAiTransfer = !!params.aiTransferTarget;
            const amdEnabled = params.amdEnabled ?? config.amd.enabled;
            const twimlUrl = hasAiTransfer
                ? (amdEnabled
                    ? `${params.callbackUrl}/sw/amd-hold?aiTarget=${encodeURIComponent(params.aiTransferTarget!)}`
                    : `${params.callbackUrl}/sw/ai-connect?aiTarget=${encodeURIComponent(params.aiTransferTarget!)}`)
                : `${params.callbackUrl}/sw/bridge?to=${encodeURIComponent(params.toNumber)}&from=${encodeURIComponent(params.fromNumber)}`;

            const body = new URLSearchParams({
                From: params.fromNumber,
                To: hasAiTransfer ? params.toNumber : `sip:${params.agentId}@${this.spaceUrl}`,
                Url: twimlUrl,
                StatusCallback: `${params.callbackUrl}/sw/call-status`,
                Record: 'true',
                RecordingStatusCallback: `${params.callbackUrl}/sw/recording-status`,
            });

            ['initiated', 'ringing', 'answered', 'completed'].forEach((event) => {
                body.append('StatusCallbackEvent', event);
            });

            if (amdEnabled) {
                body.set('MachineDetection', config.amd.mode);
                body.set('MachineDetectionTimeout', String(Math.round(config.amd.timeoutMs / 1000)));
                body.set('MachineDetectionSpeechThreshold', String(config.amd.speechThresholdMs));
                body.set('MachineDetectionSpeechEndThreshold', String(config.amd.speechEndThresholdMs));
                body.set('MachineDetectionSilenceTimeout', String(config.amd.silenceTimeoutMs));
                body.set('AsyncAmd', config.amd.async ? 'true' : 'false');
                body.set(
                    'AsyncAmdStatusCallback',
                    `${params.callbackUrl}/sw/amd-status?mode=${hasAiTransfer ? 'ai' : 'agent'}${hasAiTransfer ? `&aiTarget=${encodeURIComponent(params.aiTransferTarget!)}` : ''}`,
                );
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire call initiation failed', { status: response.status, body: bodyText });
                return null;
            }

            const data = await response.json() as { sid?: string };
            return {
                provider: this.name,
                providerCallId: data.sid || '',
                raw: {
                    callbackUrl: params.callbackUrl,
                    amdEnabled,
                    aiTransferTarget: params.aiTransferTarget || null,
                },
            };
        } catch (err) {
            logger.error('SignalWire call initiation error', { error: err });
            return null;
        }
    }

    async redirectLiveCall(request: RedirectCallRequest): Promise<boolean> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; mock redirect succeeded');
            return true;
        }

        try {
            const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Calls/${encodeURIComponent(request.providerCallId)}.json`;
            const body = new URLSearchParams({ Url: request.callbackUrl, Method: 'POST' });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });

            if (!response.ok) {
                logger.error('SignalWire live call redirect failed', { providerCallId: request.providerCallId, status: response.status });
                return false;
            }

            return true;
        } catch (err) {
            logger.error('SignalWire live call redirect error', { providerCallId: request.providerCallId, error: err });
            return false;
        }
    }

    async transferCall(providerCallId: string, targetNumber: string, callbackUrl: string): Promise<boolean> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; mock transfer succeeded');
            return true;
        }

        try {
            const url = `https://${this.spaceUrl}/api/laml/2010-04-01/Accounts/${this.projectId}/Calls/${encodeURIComponent(providerCallId)}.json`;
            const twimlUrl = `${callbackUrl}/sw/transfer?to=${encodeURIComponent(targetNumber)}`;
            const body = new URLSearchParams({ Url: twimlUrl, Method: 'POST' });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });

            if (!response.ok) {
                logger.error('SignalWire live call transfer failed', { providerCallId, status: response.status });
                return false;
            }

            return true;
        } catch (err) {
            logger.error('SignalWire live call transfer error', { providerCallId, error: err });
            return false;
        }
    }
}

export const signalwireService = new SignalWireService();
