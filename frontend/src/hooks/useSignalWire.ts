'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { SignalWire, type SignalWireClient, type FabricRoomSession, type IncomingCallNotification } from '@signalwire/js';
import api from '@/lib/api';
import { useRealtime } from '@/components/RealtimeProvider';

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

// A power-dial batch the worker has pre-armed us about. The Fabric bridge
// notification will arrive with no pendingOutboundRef (worker dispatched the
// call; we never POSTed /api/calls/browser-session), so we use this to
// recognise the upcoming bridge and auto-accept silently.
interface PendingPowerDialBatch {
    batchId: string;
    targetRef: string;
    expiresAt: number; // ms epoch
    receivedAt: number;
}

// Customer info for the leg that won the bridge race. Backend emits this from
// /swml/power-dial/claim the moment the atomic claim succeeds (~150ms after
// customer answer), so it lands in the browser before the Fabric bridge
// notification arrives (~3-5s later via SignalWire's bridge dispatch).
interface PendingPowerDialWinner {
    batchId: string;
    legId: string;
    contactName: string | null;
    contactPhone: string | null;
    providerCallId: string | null;
    receivedAt: number;
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
    // Fallback: with PSTN-first origination, the inbound Fabric notification only
    // arrives AFTER the customer answers their cell — which can take 30+ seconds.
    // Treat any invite arriving within 60s of an outbound origination as our
    // outbound continuation.
    const ageMs = Date.now() - pending.placedAt;
    return ageMs < 60000;
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
    const pendingPowerDialBatchesRef = useRef<PendingPowerDialBatch[]>([]);
    const pendingPowerDialWinnersRef = useRef<PendingPowerDialWinner[]>([]);

    // Subscribe to power_dial.batch.dispatched events. Worker fires this BEFORE
    // it originates the legs, so by the time the customer's leg AMD-detects
    // human and the bridge to /private/<targetRef> reaches our SDK, this ref
    // is already populated and the invite handler auto-accepts silently.
    const realtime = useRealtime();
    useEffect(() => {
        const dispatchHandler = (...args: unknown[]) => {
            const payload = args[0] as { batchId?: string; targetRef?: string; expiresAt?: string } | undefined;
            if (!payload?.batchId || !payload?.targetRef || !payload?.expiresAt) return;
            const now = Date.now();
            pendingPowerDialBatchesRef.current = pendingPowerDialBatchesRef.current.filter((b) => b.expiresAt > now);
            pendingPowerDialBatchesRef.current.push({
                batchId: payload.batchId,
                targetRef: payload.targetRef,
                expiresAt: new Date(payload.expiresAt).getTime(),
                receivedAt: now,
            });
            console.info('[useSignalWire] power-dial batch armed', payload);
        };

        // Backend's /swml/power-dial/claim emits this when a leg wins the
        // bridge claim. Carries the customer's name + phone so the dashboard
        // can render the actual customer instead of the Fabric SIP-ish
        // caller_id_number when the bridge invite arrives ~3-5s later.
        const winnerHandler = (...args: unknown[]) => {
            const payload = args[0] as PendingPowerDialWinner | undefined;
            if (!payload?.batchId || !payload?.legId) return;
            // Keep only the most-recent winner per batch.
            const now = Date.now();
            pendingPowerDialWinnersRef.current = pendingPowerDialWinnersRef.current.filter(
                (w) => w.batchId !== payload.batchId && now - w.receivedAt < 60_000,
            );
            pendingPowerDialWinnersRef.current.push({ ...payload, receivedAt: now });
            console.info('[useSignalWire] power-dial bridge winner', payload);
        };

        realtime.on('power_dial.batch.dispatched', dispatchHandler);
        realtime.on('power_dial.bridge.winner', winnerHandler);
        return () => {
            realtime.off('power_dial.batch.dispatched', dispatchHandler);
            realtime.off('power_dial.bridge.winner', winnerHandler);
        };
    }, [realtime]);

    function consumePendingPowerDialBatch(): PendingPowerDialBatch | null {
        const now = Date.now();
        pendingPowerDialBatchesRef.current = pendingPowerDialBatchesRef.current.filter((b) => b.expiresAt > now);
        const next = pendingPowerDialBatchesRef.current.shift() || null;
        return next;
    }

