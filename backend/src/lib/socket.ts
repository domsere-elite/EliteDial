import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'node:http';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { isTokenBlacklisted } from './validation';
import { logger } from '../utils/logger';

let io: SocketIOServer | null = null;

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
    io.use((socket: Socket, next) => {
        try {
            const token = socket.handshake.auth?.token as string | undefined;
            if (!token) {
                return next(new Error('Authentication required'));
            }

            if (isTokenBlacklisted(token)) {
                return next(new Error('Token has been revoked'));
            }

            const payload: TokenPayload = verifyToken(token);
            // Attach user data to the socket for later use
            (socket as any).user = payload;
            next();
        } catch (err) {
            logger.warn('Socket authentication failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            next(new Error('Invalid or expired token'));
        }
    });

    // ─── Connection handler ─────────────────────────
    io.on('connection', (socket: Socket) => {
        const user: TokenPayload = (socket as any).user;

        // Join user-specific room
        socket.join(`user:${user.userId}`);

        // Join role-based room
        socket.join(`role:${user.role}`);

        logger.info('Socket connected', {
            socketId: socket.id,
            userId: user.userId,
            username: user.username,
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
