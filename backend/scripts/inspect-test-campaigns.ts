import { prisma } from '../src/lib/prisma';

async function main() {
    const c = await prisma.campaign.findMany({
        where: { name: { contains: 'test', mode: 'insensitive' } },
        select: { id: true, name: true, status: true, dialMode: true, dialRatio: true, skipAmd: true, wrapUpSeconds: true, createdById: true },
    });
    console.log(JSON.stringify(c, null, 2));
    await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => undefined); process.exit(1); });
