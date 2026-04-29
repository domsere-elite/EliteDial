// Snapshot of every input the power-dial worker checks per tick.

import { prisma } from '../src/lib/prisma';

async function main() {
    console.log('=== Active progressive campaigns with dialRatio > 1.0 ===');
    const camps = await prisma.campaign.findMany({
        where: { dialMode: 'progressive', status: 'active', dialRatio: { gt: 1.0 } },
        select: { id: true, name: true, status: true, dialRatio: true, maxConcurrentCalls: true, voicemailBehavior: true },
    });
    if (camps.length === 0) console.log('  (none)');
    for (const c of camps) console.log(' ', c);

    console.log('\n=== Available agents ===');
    const agents = await prisma.profile.findMany({
        where: { status: 'available', role: { in: ['agent', 'supervisor', 'admin'] } },
        select: { id: true, email: true, status: true, role: true, updatedAt: true },
    });
    if (agents.length === 0) console.log('  (none)');
    for (const a of agents) console.log(' ', a);

    console.log('\n=== Recent campaign contact queue (top 10 across campaigns) ===');
    const contacts = await prisma.campaignContact.findMany({
        where: { status: 'queued' },
        select: { id: true, campaignId: true, primaryPhone: true, status: true, reservedByUserId: true },
        take: 10,
    });
    if (contacts.length === 0) console.log('  (none)');
    for (const c of contacts) console.log(' ', c);

    console.log('\n=== All progressive campaigns (any status) ===');
    const all = await prisma.campaign.findMany({
        where: { dialMode: 'progressive' },
        select: { id: true, name: true, status: true, dialRatio: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
    });
    for (const c of all) console.log(' ', c);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
