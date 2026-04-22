'use client';

import type { AccountPreview } from '@/hooks/useCallState';
import { AccountCard } from '../account/AccountCard';

interface ConnectedViewProps {
  accountPreview: AccountPreview | null;
  callerNumber: string;
  callerName: string;
  notes: string;
  onNotesChange: (notes: string) => void;
  fdcpaConfirmed: boolean;
  onFdcpaChange: (confirmed: boolean) => void;
}

export function ConnectedView({ accountPreview, callerNumber, callerName, notes, onNotesChange, fdcpaConfirmed, onFdcpaChange }: ConnectedViewProps) {
  return (
    <div className="workspace-body">
      <div className="workspace-sidebar">
        <AccountCard
          preview={accountPreview}
          callerNumber={callerNumber}
          callerName={callerName}
          showCompliance
          fdcpaConfirmed={fdcpaConfirmed}
          onFdcpaChange={onFdcpaChange}
        />
      </div>
      <div className="workspace-main">
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Call Notes</div>
          <textarea
            className="input"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Type notes here..."
            style={{ flex: 1, minHeight: 200, resize: 'vertical' }}
          />
        </div>
      </div>
    </div>
  );
}
