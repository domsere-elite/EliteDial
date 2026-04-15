'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { CampaignStatusBadge } from '@/components/campaigns/CampaignStatusBadge';
import { OverviewTab } from '@/components/campaigns/tabs/OverviewTab';
import { ContactsTab } from '@/components/campaigns/tabs/ContactsTab';
import { SettingsTab } from '@/components/campaigns/tabs/SettingsTab';
import { AttemptsTab } from '@/components/campaigns/tabs/AttemptsTab';
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
    status: string;
    _count?: { contacts: number; attempts: number };
}

type TabKey = 'overview' | 'contacts' | 'settings' | 'attempts';

const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'contacts', label: 'Contacts' },
    { key: 'settings', label: 'Settings' },
    { key: 'attempts', label: 'Attempts' },
];

export default function CampaignDetailPage() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const id = Array.isArray(params.id) ? params.id[0] : params.id;
    const { hasRole } = useAuth();

    const currentTab = (searchParams.get('tab') as TabKey) || 'overview';

    const [campaign, setCampaign] = useState<Campaign | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadCampaign = () => {
        if (!id) return;
        api.get(`/campaigns/${id}`)
            .then(r => setCampaign(r.data))
            .catch(() => setError('Failed to load campaign'))
            .finally(() => setLoading(false));
    };

    useEffect(loadCampaign, [id]);

    if (!hasRole('supervisor')) {
        return <div className="notice notice-error">You do not have permission to view campaigns.</div>;
    }

    if (loading) return <div className="topline">Loading campaign...</div>;
    if (error || !campaign) return <div className="notice notice-error">{error || 'Campaign not found'}</div>;

    const handleStart = async () => {
        await api.post(`/campaigns/${id}/start`);
        loadCampaign();
    };
    const handlePause = async () => {
        await api.post(`/campaigns/${id}/pause`);
        loadCampaign();
    };

    const setTab = (tab: TabKey) => {
        const p = new URLSearchParams(searchParams.toString());
        if (tab === 'overview') p.delete('tab'); else p.set('tab', tab);
        router.push(`/dashboard/campaigns/${id}?${p.toString()}`);
    };

    return (
        <div className="workspace-shell">
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.786rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                    <Link href="/dashboard/campaigns" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Campaigns</Link>
                    <span>/</span>
                    <span>{campaign.name}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <h1>{campaign.name}</h1>
                        <CampaignStatusBadge status={campaign.status} />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                        {campaign.status === 'active' ? (
                            <button className="btn btn-warning" onClick={handlePause}>Pause</button>
                        ) : (
                            <button className="btn btn-success" onClick={handleStart}>Start</button>
                        )}
                        <button className="btn btn-primary" onClick={() => router.push(`/dashboard/campaigns/${id}/edit`)}>Edit</button>
                    </div>
                </div>
            </div>

            <div className="tab-bar">
                {TABS.map(t => (
                    <button key={t.key} className={`tab ${currentTab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
                        {t.label}
                    </button>
                ))}
            </div>

            {currentTab === 'overview' && <OverviewTab campaign={campaign} />}
            {currentTab === 'contacts' && <ContactsTab campaignId={campaign.id} />}
            {currentTab === 'settings' && <SettingsTab campaign={campaign} />}
            {currentTab === 'attempts' && <AttemptsTab campaignId={campaign.id} />}
        </div>
    );
}
