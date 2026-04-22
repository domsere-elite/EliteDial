'use client';

import type { CallPhase, AccountPreview } from '@/hooks/useCallState';
import { CallControls } from './CallControls';

interface CallBarProps {
  phase: CallPhase;
  callerNumber: string;
  callerName: string;
  accountPreview: AccountPreview | null;
  timerFormatted: string;
  agentName: string;
  muted: boolean;
  held: boolean;
  onAnswer: () => void;
  onDecline: () => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onTransfer: () => void;
  onEndCall: () => void;
  onBreak: () => void;
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function CallBar(props: CallBarProps) {
  const { phase, callerNumber, callerName, accountPreview, timerFormatted, agentName, muted, held } = props;

  if (phase === 'idle') {
    return (
      <div className="call-bar call-bar-idle">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="status-dot" style={{ background: 'var(--status-green)' }} />
          <div>
            <span style={{ fontSize: '0.857rem', fontWeight: 600 }}>Available</span>
            <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)', marginLeft: 8 }}>Waiting for next call</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>{agentName}</span>
          <button className="btn btn-warning btn-sm" onClick={props.onBreak}>Break</button>
        </div>
      </div>
    );
  }

  if (phase === 'ringing') {
    return (
      <div className="call-bar call-bar-ringing">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="status-dot" style={{ background: 'var(--status-blue)', boxShadow: '0 0 8px rgba(59,130,246,0.5)' }} />
          <div>
            <div style={{ fontSize: '0.857rem', fontWeight: 700, color: 'var(--status-blue-text)' }}>Incoming Call</div>
            <div style={{ fontSize: '0.786rem', color: 'var(--status-blue)', fontWeight: 500 }}>{callerNumber}</div>
          </div>
        </div>
        {accountPreview && (
          <div className="card" style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div>
              <div style={{ fontSize: '0.786rem', fontWeight: 600 }}>{accountPreview.debtorName}</div>
              <div style={{ fontSize: '0.714rem', color: 'var(--text-secondary)' }}>
                {currency.format(accountPreview.balance)} &middot; {accountPreview.status}
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" style={{ background: 'var(--status-red-bg)', color: 'var(--status-red-text)', borderColor: 'var(--status-red-border)' }} onClick={props.onDecline}>
            Decline
          </button>
          <button className="btn btn-success" onClick={props.onAnswer}>Answer</button>
        </div>
      </div>
    );
  }

  if (phase === 'connected') {
    return (
      <div className="call-bar call-bar-connected">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="status-dot" style={{ background: 'var(--status-green)', boxShadow: '0 0 6px rgba(34,197,94,0.4)' }} />
          <div>
            <span style={{ fontSize: '0.857rem', fontWeight: 600, color: 'var(--status-green-text)' }}>Connected</span>
            <span style={{ fontSize: '0.786rem', color: 'var(--text-secondary)', marginLeft: 8 }}>{callerNumber}</span>
          </div>
        </div>
        <div className="call-timer tabular-nums">{timerFormatted}</div>
        <CallControls
          muted={muted}
          held={held}
          onToggleMute={props.onToggleMute}
          onToggleHold={props.onToggleHold}
          onTransfer={props.onTransfer}
          onEndCall={props.onEndCall}
        />
      </div>
    );
  }

  // wrap-up
  return (
    <div className="call-bar call-bar-wrapup">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="status-dot" style={{ background: 'var(--status-amber)' }} />
        <div>
          <span style={{ fontSize: '0.857rem', fontWeight: 600, color: 'var(--status-amber-text)' }}>Wrap-Up</span>
          <span style={{ fontSize: '0.786rem', color: 'var(--status-amber-text)', marginLeft: 8 }}>Complete disposition to return to queue</span>
        </div>
      </div>
      <div style={{ fontSize: '0.857rem', color: 'var(--status-amber-text)' }}>
        {timerFormatted} &middot; {callerName} &middot; {callerNumber}
      </div>
    </div>
  );
}
