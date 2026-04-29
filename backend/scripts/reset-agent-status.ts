import { prisma } from '../src/lib/prisma';

const email = process.env.AGENT_EMAIL || 'dominic@exec-strategy.com';
const target = (process.env.STATUS as 'available' | 'offline') || 'offline';

async function main() {
    const r = await prisma.profile.updateMany({
        where: { email },
        data: { status: target, updatedAt: new Date() },
    });
    console.log(`Reset ${r.count} profile row(s) for ${email} → ${target}`);
    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
