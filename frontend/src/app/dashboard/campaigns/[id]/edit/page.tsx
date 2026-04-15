'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { CampaignForm, CampaignFormValues } from '@/components/campaigns/CampaignForm';
import api from '@/lib/api';

export default function EditCampaignPage() {
    const router = useRouter();
    const params = useParams();
    const id = Array.isArray(params.id) ? params.id[0] : params.id;
    const { hasRole } = useAuth();
    const [initial, setInitial] = useState<Partial<CampaignFormValues> | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [campaignName, setCampaignName] = useState('');

    useEffect(() => {
        if (!id) return;
        api.get(`/campaigns/${id}`).then(res => {
            const c = res.data;
            setCampaignName(c.name);
            setInitial({
                name: c.name || '',
                description: c.description || '',
                dialMode: c.dialMode,
                timezone: c.timezone,
                dialRatio: c.dialRatio,
                maxConcurrentCalls: c.maxConcurrentCalls,
                abandonRateLimit: c.abandonRateLimit,
                maxAttemptsPerLead: c.maxAttemptsPerLead,
                retryDelaySeconds: c.retryDelaySeconds,
                aiOverflowNumber: c.aiOverflowNumber || '',
            });
        }).catch(() => {
            setError('Failed to load campaign');
        }).finally(() => setLoading(false));
    }, [id]);

    if (!hasRole('supervisor')) {
        return <div className="notice notice-error">You do not have permission to edit campaigns.</div>;
    }

    if (loading) return <div className="topline">Loading campaign...</div>;
    if (!initial) return <div className="notice notice-error">Campaign not found.</div>;

    const handleSubmit = async (values: CampaignFormValues) => {
        setSubmitting(true);
        setError(null);
        try {
            const payload = {
                ...values,
                aiOverflowNumber: values.aiOverflowNumber || null,
            };
            await api.patch(`/campaigns/${id}`, payload);
            router.push(`/dashboard/campaigns/${id}`);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to save campaign');
            setSubmitting(false);
        }
    };

    return (
        <div className="workspace-shell">
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.786rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                    <Link href="/dashboard/campaigns" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>Campaigns</Link>
                    <span>/</span>
                    <Link href={`/dashboard/campaigns/${id}`} style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>{campaignName}</Link>
                    <span>/</span>
                    <span>Edit</span>
                </div>
                <h1>Edit Campaign</h1>
            </div>
            <CampaignForm
                mode="edit"
                initialValues={initial}
                submitting={submitting}
                error={error}
                onSubmit={handleSubmit}
                onCancel={() => router.push(`/dashboard/campaigns/${id}`)}
            />
        </div>
    );
}
