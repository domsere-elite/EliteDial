import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    inboundIvrSwml,
    ivrSelectionSwml,
    connectAgentSwml,
    voicemailSwml,
    queueHoldSwml,
    bridgeOutboundSwml,
    transferSwml,
    hangupSwml,
    bridgeOutboundAiSwml,
    powerDialDetectSwml,
} from '../services/swml/builder';

test('swml-builder: inbound IVR presents 3-option menu with action callback', () => {
    const doc = inboundIvrSwml({ actionUrl: 'https://example.test/swml/ivr-action' });
    assert.equal(doc.version, '1.0.0');
    assert.ok(doc.sections.main, 'main section exists');
    const main = doc.sections.main;
    assert.ok(main.some((step: any) => step.answer !== undefined), 'answer step present');
    const prompt = main.find((step: any) => step.prompt !== undefined);
    assert.ok(prompt, 'prompt step present');
    assert.equal(prompt.prompt.max_digits, 1);
    assert.match(prompt.prompt.play || prompt.prompt.say, /payment|agent|voicemail/i);
});

test('swml-builder: IVR selection "1" routes to payment queue', () => {
    const doc = ivrSelectionSwml({ digit: '1', connectAgentUrl: 'https://x.test/swml/connect-agent', voicemailUrl: 'https://x.test/swml/voicemail' });
    assert.equal(doc.version, '1.0.0');
    const steps = doc.sections.main;
    assert.ok(steps.some((s: any) => s.say?.text?.match(/payment/i)));
});

test('swml-builder: IVR selection "2" transfers to connect-agent section', () => {
    const doc = ivrSelectionSwml({ digit: '2', connectAgentUrl: 'https://x.test/swml/connect-agent', voicemailUrl: 'https://x.test/swml/voicemail' });
    const steps = doc.sections.main;
    const request = steps.find((s: any) => s.request !== undefined);
    assert.ok(request, 'request verb present to fetch connect-agent SWML');
    assert.equal(request.request.url, 'https://x.test/swml/connect-agent');
});

test('swml-builder: IVR selection "3" enters voicemail record flow', () => {
    const doc = ivrSelectionSwml({ digit: '3', connectAgentUrl: 'https://x.test/swml/connect-agent', voicemailUrl: 'https://x.test/swml/voicemail' });
    const steps = doc.sections.main;
    const record = steps.find((s: any) => s.record !== undefined);
    assert.ok(record, 'record verb present for voicemail');
    assert.equal(record.record.max_length, 120);
    assert.equal(record.record.beep, true);
});

test('swml-builder: IVR selection default hangs up with apology', () => {
    const doc = ivrSelectionSwml({ digit: '9', connectAgentUrl: 'https://x.test/swml/connect-agent', voicemailUrl: 'https://x.test/swml/voicemail' });
    const steps = doc.sections.main;
    assert.ok(steps.some((s: any) => s.hangup !== undefined), 'hangup present');
});

test('swml-builder: connect-agent uses SIP address to fabric extension', () => {
    const doc = connectAgentSwml({
        extension: 'agent-alice',
        spaceUrl: 'mytest.signalwire.com',
        fallbackVoicemailUrl: 'https://x.test/swml/voicemail',
    });
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, 'sip:agent-alice@mytest.signalwire.com');
    assert.equal(connect.connect.answer_on_bridge, true);
    // on_failure must fall through to voicemail
    assert.ok(connect.on_failure, 'on_failure branch present');
    const onFail = connect.on_failure;
    assert.ok(onFail.some((s: any) => s.request !== undefined), 'on_failure fetches voicemail SWML');
});

test('swml-builder: voicemail records up to 120s and fires recording webhook', () => {
    const doc = voicemailSwml();
    const main = doc.sections.main;
    const record = main.find((s: any) => s.record !== undefined);
    assert.ok(record, 'record step present');
    assert.equal(record.record.max_length, 120);
    assert.equal(record.record.end_silence_timeout, 3);
});

