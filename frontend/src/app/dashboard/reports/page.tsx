'use client';

import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend, CartesianGrid } from 'recharts';
import CallRecordingPlayer from '@/components/CallRecordingPlayer';

interface CallRecord {
    id: string;
    direction: string;
    fromNumber: string;
    toNumber: string;
    status: string;
    duration: number;
    accountName: string;
    accountId: string;
    dispositionId: string | null;
    createdAt: string;
    recordingUrl?: string | null;
    agent?: { firstName: string; lastName: string; username: string };
}

interface AgentStat {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    status: string;
    totalCalls: number;
    answeredCalls: number;
    answerRate: string;
    avgDuration: number;
}

interface SummaryStats {
    totalCalls: number;
    outbound: number;
    inbound: number;
    completed: number;
    noAnswer: number;
    busy: number;
    failed: number;
    voicemail: number;
    abandonedEvents: number;
    guardrailBlocks: number;
    aiCalls: number;
    aiCompleted: number;
    aiAvgDuration: number;
    answerRate: string;
    abandonRate: string;
    avgDuration: number;
    dispositions: Array<{ dispositionId: string | null; _count: number }>;
}

interface HourlyStat {
    hour: number;
    total: number;
    inbound: number;
    outbound: number;
    answered: number;
    abandoned: number;
    blocked: number;
}

