'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useCallTimer } from '@/hooks/useCallTimer';
import { useSignalWire } from '@/hooks/useSignalWire';
import { useRealtime } from '@/components/RealtimeProvider';
import { useProfileStatus } from '@/hooks/useProfileStatus';
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

interface LastCallContext {
    callId: string;
    fromNumber: string;
    toNumber: string;
    duration: number;
    direction: 'inbound' | 'outbound';
}

type CallStatusEvent = {
    callId: string;
    status: string;
    agentId?: string;
    providerCallId?: string;
    duration?: number;
};

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
    const sw = useSignalWire();
    const { on, off, connected: socketConnected } = useRealtime();
    const profile = useProfileStatus();

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
    const [transferTarget, setTransferTarget] = useState('');
    const [transferring, setTransferring] = useState(false);
    const [secondsLeft, setSecondsLeft] = useState(0);

    const wasOnCallRef = useRef(false);
    const activeOutboundContextRef = useRef<{ toNumber: string; fromNumber: string } | null>(null);
    // Persists across the call-end → wrap-up transition so the disposition handler
    // can POST to /api/calls/<id>/disposition after sw.callId has been cleared.
    const lastCallContextRef = useRef<LastCallContext | null>(null);

    /* ── Connect SDK on mount ─────────────────────────────────────── */
    useEffect(() => {
        sw.connect();
    }, [sw]);

    /* ── Data fetching ─────────────────────────────────────────────── */

    const fetchRecentCalls = useCallback(async () => {
        try {
            const { data } = await api.get('/calls', { params: { limit: 20 } });
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

    useEffect(() => {
        fetchRecentCalls();
        fetchDispositions();
    }, [fetchRecentCalls, fetchDispositions]);

    /* ── Real-time call status events ─────────────────────────────── */
    useEffect(() => {
        const handler = (..._args: unknown[]) => {
            // any call status change should refresh recent list
            void fetchRecentCalls();
        };
        on('call:status', handler);
        return () => off('call:status', handler);
    }, [on, off, fetchRecentCalls]);

    /* ── Detect call-end → capture context for disposition handler ──── */
    // The wrap-up phase itself is now driven server-side via useProfileStatus;
    // this effect just runs the timer and records the just-ended call so the
    // disposition POST can find its callId after sw.callId has been cleared.
    useEffect(() => {
        if (sw.onCall) {
            if (!wasOnCallRef.current) {
                wasOnCallRef.current = true;
                timer.start();
            }
            return;
        }
        if (wasOnCallRef.current && !sw.onCall && !sw.ringing && !sw.incomingCall) {
            const dur = timer.stop();
            const callId = sw.callId;
            const ctx = activeOutboundContextRef.current;
            if (callId) {
                lastCallContextRef.current = {
                    callId,
                    fromNumber: ctx?.fromNumber || '',
                    toNumber: ctx?.toNumber || sw.currentNumber,
                    duration: dur,
                    direction: ctx ? 'outbound' : 'inbound',
                };
            }
            wasOnCallRef.current = false;
            activeOutboundContextRef.current = null;
            void fetchRecentCalls();
        }
    }, [sw.onCall, sw.ringing, sw.incomingCall, sw.callId, sw.currentNumber, timer, fetchRecentCalls]);

    /* ── Wrap-up countdown (drives the visible timer in the disposition panel) */
    useEffect(() => {
        if (!profile.wrapUpUntil) { setSecondsLeft(0); return; }
        const tick = () => {
            const remaining = Math.max(0, Math.ceil((profile.wrapUpUntil!.getTime() - Date.now()) / 1000));
            setSecondsLeft(remaining);
        };
        tick();
        const id = setInterval(tick, 250);
        return () => clearInterval(id);
    }, [profile.wrapUpUntil]);

    /* ── CRM lookup follows live call or selection ─────────────────── */
    useEffect(() => {
        const phone = sw.incomingCall?.callerNumber
            || (sw.onCall || sw.ringing ? sw.currentNumber : null)
            || selectedCall?.fromNumber
            || null;
        if (phone) lookupCRM(phone);
        else setCrmData(null);
    }, [sw.incomingCall?.callerNumber, sw.onCall, sw.ringing, sw.currentNumber, selectedCall?.fromNumber, lookupCRM]);

    /* ── Call actions ─────────────────────────────────────────────── */

    const handleAccept = async () => { await sw.acceptIncoming(); };
    const handleReject = async () => { await sw.rejectIncoming(); };

    const handleHangup = async () => { await sw.hangup(); };

    const handleDispositionSubmit = async () => {
        const ctx = lastCallContextRef.current;
        if (!ctx || !selectedDispositionId) return;
        try {
            await api.post(`/calls/${ctx.callId}/disposition`, {
                dispositionId: selectedDispositionId,
                notes: dispositionNote,
            });
        } catch { /* compliance: log; non-blocking */ }
        try {
            if (user?.id) await api.post(`/agents/${user.id}/ready`);
        } catch { /* sweep + scheduler timer will catch us */ }
        setSelectedDispositionId('');
        setDispositionNote('');
        setTransferTarget('');
        void fetchRecentCalls();
    };

    const handleReadyNow = async () => {
        try {
            if (user?.id) await api.post(`/agents/${user.id}/ready`);
        } catch { /* sweep will catch us */ }
    };

    const handleOutboundDial = async () => {
        const target = dialNumber.trim();
        if (!target || dialing || profile.status === 'wrap-up' || sw.onCall || sw.ringing) return;
        setDialing(true);
        try {
            const result = await sw.dial(target);
            if (result?.callId) {
                activeOutboundContextRef.current = {
                    toNumber: target,
                    fromNumber: result.fromNumber || '',
                };
                setDialPadOpen(false);
                setDialNumber('');
            }
        } finally {
            setDialing(false);
        }
    };

    const handleTransfer = async () => {
        if (!sw.callId || !transferTarget.trim() || transferring) return;
        setTransferring(true);
        try {
            await api.post(`/calls/${sw.callId}/transfer`, {
                targetNumber: transferTarget.trim(),
                type: 'cold',
            });
            setTransferTarget('');
        } catch { /* surfaced via the global error state in sw if needed */ } finally {
            setTransferring(false);
        }
    };

    const pushDigit = (digit: string) => setDialNumber((n) => n + digit);

    /* ── Derived UI state ─────────────────────────────────────────── */

    const phase: 'idle' | 'incoming' | 'outbound-ring' | 'connected' | 'wrap-up' =
        profile.status === 'wrap-up' ? 'wrap-up'
            : sw.incomingCall ? 'incoming'
            : sw.onCall ? 'connected'
            : sw.ringing ? 'outbound-ring'
            : 'idle';

    const dialDisabled = phase !== 'idle' || dialing || !dialNumber.trim();

    const focusPhone = sw.incomingCall?.callerNumber
        || (sw.onCall || sw.ringing ? sw.currentNumber : null)
        || selectedCall?.fromNumber
        || null;

    const callHistoryForPhone = focusPhone
        ? recentCalls.filter((c) => c.fromNumber === focusPhone || c.toNumber === focusPhone).slice(0, 5)
        : [];

    /* ── Render ─────────────────────────────────────────────────────── */

    return (
        <div className="workspace-shell">
            {/* Header */}
            <div className="page-header">
                <div>
                    <h1 style={{ fontFamily: 'var(--font-headline)' }}>Inbound Hub</h1>
                    <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                        {sw.connected ? 'Softphone connected.' : sw.error || 'Connecting softphone...'}
                        {socketConnected ? ' Real-time live.' : ' Real-time offline.'}
                    </p>
                </div>
            </div>

            {sw.error && (
                <div className="notice notice-error" style={{ marginBottom: 12 }}>
                    {sw.error}
                </div>
            )}

            {/* Collapsible Dial Pad */}
            <div className="glass-panel" style={{ padding: dialPadOpen ? 20 : '10px 16px', transition: 'padding 0.2s ease' }}>
                <div
                    className="status-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => phase === 'idle' && setDialPadOpen(!dialPadOpen)}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="nav-glyph" style={{ width: 24, height: 24, fontSize: '0.6rem' }}>
                            {dialPadOpen ? '▲' : '☎'}
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
                                disabled={dialDisabled}
                                onClick={handleOutboundDial}
                            >
                                {dialing ? 'Dialing...' : phase === 'wrap-up' ? 'Submit disposition first' : 'Call'}
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
                        {phase === 'idle' && (
                            <div style={{ padding: '24px 0' }}>
                                <p className="topline" style={{ marginBottom: 6 }}>STATUS</p>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem' }}>
                                    {sw.connected ? 'Idle. Waiting for inbound calls or place an outbound call.' : 'Connecting softphone...'}
                                </p>
                            </div>
                        )}

                        {phase === 'incoming' && sw.incomingCall && (
                            <>
                                <span className="status-badge status-badge--warning">incoming</span>
                                <p className="mono" style={{ fontSize: '1.6rem', letterSpacing: '-0.03em' }}>
                                    {sw.incomingCall.callerNumber}
                                </p>
                                <p style={{ color: 'var(--text-muted)' }}>{sw.incomingCall.callerName}</p>
                                <div className="call-controls">
                                    <button className="call-btn call-btn-accept" onClick={handleAccept}>Accept</button>
                                    <button className="call-btn call-btn-hangup" onClick={handleReject}>Reject</button>
                                </div>
                            </>
                        )}

                        {phase === 'outbound-ring' && (
                            <>
                                <span className="status-badge status-badge--warning">ringing</span>
                                <p className="mono" style={{ fontSize: '1.6rem', letterSpacing: '-0.03em' }}>
                                    {sw.currentNumber || '—'}
                                </p>
                                <p style={{ color: 'var(--text-muted)' }}>Connecting...</p>
                                <div className="call-controls">
                                    <button className="call-btn call-btn-hangup" onClick={handleHangup}>Cancel</button>
                                </div>
                            </>
                        )}

                        {phase === 'connected' && (
                            <>
                                <span className="status-badge status-badge--success">connected</span>
                                <p className="mono" style={{ fontSize: '1.6rem', letterSpacing: '-0.03em' }}>
                                    {sw.currentNumber || '—'}
                                </p>
                                <p className="call-timer">{timer.formatted}</p>
                                <div className="call-controls">
                                    <button className="call-btn call-btn-hangup" onClick={handleHangup}>Hang Up</button>
                                    <button
                                        className={`call-control-btn ${sw.held ? 'active' : ''}`}
                                        onClick={() => sw.toggleHold()}
                                    >
                                        {sw.held ? 'Resume' : 'Hold'}
                                    </button>
                                    <button
                                        className={`call-control-btn ${sw.muted ? 'active' : ''}`}
                                        onClick={() => sw.toggleMute()}
                                    >
                                        {sw.muted ? 'Unmute' : 'Mute'}
                                    </button>
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                    <input
                                        type="text"
                                        value={transferTarget}
                                        onChange={(e) => setTransferTarget(e.target.value)}
                                        placeholder="Cold transfer to..."
                                        className="input"
                                        style={{ flex: 1, fontSize: '0.9rem' }}
                                    />
                                    <button
                                        className="btn btn-secondary"
                                        disabled={!transferTarget.trim() || transferring}
                                        onClick={handleTransfer}
                                    >
                                        {transferring ? 'Transferring...' : 'Transfer'}
                                    </button>
                                </div>
                            </>
                        )}

                        {phase === 'wrap-up' && lastCallContextRef.current && (
                            <>
                                <span className="status-badge status-badge--info">wrap-up</span>
                                <p className="mono" style={{ fontSize: '1.4rem', letterSpacing: '-0.03em' }}>
                                    {lastCallContextRef.current.direction === 'outbound' ? lastCallContextRef.current.toNumber : lastCallContextRef.current.fromNumber}
                                </p>
                                <p style={{ color: 'var(--text-muted)' }}>
                                    Call ended after {fmtDuration(lastCallContextRef.current.duration)}. Submit disposition or click Ready Now.
                                </p>
                            </>
                        )}
                    </div>

                    {/* Recent Calls */}
                    <div className="glass-panel workspace-panel" style={{ flex: 1, overflow: 'hidden' }}>
                        <div className="panel-heading">
                            <h3>Recent Calls</h3>
                        </div>
                        <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 440px)' }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Dir</th>
                                        <th>Number</th>
                                        <th>Account</th>
                                        <th>Status</th>
                                        <th>Dur</th>
                                        <th>Time</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recentCalls.length === 0 && (
                                        <tr>
                                            <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                                                No recent calls
                                            </td>
                                        </tr>
                                    )}
                                    {recentCalls.map((call) => {
                                        const number = call.direction === 'inbound' ? call.fromNumber : call.toNumber;
                                        return (
                                            <tr
                                                key={call.id}
                                                onClick={() => setSelectedCall(call)}
                                                style={{
                                                    cursor: 'pointer',
                                                    background: selectedCall?.id === call.id ? 'rgba(0,88,188,0.06)' : undefined,
                                                }}
                                            >
                                                <td>{call.direction === 'inbound' ? '←' : '→'}</td>
                                                <td className="mono">{number}</td>
                                                <td>{call.accountName ?? 'Unknown'}</td>
                                                <td><span className="status-badge">{call.status}</span></td>
                                                <td>{fmtDuration(call.duration)}</td>
                                                <td>{fmtShortTime(call.createdAt)}</td>
                                            </tr>
                                        );
                                    })}
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
                            <div className="notice notice-info">Select a call or take an inbound call to view account details.</div>
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
                    {phase === 'wrap-up' && (
                        <div className="glass-panel workspace-panel">
                            <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h3>Disposition</h3>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span className="status-badge">
                                        Wrap-up — {secondsLeft}s
                                    </span>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={handleReadyNow}
                                    >
                                        Ready Now
                                    </button>
                                </div>
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
                                    Submit &amp; Next
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
