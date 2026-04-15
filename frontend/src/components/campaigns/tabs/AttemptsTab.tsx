'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

interface Attempt {
    id: string;
    outcome: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    contact?: { firstName: string | null; lastName: string | null; primaryPhone: string };
    call?: { id: string; duration: number; status: string } | null;
}

interface Props {
    campaignId: string;
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

const PAGE_SIZE = 50;

export function AttemptsTab({ campaignId }: Props) {
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        api.get(`/campaigns/${campaignId}/attempts?limit=${PAGE_SIZE}&offset=${offset}`)
            .then(r => {
                setAttempts(r.data?.attempts || []);
                setTotal(r.data?.total || 0);
            })
            .catch(() => setAttempts([]))
            .finally(() => setLoading(false));
    }, [campaignId, offset]);

    const hasPrev = offset > 0;
    const hasNext = offset + PAGE_SIZE < total;

    return (
        <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div className="section-label">Call Attempts ({total})</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.786rem', color: 'var(--text-muted)' }}>
                    <button className="btn btn-sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={!hasPrev}>Previous</button>
                    <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
                    <button className="btn btn-sm" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!hasNext}>Next</button>
                </div>
            </div>
            {loading ? (
                <div className="topline">Loading...</div>
            ) : attempts.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.857rem', padding: '20px 0', textAlign: 'center' }}>
                    No attempts yet
                </div>
            ) : (
                <table className="data-table">
                    <thead><tr><th>Time</th><th>Contact</th><th>Phone</th><th>Outcome</th><th>Duration</th></tr></thead>
                    <tbody>
                        {attempts.map(a => {
                            const badge = OUTCOME_BADGE[a.outcome || ''] ?? { className: 'badge-gray', label: a.outcome || a.status };
                            const name = `${a.contact?.firstName || ''} ${a.contact?.lastName || ''}`.trim() || 'Unknown';
                            const duration = a.call?.duration ? `${Math.floor(a.call.duration / 60)}:${String(a.call.duration % 60).padStart(2, '0')}` : '—';
                            return (
                                <tr key={a.id}>
                                    <td style={{ color: 'var(--text-muted)', fontSize: '0.786rem' }}>
                                        {new Date(a.startedAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                    </td>
                                    <td style={{ fontWeight: 500 }}>{name}</td>
                                    <td className="mono" style={{ fontSize: '0.786rem', color: 'var(--text-secondary)' }}>{a.contact?.primaryPhone || '—'}</td>
                                    <td><span className={`status-badge ${badge.className}`}>{badge.label}</span></td>
                                    <td className="mono">{duration}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
