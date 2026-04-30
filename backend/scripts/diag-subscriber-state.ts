// Probe a Fabric subscriber's current state. Helps debug -32603 WebRTC
// endpoint registration failures by surfacing whether the subscriber has
// a password set, what its email looks like, and whether the PUT actually
// modifies state.
import { config } from '../src/config';

const SUBSCRIBER_ID = process.env.SUBSCRIBER_ID || '4494aea4-75fb-455c-8deb-ecfc080a3070';
const REFERENCE = process.env.REFERENCE || 'dominic@exec-strategy.com';

async function main() {
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const baseUrl = `https://${config.signalwire.spaceUrl}`;

    console.log('GET /api/fabric/subscribers/<id> ...');
    const getResp = await fetch(`${baseUrl}/api/fabric/subscribers/${SUBSCRIBER_ID}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
    });
    console.log('GET status:', getResp.status);
    const getBody = await getResp.text();
    console.log('GET body:', getBody);

    console.log('\nGET /api/fabric/subscribers/tokens (mint a fresh SAT) ...');
    const satResp = await fetch(`${baseUrl}/api/fabric/subscribers/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ reference: REFERENCE }),
    });
    console.log('SAT status:', satResp.status);
    const satBody = await satResp.text();
    // Don't print the token itself
    try {
        const j = JSON.parse(satBody);
        console.log('SAT body keys:', Object.keys(j));
        console.log('SAT subscriber_id:', j.subscriber_id);
        console.log('SAT has token?:', !!j.token, 'len:', j.token?.length);
    } catch {
        console.log('SAT body (non-json):', satBody);
    }

    console.log('\nPUT /api/fabric/subscribers/<id> (set fresh password) ...');
    const newPwd = `EliteDial-${Date.now()}!`;
    const putResp = await fetch(`${baseUrl}/api/fabric/subscribers/${SUBSCRIBER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ email: REFERENCE, password: newPwd }),
    });
    console.log('PUT status:', putResp.status);
    const putBody = await putResp.text();
    console.log('PUT body:', putBody);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
