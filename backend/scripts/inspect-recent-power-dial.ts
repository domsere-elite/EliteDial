import { prisma } from '../src/lib/prisma';

async function main() {
    const batches = await prisma.powerDialBatch.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        include: {
            legs: { select: { id: true, status: true, providerCallId: true, contactId: true, claimedAgent: true } },
        },
    });
    console.log(`POWER DIAL BATCHES IN LAST HOUR: ${batches.length}`);
    console.log(JSON.stringify(batches, null, 2));

    const lastBatch = batches[0];
    if (lastBatch) {
        const callByProvider = lastBatch.legs[0]?.providerCallId
            ? await prisma.call.findFirst({ where: { providerCallId: lastBatch.legs[0].providerCallId } })
            : null;
        console.log('\nCALL row by leg.providerCallId:');
        console.log(JSON.stringify(callByProvider, null, 2));
    }
    // Also list ANY Call rows created in last 30 minutes
    const recentCalls = await prisma.call.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, providerCallId: true, status: true, agentId: true, fromNumber: true, toNumber: true, createdAt: true, completedAt: true },
    });
    console.log('\nALL CALL ROWS (last 30 min):');
    console.log(JSON.stringify(recentCalls, null, 2));
    await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => undefined); process.exit(1); });
