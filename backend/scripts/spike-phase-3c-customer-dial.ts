// Origination script for Phase 3c spike. Dials the test cell with the
// spike-customer-room SWML.
//
// Run AFTER the agent's browser has joined /swml/spike-agent-room (so the
// moderator is present) to test H1 (instant late-joiner audio).
//
// Run BEFORE the agent has joined to test H2 (wait_for_moderator timeout
// fallback — should hear the TTS marker after ~3s).
//
// Usage:
//   railway run npx tsx scripts/spike-phase-3c-customer-dial.ts
//   TO=+18327979834 railway run npx tsx scripts/spike-phase-3c-customer-dial.ts

import { config } from '../src/config';

const TO = process.env.TO || '+18327979834';
const FROM = process.env.FROM || '+13467760336';

async function main(): Promise<void> {
    if (!config.signalwire.spaceUrl || !config.signalwire.projectId || !config.signalwire.apiToken) {
        throw new Error('SignalWire env not configured (SIGNALWIRE_SPACE_URL/PROJECT_ID/API_TOKEN)');
    }
    if (!config.publicUrls.backend) {
        throw new Error('BACKEND_PUBLIC_URL not set — required for SWML callback URL');
    }
    const baseUrl = `https://${config.signalwire.spaceUrl}`;
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const callbackUrl = config.publicUrls.backend;

    console.log(`[spike] dialing ${TO} from ${FROM} -> ${callbackUrl}/swml/spike-customer-room`);
    const t0 = Date.now();
    const resp = await fetch(`${baseUrl}/api/calling/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
            command: 'dial',
            params: {
                from: FROM,
                to: TO,
                caller_id: FROM,
                url: `${callbackUrl}/swml/spike-customer-room`,
                status_url: `${callbackUrl}/signalwire/events/call-status`,
                status_events: ['answered', 'ended'],
            },
        }),
    });
    console.log(`[spike] http status: ${resp.status} (${Date.now() - t0}ms)`);
    console.log('[spike] body:', await resp.text());
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
