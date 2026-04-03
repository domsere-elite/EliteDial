import { Request, Response, NextFunction } from 'express';

type Role = 'agent' | 'supervisor' | 'admin';

const roleHierarchy: Record<Role, number> = {
    agent: 1,
    supervisor: 2,
    admin: 3,
};

export function requireRole(...allowedRoles: Role[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        const userRole = req.user.role as Role;
        if (!allowedRoles.includes(userRole)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        next();
    };
}

export function requireMinRole(minRole: Role) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        const userLevel = roleHierarchy[req.user.role as Role] || 0;
        const requiredLevel = roleHierarchy[minRole];

        if (userLevel < requiredLevel) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        next();
    };
}
