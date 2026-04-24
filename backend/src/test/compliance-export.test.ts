import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildComplianceCsv, CSV_HEADERS, CallExportRow } from '../services/compliance-export';

const row = (overrides: Partial<CallExportRow> = {}): CallExportRow => ({
    id: 'call-1',
    createdAt: new Date('2026-04-23T15:30:00Z'),
    direction: 'outbound',
    fromNumber: '+14085551000',
    toNumber: '+14085559999',
    duration: 45,
    status: 'completed',
    mode: 'progressive',
    channel: 'human',
    agentId: 'agent-42',
    accountId: 'acct-7',
    dispositionId: 'PAID',
    dispositionNote: 'Promise to pay Tuesday',
    fdcpaNotice: true,
    dncChecked: true,
    recordingUrl: 'https://recordings.example.com/call-1.mp3',
    ...overrides,
});

describe('buildComplianceCsv', () => {
    it('returns only the header line when no rows', () => {
        const csv = buildComplianceCsv([]);
        assert.equal(csv.trim(), CSV_HEADERS.join(','));
    });

    it('emits the header row first', () => {
        const csv = buildComplianceCsv([row()]);
        const [header] = csv.split('\r\n');
        assert.equal(header, CSV_HEADERS.join(','));
    });

    it('emits one data line per call', () => {
        const csv = buildComplianceCsv([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
        const lines = csv.trim().split('\n');
        assert.equal(lines.length, 4); // 1 header + 3 rows
    });

    it('writes timestamps in ISO 8601 UTC', () => {
        const csv = buildComplianceCsv([row({ createdAt: new Date('2026-04-23T15:30:00Z') })]);
        assert.ok(csv.includes('2026-04-23T15:30:00.000Z'));
    });

    it('writes boolean compliance flags as true/false strings', () => {
        const csv = buildComplianceCsv([row({ fdcpaNotice: true, dncChecked: false })]);
        const dataLine = csv.split('\r\n')[1];
        const fields = dataLine.split(',');
        const fdcpaIdx = CSV_HEADERS.indexOf('fdcpa_notice_played');
        const dncIdx = CSV_HEADERS.indexOf('dnc_checked');
        assert.equal(fields[fdcpaIdx], 'true');
        assert.equal(fields[dncIdx], 'false');
    });

    it('writes empty string for null/undefined fields', () => {
        const csv = buildComplianceCsv([row({
            agentId: null,
            accountId: null,
            dispositionId: null,
            dispositionNote: null,
            recordingUrl: null,
        })]);
        const dataLine = csv.split('\r\n')[1];
        const fields = dataLine.split(',');
        const agentIdx = CSV_HEADERS.indexOf('agent_id');
        assert.equal(fields[agentIdx], '');
    });

    it('escapes fields containing commas by wrapping in double quotes', () => {
        const csv = buildComplianceCsv([row({ dispositionNote: 'Will pay, maybe' })]);
        const dataLine = csv.split('\r\n')[1];
        assert.ok(dataLine.includes('"Will pay, maybe"'));
    });

    it('escapes fields containing double quotes by doubling them (RFC 4180)', () => {
        const csv = buildComplianceCsv([row({ dispositionNote: 'Said "call back"' })]);
        const dataLine = csv.split('\r\n')[1];
        assert.ok(dataLine.includes('"Said ""call back"""'));
    });

    it('escapes fields containing newlines by wrapping in double quotes', () => {
        const csv = buildComplianceCsv([row({ dispositionNote: 'Line one\nLine two' })]);
        // The whole field should be quoted
        assert.ok(csv.includes('"Line one\nLine two"'));
    });

    it('uses CRLF line terminator between rows (RFC 4180)', () => {
        const csv = buildComplianceCsv([row({ id: 'a' }), row({ id: 'b' })]);
        assert.ok(csv.includes('\r\n'));
    });

    it('includes all expected headers in order', () => {
        assert.deepEqual(CSV_HEADERS, [
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
        ]);
    });
});
