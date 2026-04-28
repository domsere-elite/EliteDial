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
    powerDialBridgeAgentSwml,
    powerDialOverflowSwml,
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

// ---- powerDialDetectSwml -----------------------------------------------------

test('swml-builder: powerDialDetectSwml answers, runs detect_machine, and conds on detect_result', () => {
    const doc = powerDialDetectSwml({
        claimUrl: 'https://api.test/swml/power-dial/claim',
        voicemailUrl: 'https://api.test/swml/power-dial/voicemail',
        batchId: 'batch-1',
        legId: 'leg-1',
        campaignId: 'camp-1',
        callerId: '+13467760336',
    });
    assert.equal(doc.version, '1.0.0');
    const main = doc.sections.main;

    assert.ok(main.some((s: any) => s.answer !== undefined), 'answer step present');

    const detect = main.find((s: any) => s.detect_machine !== undefined);
    assert.ok(detect, 'detect_machine step present');
    assert.equal(detect.detect_machine.detectors, 'amd');
    assert.equal(detect.detect_machine.wait, true);
    assert.ok(typeof detect.detect_machine.timeout === 'number' && detect.detect_machine.timeout > 0);

    const cond = main.find((s: any) => s.cond !== undefined);
    assert.ok(cond, 'cond step present');
    const branches = cond.cond as any[];
    const human = branches.find((b: any) => b.when === "detect_result == 'human'");
    assert.ok(human, "human branch present matching detect_result == 'human'");
    const elseBranch = branches.find((b: any) => b.else);
    assert.ok(elseBranch, 'else branch present for non-human results');
});

test('swml-builder: powerDialDetectSwml claim URL embeds batchId+legId+campaignId+callerId; voicemail URL embeds campaignId+legId', () => {
    const doc = powerDialDetectSwml({
        claimUrl: 'https://api.test/swml/power-dial/claim',
        voicemailUrl: 'https://api.test/swml/power-dial/voicemail',
        batchId: 'batch-42',
        legId: 'leg-7',
        campaignId: 'camp-X',
        callerId: '+13467760336',
    });
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const human = cond.find((b: any) => b.when === "detect_result == 'human'");
    const elseBranch = cond.find((b: any) => b.else);

    const humanReq = human.then.find((s: any) => s.request !== undefined);
    assert.match(humanReq.request.url, /batchId=batch-42/);
    assert.match(humanReq.request.url, /legId=leg-7/);
    assert.match(humanReq.request.url, /campaignId=camp-X/);
    assert.match(humanReq.request.url, /callerId=%2B13467760336/);
    assert.equal(humanReq.request.method, 'POST');

    const elseReq = elseBranch.else.find((s: any) => s.request !== undefined);
    assert.match(elseReq.request.url, /campaignId=camp-X/);
    assert.match(elseReq.request.url, /legId=leg-7/);
    assert.equal(elseReq.request.method, 'POST');
});

test('swml-builder: powerDialDetectSwml URL-encodes ids that contain unsafe characters', () => {
    const doc = powerDialDetectSwml({
        claimUrl: 'https://api.test/swml/power-dial/claim',
        voicemailUrl: 'https://api.test/swml/power-dial/voicemail',
        batchId: 'batch with space',
        legId: 'leg/1',
        campaignId: 'camp&id',
        callerId: '+1 555 0000',
    });
    const cond = doc.sections.main.find((s: any) => s.cond !== undefined)!.cond as any[];
    const humanReqUrl = cond.find((b: any) => b.then).then.find((s: any) => s.request).request.url;
    assert.match(humanReqUrl, /batchId=batch%20with%20space/);
    assert.match(humanReqUrl, /legId=leg%2F1/);
});

// ---- powerDialBridgeAgentSwml ------------------------------------------------

test('swml-builder: powerDialBridgeAgentSwml connects to /private/<targetRef> with caller ID', () => {
    const doc = powerDialBridgeAgentSwml({ targetRef: 'dominic', callerId: '+13467760336' });
    assert.equal(doc.version, '1.0.0');
    const connect = doc.sections.main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.to, '/private/dominic');
    assert.equal(connect.connect.from, '+13467760336');
    assert.equal(connect.connect.answer_on_bridge, true);
    assert.ok(connect.on_failure, 'on_failure handler present');
});

test('swml-builder: powerDialBridgeAgentSwml records the bridged call', () => {
    const doc = powerDialBridgeAgentSwml({ targetRef: 'agent42', callerId: '+15551112222' });
    const recorder = doc.sections.main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call step present');
    assert.equal(recorder.record_call.stereo, true);
    assert.equal(recorder.record_call.format, 'mp3');
});

// ---- powerDialOverflowSwml ---------------------------------------------------

test('swml-builder: powerDialOverflowSwml(ai) connects to retellSipAddress when retell+callerId provided', () => {
    const doc = powerDialOverflowSwml({
        mode: 'ai',
        retellSipAddress: 'sip:agent_abc@host',
        callerId: '+13467760336',
    });
    const connect = doc.sections.main.find((s: any) => s.connect !== undefined);
    assert.ok(connect, 'connect step present for AI bridge');
    assert.equal(connect.connect.to, 'sip:agent_abc@host');
    assert.equal(connect.connect.from, '+13467760336');
    const recorder = doc.sections.main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call still on AI overflow path');
});

test('swml-builder: powerDialOverflowSwml(ai) falls back to hangup when retellSipAddress missing', () => {
    const doc = powerDialOverflowSwml({ mode: 'ai', callerId: '+15550001111' });
    assert.deepEqual(doc.sections.main, [{ hangup: {} }]);
});

test('swml-builder: powerDialOverflowSwml(leave_message) plays TTS then hangs up', () => {
    const doc = powerDialOverflowSwml({
        mode: 'leave_message',
        voicemailMessage: 'Hi, this is Elite. Please call us back.',
    });
    const main = doc.sections.main;
    const play = main.find((s: any) => s.play !== undefined);
    assert.ok(play, 'play step present for TTS');
    assert.match(play.play.url, /^say:Hi, this is Elite/);
    assert.ok(main.some((s: any) => s.hangup !== undefined), 'hangup follows the message');
});

test('swml-builder: powerDialOverflowSwml(leave_message) without message degrades to hangup', () => {
    const doc = powerDialOverflowSwml({ mode: 'leave_message' });
    assert.deepEqual(doc.sections.main, [{ hangup: {} }]);
});

test('swml-builder: powerDialOverflowSwml(hangup) returns minimal hangup SWML', () => {
    const doc = powerDialOverflowSwml({ mode: 'hangup' });
    assert.deepEqual(doc.sections.main, [{ hangup: {} }]);
});
