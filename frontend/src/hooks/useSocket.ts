'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io as ioClient, Socket } from 'socket.io-client';
import { supabase } from '@/lib/supabase';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

/**
 * React hook that manages a Socket.IO connection authenticated via the current
 * Supabase access token. Reconnects on token refresh; disconnects on unmount.
 */
export function useSocket() {
    const [connected, setConnected] = useState(false);
    const socketRef = useRef<Socket | null>(null);

    const connectWith = useCallback((token: string) => {
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }
        const socket = ioClient(BACKEND_URL, {
            auth: { token },
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
        });
        socket.on('connect', () => setConnected(true));
        socket.on('disconnect', () => setConnected(false));
        socket.on('connect_error', () => setConnected(false));
        socketRef.current = socket;
    }, []);

    useEffect(() => {
        let cancelled = false;

        supabase.auth.getSession().then(({ data: { session } }) => {
            if (cancelled) return;
            if (session?.access_token) {
                connectWith(session.access_token);
            }
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || !session) {
                if (socketRef.current) {
                    socketRef.current.disconnect();
                    socketRef.current = null;
                    setConnected(false);
                }
                return;
            }
            // SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED — reconnect with the latest token.
            connectWith(session.access_token);
        });

        return () => {
            cancelled = true;
            subscription.unsubscribe();
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
            }
            setConnected(false);
        };
    }, [connectWith]);

    const on = useCallback((event: string, handler: (...args: unknown[]) => void) => {
        socketRef.current?.on(event, handler);
    }, []);

    const off = useCallback((event: string, handler: (...args: unknown[]) => void) => {
        socketRef.current?.off(event, handler);
    }, []);

    return {
        socket: socketRef.current,
        connected,
        on,
        off,
    };
}
