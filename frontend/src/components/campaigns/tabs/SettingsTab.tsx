'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDialMode } from '@/lib/dialMode';
import { fetchRetellAgents, RetellAgent } from '@/lib/retellAgents';

interface Campaign {
    id: string;
    name: string;
    description: string | null;
    dialMode: string;
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
    retellAgentId?: string | null;
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
    const [agents, setAgents] = useState<RetellAgent[] | null>(null);

    useEffect(() => {
        if (campaign.dialMode !== 'ai_autonomous') return;
        fetchRetellAgents().then(setAgents).catch(() => setAgents([]));
    }, [campaign.dialMode]);

    const assignedAgent =
        campaign.dialMode === 'ai_autonomous' && campaign.retellAgentId
            ? (agents?.find(a => a.id === campaign.retellAgentId) ?? null)
            : null;

    const agentLabel: React.ReactNode = (() => {
        if (campaign.dialMode !== 'ai_autonomous') return null;
        if (!campaign.retellAgentId) return <span style={{ color: 'var(--status-red-text)' }}>Not assigned</span>;
        if (agents === null) return 'Loading…';
        if (assignedAgent) return assignedAgent.name;
        return <code>{campaign.retellAgentId}</code>;
    })();

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

            {campaign.dialMode === 'ai_autonomous' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>AI Agent</div>
                    <Row label="Assigned Agent" value={agentLabel} />
                </div>
            )}

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
