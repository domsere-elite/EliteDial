import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { webhookEngine } from '../services/webhook-engine';
import { signalwireService } from '../services/signalwire';
import { callAuditService } from '../services/call-audit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { callSessionService } from '../services/call-session-service';
import { crmAdapter } from '../services/crm-adapter';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { escapeXml } from '../utils/sanitize';

const router = Router();

const isPhoneNumber = (target: string): boolean => /^\+?[1-9]\d{7,14}$/.test(target);

const reserveAvailableAgent = async (): Promise<{ id: string; endpoint: string } | null> => {
    for (let i = 0; i < 5; i += 1) {
        const agent = await prisma.user.findFirst({
            where: {
                role: { in: ['agent', 'supervisor', 'admin'] },
                status: 'available',
            },
            select: { id: true, extension: true },
            orderBy: { updatedAt: 'asc' },
        });

        if (!agent) return null;

        const claim = await prisma.user.updateMany({
            where: { id: agent.id, status: 'available' },
            data: { status: 'on-call' },
        });

        if (claim.count === 1) {
            return { id: agent.id, endpoint: agent.extension || agent.id };
        }
    }

    return null;
};

const ensureInboundCallRecord = async (params: {
    callSid?: string;
    fromNumber?: string;
    toNumber?: string;
    agentId?: string | null;
}): Promise<string | null> => {
    const callSid = (params.callSid || '').trim();
    if (!callSid) return null;

    const existing = await prisma.call.findFirst({
        where: { signalwireCallSid: callSid },
        select: { id: true, agentId: true },
    });

    if (existing) {
        if (!existing.agentId && params.agentId) {
            await prisma.call.update({
                where: { id: existing.id },
                data: { agentId: params.agentId },
            });
            await callSessionService.syncCall(existing.id, {
                provider: 'signalwire',
                providerCallId: callSid,
                mode: 'inbound',
                channel: 'human',
            });
        }
        return existing.id;
    }

    const { call } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: 'inbound',
        direction: 'inbound',
        fromNumber: params.fromNumber || 'unknown',
        toNumber: params.toNumber || 'unknown',
        status: 'initiated',
        providerCallId: callSid,
        agentId: params.agentId || null,
    });

    return call.id;
};