test('swml-builder: queue-hold plays hold music and offers voicemail fallback', () => {
    const doc = queueHoldSwml({ voicemailUrl: 'https://x.test/swml/voicemail' });
    const main = doc.sections.main;
    assert.ok(main.some((s: any) => s.play !== undefined || s.say !== undefined));
    const prompt = main.find((s: any) => s.prompt !== undefined);
    assert.ok(prompt, 'overflow prompt present');
});

test('swml-builder: outbound bridge connects to destination with caller ID', () => {
    const doc = bridgeOutboundSwml({ to: '+15551234567', from: '+15559998888' });
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.ok(connect);
    assert.equal(connect.connect.to, '+15551234567');
    assert.equal(connect.connect.from, '+15559998888');
});

test('swml-builder: transferSwml connects to phone number target', () => {
    const doc = transferSwml({ to: '+15551234567', from: '+15559998888' });
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, '+15551234567');
});

test('swml-builder: transferSwml connects to SIP target when target is a SIP URI', () => {
    const doc = transferSwml({ to: 'sip:ai@elevenlabs.sip.signalwire.com', from: '+15559998888' });
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, 'sip:ai@elevenlabs.sip.signalwire.com');
});

test('swml-builder: hangupSwml is minimal and valid', () => {
    const doc = hangupSwml();
    assert.equal(doc.version, '1.0.0');
    assert.ok(doc.sections.main.some((s: any) => s.hangup !== undefined));
});

test('swml-builder: bridgeOutboundAiSwml connects to Retell SIP URI with caller ID', () => {
    const doc = bridgeOutboundAiSwml({
        retellSipAddress: 'sip:agent_abc123@5t4n6j0wnrl.sip.livekit.cloud',
        from: '+15551234567',
    });
    assert.equal(doc.version, '1.0.0');
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, 'sip:agent_abc123@5t4n6j0wnrl.sip.livekit.cloud');
    assert.equal(connect.connect.from, '+15551234567');
    assert.equal(connect.connect.answer_on_bridge, true);
});

test('swml-builder: bridgeOutboundAiSwml always includes record_call', () => {
    const doc = bridgeOutboundAiSwml({
        retellSipAddress: 'sip:agent@example',
        from: '+15551112222',
    });
    const recorder = doc.sections.main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call step present');
    assert.equal(recorder.record_call.stereo, true);
    assert.equal(recorder.record_call.format, 'mp3');
});

// ---- powerDialDetectSwml (multi-section, all routing inline) -----------------

const baseDetectParams = {
    claimUrl: 'https://api.test/swml/power-dial/claim',
    voicemailUrl: 'https://api.test/swml/power-dial/voicemail',
    batchId: 'batch-1',
    legId: 'leg-1',
    campaignId: 'camp-1',
    callerId: '+13467760336',
    targetRef: 'dominic',
    retellSipAddress: null as string | null,
    voicemailBehavior: 'hangup' as 'hangup' | 'leave_message',
    voicemailMessage: null as string | null,
    // Default skipAmd=false in the existing test fixture so the AMD-path tests
    // below keep verifying the AMD flow. New tests further down assert the
    // skipAmd=true (production default) flow.
    skipAmd: false,
};

test('swml-builder: powerDialDetectSwml main runs answer + detect_machine + cond', () => {
    const doc = powerDialDetectSwml(baseDetectParams);
    assert.equal(doc.version, '1.0.0');
    const main = doc.sections.main;
    assert.ok(main.some((s: any) => s.answer !== undefined), 'answer present');
    const detect = main.find((s: any) => s.detect_machine !== undefined);
    assert.ok(detect, 'detect_machine present');
    assert.equal(detect.detect_machine.detectors, 'amd');
    assert.equal(detect.detect_machine.wait, true);
    const cond = main.find((s: any) => s.cond !== undefined);
    assert.ok(cond, 'cond present');
});

