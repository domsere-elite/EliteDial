// Seed ONLY the cell as a queued contact on test#1, and remove the 833.
// For smoke testing where we want the cell to be the winning leg.

import { prisma } from '../src/lib/prisma';

async function main() {
    const campaign = await prisma.campaign.findFirst({
        where: { dialMode: 'progressive', dialRatio: { gt: 1.0 } },
        orderBy: { createdAt: 'desc' },
    });
    if (!campaign) throw new Error('no campaign');

    // Move 833 out of the queue (can't delete due to FK from PowerDialLeg).
    // Setting status='completed' takes it out of the worker's reservation pool.
    const moved833 = await prisma.campaignContact.updateMany({
        where: { campaignId: campaign.id, primaryPhone: '+18333814416' },
        data: { status: 'completed', reservedByUserId: null, reservationToken: null, reservationExpiresAt: null },
    });
    console.log(`Moved ${moved833.count} 833 contact rows to status=completed`);

    // Re-queue cell
    const cell = await prisma.campaignContact.upsert({
        where: { campaignId_primaryPhone: { campaignId: campaign.id, primaryPhone: '+18327979834' } },
        update: {
            status: 'queued',
            attemptCount: 0,
            reservedByUserId: null,
            reservationToken: null,
            reservationExpiresAt: null,
            lastAttemptAt: null,
            nextAttemptAt: null,
        },
        create: { campaignId: campaign.id, primaryPhone: '+18327979834', firstName: 'Smoke', lastName: 'Cell', status: 'queued' },
    });
    console.log(`Cell queued: ${cell.id} status=${cell.status}`);

    // Note: dialRatio=2 with only 1 contact in queue means the worker creates
    // a 1-leg batch (legCount = 1). That's fine — it'll just dial the cell.
    // The contact will be resolved as the only leg in the batch.

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