export default function ReportsPage() {
    const { hasRole } = useAuth();
    const [tab, setTab] = useState<'overview' | 'agents' | 'calllog' | 'ai'>('overview');
    const [summary, setSummary] = useState<SummaryStats | null>(null);
    const [hourly, setHourly] = useState<HourlyStat[]>([]);
    const [agentStats, setAgentStats] = useState<AgentStat[]>([]);
    const [callLog, setCallLog] = useState<CallRecord[]>([]);
    const [callLogTotal, setCallLogTotal] = useState(0);
    const [logPage, setLogPage] = useState(1);
    const [expandedCallId, setExpandedCallId] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        try {
            const [summaryRes, hourlyRes, agentsRes, logRes] = await Promise.all([
                api.get('/reports/summary'),
                api.get('/reports/hourly'),
                api.get('/reports/agents'),
                api.get(`/calls?limit=20&page=${logPage}`),
            ]);
            setSummary(summaryRes.data);
            setHourly(hourlyRes.data);
            setAgentStats(agentsRes.data);
            setCallLog(logRes.data.calls || []);
            setCallLogTotal(logRes.data.total || 0);
        } catch {
            // no-op
        }
    }, [logPage]);

    useEffect(() => { loadData(); }, [loadData]);

    if (!hasRole('supervisor')) {
        return <div className="topline" style={{ padding: '60px', textAlign: 'center' }}>Insufficient permissions</div>;
    }

    const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const formatTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const maxHourlyTotal = Math.max(...(hourly.map((h) => Math.max(h.total, h.abandoned, h.blocked)) || [1]), 1);

    return (
        <div className="workspace-shell">
            <div className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <h1>Reporting</h1>
                    <div className="topline">Performance visibility across volume, outcomes, and agent execution.</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className={`btn ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('overview')}>Overview</button>
                    <button className={`btn ${tab === 'agents' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('agents')}>Agents</button>
                    <button className={`btn ${tab === 'calllog' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('calllog')}>Call Log</button>
                    <button className={`btn ${tab === 'ai' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('ai')}>AI Performance</button>
                </div>
            </div>

            {tab === 'overview' && summary && (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                        <div className="stat-card"><div className="stat-value">{summary.totalCalls}</div><div className="stat-label">Total Calls</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.outbound}</div><div className="stat-label">Outbound</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.inbound}</div><div className="stat-label">Inbound</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.answerRate}%</div><div className="stat-label">Answer Rate</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.abandonRate}%</div><div className="stat-label">Abandon Rate</div></div>
                        <div className="stat-card"><div className="stat-value">{formatDuration(summary.avgDuration)}</div><div className="stat-label">Avg Duration</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.completed}</div><div className="stat-label">Completed</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.abandonedEvents}</div><div className="stat-label">Missed Connects</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.aiCalls ?? 0}</div><div className="stat-label">AI Calls</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.noAnswer}</div><div className="stat-label">No Answer</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.failed + summary.busy + summary.voicemail}</div><div className="stat-label">Other Outcomes</div></div>
                    </div>

                    <div className="glass-panel" style={{ padding: 20 }}>
                        <div className="status-row" style={{ marginBottom: 12 }}>
                            <h3>Call Volume by Hour</h3>
                            <span className="topline">24h distribution</span>
                        </div>
                        <div style={{ height: 260, width: '100%' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={hourly} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                                    <XAxis dataKey="hour" stroke="#687076" tick={{ fill: '#687076', fontSize: 12 }} tickFormatter={(h) => `${h}:00`} />
                                    <YAxis stroke="#687076" tick={{ fill: '#687076', fontSize: 12 }} />
                                    <Tooltip 
                                        contentStyle={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-color)', borderRadius: '6px' }}
                                        itemStyle={{ color: '#fff' }}
                                    />
                                    <Legend wrapperStyle={{ paddingTop: '20px' }} />
                                    <Line type="monotone" dataKey="total" stroke="var(--accent-blue)" strokeWidth={3} dot={{ r: 4, fill: 'var(--bg-glass)', strokeWidth: 2 }} name="Total Volume" />
                                    <Line type="monotone" dataKey="abandoned" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} name="Missed/Abandoned" />
                                    <Line type="monotone" dataKey="blocked" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="Guardrail Blocks" />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {summary.dispositions && summary.dispositions.length > 0 && (
                        <div className="glass-panel" style={{ padding: 20 }}>
                            <div className="status-row" style={{ marginBottom: 12 }}>
                                <h3>Disposition Mix</h3>
                                <span className="topline">Outcome distribution</span>
                            </div>
                            <div style={{ height: 260, width: '100%' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={summary.dispositions.map(d => ({ name: d.dispositionId || 'None', count: d._count }))} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                                        <XAxis dataKey="name" stroke="#687076" tick={{ fill: '#687076', fontSize: 12 }} />
                                        <YAxis stroke="#687076" tick={{ fill: '#687076', fontSize: 12 }} />
                                        <Tooltip 
                                            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                                            contentStyle={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-color)', borderRadius: '6px' }}
                                            itemStyle={{ color: '#fff' }}
                                        />
                                        <Bar dataKey="count" fill="var(--accent-blue)" radius={[4, 4, 0, 0]} name="Count">
                                            {summary.dispositions.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={index % 2 === 0 ? 'var(--accent-blue)' : 'var(--accent-purple)'} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}
                </>
            )}

            {tab === 'agents' && (
                <div className="glass-panel" style={{ overflow: 'auto' }}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Agent</th>
                                <th>Status</th>
                                <th>Total</th>
                                <th>Answered</th>
                                <th>Answer Rate</th>
                                <th>Avg Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {agentStats.map((agent) => (
                                <tr key={agent.id}>
                                    <td>
                                        <div style={{ fontWeight: 700 }}>{agent.firstName} {agent.lastName}</div>
                                        <div className="mono topline">@{agent.username}</div>
                                    </td>
                                    <td>
                                        <span className={`status-badge ${agent.status === 'available' ? 'status-available' : agent.status === 'on-call' ? 'status-on-call' : agent.status === 'break' ? 'status-break' : 'status-offline'}`}>
                                            {agent.status}
                                        </span>
                                    </td>
                                    <td className="mono">{agent.totalCalls}</td>
                                    <td className="mono">{agent.answeredCalls}</td>
                                    <td className="mono">{agent.answerRate}%</td>
                                    <td className="mono">{formatDuration(agent.avgDuration)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {tab === 'calllog' && (
                <>
                    <div className="glass-panel" style={{ overflow: 'auto' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Dir</th>
                                    <th>From</th>
                                    <th>To</th>
                                    <th>Agent</th>
                                    <th>Account</th>
                                    <th>Status</th>
                                    <th>Duration</th>
                                    <th>Disposition</th>
                                    <th>Time</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {callLog.map((call) => {
                                    const isExpanded = expandedCallId === call.id;
                                    return (
                                        <Fragment key={call.id}>
                                            <tr>
                                                <td className="mono">{call.direction === 'outbound' ? 'OUT' : 'IN'}</td>
                                                <td className="mono">{call.fromNumber}</td>
                                                <td className="mono">{call.toNumber}</td>
                                                <td>{call.agent ? `${call.agent.firstName} ${call.agent.lastName}` : '—'}</td>
                                                <td className="mono">{call.accountId || '—'}</td>
                                                <td>
                                                    <span className={`status-badge ${call.status === 'completed' ? 'status-available' : call.status === 'no-answer' ? 'status-offline' : 'status-break'}`}>
                                                        {call.status}
                                                    </span>
                                                </td>
                                                <td className="mono">{formatDuration(call.duration)}</td>
                                                <td className="mono" style={{ color: 'var(--accent-blue)' }}>{call.dispositionId || '—'}</td>
                                                <td className="mono topline">{formatTime(call.createdAt)}</td>
                                                <td>
                                                    {call.recordingUrl ? (
                                                        <button
                                                            className="btn btn-secondary btn-sm"
                                                            onClick={() => setExpandedCallId(isExpanded ? null : call.id)}
                                                        >
                                                            {isExpanded ? 'Hide' : '▶ Play'}
                                                        </button>
                                                    ) : null}
                                                </td>
                                            </tr>
                                            {isExpanded && call.recordingUrl && (
                                                <tr>
                                                    <td colSpan={10} style={{ padding: '8px 4px' }}>
                                                        <CallRecordingPlayer recordingUrl={call.recordingUrl} duration={call.duration} />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className="status-row">
                        <span className="mono topline">Showing {callLog.length} of {callLogTotal} calls</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-secondary btn-sm" disabled={logPage <= 1} onClick={() => setLogPage((p) => p - 1)}>Prev</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setLogPage((p) => p + 1)}>Next</button>
                        </div>
                    </div>
                </>
            )}

            {tab === 'ai' && summary && (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                        <div className="stat-card"><div className="stat-value">{summary.aiCalls ?? 0}</div><div className="stat-label">AI Calls</div></div>
                        <div className="stat-card"><div className="stat-value">{summary.aiCompleted ?? 0}</div><div className="stat-label">AI Completed</div></div>
                        <div className="stat-card"><div className="stat-value">{formatDuration(summary.aiAvgDuration ?? 0)}</div><div className="stat-label">AI Avg Duration</div></div>
                    </div>
                    <div className="glass-panel" style={{ padding: 20 }}>
                        <p style={{ color: 'var(--text-secondary)' }}>View detailed AI agent performance on the AI Agents page.</p>
                    </div>
                </>
            )}
        </div>
    );
}
