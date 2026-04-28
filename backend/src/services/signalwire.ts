import { createHash } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
    BrowserTokenResult,
    OutboundCallRequest,
    OutboundCallResult,
    TelephonyProvider,
} from './providers/types';

// Deterministic password derived from a stable secret + agent reference.
// Subscriber records require a password per /api/fabric/subscribers docs;
// without it the subscriber is half-provisioned and WebRTC endpoint
// registration is rejected by SignalWire's edge with code -32603.
function derivedSubscriberPassword(reference: string): string {
    const secret = process.env.SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET || config.signalwire.apiToken || 'elitedial-fallback';
    return createHash('sha256').update(`${secret}:${reference}`).digest('hex').slice(0, 32);
}

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

    private async requestSubscriberToken(reference: string): Promise<BrowserTokenResult & { subscriberId?: string }> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference }),
        });
        if (response.ok) {
            const data = (await response.json()) as { token?: string; subscriber_id?: string };
            return {
                token: data.token || null,
                subscriberId: data.subscriber_id,
                metadata: { provider: this.name, spaceUrl: this.spaceUrl, endpointReference: reference, reusedSubscriber: true, subscriberId: data.subscriber_id },
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

    // Idempotently set password and email on a subscriber. SignalWire's
    // /api/fabric/subscribers/tokens endpoint auto-creates a subscriber when
    // the reference doesn't match an existing one, but the auto-created
    // subscriber has NO password and stores the reference (often a UUID) in
    // the email field. Without a password, client.online() registration fails
    // with code -32603 "WebRTC endpoint registration failed". And the PUT
    // endpoint validates email format, so we must send a real email alongside
    // the password.
    private async ensureSubscriberPassword(subscriberId: string, reference: string, email: string): Promise<void> {
        const password = derivedSubscriberPassword(reference);
        try {
            const resp = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers/${subscriberId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({ email, password }),
            });
            if (!resp.ok) {
                const errBody = await resp.text();
                logger.warn('SignalWire ensureSubscriberPassword PUT failed', { status: resp.status, body: errBody, subscriberId, email });
            }
        } catch (err) {
            logger.warn('SignalWire ensureSubscriberPassword exception', { err, subscriberId });
        }
    }

    private async createSubscriber(reference: string, agentName: string, email: string): Promise<{ ok: boolean; error?: string }> {
        const password = derivedSubscriberPassword(reference);
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference, name: agentName, email, password }),
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
            const realEmail = agentEmail || `${agentId}@users.elitedial.local`;
            const existing = await this.requestSubscriberToken(reference);
            if (existing.token) {
                // SignalWire auto-creates a subscriber if reference doesn't match,
                // but the auto-created sub has NO password and stores the reference
                // (UUID) in the email field. online() registration fails with -32603.
                // Force-set password + valid email idempotently before returning the
                // token. SignalWire's PUT endpoint validates email format, so we must
                // send a real email alongside the password.
                if (existing.subscriberId) {
                    await this.ensureSubscriberPassword(existing.subscriberId, reference, realEmail);
                }
                return existing;
            }

            if (!this.allowProvisioning) {
                logger.warn('SignalWire subscriber provisioning blocked', { agentId, reference });
                return {
                    token: null,
                    error: 'subscriber_provisioning_disabled',
                    metadata: { provider: this.name, endpointReference: reference, existingSubscriberReuseAttempted: true },
                };
            }

            const create = await this.createSubscriber(reference, agentName, realEmail);
            if (!create.ok) return { token: null, error: create.error || 'subscriber_create_failed' };

            const created = await this.requestSubscriberToken(reference);
            if (created.token && created.subscriberId) {
                await this.ensureSubscriberPassword(created.subscriberId, reference, realEmail);
            }
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
            // Use the Fabric subscriber address. SignalWire resolves
            // /private/<reference> to sip:<reference>@<projectId>.call.signalwire.com;context=private
            // server-side. Constructing the SIP URI ourselves with the
            // space URL produces an unreachable host (verified — calls
            // were accepted but never reached the registered subscriber).
            const fabricTarget = `/private/${params.agentSipReference}`;

            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'dial',
                    params: {
                        from: params.callerIdNumber,
                        to: fabricTarget,
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
                raw: { fabricTarget, callerIdNumber: params.callerIdNumber, toNumber: params.toNumber },
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
    // The address is read from /api/fabric/addresses (NOT hand-constructed) — for
    // SWML scripts, SignalWire assigns an address whose channels.audio is the
    // dialable path; reusing the /private/<name> subscriber pattern silently fails.
    async ensureAgentDialResource(agentReference: string): Promise<{ resourceId: string; address: string } | null> {
        if (!this.isConfigured) return null;

        const name = `agent-dial-${agentReference}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);

        const listResp = await this.fetchImpl(
            `${this.baseUrl}/api/fabric/resources?page_size=200`,
            { headers: { Authorization: this.authHeader } },
        );
        let resourceId: string | null = null;
        let resourceRaw: unknown = null;
        if (listResp.ok) {
            const listData = (await listResp.json()) as {
                data?: Array<{ id: string; type: string; display_name: string; addresses?: unknown }>;
            };
            const existing = (listData.data || []).find(r => r.type === 'swml_script' && r.display_name === name);
            if (existing) {
                resourceId = existing.id;
                resourceRaw = existing;
            }
        }

        if (!resourceId) {
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
            resourceId = created.id;
            resourceRaw = created;
        }

        // Discover the actual dialable address by listing fabric addresses
        // and matching by name. The SDK's client.dial() needs a real address
        // assigned by SignalWire, not a hand-constructed /private/<name>.
        let discoveredAddress: string | null = null;
        let addressesRaw: unknown = null;
        try {
            const addrResp = await this.fetchImpl(
                `${this.baseUrl}/api/fabric/addresses?page_size=200`,
                { headers: { Authorization: this.authHeader } },
            );
            if (addrResp.ok) {
                const addrData = (await addrResp.json()) as {
                    data?: Array<{
                        id: string;
                        name: string;
                        display_name?: string;
                        type: string;
                        channels?: { audio?: string; video?: string; messaging?: string };
                    }>;
                };
                addressesRaw = addrData.data;
                const match = (addrData.data || []).find(a => a.name === name || a.display_name === name);
                if (match?.channels?.audio) {
                    discoveredAddress = match.channels.audio.replace(/\?channel=audio$/, '');
                }
            }
        } catch (err) {
            logger.warn('SignalWire address discovery failed', { error: err });
        }

        const fallbackAddress = `/private/${name}`;
        const address = discoveredAddress || fallbackAddress;
        logger.info('SignalWire ensureAgentDialResource', {
            name,
            resourceId,
            chosenAddress: address,
            discoveredAddress,
            usedFallback: !discoveredAddress,
            resourceRaw,
            addressesSample: Array.isArray(addressesRaw)
                ? (addressesRaw as Array<{ name: string; type: string; channels?: unknown }>)
                    .map(a => ({ name: a.name, type: a.type, channels: a.channels }))
                : null,
        });

        return { resourceId: resourceId!, address };
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
