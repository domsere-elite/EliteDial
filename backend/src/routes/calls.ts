import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { dncService } from '../services/dnc';
import { webhookEngine } from '../services/webhook-engine';
import { callAuditService } from '../services/call-audit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { providerRegistry } from '../services/provider-registry';
import { callSessionService } from '../services/call-session-service';
import { phoneNumberService } from '../services/phone-number-service';
import { crmAdapter } from '../services/crm-adapter';
import { getBackendBaseUrl } from '../utils/backend-url';
import { signalwireService } from '../services/signalwire';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { isWithinCallingWindow, getContactTimezone } from '../services/tcpa';
import {
    validate, initiateCallSchema, browserSessionSchema, browserStatusSchema,
    dispositionSchema, transferSchema, simulateInboundSchema, inboundAttachSchema,
} from '../lib/validation';

const router = Router();
const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));
const queryValue = (value: string | string[] | undefined): string | undefined => {
    if (Array.isArray(value)) return value[0];
    return value;
};

const mapRelayStateToCallStatus = (relayState: string): string => {
    switch (relayState) {
        case 'new':
        case 'trying':
        case 'requesting':
            return 'initiated';
        case 'ringing':
        case 'early':
            return 'ringing';
        case 'active':
        case 'held':
            return 'in-progress';
        case 'hangup':
        case 'destroy':
        case 'purge':
            return 'completed';
        default:
            return relayState || 'initiated';
    }
};

const resolveCampaignContactOutcome = async (callId: string, outcome: 'completed' | 'failed' | 'no-answer' | 'busy' | 'voicemail') => {
    const attempt = await prisma.campaignAttempt.findFirst({
        where: { callId },
        orderBy: { startedAt: 'desc' },
        select: {
            id: true,
            contactId: true,
            contact: {
                select: {
                    attemptCount: true,
                    campaign: {
                        select: {
                            maxAttemptsPerLead: true,
                            retryDelaySeconds: true,
                        },
                    },
                },
            },
        },
    });

    if (!attempt) return;

    const outcomeMap: Record<string, string> = {
        completed: 'human',
        failed: 'failed',
        'no-answer': 'no-answer',
        busy: 'busy',
        voicemail: 'voicemail',
    };

    await prisma.campaignAttempt.update({
        where: { id: attempt.id },
        data: {
            status: outcome,
            outcome: outcomeMap[outcome] || outcome,
            completedAt: new Date(),
        },
    });

    if (outcome === 'completed' || outcome === 'voicemail') {
        await campaignReservationService.completeReservation(attempt.contactId, 'completed');
        return;
    }

    const maxedOut = attempt.contact.attemptCount >= attempt.contact.campaign.maxAttemptsPerLead;
    await campaignReservationService.failReservation(
        attempt.contactId,
        maxedOut ? 'failed' : 'queued',
        maxedOut ? null : new Date(Date.now() + Math.max(30, attempt.contact.campaign.retryDelaySeconds) * 1000),
    );
};