test('swml-builder: powerDialDetectSwml — human branch hits claim URL with save_variables and switches on outcome', () => {
    const doc = powerDialDetectSwml(baseDetectParams);
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const human = cond.find((b: any) => b.when === "detect_result == 'human'");
    assert.ok(human, 'human branch present');
    const req = human.then.find((s: any) => s.request);
    assert.ok(req, 'request step in human branch');
    assert.equal(req.request.method, 'POST');
    assert.equal(req.request.save_variables, true, 'save_variables: true (response goes into request_response.*)');
    assert.match(req.request.url, /batchId=batch-1/);
    assert.match(req.request.url, /legId=leg-1/);
    assert.match(req.request.url, /campaignId=camp-1/);
    assert.match(req.request.url, /callerId=%2B13467760336/);
    const sw = human.then.find((s: any) => s.switch);
    assert.ok(sw, 'switch follows the request to branch on the JSON outcome');
    assert.equal(sw.switch.variable, 'request_response.outcome');
    assert.deepEqual(Object.keys(sw.switch.case).sort(), ['bridge', 'hangup', 'overflow']);
});

test('swml-builder: powerDialDetectSwml — non-human branch fires audit request then hangs up (default voicemailBehavior)', () => {
    const doc = powerDialDetectSwml(baseDetectParams);
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const elseBranch = cond.find((b: any) => b.else)!;
    const steps = elseBranch.else as any[];
    const req = steps.find((s: any) => s.request);
    assert.ok(req, 'voicemail audit request present');
    assert.match(req.request.url, /campaignId=camp-1/);
    assert.match(req.request.url, /legId=leg-1/);
    assert.equal(req.request.save_variables, undefined, 'audit request does not need response data');
    assert.ok(steps.some((s: any) => s.hangup !== undefined), 'hangup follows audit');
    assert.ok(!steps.some((s: any) => s.play !== undefined), 'no TTS play when behavior=hangup');
});

test('swml-builder: powerDialDetectSwml — leave_message bakes TTS into voicemail branch', () => {
    const doc = powerDialDetectSwml({
        ...baseDetectParams,
        voicemailBehavior: 'leave_message',
        voicemailMessage: 'Hi this is Elite, please call us back.',
    });
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const elseBranch = cond.find((b: any) => b.else)!;
    const steps = elseBranch.else as any[];
    const play = steps.find((s: any) => s.play);
    assert.ok(play, 'play step present');
    assert.match(play.play.url, /^say:Hi this is Elite/);
    assert.ok(steps.some((s: any) => s.hangup !== undefined), 'hangup follows TTS');
});

test('swml-builder: powerDialDetectSwml — leave_message without message degrades to hangup', () => {
    const doc = powerDialDetectSwml({
        ...baseDetectParams,
        voicemailBehavior: 'leave_message',
        voicemailMessage: '',
    });
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const elseBranch = cond.find((b: any) => b.else)!;
    const steps = elseBranch.else as any[];
    assert.ok(!steps.some((s: any) => s.play !== undefined), 'no TTS when message empty');
    assert.ok(steps.some((s: any) => s.hangup !== undefined), 'still hangs up cleanly');
});

test('swml-builder: powerDialDetectSwml — bridge section connects to /private/<targetRef> with no TTS hold', () => {
    const doc = powerDialDetectSwml({ ...baseDetectParams, targetRef: 'dominic' });
    const bridge = doc.sections.bridge as any[];
    assert.ok(bridge, 'bridge section present');

    // skipAmd=true gets customer to bridge in <1s, WebRTC completes in ~3s,
    // so no TTS audio masking is needed. Bridge is just connect + hangup.
    assert.ok(!bridge.some((s: any) => s.play !== undefined), 'no TTS hold (was needed for AMD path; not for skipAmd path)');

    const connect = bridge.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, '/private/dominic');
    assert.equal(connect.connect.from, undefined, 'no from: — mirrors working softphone shape');
    assert.equal(connect.connect.answer_on_bridge, true);
    assert.equal(connect.connect.timeout, 30);
    assert.ok(bridge.some((s: any) => s.hangup !== undefined), 'trailing hangup');
});

