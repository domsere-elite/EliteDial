'use client';
import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';

interface User {
    id: string;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    status: string;
}

export function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        try {
            const savedToken = localStorage.getItem('elitedial_token');
            const savedUser = localStorage.getItem('elitedial_user');
            if (savedToken && savedUser) {
                try {
                    const parsedUser = JSON.parse(savedUser);
                    setToken(savedToken);
                    setUser(parsedUser);
                } catch {
                    localStorage.removeItem('elitedial_token');
                    localStorage.removeItem('elitedial_user');
                    setToken(null);
                    setUser(null);
                }
            }
        } finally {
            setLoading(false);
        }
    }, []);

    const login = useCallback(async (username: string, password: string) => {
        const res = await api.post('/auth/login', { username, password });
        const { token: newToken, user: newUser } = res.data;
        localStorage.setItem('elitedial_token', newToken);
        localStorage.setItem('elitedial_user', JSON.stringify(newUser));
        setToken(newToken);
        setUser(newUser);
        return newUser;
    }, []);

    const logout = useCallback(() => {
        localStorage.removeItem('elitedial_token');
        localStorage.removeItem('elitedial_user');
        setToken(null);
        setUser(null);
    }, []);

    const updateStatus = useCallback(async (status: string) => {
        if (!user) return;
        await api.patch(`/agents/${user.id}/status`, { status });
        const updated = { ...user, status };
        setUser(updated);
        localStorage.setItem('elitedial_user', JSON.stringify(updated));
    }, [user]);

    const hasRole = useCallback((minRole: string): boolean => {
        if (!user) return false;
        const hierarchy: Record<string, number> = { agent: 1, supervisor: 2, admin: 3 };
        return (hierarchy[user.role] || 0) >= (hierarchy[minRole] || 0);
    }, [user]);

    return { user, token, loading, login, logout, updateStatus, hasRole };
}
