'use client';

import { useEffect, useState } from 'react';
import { DialMode, DIAL_MODE_OPTIONS } from '@/lib/dialMode';
import { fetchRetellAgents, RetellAgent } from '@/lib/retellAgents';

export type VoicemailBehavior = 'hangup' | 'leave_message';

export interface CampaignFormValues {
    name: string;
    description: string;
    dialMode: DialMode;
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
    dialRatio: number;
    voicemailBehavior: VoicemailBehavior;
    voicemailMessage: string;
    retellAgentId: string | null;
    retellSipAddress: string | null;
}

const DEFAULT_VALUES: CampaignFormValues = {
    name: '',
    description: '',
    dialMode: 'manual',
    timezone: 'America/Chicago',
    maxConcurrentCalls: 0,
    maxAttemptsPerLead: 6,
    retryDelaySeconds: 600,
    dialRatio: 1.0,
    voicemailBehavior: 'hangup',
    voicemailMessage: '',
    retellAgentId: null,
    retellSipAddress: null,
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
    const [agents, setAgents] = useState<RetellAgent[] | null>(null);
    const [agentsLoading, setAgentsLoading] = useState(false);
    const [agentsError, setAgentsError] = useState<string | null>(null);

    useEffect(() => {
        if (values.dialMode !== 'ai_autonomous') return;
        if (agents !== null || agentsLoading) return;
        setAgentsLoading(true);
        fetchRetellAgents()
            .then(list => {
                setAgents(list);
                setAgentsError(null);
            })
            .catch((err: any) => {
                setAgentsError(err?.response?.data?.error || 'Failed to load Retell agents');
            })
            .finally(() => setAgentsLoading(false));
    }, [values.dialMode, agents, agentsLoading]);

    const set = <K extends keyof CampaignFormValues>(key: K, value: CampaignFormValues[K]) => {
        setValues(prev => ({ ...prev, [key]: value }));
        setFieldErrors(prev => ({ ...prev, [key]: '' }));
    };

    const validate = (): boolean => {
        const errs: Record<string, string> = {};
        if (!values.name.trim()) errs.name = 'Name is required';
        if (values.maxAttemptsPerLead < 1 || values.maxAttemptsPerLead > 20) errs.maxAttemptsPerLead = 'Must be between 1 and 20';
        if (values.maxConcurrentCalls < 0) errs.maxConcurrentCalls = 'Cannot be negative';
        if (values.dialMode === 'progressive' && (values.dialRatio < 1.0 || values.dialRatio > 5.0)) {
            errs.dialRatio = 'Must be between 1.0 and 5.0';
        }
        if (values.voicemailBehavior === 'leave_message' && !values.voicemailMessage.trim()) {
            errs.voicemailMessage = 'Required when leaving a voicemail';
        }
        if (values.dialMode === 'ai_autonomous' && !values.retellAgentId) {
            errs.retellAgentId = 'Pick a Retell agent';
        }
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
                            <select className="select" value={values.dialMode} onChange={e => set('dialMode', e.target.value as DialMode)}>
                                {DIAL_MODE_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
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

            {/* CONCURRENCY — only meaningful outside Manual mode */}
            {values.dialMode !== 'manual' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>Concurrency</div>
                    <div>
                        <label>Max Concurrent Calls</label>
                        <input type="number" className="input" min={0} value={values.maxConcurrentCalls}
                               onChange={e => set('maxConcurrentCalls', parseInt(e.target.value, 10) || 0)} />
                        <div style={{ fontSize: '0.714rem', color: 'var(--text-muted)', marginTop: 3 }}>
                            {values.dialMode === 'ai_autonomous'
                                ? 'Number of concurrent outbound AI calls.'
                                : 'Caps agent-paced dialing (0 = use available agents).'}
                        </div>
                        {fieldErrors.maxConcurrentCalls && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.maxConcurrentCalls}</div>}
                    </div>

                    {values.dialMode === 'progressive' && (
                        <div style={{ marginTop: 14 }}>
                            <label>
                                Dial Ratio: <strong>{values.dialRatio.toFixed(1)}x per agent</strong>
                                {values.dialRatio === 1.0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (1:1, no power dialing)</span>}
                            </label>
                            <input
                                type="range"
                                min={1.0}
                                max={5.0}
                                step={0.5}
                                value={values.dialRatio}
                                onChange={e => set('dialRatio', parseFloat(e.target.value))}
                                style={{ width: '100%' }}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.714rem', color: 'var(--text-muted)' }}>
                                <span>1.0x</span><span>2.5x</span><span>5.0x</span>
                            </div>
                            <div style={{ fontSize: '0.714rem', color: 'var(--text-muted)', marginTop: 6 }}>
                                Number of simultaneous outbound calls placed per available agent. Higher ratios connect agents to more live answers per hour but require power-dial routing (Phase 2 — coming soon). Setting above 1.0x updates dispatch capacity now and will activate multi-leg dialing once the worker ships.
                            </div>
                            {fieldErrors.dialRatio && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.dialRatio}</div>}
                        </div>
                    )}
                </div>
            )}

            {/* VOICEMAIL HANDLING — progressive only (ai_autonomous lets the AI handle VM) */}
            {values.dialMode === 'progressive' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>Voicemail Handling</div>
                    <div>
                        <label>When a machine is detected</label>
                        <select
                            className="select"
                            value={values.voicemailBehavior}
                            onChange={e => set('voicemailBehavior', e.target.value as VoicemailBehavior)}
                        >
                            <option value="hangup">Hang up silently (default)</option>
                            <option value="leave_message">Leave a voicemail message</option>
                        </select>
                        <div style={{ fontSize: '0.714rem', color: 'var(--text-muted)', marginTop: 3 }}>
                            Applied to power-dial legs that reach voicemail. AI Autonomous campaigns let the Retell agent handle voicemail directly.
                        </div>
                    </div>
                    {values.voicemailBehavior === 'leave_message' && (
                        <div style={{ marginTop: 10 }}>
                            <label>Voicemail Message</label>
                            <textarea
                                className="input"
                                rows={3}
                                maxLength={500}
                                placeholder="Hi, this is — please call us back at ..."
                                value={values.voicemailMessage}
                                onChange={e => set('voicemailMessage', e.target.value)}
                            />
                            {fieldErrors.voicemailMessage && <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>{fieldErrors.voicemailMessage}</div>}
                        </div>
                    )}
                </div>
            )}

            {/* AI AGENT — only when dialMode is ai_autonomous */}
            {values.dialMode === 'ai_autonomous' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>AI Agent</div>
                    {agentsLoading && (
                        <div style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>Loading agents from Retell…</div>
                    )}
                    {agentsError && (
                        <div className="notice notice-error" style={{ fontSize: '0.786rem' }}>
                            {agentsError}
                        </div>
                    )}
                    {agents && agents.length === 0 && (
                        <div className="notice notice-error" style={{ fontSize: '0.786rem' }}>
                            No agents found in your Retell account. Create one in the Retell dashboard, then reload this page.
                        </div>
                    )}
                    {agents && agents.length > 0 && (
                        <>
                            <label>Retell Agent</label>
                            <select
                                className="select"
                                value={values.retellAgentId ?? ''}
                                onChange={e => {
                                    const id = e.target.value || null;
                                    const sip = id ? (agents.find(a => a.id === id)?.sipAddress ?? null) : null;
                                    setValues(prev => ({ ...prev, retellAgentId: id, retellSipAddress: sip }));
                                    setFieldErrors(prev => ({ ...prev, retellAgentId: '' }));
                                }}
                            >
                                <option value="">— Select an agent —</option>
                                {agents.map(a => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            {values.retellAgentId && !agents.find(a => a.id === values.retellAgentId) && (
                                <div className="notice notice-error" style={{ fontSize: '0.786rem', marginTop: 6 }}>
                                    Previously assigned agent <code>{values.retellAgentId}</code> was not found in your Retell account. Pick a new one.
                                </div>
                            )}
                            {fieldErrors.retellAgentId && (
                                <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>
                                    {fieldErrors.retellAgentId}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

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
