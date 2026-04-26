import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { config } from '../config';

interface SupabaseJwtClaims {
    sub: string;
    email: string;
    aud: string;
    exp: number;
}

export interface AuthDeps {
    profileLookup?: (id: string) => Promise<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
        extension: string | null;
    } | null>;
}

export function authenticate(deps: AuthDeps = {}): RequestHandler {
    const lookup = deps.profileLookup ?? (async (id: string) => {
        // The Profile model is introduced in Task 3 (rename of User → Profile).
        // Until then, this default branch is unreachable in tests (which inject `profileLookup`).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (prisma as any).profile.findUnique({
            where: { id },
            select: { id: true, email: true, firstName: true, lastName: true, role: true, extension: true },
        });
    });

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or malformed Authorization header' });
            return;
        }
        const token = header.slice(7);
        let claims: SupabaseJwtClaims;
        try {
            claims = jwt.verify(token, config.supabase.jwtSecret, {
                algorithms: ['HS256'],
                audience: 'authenticated',
            }) as SupabaseJwtClaims;
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }
        const profile = await lookup(claims.sub);
        if (!profile) {
            res.status(401).json({ error: 'Profile not found for authenticated user' });
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).user = {
            id: profile.id,
            email: profile.email,
            role: profile.role,
            firstName: profile.firstName,
            lastName: profile.lastName,
            extension: profile.extension,
        };
        next();
    };
}
