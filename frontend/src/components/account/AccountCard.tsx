'use client';

import type { AccountPreview } from '@/hooks/useCallState';

interface AccountCardProps {
  preview: AccountPreview | null;
  callerNumber: string;
  callerName: string;
  showCompliance?: boolean;
  fdcpaConfirmed?: boolean;
  onFdcpaChange?: (confirmed: boolean) => void;
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function AccountCard({ preview, callerNumber, callerName, showCompliance, fdcpaConfirmed, onFdcpaChange }: AccountCardProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div className="card">
        <div className="section-label">Account</div>
        <div style={{ fontSize: '1.07rem', fontWeight: 700, marginTop: 6 }}>
          {preview?.debtorName || callerName || 'Unknown'}
        </div>
        <div style={{ fontSize: '0.929rem', fontWeight: 700, marginTop: 2 }}>
          {preview ? currency.format(preview.balance) : '$0.00'}
        </div>
        {preview && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span className="status-badge badge-green">{preview.status}</span>
          </div>
        )}
        {callerNumber && (
          <div style={{ fontSize: '0.786rem', color: 'var(--text-secondary)', marginTop: 6 }}>
            {callerNumber}
          </div>
        )}
        {preview?.accountName && (
          <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 10, paddingTop: 8 }}>
            <div className="section-label">Account Name</div>
            <div style={{ fontSize: '0.786rem', color: 'var(--text-secondary)', fontWeight: 500, marginTop: 2 }}>
              {preview.accountName}
            </div>
          </div>
        )}
      </div>

      {showCompliance && (
        <div className="card">
          <div className="section-label">Compliance</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer', fontSize: '0.786rem' }}>
            <input
              type="checkbox"
              checked={fdcpaConfirmed || false}
              onChange={(e) => onFdcpaChange?.(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--status-green)' }}
            />
            <span style={{ fontWeight: 500, color: fdcpaConfirmed ? 'var(--status-green-text)' : 'var(--text-secondary)' }}>
              Mini-Miranda delivered
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
