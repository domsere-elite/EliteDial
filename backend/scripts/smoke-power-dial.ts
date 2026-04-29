// Live smoke test for the power-dial Phase 2 dispatch path.
//
// Mirrors what progressive-power-dial-worker.ts does in one tick, but takes
// two phone numbers via env so we can exercise the full flow against real
// PSTN endpoints without configuring a campaign + contacts in the dashboard.
//
// What it does:
//   1. Finds the first campaign in the DB (the FK target — the rows we create
//      below need a real campaignId).
//   2. Finds the agent profile for AGENT_EMAIL (default dominic@exec-strategy.com).
//      Uses email's local-part as targetRef → /private/<ref>.
//   3. Creates two CampaignContact rows with TO_NUMBER_1 / TO_NUMBER_2.
//   4. Creates one PowerDialBatch + two PowerDialLeg rows.
//   5. Dispatches both legs in parallel via signalwireService.originatePowerDialLeg
//      with the same powerDialDetectSwml the worker generates.
//   6. Prints the batch id, leg ids, provider call ids, and where to inspect.
//
// Expected live behaviour (with the agent's browser softphone open + status='available'):
//   - Both numbers ring.
//   - The leg you answer first wins the atomic claim → bridges to /private/<targetRef>
//     → softphone tab auto-accepts → audio bridge live.
//   - The other leg hits /swml/power-dial/claim, loses the race, falls through to
//     hangup (no retellSipAddress on this smoke campaign).
//
// Usage (PowerShell):
//   cd backend
//   $env:TO_NUMBER_1 = "+18327979834"
//   $env:TO_NUMBER_2 = "+18333814416"
//   railway run --service backend npx tsx scripts/smoke-power-dial.ts

import { prisma } from '../src/lib/prisma';
import { signalwireService } from '../src/services/signalwire';
import { powerDialDetectSwml } from '../src/services/swml/builder';
import { config } from '../src/config';

const to1 = process.env.TO_NUMBER_1;
const to2 = process.env.TO_NUMBER_2;
const agentEmail = process.env.AGENT_EMAIL || 'dominic@exec-strategy.com';
const callbackUrl = process.env.CALLBACK_URL || config.publicUrls.backend || 'https://backend-production-e2bf.up.railway.app';
const fromDid = process.env.FROM_DID || '+13467760336';

if (!to1 || !to2) {
    console.error('Missing TO_NUMBER_1 and/or TO_NUMBER_2 env vars.');
    process.exit(1);
}

async function main() {
    console.log('Power-dial live smoke');
    console.log('  agent:', agentEmail);
    console.log('  from :', fromDid);
    console.log('  to[0]:', to1);
    console.log('  to[1]:', to2);
    console.log('  cb   :', callbackUrl);
    console.log();

    let campaign = await prisma.campaign.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!campaign) {
        console.log('No campaigns in DB; creating a smoke campaign…');
        campaign = await prisma.campaign.create({
            data: {
                name: 'power-dial-smoke',
                description: 'Auto-created by scripts/smoke-power-dial.ts',
                status: 'draft',
                dialMode: 'progressive',
                dialRatio: 2.0,
                voicemailBehavior: 'hangup',
            },
        });
    }
    console.log(`Using campaign: ${campaign.id}  (${campaign.name})`);

    const profile = await prisma.profile.findUnique({ where: { email: agentEmail } });
    if (!profile) {
        throw new Error(`No Profile for email ${agentEmail}.`);
    }
    const targetRef = (profile.email || '').split('@')[0] || profile.id;
    console.log(`Agent profile: ${profile.id}  targetRef=${targetRef}`);

    // Create two contact rows for the test phones. Use upsert so re-running
    // the smoke against the same numbers works.
    const contact1 = await prisma.campaignContact.upsert({
        where: { campaignId_primaryPhone: { campaignId: campaign.id, primaryPhone: to1! } },
        update: { status: 'queued', updatedAt: new Date() },
        create: {
            campaignId: campaign.id,
            primaryPhone: to1!,
            firstName: 'Smoke',
            lastName: 'Test1',
            status: 'queued',
        },
    });
    const contact2 = await prisma.campaignContact.upsert({
        where: { campaignId_primaryPhone: { campaignId: campaign.id, primaryPhone: to2! } },
        update: { status: 'queued', updatedAt: new Date() },
        create: {
            campaignId: campaign.id,
            primaryPhone: to2!,
            firstName: 'Smoke',
            lastName: 'Test2',
            status: 'queued',
        },
    });

    // Create the batch + legs.
    const batch = await prisma.powerDialBatch.create({
        data: {
            campaignId: campaign.id,
            agentId: profile.id,
            targetRef,
            legCount: 2,
            expiresAt: new Date(Date.now() + 60_000),
        },
    });
    console.log(`Batch: ${batch.id}`);

    const leg1 = await prisma.powerDialLeg.create({
        data: { batchId: batch.id, contactId: contact1.id, legIndex: 0 },
    });
    const leg2 = await prisma.powerDialLeg.create({
        data: { batchId: batch.id, contactId: contact2.id, legIndex: 1 },
    });
    console.log(`Legs: ${leg1.id}, ${leg2.id}`);

    // Dispatch both legs in parallel.
    const dispatch = async (legId: string, to: string) => {
        const swml = powerDialDetectSwml({
            claimUrl: `${callbackUrl}/swml/power-dial/claim`,
            voicemailUrl: `${callbackUrl}/swml/power-dial/voicemail`,
            batchId: batch.id,
            legId,
            campaignId: campaign.id,
            callerId: fromDid,
            targetRef,
            retellSipAddress: campaign.retellSipAddress,
            voicemailBehavior: campaign.voicemailBehavior === 'leave_message' ? 'leave_message' : 'hangup',
            voicemailMessage: campaign.voicemailMessage,
        });
        const r = await signalwireService.originatePowerDialLeg({
            to,
            from: fromDid,
            swml,
            statusUrl: `${callbackUrl}/signalwire/events/call-status`,
        });
        return { legId, to, result: r };
    };

    console.log('\nOriginating both legs in parallel…');
    const results = await Promise.all([dispatch(leg1.id, to1!), dispatch(leg2.id, to2!)]);

    for (const r of results) {
        if (r.result) {
            await prisma.powerDialLeg.update({
                where: { id: r.legId },
                data: { providerCallId: r.result.providerCallId },
            });
            console.log(`  leg=${r.legId.slice(0, 8)}…  to=${r.to}  providerCallId=${r.result.providerCallId}`);
            console.log(`    inspect: https://${config.signalwire.spaceUrl}/logs/calls/${r.result.providerCallId}`);
        } else {
            console.log(`  leg=${r.legId.slice(0, 8)}…  to=${r.to}  ORIGINATE FAILED`);
        }
    }

    console.log('\nWatch Railway logs (backend service):');
    console.log('  power-dial.bridge.claimed   ← winning leg');
    console.log('  power-dial.bridge.overflow_hangup ← losing leg');
    console.log('  Or, if you don\'t answer either: power-dial.voicemail.hangup × 2');
    console.log();
    console.log('Cleanup later (optional):');
    console.log(`  DELETE FROM "PowerDialLeg" WHERE "batchId" = '${batch.id}';`);
    console.log(`  DELETE FROM "PowerDialBatch" WHERE id = '${batch.id}';`);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('Power-dial smoke errored:', err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(2);
});
