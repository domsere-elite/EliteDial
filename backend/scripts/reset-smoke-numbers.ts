// Reset smoke test phone numbers: delete recent Call rows so Reg F count
// drops back to zero, and re-queue any 'suppressed-reg-f' contact rows.
//
// SAFE: only touches the explicit smoke numbers passed in PHONES env var.

import { prisma } from '../src/lib/prisma';

const phones = (process.env.PHONES || '+18327979834,+18333814416').split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
    console.log('Resetting smoke numbers:', phones);

    for (const phone of phones) {
        const callCountBefore = await prisma.call.count({ where: { toNumber: phone } });
        const callDel = await prisma.call.deleteMany({ where: { toNumber: phone } });
        console.log(`  ${phone}: deleted ${callDel.count} Call rows (was ${callCountBefore})`);

        const requeued = await prisma.campaignContact.updateMany({
            where: { primaryPhone: phone, status: 'suppressed-reg-f' },
            data: {
                status: 'queued',
                attemptCount: 0,
                reservedByUserId: null,
                reservationToken: null,
                reservationExpiresAt: null,
                lastAttemptAt: null,
                nextAttemptAt: null,
            },
        });
        console.log(`  ${phone}: re-queued ${requeued.count} suppressed-reg-f contact rows`);

        // Also reset 'dialing' rows that might be stuck mid-attempt from prior smokes.
        const stuckRequeued = await prisma.campaignContact.updateMany({
            where: { primaryPhone: phone, status: { in: ['dialing', 'failed'] } },
            data: {
                status: 'queued',
                attemptCount: 0,
                reservedByUserId: null,
                reservationToken: null,
                reservationExpiresAt: null,
                lastAttemptAt: null,
                nextAttemptAt: null,
            },
        });
        console.log(`  ${phone}: re-queued ${stuckRequeued.count} stuck dialing/failed rows`);
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
