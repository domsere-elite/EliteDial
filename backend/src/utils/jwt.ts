import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
    userId: string;
    username: string;
    role: string;
}

interface RefreshTokenPayload extends TokenPayload {
    type: 'refresh';
}

export function generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, config.jwtSecret, {
        expiresIn: config.jwtExpiresIn,
    } as jwt.SignOptions);
}

export function generateRefreshToken(payload: TokenPayload): string {
    const refreshPayload: RefreshTokenPayload = { ...payload, type: 'refresh' };
    return jwt.sign(refreshPayload, config.jwtSecret, {
        expiresIn: '7d',
    } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
    const decoded = jwt.verify(token, config.jwtSecret) as RefreshTokenPayload;
    if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type — expected refresh token');
    }
    return { userId: decoded.userId, username: decoded.username, role: decoded.role };
}

export function generateApiKey(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'eld_';
    for (let i = 0; i < 40; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
