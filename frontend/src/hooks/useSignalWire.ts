'use client';

import { useState, useCallback, useRef } from 'react';
import { SignalWire, type SignalWireClient, type FabricRoomSession, type IncomingCallNotification } from '@signalwire/js';
import api from '@/lib/api';

interface IncomingCall {
    callerName: string;
    callerNumber: string;
    callSid?: string;
    toNumber?: string;
}

interface SignalWireState {
    connected: boolean;
    onCall: boolean;
    ringing: boolean;
    muted: boolean;
    held: boolean;
    callId: string | null;
    providerCallId: string | null;
    currentNumber: string;
    incomingCall: IncomingCall | null;
    error: string;
}

interface DialResult {
    callId: string;
    providerCallId?: string;
    fromNumber?: string;
}

interface PendingOutbound {
    backendCallId: string;
    providerCallId: string;
    toNumber: string;
    fromNumber?: string;
    placedAt: number;
}

type CallStateEventParams = { call_state?: string; call_id?: string };

const isCallStateParams = (value: unknown): value is CallStateEventParams =>
    typeof value === 'object' && value !== null;

const inviteMatchesPending = (
    details: Record<string, string | undefined>,
    pending: PendingOutbound | null,
): boolean => {
    if (!pending) return false;
    const providerCallId = pending.providerCallId;
    const candidates = [details.call_id, details.call_sid, details.sip_call_id, details.parent_call_id]
        .filter((v): v is string => Boolean(v));
    if (candidates.some((id) => id === providerCallId)) return true;
    // Fallback: SignalWire SIP invite to a subscriber may not echo the originating call_id.
    // Treat any invite arriving within 15s of an outbound origination as our outbound continuation.
    const ageMs = Date.now() - pending.placedAt;
    return ageMs < 15000;
};

