'use client';

import { useCallback, useRef, useState } from 'react';
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

type RelayNotification = {
    type?: string;
    call?: {
        id?: string;
        state?: string;
        prevState?: string;
        direction?: string;
        remoteNumber?: string;
        destinationNumber?: string;
    };
};

declare global {
    interface Window {
        Relay?: new (options: { project: string; token: string }) => RelayClient;
    }
}

type RelayClient = {
    connected?: boolean;
    on: (event: string, handler: (...args: any[]) => void) => RelayClient;
    off?: (event: string, handler?: (...args: any[]) => void) => RelayClient;
    connect: () => Promise<void>;
    disconnect?: () => void;
    refreshToken?: (token: string) => Promise<void>;
    newCall: (options: {
        destinationNumber: string;
        callerNumber?: string;
        id?: string;
        audio?: boolean;
        video?: boolean;
    }) => Promise<RelayCall>;
};

type RelayCall = {
    id?: string;
    state?: string;
    prevState?: string;
    direction?: string;
    on?: (event: string, handler: (...args: any[]) => void) => RelayCall;
    answer?: () => void;
    hangup?: () => void;
    deaf?: () => void;
    undeaf?: () => void;
    hold?: () => void;
    unhold?: () => void;
};

const RELAY_SCRIPT_SRC = 'https://cdn.signalwire.com/@signalwire/js@1';

const loadRelayScript = async (): Promise<void> => {
    if (typeof window === 'undefined') return;
    if (window.Relay) return;

    await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector(`script[src="${RELAY_SCRIPT_SRC}"]`) as HTMLScriptElement | null;
        if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error('Failed to load Relay SDK')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = RELAY_SCRIPT_SRC;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Relay SDK'));
        document.head.appendChild(script);
    });
};

const mapRelayStateToWorkspaceState = (state: string | undefined): 'idle' | 'dialing' | 'connected' => {
    switch (state) {
        case 'active':
        case 'held':
            return 'connected';
        case 'new':
        case 'trying':
        case 'requesting':
        case 'ringing':
        case 'early':
            return 'dialing';
        default:
            return 'idle';
    }
};

