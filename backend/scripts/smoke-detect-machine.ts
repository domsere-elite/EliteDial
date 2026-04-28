// Smoke test: verify SWML `detect_machine` verb is enabled on this SignalWire space.
//
// Why this exists: detect_machine is gated on some SignalWire spaces. Power-dial Phase 2
// depends on it for human/machine routing. We need to confirm the verb works before we
// build the worker around it.
//
// How it works:
//   1. POSTs /api/calling/calls with inline SWML that does: answer + detect_machine + say "%{detect_result}" + hangup.
//   2. SignalWire dials the target. When the call connects (human or VM greeting),
//      detect_machine runs and sets %{detect_result}.
//   3. The TTS reads the result back, so the listener (or the VM recording) captures it.
//
// Expected outcomes:
//   - Target answers in person → hears "Detect result: human" then hangup.
//   - Target's VM picks up    → VM records "Detect result: machine" then hangup.
//   - Verb not enabled        → call fails or detect_result is empty; check the
//                                SignalWire dashboard call detail page for the SWML error.
//
// Usage:
//   cd backend
//   SIGNALWIRE_PROJECT_ID=... \
//   SIGNALWIRE_API_TOKEN=... \
//   SIGNALWIRE_SPACE_URL=executive-strategy.signalwire.com \
//   FROM_DID=+13467760336 \
//   TO_NUMBER=+18327979834 \
//   npx tsx scripts/smoke-detect-machine.ts
//
// Or with values pulled from a Railway-linked shell:
//   railway run --service backend npx tsx scripts/smoke-detect-machine.ts

const projectId = process.env.SIGNALWIRE_PROJECT_ID;
const apiToken = process.env.SIGNALWIRE_API_TOKEN;
const spaceUrl = process.env.SIGNALWIRE_SPACE_URL || 'executive-strategy.signalwire.com';
const fromDid = process.env.FROM_DID || '+13467760336';
const toNumber = process.env.TO_NUMBER || '+18327979834';

if (!projectId || !apiToken) {
    console.error('Missing SIGNALWIRE_PROJECT_ID and/or SIGNALWIRE_API_TOKEN env vars.');
    process.exit(1);
}

// Mirror the SignalWire docs canonical pattern (developer.signalwire.com/swml/methods/detect_machine):
// - play.url: "say:..." form is what supports %{detect_result} variable interpolation.
// - cond branches give us a clear acoustic signal of which path fired.
// - detectors: "amd,fax" is the doc default; we keep amd-only here but timeout high enough
//   that the user actually hears the result before the call ends.
const swml = {
    version: '1.0.0',
    sections: {
        main: [
            { answer: {} },
            { play: { url: 'say:Running machine detection. Please wait.' } },
            {
                detect_machine: {
                    detectors: 'amd',
                    wait: true,
                    timeout: 10,
                },
            },
            {
                cond: [
                    {
                        when: "detect_result == 'human'",
                        then: [
                            { play: { url: 'say:Detect result: human. Goodbye.' } },
                            { hangup: {} },
                        ],
                    },
                    {
                        when: "detect_result == 'machine'",
                        then: [
                            { play: { url: 'say:Detect result: machine. Goodbye.' } },
                            { hangup: {} },
                        ],
                    },
                    {
                        else: [
                            { play: { url: 'say:Detect result was %{detect_result}. Goodbye.' } },
                            { hangup: {} },
                        ],
                    },
                ],
            },
        ],
    },
};

const auth = 'Basic ' + Buffer.from(`${projectId}:${apiToken}`).toString('base64');

async function main() {
    const url = `https://${spaceUrl}/api/calling/calls`;
    console.log(`POST ${url}`);
    console.log(`from=${fromDid} to=${toNumber}`);
    console.log('SWML:', JSON.stringify(swml, null, 2));

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
            command: 'dial',
            params: {
                from: fromDid,
                to: toNumber,
                caller_id: fromDid,
                swml: JSON.stringify(swml),
            },
        }),
    });

    const body = await res.text();
    console.log(`HTTP ${res.status}`);
    console.log(body);

    if (!res.ok) {
        console.error('Call origination failed. Check the body above for an error.');
        process.exit(2);
    }

    let parsed: any;
    try { parsed = JSON.parse(body); } catch { /* leave parsed undefined */ }
    const callId = parsed?.id || parsed?.call_id;
    if (callId) {
        console.log(`\nCall id: ${callId}`);
        console.log(`Inspect: https://${spaceUrl}/logs/calls/${callId}`);
    }
    console.log('\nNext steps:');
    console.log('  1. Run #1 — ANSWER the test cell. Expect TTS "Detect result: human", then hangup.');
    console.log('  2. Run #2 — DO NOT ANSWER. Expect VM recording with "Detect result: machine".');
    console.log('  3. Open the SignalWire dashboard call detail and confirm detect_machine fired.');
}

main().catch((err) => {
    console.error('Smoke test errored:', err);
    process.exit(3);
});
