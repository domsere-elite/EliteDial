'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

interface Campaign {
    id: string;
    _count?: { contacts: number; attempts: number };
}

interface Attempt {
    id: string;
    outcome: string | null;
    status: string;
    startedAt: string;
    contact?: { firstName: string | null; lastName: string | null; primaryPhone: string };
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

export function OverviewTab({ campaign }: Props) {
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api.get(`/campaigns/${campaign.id}/attempts?limit=20`)
            .then(r => setAttempts(r.data?.attempts || []))
            .catch(() => setAttempts([]))
            .finally(() => setLoading(false));
    }, [campaign.id]);

    const total = attempts.length;
    const contacted = attempts.filter(a => ['bridged-to-agent', 'bridged-to-ai', 'human', 'completed'].includes(a.outcome || '')).length;
    const abandoned = attempts.filter(a => a.outcome === 'bridge-failed').length;
    const contactRate = total > 0 ? `${Math.round((contacted / total) * 100)}%` : '—';
    const abandonRate = total > 0 ? `${((abandoned / total) * 100).toFixed(1)}%` : '—';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                <div className="stat-card">
                    <div className="stat-value">{abandonRate}</div>
                    <div className="stat-label">Abandon Rate</div>
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
