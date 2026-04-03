export const DISPOSITION_CODES = [
    { code: 'PIF', label: 'Paid in Full', category: 'payment' },
    { code: 'PP', label: 'Payment Plan', category: 'payment' },
    { code: 'PTP', label: 'Promise to Pay', category: 'promise' },
    { code: 'CB', label: 'Callback', category: 'general' },
    { code: 'LM', label: 'Left Message', category: 'general' },
    { code: 'NA', label: 'No Answer', category: 'skip' },
    { code: 'WN', label: 'Wrong Number', category: 'skip' },
    { code: 'DISC', label: 'Disconnected', category: 'skip' },
    { code: 'DNC', label: 'DNC Request', category: 'skip' },
    { code: 'DISP', label: 'Dispute', category: 'general' },
    { code: 'REF', label: 'Refused', category: 'general' },
    { code: 'BK', label: 'Bankruptcy', category: 'skip' },
];

export const AGENT_STATUSES = [
    { value: 'available', label: 'Available', color: 'var(--status-available)' },
    { value: 'break', label: 'On Break', color: 'var(--status-break)' },
    { value: 'offline', label: 'Offline', color: 'var(--status-offline)' },
    { value: 'on-call', label: 'On Call', color: 'var(--status-oncall)' },
];

export const ROLES = [
    { value: 'agent', label: 'Agent' },
    { value: 'supervisor', label: 'Supervisor' },
    { value: 'admin', label: 'Admin' },
];
