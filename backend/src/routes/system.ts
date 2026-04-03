import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { config } from '../config';
import { providerRegistry } from '../services/provider-registry';
import { signalwireService } from '../services/signalwire';
import { getBackendBaseUrl } from '../utils/backend-url';

const router = Router();
const extractDetails = (payload: unknown): Record<string, unknown> | null => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const details = (payload as Record<string, unknown>).details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    return details as Record<string, unknown>;
};

router.get('/readiness', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const backendBaseUrl = getBackendBaseUrl(req);
    const [users, phoneNumbers, queues, campaigns] = await Promise.all([
        prisma.user.findMany({
            where: { role: { in: ['agent', 'supervisor', 'admin'] } },
            select: { id: true, firstName: true, lastName: true, role: true, status: true, extension: true },
            orderBy: [{ role: 'desc' }, { lastName: 'asc' }],
        }),
        prisma.phoneNumber.findMany({
            where: { isActive: true },
            select: { number: true, label: true, type: true, assignedTo: true },
            orderBy: { createdAt: 'asc' },
        }),
        prisma.queueConfig.findMany({
            where: { isActive: true },
            select: { id: true, name: true, holdTimeout: true, overflowAction: true },
            orderBy: { name: 'asc' },
        }),
        prisma.campaign.findMany({
            where: { status: 'active' },
            select: { id: true, name: true, dialMode: true, aiTargetEnabled: true },
            orderBy: { updatedAt: 'desc' },
        }),
    ]);

    const primaryTelephonyProvider = providerRegistry.getPrimaryTelephonyProvider();
    const primaryAIProvider = providerRegistry.getPrimaryAIProvider();
    const missingExtensions = users
        .filter((user) => !user.extension)
        .map((user) => ({
            id: user.id,
            name: `${user.firstName} ${user.lastName}`,
            role: user.role,
            status: user.status,
        }));

    const warnings: string[] = [];
    if (!config.publicUrls.backend) {
        warnings.push('BACKEND_PUBLIC_URL is not configured. Live callbacks depend on request host unless this is set explicitly.');
    }
    if (backendBaseUrl.includes('localhost')) {
        warnings.push('The current backend base URL resolves to localhost. Live webhooks require a public URL such as ngrok or production hosting.');
    }
    if (!config.isSignalWireConfigured) {
        warnings.push('SignalWire credentials are incomplete.');
    }
    if (!config.signalwire.allowSubscriberProvisioning) {
        warnings.push('SignalWire subscriber provisioning is disabled for new endpoints. Existing approved SignalWire subscribers can still receive fresh browser tokens and connect.');
    }
    if (config.dialer.mode === 'live' && primaryTelephonyProvider.name === 'signalwire' && !config.isSignalWireHumanBrowserOutboundSupported) {
        warnings.push(`Live human outbound is blocked while SIGNALWIRE_SOFTPHONE_TRANSPORT=${config.signalwire.softphoneTransport}. The current Browser SDK v3 / Fabric subscriber path can receive tokens, but it cannot be used as a PSTN/SIP softphone leg for manual outbound.`);
    }
    if (missingExtensions.length > 0) {
        warnings.push(`${missingExtensions.length} agent endpoints are missing explicit extensions. Inbound routing will fall back to internal user IDs, but stable SIP-style extension mapping is still recommended.`);
    }
    if (phoneNumbers.length === 0) {
        warnings.push('No active phone numbers are configured in the local database.');
    }

    res.json({
        environment: {
            nodeEnv: config.nodeEnv,
            port: config.port,
            frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
            backendBaseUrl,
            backendPublicUrlConfigured: !!config.publicUrls.backend,
            dialerMode: config.dialer.mode,
        },
        providers: {
            telephony: {
                selected: primaryTelephonyProvider.name,
                signalwireConfigured: config.isSignalWireConfigured,
                signalwireSpaceUrl: config.signalwire.spaceUrl || null,
                browserTokenCapable: signalwireService.isConfigured,
                subscriberProvisioningEnabled: config.signalwire.allowSubscriberProvisioning,
                softphoneTransport: config.signalwire.softphoneTransport,
                humanBrowserOutboundSupported: config.isSignalWireHumanBrowserOutboundSupported,
                inboundWebhookUrl: `${backendBaseUrl}/sw/inbound`,
                callStatusWebhookUrl: `${backendBaseUrl}/sw/call-status`,
                recordingWebhookUrl: `${backendBaseUrl}/sw/recording-status`,
                transcriptionWebhookUrl: `${backendBaseUrl}/sw/transcription`,
                amdWebhookUrl: `${backendBaseUrl}/sw/amd-status`,
            },
            ai: {
                selected: primaryAIProvider.name,
                retellConfigured: config.isRetellConfigured,
            },
            crm: {
                configured: config.isCrmConfigured,
            },
        },
        staffing: {
            totalAgents: users.length,
            agentsWithExtensions: users.length - missingExtensions.length,
            missingExtensions,
        },
        phoneNumbers: {
            totalActive: phoneNumbers.length,
            outbound: phoneNumbers.filter((number) => ['outbound', 'agents'].includes(number.assignedTo || '') || number.type === 'local'),
            inbound: phoneNumbers.filter((number) => number.type === 'toll-free' || number.assignedTo === 'agents'),
        },
        queues,
        campaigns,
        warnings,
    });
});

