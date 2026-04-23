export const CSV_HEADERS = [
    'call_id',
    'timestamp_utc',
    'direction',
    'from_number',
    'to_number',
    'duration_seconds',
    'status',
    'mode',
    'channel',
    'agent_id',
    'account_id',
    'disposition_code',
    'disposition_note',
    'fdcpa_notice_played',
    'dnc_checked',
    'recording_url',
] as const;

export interface CallExportRow {
    id: string;
    createdAt: Date;
    direction: string;
    fromNumber: string;
    toNumber: string;
    duration: number;
    status: string;
    mode: string;
    channel: string;
    agentId: string | null;
    accountId: string | null;
    dispositionId: string | null;
    dispositionNote: string | null;
    fdcpaNotice: boolean;
    dncChecked: boolean;
    recordingUrl: string | null;
}

const escapeField = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    const needsQuoting = /[",\r\n]/.test(str);
    if (!needsQuoting) return str;
    return `"${str.replace(/"/g, '""')}"`;
};

const rowToCsv = (row: CallExportRow): string => {
    const fields: unknown[] = [
        row.id,
        row.createdAt.toISOString(),
        row.direction,
        row.fromNumber,
        row.toNumber,
        row.duration,
        row.status,
        row.mode,
        row.channel,
        row.agentId,
        row.accountId,
        row.dispositionId,
        row.dispositionNote,
        row.fdcpaNotice ? 'true' : 'false',
        row.dncChecked ? 'true' : 'false',
        row.recordingUrl,
    ];
    return fields.map(escapeField).join(',');
};

export function buildComplianceCsv(rows: CallExportRow[]): string {
    const header = CSV_HEADERS.join(',');
    if (rows.length === 0) return `${header}\r\n`;
    const lines = rows.map(rowToCsv);
    return [header, ...lines].join('\r\n') + '\r\n';
}
