import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { logger } from './utils/logger';
import { prisma } from './lib/prisma';
import { setupSocketIO } from './lib/socket';

import authRoutes from './routes/auth';
import agentRoutes from './routes/agents';
import callRoutes from './routes/calls';
import voicemailRoutes from './routes/voicemails';
import reportRoutes from './routes/reports';
import adminRoutes from './routes/admin';
import systemRoutes from './routes/system';
import retellWebhookRoutes from './routes/retell-webhooks';
import swmlRoutes from './routes/swml';
import signalwireEventsRoutes from './routes/signalwire-events';
import integrationRoutes from './routes/integration';
import campaignRoutes from './routes/campaigns';
import aiAgentRoutes from './routes/ai-agents';
import settingsRoutes from './routes/settings';
import { reservationCleanup } from './services/reservation-cleanup';
import { crmRetryQueue } from './services/crm-retry-queue';
import { computeHealth } from './services/health';
import { correlationId } from './middleware/correlation';
import { validateEnvOrExit, validateActivationsOrWarn } from './lib/env-validation';
import { aiAutonomousWorker } from './services/ai-autonomous-worker';
import { concurrencyLimiter } from './services/concurrency-limiter';

validateEnvOrExit();

const app = express();

// ─── Security ────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CSP managed by Next.js frontend
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ─── Compression ─────────────────────────────────
app.use(compression());

const allowedOrigins = process.env.FRONTEND_URL
    ? [process.env.FRONTEND_URL]
    : ['http://localhost:3000'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(correlationId);
app.use('/audio', express.static(path.join(__dirname, '..', 'public')));

// ─── Rate limiting on auth endpoints ─────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // limit each IP to 15 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later' },
});

// ─── Health check ────────────────────────────────
app.get('/health', async (req, res) => {
    const result = await computeHealth({
        checkDb: async () => {
            await prisma.$queryRaw`SELECT 1`;
            return true;
        },
        providers: {
            signalwire: config.isSignalWireConfigured,
            retell: config.isRetellConfigured,
            crm: config.isCrmConfigured,
        },
    });
    res.status(result.statusCode).json(result.body);
});

// ─── Liveness probe (process alive, no deps) ─────
app.get('/live', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// ─── Dialer health: per-campaign slot occupancy ──
app.get('/health/dialer', async (_req, res) => {
    const campaigns = await prisma.campaign.findMany({
        where: { status: 'active', dialMode: 'ai_autonomous' },
        select: { id: true, name: true, maxConcurrentCalls: true },
    });
    const slots = campaigns.map(c => ({
        campaignId: c.id,
        name: c.name,
        cap: c.maxConcurrentCalls,
        active: concurrencyLimiter.active(c.id),
    }));
    res.json({ campaigns: slots });
});

// ─── Routes ──────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/voicemails', voicemailRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/ai-agents', aiAgentRoutes);
app.use('/api/settings', settingsRoutes);

app.use('/retell', retellWebhookRoutes);
app.use('/swml', swmlRoutes);
app.use('/signalwire/events', signalwireEventsRoutes);

app.use('/api/integration', integrationRoutes);

// ─── Global error handler ────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ─────────────────────────────────────
const server = http.createServer(app);
setupSocketIO(server);

server.listen(config.port, () => {
    logger.info(`EliteDial backend running on port ${config.port}`);
    logger.info(`SignalWire configured: ${config.isSignalWireConfigured}`);
    logger.info(`Retell configured: ${config.isRetellConfigured}`);
    reservationCleanup.start();
    crmRetryQueue.start();
    void (async () => {
        try {
            await validateActivationsOrWarn();
            await aiAutonomousWorker.start();
        } catch (err) {
            logger.error('ai-autonomous-worker startup failed', { err });
        }
    })();
});

// ─── Graceful shutdown ───────────────────────────
const gracefulShutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    reservationCleanup.stop();
    crmRetryQueue.stop();
    aiAutonomousWorker.stop();

    server.close(async () => {
        await prisma.$disconnect();
        logger.info('Server closed, database disconnected');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        logger.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, 10_000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
});

export default app;
