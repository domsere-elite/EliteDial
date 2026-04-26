import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { validate, loginSchema, refreshSchema, changePasswordSchema, registerSchema, blacklistToken } from '../lib/validation';

const router = Router();

// POST /api/auth/login
router.post('/login', validate(loginSchema), async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password } = req.body;

        const user = await prisma.profile.findUnique({ where: { username } });
        if (!user) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const token = generateToken({ userId: user.id, username: user.username, role: user.role });
        const refreshToken = generateRefreshToken({ userId: user.id, username: user.username, role: user.role });

        // Set user as available on login
        await prisma.profile.update({ where: { id: user.id }, data: { status: 'available' } });

        res.json({
            token,
            refreshToken,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                status: 'available',
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/refresh
router.post('/refresh', validate(refreshSchema), async (req: Request, res: Response): Promise<void> => {
    try {
        const { refreshToken } = req.body;

        let payload;
        try {
            payload = verifyRefreshToken(refreshToken);
        } catch {
            res.status(401).json({ error: 'Invalid or expired refresh token' });
            return;
        }

        const user = await prisma.profile.findUnique({ where: { id: payload.userId } });
        if (!user) {
            res.status(401).json({ error: 'User no longer exists' });
            return;
        }

        const newToken = generateToken({ userId: user.id, username: user.username, role: user.role });
        const newRefreshToken = generateRefreshToken({ userId: user.id, username: user.username, role: user.role });

        res.json({ token: newToken, refreshToken: newRefreshToken });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, validate(changePasswordSchema), async (req: Request, res: Response): Promise<void> => {
    try {
        const { currentPassword, newPassword } = req.body;

        const user = await prisma.profile.findUnique({ where: { id: req.user!.id } });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) {
            res.status(401).json({ error: 'Current password is incorrect' });
            return;
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await prisma.profile.update({
            where: { id: user.id },
            data: { passwordHash },
        });

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/register (admin only)
router.post('/register', authenticate, requireRole('admin'), validate(registerSchema), async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, email, password, firstName, lastName, role, extension } = req.body;

        const existing = await prisma.profile.findFirst({
            where: { OR: [{ username }, { email }] },
        });
        if (existing) {
            res.status(409).json({ error: 'Username or email already exists' });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const user = await prisma.profile.create({
            data: { username, email, passwordHash, firstName, lastName, role: role || 'agent', extension },
        });

        res.status(201).json({
            id: user.id,
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/logout — blacklist current token
router.post('/logout', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            blacklistToken(token);
        }
        await prisma.profile.update({ where: { id: req.user!.id }, data: { status: 'offline' } });
        res.json({ message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await prisma.profile.findUnique({ where: { id: req.user!.id } });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            status: user.status,
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
