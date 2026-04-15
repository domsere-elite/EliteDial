'use client';

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

interface ImportResult {
    totalRecords: number;
    validRecords: number;
    invalidRecords: number;
    duplicateSuppressed: number;
    dncSuppressed: number;
}

interface Contact {
    id: string;
    firstName: string | null;
    lastName: string | null;
    primaryPhone: string;
    status: string;
    priority: number;
    attemptCount: number;
}

interface Props {
    campaignId: string;
}

export function ContactsTab({ campaignId }: Props) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [importing, setImporting] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const loadContacts = () => {
        api.get(`/campaigns/${campaignId}/contacts?page=1&limit=50`)
            .then(r => setContacts(r.data?.contacts || []))
            .catch(() => setContacts([]));
    };

    useEffect(loadContacts, [campaignId]);

    const handleFile = async (file: File) => {
        if (!file.name.toLowerCase().endsWith('.csv')) {
            setError('Please upload a CSV file');
            return;
        }
        setImporting(true);
        setError(null);
        try {
            const csv = await file.text();
            const res = await api.post(`/campaigns/${campaignId}/import`, {
                listName: file.name.replace(/\.csv$/i, ''),
                csv,
            });
            setImportResult(res.data);
            loadContacts();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Import failed');
        } finally {
            setImporting(false);
        }
    };

    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
    };

    const onSelect = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) void handleFile(file);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {error && <div className="notice notice-error">{error}</div>}

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Import Contacts</div>
                <div
                    className="dropzone"
                    style={{ borderColor: dragOver ? 'var(--brand-navy)' : undefined, cursor: 'pointer' }}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <input ref={fileInputRef} type="file" accept=".csv" onChange={onSelect} style={{ display: 'none' }} />
                    <div style={{ fontSize: '0.929rem', color: 'var(--text-primary)', marginBottom: 6 }}>
                        {importing ? 'Importing...' : 'Drop a CSV file here or click to browse'}
                    </div>
                    <div style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>
                        Expected headers: firstName, lastName, phone, email (optional), accountId (optional), timezone (optional)
                    </div>
                </div>

                {importResult && (
                    <div className="notice notice-success" style={{ marginTop: 12 }}>
                        Imported {importResult.validRecords} valid contacts from {importResult.totalRecords} rows
                        {importResult.duplicateSuppressed > 0 && ` · ${importResult.duplicateSuppressed} duplicates suppressed`}
                        {importResult.dncSuppressed > 0 && ` · ${importResult.dncSuppressed} DNC suppressed`}
                        {importResult.invalidRecords > 0 && ` · ${importResult.invalidRecords} invalid`}
                    </div>
                )}
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Contacts ({contacts.length})</div>
                {contacts.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.857rem', padding: '20px 0', textAlign: 'center' }}>
                        No contacts yet — upload a CSV to get started
                    </div>
                ) : (
                    <table className="data-table">
                        <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Priority</th><th>Attempts</th></tr></thead>
                        <tbody>
                            {contacts.map(c => (
                                <tr key={c.id}>
                                    <td style={{ fontWeight: 500 }}>{`${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown'}</td>
                                    <td className="mono" style={{ fontSize: '0.786rem', color: 'var(--text-secondary)' }}>{c.primaryPhone}</td>
                                    <td><span className="status-badge badge-gray">{c.status}</span></td>
                                    <td className="mono">{c.priority}</td>
                                    <td className="mono">{c.attemptCount}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
