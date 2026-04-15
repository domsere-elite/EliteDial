'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

interface Campaign {
    id: string;
    abandonRateLimit?: number;
    _count?: { contacts: number; attempts: number };
}

interface Attempt {
    id: string;
    outcome: string | null;
    status: string;
    startedAt: string;
    contact?: { firstName: string | null; lastName: string | null; primaryPhone: string };
}

interface DialerCampaignStatus {
    id: string;
    availableAgents: number;
    activeAttempts: number;
    dispatchCapacity: number;
    effectiveConcurrentLimit: number;
    recentAbandonRate: number;
    recentCompletedAttempts: number;
    abandonRateLimit: number;
    warnings: string[];
    blockedReasons: string[];
}

interface Props {
    campaign: Campaign;
}

const OUTCOME_BADGE: Record<string, { className: string; label: string }> = {
    'bridged-to-agent': { className: 'badge-green', label: 'bridged-agent' },
    'bridged-to-ai': { className: 'badge-blue', label: 'bridged-to-ai' },
    'human': { className: 'badge-green', label: 'human' },
    'completed': { className: 'badge-green', label: 'completed' },
    'no-answer': { className: 'badge-red', label: 'no-answer' },
    'failed': { className: 'badge-red', label: 'failed' },
    'bridge-failed': { className: 'badge-red', label: 'bridge-failed' },
    'voicemail': { className: 'badge-amber', label: 'voicemail' },
    'busy': { className: 'badge-amber', label: 'busy' },
    'early-hangup': { className: 'badge-amber', label: 'early-hangup' },
};

const WARNING_COPY: Record<string, { tone: 'error' | 'warning' | 'info'; label: string }> = {
    abandon_rate_exceeded: { tone: 'error', label: 'Abandon rate over limit' },
    safe_predictive_cap: { tone: 'info', label: 'Over-dial disabled (config)' },
    no_available_agents: { tone: 'warning', label: 'No agents available — dispatch paused' },
    queue_backpressure: { tone: 'warning', label: 'Queue full — waiting on active calls' },
};

const STATUS_POLL_MS = 5000;

