'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { CampaignForm, CampaignFormValues } from '@/components/campaigns/CampaignForm';
import api from '@/lib/api';

export default function NewCampaignPage() {
    const router = useRouter();
    const { hasRole } = useAuth();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!hasRole('supervisor')) {
        return <div className="notice notice-error">You do not have permission to create campaigns.</div>;
    }

    const handleSubmit = async (values: CampaignFormValues) => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await api.post('/campaigns', values);
            router.push(`/dashboard/campaigns/${res.data.id}`);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to create campaign');
            setSubmitting(false);
        }
    };

    return (
        <div className="workspace-shell">
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.786rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                    <Link href="/dashboard/campaigns" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Campaigns</Link>
                    <span>/</span>
                    <span>New Campaign</span>
                </div>
                <h1>Create Campaign</h1>
            </div>
            <CampaignForm
                mode="create"
                submitting={submitting}
                error={error}
                onSubmit={handleSubmit}
                onCancel={() => router.push('/dashboard/campaigns')}
            />
        </div>
    );
}
