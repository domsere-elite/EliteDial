'use client';

import { useEffect, useState } from 'react';
import { useRealtime } from '@/components/RealtimeProvider';
import api from '@/lib/api';

export type ProfileStatus = 'available' | 'break' | 'offline' | 'on-call' | 'wrap-up';

export interface ProfileStatusEvent {
    status: ProfileStatus;
    wrapUpUntil: string | null;
    wrapUpSeconds: number;
}

export interface ProfileStatusState {
    status: ProfileStatus;
    wrapUpUntil: Date | null;
    wrapUpSeconds: number;
}

export function useProfileStatus(initialStatus: ProfileStatus = 'offline'): ProfileStatusState {
    const { on, off, connected } = useRealtime();
    const [status, setStatus] = useState<ProfileStatus>(initialStatus);
    const [wrapUpUntil, setWrapUpUntil] = useState<Date | null>(null);
    const [wrapUpSeconds, setWrapUpSeconds] = useState<number>(0);

    useEffect(() => {
        let cancelled = false;
        api.get('/agents/me/status').then(({ data }) => {
            if (cancelled) return;
            setStatus(data.status as ProfileStatus);
            setWrapUpUntil(data.wrapUpUntil ? new Date(data.wrapUpUntil) : null);
        }).catch(() => { /* fall back to initialStatus; sweep/socket will catch up */ });
        return () => { cancelled = true; };
    }, []);

    // Re-hydrate from REST when the socket connects, so a status change that
    // happened while the socket was disconnected (or before initial connect)
    // gets picked up. This also covers the bug where useSocket.on/off are
    // useCallback([]) refs and silently no-op when subscribed before the
    // socket exists — by re-running the subscription effect on connect, we
    // both rehydrate AND re-subscribe.
    useEffect(() => {
        const handler = (e: ProfileStatusEvent) => {
            setStatus(e.status);
            setWrapUpUntil(e.wrapUpUntil ? new Date(e.wrapUpUntil) : null);
            setWrapUpSeconds(e.wrapUpSeconds);
        };
        on('profile.status', handler);
        // If we just connected (or reconnected), pull fresh state in case
        // we missed events while disconnected.
        if (connected) {
            api.get('/agents/me/status').then(({ data }) => {
                setStatus(data.status as ProfileStatus);
                setWrapUpUntil(data.wrapUpUntil ? new Date(data.wrapUpUntil) : null);
            }).catch(() => { /* non-fatal */ });
        }
        return () => off('profile.status', handler);
    }, [on, off, connected]);

    return { status, wrapUpUntil, wrapUpSeconds };
}
