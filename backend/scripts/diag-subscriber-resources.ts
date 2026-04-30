// Inspect what Fabric resources point at the subscriber so we know what
// will/won't break if we delete + recreate it.
import { config } from '../src/config';

const SUBSCRIBER_ID = process.env.SUBSCRIBER_ID || '4494aea4-75fb-455c-8deb-ecfc080a3070';

async function main() {
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const baseUrl = `https://${config.signalwire.spaceUrl}`;

    // 1. Get the subscriber details
    console.log('GET /api/fabric/subscribers/<id> ...');
    const sub = await fetch(`${baseUrl}/api/fabric/subscribers/${SUBSCRIBER_ID}`, {
        headers: { Authorization: auth },
    });
    console.log('Subscriber status:', sub.status);
    console.log('Subscriber:', await sub.text());

    // 2. List Fabric addresses (no filter)
    console.log('\nGET /api/fabric/addresses ...');
    const addrs = await fetch(`${baseUrl}/api/fabric/addresses?page_size=100`, {
        headers: { Authorization: auth },
    });
    console.log('Addresses status:', addrs.status);
    const aBody = await addrs.text();
    try {
        const j = JSON.parse(aBody);
        if (Array.isArray(j.data)) {
            console.log(`Found ${j.data.length} addresses total`);
            for (const a of j.data) {
                if (a.resource_id === SUBSCRIBER_ID || (a.name && a.name.includes('dominic')) || (a.display_name && a.display_name.includes('dominic'))) {
                    console.log(`  MATCH: id=${a.id} name=${a.name} display=${a.display_name} resource_id=${a.resource_id} type=${a.type}`);
                }
            }
        }
    } catch {
        console.log('Body (non-json):', aBody.slice(0, 500));
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
