'use client';

import { useState } from 'react';

export interface CampaignFormValues {
    name: string;
    description: string;
    dialMode: 'manual' | 'progressive' | 'ai_autonomous';
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
}

const DEFAULT_VALUES: CampaignFormValues = {
    name: '',
    description: '',
    dialMode: 'manual',
    timezone: 'America/Chicago',
    maxConcurrentCalls: 0,
    maxAttemptsPerLead: 6,
    retryDelaySeconds: 600,
};

const RETRY_PRESETS: Array<{ label: string; seconds: number }> = [
    { label: '5 minutes', seconds: 300 },
    { label: '10 minutes', seconds: 600 },
    { label: '30 minutes', seconds: 1800 },
    { label: '1 hour', seconds: 3600 },
    { label: '2 hours', seconds: 7200 },
];

interface Props {
    initialValues?: Partial<CampaignFormValues>;
    mode: 'create' | 'edit';
    submitting: boolean;
    error: string | null;
    onSubmit: (values: CampaignFormValues) => void;
    onCancel: () => void;
}

export function CampaignForm({ initialValues, mode, submitting, error, onSubmit, onCancel }: Props) {
    const [values, setValues] = useState<CampaignFormValues>({ ...DEFAULT_VALUES, ...initialValues });
    const [useCustomRetry, setUseCustomRetry] = useState(() => {
        const s = initialValues?.retryDelaySeconds ?? DEFAULT_VALUES.retryDelaySeconds;
        return !RETRY_PRESETS.some(p => p.seconds === s);
    });
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const set = <K extends keyof CampaignFormValues>(key: K, value: CampaignFormValues[K]) => {
        setValues(prev => ({ ...prev, [key]: value }));
        setFieldErrors(prev => ({ ...prev, [key]: '' }));
    };

    const validate = (): boolean => {
        const errs: Record<string, string> = {};
        if (!values.name.trim()) errs.name = 'Name is required';
        if (values.maxAttemptsPerLead < 1 || values.maxAttemptsPerLead > 20) errs.maxAttemptsPerLead = 'Must be between 1 and 20';
        if (values.maxConcurrentCalls < 0) errs.maxConcurrentCalls = 'Cannot be negative';
        setFieldErrors(errs);
        return Object.keys(errs).length === 0;
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!validate()) return;
        onSubmit(values);
    };

    return (
        <form onSubmit={handleSubmit} style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {error && <div className="notice notice-error">{error}</div>}

            {/* BASICS */}
            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Basics</div>
                <div style={{ display: 'grid', gap: 10 }}>
                    <div>
                        <label>Name</label>
                        <input className="input" value={values.name} onChange={e => set('name', e.target.value)} maxLength={100} />
                        {fieldErrors.name && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.name}</div>}
                    </div>
                    <div>
                        <label>Description</label>
                        <textarea className="input" rows={3} value={values.description} onChange={e => set('description', e.target.value)} maxLength={500} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                            <label>Dial Mode</label>
                            <select className="select" value={values.dialMode} onChange={e => set('dialMode', e.target.value as CampaignFormValues['dialMode'])}>
                                <option value="manual">Manual</option>
                                <option value="progressive">Progressive (1 per available agent)</option>
                                <option value="ai_autonomous">AI Autonomous (no agents, auto-bridge to AI)</option>
                            </select>
                        </div>
                        <div>
                            <label>Timezone</label>
                            <select className="select" value={values.timezone} onChange={e => set('timezone', e.target.value)}>
                                <option value="America/New_York">Eastern (America/New_York)</option>
                                <option value="America/Chicago">Central (America/Chicago)</option>
                                <option value="America/Denver">Mountain (America/Denver)</option>
                                <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            {/* CONCURRENCY */}
            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Concurrency</div>
                <div>
                    <label>Max Concurrent Calls</label>
                    <input type="number" className="input" min={0} value={values.maxConcurrentCalls}
                           onChange={e => set('maxConcurrentCalls', parseInt(e.target.value, 10) || 0)} />
                    <div style={{ fontSize: '0.714rem', color: 'var(--text-muted)', marginTop: 3 }}>
                        For AI Autonomous: the number of concurrent outbound calls. For Progressive: caps agent-paced dialing (0 = use available agents).
                    </div>
                    {fieldErrors.maxConcurrentCalls && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.maxConcurrentCalls}</div>}
                </div>
            </div>

            {/* RETRY */}
            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Retry Strategy</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                        <label>Max Attempts Per Lead</label>
                        <input type="number" className="input" min={1} max={20} value={values.maxAttemptsPerLead}
                               onChange={e => set('maxAttemptsPerLead', parseInt(e.target.value, 10) || 1)} />
                        {fieldErrors.maxAttemptsPerLead && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.maxAttemptsPerLead}</div>}
                    </div>
                    <div>
                        <label>Retry Delay</label>
                        <select className="select"
                                value={useCustomRetry ? 'custom' : String(values.retryDelaySeconds)}
                                onChange={e => {
                                    if (e.target.value === 'custom') {
                                        setUseCustomRetry(true);
                                    } else {
                                        setUseCustomRetry(false);
                                        set('retryDelaySeconds', parseInt(e.target.value, 10));
                                    }
                                }}>
                            {RETRY_PRESETS.map(p => <option key={p.seconds} value={p.seconds}>{p.label}</option>)}
                            <option value="custom">Custom</option>
                        </select>
                        {useCustomRetry && (
                            <input type="number" className="input" min={30} value={values.retryDelaySeconds}
                                   style={{ marginTop: 6 }}
                                   onChange={e => set('retryDelaySeconds', Math.max(30, parseInt(e.target.value, 10) || 30))} />
                        )}
                    </div>
                </div>
            </div>

            {/* ACTIONS */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting || !values.name.trim()}>
                    {submitting ? 'Saving...' : mode === 'create' ? 'Create Campaign' : 'Save Changes'}
                </button>
            </div>
        </form>
    );
}