// POST /sw/inbound — SignalWire inbound call handler (LaML)
router.post('/inbound', (req: Request, res: Response): void => {
    void ensureInboundCallRecord({
        callSid: req.body.CallSid as string | undefined,
        fromNumber: req.body.From as string | undefined,
        toNumber: req.body.To as string | undefined,
    }).then((callId) => {
        void callAuditService.track({
            type: 'inbound.received',
            callId: callId || undefined,
            callSid: req.body.CallSid as string | undefined,
            details: {
                fromNumber: (req.body.From as string | undefined) || 'unknown',
                toNumber: (req.body.To as string | undefined) || 'unknown',
            },
            source: 'signalwire.inbound',
        });
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Thank you for calling Elite Portfolio Management.</Say>
  <Gather input="dtmf" numDigits="1" action="/sw/ivr-action" timeout="10">
    <Say voice="woman">
      Press 1 to make a payment. Press 2 to speak with an agent. Press 3 to leave a voicemail.
    </Say>
  </Gather>
  <Say voice="woman">We did not receive your selection. Goodbye.</Say>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/ivr-action — process IVR keypress
router.post('/ivr-action', async (req: Request, res: Response): Promise<void> => {
    const digit = req.body.Digits;
    const callSid = req.body.CallSid as string | undefined;
    const callId = await ensureInboundCallRecord({
        callSid,
        fromNumber: req.body.From as string | undefined,
        toNumber: req.body.To as string | undefined,
    });
    await callAuditService.track({
        type: 'inbound.ivr.selection',
        callId: callId || undefined,
        callSid,
        details: { digit: (digit || '').toString() || 'none' },
        source: 'signalwire.ivr_action',
    });

    let xml = '';

    switch (digit) {
        case '1':
            // Payment option — could route to payment IVR or agent
            xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Connecting you to our payment system. Please hold.</Say>
  <Enqueue waitUrl="/sw/queue-wait">payments</Enqueue>
</Response>`;
            break;
        case '2':
            // Agent option — route to available browser agent endpoint
            xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Please hold while we connect you with an agent.</Say>
  <Redirect method="POST">/sw/connect-agent</Redirect>
</Response>`;
            break;
        case '3':
            // Voicemail
            xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Please leave your message after the tone. Press pound when finished.</Say>
  <Record maxLength="120" action="/sw/voicemail" transcribe="true" transcribeCallback="/sw/transcription" finishOnKey="#" />
</Response>`;
            break;
        default:
            xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Invalid selection. Goodbye.</Say>
  <Hangup/>
</Response>`;
    }

    res.type('text/xml').send(xml);
});

// POST /sw/queue-wait — hold music + overflow prompt
router.post('/queue-wait', (req: Request, res: Response): void => {
    // After ~60 seconds, offer voicemail option
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">All agents are currently assisting other callers. Your call is important to us.</Say>
  <Play>/audio/hold-music.mp3</Play>
  <Gather input="dtmf" numDigits="1" action="/sw/overflow-action" timeout="60">
    <Say voice="woman">
      We apologize for the wait. Press 1 to continue holding. Press 2 to leave a voicemail and we will return your call.
    </Say>
  </Gather>
  <Say voice="woman">We will continue to hold your place in the queue.</Say>
  <Play>/audio/hold-music.mp3</Play>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/overflow-action — handle overflow choice
router.post('/overflow-action', (req: Request, res: Response): void => {
    const digit = req.body.Digits;
    let xml = '';

    if (digit === '2') {
        xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Please leave your message after the tone. Press pound when finished.</Say>
  <Record maxLength="120" action="/sw/voicemail" transcribe="true" transcribeCallback="/sw/transcription" finishOnKey="#" />
</Response>`;
    } else {
        xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Thank you for your patience. Please continue to hold.</Say>
  <Enqueue waitUrl="/sw/queue-wait">agents</Enqueue>
</Response>`;
    }

    res.type('text/xml').send(xml);
});

// POST /sw/bridge — bridge agent to destination (outbound calls)
router.post('/bridge', (req: Request, res: Response): void => {
    const toNumber = req.query.to as string;
    const fromNumber = req.query.from as string;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Call is being connected.</Say>
  <Dial callerId="${escapeXml(fromNumber || '')}" record="record-from-answer-dual">
    <Number>${escapeXml(toNumber || '')}</Number>
  </Dial>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/connect-agent — direct inbound caller to available in-app agent
router.post('/connect-agent', async (req: Request, res: Response): Promise<void> => {
    const callSid = req.body.CallSid as string | undefined;
    const reservedAgent = await reserveAvailableAgent();

    if (!reservedAgent || !config.signalwire.spaceUrl) {
        const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">All agents are currently assisting other callers. Please continue to hold.</Say>
  <Enqueue waitUrl="/sw/queue-wait">agents</Enqueue>
</Response>`;
        res.type('text/xml').send(fallback);
        return;
    }

    const callId = await ensureInboundCallRecord({
        callSid,
        fromNumber: req.body.From as string | undefined,
        toNumber: req.body.To as string | undefined,
        agentId: reservedAgent.id,
    });

    await callAuditService.track({
        type: 'inbound.agent.reserved',
        callId: callId || undefined,
        callSid,
        details: {
            agentId: reservedAgent.id,
            endpoint: reservedAgent.endpoint,
        },
        source: 'signalwire.connect_agent',
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" timeout="20" action="/sw/agent-dial-result" method="POST">
    <Sip>sip:${escapeXml(reservedAgent.endpoint)}@${escapeXml(config.signalwire.spaceUrl)}</Sip>
  </Dial>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/agent-dial-result — fallback after unsuccessful agent connect
router.post('/agent-dial-result', async (req: Request, res: Response): Promise<void> => {
    const status = (req.body.DialCallStatus || '').toString();
    const callSid = req.body.CallSid as string | undefined;
    const isConnected = ['completed', 'answered', 'in-progress'].includes(status);

    if (isConnected) {
        const done = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
        res.type('text/xml').send(done);
        return;
    }

    const dialedAgent = (req.body.DialSip || req.body.To || '').toString();
    const callId = await ensureInboundCallRecord({
        callSid,
        fromNumber: req.body.From as string | undefined,
        toNumber: req.body.To as string | undefined,
    });
    if (dialedAgent) {
        const endpoint = dialedAgent.replace(/^sip:/, '').split('@')[0];
        if (endpoint) {
            await callAuditService.track({
                type: 'inbound.agent.connect_failed',
                callId: callId || undefined,
                callSid,
                details: {
                    endpoint,
                    dialStatus: status || 'unknown',
                },
                source: 'signalwire.agent_dial_result',
            });
            await callAuditService.track({
                type: 'call.abandoned',
                callId: callId || undefined,
                callSid,
                status: 'abandoned',
                details: {
                    reason: 'agent_connect_failed',
                    endpoint,
                    dialStatus: status || 'unknown',
                },
                source: 'signalwire.agent_dial_result',
                idempotencyKey: `signalwire:${callSid}:agent_connect_failed:${endpoint}:${status || 'unknown'}`,
            });
            void prisma.user.updateMany({
                where: {
                    OR: [{ id: endpoint }, { extension: endpoint }],
                },
                data: { status: 'available' },
            });
        }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">We could not connect to an available agent endpoint. Please leave a voicemail after the tone.</Say>
  <Record maxLength="120" action="/sw/voicemail" transcribe="true" transcribeCallback="/sw/transcription" finishOnKey="#" />
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/amd-hold — short hold while async AMD runs
router.post('/amd-hold', (req: Request, res: Response): void => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Say voice="woman">One moment while we connect your call.</Say>
  <Pause length="2"/>
  <Say voice="woman">Please stay on the line.</Say>
  <Pause length="3"/>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/ai-connect — connect answered callee to AI voice model
router.post('/ai-connect', (req: Request, res: Response): void => {
    const aiTargetFromQuery = (req.query.aiTarget as string) || '';
    const aiTarget = aiTargetFromQuery || config.ai.transferTarget;

    if (!aiTarget) {
        const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">We are unable to connect your call at this time. Goodbye.</Say>
  <Hangup/>
</Response>`;
        res.type('text/xml').send(fallback);
        return;
    }

    const dialDestination = isPhoneNumber(aiTarget)
        ? `<Number>${escapeXml(aiTarget)}</Number>`
        : `<Sip>${escapeXml(aiTarget)}</Sip>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Please hold while we connect you.</Say>
  <Dial answerOnBridge="true">
    ${dialDestination}
  </Dial>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/amd-machine — machine detected behavior
router.post('/amd-machine', (req: Request, res: Response): void => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/voicemail — voicemail recording completed
router.post('/voicemail', async (req: Request, res: Response): Promise<void> => {
    const { RecordingUrl, RecordingDuration, From, To } = req.body;

    try {
        const voicemail = await prisma.voicemail.create({
            data: {
                fromNumber: From || 'unknown',
                toNumber: To || 'unknown',
                audioUrl: RecordingUrl || '',
                duration: parseInt(RecordingDuration || '0'),
            },
        });

        await webhookEngine.dispatch('voicemail.received', {
            voicemailId: voicemail.id,
            fromNumber: From,
            duration: voicemail.duration,
        });
        await crmAdapter.postVoicemail({
            voicemail_id: voicemail.id,
            from_number: From || 'unknown',
            to_number: To || 'unknown',
            recording_url: RecordingUrl || '',
            duration: voicemail.duration,
        });

        logger.info('Voicemail saved', { id: voicemail.id, from: From });
    } catch (err) {
        logger.error('Failed to save voicemail', { error: err });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Thank you for your message. A representative will return your call shortly. Goodbye.</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml').send(xml);
});

// POST /sw/transcription — voicemail transcription callback
router.post('/transcription', async (req: Request, res: Response): Promise<void> => {
    const { TranscriptionText, RecordingUrl } = req.body;
    if (TranscriptionText && RecordingUrl) {
        await prisma.voicemail.updateMany({
            where: { audioUrl: RecordingUrl },
            data: { transcription: TranscriptionText },
        });
        await callSessionService.addTranscript({
            provider: 'signalwire',
            sourceType: 'voicemail',
            text: TranscriptionText,
            metadata: { recordingUrl: RecordingUrl },
        });
        await callAuditService.track({
            type: 'call.transcript.ready',
            details: { recordingUrl: RecordingUrl },
            source: 'signalwire.transcription',
        });
        logger.info('Voicemail transcription saved');
    }
    res.status(200).send('OK');
});

// POST /sw/call-status — call status change callback
router.post('/call-status', async (req: Request, res: Response): Promise<void> => {
    const { CallSid, CallStatus, CallDuration } = req.body;

    if (CallSid) {
        const callId = await ensureInboundCallRecord({
            callSid: CallSid,
            fromNumber: req.body.From as string | undefined,
            toNumber: req.body.To as string | undefined,
        });

        const statusMap: Record<string, string> = {
            'initiated': 'initiated',
            'ringing': 'ringing',
            'in-progress': 'in-progress',
            'completed': 'completed',
            'failed': 'failed',
            'no-answer': 'no-answer',
            'busy': 'busy',
        };

        const status = statusMap[CallStatus] || CallStatus;
        await callAuditService.track({
            type: 'call.status',
            callId: callId || undefined,
            callSid: CallSid,
            details: {
                status,
                duration: parseInt(CallDuration || '0'),
            },
            source: 'signalwire.call_status',
            status,
            idempotencyKey: `signalwire:${CallSid}:status:${status}:${CallDuration || '0'}`,
        });

        await callSessionService.updateProviderStatus({
            provider: 'signalwire',
            providerCallId: CallSid,
            status,
            duration: parseInt(CallDuration || '0'),
            answeredAt: status === 'in-progress' ? new Date() : null,
            completedAt: ['completed', 'failed', 'no-answer', 'busy'].includes(status) ? new Date() : null,
        });

        await prisma.call.updateMany({
            where: { signalwireCallSid: CallSid },
            data: {
                status,
                duration: parseInt(CallDuration || '0'),
                ...(['completed', 'failed', 'no-answer', 'busy'].includes(status) ? { completedAt: new Date() } : {}),
            },
        });

        const callWithAttempt = await prisma.call.findFirst({
            where: { signalwireCallSid: CallSid },
            select: {
                id: true,
                agentId: true,
                campaignAttempts: {
                    orderBy: { startedAt: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        contactId: true,
                        campaignId: true,
                        contact: {
                            select: {
                                id: true,
                                attemptCount: true,
                                campaign: { select: { maxAttemptsPerLead: true, retryDelaySeconds: true } },
                            },
                        },
                    },
                },
            },
        });

        const campaignAttempt = callWithAttempt?.campaignAttempts?.[0];
        if (campaignAttempt) {
            const terminalStatuses = ['completed', 'failed', 'no-answer', 'busy'];
            if (status === 'ringing' || status === 'in-progress') {
                await prisma.campaignAttempt.update({
                    where: { id: campaignAttempt.id },
                    data: {
                        status,
                        ...(status === 'in-progress' ? { outcome: 'human' } : {}),
                    },
                });
            }

            if (terminalStatuses.includes(status)) {
                const outcomeMap: Record<string, string> = {
                    completed: 'human',
                    failed: 'failed',
                    'no-answer': 'no-answer',
                    busy: 'busy',
                };

                await prisma.campaignAttempt.update({
                    where: { id: campaignAttempt.id },
                    data: {
                        status,
                        outcome: outcomeMap[status] || status,
                        completedAt: new Date(),
                    },
                });

                const maxAttempts = campaignAttempt.contact.campaign.maxAttemptsPerLead;
                const retryDelayMs = Math.max(30, campaignAttempt.contact.campaign.retryDelaySeconds) * 1000;
                const exhausted = campaignAttempt.contact.attemptCount >= maxAttempts;
                const nextContactStatus = status === 'completed'
                    ? 'completed'
                    : (exhausted ? 'failed' : 'queued');

                await campaignReservationService.completeReservation(
                    campaignAttempt.contactId,
                    nextContactStatus,
                    nextContactStatus === 'queued'
                        ? new Date(Date.now() + retryDelayMs)
                        : null,
                );
            }
        }

        if (['completed', 'failed', 'no-answer', 'busy'].includes(status)) {
            const completedCall = await prisma.call.findFirst({
                where: { signalwireCallSid: CallSid },
                select: { agentId: true, id: true, accountId: true },
            });

            if (completedCall?.agentId) {
                await prisma.user.updateMany({
                    where: { id: completedCall.agentId },
                    data: { status: 'available' },
                });
            }
            if (completedCall?.id) {
                await crmAdapter.postCallEvent({
                    event_type: 'call.completed',
                    call_id: completedCall.id,
                    provider: 'signalwire',
                    provider_call_id: CallSid,
                    status,
                    duration: parseInt(CallDuration || '0'),
                    account_id: completedCall.accountId || null,
                });
            }
        }

        // Dispatch webhook events
        if (status === 'in-progress') {
            await webhookEngine.dispatch('call.answered', { callSid: CallSid, status });
        } else if (status === 'completed') {
            await webhookEngine.dispatch('call.completed', {
                callSid: CallSid,
                status,
                duration: parseInt(CallDuration || '0'),
            });
        }
    }

    res.status(200).send('OK');
});

// POST /sw/amd-status — asynchronous AMD callback
router.post('/amd-status', async (req: Request, res: Response): Promise<void> => {
    const callSid = req.body.CallSid as string | undefined;
    const answeredBy = (req.body.AnsweredBy || req.body.MachineDetectionResult || 'unknown') as string;
    const mode = (req.query.mode as string) || 'agent';
    const aiTarget = (req.query.aiTarget as string) || config.ai.transferTarget;

    logger.info('AMD callback received', { callSid, answeredBy, mode });

    if (!callSid) {
        res.status(200).send('OK');
        return;
    }

    const isHuman = answeredBy.includes('human');
    const isMachine = answeredBy.includes('machine') || answeredBy.includes('fax') || answeredBy.includes('unknown');

    if (mode === 'ai') {
        if (isHuman && aiTarget) {
            const connectUrl = `${req.protocol}://${req.get('host')}/sw/ai-connect?aiTarget=${encodeURIComponent(aiTarget)}`;
            await signalwireService.redirectLiveCall({ providerCallId: callSid, callbackUrl: connectUrl });
        }
        if (isMachine) {
            const machineUrl = `${req.protocol}://${req.get('host')}/sw/amd-machine`;
            await signalwireService.redirectLiveCall({ providerCallId: callSid, callbackUrl: machineUrl });
        }
    }

    res.status(200).send('OK');
});

// POST /sw/recording-status — recording completion callback
router.post('/recording-status', async (req: Request, res: Response): Promise<void> => {
    const { CallSid, RecordingUrl } = req.body;
    if (CallSid && RecordingUrl) {
        await prisma.call.updateMany({
            where: { signalwireCallSid: CallSid },
            data: { recordingUrl: RecordingUrl },
        });
        const linkedCall = await prisma.call.findFirst({
            where: { signalwireCallSid: CallSid },
            select: { id: true, accountId: true },
        });
        await callSessionService.addRecording({
            provider: 'signalwire',
            providerCallId: CallSid,
            callId: linkedCall?.id,
            url: RecordingUrl,
            status: 'available',
        });
        await callAuditService.track({
            type: 'call.recording.ready',
            callId: linkedCall?.id,
            callSid: CallSid,
            details: { recordingUrl: RecordingUrl },
            source: 'signalwire.recording_status',
        });
        await crmAdapter.postRecordingTranscript({
            call_id: linkedCall?.id || null,
            provider: 'signalwire',
            provider_call_id: CallSid,
            recording_url: RecordingUrl,
            account_id: linkedCall?.accountId || null,
        });
        logger.info('Recording URL saved', { callSid: CallSid });
    }
    res.status(200).send('OK');
});

export default router;
