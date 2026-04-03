'use client';

import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';

interface VoicemailRecord {
    id: string;
    fromNumber: string;
    toNumber: string;
    audioUrl: string;
    transcription: string | null;
    duration: number;
    isRead: boolean;
    createdAt: string;
}

export default function VoicemailPage() {
    const [voicemails, setVoicemails] = useState<VoicemailRecord[]>([]);
    const [selected, setSelected] = useState<VoicemailRecord | null>(null);
    const [unreadCount, setUnreadCount] = useState(0);
    const [filter, setFilter] = useState<'all' | 'unread'>('all');

    const loadVoicemails = useCallback(async () => {
        try {
            const res = await api.get(`/voicemails?${filter === 'unread' ? 'unreadOnly=true' : ''}`);
            setVoicemails(res.data.voicemails || []);
            setUnreadCount(res.data.unreadCount || 0);
        } catch {
            // no-op
        }
    }, [filter]);

    useEffect(() => { loadVoicemails(); }, [loadVoicemails]);

    const markRead = async (vm: VoicemailRecord) => {
        if (!vm.isRead) {
            await api.patch(`/voicemails/${vm.id}/read`);
            await loadVoicemails();
        }
        setSelected(vm);
    };

    const formatDate = (iso: string) => {
        const date = new Date(iso);
        return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    };

    const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

    return (
        <div className="workspace-shell">
            <div className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <h1>Voicemail Inbox</h1>
                    <div className="topline">Review, transcribe, and follow up on missed conversations.</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {unreadCount > 0 && <span className="badge badge-blue">{unreadCount}</span>}
                    <button className={`btn ${filter === 'all' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setFilter('all')}>All</button>
                    <button className={`btn ${filter === 'unread' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setFilter('unread')}>Unread</button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, minHeight: 'calc(100vh - 150px)' }}>
                <div className="glass-panel" style={{ overflow: 'auto' }}>
                    {voicemails.length === 0 && <div className="topline" style={{ padding: '50px 0', textAlign: 'center' }}>No voicemail records yet.</div>}

                    {voicemails.map((vm) => (
                        <div
                            key={vm.id}
                            className={`voicemail-item ${!vm.isRead ? 'unread' : ''}`}
                            style={{ background: selected?.id === vm.id ? '#eef5ff' : 'transparent' }}
                            onClick={() => markRead(vm)}
                        >
                            {!vm.isRead && <div className="voicemail-dot" />}
                            <div style={{ flex: 1 }}>
                                <div className="status-row">
                                    <span className="mono" style={{ fontWeight: vm.isRead ? 500 : 700 }}>{vm.fromNumber}</span>
                                    <span className="mono topline">{formatDuration(vm.duration)}</span>
                                </div>
                                <div className="topline" style={{ marginTop: 4 }}>{formatDate(vm.createdAt)}</div>
                                {vm.transcription && (
                                    <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {vm.transcription}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="glass-panel" style={{ padding: 20, overflow: 'auto' }}>
                    {!selected && (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                            <div className="topline">Select a voicemail to view transcript and follow-up options.</div>
                        </div>
                    )}

                    {selected && (
                        <>
                            <div className="status-row" style={{ marginBottom: 14 }}>
                                <div>
                                    <div className="topline" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>From</div>
                                    <div className="mono" style={{ fontSize: '1.2rem', marginTop: 2 }}>{selected.fromNumber}</div>
                                    <div className="mono topline" style={{ marginTop: 2 }}>{formatDate(selected.createdAt)} · {formatDuration(selected.duration)}</div>
                                </div>
                            </div>

                            <div className="glass-panel" style={{ padding: 14, marginBottom: 14 }}>
                                <div className="status-row" style={{ marginBottom: 8 }}>
                                    <h3>Playback</h3>
                                    <span className="mono topline">{formatDuration(selected.duration)}</span>
                                </div>
                                <audio controls style={{ width: '100%' }} src={selected.audioUrl}>
                                    Your browser does not support audio playback.
                                </audio>
                            </div>

                            <div className="glass-panel" style={{ padding: 14 }}>
                                <div className="status-row" style={{ marginBottom: 8 }}>
                                    <h3>Transcription</h3>
                                </div>
                                <div style={{ fontSize: '0.84rem', lineHeight: 1.65, color: 'var(--text-secondary)' }}>
                                    {selected.transcription || 'Transcription not available yet.'}
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                                <button className="btn btn-success" style={{ flex: 1 }}>Call Back</button>
                                <button className="btn btn-secondary" style={{ flex: 1 }}>Assign</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