// POST /api/calls/initiate — click-to-dial
router.post('/initiate', authenticate, validate(initiateCallSchema), async (req: Request, res: Response): Promise<void> => {
    const { toNumber, fromNumber, accountId, accountName, mode = 'agent', aiTarget, amdEnabled, aiAgentId, dynamicVariables, metadata, mockScenario, reservationToken } = req.body;
    const isAiMode = mode === 'ai';
    const requestedCampaignContactId = req.body.campaignContactId as string | undefined;
    const primaryTelephonyProvider = providerRegistry.getPrimaryTelephonyProvider();
    const primaryAIProvider = providerRegistry.getPrimaryAIProvider();

    if (!toNumber) {
        res.status(400).json({ error: 'toNumber is required' });
        return;
    }

    if (!isAiMode && !req.user?.id) {
        res.status(400).json({ error: 'agent id is required for agent mode' });
        return;
    }

    if (
        !isAiMode &&
        config.dialer.mode === 'live' &&
        primaryTelephonyProvider.name === 'signalwire' &&
        !config.isSignalWireHumanBrowserOutboundSupported
    ) {
        res.status(409).json({
            error: 'Live human outbound is blocked: current SignalWire softphone transport is fabric-v3, which does not support PSTN/SIP browser dialing. Migrate the agent leg to a SIP endpoint or SignalWire Relay v2 before enabling live manual outbound.',
            unsupportedSoftphoneTransport: config.signalwire.softphoneTransport,
        });
        return;
    }

    if (isAiMode && primaryAIProvider.name !== 'mock-ai' && !(aiTarget || process.env.AI_TRANSFER_TARGET)) {
        res.status(400).json({ error: 'aiTarget is required for ai mode or set AI_TRANSFER_TARGET env var' });
        return;
    }

    // TCPA: Check DNC before dialing
    const isDNC = await dncService.isOnDNC(toNumber);
    if (isDNC) {
        res.status(403).json({ error: 'Number is on the Do Not Call list', dncBlocked: true });
        return;
    }

    const linkedContact = requestedCampaignContactId
        ? await prisma.campaignContact.findUnique({ where: { id: requestedCampaignContactId } })
        : null;

    const selectedFromNumber = linkedContact
        ? (await phoneNumberService.resolveOutboundDID({
            toNumber,
            campaignId: linkedContact.campaignId,
            contactId: linkedContact.id,
            preferredFromNumber: fromNumber,
        })).number
        : await phoneNumberService.resolveOutboundNumber(fromNumber);

    const callMode = isAiMode
        ? 'ai_outbound'
        : 'manual';

    // TCPA: Check calling window for campaign-linked contacts
    if (linkedContact) {
        const campaign = await prisma.campaign.findUnique({
            where: { id: linkedContact.campaignId },
            select: { timezone: true },
        });
        const contactTz = getContactTimezone(linkedContact.timezone, campaign?.timezone);
        if (!isWithinCallingWindow(contactTz)) {
            res.status(403).json({
                error: `TCPA: Cannot call this contact — it is currently outside the permitted calling window (8 AM – 9 PM) in ${contactTz}.`,
                tcpaBlocked: true,
                timezone: contactTz,
            });
            return;
        }
    }

    if (linkedContact) {
        const claimedContact = await campaignReservationService.confirmDialReservation(linkedContact.id, {
            type: 'agent',
            userId: req.user?.id || null,
            token: typeof reservationToken === 'string' ? reservationToken : null,
        });

        if (!claimedContact) {
            res.status(409).json({ error: 'Lead reservation is no longer valid. Fetch the next contact again.' });
            return;
        }
    }

    const { call, session } = await callSessionService.createUnifiedCall({
        provider: isAiMode ? primaryAIProvider.name : primaryTelephonyProvider.name,
        channel: isAiMode ? 'ai' : 'human',
        mode: callMode,
        direction: 'outbound',
        fromNumber: selectedFromNumber,
        toNumber,
        status: 'initiated',
        agentId: isAiMode ? null : req.user!.id,
        accountId,
        accountName,
        campaignId: linkedContact?.campaignId || null,
        contactId: linkedContact?.id || null,
        leadExternalId: linkedContact?.externalId || null,
        crmContext: metadata || undefined,
        dncChecked: true,
        fdcpaNotice: true,
    });

    // Link to campaign if campaignContactId provided
    if (linkedContact) {
        try {
            await prisma.campaignAttempt.create({
                data: {
                    campaignId: linkedContact.campaignId,
                    contactId: linkedContact.id,
                    callId: call.id,
                    status: 'initiated',
                }
            });
        } catch (err) {
            logger.error('Failed to link call to campaign contact', { error: err, callId: call.id, contactId: requestedCampaignContactId });
        }
    }

    const baseUrl = getBackendBaseUrl(req);
    let providerResult;

    try {
        providerResult = isAiMode
            ? await primaryAIProvider.launchOutboundCall({
                fromNumber: selectedFromNumber,
                toNumber,
                agentId: aiAgentId || config.retell.defaultAgentId,
                metadata: {
                    call_id: call.id,
                    call_session_id: session.id,
                    account_id: accountId || '',
                    campaign_id: linkedContact?.campaignId || '',
                    contact_id: linkedContact?.id || '',
                    ai_target: aiTarget || '',
                    mock_scenario: mockScenario || '',
                    ...(metadata || {}),
                },
                dynamicVariables: dynamicVariables || {},
                customSipHeaders: {
                    'X-EliteDial-Call-Id': call.id,
                    'X-EliteDial-Session-Id': session.id,
                    ...(accountId ? { 'X-EliteDial-Account-Id': accountId } : {}),
                    ...(linkedContact?.campaignId ? { 'X-EliteDial-Campaign-Id': linkedContact.campaignId } : {}),
                    ...(linkedContact?.id ? { 'X-EliteDial-Contact-Id': linkedContact.id } : {}),
                },
            })
            : await primaryTelephonyProvider.initiateOutboundCall({
                fromNumber: selectedFromNumber,
                toNumber,
                agentId: req.user!.id,
                callbackUrl: baseUrl,
                aiTransferTarget: aiTarget || undefined,
                amdEnabled,
                metadata: {
                    callId: call.id,
                    sessionId: session.id,
                    campaignId: linkedContact?.campaignId || null,
                    contactId: linkedContact?.id || null,
                    mockScenario: mockScenario || null,
                },
            });
    } catch (error) {
        logger.error('Failed to initiate outbound provider call', { error, callId: call.id, requestedCampaignContactId });
        await prisma.call.update({
            where: { id: call.id },
            data: { status: 'failed', completedAt: new Date() },
        });
        await callSessionService.syncCall(call.id, { status: 'failed' });

        if (linkedContact) {
            await resolveCampaignContactOutcome(call.id, 'failed');
        }

        res.status(502).json({ error: 'Failed to initiate outbound call with provider' });
        return;
    }

    if (providerResult?.providerCallId) {
        await callSessionService.attachProviderIdentifiers(call.id, {
            provider: providerResult.provider,
            providerCallId: providerResult.providerCallId,
            providerMetadata: providerResult.raw || undefined,
        });
        await prisma.call.update({
            where: { id: call.id },
            data: { status: 'ringing' },
        });
        await prisma.callSession.update({
            where: { id: session.id },
            data: { status: 'ringing', lastEventAt: new Date() },
        });
    } else {
        await prisma.call.update({
            where: { id: call.id },
            data: { status: 'failed', completedAt: new Date() },
        });
        await callSessionService.syncCall(call.id, { status: 'failed' });

        if (linkedContact) {
            await resolveCampaignContactOutcome(call.id, 'failed');
        }

        res.status(502).json({ error: 'Provider did not return a live call identifier' });
        return;
    }

    if (!isAiMode) {
        await prisma.profile.update({ where: { id: req.user!.id }, data: { status: 'on-call' } });
    }

    logger.info('Outbound call initiated', {
        callId: call.id,
        to: toNumber,
        from: selectedFromNumber,
        mode: callMode,
        provider: providerResult?.provider || (isAiMode ? primaryAIProvider.name : primaryTelephonyProvider.name),
        agent: isAiMode ? 'retell-ai' : req.user!.email,
        campaignContactId: requestedCampaignContactId,
    });

    await callAuditService.track({
        type: 'call.outbound.initiated',
        callId: call.id,
        callSid: providerResult?.providerCallId,
        details: {
            toNumber,
            fromNumber: selectedFromNumber,
            mode: callMode,
            provider: providerResult?.provider || (isAiMode ? primaryAIProvider.name : primaryTelephonyProvider.name),
        },
        source: 'api.calls.initiate',
        status: providerResult?.providerCallId ? 'ringing' : 'initiated',
    });

    await crmAdapter.postCallEvent({
        event_type: 'call.initiated',
        call_id: call.id,
        call_session_id: session.id,
        provider: providerResult?.provider || (isAiMode ? primaryAIProvider.name : primaryTelephonyProvider.name),
        provider_call_id: providerResult?.providerCallId || null,
        mode: callMode,
        channel: isAiMode ? 'ai' : 'human',
        to_number: toNumber,
        from_number: selectedFromNumber,
        account_id: accountId || null,
        campaign_id: linkedContact?.campaignId || null,
        contact_id: linkedContact?.id || null,
        agent_id: isAiMode ? null : req.user!.id,
    });

    res.json({
        callId: call.id,
        callSessionId: session.id,
        status: 'initiated',
        callSid: providerResult?.providerCallId,
        mode: callMode,
        provider: providerResult?.provider || (isAiMode ? primaryAIProvider.name : primaryTelephonyProvider.name),
        amdEnabled: amdEnabled ?? true,
        dncChecked: true,
        fromNumber: selectedFromNumber,
    });
});