export function OverviewTab({ campaign }: Props) {
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialerStatus, setDialerStatus] = useState<DialerCampaignStatus | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        api.get(`/campaigns/${campaign.id}/attempts?limit=20`)
            .then(r => setAttempts(r.data?.attempts || []))
            .catch(() => setAttempts([]))
            .finally(() => setLoading(false));
    }, [campaign.id]);

    useEffect(() => {
        mountedRef.current = true;
        const fetchStatus = async () => {
            try {
                const res = await api.get('/campaigns/dialer/status');
                if (!mountedRef.current) return;
                const match = (res.data?.campaigns || []).find((c: DialerCampaignStatus) => c.id === campaign.id);
                setDialerStatus(match || null);
            } catch {
                // Silent — status is supplementary; stale UI better than noisy errors.
            }
        };
        void fetchStatus();
        const interval = setInterval(fetchStatus, STATUS_POLL_MS);
        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [campaign.id]);

    const total = attempts.length;
    const contacted = attempts.filter(a => ['bridged-to-agent', 'bridged-to-ai', 'human', 'completed'].includes(a.outcome || '')).length;
    const contactRate = total > 0 ? `${Math.round((contacted / total) * 100)}%` : '—';

    const abandonLimit = dialerStatus?.abandonRateLimit ?? campaign.abandonRateLimit ?? 0.03;
    const liveAbandon = dialerStatus?.recentAbandonRate ?? 0;
    const abandonSampleReady = (dialerStatus?.recentCompletedAttempts ?? 0) >= 5;
    const abandonOverLimit = abandonSampleReady && liveAbandon >= abandonLimit;
    const abandonPct = `${(liveAbandon * 100).toFixed(1)}%`;
    const limitPct = `${(abandonLimit * 100).toFixed(1)}%`;

    const allSignals = [
        ...(dialerStatus?.blockedReasons || []),
        ...(dialerStatus?.warnings || []),
    ];
    const visibleSignals = Array.from(new Set(allSignals));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {visibleSignals.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {visibleSignals.map(code => {
                        const copy = WARNING_COPY[code] || { tone: 'warning' as const, label: code };
                        const cls =
                            copy.tone === 'error' ? 'notice notice-error' :
                            copy.tone === 'warning' ? 'notice notice-warning' :
                            'notice notice-info';
                        let detail = copy.label;
                        if (code === 'abandon_rate_exceeded') {
                            detail = `${copy.label} — ${abandonPct} (cap ${limitPct}) over last ${dialerStatus?.recentCompletedAttempts ?? 0} completed calls`;
                        }
                        return (
                            <div key={code} className={cls}>
                                <strong>⚠ {detail}</strong>
                            </div>
                        );
                    })}
                </div>
            )}

            {dialerStatus && (
                <div className="card" style={{ display: 'flex', gap: 24, alignItems: 'center', padding: '10px 16px' }}>
                    <div>
                        <div className="section-label">Agents available</div>
                        <div style={{ fontSize: '1.286rem', fontWeight: 600 }}>{dialerStatus.availableAgents}</div>
                    </div>
                    <div>
                        <div className="section-label">Active calls</div>
                        <div style={{ fontSize: '1.286rem', fontWeight: 600 }}>{dialerStatus.activeAttempts}</div>
                    </div>
                    <div>
                        <div className="section-label">Dispatch capacity</div>
                        <div style={{ fontSize: '1.286rem', fontWeight: 600 }}>
                            {dialerStatus.dispatchCapacity}
                            <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                                / limit {dialerStatus.effectiveConcurrentLimit}
                            </span>
                        </div>
                    </div>
                    <div style={{ marginLeft: 'auto', fontSize: '0.714rem', color: 'var(--text-muted)' }}>
                        Live · updates every {STATUS_POLL_MS / 1000}s
                    </div>
                </div>
            )}

            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-value">{campaign._count?.contacts ?? 0}</div>
                    <div className="stat-label">Contacts</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{campaign._count?.attempts ?? 0}</div>
                    <div className="stat-label">Attempts</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value" style={{ color: 'var(--status-green)' }}>{contactRate}</div>
                    <div className="stat-label">Contact Rate</div>
                </div>
                <div
                    className={`stat-card ${abandonOverLimit ? 'pulse-red' : ''}`}
                    style={abandonOverLimit ? { borderColor: 'var(--status-red-border)' } : undefined}
                >
                    <div className="stat-value" style={{ color: abandonOverLimit ? 'var(--status-red-text)' : undefined }}>
                        {abandonSampleReady ? abandonPct : '—'}
                    </div>
                    <div className="stat-label">
                        Abandon Rate <span style={{ color: 'var(--text-muted)' }}>/ cap {limitPct}</span>
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Recent Activity</div>
                {loading ? (
                    <div className="topline">Loading...</div>
                ) : attempts.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.857rem', padding: '20px 0', textAlign: 'center' }}>
                        No attempts yet
                    </div>
                ) : (
                    <table className="data-table">
                        <thead><tr><th>Outcome</th><th>Contact</th><th>Phone</th><th>Time</th></tr></thead>
                        <tbody>
                            {attempts.slice(0, 15).map(a => {
                                const badge = OUTCOME_BADGE[a.outcome || ''] ?? { className: 'badge-gray', label: a.outcome || a.status };
                                const name = `${a.contact?.firstName || ''} ${a.contact?.lastName || ''}`.trim() || 'Unknown';
                                return (
                                    <tr key={a.id}>
                                        <td><span className={`status-badge ${badge.className}`}>{badge.label}</span></td>
                                        <td style={{ fontWeight: 500 }}>{name}</td>
                                        <td className="mono" style={{ fontSize: '0.786rem', color: 'var(--text-secondary)' }}>{a.contact?.primaryPhone || '—'}</td>
                                        <td style={{ color: 'var(--text-muted)', fontSize: '0.786rem' }}>
                                            {new Date(a.startedAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
