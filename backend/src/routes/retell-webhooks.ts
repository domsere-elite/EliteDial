import { Request, Response, Router } from 'express';
import { callSessionService } from '../services/call-session-service';
import { callAuditService } from '../services/call-audit';
import { crmAdapter } from '../services/crm-adapter';
import { logger } from '../utils/logger';

const router = Router();

const readString = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    return undefined;
};

const readRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
};

const getCallPayload = (body: Record<string, unknown>) => {
    const nested = readRecord(body.call);
    return Object.keys(nested).length > 0 ? nested : body;
};

const inferDirection = (payload: Record<string, unknown>): 'inbound' | 'outbound' => {
    const direction = readString(payload.direction) || readString(payload.call_direction);
    return direction === 'inbound' ? 'inbound' : 'outbound';
};

const inferStatus = (eventType: string, payload: Record<string, unknown>): string => {
    const explicit = readString(payload.call_status) || readString(payload.status) || readString(payload.disconnection_reason);
    if (explicit) {
        if (['registered', 'initiated', 'queued'].includes(explicit)) return 'initiated';
        if (['ringing'].includes(explicit)) return 'ringing';
        if (['answered', 'in_progress', 'ongoing'].includes(explicit)) return 'in-progress';
        if (['ended', 'completed', 'done'].includes(explicit)) return 'completed';
        if (['failed', 'error'].includes(explicit)) return 'failed';
        return explicit;
    }

    if (eventType.includes('started')) return 'initiated';
    if (eventType.includes('analyzed')) return 'completed';
    return 'initiated';
};

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
    const body = readRecord(req.body);
    const eventType = readString(body.event) || readString(body.type) || readString(body.event_type) || 'retell.unknown';
    const payload = getCallPayload(body);
    const providerCallId = readString(payload.call_id) || readString(payload.callId);
    const metadata = readRecord(payload.metadata);
    const accountId = readString(metadata.account_id) || readString(metadata.accountId);
    const campaignId = readString(metadata.campaign_id) || readString(metadata.campaignId);
    const contactId = readString(metadata.contact_id) || readString(metadata.contactId);
    const callIdFromMetadata = readString(metadata.call_id) || readString(metadata.callId);
    const direction = inferDirection(payload);
    const status = inferStatus(eventType, payload);
    const fromNumber = readString(payload.from_number) || readString(payload.from) || 'unknown';
    const toNumber = readString(payload.to_number) || readString(payload.to) || 'unknown';

    try {
        let callId = callIdFromMetadata || null;
        let sessionId = callId ? (await callSessionService.resolveSessionId('retell', providerCallId || null, callId)) : null;

        if (!sessionId && providerCallId) {
            const existing = await callSessionService.findSessionByProviderCall('retell', providerCallId);
            if (existing) {
                sessionId = existing.id;
                callId = existing.callId;
            }
        }

        if (!sessionId && providerCallId) {
            const created = await callSessionService.createUnifiedCall({
                provider: 'retell',
                channel: 'ai',
                mode: direction === 'inbound' ? 'inbound' : 'ai_outbound',
                direction,
                fromNumber,
                toNumber,
                status,
                providerCallId,
                accountId,
                accountName: readString(metadata.account_name) || null,
                campaignId,
                contactId,
                leadExternalId: readString(metadata.external_id) || null,
                crmContext: metadata,
                providerMetadata: payload,
            });
            sessionId = created.session.id;
            callId = created.call.id;
        }

        if (providerCallId) {
            await callSessionService.updateProviderStatus({
                provider: 'retell',
                providerCallId,
                status,
                completedAt: status === 'completed' ? new Date() : null,
                answeredAt: status === 'in-progress' ? new Date() : null,
                providerMetadata: payload,
            });
        }

        const transcript = readString(payload.transcript) || readString(readRecord(payload.call_analysis).transcript);
        if (transcript) {
            await callSessionService.addTranscript({
                provider: 'retell',
                providerCallId,
                callId,
                providerTranscriptId: readString(payload.transcript_id),
                sourceType: 'ai',
                text: transcript,
                metadata: payload,
            });
            await callAuditService.track({
                type: 'call.transcript.ready',
                callId: callId || undefined,
                callSid: providerCallId,
                details: { provider: 'retell', eventType },
                source: 'retell.webhook',
                status,
            });
        }

        const recordingUrl = readString(payload.recording_url) || readString(readRecord(payload.recording).url);
        if (recordingUrl) {
            await callSessionService.addRecording({
                provider: 'retell',
                providerCallId,
                callId,
                providerRecordingId: readString(payload.recording_id),
                url: recordingUrl,
                status: 'available',
                metadata: payload,
                updateCallRecordingUrl: false,
            });
            await crmAdapter.postRecordingTranscript({
                call_id: callId,
                provider: 'retell',
                provider_call_id: providerCallId,
                account_id: accountId || null,
                recording_url: recordingUrl,
                transcript: transcript || null,
            });
        }

        await callAuditService.track({
            type: eventType.startsWith('call_') ? 'call.status' : eventType,
            callId: callId || undefined,
            callSid: providerCallId,
            details: {
                provider: 'retell',
                eventType,
                status,
            },
            source: 'retell.webhook',
            status,
            idempotencyKey: providerCallId ? `retell:${providerCallId}:${eventType}:${status}` : undefined,
        });

        await crmAdapter.postCallEvent({
            event_type: eventType,
            call_id: callId,
            provider: 'retell',
            provider_call_id: providerCallId,
            account_id: accountId || null,
            campaign_id: campaignId || null,
            contact_id: contactId || null,
            status,
            from_number: fromNumber,
            to_number: toNumber,
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        logger.error('Retell webhook processing failed', { error, eventType, providerCallId });
        res.status(500).json({ error: 'retell_webhook_failed' });
    }
});

export default router;
