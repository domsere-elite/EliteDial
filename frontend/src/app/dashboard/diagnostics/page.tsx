'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

interface DiagnosticSummary {
    activeSignalWireSessions: number;
    signalwireCalls24h: number;
    inbound24h: number;
    outbound24h: number;
    completed24h: number;
    webhookEvents24h: number;
}

interface DiagnosticAgent {
    id: string;
    name: string;
    status: string;
    endpointReference: string;
    usingFallbackId: boolean;
}

interface DiagnosticCall {
    id: string;
    providerCallId: string | null;
    direction: string;
    status: string;
    mode: string;
    fromNumber: string;
    toNumber: string;
    createdAt: string;
    completedAt: string | null;
    duration: number;
    accountId: string | null;
    agent: { name: string; username: string; extension: string | null } | null;
}

interface DiagnosticEvent {
    id: string;
    createdAt: string;
    type: string;
    source: string;
    status: string | null;
    providerCallId: string | null;
    callId: string | null;
    details: Record<string, unknown> | null;
}

interface DiagnosticVoicemail {
    id: string;
    fromNumber: string;
    toNumber: string;
    duration: number;
    audioUrl: string | null;
    transcription: string | null;
    createdAt: string;
}

interface DiagnosticsResponse {
    summary: DiagnosticSummary;
    agents: DiagnosticAgent[];
    recentCalls: DiagnosticCall[];
    recentEvents: DiagnosticEvent[];
    recentVoicemails: DiagnosticVoicemail[];
}

export default function DiagnosticsPage() {
    const { hasRole } = useAuth();
    const [data, setData] = useState<DiagnosticsResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const loadDiagnostics = useCallback(async () => {
        setLoading(true);
        try {
            const response = await api.get('/system/signalwire/diagnostics');
            setData(response.data);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!hasRole('supervisor')) return;
        void loadDiagnostics();
        const interval = setInterval(() => {
            void loadDiagnostics();
        }, 10000);
        return () => clearInterval(interval);
    }, [hasRole, loadDiagnostics]);

    if (!hasRole('supervisor')) {
        return (
            <div className="workspace-shell">
                <div className="page-header">
                    <h1>Diagnostics</h1>
                </div>
                <div className="notice notice-error">Supervisor or admin access required.</div>
            </div>
        );
    }

    return (
        <div className="workspace-shell">
            <div className="page-header">
                <div>
                    <h1>Diagnostics</h1>
                    <div className="topline">SignalWire call activity, webhook flow, voicemail callbacks, and agent endpoint routing.</div>
                </div>
                <button className="btn btn-secondary" onClick={() => loadDiagnostics()} disabled={loading}>Refresh</button>
            </div>

            {loading || !data ? (
                <div className="glass-panel" style={{ padding: 24 }}>
                    <div className="topline">Loading diagnostics...</div>
                </div>
            ) : (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(120px, 1fr))', gap: 10 }}>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.activeSignalWireSessions}</div><div className="stat-label">Active Sessions</div></div>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.signalwireCalls24h}</div><div className="stat-label">Calls 24h</div></div>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.inbound24h}</div><div className="stat-label">Inbound 24h</div></div>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.outbound24h}</div><div className="stat-label">Outbound 24h</div></div>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.completed24h}</div><div className="stat-label">Completed 24h</div></div>
                        <div className="stat-card"><div className="stat-value mono">{data.summary.webhookEvents24h}</div><div className="stat-label">Webhook Events</div></div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 12 }}>
                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Recent SignalWire Calls</h3>
                                <span className="topline mono">{data.recentCalls.length} rows</span>
                            </div>
                            <table className="data-table">
                                <thead>
                                    <tr><th>Time</th><th>Direction</th><th>Status</th><th>Provider SID</th><th>Agent</th></tr>
                                </thead>
                                <tbody>
                                    {data.recentCalls.map((call) => (
                                        <tr key={call.id}>
                                            <td className="mono">{new Date(call.createdAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                                            <td className="mono">{call.direction}</td>
                                            <td><span className={`status-badge ${call.status === 'completed' ? 'status-available' : call.status === 'in-progress' ? 'status-on-call' : call.status === 'ringing' ? 'status-break' : 'status-offline'}`}>{call.status}</span></td>
                                            <td className="mono">{call.providerCallId || '-'}</td>
                                            <td>{call.agent?.name || '-'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Agent Endpoint Routing</h3>
                                <span className="topline mono">{data.agents.length} users</span>
                            </div>
                            <table className="data-table">
                                <thead>
                                    <tr><th>Agent</th><th>Status</th><th>Endpoint</th></tr>
                                </thead>
                                <tbody>
                                    {data.agents.map((agent) => (
                                        <tr key={agent.id}>
                                            <td>{agent.name}</td>
                                            <td className="mono">{agent.status}</td>
                                            <td className="mono">{agent.endpointReference}{agent.usingFallbackId ? ' (fallback)' : ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="glass-panel" style={{ padding: 18 }}>
                        <div className="status-row" style={{ marginBottom: 10 }}>
                            <h3>Webhook Event Stream</h3>
                            <span className="topline mono">{data.recentEvents.length} recent events</span>
                        </div>
                        <table className="data-table">
                            <thead>
                                <tr><th>Time</th><th>Source</th><th>Type</th><th>Status</th><th>Details</th></tr>
                            </thead>
                            <tbody>
                                {data.recentEvents.map((event) => (
                                    <tr key={event.id}>
                                        <td className="mono">{new Date(event.createdAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                                        <td className="mono">{event.source}</td>
                                        <td className="mono">{event.type}</td>
                                        <td className="mono">{event.status || '-'}</td>
                                        <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {event.details ? Object.entries(event.details).map(([key, value]) => `${key}:${String(value)}`).join(' | ') : (event.providerCallId || event.callId || '-')}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="glass-panel" style={{ padding: 18 }}>
                        <div className="status-row" style={{ marginBottom: 10 }}>
                            <h3>Recent Voicemails</h3>
                            <span className="topline mono">{data.recentVoicemails.length} recent entries</span>
                        </div>
                        <table className="data-table">
                            <thead>
                                <tr><th>Time</th><th>From</th><th>To</th><th>Duration</th><th>Transcript</th></tr>
                            </thead>
                            <tbody>
                                {data.recentVoicemails.map((voicemail) => (
                                    <tr key={voicemail.id}>
                                        <td className="mono">{new Date(voicemail.createdAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                                        <td className="mono">{voicemail.fromNumber}</td>
                                        <td className="mono">{voicemail.toNumber}</td>
                                        <td className="mono">{voicemail.duration}s</td>
                                        <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {voicemail.transcription || voicemail.audioUrl || '-'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