router.post('/signalwire/browser-token-test', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { id: true, username: true, email: true, extension: true },
    });

    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }

    const endpointReference = user.extension || user.id;
    const result = await signalwireService.generateBrowserToken(user.id, user.username, user.email, endpointReference);
    if (!result.token) {
        res.status(400).json({
            ok: false,
            error: result.error || 'browser_token_failed',
        });
        return;
    }

    res.json({
        ok: true,
        provider: signalwireService.name,
        metadata: result.metadata || {},
        endpointReference,
        tokenPreview: `${result.token.slice(0, 18)}...`,
    });
});

router.get('/signalwire/diagnostics', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentEvents, recentCalls, recentVoicemails, activeSessions, agents, todayCalls] = await Promise.all([
        prisma.callEvent.findMany({
            where: {
                OR: [
                    { source: { startsWith: 'signalwire' } },
                    { provider: 'signalwire' },
                ],
            },
            orderBy: { createdAt: 'desc' },
            take: 75,
        }),
        prisma.call.findMany({
            where: {
                OR: [
                    { provider: 'signalwire' },
                    { signalwireCallSid: { not: null } },
                ],
            },
            include: {
                agent: { select: { firstName: true, lastName: true, username: true, extension: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 25,
        }),
        prisma.voicemail.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
        }),
        prisma.callSession.count({
            where: {
                provider: 'signalwire',
                status: { in: ['initiated', 'ringing', 'in-progress'] },
            },
        }),
        prisma.user.findMany({
            where: { role: { in: ['agent', 'supervisor', 'admin'] } },
            select: { id: true, firstName: true, lastName: true, status: true, extension: true },
            orderBy: { lastName: 'asc' },
        }),
        prisma.call.findMany({
            where: {
                OR: [
                    { provider: 'signalwire' },
                    { signalwireCallSid: { not: null } },
                ],
                createdAt: { gte: since },
            },
            select: { id: true, direction: true, status: true },
        }),
    ]);

    const inboundToday = todayCalls.filter((call) => call.direction === 'inbound').length;
    const outboundToday = todayCalls.filter((call) => call.direction === 'outbound').length;
    const completedToday = todayCalls.filter((call) => call.status === 'completed').length;

    res.json({
        summary: {
            activeSignalWireSessions: activeSessions,
            signalwireCalls24h: todayCalls.length,
            inbound24h: inboundToday,
            outbound24h: outboundToday,
            completed24h: completedToday,
            webhookEvents24h: recentEvents.filter((event) => event.createdAt >= since).length,
        },
        agents: agents.map((agent) => ({
            id: agent.id,
            name: `${agent.firstName} ${agent.lastName}`,
            status: agent.status,
            endpointReference: agent.extension || agent.id,
            usingFallbackId: !agent.extension,
        })),
        recentCalls: recentCalls.map((call) => ({
            id: call.id,
            providerCallId: call.providerCallId || call.signalwireCallSid,
            direction: call.direction,
            status: call.status,
            mode: call.mode,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            createdAt: call.createdAt,
            completedAt: call.completedAt,
            duration: call.duration,
            accountId: call.accountId,
            agent: call.agent
                ? {
                    name: `${call.agent.firstName} ${call.agent.lastName}`,
                    username: call.agent.username,
                    extension: call.agent.extension || null,
                }
                : null,
        })),
        recentEvents: recentEvents.map((event) => ({
            id: event.id,
            createdAt: event.createdAt,
            type: event.type,
            source: event.source,
            status: event.status,
            providerCallId: event.providerCallId,
            callId: event.callId,
            details: extractDetails(event.payload),
        })),
        recentVoicemails: recentVoicemails.map((voicemail) => ({
            id: voicemail.id,
            fromNumber: voicemail.fromNumber,
            toNumber: voicemail.toNumber,
            duration: voicemail.duration,
            audioUrl: voicemail.audioUrl,
            transcription: voicemail.transcription,
            createdAt: voicemail.createdAt,
        })),
    });
});

export default router;
