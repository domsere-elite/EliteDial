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
        try {
            await api.post(`/calls/${callId}/browser-status`, payload);
        } catch {
            // status updates are fire-and-forget; UI keeps SDK truth
        }
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

            // The client is dial-capable as soon as SignalWire() resolves. Going
            // online() is only required to receive incoming calls — outbound dial
            // does not need it. Register the client and mark connected first so
            // that a failure in online() (e.g. "WebRTC endpoint registration
            // failed" when the subscriber is in a bad state) doesn't block
            // outbound calling.
            clientRef.current = client;
            (window as unknown as { __sw?: SignalWireClient }).__sw = client;
            setState((prev) => ({ ...prev, connected: true, error: '' }));

            // NOTE: client.online() is intentionally NOT called.
            //
            // online() registers the WebRTC endpoint to receive incoming calls.
            // SignalWire's server has been rejecting that registration for this
            // project's subscribers ({"code":-32603,"message":"WebRTC endpoint
            // registration failed"}), and the SDK retries the registration in a
            // tight loop that floods the JSON-RPC channel — which also breaks
            // outbound dial because dial responses can't get through.
            //
            // Skipping online() means: outbound dial works (the documented
            // pattern in SignalWire's webrtc-enabled-agent example does NOT
            // call online()), but this browser cannot RECEIVE inbound calls
            // until the registration issue is resolved (likely needs vendor
            // support to fix subscriber config / WebRTC entitlement on the
            // SignalWire space).
            //
            // To re-enable inbound: uncomment the block below once SignalWire
            // confirms registration is working.
            // -----------------------------------------------------------------
            // void incomingCallHandlers;  // see below for the handler body
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
        const client = clientRef.current;
        if (!client) {
            setState((prev) => ({ ...prev, error: 'SignalWire client not connected' }));
            return null;
        }

        // Backend creates/updates a SWML Resource configured to connect to this
        // specific destination, then returns its Fabric address (e.g.
        // "/private/agent-dial-XYZ?channel=audio"). We dial that address; the
        // SDK opens a WebRTC media path to SignalWire which executes the
        // Resource's SWML and bridges to the PSTN destination. No backend
        // origination, no SIP invite to the browser, no incomingCallHandlers
        // dependency.
        let sessionResp: { callId: string; resourceAddress: string; fromNumber?: string };
        try {
            const { data } = await api.post('/calls/browser-session', { toNumber });
            if (!data?.resourceAddress) {
                setState((prev) => ({ ...prev, error: 'Backend did not provide a Fabric resource address' }));
                return null;
            }
            sessionResp = {
                callId: data.callId,
                resourceAddress: data.resourceAddress,
                fromNumber: data.fromNumber,
            };
        } catch (err) {
            const respErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
            setState((prev) => ({ ...prev, error: respErr || 'Failed to start outbound call' }));
            return null;
        }

        const backendCallId = sessionResp.callId;
        activeBackendCallIdRef.current = backendCallId;
        setState((prev) => ({
            ...prev,
            callId: backendCallId,
            providerCallId: null,
            currentNumber: toNumber,
            ringing: true,
            error: '',
        }));

        // Ensure mic permission is granted and AudioContext is unsuspended
        // BEFORE invoking client.dial. Both are user-gesture-gated in the
        // browser; without them client.dial returns a session that never
        // negotiates media and the SWML connect step on SignalWire's side
        // never runs.
        try {
            const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            // eslint-disable-next-line no-console
            console.log('[SW-DIAL] AudioContext state before resume:', audioCtx.state);
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
                // eslint-disable-next-line no-console
                console.log('[SW-DIAL] AudioContext resumed, state:', audioCtx.state);
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[SW-DIAL] AudioContext resume failed:', e);
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // eslint-disable-next-line no-console
            console.log('[SW-DIAL] mic permission OK, tracks:', stream.getAudioTracks().map(t => t.label));
            stream.getTracks().forEach(t => t.stop()); // release; SDK will request its own
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Microphone permission denied';
            // eslint-disable-next-line no-console
            console.error('[SW-DIAL] mic permission failed:', e);
            void pushBrowserStatus(backendCallId, { relayState: 'failed', details: { reason: 'mic_permission_denied' } });
            cleanupActive();
            setState((prev) => ({ ...prev, error: 'Microphone access required: ' + message }));
            return null;
        }

        // eslint-disable-next-line no-console
        console.log('[SW-DIAL] client.dial → address:', sessionResp.resourceAddress);
        try {
            const room = await client.dial({
                to: sessionResp.resourceAddress,
                audio: true,
                video: false,
            }) as FabricRoomSession;
            // eslint-disable-next-line no-console
            console.log('[SW-DIAL] dial returned room session, attaching events. roomId:', (room as unknown as { id?: string }).id, 'roomState:', (room as unknown as { state?: string }).state);
            activeCallRef.current = room;
            wireRoomEvents(room, backendCallId);
            room.on('call.state', (s: unknown) => {
                // eslint-disable-next-line no-console
                console.log('[SW-DIAL] call.state →', s);
            });
            room.on('destroy', () => {
                // eslint-disable-next-line no-console
                console.log('[SW-DIAL] destroy');
            });
            (window as unknown as { __lastRoom?: unknown }).__lastRoom = room;
            // Periodic state poll for 30s, in case events are lost
            let ticks = 0;
            const stateInterval = setInterval(() => {
                ticks += 1;
                const s = (room as unknown as { state?: string }).state;
                // eslint-disable-next-line no-console
                console.log('[SW-DIAL] periodic poll', ticks, 'state:', s);
                if (ticks >= 6) clearInterval(stateInterval);
            }, 5000);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'SignalWire dial failed';
            // eslint-disable-next-line no-console
            console.error('[SW-DIAL] threw:', err);
            void pushBrowserStatus(backendCallId, { relayState: 'failed', details: { reason: message } });
            cleanupActive();
            setState((prev) => ({ ...prev, error: message }));
            return null;
        }

        return {
            callId: backendCallId,
            providerCallId: undefined,
            fromNumber: sessionResp.fromNumber,
        };
    }, [connect, cleanupActive, pushBrowserStatus, wireRoomEvents]);

    const acceptIncoming = useCallback(async () => {
        const invite = pendingInviteRef.current;
        if (!invite) return;

        try {
            const session = await invite.invite.accept({ audio: true, video: false, negotiateVideo: false });
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
