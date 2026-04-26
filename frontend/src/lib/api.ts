import axios from 'axios';
import { supabase } from './supabase';

const api = axios.create({
    baseURL: '/api',
    headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`;
    }
    return config;
});

api.interceptors.response.use(
    (r) => r,
    async (error) => {
        if (error.response?.status === 401) {
            await supabase.auth.signOut();
            if (typeof window !== 'undefined' && window.location.pathname !== '/') {
                window.location.href = '/';
            }
        }
        return Promise.reject(error);
    },
);

export async function logout(): Promise<void> {
    await supabase.auth.signOut();
    if (typeof window !== 'undefined') {
        window.location.href = '/';
    }
}

export default api;
