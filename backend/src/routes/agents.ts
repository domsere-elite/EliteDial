import { Router, Request, Response, RequestHandler } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate as defaultAuthenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { signalwireService } from '../services/signalwire';
import { validate, updateAgentStatusSchema } from '../lib/validation';
import { wrapUpService } from '../services/wrap-up-service';
import { cancelAutoResume } from '../services/wrap-up-scheduler';
import { signAgentRoomUrl } from '../lib/signed-url';
import { config } from '../config';

const paramValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : (value || ''));

export interface AgentsRouterDeps {
    exitWrapUp: (agentId: string) => Promise<{ transitioned: boolean }>;
    cancelAutoResume: (agentId: string) => void;
    authenticate?: RequestHandler;
}

const defaultDeps: AgentsRouterDeps = {
    exitWrapUp: (id) => wrapUpService.exitWrapUp(id),
    cancelAutoResume,
};

export function buildAgentsRouter(deps: AgentsRouterDeps = defaultDeps): Router {
    const router = Router();
    const authenticate = deps.authenticate ?? defaultAuthenticate;

    // GET /api/agents — list all agents (supervisor+)
    router.get('/', authenticate, requireMinRole('supervisor'), async (_req: Request, res: Response): Promise<void> => {
        const agents = await prisma.profile.findMany({
            select: {
                id: true, email: true, firstName: true, lastName: true,
                role: true, status: true, extension: true, createdAt: true,
            },
            orderBy: { lastName: 'asc' },
        });
        res.json(agents);
    });

    // GET /api/agents/me/status — current agent's wrap-up state for hydration
    router.get('/me/status', authenticate, async (req: Request, res: Response): Promise<void> => {
        const id = req.user!.id;
        const profile = await prisma.profile.findUnique({
            where: { id },
            select: { id: true, status: true, wrapUpUntil: true },
        });
        if (!profile) {
            res.status(404).json({ error: 'profile not found' });
            return;
        }
        res.json(profile);
    });

    // PATCH /api/agents/:id/status — update availability
    router.patch('/:id/status', authenticate, validate(updateAgentStatusSchema), async (req: Request, res: Response): Promise<void> => {
        const id = paramValue(req.params.id);
        const { status } = req.body;

        // Agents can only update their own status; supervisors/admins can update anyone
        if (req.user!.role === 'agent' && req.user!.id !== id) {
            res.status(403).json({ error: 'Cannot update another agent\'s status' });
            return;
        }

        const agent = await prisma.profile.update({
            where: { id },
            data: { status },
            select: { id: true, email: true, status: true },
        });

        res.json(agent);
    });

    // POST /api/agents/:id/ready — explicit transition out of wrap-up
    router.post('/:id/ready', authenticate, async (req: Request, res: Response): Promise<void> => {
        const id = paramValue(req.params.id);
        if (req.user!.role === 'agent' && req.user!.id !== id) {
            res.status(403).json({ error: 'Cannot mark another agent ready' });
            return;
        }
        deps.cancelAutoResume(id);
        const result = await deps.exitWrapUp(id);
        res.json({ id, transitioned: result.transitioned });
    });

    // GET /api/agents/:id/stats — per-agent performance
    router.get('/:id/stats', authenticate, requireMinRole('supervisor'), async (req: Request, res: Response): Promise<void> => {
        const id = paramValue(req.params.id);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [totalCalls, answeredCalls, avgDuration, dispositions] = await Promise.all([
            prisma.call.count({ where: { agentId: id, createdAt: { gte: today } } }),
            prisma.call.count({ where: { agentId: id, status: 'completed', createdAt: { gte: today } } }),
            prisma.call.aggregate({ where: { agentId: id, status: 'completed' }, _avg: { duration: true } }),
            prisma.call.groupBy({
                by: ['dispositionId'],
                where: { agentId: id, createdAt: { gte: today }, dispositionId: { not: null } },
                _count: true,
            }),
        ]);

        res.json({
            agentId: id,
            today: {
                totalCalls,
                answeredCalls,
                answerRate: totalCalls > 0 ? ((answeredCalls / totalCalls) * 100).toFixed(1) : '0.0',
                avgDuration: Math.round(avgDuration._avg?.duration || 0),
            },
            dispositions,
        });
    });

    // GET /api/agents/:id/room-url — Phase 3c: mint a short-lived signed URL the
    // frontend passes to client.dial(...) to enter the agent's pre-warm room.
    // Agent can only mint for themselves; supervisor/admin can mint for anyone.
    router.get('/:id/room-url', authenticate, (req: Request, res: Response): void => {
        const id = paramValue(req.params.id);
        if (req.user!.role === 'agent' && req.user!.id !== id) {
            res.status(403).json({ error: 'Cannot mint room URL for another agent' });
            return;
        }
        const secret = process.env.SWML_URL_SIGNING_SECRET || config.signalwire.apiToken;
        if (!secret) {
            res.status(500).json({ error: 'signing_secret_unset' });
            return;
        }
        const backend = config.publicUrls.backend || process.env.BACKEND_PUBLIC_URL || '';
        const { sig, exp } = signAgentRoomUrl(id, 60, secret); // 60-second TTL
        const url = `${backend}/swml/agent-room/${id}?sig=${sig}&exp=${exp}`;
        res.json({ url, exp });
    });

    // GET /api/agents/token — get SignalWire browser token for current agent
    router.get('/token/signalwire', authenticate, async (req: Request, res: Response): Promise<void> => {
        const user = await prisma.profile.findUnique({
            where: { id: req.user!.id },
            select: { id: true, email: true, extension: true },
        });

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        // Use email as endpointReference so SignalWire can store it as a valid email,
        // PUT password idempotently, and derive a path-safe Fabric address /private/<local-part>.
        // UUID-as-reference triggers the auto-create-without-password path that breaks
        // WebRTC endpoint registration (-32603).
        const result = await signalwireService.generateBrowserToken(user.id, user.email, user.email, user.email);
        if (!result.token) {
            if (result.error === 'subscriber_provisioning_disabled') {
                res.status(403).json({ error: 'SignalWire subscriber provisioning is disabled for new endpoints. Existing approved subscribers can still connect.' });
                return;
            }
            if (result.error === 'insufficient_balance') {
                res.status(402).json({ error: 'SignalWire account has insufficient balance for softphone token generation' });
                return;
            }
            res.status(500).json({ error: 'Failed to generate browser token', reason: result.error || 'unknown' });
            return;
        }
        res.json({ token: result.token, spaceUrl: process.env.SIGNALWIRE_SPACE_URL || '' });
    });

    return router;
}

export default buildAgentsRouter();
