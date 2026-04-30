// Probe whether setting display_name + first/last name on the Fabric subscriber
// affects the -32603 WebRTC registration error. Some SignalWire docs imply
// these fields are needed for endpoint registration; the existing flow only
// PUTs email + password.
import { config } from '../src/config';
import { createHash } from 'crypto';

const SUBSCRIBER_ID = process.env.SUBSCRIBER_ID || '4494aea4-75fb-455c-8deb-ecfc080a3070';
const REFERENCE = process.env.REFERENCE || 'dominic@exec-strategy.com';
const FIRST_NAME = process.env.FIRST_NAME || 'Dominic';
const LAST_NAME = process.env.LAST_NAME || 'Agent';

function derivedSubscriberPassword(reference: string): string {
    const secret = process.env.SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET || config.signalwire.apiToken || 'elitedial-fallback';
    return createHash('sha256').update(`${secret}:${reference}`).digest('hex').slice(0, 32);
}

async function main() {
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const baseUrl = `https://${config.signalwire.spaceUrl}`;

    const password = derivedSubscriberPassword(REFERENCE);
    const body = {
        email: REFERENCE,
        password,
        first_name: FIRST_NAME,
        last_name: LAST_NAME,
        display_name: `${FIRST_NAME} ${LAST_NAME}`,
    };
    console.log('PUT body:', { ...body, password: '<redacted>' });

    const putResp = await fetch(`${baseUrl}/api/fabric/subscribers/${SUBSCRIBER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(body),
    });
    console.log('PUT status:', putResp.status);
    console.log('PUT body:', await putResp.text());
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
