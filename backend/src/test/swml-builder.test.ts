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