router.post('/browser-session', authenticate, validate(browserSessionSchema), async (req: Request, res: Response): Promise<void> => {
    const { toNumber, fromNumber, accountId, accountName, reservationToken } = req.body;
    const requestedCampaignContactId = req.body.campaignContactId as string | undefined;

    if (!toNumber) {
        res.status(400).json({ error: 'toNumber is required' });
        return;
    }

    const isDNC = await dncService.isOnDNC(toNumber);
    if (isDNC) {
        res.status(403).json({ error: 'Number is on the Do Not Call list', dncBlocked: true });
        return;
    }

    const linkedContact = requestedCampaignContactId
        ? await prisma.campaignContact.findUnique({ where: { id: requestedCampaignContactId } })
        : null;

    const selectedFromNumber = linkedContact
        ? (await phoneNumberService.resolveOutboundDID({
            toNumber,
            campaignId: linkedContact.campaignId,
            contactId: linkedContact.id,
            preferredFromNumber: fromNumber,
        })).number
        : await phoneNumberService.resolveOutboundNumber(fromNumber);

    if (linkedContact) {
        const claimedContact = await campaignReservationService.confirmDialReservation(linkedContact.id, {
            type: 'agent',
            userId: req.user!.id,
            token: typeof reservationToken === 'string' ? reservationToken : null,
        });

        if (!claimedContact) {
            res.status(409).json({ error: 'Lead reservation is no longer valid. Fetch the next contact again.' });
            return;
        }
    }

    const callMode = 'manual';
    const { call, session } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: callMode,
        direction: 'outbound',
        fromNumber: selectedFromNumber,
        toNumber,
        status: 'initiated',
        agentId: req.user!.id,
        accountId,
        accountName,
        campaignId: linkedContact?.campaignId || null,
        contactId: linkedContact?.id || null,
        leadExternalId: linkedContact?.externalId || null,
        providerMetadata: {
            transport: 'relay-v2',
            browserInitiated: true,
        },
        dncChecked: true,
        fdcpaNotice: true,
    });

    if (linkedContact) {
        try {
            await prisma.campaignAttempt.create({
                data: {
                    campaignId: linkedContact.campaignId,
                    contactId: linkedContact.id,
                    callId: call.id,
                    status: 'initiated',
                },
            });
        } catch (error) {
            logger.error('Failed to link relay browser session to campaign contact', { error, callId: call.id, contactId: linkedContact.id });
        }
    }

    await callAuditService.track({
        type: 'call.outbound.session_created',
        callId: call.id,
        details: {
            toNumber,
            fromNumber: selectedFromNumber,
            transport: 'relay-v2',
            mode: callMode,
        },
        source: 'api.calls.browser_session',
        status: 'initiated',
    });

    res.status(201).json({
        callId: call.id,
        callSessionId: session.id,
        status: call.status,
        fromNumber: selectedFromNumber,
        mode: callMode,
        provider: 'signalwire',
        transport: 'relay-v2',
    });
});

