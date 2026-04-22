'use client';

import { useState } from 'react';
import type { AccountPreview } from '@/hooks/useCallState';
import { AccountCard } from '../account/AccountCard';

interface DispositionCode {
  id: string;
  code: string;
  label: string;
}

interface WrapUpViewProps {
  accountPreview: AccountPreview | null;
  callerNumber: string;
  callerName: string;
  dispositions: DispositionCode[];
  notes: string;
  onNotesChange: (notes: string) => void;
  fdcpaConfirmed: boolean;
  onFdcpaChange: (confirmed: boolean) => void;
  onSubmit: (dispositionId: string, note: string, callbackDate?: string) => void;
  submitError: string;
}

const SKIP_FDCPA_CODES = ['NA', 'VM', 'BUSY', 'DROP', 'FAILED', 'WN', 'DISC', 'DNC', 'LM', 'BK'];

export function WrapUpView({ accountPreview, callerNumber, callerName, dispositions, notes, onNotesChange, fdcpaConfirmed, onFdcpaChange, onSubmit, submitError }: WrapUpViewProps) {
  const [selectedId, setSelectedId] = useState('');
  const [callbackDate, setCallbackDate] = useState('');

  const selectedCode = dispositions.find(d => d.id === selectedId)?.code || '';
  const showCallback = selectedCode.includes('CB');
  const requiresFdcpa = Boolean(selectedCode) && !SKIP_FDCPA_CODES.includes(selectedCode);
  const submitDisabled = !selectedId || (requiresFdcpa && !fdcpaConfirmed);

  return (
    <div className="workspace-body">
      <div className="workspace-sidebar">
        <AccountCard
          preview={accountPreview}
          callerNumber={callerNumber}
          callerName={callerName}
        />
      </div>
      <div className="workspace-main">
        <div className="card" style={{ flex: 1 }}>
          <div className="section-label" style={{ marginBottom: 12, color: 'var(--status-amber-text)' }}>Select Disposition</div>
          <div className="disposition-grid" style={{ marginBottom: 14 }}>
            {dispositions.map((d) => (
              <button
                key={d.id}
                className={`disposition-btn ${selectedId === d.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(d.id)}
              >
                {d.code} - {d.label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Add notes..."
            style={{ marginBottom: 10, minHeight: 60 }}
          />
          {requiresFdcpa && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer', fontSize: '0.857rem', padding: '8px 10px', background: fdcpaConfirmed ? 'var(--status-green-surface)' : 'var(--status-amber-surface)', border: `1px solid ${fdcpaConfirmed ? 'var(--status-green-border)' : 'var(--status-amber-border)'}`, borderRadius: 'var(--radius-sm)' }}>
              <input
                type="checkbox"
                checked={fdcpaConfirmed}
                onChange={(e) => onFdcpaChange(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--status-green)' }}
              />
              <span style={{ fontWeight: 500, color: fdcpaConfirmed ? 'var(--status-green-text)' : 'var(--status-amber-text)' }}>
                I delivered the FDCPA Mini-Miranda during this call
              </span>
            </label>
          )}
          {submitError && (
            <div className="notice notice-error" style={{ marginBottom: 10 }}>{submitError}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {showCallback && (
              <input
                type="datetime-local"
                className="input"
                value={callbackDate}
                onChange={(e) => setCallbackDate(e.target.value)}
                style={{ flex: 1 }}
              />
            )}
            <button
              className="btn btn-primary"
              onClick={() => onSubmit(selectedId, notes, callbackDate || undefined)}
              disabled={submitDisabled}
              style={{ minWidth: 140 }}
            >
              Submit &amp; Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
