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
    muted: boolean;
    held: boolean;
    currentNumber: string;
    incomingCall: IncomingCall | null;
    error: string;
}

export function useSignalWire() {
    const [state, setState] = useState<SignalWireState>({
        connected: false,
        onCall: false,
        muted: false,
        held: false,
        currentNumber: '',
        incomingCall: null,
        error: '',
    });

    const clientRef = useRef<SignalWireClient | null>(null);
    const activeCallRef = useRef<FabricRoomSession | null>(null);
    const pendingInviteRef = useRef<IncomingCallNotification | null>(null);

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

    const acceptIncoming = useCallback(async () => {
        const invite = pendingInviteRef.current;
        if (!invite) {
            setState((prev) => {
                if (!prev.incomingCall) return prev;
                return {
                    ...prev,
                    onCall: true,
                    incomingCall: null,
                    currentNumber: prev.incomingCall.callerNumber || '',
                    error: '',
                };
            });
            return;
        }

        try {
            const session = await invite.invite.accept({ audio: true, video: false, negotiateVideo: false });
            activeCallRef.current = session;
            pendingInviteRef.current = null;

            setState((prev) => ({
                ...prev,
                onCall: true,
                incomingCall: null,
                currentNumber: invite.invite.details.caller_id_number || '',
                error: '',
            }));
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unable to answer call';
            setState((prev) => ({ ...prev, incomingCall: null, error: message }));
        }
    }, []);

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

    const simulateIncomingCall = useCallback((callerNumber?: string) => {
        const number = callerNumber || `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
        const callSid = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        pendingInviteRef.current = null;
        setState((prev) => ({
            ...prev,
            incomingCall: {
                callerName: 'Simulation Caller',
                callerNumber: number,
                callSid,
                toNumber: '+15551000001',
            },
            error: '',
        }));
    }, []);

    const dial = useCallback(async (number: string) => {
        setState((prev) => ({ ...prev, onCall: true, currentNumber: number }));
    }, []);

    const hangup = useCallback(async () => {
        try {
            if (activeCallRef.current) {
                await activeCallRef.current.end();
            }
        } catch {
            // no-op
        }

        activeCallRef.current = null;
        setState((prev) => ({ ...prev, onCall: false, muted: false, held: false, currentNumber: '' }));
    }, []);

    const toggleMute = useCallback(async () => {
        const target = activeCallRef.current;
        if (!target) {
            setState((prev) => ({ ...prev, muted: !prev.muted }));
            return;
        }

        try {
            if (state.muted) {
                await target.audioUnmute();
            } else {
                await target.audioMute();
            }
            setState((prev) => ({ ...prev, muted: !prev.muted }));
        } catch {
            // no-op
        }
    }, [state.muted]);

    const toggleHold = useCallback(async () => {
        const target = activeCallRef.current;
        if (!target) {
            setState((prev) => ({ ...prev, held: !prev.held }));
            return;
        }

        try {
            if (state.held) {
                await target.undeaf();
            } else {
                await target.deaf();
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
        simulateIncomingCall,
    };
}
