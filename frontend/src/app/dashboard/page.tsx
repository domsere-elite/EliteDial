'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useCallTimer } from '@/hooks/useCallTimer';
import api from '@/lib/api';

/* ── Types ─────────────────────────────────────────────────────────── */

interface CallRecord {
    id: string;
    direction: string;
    fromNumber: string;
    toNumber: string;
    status: string;
    duration: number;
    accountName?: string;
    accountId?: string;
    createdAt: string;
    agent?: { firstName: string; lastName: string };
}

interface CRMAccount {
    accountId: string;
    accountName: string;
    debtorName: string;
    balance: number;
    status: string;
}

interface Disposition {
    id: string;
    code: string;
    label: string;
}

type CallState = 'idle' | 'ringing' | 'connected' | 'wrap-up';

/* ── Helpers ───────────────────────────────────────────────────────── */

function fmtDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtShortTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtShortDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function DashboardPage() {
    const { user } = useAuth();
    const timer = useCallTimer();

    const [callState, setCallState] = useState<CallState>('idle');
    const [activeCall, setActiveCall] = useState<CallRecord | null>(null);
    const [recentCalls, setRecentCalls] = useState<CallRecord[]>([]);
    const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
    const [crmData, setCrmData] = useState<CRMAccount | null>(null);
    const [crmLoading, setCrmLoading] = useState(false);
    const [dispositions, setDispositions] = useState<Disposition[]>([]);
    const [selectedDispositionId, setSelectedDispositionId] = useState('');
    const [dispositionNote, setDispositionNote] = useState('');
    const [dialPadOpen, setDialPadOpen] = useState(false);
    const [dialNumber, setDialNumber] = useState('');
    const [dialing, setDialing] = useState(false);

    /* ── Data fetching ─────────────────────────────────────────────── */

    const fetchRecentCalls = useCallback(async () => {
        try {
            const { data } = await api.get('/calls', { params: { direction: 'inbound', limit: 15 } });
            setRecentCalls(Array.isArray(data) ? data : data.calls ?? []);
        } catch { /* silent */ }
    }, []);

    const fetchDispositions = useCallback(async () => {
        try {
            const { data } = await api.get('/admin/dispositions');
            setDispositions(Array.isArray(data) ? data : data.dispositions ?? []);
        } catch { /* silent */ }
    }, []);

    const lookupCRM = useCallback(async (phone: string) => {
        setCrmLoading(true);
        setCrmData(null);
        try {
            const { data } = await api.get(`/calls/lookup/phone/${encodeURIComponent(phone)}`);
            setCrmData(data ?? null);
        } catch {
            setCrmData(null);
        } finally {
            setCrmLoading(false);
        }
    }, []);

    // On mount: fetch recent calls + dispositions
    useEffect(() => {
        fetchRecentCalls();
        fetchDispositions();
    }, [fetchRecentCalls, fetchDispositions]);

    // Poll recent calls every 15s
    useEffect(() => {
        const id = setInterval(fetchRecentCalls, 15_000);
        return () => clearInterval(id);
    }, [fetchRecentCalls]);

    // CRM lookup when active call changes or a call is selected
    useEffect(() => {
        const phone = activeCall?.fromNumber ?? selectedCall?.fromNumber;
        if (phone) lookupCRM(phone);
        else setCrmData(null);
    }, [activeCall?.fromNumber, selectedCall?.fromNumber, lookupCRM]);

    /* ── Call actions (stubs — softphone wired later) ──────────────── */

    const handleHangup = () => {
        const dur = timer.stop();
        if (activeCall) setActiveCall({ ...activeCall, duration: dur, status: 'completed' });
        setCallState('wrap-up');
    };

    const handleDispositionSubmit = async () => {
        if (!activeCall || !selectedDispositionId) return;
        try {
            await api.post(`/calls/${activeCall.id}/disposition`, {
                dispositionId: selectedDispositionId,
                notes: dispositionNote,
            });
        } catch { /* silent */ }
        setCallState('idle');
        setActiveCall(null);
        setSelectedDispositionId('');
        setDispositionNote('');
        fetchRecentCalls();
    };

    const handleOutboundDial = async () => {
        if (!dialNumber.trim() || dialing) return;
        setDialing(true);
        try {
            const { data } = await api.post('/calls/initiate', {
                toNumber: dialNumber.trim(),
                mode: 'agent',
            });
            setActiveCall({
                id: data.callId,
                direction: 'outbound',
                fromNumber: data.fromNumber || '',
                toNumber: dialNumber.trim(),
                status: 'ringing',
                duration: 0,
                createdAt: new Date().toISOString(),
            });
            setCallState('ringing');
            timer.start();
            setTimeout(() => {
                setCallState('connected');
            }, 2000);
            setDialPadOpen(false);
        } catch (err: any) {
            const msg = err?.response?.data?.error || 'Call failed';
            alert(msg);
        } finally {
            setDialing(false);
        }
    };

    const pushDigit = (digit: string) => setDialNumber((n) => n + digit);

    /* ── Derived data ──────────────────────────────────────────────── */

    const focusPhone = activeCall?.fromNumber ?? selectedCall?.fromNumber ?? null;

    const callHistoryForPhone = focusPhone
        ? recentCalls.filter((c) => c.fromNumber === focusPhone).slice(0, 5)
        : [];

    /* ── Render ─────────────────────────────────────────────────────── */

    return (
        <div className="workspace-shell">
            {/* Header */}
            <div className="page-header">
                <div>
                    <h1 style={{ fontFamily: 'var(--font-headline)' }}>Inbound Hub</h1>
                    <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                        Receive calls and view account context.
                    </p>
                </div>
            </div>

            {/* Collapsible Dial Pad */}
            <div className="glass-panel" style={{ padding: dialPadOpen ? 20 : '10px 16px', transition: 'padding 0.2s ease' }}>
                <div
                    className="status-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => callState === 'idle' && setDialPadOpen(!dialPadOpen)}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="nav-glyph" style={{ width: 24, height: 24, fontSize: '0.6rem' }}>
                            {dialPadOpen ? '\u25B2' : '\u260E'}
                        </span>
                        <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                            {dialPadOpen ? 'Outbound Dial' : 'Make a Call'}
                        </span>
                    </div>
                    {!dialPadOpen && dialNumber && (
                        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>{dialNumber}</span>
                    )}
                </div>

                {dialPadOpen && (
                    <div style={{ marginTop: 14 }}>
                        <div className="softphone-number" style={{ marginBottom: 12 }}>
                            <input
                                type="text"
                                value={dialNumber}
                                onChange={(e) => setDialNumber(e.target.value)}
                                placeholder="Enter number..."
                                style={{ fontSize: '1.2rem' }}
                            />
                        </div>

                        <div className="dial-pad" style={{ maxWidth: 260, margin: '0 auto 14px' }}>
                            {['1','2','3','4','5','6','7','8','9','*','0','#'].map((d) => (
                                <button key={d} className="dial-key" onClick={() => pushDigit(d)}>
                                    <span style={{ fontSize: '1.1rem', fontWeight: 700 }}>{d}</span>
                                </button>
                            ))}
                        </div>

                        <div style={{ display: 'flex', gap: 8 }}>
                            <button
                                className="call-btn call-btn-dial"
                                style={{ flex: 1 }}
                                disabled={!dialNumber.trim() || dialing || callState !== 'idle'}
                                onClick={handleOutboundDial}
                            >
                                {dialing ? 'Dialing...' : 'Call'}
                            </button>
                            <button
                                className="btn btn-secondary"
                                onClick={() => { setDialNumber(''); setDialPadOpen(false); }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Two-column layout */}
            <div className="workspace">
                {/* ── LEFT COLUMN ───────────────────────────────────── */}
                <div className="workspace-column">
                    {/* Active Call Card */}
                    <div className="glass-panel call-card-primary workspace-panel call-card">
                        {callState === 'idle' ? (
                            <div style={{ padding: '24px 0' }}>
                                <p className="topline" style={{ marginBottom: 6 }}>STATUS</p>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem' }}>
                                    Waiting for inbound calls...
                                </p>
                            </div>
                        ) : (
                            <>
                                <span className={`status-badge status-badge--${callState === 'ringing' ? 'warning' : callState === 'connected' ? 'success' : 'info'}`}>
                                    {callState}
                                </span>
                                <p className="mono" style={{ fontSize: '1.6rem', letterSpacing: '-0.03em' }}>
                                    {activeCall?.fromNumber ?? '\u2014'}
                                </p>
                                {callState === 'connected' && (
                                    <p className="call-timer">{timer.formatted}</p>
                                )}
                                <div className="call-controls">
                                    <button className="call-btn call-btn-hangup" onClick={handleHangup}>
                                        Hang Up
                                    </button>
                                    <button className="call-control-btn">Hold</button>
                                    <button className="call-control-btn">Mute</button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Recent Inbound Calls */}
                    <div className="glass-panel workspace-panel" style={{ flex: 1, overflow: 'hidden' }}>
                        <div className="panel-heading">
                            <h3>Recent Inbound Calls</h3>
                        </div>
                        <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 440px)' }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Caller</th>
                                        <th>Account</th>
                                        <th>Status</th>
                                        <th>Dur</th>
                                        <th>Time</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recentCalls.length === 0 && (
                                        <tr>
                                            <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                                                No recent inbound calls
                                            </td>
                                        </tr>
                                    )}
                                    {recentCalls.map((call) => (
                                        <tr
                                            key={call.id}
                                            onClick={() => setSelectedCall(call)}
                                            style={{
                                                cursor: 'pointer',
                                                background: selectedCall?.id === call.id ? 'rgba(0,88,188,0.06)' : undefined,
                                            }}
                                        >
                                            <td className="mono">{call.fromNumber}</td>
                                            <td>{call.accountName ?? 'Unknown'}</td>
                                            <td><span className="status-badge">{call.status}</span></td>
                                            <td>{fmtDuration(call.duration)}</td>
                                            <td>{fmtShortTime(call.createdAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                {/* ── RIGHT COLUMN ──────────────────────────────────── */}
                <div className="workspace-column">
                    {/* Screen Pop -- Account Data */}
                    <div className="glass-panel workspace-panel">
                        <div className="panel-heading">
                            <h3>Account Details</h3>
                        </div>
                        {!focusPhone && (
                            <div className="notice notice-info">Select a call to view account details.</div>
                        )}
                        {focusPhone && crmLoading && (
                            <p style={{ color: 'var(--text-muted)' }}>Looking up account...</p>
                        )}
                        {focusPhone && !crmLoading && !crmData && (
                            <div className="notice notice-info">No account found for this number.</div>
                        )}
                        {crmData && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <p style={{ fontSize: '1.28rem', fontWeight: 700, fontFamily: 'var(--font-headline)' }}>
                                    {crmData.debtorName}
                                </p>
                                <div className="status-row">
                                    <span className="topline">ACCOUNT ID</span>
                                    <span className="mono">{crmData.accountId}</span>
                                </div>
                                <div className="status-row">
                                    <span className="topline">BALANCE</span>
                                    <span className="mono" style={{ color: 'var(--accent-red)' }}>
                                        {fmtCurrency(crmData.balance)}
                                    </span>
                                </div>
                                <div className="status-row">
                                    <span className="topline">STATUS</span>
                                    <span className="status-badge">{crmData.status}</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Call History for selected number */}
                    <div className="glass-panel workspace-panel">
                        <div className="panel-heading">
                            <h3>Call History</h3>
                            {focusPhone && (
                                <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                                    {focusPhone}
                                </span>
                            )}
                        </div>
                        {callHistoryForPhone.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                                {focusPhone ? 'No previous calls.' : 'Select a call to view history.'}
                            </p>
                        ) : (
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Dir</th>
                                        <th>Status</th>
                                        <th>Dur</th>
                                        <th>Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {callHistoryForPhone.map((c) => (
                                        <tr key={c.id}>
                                            <td>{c.direction}</td>
                                            <td><span className="status-badge">{c.status}</span></td>
                                            <td>{fmtDuration(c.duration)}</td>
                                            <td>{fmtShortDate(c.createdAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* Disposition Form -- only during wrap-up */}
                    {callState === 'wrap-up' && (
                        <div className="glass-panel workspace-panel">
                            <div className="panel-heading">
                                <h3>Disposition</h3>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                <select
                                    className="select"
                                    value={selectedDispositionId}
                                    onChange={(e) => setSelectedDispositionId(e.target.value)}
                                >
                                    <option value="">Select disposition...</option>
                                    {dispositions.map((d) => (
                                        <option key={d.id} value={d.id}>{d.label}</option>
                                    ))}
                                </select>
                                <textarea
                                    className="input"
                                    rows={3}
                                    placeholder="Call notes..."
                                    value={dispositionNote}
                                    onChange={(e) => setDispositionNote(e.target.value)}
                                />
                                <button
                                    className="btn btn-primary"
                                    disabled={!selectedDispositionId}
                                    onClick={handleDispositionSubmit}
                                >
                                    Submit Disposition
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
