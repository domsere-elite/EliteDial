'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

interface Agent {
    agent_id: string;
    agent_name: string;
    voice_id?: string;
    language?: string;
    response_engine?: { type: string };
    stats: { callsToday: number; totalCalls: number; avgDuration: number };
}

interface AgentDetail {
    agent: Agent;
    recentCalls: Array<{ id: string; toNumber: string; status: string; duration: number; createdAt: string }>;
    transcripts: Array<{ id: string; text: string; summary?: string; createdAt: string }>;
}

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function AIAgentsPage() {
    const { hasRole } = useAuth();
    const router = useRouter();

    const [agents, setAgents] = useState<Agent[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<AgentDetail | null>(null);
    const [launchAgent, setLaunchAgent] = useState<Agent | null>(null);
    const [launchNumber, setLaunchNumber] = useState('');
    const [launchAccountId, setLaunchAccountId] = useState('');
    const [launchStatus, setLaunchStatus] = useState<'idle' | 'launching' | 'success' | 'error'>('idle');
    const [stats, setStats] = useState<{ aiCalls: number; aiCompleted: number; aiAvgDuration: number } | null>(null);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const [agentsRes, statsRes] = await Promise.all([
                api.get('/ai-agents'),
                api.get('/reports/summary'),
            ]);
            setAgents(agentsRes.data);
            setStats(statsRes.data);
        } catch {
            // no-op
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const loadAgentDetail = async (agent: Agent) => {
        if (selectedAgent?.agent.agent_id === agent.agent_id) {
            setSelectedAgent(null);
            return;
        }
        try {
            const res = await api.get(`/ai-agents/${agent.agent_id}`);
            setSelectedAgent(res.data);
        } catch {
            setSelectedAgent(null);
        }
    };

    const openLaunchModal = (agent: Agent) => {
        setLaunchAgent(agent);
        setLaunchNumber('');
        setLaunchAccountId('');
        setLaunchStatus('idle');
    };

    const submitLaunch = async () => {
        if (!launchAgent || !launchNumber.trim()) return;
        setLaunchStatus('launching');
        try {
            await api.post(`/ai-agents/${launchAgent.agent_id}/launch`, {
                toNumber: launchNumber.trim(),
                accountId: launchAccountId.trim() || undefined,
            });
            setLaunchStatus('success');
            setTimeout(() => setLaunchAgent(null), 2000);
        } catch {
            setLaunchStatus('error');
        }
    };

    if (!hasRole('supervisor')) {
        return <div className="topline" style={{ padding: 60, textAlign: 'center' }}>Insufficient permissions</div>;
    }

    return (
        <div className="workspace-shell">
            {/* Header */}
            <div className="page-header">
                <div>
                    <h1>AI Voice Agents</h1>
                    <div className="topline">View agents, monitor performance, and launch AI outbound calls.</div>
                </div>
            </div>

            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                <div className="stat-card">
                    <div className="stat-value">{stats?.aiCalls ?? '—'}</div>
                    <div className="stat-label">AI Calls Today</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{stats?.aiCompleted ?? '—'}</div>
                    <div className="stat-label">AI Completed</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{stats ? fmtDuration(stats.aiAvgDuration) : '—'}</div>
                    <div className="stat-label">Avg Duration</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{agents.length}</div>
                    <div className="stat-label">Agents</div>
                </div>
            </div>

            {/* Agent Grid */}
            {loading ? (
                <div className="glass-panel" style={{ padding: 40, textAlign: 'center' }}>
                    <span className="topline">Loading agents...</span>
                </div>
            ) : agents.length === 0 ? (
                <div className="glass-panel" style={{ padding: 40, textAlign: 'center' }}>
                    <span className="topline">No AI agents configured.</span>
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
                    {agents.map((agent) => (
                        <div
                            key={agent.agent_id}
                            className="glass-panel"
                            style={{ padding: 20, cursor: 'pointer' }}
                            onClick={() => void loadAgentDetail(agent)}
                        >
                            <div style={{ fontFamily: 'var(--font-headline)', fontSize: '1.2rem', fontWeight: 800 }}>
                                {agent.agent_name}
                            </div>
                            <div className="topline" style={{ marginTop: 4 }}>
                                {agent.voice_id && <span className="mono">{agent.voice_id}</span>}
                                {agent.voice_id && agent.language && ' · '}
                                {agent.language}
                            </div>
                            <div style={{ marginTop: 10 }}>
                                <span className="status-badge status-available">Active</span>
                            </div>
                            <div className="topline" style={{ marginTop: 10 }}>
                                {agent.stats.callsToday} calls today | Avg {fmtDuration(agent.stats.avgDuration)}
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 14 }} onClick={(e) => e.stopPropagation()}>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => router.push('/dashboard/reports?channel=ai')}
                                >
                                    View Calls
                                </button>
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={() => openLaunchModal(agent)}
                                >
                                    Launch Outbound
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Selected Agent Detail */}
            {selectedAgent && (
                <div className="glass-panel" style={{ padding: 20 }}>
                    <div className="panel-heading">
                        <h3 style={{ fontFamily: 'var(--font-headline)', fontWeight: 800 }}>{selectedAgent.agent.agent_name}</h3>
                        <button className="btn btn-secondary btn-sm" onClick={() => setSelectedAgent(null)}>Close</button>
                    </div>
                    <div className="status-row" style={{ marginTop: 8 }}>
                        <span className="topline">
                            Voice: {selectedAgent.agent.voice_id || '—'} · Language: {selectedAgent.agent.language || '—'} · Engine: {selectedAgent.agent.response_engine?.type || '—'}
                        </span>
                    </div>

                    {selectedAgent.recentCalls.length > 0 && (
                        <div style={{ marginTop: 16 }}>
                            <h4 style={{ fontFamily: 'var(--font-headline)', fontWeight: 700, marginBottom: 8 }}>Recent Calls</h4>
                            <div style={{ overflow: 'auto' }}>
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th>To Number</th>
                                            <th>Status</th>
                                            <th>Duration</th>
                                            <th>Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedAgent.recentCalls.map((call) => (
                                            <tr key={call.id}>
                                                <td className="mono">{call.toNumber}</td>
                                                <td>
                                                    <span className={`status-badge ${call.status === 'completed' ? 'status-available' : 'status-offline'}`}>
                                                        {call.status}
                                                    </span>
                                                </td>
                                                <td className="mono">{fmtDuration(call.duration)}</td>
                                                <td className="mono topline">{fmtDate(call.createdAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {selectedAgent.transcripts.length > 0 && (
                        <div style={{ marginTop: 16 }}>
                            <h4 style={{ fontFamily: 'var(--font-headline)', fontWeight: 700, marginBottom: 8 }}>Recent Transcripts</h4>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {selectedAgent.transcripts.map((t) => (
                                    <div key={t.id} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-elevated)' }}>
                                        <div className="mono topline" style={{ marginBottom: 4 }}>{fmtDate(t.createdAt)}</div>
                                        <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>{t.text}</div>
                                        {t.summary && <div className="topline" style={{ marginTop: 4 }}>{t.summary}</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Launch Outbound Modal */}
            {launchAgent && (
                <div className="modal-overlay" onClick={() => setLaunchAgent(null)}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h2>Launch AI Outbound — {launchAgent.agent_name}</h2>

                        {launchStatus === 'success' ? (
                            <div className="notice notice-info">Call launched successfully.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                                <div>
                                    <label>Phone Number *</label>
                                    <input
                                        className="input"
                                        placeholder="+15551234567"
                                        value={launchNumber}
                                        onChange={(e) => setLaunchNumber(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label>Account ID (optional)</label>
                                    <input
                                        className="input"
                                        placeholder="Account ID"
                                        value={launchAccountId}
                                        onChange={(e) => setLaunchAccountId(e.target.value)}
                                    />
                                </div>
                                {launchStatus === 'error' && (
                                    <div className="notice notice-info" style={{ color: '#ef4444' }}>Failed to launch call. Please try again.</div>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                                    <button className="btn btn-secondary" onClick={() => setLaunchAgent(null)}>Cancel</button>
                                    <button
                                        className="btn btn-primary"
                                        disabled={!launchNumber.trim() || launchStatus === 'launching'}
                                        onClick={() => void submitLaunch()}
                                    >
                                        {launchStatus === 'launching' ? 'Launching...' : 'Launch Call'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
