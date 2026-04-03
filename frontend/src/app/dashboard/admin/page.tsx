'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { ROLES } from '@/lib/constants';

interface Agent {
    id: string;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    status: string;
    extension: string | null;
    createdAt: string;
}

interface PhoneNum {
    id: string;
    number: string;
    label: string | null;
    type: string;
    assignedTo: string | null;
    isActive: boolean;
}

interface DNCRec {
    id: string;
    phoneNumber: string;
    reason: string | null;
    addedBy: string | null;
    createdAt: string;
}

interface QueueRec {
    id: string;
    name: string;
    holdTimeout: number;
    overflowAction: string;
    maxQueueSize: number;
    isActive: boolean;
}

interface AgentFormState {
    username: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: string;
    extension: string;
}

interface AgentEditState {
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    extension: string;
}

const emptyAgentForm: AgentFormState = {
    username: '',
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    role: 'agent',
    extension: '',
};

export default function AdminPage() {
    const { hasRole } = useAuth();
    const [tab, setTab] = useState<'agents' | 'phones' | 'dnc' | 'queues'>('agents');

    const [agents, setAgents] = useState<Agent[]>([]);
    const [showAgentForm, setShowAgentForm] = useState(false);
    const [agentForm, setAgentForm] = useState<AgentFormState>(emptyAgentForm);
    const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
    const [agentEdits, setAgentEdits] = useState<Record<string, AgentEditState>>({});

    const [phones, setPhones] = useState<PhoneNum[]>([]);
    const [phoneForm, setPhoneForm] = useState({ number: '', label: '', type: 'local', assignedTo: '' });
    const [showPhoneForm, setShowPhoneForm] = useState(false);

    const [dncEntries, setDncEntries] = useState<DNCRec[]>([]);
    const [dncNumber, setDncNumber] = useState('');
    const [dncReason, setDncReason] = useState('');
    const [dncTotal, setDncTotal] = useState(0);

    const [queues, setQueues] = useState<QueueRec[]>([]);

    const buildAgentEdit = (agent: Agent): AgentEditState => ({
        firstName: agent.firstName,
        lastName: agent.lastName,
        email: agent.email,
        role: agent.role,
        extension: agent.extension || '',
    });

    const loadTab = useCallback(async () => {
        try {
            if (tab === 'agents') {
                const response = await api.get('/admin/agents');
                const nextAgents = response.data as Agent[];
                setAgents(nextAgents);
                setAgentEdits(
                    Object.fromEntries(nextAgents.map((agent) => [agent.id, buildAgentEdit(agent)]))
                );
            }

            if (tab === 'phones') {
                const response = await api.get('/admin/phones');
                setPhones(response.data);
            }

            if (tab === 'dnc') {
                const response = await api.get('/admin/dnc');
                setDncEntries(response.data.entries);
                setDncTotal(response.data.total);
            }

            if (tab === 'queues') {
                const response = await api.get('/admin/queues');
                setQueues(response.data);
            }
        } catch {
            // Intentionally quiet for now; existing admin page follows the same pattern.
        }
    }, [tab]);

    useEffect(() => {
        loadTab();
    }, [loadTab]);

    if (!hasRole('admin')) {
        return <div className="topline" style={{ padding: '60px', textAlign: 'center' }}>Admin access required</div>;
    }

    const createAgent = async () => {
        await api.post('/auth/register', {
            ...agentForm,
            extension: agentForm.extension.trim() || null,
        });
        setShowAgentForm(false);
        setAgentForm(emptyAgentForm);
        await loadTab();
    };

    const startEditingAgent = (agent: Agent) => {
        setEditingAgentId(agent.id);
        setAgentEdits((current) => ({
            ...current,
            [agent.id]: buildAgentEdit(agent),
        }));
    };

    const cancelEditingAgent = (agent: Agent) => {
        setEditingAgentId(null);
        setAgentEdits((current) => ({
            ...current,
            [agent.id]: buildAgentEdit(agent),
        }));
    };

    const updateAgentEdit = (agentId: string, field: keyof AgentEditState, value: string) => {
        setAgentEdits((current) => ({
            ...current,
            [agentId]: {
                firstName: current[agentId]?.firstName || '',
                lastName: current[agentId]?.lastName || '',
                email: current[agentId]?.email || '',
                role: current[agentId]?.role || 'agent',
                extension: current[agentId]?.extension || '',
                [field]: value,
            },
        }));
    };

    const saveAgent = async (agentId: string) => {
        const payload = agentEdits[agentId];
        if (!payload) return;

        await api.put(`/admin/agents/${agentId}`, {
            ...payload,
            extension: payload.extension.trim() || null,
        });
        setEditingAgentId(null);
        await loadTab();
    };

    const deleteAgent = async (id: string) => {
        if (!confirm('Delete this agent?')) return;
        await api.delete(`/admin/agents/${id}`);
        await loadTab();
    };

    const addPhone = async () => {
        await api.post('/admin/phones', phoneForm);
        setShowPhoneForm(false);
        setPhoneForm({ number: '', label: '', type: 'local', assignedTo: '' });
        await loadTab();
    };

    const addDNC = async () => {
        if (!dncNumber) return;
        await api.post('/admin/dnc', { phoneNumber: dncNumber, reason: dncReason });
        setDncNumber('');
        setDncReason('');
        await loadTab();
    };

    const removeDNC = async (phone: string) => {
        await api.delete(`/admin/dnc/${encodeURIComponent(phone)}`);
        await loadTab();
    };

    const tabs = [
        { key: 'agents', label: 'Agents' },
        { key: 'phones', label: 'Phone Numbers' },
        { key: 'dnc', label: 'DNC List' },
        { key: 'queues', label: 'Queues' },
    ] as const;

    return (
        <div className="workspace-shell">
            <div className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <h1>Admin</h1>
                    <div className="topline">Manage users, numbers, compliance suppression, and queue settings.</div>
                </div>
            </div>

            <div className="tab-bar">
                {tabs.map((item) => (
                    <button
                        key={item.key}
                        className={`tab ${tab === item.key ? 'active' : ''}`}
                        onClick={() => setTab(item.key)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            {tab === 'agents' && (
                <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn btn-primary" onClick={() => setShowAgentForm((current) => !current)}>New Agent</button>
                    </div>

                    {showAgentForm && (
                        <div className="glass-panel" style={{ padding: 20 }}>
                            <div className="status-row" style={{ marginBottom: 12 }}>
                                <h3>Create Agent</h3>
                                <span className="topline">Provision user account and extension mapping</span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div>
                                    <label>First Name</label>
                                    <input className="input" value={agentForm.firstName} onChange={(e) => setAgentForm({ ...agentForm, firstName: e.target.value })} />
                                </div>
                                <div>
                                    <label>Last Name</label>
                                    <input className="input" value={agentForm.lastName} onChange={(e) => setAgentForm({ ...agentForm, lastName: e.target.value })} />
                                </div>
                                <div>
                                    <label>Username</label>
                                    <input className="input" value={agentForm.username} onChange={(e) => setAgentForm({ ...agentForm, username: e.target.value })} />
                                </div>
                                <div>
                                    <label>Email</label>
                                    <input className="input" type="email" value={agentForm.email} onChange={(e) => setAgentForm({ ...agentForm, email: e.target.value })} />
                                </div>
                                <div>
                                    <label>Password</label>
                                    <input className="input" type="password" value={agentForm.password} onChange={(e) => setAgentForm({ ...agentForm, password: e.target.value })} />
                                </div>
                                <div>
                                    <label>Role</label>
                                    <select className="select" value={agentForm.role} onChange={(e) => setAgentForm({ ...agentForm, role: e.target.value })}>
                                        {ROLES.map((role) => (
                                            <option key={role.value} value={role.value}>{role.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label>Extension</label>
                                    <input className="input input-mono" value={agentForm.extension} onChange={(e) => setAgentForm({ ...agentForm, extension: e.target.value })} placeholder="1001" />
                                </div>
                            </div>
                            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                                <button className="btn btn-primary" onClick={createAgent}>Create</button>
                                <button className="btn btn-secondary" onClick={() => setShowAgentForm(false)}>Cancel</button>
                            </div>
                        </div>
                    )}

                    <div className="glass-panel" style={{ overflow: 'auto' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Username</th>
                                    <th>Email</th>
                                    <th>Role</th>
                                    <th>Extension</th>
                                    <th>Status</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {agents.map((agent) => (
                                    <tr key={agent.id}>
                                        <td style={{ fontWeight: 700 }}>
                                            {editingAgentId === agent.id ? (
                                                <div style={{ display: 'grid', gap: 8 }}>
                                                    <input className="input" value={agentEdits[agent.id]?.firstName || ''} onChange={(e) => updateAgentEdit(agent.id, 'firstName', e.target.value)} />
                                                    <input className="input" value={agentEdits[agent.id]?.lastName || ''} onChange={(e) => updateAgentEdit(agent.id, 'lastName', e.target.value)} />
                                                </div>
                                            ) : (
                                                <>{agent.firstName} {agent.lastName}</>
                                            )}
                                        </td>
                                        <td className="mono">@{agent.username}</td>
                                        <td>
                                            {editingAgentId === agent.id ? (
                                                <input className="input" value={agentEdits[agent.id]?.email || ''} onChange={(e) => updateAgentEdit(agent.id, 'email', e.target.value)} />
                                            ) : (
                                                agent.email
                                            )}
                                        </td>
                                        <td className="mono" style={{ color: 'var(--accent-indigo)' }}>
                                            {editingAgentId === agent.id ? (
                                                <select className="select" value={agentEdits[agent.id]?.role || agent.role} onChange={(e) => updateAgentEdit(agent.id, 'role', e.target.value)}>
                                                    {ROLES.map((role) => (
                                                        <option key={role.value} value={role.value}>{role.label}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                agent.role
                                            )}
                                        </td>
                                        <td className="mono">
                                            {editingAgentId === agent.id ? (
                                                <input className="input input-mono" value={agentEdits[agent.id]?.extension || ''} onChange={(e) => updateAgentEdit(agent.id, 'extension', e.target.value)} placeholder="1001" />
                                            ) : (
                                                agent.extension || '-'
                                            )}
                                        </td>
                                        <td>
                                            <span className={`status-badge ${agent.status === 'available' ? 'status-available' : agent.status === 'on-call' ? 'status-on-call' : agent.status === 'break' ? 'status-break' : 'status-offline'}`}>
                                                {agent.status}
                                            </span>
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                                {editingAgentId === agent.id ? (
                                                    <>
                                                        <button className="btn btn-primary btn-sm" onClick={() => saveAgent(agent.id)}>Save</button>
                                                        <button className="btn btn-secondary btn-sm" onClick={() => cancelEditingAgent(agent)}>Cancel</button>
                                                    </>
                                                ) : (
                                                    <button className="btn btn-secondary btn-sm" onClick={() => startEditingAgent(agent)}>Edit</button>
                                                )}
                                                <button className="btn btn-danger btn-sm" onClick={() => deleteAgent(agent.id)}>Delete</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {tab === 'phones' && (
                <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn btn-primary" onClick={() => setShowPhoneForm((current) => !current)}>Add Number</button>
                    </div>

                    {showPhoneForm && (
                        <div className="glass-panel" style={{ padding: 20 }}>
                            <h3 style={{ marginBottom: 12 }}>Add Phone Number</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div>
                                    <label>Number</label>
                                    <input className="input input-mono" value={phoneForm.number} onChange={(e) => setPhoneForm({ ...phoneForm, number: e.target.value })} placeholder="+15551234567" />
                                </div>
                                <div>
                                    <label>Label</label>
                                    <input className="input" value={phoneForm.label} onChange={(e) => setPhoneForm({ ...phoneForm, label: e.target.value })} placeholder="Main Line" />
                                </div>
                                <div>
                                    <label>Type</label>
                                    <select className="select" value={phoneForm.type} onChange={(e) => setPhoneForm({ ...phoneForm, type: e.target.value })}>
                                        <option value="local">Local</option>
                                        <option value="toll-free">Toll-Free</option>
                                    </select>
                                </div>
                                <div>
                                    <label>Assigned To</label>
                                    <input className="input" value={phoneForm.assignedTo} onChange={(e) => setPhoneForm({ ...phoneForm, assignedTo: e.target.value })} placeholder="agents" />
                                </div>
                            </div>
                            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                                <button className="btn btn-primary" onClick={addPhone}>Save</button>
                                <button className="btn btn-secondary" onClick={() => setShowPhoneForm(false)}>Cancel</button>
                            </div>
                        </div>
                    )}

                    <div className="glass-panel" style={{ overflow: 'auto' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Number</th>
                                    <th>Label</th>
                                    <th>Type</th>
                                    <th>Assigned To</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {phones.map((phone) => (
                                    <tr key={phone.id}>
                                        <td className="mono">{phone.number}</td>
                                        <td>{phone.label || '-'}</td>
                                        <td className="mono">{phone.type}</td>
                                        <td>{phone.assignedTo || '-'}</td>
                                        <td>
                                            <span className={`status-badge ${phone.isActive ? 'status-available' : 'status-offline'}`}>
                                                {phone.isActive ? 'Active' : 'Inactive'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {tab === 'dnc' && (
                <>
                    <div className="glass-panel" style={{ padding: 18 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
                            <div>
                                <label>Phone Number</label>
                                <input className="input input-mono" value={dncNumber} onChange={(e) => setDncNumber(e.target.value)} placeholder="+15551234567" />
                            </div>
                            <div>
                                <label>Reason</label>
                                <input className="input" value={dncReason} onChange={(e) => setDncReason(e.target.value)} placeholder="Customer request" />
                            </div>
                            <button className="btn btn-danger" onClick={addDNC}>Add to DNC</button>
                        </div>
                    </div>

                    <div className="topline mono">{dncTotal} numbers currently suppressed</div>

                    <div className="glass-panel" style={{ overflow: 'auto' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Phone Number</th>
                                    <th>Reason</th>
                                    <th>Added By</th>
                                    <th>Date</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {dncEntries.map((entry) => (
                                    <tr key={entry.id}>
                                        <td className="mono">{entry.phoneNumber}</td>
                                        <td>{entry.reason || '-'}</td>
                                        <td className="mono">{entry.addedBy || '-'}</td>
                                        <td className="mono topline">{new Date(entry.createdAt).toLocaleDateString()}</td>
                                        <td><button className="btn btn-secondary btn-sm" onClick={() => removeDNC(entry.phoneNumber)}>Remove</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {tab === 'queues' && (
                <div className="glass-panel" style={{ overflow: 'auto' }}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Queue</th>
                                <th>Hold Timeout</th>
                                <th>Overflow Action</th>
                                <th>Max Size</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {queues.map((queue) => (
                                <tr key={queue.id}>
                                    <td style={{ fontWeight: 700 }}>{queue.name}</td>
                                    <td className="mono">{queue.holdTimeout}s</td>
                                    <td className="mono">{queue.overflowAction}</td>
                                    <td className="mono">{queue.maxQueueSize}</td>
                                    <td>
                                        <span className={`status-badge ${queue.isActive ? 'status-available' : 'status-offline'}`}>
                                            {queue.isActive ? 'Active' : 'Inactive'}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
