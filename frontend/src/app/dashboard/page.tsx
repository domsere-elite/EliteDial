'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useCallTimer } from '@/hooks/useCallTimer';
import { useSignalWire } from '@/hooks/useSignalWire';
import { useSignalWireRelay } from '@/hooks/useSignalWireRelay';
import api from '@/lib/api';

interface CallRecord {
    id: string;
    direction: string;
    fromNumber: string;
    toNumber: string;
    status: string;
    duration: number;
    accountName: string;
    createdAt: string;
}

interface AuditEvent {
    id: string;
    timestamp: string;
    type: string;
    callId?: string;
    callSid?: string;
    details?: Record<string, string | number | boolean | null | undefined>;
}

interface DispositionCode {
    id: string;
    code: string;
    label: string;
}

interface CampaignContact {
    id: string;
    firstName: string;
    lastName: string;
    primaryPhone: string;
    campaignId: string;
    metaData?: Record<string, unknown>;
}

interface CRMAccountPreview {
    accountId: string;
    accountName: string;
    debtorName: string;
    balance: number;
    status: string;
    metadata?: Record<string, unknown>;
}

interface RuntimeTelephonyState {
    dialerMode: 'mock' | 'live';
    telephonyProvider: string;
    humanOutboundSupported: boolean;
    softphoneTransport: string;
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export default function WorkspacePage() {
    const { user, updateStatus, hasRole } = useAuth();
    const timer = useCallTimer();
    const swFabric = useSignalWire();
    const swRelay = useSignalWireRelay();

    const [dialMode, setDialMode] = useState<'predictive' | 'preview' | 'manual' | 'ai'>('manual');
    const [dialNumber, setDialNumber] = useState('');
    const [selectedFromNumber, setSelectedFromNumber] = useState('');
    const [outboundNumbers, setOutboundNumbers] = useState<string[]>([]);
    const [crmPreview, setCrmPreview] = useState<CRMAccountPreview | null>(null);
    const [crmLoading, setCrmLoading] = useState(false);
    const [callState, setCallState] = useState<'idle' | 'dialing' | 'connected' | 'wrap-up'>('idle');
    const [activeCall, setActiveCall] = useState<{ callId?: string } | null>(null);
    const [recentCalls, setRecentCalls] = useState<CallRecord[]>([]);
    const [dispositions, setDispositions] = useState<DispositionCode[]>([]);
    const [selectedDispositionId, setSelectedDispositionId] = useState('');
    const [dispositionNote, setDispositionNote] = useState('');
    const [dncWarning, setDncWarning] = useState('');
    const [callAudit, setCallAudit] = useState<AuditEvent[]>([]);
    const [recentAudit, setRecentAudit] = useState<AuditEvent[]>([]);
    const [simScenario, setSimScenario] = useState<'answer' | 'no-answer' | 'voicemail'>('answer');
    const [outboundScenario, setOutboundScenario] = useState<'answer' | 'no-answer' | 'voicemail'>('answer');
    const [aiScenario, setAiScenario] = useState<'transfer' | 'no-answer' | 'voicemail'>('transfer');
    const [campaignContact, setCampaignContact] = useState<CampaignContact | null>(null);
    const [campaignReservationToken, setCampaignReservationToken] = useState<string | null>(null);
    const [loadingContact, setLoadingContact] = useState(false);
    const [predictiveRunning, setPredictiveRunning] = useState(false);
    const [campaignName, setCampaignName] = useState('');
    const [runtimeTelephony, setRuntimeTelephony] = useState<RuntimeTelephonyState>({
        dialerMode: 'mock',
        telephonyProvider: 'mock',
        humanOutboundSupported: true,
        softphoneTransport: 'mock',
    });
    const [keypadOpen, setKeypadOpen] = useState(true);
    const [fdcpaConfirmed, setFdcpaConfirmed] = useState(false);
    const [transferModalOpen, setTransferModalOpen] = useState(false);
    const [transferTarget, setTransferTarget] = useState('');
    const [callbackDate, setCallbackDate] = useState('');
    const softphone = runtimeTelephony.softphoneTransport === 'relay-v2' ? swRelay : swFabric;

    const loadData = useCallback(async () => {
        try {
            const [callsRes, dispRes, numbersRes, readinessRes] = await Promise.all([
                api.get('/calls?limit=20'),
                api.get('/admin/dispositions'),
                api.get('/calls/outbound-numbers'),
                api.get('/system/readiness'),
            ]);
            setRecentCalls(callsRes.data.calls || []);
            setDispositions(dispRes.data || []);
            const numbers = (numbersRes.data?.numbers || []) as string[];
            setOutboundNumbers(numbers);
            setSelectedFromNumber((current) => current || numbers[0] || '+15551000002');
            setRuntimeTelephony({
                dialerMode: readinessRes.data?.environment?.dialerMode || 'mock',
                telephonyProvider: readinessRes.data?.providers?.telephony?.selected || 'mock',
                humanOutboundSupported: readinessRes.data?.providers?.telephony?.humanBrowserOutboundSupported ?? true,
                softphoneTransport: readinessRes.data?.providers?.telephony?.softphoneTransport || 'mock',
            });
        } catch {
            // no-op
        }
    }, []);

    useEffect(() => { void loadData(); }, [loadData]);

    useEffect(() => {
        if (runtimeTelephony.dialerMode === 'live' && runtimeTelephony.telephonyProvider === 'signalwire') {
            void softphone.connect();
        }
    }, [runtimeTelephony.dialerMode, runtimeTelephony.telephonyProvider, softphone.connect]);

    useEffect(() => {
        const activeCallId = activeCall?.callId;
        if (!activeCallId) {
            setCallAudit([]);
            return;
        }

        const syncActiveCall = async () => {
            try {
                const [callRes, auditRes] = await Promise.all([
                    api.get(`/calls/${activeCallId}`),
                    api.get(`/calls/${activeCallId}/audit?limit=50`),
                ]);

                const call = callRes.data as CallRecord;
                const auditEvents = (auditRes.data?.events || []) as AuditEvent[];
                setCallAudit(auditEvents);

                if (['initiated', 'ringing'].includes(call.status) && (callState === 'idle' || callState === 'dialing')) {
                    setCallState('dialing');
                }

                if (call.status === 'in-progress' && (callState === 'idle' || callState === 'dialing')) {
                    setCallState('connected');
                    timer.start();
                    void updateStatus('on-call');
                }

                if (['completed', 'failed', 'no-answer', 'busy', 'voicemail'].includes(call.status) && callState !== 'wrap-up') {
                    timer.stop();
                    setCallState('wrap-up');
                    void updateStatus('available');
                }
            } catch {
                // no-op
            }
        };

        void syncActiveCall();
        const interval = setInterval(syncActiveCall, 2500);
        return () => clearInterval(interval);
    }, [activeCall?.callId, callState, timer.stop, updateStatus]);

    useEffect(() => {
        const loadRecentAudit = async () => {
            try {
                const res = await api.get('/calls/audit/recent?limit=12');
                setRecentAudit(res.data?.events || []);
            } catch {
                // no-op
            }
        };

        void loadRecentAudit();
        const interval = setInterval(loadRecentAudit, 8000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (runtimeTelephony.softphoneTransport === 'relay-v2') {
            return;
        }

        if (callState !== 'dialing' || !activeCall?.callId || !softphone.incomingCall) {
            return;
        }

        let cancelled = false;

        const answerSoftphoneLeg = async () => {
            try {
                await softphone.acceptIncoming();
                if (!cancelled) {
                    setDncWarning('');
                }
            } catch {
                if (!cancelled) {
                    setDncWarning('Answer the softphone prompt to complete this outbound call.');
                }
            }
        };

        void answerSoftphoneLeg();

        return () => {
            cancelled = true;
        };
    }, [activeCall?.callId, callState, runtimeTelephony.softphoneTransport, softphone.acceptIncoming, softphone.incomingCall]);

    useEffect(() => {
        if (!dialNumber) {
            setCrmPreview(null);
            return;
        }

        const timeout = setTimeout(async () => {
            setCrmLoading(true);
            try {
                const res = await api.get(`/calls/lookup/phone/${encodeURIComponent(dialNumber)}`);
                setCrmPreview(res.data?.account || null);
            } catch {
                setCrmPreview(null);
            } finally {
                setCrmLoading(false);
            }
        }, 350);

        return () => clearTimeout(timeout);
    }, [dialNumber]);

    const runSimScenario = async () => {
        if (simScenario === 'answer') {
            softphone.simulateIncomingCall();
            return;
        }

        try {
            const res = await api.post('/calls/simulate/inbound', { scenario: simScenario });
            setActiveCall({ callId: res.data.callId });
            setDialNumber('');
            setCallState('wrap-up');
            timer.stop();
            await updateStatus('available');
            await loadData();
        } catch {
            // no-op
        }
    };

    const handleNextLead = async () => {
        setLoadingContact(true);
        setCampaignContact(null);
        setDncWarning('');
        try {
            const res = await api.get('/campaigns/active/next-contact');
            if (res.data.contact) {
                setCampaignContact(res.data.contact);
                setCampaignReservationToken(res.data.reservationToken || null);
                setCampaignName(res.data.campaign?.name || 'Campaign');
                setDialNumber(res.data.contact.primaryPhone);
            } else {
                setDncWarning(res.data.message || 'No available contacts.');
            }
        } catch {
            setDncWarning('Failed to fetch next lead.');
        } finally {
            setLoadingContact(false);
        }
    };

    const handleDial = async () => {
        if (!dialNumber) {
            setDncWarning('Enter a phone number before starting a call.');
            return;
        }

        if (callState !== 'idle') {
            setDncWarning('A call is already active or wrapping up.');
            return;
        }
        setDncWarning('');

        try {
            if (isLiveTelephony && runtimeTelephony.softphoneTransport === 'relay-v2' && dialMode !== 'ai') {
                const res = await api.post('/calls/browser-session', {
                    toNumber: dialNumber,
                    fromNumber: selectedFromNumber || undefined,
                    campaignContactId: campaignContact?.id,
                    reservationToken: campaignReservationToken || undefined,
                    accountId: crmPreview?.accountId,
                    accountName: crmPreview?.accountName,
                });

                if (res.data.dncBlocked) {
                    setDncWarning('Number is on DNC list. Call blocked.');
                    return;
                }

                setCallState('dialing');
                setActiveCall(res.data);
                await softphone.dial(dialNumber, res.data.fromNumber || selectedFromNumber || '', res.data.callId);
                return;
            }

            const res = await api.post('/calls/initiate', {
                toNumber: dialNumber,
                fromNumber: selectedFromNumber || undefined,
                mode: dialMode === 'ai' ? 'ai' : 'agent',
                aiTarget: dialMode === 'ai' ? 'mock-human-queue' : undefined,
                campaignContactId: campaignContact?.id,
                reservationToken: campaignReservationToken || undefined,
                accountId: crmPreview?.accountId,
                accountName: crmPreview?.accountName,
                mockScenario: dialMode === 'ai' ? aiScenario : outboundScenario,
            });

            if (res.data.dncBlocked) {
                setDncWarning('Number is on DNC list. Call blocked.');
                return;
            }

            setCallState('dialing');
            setActiveCall(res.data);
        } catch (err: any) {
            if (err.response?.data?.dncBlocked) {
                setDncWarning('Number is on DNC list. Call blocked.');
                return;
            }
            setDncWarning(err.response?.data?.error || 'Call failed to start.');
        }
    };

    const runPredictiveCycle = async () => {
        if (!hasRole('supervisor') || predictiveRunning) return;
        setPredictiveRunning(true);
        setDncWarning('');

        try {
            await api.post('/campaigns/dialer/run-now');
            await loadData();
        } catch {
            setDncWarning('Predictive cycle failed to run.');
        } finally {
            setPredictiveRunning(false);
        }
    };

    const handleHangup = async () => {
        timer.stop();
        setCallState('wrap-up');
        await updateStatus('available');
        await softphone.hangup();

        if (activeCall?.callId) {
            try {
                await api.post(`/calls/${activeCall.callId}/hangup`);
            } catch {
                // no-op
            }
        }
    };

    const closeWrapUp = () => {
        setCallState('idle');
        setActiveCall(null);
        setSelectedDispositionId('');
        setDispositionNote('');
        setCampaignContact(null);
        setCampaignReservationToken(null);
        setCampaignName('');
        setDialNumber('');
        setCrmPreview(null);
        setFdcpaConfirmed(false);
        setTransferModalOpen(false);
        setTransferTarget('');
        setCallbackDate('');
        timer.reset();
        void loadData();
    };

    const submitDisposition = async () => {
        if (!selectedDispositionId || !activeCall?.callId) return;

        const selectedCode = dispositions.find(d => d.id === selectedDispositionId)?.code || '';
        const requiresFdcpa = !['NA', 'VM', 'BUSY', 'DROP', 'FAILED'].includes(selectedCode);

        if (requiresFdcpa && !fdcpaConfirmed) {
            setDncWarning('Compliance Error: You must confirm FDCPA Mini-Miranda delivery before disposing this connected call.');
            return;
        }

        try {
            await api.post(`/calls/${activeCall.callId}/disposition`, {
                dispositionId: selectedDispositionId,
                note: dispositionNote,
                callbackAt: callbackDate && selectedCode.includes('CB') ? new Date(callbackDate).toISOString() : undefined,
            });
        } catch {
            // no-op
        }
        closeWrapUp();
    };

    const handleTransfer = async () => {
        if (!activeCall?.callId || !transferTarget) return;
        try {
            await api.post(`/calls/${activeCall.callId}/transfer`, {
                targetNumber: transferTarget,
                type: 'cold'
            });
            setTransferModalOpen(false);
            setTransferTarget('');
            await handleHangup();
        } catch (err: any) {
            setDncWarning(err.response?.data?.error || 'Transfer failed.');
        }
    };

    const pushDialDigit = (digit: string) => {
        setDialNumber((current) => {
            if (digit === '+') {
                return current.startsWith('+') ? current : `+${current}`;
            }

            const normalized = current.replace(/[^\d+]/g, '');
            if (digit === 'backspace') {
                return normalized.slice(0, -1);
            }

            return `${normalized}${digit}`;
        });
    };

    const clearDialNumber = () => {
        setDialNumber('');
    };

    const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const formatPhoneDisplay = (value: string) => {
        const digits = value.replace(/\D/g, '');
        if (digits.length >= 10) {
            const normalized = digits.length === 11 ? digits.slice(1) : digits.slice(-10);
            return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6, 10)}`;
        }
        return value || '(000) 000-0000';
    };
    const callerName = campaignContact
        ? `${campaignContact.firstName || ''} ${campaignContact.lastName || ''}`.trim()
        : (crmPreview?.debtorName || (dialNumber ? 'CRM Match Pending' : 'No Lead Selected'));
    const callerInitials = callerName
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('') || 'ED';
    const accountMetadata = (crmPreview?.metadata as Record<string, unknown> | undefined)
        || (campaignContact?.metaData as Record<string, unknown> | undefined);
    const readMetadataNumber = (key: string) => {
        const value = accountMetadata?.[key];
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const parsed = Number(value.replace(/[^0-9.-]/g, ''));
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    };
    const totalDebt = crmPreview?.balance || 0;
    const lastPayment = readMetadataNumber('lastPaymentAmount') ?? readMetadataNumber('lastPayment') ?? 0;
    const daysPastDue = readMetadataNumber('daysPastDue');
    const isLiveTelephony = runtimeTelephony.telephonyProvider === 'signalwire' && runtimeTelephony.dialerMode === 'live';
    const liveHumanOutboundBlocked = isLiveTelephony && dialMode !== 'ai' && !runtimeTelephony.humanOutboundSupported;
    const currentEvents = activeCall?.callId ? callAudit : recentAudit;
    const dialerTitle = callState === 'connected'
        ? 'Active Call'
        : callState === 'dialing'
            ? 'Dialing'
            : dialMode === 'predictive'
                ? 'Predictive Queue'
                : dialMode === 'preview'
                    ? 'Preview Lead'
                    : dialMode === 'ai'
                        ? 'AI Outbound'
                        : 'Dialer Ready';
    const recentTimeline = recentCalls.slice(0, 4);
    const keypadDigits: Array<[string, string]> = [
        ['1', '_'],
        ['2', 'ABC'],
        ['3', 'DEF'],
        ['4', 'GHI'],
        ['5', 'JKL'],
        ['6', 'MNO'],
        ['7', 'PQRS'],
        ['8', 'TUV'],
        ['9', 'WXYZ'],
        ['*', ''],
        ['0', '+'],
        ['#', ''],
    ];
    const modeSummary = {
        predictive: 'Safe-paced campaign execution based on available agents and guardrails.',
        preview: 'Reserve one lead, review context, and dial only when ready.',
        manual: 'Direct outbound call flow over SignalWire Relay with your approved ANI.',
        ai: 'Separate AI outbound path with mock routing until Retell is configured.',
    }[dialMode];
    const callButtonLabel = dialMode === 'ai'
        ? 'Launch AI Call'
        : dialMode === 'preview'
            ? 'Call Recipient'
            : 'Start Call';

    return (
        <div className="workspace-shell">
            <div className="page-header precision-page-header">
                <div>
                    <div className="header-group">
                        <span className={`status-badge ${user?.status === 'available' ? 'status-available' : user?.status === 'on-call' ? 'status-on-call' : 'status-break'}`}>
                            {user?.status === 'on-call' ? 'On Call' : 'Live Dialing'}
                        </span>
                        {campaignName ? <span className="status-badge status-available">{campaignName}</span> : null}
                        {crmPreview?.accountId ? <span className="status-badge status-on-call">{crmPreview.accountId}</span> : null}
                    </div>
                    <h1>Main Dialer</h1>
                    <div className="topline">Manual, preview, predictive, and AI outbound operations from a single live workspace.</div>
                </div>
                <div className="precision-header-stats">
                    <div className="campaign-stat-card">
                        <div className="label">Daily Recovery Total</div>
                        <div className="value">{currency.format(totalDebt || 0)}</div>
                    </div>
                    <div className="campaign-stat-card">
                        <div className="label">Outbound Dials</div>
                        <div className="value">{recentCalls.length}</div>
                    </div>
                    <div className="campaign-stat-card">
                        <div className="label">Lookup Status</div>
                        <div className="value">{crmLoading ? '...' : (crmPreview ? 'Ready' : 'Pending')}</div>
                    </div>
                </div>
            </div>

            {softphone.error && <div className="notice notice-error">SignalWire softphone: {softphone.error}</div>}
            {!softphone.connected && isLiveTelephony && (
                <div className="notice notice-info status-row">
                    <div>
                        <div className="topline">Softphone Connection</div>
                        <div className="mono" style={{ fontSize: '0.92rem', marginTop: 2 }}>
                            {runtimeTelephony.softphoneTransport === 'relay-v2'
                                ? 'Browser softphone connects through SignalWire Relay v2 using a short-lived JWT minted by your backend.'
                                : 'Browser softphone auto-connects with an approved existing endpoint. New SignalWire subscriber creation remains blocked unless you explicitly approve it.'}
                        </div>
                    </div>
                    <button className="btn btn-primary" onClick={() => softphone.connect()} style={{ color: '#fff' }}>
                        Retry Softphone Connect
                    </button>
                </div>
            )}
            {dncWarning && <div className="notice notice-error">{dncWarning}</div>}
            {isLiveTelephony && (
                <div className="notice notice-info">
                    Live SignalWire mode is active. Outbound calls use your real configured number and no longer use mock call scenarios.
                </div>
            )}
            {liveHumanOutboundBlocked && (
                <div className="notice notice-error">
                    Live human outbound is currently blocked. This workspace is using SignalWire softphone transport `{runtimeTelephony.softphoneTransport}`, which can connect the browser but cannot complete PSTN/SIP manual outbound. Migrate the agent leg to a SIP endpoint or Relay v2 before using live manual dialing.
                </div>
            )}
            {!softphone.incomingCall && callState === 'idle' && (
                <div className="notice notice-info status-row">
                    <div>
                        <div className="topline">Dev Telephony Simulator</div>
                        <div className="mono" style={{ fontSize: '0.92rem', marginTop: 2 }}>Create a synthetic inbound ring without paid SignalWire minutes.</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <select className="select" value={simScenario} onChange={(e) => setSimScenario(e.target.value as 'answer' | 'no-answer' | 'voicemail')}>
                            <option value="answer">Answer Flow</option>
                            <option value="no-answer">No-Answer Flow</option>
                            <option value="voicemail">Voicemail Flow</option>
                        </select>
                        <button className="btn" onClick={runSimScenario} style={{ background: 'var(--accent-blue)' }}>
                            Run Scenario
                        </button>
                    </div>
                </div>
            )}

            {softphone.incomingCall && (callState === 'idle' || (callState === 'dialing' && !!activeCall?.callId)) && (
                <div className="notice notice-info status-row">
                    <div>
                        <div className="topline">{callState === 'dialing' ? 'Softphone Connection Needed' : 'Incoming Call'}</div>
                        <div className="mono" style={{ fontSize: '1rem', marginTop: 2 }}>{softphone.incomingCall.callerNumber}</div>
                        {callState === 'dialing' && (
                            <div className="mono" style={{ fontSize: '0.88rem', marginTop: 4 }}>
                                {runtimeTelephony.softphoneTransport === 'relay-v2'
                                    ? 'Relay v2 is placing the outbound call directly from the browser.'
                                    : 'Answer this browser leg so SignalWire can bridge your outbound call.'}
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-danger" onClick={softphone.rejectIncoming}>
                            {callState === 'dialing' ? 'Decline Softphone' : 'Decline'}
                        </button>
                        <button
                            className="btn btn-success"
                            onClick={async () => {
                                const inbound = softphone.incomingCall;
                                await softphone.acceptIncoming();
                                if (callState === 'dialing') {
                                    setDncWarning('');
                                } else {
                                    setDialNumber(inbound?.callerNumber || '');
                                    setCallState('connected');
                                    timer.start();
                                    await updateStatus('on-call');
                                }

                                if (inbound?.callSid) {
                                    try {
                                        const attachRes = await api.post('/calls/inbound/attach', {
                                            callSid: inbound.callSid,
                                            fromNumber: inbound.callerNumber,
                                            toNumber: inbound.toNumber,
                                        });
                                        setActiveCall({ callId: attachRes.data.callId });
                                    } catch {
                                        // no-op
                                    }
                                }
                            }}
                        >
                            Answer
                        </button>
                    </div>
                </div>
            )}

            <div className="workspace">
                <div className="workspace-column">
                    <div className="glass-panel workspace-panel call-card-primary">
                        <div className="tab-bar" style={{ marginBottom: 12 }}>
                            <button className={`tab ${dialMode === 'predictive' ? 'active' : ''}`} onClick={() => setDialMode('predictive')}>Predictive</button>
                            <button className={`tab ${dialMode === 'preview' ? 'active' : ''}`} onClick={() => setDialMode('preview')}>Preview</button>
                            <button className={`tab ${dialMode === 'manual' ? 'active' : ''}`} onClick={() => setDialMode('manual')}>Manual</button>
                            <button className={`tab ${dialMode === 'ai' ? 'active' : ''}`} onClick={() => setDialMode('ai')}>AI Outbound</button>
                        </div>

                        <div className="call-card" style={{ minHeight: 260 }}>
                            <span className={`status-badge ${callState === 'connected' ? 'status-available' : 'status-on-call'}`}>{callState === 'connected' ? 'Connected' : 'Dialer Ready'}</span>
                            <div className="call-timer">{callState === 'connected' ? timer.formatted : '00:00'}</div>
                            <div className="topline">Call Duration</div>
                            <div className="call-controls">
                                <button className={`call-control-btn ${softphone.muted ? 'active' : ''}`} onClick={softphone.toggleMute}>Mute</button>
                                <button className={`call-control-btn ${softphone.held ? 'active' : ''}`} onClick={softphone.toggleHold}>Hold</button>
                                <button className={`call-control-btn ${keypadOpen ? 'active' : ''}`} onClick={() => setKeypadOpen((open) => !open)}>Keypad</button>
                                <button className={`call-control-btn ${transferModalOpen ? 'active' : ''}`} onClick={() => setTransferModalOpen(!transferModalOpen)}>Xfer</button>
                            </div>

                            {transferModalOpen && (
                                <div className="glass-panel" style={{ marginTop: 8, padding: 12 }}>
                                    <div className="topline" style={{ marginBottom: 6 }}>Transfer Call</div>
                                    <input 
                                        className="input" 
                                        placeholder="Target Number (e.g. +1...)" 
                                        value={transferTarget}
                                        onChange={(e) => setTransferTarget(e.target.value)}
                                        style={{ width: '100%', marginBottom: 8 }}
                                    />
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button className="btn btn-secondary" onClick={() => setTransferModalOpen(false)} style={{ flex: 1 }}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleTransfer} disabled={!transferTarget} style={{ flex: 1 }}>Cold Transfer</button>
                                    </div>
                                </div>
                            )}

                            {callState === 'idle' ? (
                                <>
                                    {dialMode === 'predictive' ? (
                                        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                                            <div className="topline">
                                                Run one local predictive worker cycle against active campaigns without live carrier traffic.
                                            </div>
                                            <button className="call-btn call-btn-dial" onClick={runPredictiveCycle} disabled={!hasRole('supervisor') || predictiveRunning}>
                                                {predictiveRunning ? 'Running Predictive Cycle...' : 'Run Predictive Cycle'}
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <select className="select" value={selectedFromNumber} onChange={(e) => setSelectedFromNumber(e.target.value)} style={{ marginTop: 8 }}>
                                                {outboundNumbers.map((number) => (
                                                    <option key={number} value={number}>{number}</option>
                                                ))}
                                            </select>
                                            <div className="softphone-number" style={{ width: '100%', marginTop: 6 }}>
                                                <input className="mono" value={dialNumber} onChange={(e) => setDialNumber(e.target.value)} placeholder="Enter number, e.g. +18327979834" disabled={dialMode === 'preview' && !!campaignContact} />
                                            </div>
                                            {keypadOpen && (
                                                <div className="glass-panel" style={{ marginTop: 8, padding: 12 }}>
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                                                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0', 'backspace'].map((digit) => (
                                                            <button
                                                                key={digit}
                                                                className="call-control-btn"
                                                                onClick={() => pushDialDigit(digit)}
                                                                style={{ width: '100%', minHeight: 46 }}
                                                            >
                                                                {digit === 'backspace' ? '⌫' : digit}
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                                                        <span className="topline">Use keypad or type directly into the number field.</span>
                                                        <button className="btn btn-secondary btn-sm" onClick={clearDialNumber}>Clear</button>
                                                    </div>
                                                </div>
                                            )}
                                            {dialMode === 'ai' ? (
                                                <select className="select" value={aiScenario} onChange={(e) => setAiScenario(e.target.value as 'transfer' | 'no-answer' | 'voicemail')} style={{ marginTop: 6 }}>
                                                    <option value="transfer">Mock AI: Transfer</option>
                                                    <option value="no-answer">Mock AI: No Answer</option>
                                                    <option value="voicemail">Mock AI: Voicemail</option>
                                                </select>
                                            ) : !isLiveTelephony ? (
                                                <select className="select" value={outboundScenario} onChange={(e) => setOutboundScenario(e.target.value as 'answer' | 'no-answer' | 'voicemail')} style={{ marginTop: 6 }}>
                                                    <option value="answer">Mock Outbound: Answered</option>
                                                    <option value="no-answer">Mock Outbound: No Answer</option>
                                                    <option value="voicemail">Mock Outbound: Voicemail</option>
                                                </select>
                                            ) : (
                                                <div className="topline" style={{ marginTop: 10 }}>
                                                    Live outbound via SignalWire using {selectedFromNumber || 'configured ANI'}.
                                                </div>
                                            )}
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                {dialMode === 'preview' && !campaignContact && (
                                                    <button className="btn" onClick={handleNextLead} disabled={loadingContact} style={{ flex: 1, background: 'var(--accent-blue)' }}>
                                                        {loadingContact ? 'Fetching...' : 'Next Lead'}
                                                    </button>
                                                )}
                                                <button className="call-btn call-btn-dial" onClick={handleDial} disabled={!dialNumber || liveHumanOutboundBlocked} style={{ flex: 1 }}>
                                                    {dialMode === 'ai' ? 'Start AI Call' : 'Start Call'}
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </>
                            ) : (
                                <button className="call-btn call-btn-hangup" onClick={handleHangup}>End Call</button>
                            )}
                        </div>
                    </div>

                    <div className="glass-panel workspace-panel panel-subtle">
                        <div className="panel-heading">
                            <h3>Account Snapshot</h3>
                            <span className="topline mono">{crmPreview?.accountId || 'No Match'}</span>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: '1.02rem' }}>{callerName}</div>
                        <div className="mono" style={{ marginTop: 6, color: 'var(--accent-blue)' }}>{dialNumber || ''}</div>
                        <div className="topline" style={{ marginTop: 8 }}>
                            {crmPreview?.accountName || 'No CRM match'} • {crmPreview?.status || 'Unverified'}
                        </div>
                    </div>

                    <div className="glass-panel workspace-panel panel-subtle" style={{ minHeight: 180 }}>
                        <div className="panel-heading">
                            <h3>Opening Script</h3>
                            <span className="topline">Consumer Verification</span>
                        </div>
                        <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                            <div><span style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>Agent:</span> Hello, am I speaking with {callerName !== 'No Lead Selected' ? callerName : 'the customer'}?</div>
                            <div style={{ marginTop: 8 }}><span style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>Agent:</span> This is Elite Portfolio Management on a recorded line regarding account {crmPreview?.accountId || 'verification'}. For verification, can you confirm your date of birth?</div>
                        </div>
                        {callState === 'connected' && dialMode !== 'ai' && (
                            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                                <input 
                                    type="checkbox" 
                                    id="fdcpa-checkbox"
                                    checked={fdcpaConfirmed} 
                                    onChange={(e) => setFdcpaConfirmed(e.target.checked)}
                                    style={{ width: 16, height: 16 }}
                                />
                                <label htmlFor="fdcpa-checkbox" style={{ fontSize: '0.88rem', fontWeight: 600, color: fdcpaConfirmed ? 'var(--accent-green)' : 'var(--accent-red)', cursor: 'pointer' }}>
                                    I have delivered the required FDCPA Mini-Miranda disclosure.
                                </label>
                            </div>
                        )}
                    </div>
                </div>

                <div className="workspace-column">
                    <div className="workspace-kpi-grid">
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Total Balance</div>
                            <div className="mono" style={{ fontSize: '2rem', marginTop: 8, fontWeight: 700 }}>
                                {crmPreview ? currency.format(crmPreview.balance) : '$0.00'}
                            </div>
                            <div className="topline" style={{ marginTop: 4, color: 'var(--accent-red)' }}>{crmPreview ? crmPreview.accountName : 'Awaiting CRM match'}</div>
                        </div>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Account Status</div>
                            <div className="mono" style={{ fontSize: '2rem', marginTop: 8, fontWeight: 700 }}>{crmPreview?.status || '--'}</div>
                            <div className="topline" style={{ marginTop: 4 }}>Live CRM context</div>
                        </div>
                        <div className="glass-panel workspace-panel">
                            <div className="topline">Lookup Health</div>
                            <div style={{ fontSize: '2rem', marginTop: 8, fontWeight: 700, color: crmPreview ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                {crmLoading ? '...' : (crmPreview ? 'Matched' : 'Pending')}
                            </div>
                            <div className="topline" style={{ marginTop: 4 }}>Phone-to-account resolution</div>
                        </div>
                    </div>

                    <div className="glass-panel workspace-panel" style={{ flex: 1 }}>
                        <div className="panel-heading">
                            <h3>Account Timeline</h3>
                            <span className="topline">Recent Call Activity</span>
                        </div>
                        <div className="tab-bar" style={{ marginBottom: 10 }}>
                            <button className="tab active">Overview &amp; History</button>
                            <button className="tab">Payment Options</button>
                            <button className="tab">Documents</button>
                            <button className="tab">Skip Tracing</button>
                        </div>
                        <div style={{ overflow: 'auto' }}>
                            <table className="data-table">
                                <thead>
                                    <tr><th>Date</th><th>Type</th><th>Outcome</th><th>Agent</th><th>Note</th></tr>
                                </thead>
                                <tbody>
                                    {recentCalls.slice(0, 6).map((call) => (
                                        <tr key={call.id}>
                                            <td className="mono">{new Date(call.createdAt).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                                            <td>{call.direction === 'outbound' ? 'Outbound Call' : 'Inbound Call'}</td>
                                            <td>
                                                <span className={`status-badge ${call.status === 'completed' ? 'status-available' : call.status === 'no-answer' ? 'status-offline' : 'status-break'}`}>{call.status}</span>
                                            </td>
                                            <td>{user?.firstName || 'System'}</td>
                                            <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{call.accountName || 'Call note not captured'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="glass-panel workspace-panel">
                        <div className="panel-heading">
                            <h3>Call Disposition</h3>
                            <span className="topline">{callState === 'wrap-up' ? 'Wrap Up Ready' : 'Pending Call End'}</span>
                        </div>
                        {callState === 'wrap-up' ? (
                            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.6fr auto', gap: 8 }}>
                                <select className="select" value={selectedDispositionId} onChange={(e) => setSelectedDispositionId(e.target.value)}>
                                    <option value="">Select Outcome...</option>
                                    {dispositions.map((d) => <option key={d.id} value={d.id}>{d.code} - {d.label}</option>)}
                                </select>
                                {dispositions.find(d => d.id === selectedDispositionId)?.code?.includes('CB') ? (
                                    <input type="datetime-local" className="input" value={callbackDate} onChange={(e) => setCallbackDate(e.target.value)} />
                                ) : (
                                    <input className="input" placeholder="mm/dd/yyyy (N/A)" disabled />
                                )}
                                <input className="input" value={dispositionNote} onChange={(e) => setDispositionNote(e.target.value)} placeholder="Enter call details..." />
                                <button 
                                    className="btn btn-primary" 
                                    onClick={activeCall?.callId ? submitDisposition : closeWrapUp}
                                >
                                    Submit
                                </button>
                            </div>
                        ) : (
                            <div className="topline">Disposition form appears after call end.</div>
                        )}
                    </div>

                    <div className="glass-panel workspace-panel" style={{ maxHeight: 250, overflow: 'auto' }}>
                        <div className="panel-heading">
                            <h3>Call Flow Audit</h3>
                            <span className="topline mono">Persistent</span>
                        </div>
                        {(activeCall?.callId ? callAudit : recentAudit).length === 0 ? (
                            <div className="topline">No call events captured yet.</div>
                        ) : (
                            <table className="data-table">
                                <thead>
                                    <tr><th>Time</th><th>Event</th><th>Details</th></tr>
                                </thead>
                                <tbody>
                                    {(activeCall?.callId ? callAudit : recentAudit).map((event) => (
                                        <tr key={event.id}>
                                            <td className="mono">{new Date(event.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                                            <td className="mono">{event.type}</td>
                                            <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {event.details ? Object.entries(event.details).map(([k, v]) => `${k}:${String(v)}`).join(' | ') : (event.callSid || '--')}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
