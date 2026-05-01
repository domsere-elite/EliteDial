'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useSignalWire } from './useSignalWire';
import { useProfileStatus, type ProfileStatus } from './useProfileStatus';
import { useAuth } from './useAuth';

const ROOM_DEBOUNCE_MS = 500;

interface AgentRoomState {
    inRoom: boolean;
    roomError: string | null;
}

// Phase 3c — keeps the agent's WebRTC PeerConnection warm by dialing a
// per-agent SignalWire room while Profile.status is in a "wantInRoom" state
// (available, on-call, wrap-up). Customer legs `join_room` into the same
// room and get instant audio.
//
// Lifecycle:
//   offline/break -> available  -> mint signed URL, dial room, store session
//   available -> on-call/wrap-up -> no-op (stay in room across the bridge)
//   wrap-up -> available         -> no-op (already in room)
//   any -> break/offline         -> hang up the session, drop reference
//
// Resilience: on Socket.IO reconnect, if status is still wantInRoom but
// we don't have a session, redial.
export function useAgentRoom(): AgentRoomState {
    const { user } = useAuth();
    const sw = useSignalWire();
    const profile = useProfileStatus();

    const [inRoom, setInRoom] = useState(false);
    const [roomError, setRoomError] = useState<string | null>(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionRef = useRef<any | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inflightRef = useRef<boolean>(false);

    async function leaveRoom(): Promise<void> {
        const session = sessionRef.current;
        sessionRef.current = null;
        setInRoom(false);
        if (!session) return;
        try {
            if (typeof session.hangup === 'function') {
                await session.hangup();
            }
        } catch {
            // Room may have died already (network drop, etc.) — ignore.
        }
    }

    async function enterRoom(agentId: string): Promise<void> {
        try {
            console.info('[useAgentRoom] enterRoom: GET /agents/<id>/room-url', { agentId });
            const { data } = await api.get(`/agents/${agentId}/room-url`);
            const url = data?.url;
            console.info('[useAgentRoom] mint response', { url: url?.substring(0, 80) });
            if (!url) throw new Error('no room url');
            const t0 = performance.now();
            const session = await sw.dialRoom(url);
            console.info('[useAgentRoom] dialRoom resolved', { ms: Math.round(performance.now() - t0), hasSession: !!session });
            if (!session) {
                setRoomError('dialRoom returned null');
                return;
            }
            sessionRef.current = session;
            setInRoom(true);
            setRoomError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to enter room';
            console.error('[useAgentRoom] enterRoom failed', err);
            setInRoom(false);
            setRoomError(message);
            // Customer legs still get cold-bridge fallback per spec — non-fatal.
        }
    }

    async function reconcile(status: ProfileStatus): Promise<void> {
        if (inflightRef.current) {
            console.info('[useAgentRoom] reconcile skipped (inflight)');
            return;
        }
        inflightRef.current = true;
        try {
            const wantInRoom = status === 'available' || status === 'wrap-up' || status === 'on-call';
            console.info('[useAgentRoom] reconcile', { status, wantInRoom, hasSession: !!sessionRef.current, hasUserId: !!user?.id, swConnected: sw.connected });
            if (wantInRoom && !sessionRef.current) {
                if (!user?.id) {
                    console.info('[useAgentRoom] reconcile bailed: no user.id');
                    return;
                }
                if (!sw.connected) {
                    console.info('[useAgentRoom] reconcile bailed: sw not connected');
                    return;
                }
                await enterRoom(user.id);
            } else if (!wantInRoom && sessionRef.current) {
                await leaveRoom();
            }
        } finally {
            inflightRef.current = false;
        }
    }

    // Debounced status reconciler — flutters get one reconciliation, not many.
    // Includes user.id and sw.connected in deps so a status change that
    // arrived before either was ready gets retried when they become ready.
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const targetStatus = profile.status;
        debounceRef.current = setTimeout(() => {
            void reconcile(targetStatus);
        }, ROOM_DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile.status, user?.id, sw.connected]);

    return { inRoom, roomError };
}
