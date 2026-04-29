// Seed two CampaignContact rows for the power-dial smoke. Picks the most
// recently created progressive campaign with dialRatio > 1.0 (the user's
// just-created smoke campaign).

import { prisma } from '../src/lib/prisma';

async function main() {
    const campaign = await prisma.campaign.findFirst({
        where: { dialMode: 'progressive', dialRatio: { gt: 1.0 } },
        orderBy: { createdAt: 'desc' },
    });
    if (!campaign) {
        throw new Error('No progressive campaign with dialRatio>1.0 found.');
    }
    console.log(`Seeding contacts on campaign: ${campaign.id}  (${campaign.name})  dialRatio=${campaign.dialRatio}  status=${campaign.status}`);

    const contacts = [
        { primaryPhone: '+18327979834', firstName: 'Smoke', lastName: 'Cell' },
        { primaryPhone: '+18333814416', firstName: 'Smoke', lastName: 'Toll-free' },
    ];

    for (const c of contacts) {
        const row = await prisma.campaignContact.upsert({
            where: { campaignId_primaryPhone: { campaignId: campaign.id, primaryPhone: c.primaryPhone } },
            update: { status: 'queued', attemptCount: 0, nextAttemptAt: null, reservedByUserId: null, reservationToken: null, reservationExpiresAt: null, updatedAt: new Date() },
            create: { campaignId: campaign.id, primaryPhone: c.primaryPhone, firstName: c.firstName, lastName: c.lastName, status: 'queued' },
        });
        console.log(`  ${row.primaryPhone}  id=${row.id}  status=${row.status}`);
    }

    if (campaign.status !== 'active') {
        console.log(`\nNote: campaign is currently '${campaign.status}'. The worker only dispatches on 'active'.`);
        console.log(`      Activate it from the UI or run: prisma.campaign.update({ id, data: { status: 'active' } })`);
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('seed errored:', err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