router.post('/:id/browser-status', authenticate, validate(browserStatusSchema), async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const {
        providerCallId,
        relayState,
        previousRelayState,
        duration,
        details,
    } = req.body;

    const existing = await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, agentId: true, provider: true, providerCallId: true, accountId: true },
    });

    if (!existing) {
        res.status(404).json({ error: 'Call not found' });
        return;
    }

    if (existing.agentId !== req.user!.id && req.user!.role === 'agent') {
        res.status(403).json({ error: 'Cannot update another agent call' });
        return;
    }

    const mappedStatus = mapRelayStateToCallStatus((relayState || '').toString());

    if (providerCallId && !existing.providerCallId) {
        await callSessionService.attachProviderIdentifiers(callId, {
            provider: existing.provider,
            providerCallId,
            providerMetadata: {
                transport: 'relay-v2',
                relayState,
                previousRelayState: previousRelayState || null,
                ...(details || {}),
            },
        });
    }

    const completedAt = ['completed', 'failed', 'busy', 'no-answer', 'voicemail'].includes(mappedStatus)
        ? new Date()
        : null;

    await prisma.call.update({
        where: { id: callId },
        data: {
            status: mappedStatus,
            duration: typeof duration === 'number' ? duration : undefined,
            completedAt: completedAt || undefined,
            providerMetadata: {
                transport: 'relay-v2',
                relayState: relayState || null,
                previousRelayState: previousRelayState || null,
                ...(details || {}),
            },
        },
    });

    await callSessionService.syncCall(callId, {
        provider: existing.provider,
        providerCallId: providerCallId || existing.providerCallId || undefined,
        status: mappedStatus,
        providerMetadata: {
            transport: 'relay-v2',
            relayState: relayState || null,
            previousRelayState: previousRelayState || null,
            ...(details || {}),
        },
    });

    await callAuditService.track({
        type: 'call.status',
        callId,
        callSid: providerCallId || existing.providerCallId || undefined,
        details: {
            status: mappedStatus,
            relayState: relayState || 'unknown',
            previousRelayState: previousRelayState || 'unknown',
            transport: 'relay-v2',
            ...(details || {}),
        },
        source: 'api.calls.browser_status',
        status: mappedStatus,
        idempotencyKey: providerCallId
            ? `relay:${providerCallId}:${relayState || 'unknown'}:${previousRelayState || 'unknown'}:${duration || 0}`
            : undefined,
    });

    if (mappedStatus === 'in-progress') {
        await prisma.profile.updateMany({
            where: { id: req.user!.id },
            data: { status: 'on-call' },
        });
    }

    if (['completed', 'failed', 'busy', 'no-answer', 'voicemail'].includes(mappedStatus)) {
        await prisma.profile.updateMany({
            where: { id: req.user!.id },
            data: { status: 'available' },
        });
        await crmAdapter.postCallEvent({
            event_type: 'call.completed',
            call_id: callId,
            call_session_id: null,
            provider: existing.provider,
            provider_call_id: providerCallId || existing.providerCallId || null,
            mode: 'manual',
            channel: 'human',
            agent_id: req.user!.id,
            account_id: existing.accountId || null,
        });
    }

    res.json({
        ok: true,
        callId,
        status: mappedStatus,
        providerCallId: providerCallId || existing.providerCallId || null,
    });
});

