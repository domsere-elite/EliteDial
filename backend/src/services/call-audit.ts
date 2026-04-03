import { prisma } from '../lib/prisma';
import { callSessionService } from './call-session-service';

type AuditEventType =
    | 'inbound.received'
    | 'inbound.ivr.selection'
    | 'inbound.agent.reserved'
    | 'inbound.agent.connect_failed'
    | 'dialer.guardrail.blocked'
    | 'call.abandoned'
    | 'call.status'
    | 'call.disposition'
    | 'call.outbound.initiated'
    | 'call.recording.ready'
    | 'call.transcript.ready'
    | 'crm.sync'
    | 'ai.call.outbound.initiated'
    | 'ai.call.transfer';

export interface AuditEvent {
    id: string;
    timestamp: string;
    type: AuditEventType | string;
    callId?: string;
    callSid?: string;
    details?: Record<string, string | number | boolean | null | undefined>;
}

class CallAuditService {
    async track(event: Omit<AuditEvent, 'id' | 'timestamp'> & {
        source?: string;
        status?: string;
        idempotencyKey?: string;
    }): Promise<AuditEvent> {
        const persisted = await callSessionService.upsertEvent({
            callId: event.callId,
            providerCallId: event.callSid,
            type: event.type,
            source: event.source || 'app',
            status: event.status,
            idempotencyKey: event.idempotencyKey,
            payload: event.details ? { details: event.details } : undefined,
        });

        return {
            id: persisted?.id || `${Date.now()}`,
            timestamp: (persisted?.createdAt || new Date()).toISOString(),
            type: event.type,
            callId: event.callId,
            callSid: event.callSid,
            details: event.details,
        };
    }

    async getByCallId(callId: string, limit = 100): Promise<AuditEvent[]> {
        const events = await prisma.callEvent.findMany({
            where: { callId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        return events.map((event) => ({
            id: event.id,
            timestamp: event.createdAt.toISOString(),
            type: event.type,
            callId: event.callId || undefined,
            callSid: event.providerCallId || undefined,
            details: this.extractDetails(event.payload),
        }));
    }

    async getRecent(limit = 50): Promise<AuditEvent[]> {
        const events = await prisma.callEvent.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        return events.map((event) => ({
            id: event.id,
            timestamp: event.createdAt.toISOString(),
            type: event.type,
            callId: event.callId || undefined,
            callSid: event.providerCallId || undefined,
            details: this.extractDetails(event.payload),
        }));
    }

    private extractDetails(payload: unknown): Record<string, string | number | boolean | null | undefined> | undefined {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
        const raw = payload as Record<string, unknown>;
        const details = raw.details;
        if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
        return details as Record<string, string | number | boolean | null | undefined>;
    }
}

export const callAuditService = new CallAuditService();
