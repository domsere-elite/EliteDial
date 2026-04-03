'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

type AccountInfo = { accountId: string; accountName: string; debtorName: string; balance: number; status: string; phoneNumber?: string };
type CallRecord = { id: string; direction: string; fromNumber: string; toNumber: string; status: string; duration: number; createdAt: string; agent?: { firstName: string; lastName: string; username: string } };

type TimelineItem = { title: string; detail: string; time: string; kind: 'call' | 'email' | 'history' };

const demoAccount: AccountInfo = { accountId: 'ACC-001', accountName: 'Johnson Account', debtorName: 'Marcus Johnson', balance: 12480.5, status: 'active', phoneNumber: '+15551234567' };

export default function AccountsPage() {
  const { hasRole } = useAuth();
  const [query, setQuery] = useState('+15551234567');
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(demoAccount);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('Promise to Pay');
  const [amount, setAmount] = useState('$250.00');
  const [followUp, setFollowUp] = useState('');

  const loadAccount = useCallback(async (phone: string) => {
    setLoading(true);
    try {
      const lookup = (await api.get(`/calls/lookup/phone/${encodeURIComponent(phone)}`)).data?.account as AccountInfo | null;
      const resolved = lookup || demoAccount;
      setAccount(resolved);
      const callsRes = await api.get(`/calls?accountId=${encodeURIComponent(resolved.accountId)}&limit=12`);
      setCalls(callsRes.data.calls || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadAccount(query); }, [loadAccount, query]);

  const timeline: TimelineItem[] = [
    { kind: 'call', title: 'Outgoing Call - Connected', time: 'Today, 09:45 AM', detail: 'Spoke with the debtor and reviewed settlement options.' },
    { kind: 'email', title: 'Automated Email Sent', time: 'Yesterday, 02:15 PM', detail: 'Settlement reminder and payment link delivered.' },
    { kind: 'history', title: 'Inbound Call - Missed', time: '14 Oct, 11:30 AM', detail: 'Caller ID matched account. No voicemail left.' },
  ];

  const outstanding = account?.balance || 0;
  const principal = outstanding * 0.72;
  const fees = outstanding - principal;

  if (!hasRole('supervisor') && !hasRole('agent') && !hasRole('admin')) {
    return <div className="workspace-shell"><div className="notice notice-error">Insufficient permissions</div></div>;
  }

  return (
    <div className="workspace-shell account-page">
      <div className="account-topbar glass-panel">
        <div><div className="account-brand">PrecisionDial</div><div className="topline">Account Detail</div></div>
        <div className="account-search"><span className="material-symbols-outlined">search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by phone or account" /></div>
        <div className="account-actions"><button className="btn btn-secondary btn-sm" onClick={() => void loadAccount(query)}>{loading ? 'Loading...' : 'Lookup'}</button><button className="btn btn-primary btn-sm">Initiate Call</button></div>
      </div>

      <section className="hero-card glass-panel">
        <div className="account-avatar">MT</div>
        <div className="hero-copy">
          <div className="section-kicker">{account?.status?.toUpperCase() || 'ACTIVE'}</div>
          <h1>{account?.debtorName || 'Account Holder'}</h1>
          <p>{account?.accountName || 'Account Detail'} · {account?.accountId || 'ACC-0000'} · {account?.phoneNumber || query}</p>
          <div className="hero-buttons"><button className="btn btn-secondary btn-sm">View Documents</button><button className="btn btn-primary btn-sm">Initiate Call</button></div>
        </div>
        <div className="hero-status"><span className="campaign-pill active">TCPA Compliant</span></div>
      </section>

      <section className="kpi-grid">
        <div className="stat-card"><div className="stat-value">${outstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-label">Total Outstanding</div></div>
        <div className="stat-card"><div className="stat-value">${principal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-label">Principal Amount</div></div>
        <div className="stat-card"><div className="stat-value">${fees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div className="stat-label">Interest & Fees</div></div>
        <div className="stat-card"><div className="stat-value">45%</div><div className="stat-label">Recovery Goal</div></div>
      </section>

      <section className="detail-grid">
        <div className="history-col">
          <div className="glass-panel panel-card">
            <div className="panel-head"><h2>Interaction History</h2><div className="topline">Filter, export, and review prior outcomes.</div></div>
            <div className="timeline">{timeline.map((item) => <div key={item.title} className="timeline-item"><div className={`timeline-dot ${item.kind}`} /><div className="timeline-card"><div className="timeline-title">{item.title}</div><div className="timeline-time">{item.time}</div><div className="timeline-detail">{item.detail}</div></div></div>)}</div>
          </div>
          <div className="glass-panel panel-card" style={{ marginTop: 16 }}>
            <div className="panel-head"><h2>Payment History</h2><div className="topline">Recent settlement activity</div></div>
            <div className="payments"><div className="payment-row"><span>$250.00</span><span>02 Oct 2023</span></div><div className="payment-row"><span>$150.00</span><span>15 Sep 2023</span></div></div>
          </div>
        </div>

        <aside className="side-col">
          <div className="glass-panel panel-card">
            <div className="panel-head"><h2>Record Interaction</h2></div>
            <label>Outcome</label>
            <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}><option>Promise to Pay</option><option>Partial Payment</option><option>Refusal to Pay</option><option>Dispute Filed</option><option>Left Message</option></select>
            <label style={{ marginTop: 10 }}>Interaction Notes</label>
            <textarea className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Summarize the call..." />
            <div className="split-fields"><div><label>Amount</label><input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></div><div><label>Date</label><input className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="mm/dd/yyyy" /></div></div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }}>Save Log & Schedule Follow-up</button>
          </div>
          <div className="glass-panel panel-card" style={{ marginTop: 16 }}>
            <div className="panel-head"><h2>Active Status</h2></div>
            <div className="status-strip"><span className="status-badge status-available">Available for Call</span><button className="btn btn-secondary btn-sm">Pause</button><button className="btn btn-primary btn-sm">Call</button></div>
          </div>
        </aside>
      </section>

      <div className="glass-panel panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Recent Calls</h2><div className="topline">{calls.length} loaded from the dialer</div></div>
        <table className="data-table"><thead><tr><th>Time</th><th>Direction</th><th>Status</th><th>Agent</th></tr></thead><tbody>{calls.map((call) => <tr key={call.id}><td className="mono">{new Date(call.createdAt).toLocaleString()}</td><td>{call.direction}</td><td><span className={`campaign-pill ${call.status}`}>{call.status}</span></td><td>{call.agent ? `${call.agent.firstName} ${call.agent.lastName}` : '—'}</td></tr>)}</tbody></table>
      </div>

      <style jsx global>{`
        .account-page { padding-top: 10px; }
        .account-topbar { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; padding: 12px 16px; margin-bottom: 18px; }
        .account-brand { font-family: Manrope, Inter, sans-serif; font-weight: 800; font-size: 1.2rem; color: #0d1c32; letter-spacing: -0.04em; }
        .account-search { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 999px; background: rgba(255,255,255,0.72); }
        .account-search input { width: 100%; border: 0; outline: 0; background: transparent; font: inherit; }
        .account-actions { display: flex; gap: 8px; }
        .hero-card { display: flex; gap: 18px; align-items: center; padding: 22px 24px; margin-bottom: 18px; }
        .account-avatar { width: 72px; height: 72px; border-radius: 20px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0058bc, #004493); color: #fff; font-size: 1.2rem; font-weight: 800; }
        .hero-copy h1 { margin: 0; font-family: Manrope, Inter, sans-serif; font-size: clamp(2rem, 3vw, 2.8rem); letter-spacing: -0.05em; }
        .hero-copy p { margin: 8px 0 0; color: #44474d; }
        .hero-buttons { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
        .hero-status { margin-left: auto; }
        .kpi-grid, .detail-grid { display: grid; gap: 14px; }
        .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 18px; }
        .detail-grid { grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr); }
        .panel-card { padding: 18px; }
        .split-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
        .timeline { display: grid; gap: 14px; margin-top: 10px; }
        .timeline-item { display: grid; grid-template-columns: 18px 1fr; gap: 12px; align-items: start; }
        .timeline-dot { width: 12px; height: 12px; border-radius: 999px; margin-top: 14px; background: #0058bc; box-shadow: 0 0 0 6px rgba(0,88,188,0.06); }
        .timeline-dot.email { background: #0d8d4d; box-shadow: 0 0 0 6px rgba(15,186,99,0.08); }
        .timeline-dot.history { background: #ba1a1a; box-shadow: 0 0 0 6px rgba(186,26,26,0.08); }
        .timeline-card { background: rgba(255,255,255,0.8); border-radius: 18px; padding: 14px 16px; }
        .timeline-title { font-weight: 800; }
        .timeline-time, .timeline-detail { color: #76849f; font-size: 0.8rem; margin-top: 4px; }
        .payments { display: grid; gap: 10px; }
        .payment-row { display: flex; justify-content: space-between; padding: 12px 14px; border-radius: 16px; background: rgba(247,249,251,0.94); }
        .status-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        @media (max-width: 1180px) { .account-topbar, .detail-grid, .kpi-grid { grid-template-columns: 1fr; } .hero-card { flex-wrap: wrap; } .hero-status { margin-left: 0; } }
      `}</style>
    </div>
  );
}