// GET /api/calls — call history with filters
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
    const { page = '1', limit = '25', direction, status, agentId, startDate, endDate, accountId } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const where: any = {};

    // Agents only see their own calls unless supervisor+
    if (req.user!.role === 'agent') {
        where.agentId = req.user!.id;
    } else {
        const qAgentId = queryValue(agentId as string | string[] | undefined);
        if (qAgentId) where.agentId = qAgentId;
    }

    const qDirection = queryValue(direction as string | string[] | undefined);
    const qStatus = queryValue(status as string | string[] | undefined);
    const qAccountId = queryValue(accountId as string | string[] | undefined);
    const qStartDate = queryValue(startDate as string | string[] | undefined);
    const qEndDate = queryValue(endDate as string | string[] | undefined);

    if (qDirection) where.direction = qDirection;
    if (qStatus) where.status = qStatus;
    if (qAccountId) where.accountId = qAccountId;
    if (qStartDate || qEndDate) {
        where.createdAt = {};
        if (qStartDate) where.createdAt.gte = new Date(qStartDate);
        if (qEndDate) where.createdAt.lte = new Date(qEndDate);
    }

    const [calls, total] = await Promise.all([
        prisma.call.findMany({
            where,
            include: { agent: { select: { id: true, firstName: true, lastName: true, email: true } } },
            orderBy: { createdAt: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        }),
        prisma.call.count({ where }),
    ]);

    res.json({ calls, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
});

router.get('/outbound-numbers', authenticate, async (req: Request, res: Response): Promise<void> => {
    const numbers = await phoneNumberService.listActiveOutboundNumbers();
    res.json({ numbers });
});

router.get('/lookup/phone/:phoneNumber', authenticate, async (req: Request, res: Response): Promise<void> => {
    const phoneNumber = paramValue(req.params.phoneNumber);
    const account = await crmAdapter.lookupByPhone(phoneNumber);
    res.json({ account });
});

// GET /api/calls/audit/recent — latest call flow events
router.get('/audit/recent', authenticate, async (req: Request, res: Response): Promise<void> => {
    const limit = Number(req.query.limit || 50);
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    res.json({ events: await callAuditService.getRecent(safeLimit) });
});

// POST /api/calls/simulate/inbound — dev helper for inbound scenario simulation
router.post('/simulate/inbound', authenticate, validate(simulateInboundSchema), async (req: Request, res: Response): Promise<void> => {
    const { scenario, fromNumber, toNumber } = req.body;

    const callSid = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const sourceNumber = fromNumber || `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`;
    const destinationNumber = toNumber || '+15551000001';

    const finalStatus = scenario === 'answer'
        ? 'in-progress'
        : (scenario === 'no-answer' ? 'no-answer' : 'voicemail');

    const { call, session } = await callSessionService.createUnifiedCall({
        provider: 'mock',
        channel: 'human',
        mode: 'inbound',
        direction: 'inbound',
        fromNumber: sourceNumber,
        toNumber: destinationNumber,
        status: finalStatus,
        providerCallId: callSid,
        agentId: req.user!.id,
        providerMetadata: { scenario },
        completedAt: scenario === 'answer' ? null : new Date(),
    });

    await callAuditService.track({
        type: 'inbound.received',
        callId: call.id,
        callSid,
        details: {
            fromNumber: sourceNumber,
            toNumber: destinationNumber,
            source: 'simulator.api',
        },
        source: 'api.calls.simulate_inbound',
    });

    await callAuditService.track({
        type: 'inbound.agent.reserved',
        callId: call.id,
        callSid,
        details: {
            agentId: req.user!.id,
            source: 'simulator.api',
        },
        source: 'api.calls.simulate_inbound',
    });

    await callAuditService.track({
        type: 'call.status',
        callId: call.id,
        callSid,
        details: {
            status: finalStatus,
            source: 'simulator.api',
        },
        source: 'api.calls.simulate_inbound',
        status: finalStatus,
    });

    if (scenario === 'voicemail') {
        await prisma.voicemail.create({
            data: {
                fromNumber: sourceNumber,
                toNumber: destinationNumber,
                duration: Math.floor(Math.random() * 45) + 10,
                transcription: 'Simulation voicemail: customer requested callback.',
                assignedToId: req.user!.id,
            },
        });
    }

    if (scenario !== 'answer') {
        await prisma.profile.update({ where: { id: req.user!.id }, data: { status: 'available' } });
    }

    res.status(201).json({
        callId: call.id,
        callSessionId: session.id,
        callSid,
        scenario,
        status: finalStatus,
    });
});

// POST /api/calls/inbound/attach — fetch/create inbound call for accepted softphone invite
router.post('/inbound/attach', authenticate, validate(inboundAttachSchema), async (req: Request, res: Response): Promise<void> => {
    const { callSid, fromNumber, toNumber } = req.body;

    const existing = await prisma.call.findFirst({
        where: { signalwireCallId: callSid },
    });

    if (existing) {
        const nextStatus = existing.status === 'initiated' ? 'in-progress' : existing.status;
        const updated = await prisma.call.update({
            where: { id: existing.id },
            data: {
                agentId: req.user!.id,
                status: nextStatus,
                fromNumber: existing.fromNumber || fromNumber || 'unknown',
                toNumber: existing.toNumber || toNumber || 'unknown',
            },
        });

        if (nextStatus === 'in-progress' && existing.status !== 'in-progress') {
            await callAuditService.track({
                type: 'call.status',
                callId: updated.id,
                callSid,
                details: {
                    status: 'in-progress',
                    source: 'agent.attach',
                },
                source: 'api.calls.inbound_attach',
                status: 'in-progress',
            });
        }

        await callSessionService.syncCall(updated.id, {
            provider: existing.provider,
            providerCallId: callSid,
            mode: 'inbound',
            channel: updated.channel as 'human' | 'ai',
        });

        res.json({ callId: updated.id, status: updated.status, callSid });
        return;
    }

    const { call: created, session } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: 'inbound',
        direction: 'inbound',
        fromNumber: fromNumber || 'unknown',
        toNumber: toNumber || 'unknown',
        status: 'in-progress',
        providerCallId: callSid,
        agentId: req.user!.id,
    });

    await callAuditService.track({
        type: 'inbound.received',
        callId: created.id,
        callSid,
        details: {
            fromNumber: fromNumber || 'unknown',
            toNumber: toNumber || 'unknown',
            source: 'simulator.attach',
        },
        source: 'api.calls.inbound_attach',
    });
    await callAuditService.track({
        type: 'inbound.agent.reserved',
        callId: created.id,
        callSid,
        details: {
            agentId: req.user!.id,
            source: 'simulator.attach',
        },
        source: 'api.calls.inbound_attach',
    });
    await callAuditService.track({
        type: 'call.status',
        callId: created.id,
        callSid,
        details: {
            status: 'in-progress',
            source: 'agent.attach',
        },
        source: 'api.calls.inbound_attach',
        status: 'in-progress',
    });

    res.json({ callId: created.id, callSessionId: session.id, status: created.status, callSid });
});

