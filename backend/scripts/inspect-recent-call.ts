import { prisma } from '../src/lib/prisma';

async function main() {
    const calls = await prisma.call.findMany({
        where: { agentId: '692a690e-770d-43bb-a151-8ec163141281' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, status: true, duration: true, fromNumber: true, toNumber: true, createdAt: true, completedAt: true },
    });
    console.log('RECENT CALLS:');
    console.log(JSON.stringify(calls, null, 2));
    const profile = await prisma.profile.findUnique({
        where: { id: '692a690e-770d-43bb-a151-8ec163141281' },
        select: { status: true, wrapUpUntil: true, updatedAt: true },
    });
    console.log('\nAGENT PROFILE:');
    console.log(JSON.stringify(profile, null, 2));
    await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => undefined); process.exit(1); });
