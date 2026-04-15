'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

interface Campaign {
    id: string;
    name: string;
    description: string | null;
    dialMode: string;
    timezone: string;
    dialRatio: number;
    maxConcurrentCalls: number;
    abandonRateLimit: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
    aiOverflowNumber: string | null;
}

interface Props {
    campaign: Campaign;
}

const TIMEZONE_LABELS: Record<string, string> = {
    'America/New_York': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Los_Angeles': 'Pacific',
};

function formatRetry(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')} hours`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: '0.857rem', fontWeight: 500 }}>{value}</span>
        </div>
    );
}

export function SettingsTab({ campaign }: Props) {
    const router = useRouter();
    const [globalOverflow, setGlobalOverflow] = useState<string | null>(null);

    useEffect(() => {
        api.get('/settings/ai-overflow-number/public')
            .then(r => setGlobalOverflow(r.data?.value ?? null))
            .catch(() => setGlobalOverflow(null));
    }, []);

    const effectiveOverflow = campaign.aiOverflowNumber
        ? campaign.aiOverflowNumber
        : globalOverflow
            ? `${globalOverflow} (global)`
            : 'Not configured';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={() => router.push(`/dashboard/campaigns/${campaign.id}/edit`)}>
                    Edit
                </button>
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Basics</div>
                <Row label="Name" value={campaign.name} />
                <Row label="Description" value={campaign.description || '—'} />
                <Row label="Dial Mode" value={campaign.dialMode.charAt(0).toUpperCase() + campaign.dialMode.slice(1)} />
                <Row label="Timezone" value={TIMEZONE_LABELS[campaign.timezone] || campaign.timezone} />
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Pacing &amp; Overdial</div>
                <Row label="Dial Ratio" value={`${campaign.dialRatio.toFixed(1)}x`} />
                <Row label="Max Concurrent" value={campaign.maxConcurrentCalls === 0 ? 'Auto' : campaign.maxConcurrentCalls} />
                <Row label="Abandon Rate Limit" value={`${(campaign.abandonRateLimit * 100).toFixed(1)}%`} />
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Retry Strategy</div>
                <Row label="Max Attempts Per Lead" value={campaign.maxAttemptsPerLead} />
                <Row label="Retry Delay" value={formatRetry(campaign.retryDelaySeconds)} />
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>AI Overflow</div>
                <Row label="Overflow Number" value={<span className="mono">{effectiveOverflow}</span>} />
            </div>
        </div>
    );
}