// POST /api/calls/:id/hangup — operator-driven call termination
router.post('/:id/hangup', authenticate, async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const existing = await prisma.call.findUnique({ where: { id: callId } });

    if (!existing) {
        res.status(404).json({ error: 'Call not found' });
        return;
    }

    const completedAt = existing.completedAt || new Date();
    const nextStatus = ['completed', 'failed', 'busy', 'no-answer', 'voicemail'].includes(existing.status)
        ? existing.status
        : 'completed';

    const call = await prisma.call.update({
        where: { id: callId },
        data: {
            status: nextStatus,
            completedAt,
        },
    });

    await prisma.profile.update({ where: { id: req.user!.id }, data: { status: 'available' } });
    await resolveCampaignContactOutcome(
        call.id,
        nextStatus === 'busy' || nextStatus === 'failed' || nextStatus === 'no-answer' || nextStatus === 'voicemail'
            ? nextStatus
            : 'completed',
    );

    await callSessionService.syncCall(call.id);
    await callAuditService.track({
        type: 'call.status',
        callId: call.id,
        callSid: call.providerCallId || call.signalwireCallId || undefined,
        details: {
            status: nextStatus,
            source: 'agent.hangup',
        },
        source: 'api.calls.hangup',
        status: nextStatus,
    });

    await webhookEngine.dispatch('call.completed', {
        callId: call.id,
        agentId: req.user!.id,
        status: nextStatus,
        accountId: call.accountId,
    });

    await crmAdapter.postCallEvent({
        event_type: 'call.completed',
        call_id: call.id,
        call_session_id: null,
        provider: call.provider,
        provider_call_id: call.providerCallId || call.signalwireCallId || null,
        mode: call.mode,
        channel: call.channel,
        to_number: call.toNumber,
        from_number: call.fromNumber,
        account_id: call.accountId || null,
        campaign_id: null,
        contact_id: null,
        agent_id: req.user!.id,
    });

    res.json(call);
});

