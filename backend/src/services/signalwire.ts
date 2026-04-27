import { config } from '../config';
import { logger } from '../utils/logger';
import {
    BrowserTokenResult,
    OutboundCallRequest,
    OutboundCallResult,
    TelephonyProvider,
} from './providers/types';

export interface SignalWireServiceConfig {
    projectId: string;
    apiToken: string;
    spaceUrl: string;
    allowSubscriberProvisioning: boolean;
}

export interface SignalWireServiceDeps {
    fetch: typeof fetch;
}

const defaultDeps: SignalWireServiceDeps = { fetch: globalThis.fetch };

export class SignalWireService implements TelephonyProvider {
    readonly name = 'signalwire';

    private projectId: string;
    private apiToken: string;
    private spaceUrl: string;
    private allowProvisioning: boolean;
    private fetchImpl: typeof fetch;

    constructor(cfg?: Partial<SignalWireServiceConfig>, deps: SignalWireServiceDeps = defaultDeps) {
        this.projectId = cfg?.projectId ?? config.signalwire.projectId;
        this.apiToken = cfg?.apiToken ?? config.signalwire.apiToken;
        this.spaceUrl = cfg?.spaceUrl ?? config.signalwire.spaceUrl;
        this.allowProvisioning = cfg?.allowSubscriberProvisioning ?? config.signalwire.allowSubscriberProvisioning;
        this.fetchImpl = deps.fetch;
    }

    get isConfigured(): boolean {
        return !!(this.projectId && this.apiToken && this.spaceUrl);
    }

    private get authHeader(): string {
        return 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64');
    }

    private get baseUrl(): string {
        return `https://${this.spaceUrl}`;
    }

