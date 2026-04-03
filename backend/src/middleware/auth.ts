import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { prisma } from '../lib/prisma';

declare global {
    namespace Express {
        interface Request {
            user?: TokenPayload & { id: string };
        }
    }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'No token provided' });
        return;
    }

    try {
        const token = authHeader.split(' ')[1];
        const payload = verifyToken(token);
        req.user = { ...payload, id: payload.userId };
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

export async function authenticateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
        res.status(401).json({ error: 'API key required' });
        return;
    }

    try {
        const key = await prisma.aPIKey.findUnique({ where: { key: apiKey } });
        if (!key || !key.isActive) {
            res.status(401).json({ error: 'Invalid or inactive API key' });
            return;
        }
        await prisma.aPIKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } });
        next();
    } catch (err) {
        res.status(500).json({ error: 'API key validation failed' });
    }
}