// GET /api/calls/:id — single call details
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const call = await prisma.call.findUnique({
        where: { id: callId },
        include: { agent: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    if (!call) {
        res.status(404).json({ error: 'Call not found' });
        return;
    }

    // Agents can only view their own calls
    if (req.user!.role === 'agent' && call.agentId !== req.user!.id) {
        res.status(403).json({ error: 'Access denied' });
        return;
    }

    res.json(call);
});

// GET /api/calls/:id/audit — timeline for one call
router.get('/:id/audit', authenticate, async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const call = await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, agentId: true, signalwireCallId: true, createdAt: true, completedAt: true, status: true },
    });

    if (!call) {
        res.status(404).json({ error: 'Call not found' });
        return;
    }

    // Agents can only view audit for their own calls
    if (req.user!.role === 'agent' && call.agentId !== req.user!.id) {
        res.status(403).json({ error: 'Access denied' });
        return;
    }

    const eventLimit = Number(req.query.limit || 100);
    const safeLimit = Number.isFinite(eventLimit) ? Math.min(Math.max(eventLimit, 1), 300) : 100;
    const events = await callAuditService.getByCallId(callId, safeLimit);

    res.json({
        call,
        events,
    });
});

// POST /api/calls/:id/disposition — wrap-up submission
router.post('/:id/disposition', authenticate, validate(dispositionSchema), async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const { dispositionId, note, callbackAt } = req.body;

    const call = await prisma.call.update({
        where: { id: callId },
        data: {
            dispositionId,
            dispositionNote: note,
            status: 'completed',
            completedAt: new Date(),
        },
    });

    if (callbackAt) {
        const attempt = await prisma.campaignAttempt.findFirst({
            where: { callId },
            include: { contact: true },
        });
        if (attempt) {
            await prisma.campaignContact.update({
                where: { id: attempt.contactId },
                data: {
                    status: 'queued',
                    nextAttemptAt: new Date(callbackAt),
                    attemptCount: 0, // Reset attempt count for manual callback scheduling
                },
            });
        }
    }

    // Set agent back to available
    await prisma.profile.update({ where: { id: req.user!.id }, data: { status: 'available' } });
    await resolveCampaignContactOutcome(call.id, 'completed');

    // Push to CRM webhook
    await webhookEngine.dispatch('disposition.submitted', {
        callId: call.id,
        dispositionId,
        note,
        agentId: req.user!.id,
        accountId: call.accountId,
    });

    await callAuditService.track({
        type: 'call.disposition',
        callId: call.id,
        callSid: call.providerCallId || call.signalwireCallId || undefined,
        details: {
            dispositionId,
            agentId: req.user!.id,
        },
        source: 'api.calls.disposition',
        status: 'completed',
    });

    await callSessionService.syncCall(call.id);
    await crmAdapter.postDisposition({
        call_id: call.id,
        provider_call_id: call.providerCallId || call.signalwireCallId || null,
        account_id: call.accountId || null,
        disposition_id: dispositionId,
        note: note || null,
        agent_id: req.user!.id,
    });

    res.json(call);
});

// POST /api/calls/:id/transfer — cold or warm
router.post('/:id/transfer', authenticate, validate(transferSchema), async (req: Request, res: Response): Promise<void> => {
    const callId = paramValue(req.params.id);
    const { targetNumber, type } = req.body;

    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call || !(call.providerCallId || call.signalwireCallId)) {
        res.status(404).json({ error: 'Call not found or missing provider ID' });
        return;
    }

    const callProviderId = call.providerCallId || call.signalwireCallId;
    const baseUrl = getBackendBaseUrl(req);

    try {
        if (type === 'cold') {
            await signalwireService.transferCall(callProviderId!, targetNumber, baseUrl);
        } else {
            // Warm transfer uses the same logic initially for simplicity, could be modified later to use a conference bridge
            await signalwireService.transferCall(callProviderId!, targetNumber, baseUrl);
        }

        await callAuditService.track({
            type: 'call.transfer',
            callId: call.id,
            callSid: callProviderId!,
            details: { targetNumber, type, agentId: req.user!.id },
            source: 'api.calls.transfer',
            status: 'in-progress'
        });

        res.json({ success: true, callId: call.id, type, targetNumber });
    } catch (err) {
        res.status(500).json({ error: 'Transfer failed' });
    }
});

export default router;
