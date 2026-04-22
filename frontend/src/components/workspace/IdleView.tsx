'use client';

import { useState } from 'react';

interface RecentCall {
  id: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  duration: number;
  accountName: string;
  createdAt: string;
}

interface ShiftStats {
  callsHandled: number;
  avgTalkTime: string;
  paymentsTaken: number;
  contactRate: string;
}

interface IdleViewProps {
  stats: ShiftStats;
  recentCalls: RecentCall[];
  outboundNumbers: string[];
  selectedFromNumber: string;
  onFromNumberChange: (num: string) => void;
  onDial: (number: string) => void;
  dialDisabled: boolean;
}

function getDispositionBadge(status: string) {
  if (['completed', 'in-progress'].includes(status)) return { className: 'badge-green', label: status };
  if (['no-answer', 'busy'].includes(status)) return { className: 'badge-red', label: status };
  if (status === 'voicemail') return { className: 'badge-amber', label: status };
  return { className: 'badge-gray', label: status };
}

export function IdleView({ stats, recentCalls, outboundNumbers, selectedFromNumber, onFromNumberChange, onDial, dialDisabled }: IdleViewProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [dialNumber, setDialNumber] = useState('');

  return (
    <div className="workspace-shell">
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.callsHandled}</div>
          <div className="stat-label">Calls Handled</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.avgTalkTime}</div>
          <div className="stat-label">Avg Talk Time</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.paymentsTaken}</div>
          <div className="stat-label">Payments Taken</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--status-green)' }}>{stats.contactRate}</div>
          <div className="stat-label">Contact Rate</div>
        </div>
      </div>

      <div className="card" style={{ flex: 1 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>Recent Activity</div>
        {recentCalls.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.857rem', padding: '20px 0', textAlign: 'center' }}>No calls yet today</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Disposition</th>
                <th>Name</th>
                <th>Number</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {recentCalls.slice(0, 8).map((call) => {
                const badge = getDispositionBadge(call.status);
                return (
                  <tr key={call.id}>
                    <td><span className={`status-badge ${badge.className}`}>{badge.label}</span></td>
                    <td style={{ fontWeight: 500 }}>{call.accountName || 'Unknown'}</td>
                    <td className="mono" style={{ fontSize: '0.786rem', color: 'var(--text-secondary)' }}>
                      {call.direction === 'outbound' ? call.toNumber : call.fromNumber}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.786rem' }}>
                      {new Date(call.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setManualOpen(!manualOpen)}
        >
          <div className="section-label">Manual Dial</div>
          <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>{manualOpen ? 'Collapse' : 'Expand'}</span>
        </div>
        {manualOpen && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="select"
              value={selectedFromNumber}
              onChange={(e) => onFromNumberChange(e.target.value)}
              style={{ width: 180 }}
            >
              {outboundNumbers.map((num) => (
                <option key={num} value={num}>{num}</option>
              ))}
            </select>
            <input
              className="input"
              value={dialNumber}
              onChange={(e) => setDialNumber(e.target.value)}
              placeholder="Enter number, e.g. +18327979834"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary"
              onClick={() => { onDial(dialNumber); setDialNumber(''); }}
              disabled={!dialNumber || dialDisabled}
            >
              Dial
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
