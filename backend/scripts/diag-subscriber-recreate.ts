// Brute-force fix for a stuck Fabric subscriber WebRTC registration. PUT-based
// updates can't reset SignalWire's broker-side endpoint registration cache;
// only delete + recreate does. The subscriber `reference` is preserved
// (email), so the next SAT mint reuses the new subscriber.
//
// Run: railway run npx tsx scripts/diag-subscriber-recreate.ts
//
// Default targets dominic@exec-strategy.com. Override via env:
//   REFERENCE  — subscriber `reference` field (we use email here)
//   AGENT_EMAIL — email to PUT alongside (mirror reference)
//   FIRST_NAME / LAST_NAME — populated for WebRTC endpoint registration
import { config } from '../src/config';
import { createHash } from 'crypto';

const REFERENCE = process.env.REFERENCE || 'dominic@exec-strategy.com';
const AGENT_EMAIL = process.env.AGENT_EMAIL || REFERENCE;
const FIRST_NAME = process.env.FIRST_NAME || 'Dominic';
const LAST_NAME = process.env.LAST_NAME || 'Agent';

function derivedSubscriberPassword(reference: string): string {
    const secret = process.env.SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET || config.signalwire.apiToken || 'elitedial-fallback';
    return createHash('sha256').update(`${secret}:${reference}`).digest('hex').slice(0, 32);
}

async function main() {
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const baseUrl = `https://${config.signalwire.spaceUrl}`;

    // 1. Find the existing subscriber by reference (mint a SAT)
    console.log(`Looking up subscriber with reference="${REFERENCE}" ...`);
    const lookup = await fetch(`${baseUrl}/api/fabric/subscribers/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ reference: REFERENCE }),
    });
    const lookupBody = await lookup.json() as { subscriber_id?: string };
    const oldId = lookupBody.subscriber_id;
    if (!oldId) {
        console.log('No existing subscriber found, skipping delete.');
    } else {
        console.log(`Old subscriber id: ${oldId}`);
        console.log('Deleting old subscriber ...');
        const delResp = await fetch(`${baseUrl}/api/fabric/subscribers/${oldId}`, {
            method: 'DELETE',
            headers: { Authorization: auth },
        });
        console.log(`DELETE status: ${delResp.status}`);
        if (!delResp.ok) {
            const txt = await delResp.text();
            console.log(`DELETE body: ${txt}`);
            console.log('Aborting before create — manual cleanup may be needed.');
            process.exit(1);
        }
    }

    // 2. Create a fresh subscriber with full profile
    const password = derivedSubscriberPassword(REFERENCE);
    console.log('Creating fresh subscriber ...');
    const createResp = await fetch(`${baseUrl}/api/fabric/subscribers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
            reference: REFERENCE,
            email: AGENT_EMAIL,
            password,
            first_name: FIRST_NAME,
            last_name: LAST_NAME,
            display_name: `${FIRST_NAME} ${LAST_NAME}`,
            name: `${FIRST_NAME} ${LAST_NAME}`,
        }),
    });
    console.log(`POST status: ${createResp.status}`);
    const createBody = await createResp.text();
    console.log(`POST body: ${createBody}`);

    // 3. Mint a fresh SAT to verify the new subscriber resolves
    console.log('\nMinting fresh SAT to verify ...');
    const sat = await fetch(`${baseUrl}/api/fabric/subscribers/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ reference: REFERENCE }),
    });
    const satBody = await sat.json() as { subscriber_id?: string; token?: string };
    console.log(`New subscriber id: ${satBody.subscriber_id}`);
    console.log(`Token minted? ${!!satBody.token}`);
    if (oldId && satBody.subscriber_id === oldId) {
        console.log('WARNING: subscriber id unchanged — delete may not have taken effect.');
    } else {
        console.log('Subscriber id changed — fresh broker state.');
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
