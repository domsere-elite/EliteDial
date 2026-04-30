import { config } from '../src/config';

async function main() {
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const baseUrl = `https://${config.signalwire.spaceUrl}`;

    console.log('GET /api/fabric/addresses?type=subscriber ...');
    const resp = await fetch(`${baseUrl}/api/fabric/addresses?type=subscriber&page_size=50`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
    });
    console.log('Status:', resp.status);
    const body = await resp.text();
    try {
        const j = JSON.parse(body);
        if (Array.isArray(j.data)) {
            console.log(`Found ${j.data.length} addresses:`);
            for (const a of j.data) {
                console.log(`  - id=${a.id} name=${a.name} display_name=${a.display_name} resource_id=${a.resource_id} type=${a.type}`);
            }
        } else {
            console.log('Body:', body);
        }
    } catch {
        console.log('Body (non-json):', body);
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
