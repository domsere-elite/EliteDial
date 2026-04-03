'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

interface MissingExtensionAgent {
    id: string;
    name: string;
    role: string;
    status: string;
}

interface PhoneNumberRecord {
    number: string;
    label: string | null;
    type: string;
    assignedTo: string | null;
}

interface QueueRecord {
    id: string;
    name: string;
    holdTimeout: number;
    overflowAction: string;
}

interface CampaignRecord {
    id: string;
    name: string;
    dialMode: string;
    aiTargetEnabled: boolean;
}

interface ReadinessResponse {
    environment: {
        nodeEnv: string;
        port: number;
        frontendUrl: string;
        backendBaseUrl: string;
        backendPublicUrlConfigured: boolean;
        dialerMode: string;
    };
    providers: {
        telephony: {
            selected: string;
            signalwireConfigured: boolean;
            signalwireSpaceUrl: string | null;
            browserTokenCapable: boolean;
            softphoneTransport: string;
            humanBrowserOutboundSupported: boolean;
            inboundWebhookUrl: string;
            callStatusWebhookUrl: string;
            recordingWebhookUrl: string;
            transcriptionWebhookUrl: string;
            amdWebhookUrl: string;
        };
        ai: {
            selected: string;
            retellConfigured: boolean;
        };
        crm: {
            configured: boolean;
        };
    };
    staffing: {
        totalAgents: number;
        agentsWithExtensions: number;
        missingExtensions: MissingExtensionAgent[];
    };
    phoneNumbers: {
        totalActive: number;
        outbound: PhoneNumberRecord[];
        inbound: PhoneNumberRecord[];
    };
    queues: QueueRecord[];
    campaigns: CampaignRecord[];
    warnings: string[];
}

