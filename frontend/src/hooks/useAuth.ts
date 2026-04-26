'use client';
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import api, { logout as apiLogout } from '@/lib/api';

interface User {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    status: string;
    extension?: string | null;
}

export function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        const hydrate = async (sessionToken: string | null) => {
            if (!sessionToken) {
                if (mounted) { setUser(null); setToken(null); }
                return;
            }
            if (mounted) setToken(sessionToken);
            try {
                const res = await api.get('/auth/me');
                if (mounted) setUser(res.data);
            } catch {
                if (mounted) { setUser(null); setToken(null); }
            }
        };

        supabase.auth.getSession()
            .then(({ data: { session } }) => hydrate(session?.access_token ?? null))
            .finally(() => { if (mounted) setLoading(false); });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            hydrate(session?.access_token ?? null);
        });

        return () => { mounted = false; subscription.unsubscribe(); };
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // useEffect's onAuthStateChange picks up the new session and hydrates user state.
    }, []);

    const logout = useCallback(async () => {
        setToken(null);
        setUser(null);
        await apiLogout();
    }, []);

    const updateStatus = useCallback(async (status: string) => {
        if (!user) return;
        await api.patch(`/agents/${user.id}/status`, { status });
        setUser({ ...user, status });
    }, [user]);

    const hasRole = useCallback((minRole: string): boolean => {
        if (!user) return false;
        const hierarchy: Record<string, number> = { agent: 1, supervisor: 2, admin: 3 };
        return (hierarchy[user.role] || 0) >= (hierarchy[minRole] || 0);
    }, [user]);

    return { user, token, loading, login, logout, updateStatus, hasRole };
}