    function consumePowerDialWinner(batchId: string | null): PendingPowerDialWinner | null {
        const now = Date.now();
        pendingPowerDialWinnersRef.current = pendingPowerDialWinnersRef.current.filter((w) => now - w.receivedAt < 60_000);
        if (!batchId) {
            // No batch known — return the most recent winner if any (fallback).
            return pendingPowerDialWinnersRef.current[pendingPowerDialWinnersRef.current.length - 1] || null;
        }
        const idx = pendingPowerDialWinnersRef.current.findIndex((w) => w.batchId === batchId);
        if (idx < 0) return null;
        const [winner] = pendingPowerDialWinnersRef.current.splice(idx, 1);
        return winner;
    }

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
        // CallState transitions: 'created' | 'ringing' | 'answered' | 'ending' | 'ended'.
        // For the PSTN-first flow, the auto-accept handler optimistically sets
        // onCall: true the moment accept() resolves (the bridge is already live by
        // then). Don't regress that — only forward-transition: leave onCall sticky
        // on intermediate states, and clear both flags on terminal states.
        room.on('call.state', (params: unknown) => {
            if (!isCallStateParams(params)) return;
            const callState = params.call_state || '';
            const providerCallId = params.call_id;

            void pushBrowserStatus(backendCallId, {
                providerCallId,
                relayState: callState,
                details: { transport: 'fabric-v3' },
            });

            setState((prev) => {
                const next = {
                    ...prev,
                    providerCallId: providerCallId || prev.providerCallId,
                };
                if (callState === 'answered') {
                    next.onCall = true;
                    next.ringing = false;
                } else if (callState === 'ending' || callState === 'ended') {
                    next.onCall = false;
                    next.ringing = false;
                } else if (!prev.onCall && (callState === 'created' || callState === 'ringing')) {
                    // Only show "ringing" if we haven't already advanced to onCall.
                    next.ringing = true;
                }
                return next;
            });
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
                        console.info('[useSignalWire] incoming Fabric invite', {
                            hasPendingOutbound: !!pending,
                            pendingPowerDialBatches: pendingPowerDialBatchesRef.current.length,
                            details: {
                                call_id: details.call_id,
                                from: details.caller_id_number || details.from,
                                to: details.destination_number || details.to,
                            },
                        });

                        if (inviteMatchesPending(details, pending) && pending) {
                            // This SIP invite is the agent leg of an outbound we just placed.
                            // Auto-accept silently — no UI prompt.
                            pendingOutboundRef.current = null;
                            try {
                                const session = await notification.invite.accept({ rootElement: ensureMediaRoot() });
                                activeCallRef.current = session;
                                activeBackendCallIdRef.current = pending.backendCallId;
                                wireRoomEvents(session, pending.backendCallId);
                                // PSTN-first flow: the customer has already answered before this
                                // Fabric notification fires (the SWML's connect: only runs after
                                // the customer's leg picks up). By the time accept() resolves,
                                // the bridge is formed and audio is flowing. The v3 SDK doesn't
                                // route call.state events for these calls to our room handler
                                // ("Got an unknown fabric event" warning), so we won't get an
                                // 'answered' state change — set onCall: true here directly so
                                // the UI moves past "connecting" and the call timer starts.
                                setState((prev) => ({
                                    ...prev,
                                    onCall: true,
                                    ringing: false,
                                    incomingCall: null,
                                    callId: pending.backendCallId,
                                    providerCallId: pending.providerCallId,
                                    currentNumber: pending.toNumber,
                                    error: '',
                                }));
                                void pushBrowserStatus(pending.backendCallId, {
                                    providerCallId: pending.providerCallId,
                                    relayState: 'in-progress',
                                    details: { transport: 'fabric-pstn-first' },
                                });
                            } catch (err) {
                                const message = err instanceof Error ? err.message : 'Unable to attach to outbound leg';
                                void pushBrowserStatus(pending.backendCallId, { relayState: 'failed', details: { reason: message } });
                                setState((prev) => ({ ...prev, ringing: false, error: message }));
                            }
                            return;
                        }

                        // Worker-originated bridge: a PowerDialBatch has been
                        // pre-armed via Socket.IO; this Fabric notification is
                        // the bridge from the customer leg's claim. Auto-accept
                        // silently so the agent is connected without a UI prompt.
                        const batch = consumePendingPowerDialBatch();
                        if (batch) {
                            // Look up the winner (customer name + phone) the backend
                            // emitted from /swml/power-dial/claim. This typically
                            // arrives ~3-5s before the bridge invite (Socket.IO is
                            // faster than the bridge dispatch). If it's missing, fall
                            // back to whatever the Fabric details give us.
                            const winner = consumePowerDialWinner(batch.batchId);
                            const displayNumber = winner?.contactPhone || details.caller_id_number || details.from || '';
                            const displayName = winner?.contactName || details.caller_id_name || '';
                            console.info('[useSignalWire] auto-accepting worker-originated bridge', {
                                batchId: batch.batchId,
                                winnerKnown: !!winner,
                                contactName: winner?.contactName,
                                contactPhone: winner?.contactPhone,
                            });
                            setState((prev) => ({
                                ...prev,
                                ringing: true,
                                currentNumber: displayNumber,
                                providerCallId: winner?.providerCallId || details.call_id || null,
                                error: '',
                            }));
                            try {
                                const session = await notification.invite.accept({ rootElement: ensureMediaRoot() });
                                activeCallRef.current = session;
                                activeBackendCallIdRef.current = null;
                                wireRoomEvents(session, '');
                                setState((prev) => ({
                                    ...prev,
                                    onCall: true,
                                    ringing: false,
                                    incomingCall: null,
                                    callId: null,
                                    providerCallId: winner?.providerCallId || details.call_id || null,
                                    currentNumber: displayNumber,
                                    error: '',
                                }));
                                // Mute warning on unused name (we surface it via state.currentNumber for now).
                                void displayName;
                            } catch (err) {
                                const message = err instanceof Error ? err.message : 'Unable to attach to power-dial bridge';
                                console.error('[useSignalWire] power-dial bridge accept failed', err);
                                setState((prev) => ({ ...prev, ringing: false, error: message }));
                            }
                            return;
                        }

                        // Genuine inbound call → surface to UI for accept/reject.
                        console.info('[useSignalWire] surfacing as genuine inbound (no pending outbound or batch)');
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