export function useSignalWireRelay() {
    const [state, setState] = useState<SignalWireState>({
        connected: false,
        onCall: false,
        muted: false,
        held: false,
        currentNumber: '',
        incomingCall: null,
        error: '',
    });

    const clientRef = useRef<RelayClient | null>(null);
    const activeCallRef = useRef<RelayCall | null>(null);
    const activeBackendCallIdRef = useRef<string | null>(null);

    const pushBrowserStatus = useCallback(async (payload: {
        callId: string;
        providerCallId?: string;
        relayState?: string;
        previousRelayState?: string;
        duration?: number;
        details?: Record<string, unknown>;
    }) => {
        try {
            await api.post(`/calls/${payload.callId}/browser-status`, payload);
        } catch {
            // no-op
        }
    }, []);

    const syncRelayCallState = useCallback(async (call: RelayCall, backendCallId: string, overrides?: { relayState?: string; previousRelayState?: string }) => {
        const relayState = overrides?.relayState || call.state;
        const previousRelayState = overrides?.previousRelayState || call.prevState;
        const workspaceState = mapRelayStateToWorkspaceState(relayState);

        await pushBrowserStatus({
            callId: backendCallId,
            providerCallId: call.id,
            relayState,
            previousRelayState,
            details: {
                transport: 'relay-v2',
                direction: call.direction || 'outbound',
            },
        });

        setState((prev) => ({
            ...prev,
            onCall: workspaceState === 'connected',
            held: relayState === 'held',
            error: '',
        }));
    }, [pushBrowserStatus]);

    const handleNotification = useCallback(async (notification: RelayNotification) => {
        if (notification.type === 'refreshToken' && clientRef.current?.refreshToken) {
            try {
                const response = await api.get('/agents/token/signalwire-relay');
                const token = response.data?.token as string | undefined;
                if (token) {
                    await clientRef.current.refreshToken(token);
                }
            } catch {
                setState((prev) => ({ ...prev, error: 'Failed to refresh SignalWire Relay token' }));
            }
            return;
        }

        if (notification.type !== 'callUpdate' || !notification.call) {
            return;
        }

        const call = notification.call;
        const workspaceState = mapRelayStateToWorkspaceState(call.state);

        if (call.direction === 'inbound' && workspaceState === 'dialing') {
            setState((prev) => ({
                ...prev,
                incomingCall: {
                    callerName: 'Inbound Caller',
                    callerNumber: call.remoteNumber || call.destinationNumber || 'Unknown Number',
                    callSid: call.id,
                    toNumber: call.destinationNumber,
                },
                error: '',
            }));
        }

        if (activeBackendCallIdRef.current) {
            await pushBrowserStatus({
                callId: activeBackendCallIdRef.current,
                providerCallId: call.id,
                relayState: call.state,
                previousRelayState: call.prevState,
                details: {
                    direction: call.direction || null,
                    remoteNumber: call.remoteNumber || null,
                    destinationNumber: call.destinationNumber || null,
                },
            });
        }

        setState((prev) => ({
            ...prev,
            onCall: workspaceState === 'connected',
            held: call.state === 'held',
            currentNumber: call.remoteNumber || prev.currentNumber,
            incomingCall: call.state === 'active' ? null : prev.incomingCall,
        }));

        if (workspaceState === 'idle') {
            activeCallRef.current = null;
            activeBackendCallIdRef.current = null;
            setState((prev) => ({
                ...prev,
                onCall: false,
                muted: false,
                held: false,
                currentNumber: '',
                incomingCall: null,
            }));
        }
    }, [pushBrowserStatus]);

    const connect = useCallback(async () => {
        if (clientRef.current?.connected) {
            setState((prev) => ({ ...prev, connected: true, error: '' }));
            return;
        }

        try {
            await loadRelayScript();
            if (!window.Relay) {
                throw new Error('Relay SDK did not load');
            }

            const tokenRes = await api.get('/agents/token/signalwire-relay');
            const token = tokenRes.data?.token as string | undefined;
            const projectId = tokenRes.data?.projectId as string | undefined;

            if (!token || !projectId) {
                throw new Error('SignalWire Relay token unavailable');
            }

            const client = new window.Relay({ project: projectId, token });
            client.on('signalwire.ready', () => {
                setState((prev) => ({ ...prev, connected: true, error: '' }));
            });
            client.on('signalwire.error', (error: { message?: string }) => {
                setState((prev) => ({ ...prev, connected: false, error: error?.message || 'SignalWire Relay connection failed' }));
            });
            client.on('signalwire.notification', (notification: RelayNotification) => {
                void handleNotification(notification);
            });

            await client.connect();
            clientRef.current = client;
            setState((prev) => ({ ...prev, connected: true, error: '' }));
        } catch (error) {
            setState((prev) => ({
                ...prev,
                connected: false,
                error: error instanceof Error ? error.message : 'Failed to connect SignalWire Relay softphone',
            }));
        }
    }, [handleNotification]);

    const dial = useCallback(async (number: string, fromNumber: string, backendCallId: string) => {
        if (!clientRef.current) {
            await connect();
        }

        if (!clientRef.current) {
            throw new Error('SignalWire Relay client unavailable');
        }

        const call = await clientRef.current.newCall({
            destinationNumber: number,
            callerNumber: fromNumber,
            id: backendCallId,
            audio: true,
            video: false,
        });

        activeCallRef.current = call;
        activeBackendCallIdRef.current = backendCallId;

        if (call.on) {
            call.on('ringing', () => {
                void syncRelayCallState(call, backendCallId, { relayState: 'ringing' });
            });
            call.on('answered', () => {
                void syncRelayCallState(call, backendCallId, {
                    relayState: 'active',
                    previousRelayState: call.state || call.prevState || 'ringing',
                });
            });
            call.on('stateChange', () => {
                void syncRelayCallState(call, backendCallId);
            });
            call.on('hangup', () => {
                void syncRelayCallState(call, backendCallId, { relayState: 'hangup' });
            });
            call.on('destroy', () => {
                void syncRelayCallState(call, backendCallId, { relayState: 'destroy' });
            });
        }

        await syncRelayCallState(call, backendCallId);

        setState((prev) => ({
            ...prev,
            onCall: false,
            currentNumber: number,
            error: '',
        }));
    }, [connect, syncRelayCallState]);

    const acceptIncoming = useCallback(async () => {
        const activeCall = activeCallRef.current;
        if (!activeCall?.answer) return;
        activeCall.answer();
        setState((prev) => ({
            ...prev,
            onCall: true,
            incomingCall: null,
            error: '',
        }));
    }, []);

    const rejectIncoming = useCallback(async () => {
        const activeCall = activeCallRef.current;
        if (!activeCall?.hangup) return;
        activeCall.hangup();
        activeCallRef.current = null;
        setState((prev) => ({
            ...prev,
            incomingCall: null,
            onCall: false,
            currentNumber: '',
        }));
    }, []);

    const hangup = useCallback(async () => {
        activeCallRef.current?.hangup?.();
        activeCallRef.current = null;
        activeBackendCallIdRef.current = null;
        setState((prev) => ({
            ...prev,
            onCall: false,
            muted: false,
            held: false,
            currentNumber: '',
            incomingCall: null,
        }));
    }, []);

    const toggleMute = useCallback(async () => {
        const activeCall = activeCallRef.current;
        if (!activeCall) return;

        if (state.muted) {
            activeCall.undeaf?.();
        } else {
            activeCall.deaf?.();
        }

        setState((prev) => ({ ...prev, muted: !prev.muted }));
    }, [state.muted]);

    const toggleHold = useCallback(async () => {
        const activeCall = activeCallRef.current;
        if (!activeCall) return;

        if (state.held) {
            activeCall.unhold?.();
        } else {
            activeCall.hold?.();
        }

        setState((prev) => ({ ...prev, held: !prev.held }));
    }, [state.held]);

    const simulateIncomingCall = useCallback((callerNumber?: string) => {
        const number = callerNumber || `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
        setState((prev) => ({
            ...prev,
            incomingCall: {
                callerName: 'Simulation Caller',
                callerNumber: number,
                callSid: `SIM-${Date.now()}`,
            },
        }));
    }, []);

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
