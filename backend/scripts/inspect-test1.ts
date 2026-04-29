import { prisma } from '../src/lib/prisma';

async function main() {
    const campaignId = '29f6b0df-bbd9-4f99-a451-a9718149fbc3';

    console.log('=== test#1 contacts (any status) ===');
    const contacts = await prisma.campaignContact.findMany({
        where: { campaignId },
        select: { id: true, primaryPhone: true, status: true, attemptCount: true, reservedByUserId: true, reservationToken: true, reservationExpiresAt: true, lastAttemptAt: true, nextAttemptAt: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
    });
    for (const c of contacts) console.log(' ', c);

    console.log('\n=== Recent PowerDialBatch rows for test#1 ===');
    const batches = await prisma.powerDialBatch.findMany({
        where: { campaignId },
        include: { legs: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
    });
    if (batches.length === 0) console.log('  (none)');
    for (const b of batches) {
        console.log('Batch:', { id: b.id, status: b.status, legCount: b.legCount, agentId: b.agentId, targetRef: b.targetRef, createdAt: b.createdAt, expiresAt: b.expiresAt, claimedAt: b.claimedAt });
        for (const leg of b.legs) {
            console.log('  Leg:', { id: leg.id.slice(0,8), legIndex: leg.legIndex, status: leg.status, providerCallId: leg.providerCallId, detectResult: leg.detectResult, claimedAgent: leg.claimedAgent });
        }
    }

    console.log('\n=== Recent CallEvent rows for power-dial ===');
    const events = await prisma.callEvent.findMany({
        where: { type: { startsWith: 'power_dial.' } },
        orderBy: { createdAt: 'desc' },
        take: 10,
    });
    if (events.length === 0) console.log('  (none)');
    for (const e of events) console.log(' ', { createdAt: e.createdAt, type: e.type, payload: e.payload });

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