    async generateRelayJwt(resource: string, expiresInMinutes = 15): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            return { token: null, error: 'signalwire_not_configured' };
        }
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/relay/rest/jwt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({ resource, expires_in: expiresInMinutes }),
            });
            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire relay JWT failed', { status: response.status, body: bodyText });
                return {
                    token: null,
                    error: `relay_jwt_failed_${response.status}`,
                    metadata: { provider: this.name, resource, responseStatus: response.status, responseBody: bodyText },
                };
            }
            const data = (await response.json()) as { jwt_token?: string };
            return { token: data.jwt_token || null, metadata: { provider: this.name, resource, transport: 'relay-v2' } };
        } catch (err) {
            logger.error('SignalWire relay JWT error', { error: err });
            return { token: null, error: 'relay_jwt_exception' };
        }
    }

    private async requestSubscriberToken(reference: string): Promise<BrowserTokenResult> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference }),
        });
        if (response.ok) {
            const data = (await response.json()) as { token?: string };
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
            metadata: { provider: this.name, endpointReference: reference, responseStatus: response.status, responseBody: errBody },
        };
    }

    private async createSubscriber(reference: string, agentName: string, email: string): Promise<{ ok: boolean; error?: string }> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference, name: agentName, email }),
        });
        if (response.ok || response.status === 409 || response.status === 422) {
            return { ok: true };
        }
        const errBody = await response.text();
        logger.error('SignalWire fabric subscriber create failed', { status: response.status, body: errBody, reference });
        return { ok: false, error: `subscriber_create_failed_${response.status}` };
    }

    async generateBrowserToken(
        agentId: string,
        agentName: string,
        agentEmail?: string,
        endpointReference?: string,
    ): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock browser token');
            return {
                token: `mock-browser-token-${endpointReference || agentId}`,
                metadata: { provider: this.name, endpointReference: endpointReference || agentId },
            };
        }

        try {
            const reference = endpointReference || agentId;
            const existing = await this.requestSubscriberToken(reference);
            if (existing.token) return existing;

            if (!this.allowProvisioning) {
                logger.warn('SignalWire subscriber provisioning blocked', { agentId, reference });
                return {
                    token: null,
                    error: 'subscriber_provisioning_disabled',
                    metadata: { provider: this.name, endpointReference: reference, existingSubscriberReuseAttempted: true },
                };
            }

            const email = agentEmail || `${agentId}@users.elitedial.local`;
            const create = await this.createSubscriber(reference, agentName, email);
            if (!create.ok) return { token: null, error: create.error || 'subscriber_create_failed' };

            const created = await this.requestSubscriberToken(reference);
            if (created.token) {
                return { ...created, metadata: { ...(created.metadata || {}), reusedSubscriber: false, subscriberCreated: true } };
            }
            return created;
        } catch (err) {
            logger.error('SignalWire token generation error', { error: err });
            return { token: null, error: 'token_generation_exception' };
        }
    }

    async originateAgentBrowserCall(params: {
        agentSipReference: string;
        toNumber: string;
        callerIdNumber: string;
        callbackUrl: string;
    }): Promise<OutboundCallResult | null> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock agent-call id');
            return { provider: this.name, providerCallId: `mock-agent-call-${Date.now()}` };
        }

        try {
            const queryString = new URLSearchParams([
                ['to', params.toNumber],
                ['from', params.callerIdNumber],
            ]).toString();
            const swmlUrl = `${params.callbackUrl}/swml/bridge?${queryString}`;
            const statusUrl = `${params.callbackUrl}/signalwire/events/call-status`;
            const sipTarget = `sip:${params.agentSipReference}@${this.spaceUrl}`;

            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'dial',
                    params: {
                        from: params.callerIdNumber,
                        to: sipTarget,
                        caller_id: params.callerIdNumber,
                        url: swmlUrl,
                        status_url: statusUrl,
                    },
                }),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire agent-browser call origination failed', { status: response.status, body: bodyText });
                return null;
            }

            const data = (await response.json()) as { id?: string; call_id?: string };
            return {
                provider: this.name,
                providerCallId: data.id || data.call_id || '',
                raw: { sipTarget, callerIdNumber: params.callerIdNumber, toNumber: params.toNumber },
            };
        } catch (err) {
            logger.error('SignalWire agent-browser call origination error', { error: err });
            return null;
        }
    }

    async initiateOutboundCall(params: OutboundCallRequest): Promise<OutboundCallResult | null> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock call id');
            return { provider: this.name, providerCallId: `mock-call-${Date.now()}`, raw: params.metadata };
        }

        try {
            const queryString = new URLSearchParams(
                params.swmlQuery
                    ? Object.entries(params.swmlQuery)
                    : [['to', params.toNumber], ['from', params.fromNumber]],
            ).toString();
            const swmlUrl = `${params.callbackUrl}/swml/bridge?${queryString}`;
            const statusUrl = `${params.callbackUrl}/signalwire/events/call-status`;

            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'dial',
                    params: {
                        from: params.fromNumber,
                        to: params.toNumber,
                        caller_id: params.fromNumber,
                        url: swmlUrl,
                        status_url: statusUrl,
                    },
                }),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire call initiation failed', { status: response.status, body: bodyText });
                return null;
            }

            const data = (await response.json()) as { id?: string; call_id?: string };
            return {
                provider: this.name,
                providerCallId: data.id || data.call_id || '',
                raw: { callbackUrl: params.callbackUrl },
            };
        } catch (err) {
            logger.error('SignalWire call initiation error', { error: err });
            return null;
        }
    }

    // Get-or-create a SWML script Resource the agent's browser will dial as a Fabric
    // address. We keep one Resource per agent; the inline SWML is rewritten before
    // each call (see updateAgentDialResource) to point at that call's destination.
    //
    // Resource address shape: /private/<name>?channel=audio
    async ensureAgentDialResource(agentReference: string): Promise<{ resourceId: string; address: string } | null> {
        if (!this.isConfigured) return null;

        const name = `agent-dial-${agentReference}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
        const address = `/private/${name}?channel=audio`;

        const listResp = await this.fetchImpl(
            `${this.baseUrl}/api/fabric/resources?page_size=200`,
            { headers: { Authorization: this.authHeader } },
        );
        if (listResp.ok) {
            const listData = (await listResp.json()) as { data?: Array<{ id: string; type: string; display_name: string }> };
            const existing = (listData.data || []).find(r => r.type === 'swml_script' && r.display_name === name);
            if (existing) return { resourceId: existing.id, address };
        }

        const createResp = await this.fetchImpl(
            `${this.baseUrl}/api/fabric/resources/swml_scripts`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    name,
                    contents: { version: '1.0.0', sections: { main: [{ hangup: {} }] } },
                }),
            },
        );
        if (!createResp.ok) {
            const bodyText = await createResp.text();
            logger.error('SignalWire ensureAgentDialResource create failed', { status: createResp.status, body: bodyText, name });
            return null;
        }
        const created = (await createResp.json()) as { id: string };
        return { resourceId: created.id, address };
    }

    // Rewrite the agent's dial Resource so the next dial connects audio to a specific
    // PSTN number. Browser dials the Resource address; SignalWire executes this SWML
    // and bridges the browser leg to the PSTN leg.
    async updateAgentDialResource(resourceId: string, params: { to: string; from: string; name: string }): Promise<boolean> {
        if (!this.isConfigured) return false;
        const swml = {
            version: '1.0.0',
            sections: {
                main: [
                    { answer: {} },
                    {
                        connect: {
                            to: params.to,
                            from: params.from,
                            timeout: 30,
                            answer_on_bridge: true,
                        },
                    },
                    { hangup: {} },
                ],
            },
        };
        const resp = await this.fetchImpl(
            `${this.baseUrl}/api/fabric/resources/swml_scripts/${resourceId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({ name: params.name, contents: swml }),
            },
        );
        if (!resp.ok) {
            const bodyText = await resp.text();
            logger.error('SignalWire updateAgentDialResource failed', { status: resp.status, body: bodyText, resourceId });
            return false;
        }
        return true;
    }

    // Pattern A: POST /api/calling/calls with {command: "update", call_id, params: {url}}.
    // Verified by unit test; awaiting live integration check (no SignalWire creds in dev).
    // If Pattern A fails against a live account, switch to pattern B:
    //   POST /api/calling/calls/{call_id} with {params: {url}}.
    async transferCall(providerCallId: string, targetNumber: string, callbackUrl: string): Promise<boolean> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; mock transfer succeeded');
            return true;
        }

        try {
            const swmlUrl = `${callbackUrl}/swml/transfer?to=${encodeURIComponent(targetNumber)}`;
            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'update',
                    call_id: providerCallId,
                    params: { url: swmlUrl },
                }),
            });
            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire transferCall failed', { providerCallId, status: response.status, body: bodyText });
                return false;
            }
            return true;
        } catch (err) {
            logger.error('SignalWire transferCall error', { providerCallId, error: err });
            return false;
        }
    }
}

export const signalwireService = new SignalWireService();
