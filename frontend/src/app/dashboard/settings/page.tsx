'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

interface SettingResponse {
    value: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

const E164 = /^\+[1-9]\d{1,14}$/;

export default function SettingsPage() {
    const { hasRole, loading: authLoading } = useAuth();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [value, setValue] = useState('');
    const [loaded, setLoaded] = useState<SettingResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading) return;
        if (!hasRole('admin')) {
            router.replace('/dashboard');
            return;
        }
        api.get<SettingResponse>('/settings/ai-overflow-number')
            .then((r) => {
                setLoaded(r.data);
                setValue(r.data.value || '');
            })
            .catch(() => setError('Failed to load setting'))
            .finally(() => setLoading(false));
    }, [authLoading, hasRole, router]);

    const dirty = (loaded?.value || '') !== value;

    const handleSave = useCallback(async () => {
        setError(null);
        setSuccess(null);
        if (!E164.test(value)) {
            setError('Must be a valid E.164 phone number (e.g. +12762128412)');
            return;
        }
        setSaving(true);
        try {
            const r = await api.put<SettingResponse>('/settings/ai-overflow-number', { value });
            setLoaded(r.data);
            setSuccess('Saved');
        } catch (e: unknown) {
            const msg =
                (e as { response?: { data?: { error?: string } } })?.response?.data?.error ||
                'Save failed';
            setError(msg);
        } finally {
            setSaving(false);
        }
    }, [value]);

    if (authLoading || loading) {
        return <div className="topline" style={{ padding: '60px', textAlign: 'center' }}>Loading…</div>;
    }

    if (!hasRole('admin')) {
        return <div className="topline" style={{ padding: '60px', textAlign: 'center' }}>Admin access required</div>;
    }

    return (
        <div className="workspace-shell">
            <div className="page-header" style={{ marginBottom: 0 }}>
                <h1>Settings</h1>
                <div className="topline">Tenant-wide configuration for AI Autonomous calling.</div>
            </div>

            <div className="glass-panel" style={{ padding: 20, maxWidth: 640 }}>
                <div className="status-row" style={{ marginBottom: 12 }}>
                    <h3>AI Overflow Number</h3>
                    <span className="topline">Fallback DID for AI Autonomous calls</span>
                </div>

                <label htmlFor="ai-overflow" className="topline" style={{ display: 'block', marginBottom: 6 }}>
                    Phone number (E.164)
                </label>
                <input
                    id="ai-overflow"
                    className="input input-mono"
                    type="text"
                    placeholder="+15551234567"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={saving}
                    style={{ width: '100%' }}
                />
                <div className="topline" style={{ marginTop: 8 }}>
                    Used as the fallback DID when no campaign DID is configured for AI Autonomous calls.
                </div>

                {error && (
                    <div style={{ color: 'var(--accent-red)', marginTop: 12, fontSize: '0.875rem' }}>
                        {error}
                    </div>
                )}
                {success && (
                    <div style={{ color: 'var(--accent-green)', marginTop: 12, fontSize: '0.875rem' }}>
                        {success}
                    </div>
                )}

                <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    {loaded?.updatedAt && (
                        <span className="topline">
                            Last updated {new Date(loaded.updatedAt).toLocaleString()}
                            {loaded.updatedBy ? ` by ${loaded.updatedBy}` : ''}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
