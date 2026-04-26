import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'node:http';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { prisma } from './prisma';
import { config } from '../config';
import { logger } from '../utils/logger';

let io: SocketIOServer | null = null;

interface SupabaseJwtClaims {
    sub: string;
    email: string;
    aud: string;
    exp: number;
}

interface SocketUser {
    userId: string;
    email: string;
    role: string;
    firstName: string;
    lastName: string;
}

let _jwks: JWTVerifyGetKey | null = null;
function jwks(): JWTVerifyGetKey {
    if (_jwks) return _jwks;
    if (!config.supabase.url) {
        throw new Error('SUPABASE_URL must be set to verify Supabase JWTs');
    }
    _jwks = createRemoteJWKSet(
        new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`),
    );
    return _jwks;
}

/**
 * Initialise Socket.IO on the given HTTP server and return the io instance.
 */
export function setupSocketIO(server: http.Server): SocketIOServer {
    const allowedOrigins = process.env.FRONTEND_URL
        ? [process.env.FRONTEND_URL]
        : ['http://localhost:3000'];

    io = new SocketIOServer(server, {
        cors: {
            origin: allowedOrigins,
            credentials: true,
        },
        transports: ['websocket', 'polling'],
    });

    // ─── Authentication middleware ───────────────────
    io.use(async (socket: Socket, next) => {
        try {
            const headerToken = socket.handshake.headers?.authorization?.toString().replace(/^Bearer /, '');
            const token = (socket.handshake.auth?.token as string | undefined) || headerToken;
            if (!token) {
                return next(new Error('Authentication required'));
            }

            let claims: SupabaseJwtClaims;
            try {
                const { payload } = await jwtVerify(token, jwks(), { audience: 'authenticated' });
                claims = payload as unknown as SupabaseJwtClaims;
            } catch {
                return next(new Error('Invalid or expired token'));
            }

            const profile = await prisma.profile.findUnique({
                where: { id: claims.sub },
                select: { id: true, email: true, role: true, firstName: true, lastName: true },
            });
            if (!profile) {
                return next(new Error('Profile not found'));
            }

            const user: SocketUser = {
                userId: profile.id,
                email: profile.email,
                role: profile.role,
                firstName: profile.firstName,
                lastName: profile.lastName,
            };
            (socket as unknown as { user: SocketUser }).user = user;
            next();
        } catch (err) {
            logger.warn('Socket authentication failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            next(new Error('Authentication failed'));
        }
    });

    // ─── Connection handler ─────────────────────────
    io.on('connection', (socket: Socket) => {
        const user: SocketUser = (socket as unknown as { user: SocketUser }).user;

        socket.join(`user:${user.userId}`);
        socket.join(`role:${user.role}`);

        logger.info('Socket connected', {
            socketId: socket.id,
            userId: user.userId,
            email: user.email,
            role: user.role,
        });

        socket.on('disconnect', (reason) => {
            logger.info('Socket disconnected', {
                socketId: socket.id,
                userId: user.userId,
                reason,
            });
        });
    });

    logger.info('Socket.IO initialised');
    return io;
}

/**
 * Get the singleton Socket.IO server instance.
 * Throws if called before setupSocketIO.
 */
export function getIO(): SocketIOServer {
    if (!io) {
        throw new Error('Socket.IO has not been initialised — call setupSocketIO first');
    }
    return io;
}

/**
 * Emit an event to every socket in the given role room.
 */
export function emitToRole(role: string, event: string, data: unknown): void {
    if (!io) return;
    io.to(`role:${role}`).emit(event, data);
}

/**
 * Emit an event to a specific user (all their connected sockets).
 */
export function emitToUser(userId: string, event: string, data: unknown): void {
    if (!io) return;
    io.to(`user:${userId}`).emit(event, data);
}

export { io };
