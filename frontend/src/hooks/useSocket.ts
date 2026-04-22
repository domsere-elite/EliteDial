'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io as ioClient, Socket } from 'socket.io-client';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

/**
 * React hook that manages a Socket.IO connection authenticated via JWT.
 *
 * - Reads the token from localStorage (key: "token")
 * - Reconnects whenever the token changes
 * - Disconnects on unmount
 */
export function useSocket() {
    const [connected, setConnected] = useState(false);
    const socketRef = useRef<Socket | null>(null);
    const tokenRef = useRef<string | null>(null);

    // Build / rebuild the socket connection
    useEffect(() => {
        const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

        // If there is no token, ensure we are disconnected
        if (!token) {
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
            }
            setConnected(false);
            return;
        }

        // If the token hasn't changed and we already have a socket, skip
        if (token === tokenRef.current && socketRef.current) {
            return;
        }

        // Tear down previous connection
        if (socketRef.current) {
            socketRef.current.disconnect();
        }

        tokenRef.current = token;

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

        return () => {
            socket.disconnect();
            socketRef.current = null;
            setConnected(false);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Subscribe to a socket event. Wrapper around socket.on().
     */
    const on = useCallback((event: string, handler: (...args: any[]) => void) => {
        socketRef.current?.on(event, handler);
    }, []);

    /**
     * Unsubscribe from a socket event. Wrapper around socket.off().
     */
    const off = useCallback((event: string, handler: (...args: any[]) => void) => {
        socketRef.current?.off(event, handler);
    }, []);

    return {
        socket: socketRef.current,
        connected,
        on,
        off,
    };
}
