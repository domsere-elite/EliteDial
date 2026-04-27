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
    fromNumber?: string;
}

type CallStateEventParams = { call_state?: string; call_id?: string };

const isCallStateParams = (value: unknown): value is CallStateEventParams =>
    typeof value === 'object' && value !== null;

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
                    all: (notification) => {
                        const details = notification.invite.details as unknown as Record<string, string | undefined>;
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
        const client = clientRef.current;
        if (!client) {
            setState((prev) => ({ ...prev, error: 'SignalWire client not connected' }));
            return null;
        }

        // 1. Server-side compliance gate + DB record
        let sessionResp: { callId: string; fromNumber?: string };
        try {
            const { data } = await api.post('/calls/browser-session', { toNumber });
            sessionResp = { callId: data.callId, fromNumber: data.fromNumber };
        } catch (err) {
            const respErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
            setState((prev) => ({ ...prev, error: respErr || 'Failed to start outbound call' }));
            return null;
        }

        activeBackendCallIdRef.current = sessionResp.callId;
        setState((prev) => ({
            ...prev,
            callId: sessionResp.callId,
            currentNumber: toNumber,
            ringing: true,
            error: '',
        }));

        // 2. SDK dial (browser-originated audio leg via Fabric)
        try {
            const room = await client.dial({
                to: toNumber,
                audio: true,
                video: false,
                negotiateVideo: false,
            });
            activeCallRef.current = room;
            wireRoomEvents(room, sessionResp.callId);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unable to place outbound call';
            void pushBrowserStatus(sessionResp.callId, { relayState: 'failed', details: { reason: message } });
            cleanupActive();
            setState((prev) => ({ ...prev, error: message }));
            return null;
        }

        return sessionResp;
    }, [connect, wireRoomEvents, pushBrowserStatus, cleanupActive]);

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
