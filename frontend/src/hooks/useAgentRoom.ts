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
            const { data } = await api.get(`/agents/${agentId}/room-url`);
            const url = data?.url;
            if (!url) throw new Error('no room url');
            const session = await sw.dialRoom(url);
            if (!session) {
                setRoomError('dialRoom returned null');
                return;
            }
            sessionRef.current = session;
            setInRoom(true);
            setRoomError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to enter room';
            setInRoom(false);
            setRoomError(message);
            // Customer legs still get cold-bridge fallback per spec — non-fatal.
        }
    }

    async function reconcile(status: ProfileStatus): Promise<void> {
        if (inflightRef.current) return;
        inflightRef.current = true;
        try {
            const wantInRoom = status === 'available' || status === 'wrap-up' || status === 'on-call';
            if (wantInRoom && !sessionRef.current) {
                if (!user?.id) return;
                if (!sw.connected) return; // wait for connect; second effect will retry
                await enterRoom(user.id);
            } else if (!wantInRoom && sessionRef.current) {
                await leaveRoom();
            }
        } finally {
            inflightRef.current = false;
        }
    }

    // Debounced status reconciler — flutters get one reconciliation, not many.
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
    }, [profile.status]);

    // On socket reconnect, re-enter if still wantInRoom but session was lost.
    useEffect(() => {
        if (!sw.connected) return;
        const wantInRoom = profile.status === 'available' || profile.status === 'wrap-up' || profile.status === 'on-call';
        if (!wantInRoom) return;
        if (sessionRef.current) return;
        void reconcile(profile.status);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sw.connected, profile.status]);

    return { inRoom, roomError };
}