export function useSignalWire() {
    const [state, setState] = useState<SignalWireState>({
        connected: false,
        onCall: false,
        ringing: false,
        muted: false,
        held: false,
        callId: null,
        providerCallId: null,
        currentNumber: '',
        incomingCall: null,
        error: '',
    });

    const clientRef = useRef<SignalWireClient | null>(null);
    const activeCallRef = useRef<FabricRoomSession | null>(null);
    const activeBackendCallIdRef = useRef<string | null>(null);
    const pendingInviteRef = useRef<IncomingCallNotification | null>(null);
    const pendingOutboundRef = useRef<PendingOutbound | null>(null);

    const pushBrowserStatus = useCallback(async (callId: string, payload: {
        providerCallId?: string;
        relayState?: string;
        previousRelayState?: string;
        details?: Record<string, unknown>;
    }) => {
        if (!callId) return; // race: backendCallId not yet known
        try {
            await api.post(`/calls/${callId}/browser-status`, payload);
        } catch {
            // status updates are fire-and-forget; UI keeps SDK truth
        }
    }, []);

    // Visible-but-offscreen audio container for SDK media attachment. The SDK
    // attaches a child media element here and starts playing audio; some
    // WebRTC stacks refuse media attachment to zero-dimension elements.
    const ensureMediaRoot = useCallback((): HTMLElement => {
        if (typeof document === 'undefined') return null as unknown as HTMLElement;
        const id = '__sw_media_root';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.style.position = 'fixed';
            el.style.left = '-9999px';
            el.style.top = '0';
            el.style.width = '1px';
            el.style.height = '1px';
            el.style.overflow = 'hidden';
            el.style.pointerEvents = 'none';
            document.body.appendChild(el);
        }
        return el;
    }, []);

    const cleanupActive = useCallback(() => {
        activeCallRef.current = null;
        activeBackendCallIdRef.current = null;
        pendingOutboundRef.current = null;
        setState((prev) => ({
            ...prev,
            onCall: false,
            ringing: false,
            muted: false,
            held: false,
            currentNumber: '',
            callId: null,
            providerCallId: null,
            incomingCall: null,
        }));
    }, []);

    const wireRoomEvents = useCallback((room: FabricRoomSession, backendCallId: string) => {
        // CallState transitions: 'created' | 'ringing' | 'answered' | 'ending' | 'ended'
        room.on('call.state', (params: unknown) => {
            if (!isCallStateParams(params)) return;
            const callState = params.call_state || '';
            const providerCallId = params.call_id;

            void pushBrowserStatus(backendCallId, {
                providerCallId,
                relayState: callState,
                details: { transport: 'fabric-v3' },
            });

            setState((prev) => ({
                ...prev,
                providerCallId: providerCallId || prev.providerCallId,
                ringing: callState === 'created' || callState === 'ringing',
                onCall: callState === 'answered',
            }));
        });

        room.on('call.left', () => {
            void pushBrowserStatus(backendCallId, { relayState: 'ended' });
            cleanupActive();
        });

        room.on('destroy', () => {
            cleanupActive();
        });
    }, [pushBrowserStatus, cleanupActive]);

    const connect = useCallback(async () => {
        if (clientRef.current) {
            setState((prev) => ({ ...prev, connected: true }));
            return;
        }

        try {
            const tokenRes = await api.get('/agents/token/signalwire');
            const token = tokenRes.data?.token as string | undefined;

            if (!token) {
                setState((prev) => ({ ...prev, error: 'SignalWire token unavailable' }));
                return;
            }

            const client = await SignalWire({ token });
            await client.online({
                incomingCallHandlers: {
                    all: async (notification) => {
                        const details = notification.invite.details as unknown as Record<string, string | undefined>;
                        const pending = pendingOutboundRef.current;

                        if (inviteMatchesPending(details, pending) && pending) {
                            // This SIP invite is the agent leg of an outbound we just placed.
                            // Auto-accept silently — no UI prompt.
                            pendingOutboundRef.current = null;
                            try {
                                const session = await notification.invite.accept({ rootElement: ensureMediaRoot() });
                                activeCallRef.current = session;
                                activeBackendCallIdRef.current = pending.backendCallId;
                                wireRoomEvents(session, pending.backendCallId);
                                setState((prev) => ({
                                    ...prev,
                                    onCall: false,
                                    ringing: true,
                                    incomingCall: null,
                                    callId: pending.backendCallId,
                                    providerCallId: pending.providerCallId,
                                    currentNumber: pending.toNumber,
                                    error: '',
                                }));
                            } catch (err) {
                                const message = err instanceof Error ? err.message : 'Unable to attach to outbound leg';
                                void pushBrowserStatus(pending.backendCallId, { relayState: 'failed', details: { reason: message } });
                                setState((prev) => ({ ...prev, ringing: false, error: message }));
                            }
                            return;
                        }

                        // Genuine inbound call → surface to UI for accept/reject.
                        pendingInviteRef.current = notification;
                        setState((prev) => ({
                            ...prev,
                            incomingCall: {
                                callerName: details.caller_id_name || 'Unknown Caller',
                                callerNumber: details.caller_id_number || 'Unknown Number',
                                callSid: details.call_sid || details.call_id || details.sip_call_id,
                                toNumber: details.destination_number || details.to,
                            },
                            error: '',
                        }));
                    },
                },
            });

            clientRef.current = client;
            setState((prev) => ({ ...prev, connected: true, error: '' }));
        } catch (err) {
            const responseStatus = (err as { response?: { status?: number; data?: { error?: string } } })?.response?.status;
            const responseError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
            const message = responseStatus === 402
                ? (responseError || 'SignalWire account has insufficient balance for softphone connectivity')
                : (err instanceof Error ? err.message : 'Failed to connect SignalWire softphone');
            setState((prev) => ({ ...prev, connected: false, error: message }));
        }
    }, []);

    const dial = useCallback(async (toNumber: string): Promise<DialResult | null> => {
        if (!clientRef.current) {
            await connect();
        }
        if (!clientRef.current) {
            setState((prev) => ({ ...prev, error: 'SignalWire client not connected' }));
            return null;
        }

        // Server originates the call: SignalWire dials the agent's SIP first (this browser),
        // then SWML bridges that leg to the PSTN destination. The agent's SDK will receive
        // a SIP invite via incomingCallHandlers; the handler auto-accepts when it matches
        // pendingOutboundRef. We do NOT call client.dial — Fabric's client.dial is for
        // subscriber-to-subscriber addresses, not bare PSTN E.164.
        //
        // RACE: SignalWire's SIP invite to the browser can arrive faster than the
        // /browser-session response returns. Set pendingOutboundRef BEFORE the POST
        // with a placeholder providerCallId; inviteMatchesPending falls back to a
        // 15-second age window when ids don't match, so as long as pending exists
        // and is recent, the invite auto-accepts.
        const provisionalPlacedAt = Date.now();
        pendingOutboundRef.current = {
            backendCallId: '',
            providerCallId: '',
            toNumber,
            fromNumber: undefined,
            placedAt: provisionalPlacedAt,
        };

        let sessionResp: { callId: string; providerCallId?: string; fromNumber?: string };
        try {
            const { data } = await api.post('/calls/browser-session', { toNumber });
            sessionResp = {
                callId: data.callId,
                providerCallId: data.providerCallId,
                fromNumber: data.fromNumber,
            };
        } catch (err) {
            pendingOutboundRef.current = null;
            const respErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
            setState((prev) => ({ ...prev, error: respErr || 'Failed to start outbound call' }));
            return null;
        }

        if (!sessionResp.providerCallId) {
            pendingOutboundRef.current = null;
            setState((prev) => ({ ...prev, error: 'Provider did not return a call identifier' }));
            return null;
        }

        // Update pending with real ids, but keep the original placedAt so a
        // SIP invite that arrived during the network round-trip still matches
        // by age fallback if it inspects the ref again.
        pendingOutboundRef.current = {
            backendCallId: sessionResp.callId,
            providerCallId: sessionResp.providerCallId,
            toNumber,
            fromNumber: sessionResp.fromNumber,
            placedAt: provisionalPlacedAt,
        };
        activeBackendCallIdRef.current = sessionResp.callId;
        setState((prev) => ({
            ...prev,
            callId: sessionResp.callId,
            providerCallId: sessionResp.providerCallId || null,
            currentNumber: toNumber,
            ringing: true,
            error: '',
        }));

        return sessionResp;
    }, [connect]);

    const acceptIncoming = useCallback(async () => {
        const invite = pendingInviteRef.current;
        if (!invite) return;

        try {
            const session = await invite.invite.accept({ rootElement: ensureMediaRoot() });
            activeCallRef.current = session;
            pendingInviteRef.current = null;

            const details = invite.invite.details as unknown as Record<string, string | undefined>;
            const callSid = details.call_sid || details.call_id || details.sip_call_id || '';
            const fromNumber = details.caller_id_number;
            const toNumber = details.destination_number || details.to;

            // Correlate SDK call with backend Call record
            let backendCallId: string | null = null;
            if (callSid) {
                try {
                    const { data } = await api.post('/calls/inbound/attach', {
                        callSid,
                        fromNumber: fromNumber || null,
                        toNumber: toNumber || null,
                    });
                    backendCallId = data.callId || null;
                } catch {
                    // attach is best-effort; the call is still live in the SDK
                }
            }

            if (backendCallId) {
                activeBackendCallIdRef.current = backendCallId;
                wireRoomEvents(session, backendCallId);
            }

            setState((prev) => ({
                ...prev,
                onCall: true,
                ringing: false,
                incomingCall: null,
                callId: backendCallId,
                providerCallId: callSid || null,
                currentNumber: fromNumber || prev.currentNumber,
                error: '',
            }));
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unable to answer call';
            setState((prev) => ({ ...prev, incomingCall: null, error: message }));
        }
    }, [wireRoomEvents]);

    const rejectIncoming = useCallback(async () => {
        const invite = pendingInviteRef.current;
        pendingInviteRef.current = null;
        setState((prev) => ({ ...prev, incomingCall: null }));
        if (!invite) return;
        try {
            await invite.invite.reject();
        } catch {
            // no-op
        }
    }, []);

    const hangup = useCallback(async () => {
        const call = activeCallRef.current;
        const backendCallId = activeBackendCallIdRef.current;
        try {
            await call?.hangup();
        } catch {
            // no-op — cleanupActive still runs below
        }
        if (backendCallId) {
            void pushBrowserStatus(backendCallId, { relayState: 'ended', details: { source: 'agent.hangup' } });
        }
        cleanupActive();
    }, [pushBrowserStatus, cleanupActive]);

    const toggleMute = useCallback(async () => {
        const call = activeCallRef.current;
        if (!call) {
            setState((prev) => ({ ...prev, muted: !prev.muted }));
            return;
        }
        try {
            if (state.muted) {
                await call.audioUnmute();
            } else {
                await call.audioMute();
            }
            setState((prev) => ({ ...prev, muted: !prev.muted }));
        } catch {
            // no-op
        }
    }, [state.muted]);

    const toggleHold = useCallback(async () => {
        const call = activeCallRef.current;
        if (!call) {
            setState((prev) => ({ ...prev, held: !prev.held }));
            return;
        }
        try {
            if (state.held) {
                await call.undeaf();
            } else {
                await call.deaf();
            }
            setState((prev) => ({ ...prev, held: !prev.held }));
        } catch {
            // no-op
        }
    }, [state.held]);

    return {
        ...state,
        connect,
        dial,
        hangup,
        toggleMute,
        toggleHold,
        acceptIncoming,
        rejectIncoming,
    };
}
