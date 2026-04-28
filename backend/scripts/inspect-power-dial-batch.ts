// Inspect a power-dial batch's lifecycle: batch row, leg rows, and any
// CallEvent / audit rows written by the SWML callback routes.

import { prisma } from '../src/lib/prisma';

const batchId = process.env.BATCH_ID;
if (!batchId) {
    console.error('Usage: BATCH_ID=<uuid> npx tsx scripts/inspect-power-dial-batch.ts');
    process.exit(1);
}

async function main() {
    const batch = await prisma.powerDialBatch.findUnique({
        where: { id: batchId },
        include: { legs: true },
    });
    if (!batch) {
        console.error(`No batch found with id ${batchId}`);
        process.exit(1);
        return;
    }

    console.log('=== PowerDialBatch ===');
    console.log({
        id: batch.id,
        campaignId: batch.campaignId,
        agentId: batch.agentId,
        targetRef: batch.targetRef,
        legCount: batch.legCount,
        status: batch.status,
        claimedAt: batch.claimedAt,
        createdAt: batch.createdAt,
        expiresAt: batch.expiresAt,
    });

    console.log('\n=== Legs ===');
    for (const leg of batch.legs) {
        console.log({
            id: leg.id,
            legIndex: leg.legIndex,
            providerCallId: leg.providerCallId,
            status: leg.status,
            detectResult: leg.detectResult,
            claimedAgent: leg.claimedAgent,
            overflowTarget: leg.overflowTarget,
            createdAt: leg.createdAt,
            completedAt: leg.completedAt,
        });
    }

    console.log('\n=== CallEvent rows for this batch (audit trail from SWML callbacks) ===');
    const events = await prisma.callEvent.findMany({
        where: {
            OR: [
                { type: { startsWith: 'power_dial.' } },
                {
                    payload: {
                        path: ['batchId'],
                        equals: batch.id,
                    },
                },
            ],
            createdAt: { gte: new Date(batch.createdAt.getTime() - 1000) },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
    });
    for (const e of events) {
        console.log({
            createdAt: e.createdAt,
            type: e.type,
            source: e.source,
            payload: e.payload,
        });
    }
    if (events.length === 0) {
        console.log('  (none)');
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('inspect errored:', err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(2);
});