export default function SettingsPage() {
    const { hasRole } = useAuth();
    const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [tokenCheckState, setTokenCheckState] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
    const [tokenCheckMessage, setTokenCheckMessage] = useState('');

    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pwdState, setPwdState] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
    const [pwdMessage, setPwdMessage] = useState('');

    const loadReadiness = useCallback(async () => {
        setLoading(true);
        try {
            const response = await api.get('/system/readiness');
            setReadiness(response.data);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!hasRole('supervisor')) return;
        void loadReadiness();
    }, [hasRole, loadReadiness]);

    const runBrowserTokenCheck = async () => {
        setTokenCheckState('running');
        setTokenCheckMessage('');

        try {
            const response = await api.post('/system/signalwire/browser-token-test');
            setTokenCheckState('success');
            setTokenCheckMessage(`SignalWire browser token issued: ${response.data.tokenPreview}`);
        } catch (error: any) {
            setTokenCheckState('error');
            setTokenCheckMessage(error.response?.data?.error || 'Browser token test failed.');
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword !== confirmPassword) {
            setPwdState('error');
            setPwdMessage('New passwords do not match.');
            return;
        }
        if (newPassword.length < 8) {
            setPwdState('error');
            setPwdMessage('New password must be at least 8 characters.');
            return;
        }
        setPwdState('running');
        setPwdMessage('');
        try {
            await api.post('/auth/change-password', { currentPassword, newPassword });
            setPwdState('success');
            setPwdMessage('Password successfully updated.');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err: any) {
            setPwdState('error');
            setPwdMessage(err.response?.data?.error || 'Failed to change password.');
        }
    };

    return (
        <div className="workspace-shell">
            <div className="page-header">
                <div>
                    <h1>Settings & Security</h1>
                    <div className="topline">Manage your account security and view system diagnostic information.</div>
                </div>
                {hasRole('supervisor') && (
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-secondary" onClick={() => loadReadiness()} disabled={loading}>Refresh Diagnostics</button>
                        <button className="btn btn-primary" onClick={runBrowserTokenCheck} disabled={tokenCheckState === 'running'} style={{ color: '#fff' }}>
                            {tokenCheckState === 'running' ? 'Testing...' : 'Test Browser Token'}
                        </button>
                    </div>
                )}
            </div>

            <div className="glass-panel" style={{ padding: 18, marginBottom: 20 }}>
                <div className="status-row" style={{ marginBottom: 14 }}>
                    <h3>Security Focus</h3>
                    <span className="topline mono">Password Management</span>
                </div>
                
                {pwdMessage && (
                    <div className={pwdState === 'success' ? 'notice notice-info' : 'notice notice-error'} style={{ marginBottom: 16 }}>
                        {pwdMessage}
                    </div>
                )}

                <form onSubmit={handleChangePassword} style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 300px)', gap: 12 }}>
                    <div>
                        <label className="topline" style={{ display: 'block', marginBottom: 4 }}>Current Password</label>
                        <input type="password" required className="input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                    </div>
                    <div>
                        <label className="topline" style={{ display: 'block', marginBottom: 4 }}>New Password (min 8 chars)</label>
                        <input type="password" required minLength={8} className="input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </div>
                    <div>
                        <label className="topline" style={{ display: 'block', marginBottom: 4 }}>Confirm New Password</label>
                        <input type="password" required minLength={8} className="input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={pwdState === 'running' || !currentPassword || !newPassword || !confirmPassword} style={{ marginTop: 8, padding: '10px 0' }}>
                        {pwdState === 'running' ? 'Updating...' : 'Change Password'}
                    </button>
                </form>
            </div>

            {!hasRole('supervisor') ? (
                <div className="notice notice-info">System diagnostics are restricted to supervisor accounts only.</div>
            ) : loading || !readiness ? (
                <div className="glass-panel" style={{ padding: 24 }}>
                    <div className="topline">Loading readiness data...</div>
                </div>
            ) : (
                <>
                    {readiness.warnings.length > 0 && (
                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Warnings</h3>
                                <span className="status-badge status-break">Action Needed</span>
                            </div>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {readiness.warnings.map((warning) => (
                                    <div key={warning} className="notice notice-error">{warning}</div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(160px, 1fr))', gap: 10 }}>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Telephony Provider</div>
                            <div className="mono" style={{ marginTop: 8, fontSize: '1.6rem', fontWeight: 700 }}>{readiness.providers.telephony.selected}</div>
                        </div>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">SignalWire</div>
                            <div style={{ marginTop: 8, fontSize: '1.6rem', fontWeight: 700, color: readiness.providers.telephony.signalwireConfigured ? 'var(--status-available)' : 'var(--status-offline)' }}>
                                {readiness.providers.telephony.signalwireConfigured ? 'Ready' : 'Missing'}
                            </div>
                        </div>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Agent Extensions</div>
                            <div className="mono" style={{ marginTop: 8, fontSize: '1.6rem', fontWeight: 700 }}>
                                {readiness.staffing.agentsWithExtensions}/{readiness.staffing.totalAgents}
                            </div>
                        </div>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Public URL</div>
                            <div style={{ marginTop: 8, fontSize: '1.6rem', fontWeight: 700, color: readiness.environment.backendPublicUrlConfigured ? 'var(--status-available)' : 'var(--status-break)' }}>
                                {readiness.environment.backendPublicUrlConfigured ? 'Configured' : 'Derived'}
                            </div>
                        </div>
                    </div>

                    <div className="glass-panel" style={{ padding: 18 }}>
                        <div className="status-row" style={{ marginBottom: 10 }}>
                            <h3>Environment</h3>
                            <span className="topline mono">{readiness.environment.nodeEnv}</span>
                        </div>
                        <table className="data-table">
                            <tbody>
                                <tr><td>Backend Base URL</td><td className="mono">{readiness.environment.backendBaseUrl}</td></tr>
                                <tr><td>Frontend URL</td><td className="mono">{readiness.environment.frontendUrl}</td></tr>
                                <tr><td>Port</td><td className="mono">{readiness.environment.port}</td></tr>
                                <tr><td>Dialer Mode</td><td className="mono">{readiness.environment.dialerMode}</td></tr>
                                <tr><td>SignalWire Space</td><td className="mono">{readiness.providers.telephony.signalwireSpaceUrl || '-'}</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Webhook Endpoints</h3>
                                <span className="status-badge status-available">SignalWire</span>
                            </div>
                            <table className="data-table">
                                <tbody>
                                    <tr><td>Inbound</td><td className="mono">{readiness.providers.telephony.inboundWebhookUrl}</td></tr>
                                    <tr><td>Call Status</td><td className="mono">{readiness.providers.telephony.callStatusWebhookUrl}</td></tr>
                                    <tr><td>Recording</td><td className="mono">{readiness.providers.telephony.recordingWebhookUrl}</td></tr>
                                    <tr><td>Transcription</td><td className="mono">{readiness.providers.telephony.transcriptionWebhookUrl}</td></tr>
                                    <tr><td>AMD</td><td className="mono">{readiness.providers.telephony.amdWebhookUrl}</td></tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Provider Status</h3>
                            </div>
                            <table className="data-table">
                                <tbody>
                                    <tr><td>Telephony</td><td className="mono">{readiness.providers.telephony.selected}</td></tr>
                                    <tr><td>Browser Token</td><td className="mono">{readiness.providers.telephony.browserTokenCapable ? 'Enabled' : 'Unavailable'}</td></tr>
                                    <tr><td>Softphone Transport</td><td className="mono">{readiness.providers.telephony.softphoneTransport}</td></tr>
                                    <tr><td>Live Human Outbound</td><td className="mono">{readiness.providers.telephony.humanBrowserOutboundSupported ? 'Supported' : 'Blocked'}</td></tr>
                                    <tr><td>AI Provider</td><td className="mono">{readiness.providers.ai.selected}</td></tr>
                                    <tr><td>Retell</td><td className="mono">{readiness.providers.ai.retellConfigured ? 'Configured' : 'Not Configured'}</td></tr>
                                    <tr><td>CRM</td><td className="mono">{readiness.providers.crm.configured ? 'Configured' : 'Stub Mode'}</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Agent Endpoint Readiness</h3>
                                <span className="topline mono">{readiness.staffing.totalAgents} users</span>
                            </div>
                            {readiness.staffing.missingExtensions.length === 0 ? (
                                <div className="notice notice-info">All dial-capable users have extensions configured.</div>
                            ) : (
                                <table className="data-table">
                                    <thead>
                                        <tr><th>Name</th><th>Role</th><th>Status</th></tr>
                                    </thead>
                                    <tbody>
                                        {readiness.staffing.missingExtensions.map((agent) => (
                                            <tr key={agent.id}>
                                                <td>{agent.name}</td>
                                                <td className="mono">{agent.role}</td>
                                                <td className="mono">{agent.status}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>

                        <div className="glass-panel" style={{ padding: 18 }}>
                            <div className="status-row" style={{ marginBottom: 10 }}>
                                <h3>Queue and Campaign Snapshot</h3>
                            </div>
                            <div className="topline" style={{ marginBottom: 8 }}>{readiness.queues.length} active queues</div>
                            <table className="data-table" style={{ marginBottom: 12 }}>
                                <thead>
                                    <tr><th>Queue</th><th>Hold</th><th>Overflow</th></tr>
                                </thead>
                                <tbody>
                                    {readiness.queues.map((queue) => (
                                        <tr key={queue.id}>
                                            <td>{queue.name}</td>
                                            <td className="mono">{queue.holdTimeout}s</td>
                                            <td className="mono">{queue.overflowAction}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="topline" style={{ marginBottom: 8 }}>{readiness.campaigns.length} active campaigns</div>
                            <table className="data-table">
                                <thead>
                                    <tr><th>Name</th><th>Mode</th><th>AI</th></tr>
                                </thead>
                                <tbody>
                                    {readiness.campaigns.map((campaign) => (
                                        <tr key={campaign.id}>
                                            <td>{campaign.name}</td>
                                            <td className="mono">{campaign.dialMode}</td>
                                            <td className="mono">{campaign.aiTargetEnabled ? 'On' : 'Off'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="glass-panel" style={{ padding: 18 }}>
                        <div className="status-row" style={{ marginBottom: 10 }}>
                            <h3>Number Inventory</h3>
                            <span className="topline mono">{readiness.phoneNumbers.totalActive} active numbers</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div>
                                <div className="topline" style={{ marginBottom: 8 }}>Outbound</div>
                                <table className="data-table">
                                    <thead>
                                        <tr><th>Number</th><th>Type</th><th>Assigned</th></tr>
                                    </thead>
                                    <tbody>
                                        {readiness.phoneNumbers.outbound.map((record) => (
                                            <tr key={`out-${record.number}`}>
                                                <td className="mono">{record.number}</td>
                                                <td className="mono">{record.type}</td>
                                                <td>{record.assignedTo || '-'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div>
                                <div className="topline" style={{ marginBottom: 8 }}>Inbound</div>
                                <table className="data-table">
                                    <thead>
                                        <tr><th>Number</th><th>Type</th><th>Assigned</th></tr>
                                    </thead>
                                    <tbody>
                                        {readiness.phoneNumbers.inbound.map((record) => (
                                            <tr key={`in-${record.number}`}>
                                                <td className="mono">{record.number}</td>
                                                <td className="mono">{record.type}</td>
                                                <td>{record.assignedTo || '-'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
