'use client';

import { useRouter } from 'next/navigation';
import { formatDialMode } from '@/lib/dialMode';

interface Campaign {
    id: string;
    name: string;
    description: string | null;
    dialMode: string;
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
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
                <Row label="Dial Mode" value={formatDialMode(campaign.dialMode)} />
                <Row label="Timezone" value={TIMEZONE_LABELS[campaign.timezone] || campaign.timezone} />
            </div>

            {campaign.dialMode !== 'manual' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>Concurrency</div>
                    <Row label="Max Concurrent Calls" value={campaign.maxConcurrentCalls === 0 ? 'Auto (use available agents)' : campaign.maxConcurrentCalls} />
                </div>
            )}

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Retry Strategy</div>
                <Row label="Max Attempts Per Lead" value={campaign.maxAttemptsPerLead} />
                <Row label="Retry Delay" value={formatRetry(campaign.retryDelaySeconds)} />
            </div>
        </div>
    );
}
