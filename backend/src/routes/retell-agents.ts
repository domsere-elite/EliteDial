import { Router, Request, Response, RequestHandler } from 'express';
import { authenticate as defaultAuthenticate } from '../middleware/auth';
import { listRetellAgents, RetellAgent } from '../services/retell-agents-service';
import { config } from '../config';
import { logger } from '../utils/logger';

interface Deps {
    listAgents?: () => Promise<RetellAgent[]>;
    authenticate?: RequestHandler;
}

export function buildRetellAgentsRouter(deps: Deps = {}): Router {
    const router = Router();
    const auth = deps.authenticate ?? defaultAuthenticate;
    const list = deps.listAgents ?? (() => listRetellAgents({
        fetchImpl: fetch,
        apiKey: config.retell.apiKey,
        baseUrl: config.retell.baseUrl,
    }));

    router.get('/agents', auth, async (_req: Request, res: Response): Promise<void> => {
        try {
            const agents = await list();
            res.json({ agents });
        } catch (err: any) {
            logger.warn('GET /api/retell/agents failed', { error: err?.message });
            res.status(503).json({ error: err?.message || 'Retell agents unavailable' });
        }
    });

    return router;
}

export default buildRetellAgentsRouter();
