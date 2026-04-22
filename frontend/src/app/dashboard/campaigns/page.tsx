'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

type Campaign = {
    id: string;
    name: string;
    description: string | null;
    dialMode: string;
    status: string;
    timezone: string;
    maxAttemptsPerLead: number;
    abandonRateLimit: number;
    dialRatio: number;
    retryDelaySeconds: number;
    maxConcurrentCalls: number;
    aiTargetEnabled: boolean;
    aiTarget: string | null;
    createdAt: string;
    _count: { lists: number; contacts: number; attempts: number };
};

type CampaignDetail = Campaign & {
    lists: {
        id: string;
        name: string;
        sourceType: string;
        totalRecords: number;
        validRecords: number;
        invalidRecords: number;
        duplicateSuppressed: number;
        dncSuppressed: number;
        uploadStatus: string;
    }[];
};

type CampaignContact = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    primaryPhone: string;
    status: string;
    priority: number;
    attemptCount: number;
};

type ImportResult = {
    totalRecords: number;
    validRecords: number;
    invalidRecords: number;
    duplicateSuppressed: number;
    dncSuppressed: number;
};

const modeLabels: Record<string, string> = { predictive: 'Predictive', progressive: 'Progressive', preview: 'Preview' };
const initials = (name: string) => name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'CM';

