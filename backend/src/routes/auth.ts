import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { validate, registerSchema } from '../lib/validation';
import { supabaseAdmin } from '../lib/supabase-admin';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const router = Router();

// POST /api/auth/register — admin only. Creates a Supabase user; the on_auth_user_created
// trigger creates the matching Profile row. We then update the optional `extension` since
// the trigger doesn't know about it.
router.post(
    '/register',
    authenticate,
    requireRole('admin'),
    validate(registerSchema),
    async (req: Request, res: Response): Promise<void> => {
        const { email, password, firstName, lastName, role, extension } = req.body;
        const { data, error } = await supabaseAdmin().auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { firstName, lastName, role },
        });
        if (error || !data?.user) {
            logger.warn('register failed', { error: error?.message });
            res.status(400).json({ error: error?.message || 'register failed' });
            return;
        }
        if (extension) {
            await prisma.profile.update({
                where: { id: data.user.id },
                data: { extension },
            });
        }
        const profile = await prisma.profile.findUnique({ where: { id: data.user.id } });
        res.status(201).json(profile);
    },
);

// GET /api/auth/me
router.get('/me', authenticate, (req: Request, res: Response): void => {
    res.json(req.user);
});

export default router;
