import { PrismaClient } from '@prisma/client';

// Singleton pattern — prevents multiple PrismaClient instances during hot-reload
// and ensures a single connection pool is shared across all route files.

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
