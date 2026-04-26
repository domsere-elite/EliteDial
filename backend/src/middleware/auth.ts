import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { prisma } from '../lib/prisma';
import { config } from '../config';

export interface AuthenticatedUser {
    id: string;
    email: string;
    role: string;
    firstName: string;
    lastName: string;
    extension: string | null;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: AuthenticatedUser;
        }
    }
}

interface SupabaseJwtClaims {
    sub: string;
    email: string;
    aud: string;
    exp: number;
}

export interface AuthDeps {
    profileLookup?: (id: string) => Promise<AuthenticatedUser | null>;
    // Caller can inject a custom JWKS resolver (used in tests). Defaults to
    // a remote JWKS bound to the Supabase project URL.
    jwks?: JWTVerifyGetKey;
}

let _defaultJwks: JWTVerifyGetKey | null = null;
function defaultJwks(): JWTVerifyGetKey {
    if (_defaultJwks) return _defaultJwks;
    if (!config.supabase.url) {
        throw new Error('SUPABASE_URL must be set to verify Supabase JWTs');
    }
    _defaultJwks = createRemoteJWKSet(
        new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`),
    );
    return _defaultJwks;
}

function authenticateImpl(deps: AuthDeps = {}): RequestHandler {
    const lookup = deps.profileLookup ?? (async (id: string) => {
        return prisma.profile.findUnique({
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
            const jwks = deps.jwks ?? defaultJwks();
            const { payload } = await jwtVerify(token, jwks, { audience: 'authenticated' });
            claims = payload as unknown as SupabaseJwtClaims;
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }
        const profile = await lookup(claims.sub);
        if (!profile) {
            res.status(401).json({ error: 'Profile not found for authenticated user' });
            return;
        }
        req.user = {
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

// Drop-in middleware that uses the project's remote JWKS + real Prisma.
export const authenticate: RequestHandler = authenticateImpl();

// Used by tests to inject a stubbed profile lookup and/or a synthetic JWKS.
export const buildAuthenticate = authenticateImpl;

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
    } catch {
        res.status(500).json({ error: 'API key validation failed' });
    }
}
