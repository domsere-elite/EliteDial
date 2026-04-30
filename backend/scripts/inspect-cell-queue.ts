import { prisma } from '../src/lib/prisma';

async function main() {
    const c = await prisma.campaignContact.findMany({
        where: { primaryPhone: { in: ['+18327979834', '+18333814416'] } },
        select: { id: true, primaryPhone: true, status: true, attemptCount: true, campaign: { select: { name: true } } },
    });
    console.log(JSON.stringify(c, null, 2));
    await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => undefined); process.exit(1); });
