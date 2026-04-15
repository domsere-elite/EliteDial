'use client';

interface Props {
    status: string;
}

const STATUS_CLASS: Record<string, string> = {
    active: 'badge-green',
    paused: 'badge-amber',
    draft: 'badge-gray',
    completed: 'badge-blue',
    archived: 'badge-gray',
};

export function CampaignStatusBadge({ status }: Props) {
    const className = STATUS_CLASS[status] ?? 'badge-gray';
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return <span className={`status-badge ${className}`}>{label}</span>;
}