export default function CampaignsPage() {
    const { hasRole } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [selectedCampaign, setSelectedCampaign] = useState<CampaignDetail | null>(null);
    const [drawerLoading, setDrawerLoading] = useState(false);
    const [contacts, setContacts] = useState<CampaignContact[]>([]);
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [importing, setImporting] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState({
        name: '',
        description: '',
        dialMode: 'predictive',
        timezone: 'America/Chicago',
        maxAttemptsPerLead: 6,
        abandonRateLimit: 0.03,
        dialRatio: 3,
        retryDelaySeconds: 600,
        maxConcurrentCalls: 0,
        aiTargetEnabled: false,
        aiTarget: '',
    });

    const loadCampaigns = useCallback(async () => {
        try {
            setCampaigns((await api.get('/campaigns')).data);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void loadCampaigns(); }, [loadCampaigns]);

    const openCreateModal = () => {
        setEditingId(null);
        setForm({ name: '', description: '', dialMode: 'predictive', timezone: 'America/Chicago', maxAttemptsPerLead: 6, abandonRateLimit: 0.03, dialRatio: 3, retryDelaySeconds: 600, maxConcurrentCalls: 0, aiTargetEnabled: false, aiTarget: '' });
        setShowModal(true);
    };

    const openEditModal = (campaign: Campaign) => {
        setEditingId(campaign.id);
        setForm({
            name: campaign.name,
            description: campaign.description || '',
            dialMode: campaign.dialMode,
            timezone: campaign.timezone,
            maxAttemptsPerLead: campaign.maxAttemptsPerLead,
            abandonRateLimit: campaign.abandonRateLimit,
            dialRatio: campaign.dialRatio,
            retryDelaySeconds: campaign.retryDelaySeconds,
            maxConcurrentCalls: campaign.maxConcurrentCalls,
            aiTargetEnabled: campaign.aiTargetEnabled,
            aiTarget: campaign.aiTarget || '',
        });
        setShowModal(true);
    };

    const saveCampaign = async () => {
        if (!form.name.trim()) return;
        setSaving(true);
        try {
            const payload = { ...form, name: form.name.trim(), description: form.description.trim() || null, aiTarget: form.aiTarget || null };
            if (editingId) {
                await api.patch(`/campaigns/${editingId}`, payload);
            } else {
                await api.post('/campaigns', payload);
            }
            setShowModal(false);
            await loadCampaigns();
        } finally {
            setSaving(false);
        }
    };

    const refreshDrawer = async (id: string) => {
        setDrawerLoading(true);
        setImportResult(null);
        try {
            const [campaignRes, contactsRes] = await Promise.all([
                api.get(`/campaigns/${id}`),
                api.get(`/campaigns/${id}/contacts?page=1&limit=24`),
            ]);
            setSelectedCampaign(campaignRes.data);
            setContacts(contactsRes.data.contacts || []);
        } finally {
            setDrawerLoading(false);
        }
    };

    const startCampaign = async (id: string) => {
        await api.post(`/campaigns/${id}/start`);
        await loadCampaigns();
        if (selectedCampaign?.id === id) await refreshDrawer(id);
    };

    const pauseCampaign = async (id: string) => {
        await api.post(`/campaigns/${id}/pause`);
        await loadCampaigns();
        if (selectedCampaign?.id === id) await refreshDrawer(id);
    };

    const handleFile = async (file: File) => {
        if (!selectedCampaign) return;
        setImporting(true);
        try {
            const csv = await file.text();
            const res = await api.post(`/campaigns/${selectedCampaign.id}/import`, {
                listName: file.name.replace(/\.csv$/i, ''),
                csv,
            });
            setImportResult(res.data);
            await refreshDrawer(selectedCampaign.id);
        } finally {
            setImporting(false);
        }
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void handleFile(file);
    };

    const onSelectFile = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) void handleFile(file);
    };

    const totalContacts = campaigns.reduce((sum, campaign) => sum + campaign._count.contacts, 0);
    const totalAttempts = campaigns.reduce((sum, campaign) => sum + campaign._count.attempts, 0);
    const successPercentage = totalContacts > 0 ? Math.min(99.9, (totalAttempts / totalContacts) * 100) : 0;
    const chartBars = [28, 44, 36, 61, 52, 68, 84];
    const chartLabels = ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00', 'NOW'];

    if (!hasRole('supervisor')) {
        return <div className="notice notice-error">You do not have permission to view campaigns.</div>;
    }

    return (
        <div className="precision-page">
            <div className="precision-toolbar">
                <div className="precision-toolbar-title">AI Outbound Campaigns</div>
                <div className="precision-search"><input className="input" placeholder="Search campaigns..." /></div>
                <div className="precision-toolbar-actions">
                    <button className="btn btn-primary" onClick={openCreateModal} style={{ color: '#fff' }}>Create Campaign</button>
                </div>
            </div>
            <div className="topline" style={{ marginTop: -8, marginBottom: 8 }}>Manage contact lists for AI outbound calling.</div>

            <section className="campaign-kpi-grid">
                <div className="campaign-stat-card"><div className="label">Total Campaigns</div><div className="value">{campaigns.length}</div></div>
                <div className="campaign-stat-card"><div className="label">Success Percentage</div><div className="value">{successPercentage.toFixed(1)}%</div></div>
                <div className="campaign-stat-card"><div className="label">Total Leads Remaining</div><div className="value">{totalContacts.toLocaleString()}</div></div>
                <div className="campaign-stat-card"><div className="label">Total Attempts</div><div className="value">{totalAttempts.toLocaleString()}</div></div>
            </section>

            <div className="campaign-layout-grid">
                <div className="precision-stack">
                    <section className="campaign-table-wrap">
                        {loading ? (
                            <div className="precision-card">Loading campaigns...</div>
                        ) : campaigns.length === 0 ? (
                            <div className="precision-card">
                                <div className="topline">No campaigns yet.</div>
                                <button className="btn btn-primary" onClick={openCreateModal} style={{ marginTop: 12, color: '#fff' }}>Create your first campaign</button>
                            </div>
                        ) : (
                            <table className="campaign-table">
                                <thead>
                                    <tr>
                                        <th>Campaign Name</th>
                                        <th>Status</th>
                                        <th>Dial Rate</th>
                                        <th>Connected</th>
                                        <th>Manager</th>
                                        <th style={{ textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {campaigns.map((campaign) => {
                                        const connectedPct = Math.min(100, Math.round((campaign._count.attempts / Math.max(campaign._count.contacts, 1)) * 100));
                                        return (
                                            <tr key={campaign.id} onClick={() => void refreshDrawer(campaign.id)} style={{ cursor: 'pointer' }}>
                                                <td>
                                                    <div style={{ fontWeight: 800 }}>{campaign.name}</div>
                                                    <div className="topline" style={{ fontSize: '0.72rem' }}>{campaign.description || `ID: #${campaign.id.slice(0, 6).toUpperCase()}`}</div>
                                                </td>
                                                <td><span className={`campaign-pill ${campaign.status}`}>{campaign.status.toUpperCase()}</span></td>
                                                <td className="mono">{campaign.dialRatio.toFixed(1)}x</td>
                                                <td>
                                                    <div className="progress-pill"><span style={{ width: `${connectedPct}%` }} /></div>
                                                    <div className="topline" style={{ fontSize: '0.68rem', marginTop: 6 }}>{connectedPct}% of list</div>
                                                </td>
                                                <td>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                        <div className="precision-avatar" style={{ width: 30, height: 30, borderRadius: 10 }}>{initials(campaign.name)}</div>
                                                        <span style={{ fontWeight: 700 }}>{campaign.aiTargetEnabled ? 'AI Routing' : 'Supervisor'}</span>
                                                    </div>
                                                </td>
                                                <td onClick={(event) => event.stopPropagation()} style={{ textAlign: 'right' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                                        {(campaign.status === 'draft' || campaign.status === 'paused') && <button className="btn btn-success btn-sm" onClick={() => void startCampaign(campaign.id)}>Start</button>}
                                                        {campaign.status === 'active' && <button className="btn btn-secondary btn-sm" onClick={() => void pauseCampaign(campaign.id)}>Pause</button>}
                                                        <button className="btn btn-secondary btn-sm" onClick={() => openEditModal(campaign)}>Edit</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </section>

                    <section className="precision-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <h2 style={{ fontFamily: 'var(--font-headline)', fontSize: '1.4rem', fontWeight: 800 }}>Dialing Frequency Trend</h2>
                                <div className="topline">Average attempts per contact over the last 24 hours.</div>
                            </div>
                            <select className="select" style={{ width: 170 }} defaultValue="24h">
                                <option value="24h">Last 24 Hours</option>
                                <option value="7d">Last 7 Days</option>
                            </select>
                        </div>
                        <div className="mini-chart">
                            {chartBars.map((height, index) => (
                                <div key={chartLabels[index]} className="mini-chart-bar" style={{ height: `${Math.max(height, 12)}%` }}>
                                    <span>{chartLabels[index]}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                <div className="precision-stack">
                    <section className="precision-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                            <h3 style={{ fontFamily: 'var(--font-headline)', fontSize: '1.12rem', fontWeight: 800 }}>AI Optimization</h3>
                            <span className="status-badge status-available">Live</span>
                        </div>
                        <p style={{ color: 'var(--text-secondary)' }}>
                            System recommends increasing dial rate on the highest-affinity campaign in the current time window.
                        </p>
                        <button className="btn btn-primary btn-sm" style={{ marginTop: 12, color: '#fff' }}>Apply Strategy</button>
                    </section>

                    <section className="precision-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                            <h3 style={{ fontFamily: 'var(--font-headline)', fontSize: '1.12rem', fontWeight: 800 }}>Campaign Queues</h3>
                            <span className="topline">{campaigns.length} total</span>
                        </div>
                        <div className="precision-list">
                            {campaigns.slice(0, 3).map((campaign) => (
                                <div key={campaign.id} className="precision-list-item">
                                    <div>
                                        <div style={{ fontWeight: 800 }}>{campaign.name}</div>
                                        <div className="topline" style={{ fontSize: '0.68rem', marginTop: 4 }}>{campaign._count.contacts.toLocaleString()} contacts · {modeLabels[campaign.dialMode] || campaign.dialMode}</div>
                                    </div>
                                    <span className={`campaign-pill ${campaign.status}`}>{campaign.status}</span>
                                </div>
                            ))}
                            {campaigns.length === 0 && <div className="topline">No active queue uploads yet.</div>}
                        </div>
                    </section>
                </div>
            </div>

            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal-card" onClick={(event) => event.stopPropagation()}>
                        <h2>{editingId ? 'Edit Campaign' : 'New Campaign'}</h2>
                        <div style={{ display: 'grid', gap: 12 }}>
                            <div><label>Campaign Name</label><input className="input" value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} /></div>
                            <div><label>Description</label><textarea className="input" rows={3} value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} /></div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                                <div><label>Timezone</label><select className="select" value={form.timezone} onChange={(e) => setForm((current) => ({ ...current, timezone: e.target.value }))}><option value="America/New_York">Eastern</option><option value="America/Chicago">Central</option><option value="America/Denver">Mountain</option><option value="America/Los_Angeles">Pacific</option></select></div>
                                <div><label>Max Attempts Per Lead</label><input className="input" type="number" value={form.maxAttemptsPerLead} onChange={(e) => setForm((current) => ({ ...current, maxAttemptsPerLead: parseInt(e.target.value) || 1 }))} /></div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input type="checkbox" checked={form.aiTargetEnabled} onChange={(e) => setForm((current) => ({ ...current, aiTargetEnabled: e.target.checked }))} />
                                    <label style={{ margin: 0 }}>Enable AI Target</label>
                                </div>
                                {form.aiTargetEnabled && (
                                    <div><label>AI Target</label><input className="input" value={form.aiTarget} onChange={(e) => setForm((current) => ({ ...current, aiTarget: e.target.value }))} placeholder="e.g. appointment-setter" /></div>
                                )}
                            </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
                            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={() => void saveCampaign()} disabled={saving || !form.name.trim()} style={{ color: '#fff' }}>{saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Campaign'}</button>
                        </div>
                    </div>
                </div>
            )}

            {selectedCampaign && (
                <div className="modal-overlay" onClick={() => setSelectedCampaign(null)}>
                    <div className="modal-card" style={{ maxWidth: 980 }} onClick={(event) => event.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                            <div>
                                <div className="topline">Campaign Detail</div>
                                <h2>{selectedCampaign.name}</h2>
                            </div>
                            <button className="btn btn-secondary btn-sm" onClick={() => setSelectedCampaign(null)}>Close</button>
                        </div>
                        {drawerLoading ? (
                            <div className="topline">Loading details...</div>
                        ) : (
                            <div style={{ display: 'grid', gap: 16 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                                    <div className="campaign-stat-card"><div className="label">Contacts</div><div className="value">{selectedCampaign._count.contacts}</div></div>
                                    <div className="campaign-stat-card"><div className="label">Lists</div><div className="value">{selectedCampaign.lists.length}</div></div>
                                    <div className="campaign-stat-card"><div className="label">Attempts</div><div className="value">{selectedCampaign._count.attempts}</div></div>
                                </div>
                                <div className="precision-card subtle">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                        <div>
                                            <h3 style={{ fontFamily: 'var(--font-headline)', fontSize: '1.05rem', fontWeight: 800 }}>Import Contacts</h3>
                                            <div className="topline">Drop CSV or click to browse.</div>
                                        </div>
                                    </div>
                                    <div
                                        className={`dropzone ${dragOver ? 'active' : ''}`}
                                        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                                        onDragLeave={() => setDragOver(false)}
                                        onDrop={onDrop}
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <input ref={fileInputRef} type="file" accept=".csv" onChange={onSelectFile} />
                                        {importing ? 'Importing...' : 'Drop CSV file here or click to browse'}
                                    </div>
                                    {importResult && <div className="topline" style={{ marginTop: 10 }}>Imported {importResult.validRecords} valid records from {importResult.totalRecords} total.</div>}
                                </div>
                                <div className="precision-card subtle">
                                    <h3 style={{ fontFamily: 'var(--font-headline)', fontSize: '1.05rem', fontWeight: 800, marginBottom: 12 }}>Recent Contacts</h3>
                                    <table className="campaign-table">
                                        <thead>
                                            <tr><th>Name</th><th>Phone</th><th>Status</th><th>Priority</th><th>Attempts</th></tr>
                                        </thead>
                                        <tbody>
                                            {contacts.map((contact) => (
                                                <tr key={contact.id}>
                                                    <td>{contact.firstName || ''} {contact.lastName || ''}</td>
                                                    <td className="mono">{contact.primaryPhone}</td>
                                                    <td><span className={`campaign-pill ${contact.status}`}>{contact.status}</span></td>
                                                    <td className="mono">{contact.priority}</td>
                                                    <td className="mono">{contact.attemptCount}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
