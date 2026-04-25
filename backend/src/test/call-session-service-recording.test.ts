import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallSessionService } from '../services/call-session-service';

// Minimal in-memory mock of the prisma surface addRecording uses.
function makeMockPrisma() {
    const callRecordings: any[] = [];
    const callUpdates: Array<{ id: string; data: any }> = [];
    const callSessions = new Map<string, { id: string; callId: string | null }>();
    callSessions.set('sess-1', { id: 'sess-1', callId: 'call-1' });

    const prismaLike = {
        callSession: {
            findUnique: async ({ where }: any) => {
                if (where?.callId === 'call-1') return { id: 'sess-1' };
                return null;
            },
            findFirst: async () => callSessions.get('sess-1') || null,
            create: async ({ data }: any) => { const s = { id: 'sess-new', ...data }; callSessions.set(s.id, s); return s; },
            update: async ({ where, data }: any) => ({ id: where.id, ...data }),
        },
        callRecording: {
            findFirst: async () => null,
            create: async ({ data }: any) => { const rec = { id: `rec-${callRecordings.length}`, ...data }; callRecordings.push(rec); return rec; },
            update: async ({ where, data }: any) => { const idx = callRecordings.findIndex(r => r.id === where.id); callRecordings[idx] = { ...callRecordings[idx], ...data }; return callRecordings[idx]; },
        },
        call: {
            update: async ({ where, data }: any) => { callUpdates.push({ id: where.id, data }); return { id: where.id, ...data }; },
        },
    };

    return { prismaLike, callRecordings, callUpdates };
}

test('addRecording: default behavior writes Call.recordingUrl', async () => {
    const { prismaLike, callUpdates } = makeMockPrisma();
    const svc = buildCallSessionService({ prisma: prismaLike as any });

    await svc.addRecording({
        provider: 'signalwire',
        providerCallId: 'pcid-1',
        callId: 'call-1',
        url: 'https://signalwire.example/rec.mp3',
        status: 'available',
    });

    assert.equal(callUpdates.length, 1, 'Call.recordingUrl updated by default');
    assert.equal(callUpdates[0].data.recordingUrl, 'https://signalwire.example/rec.mp3');
});

test('addRecording: updateCallRecordingUrl=false skips Call.recordingUrl write', async () => {
    const { prismaLike, callRecordings, callUpdates } = makeMockPrisma();
    const svc = buildCallSessionService({ prisma: prismaLike as any });

    await svc.addRecording({
        provider: 'retell',
        providerCallId: 'pcid-2',
        callId: 'call-1',
        url: 'https://retell.example/rec.mp3',
        status: 'available',
        updateCallRecordingUrl: false,
    });

    assert.equal(callUpdates.length, 0, 'Call.recordingUrl NOT updated when flag is false');
    assert.equal(callRecordings.length, 1, 'CallRecording row still created');
    assert.equal(callRecordings[0].url, 'https://retell.example/rec.mp3');
});
