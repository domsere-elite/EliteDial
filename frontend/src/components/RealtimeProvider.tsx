'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import { useSocket } from '../hooks/useSocket';
import type { Socket } from 'socket.io-client';

interface RealtimeContextValue {
    socket: Socket | null;
    connected: boolean;
    on: (event: string, handler: (...args: any[]) => void) => void;
    off: (event: string, handler: (...args: any[]) => void) => void;
}

const RealtimeContext = createContext<RealtimeContextValue>({
    socket: null,
    connected: false,
    on: () => {},
    off: () => {},
});

interface RealtimeProviderProps {
    children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
    const { socket, connected, on, off } = useSocket();

    return (
        <RealtimeContext.Provider value={{ socket, connected, on, off }}>
            {children}
        </RealtimeContext.Provider>
    );
}

/**
 * Access the realtime socket context.
 * Must be used within a <RealtimeProvider>.
 */
export function useRealtime(): RealtimeContextValue {
    const context = useContext(RealtimeContext);
    if (context === undefined) {
        throw new Error('useRealtime must be used within a RealtimeProvider');
    }
    return context;
}