test('swml-builder: powerDialDetectSwml — overflow_ai connects to retellSipAddress when configured', () => {
    const doc = powerDialDetectSwml({
        ...baseDetectParams,
        retellSipAddress: 'sip:agent_abc@retell.example',
    });
    const overflow = doc.sections.overflow_ai as any[];
    assert.ok(overflow, 'overflow_ai section present');
    const connect = overflow.find((s: any) => s.connect);
    assert.ok(connect, 'overflow_ai.connect present');
    assert.equal(connect.connect.to, 'sip:agent_abc@retell.example');
});

test('swml-builder: powerDialDetectSwml — overflow_ai degrades to hangup when no retellSipAddress', () => {
    const doc = powerDialDetectSwml({ ...baseDetectParams, retellSipAddress: null });
    const overflow = doc.sections.overflow_ai as any[];
    assert.deepEqual(overflow, [{ hangup: {} }]);
});

test('swml-builder: powerDialDetectSwml — hangup_now section is just a hangup', () => {
    const doc = powerDialDetectSwml(baseDetectParams);
    assert.deepEqual(doc.sections.hangup_now, [{ hangup: {} }]);
});

test('swml-builder: powerDialDetectSwml URL-encodes ids that contain unsafe characters', () => {
    const doc = powerDialDetectSwml({
        ...baseDetectParams,
        batchId: 'batch with space',
        legId: 'leg/1',
        campaignId: 'camp&id',
    });
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const humanReqUrl = cond.find((b: any) => b.then).then.find((s: any) => s.request).request.url;
    assert.match(humanReqUrl, /batchId=batch%20with%20space/);
    assert.match(humanReqUrl, /legId=leg%2F1/);
});

// ---- skipAmd=true (production default) — fast path with no AMD --------------

test('swml-builder: powerDialDetectSwml(skipAmd=true) — main is answer + claim, no detect_machine, no cond', () => {
    const doc = powerDialDetectSwml({ ...baseDetectParams, skipAmd: true });
    const main = doc.sections.main;
    assert.ok(main.some((s: any) => s.answer !== undefined), 'answer present');
    assert.ok(!main.some((s: any) => s.detect_machine !== undefined), 'no detect_machine in fast path');
    assert.ok(!main.some((s: any) => s.cond !== undefined), 'no cond branching in fast path');
    const req = main.find((s: any) => s.request !== undefined);
    assert.ok(req, 'request to claim present');
    assert.equal(req.request.save_variables, true);
    const sw = main.find((s: any) => s.switch !== undefined);
    assert.ok(sw, 'switch on outcome present');
    assert.equal(sw.switch.variable, 'request_response.outcome');
});

test('swml-builder: powerDialDetectSwml(skipAmd=true) — bridge, overflow_ai, hangup_now sections still exist', () => {
    const doc = powerDialDetectSwml({ ...baseDetectParams, skipAmd: true });
    assert.ok(doc.sections.bridge, 'bridge section still defined for outcome=bridge');
    assert.ok(doc.sections.overflow_ai, 'overflow_ai still defined');
    assert.ok(doc.sections.hangup_now, 'hangup_now still defined');
});

test('swml-builder: powerDialDetectSwml(skipAmd=true) — claim URL still embeds all routing params', () => {
    const doc = powerDialDetectSwml({
        ...baseDetectParams,
        skipAmd: true,
        batchId: 'b-7',
        legId: 'l-9',
        campaignId: 'c-3',
    });
    const req = doc.sections.main.find((s: any) => s.request !== undefined)!;
    assert.match(req.request.url, /batchId=b-7/);
    assert.match(req.request.url, /legId=l-9/);
    assert.match(req.request.url, /campaignId=c-3/);
    assert.match(req.request.url, /callerId=%2B13467760336/);
});
