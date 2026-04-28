// Pure SWML document builders. Return JSON documents that SignalWire executes.
// No side effects. No I/O. No HTTP. Testable in isolation.
//
// SWML spec reference: https://developer.signalwire.com/swml/
// Version pinned to 1.0.0 for the duration of this product; update deliberately.

export type SwmlStep = Record<string, any>;

export interface SwmlDocument {
    version: '1.0.0';
    sections: {
        main: SwmlStep[];
        [sectionName: string]: SwmlStep[];
    };
}

const isPhoneNumber = (target: string): boolean => /^\+?[1-9]\d{7,14}$/.test(target);

export function hangupSwml(reason?: string): SwmlDocument {
    const main: SwmlStep[] = [];
    if (reason) main.push({ say: { text: reason } });
    main.push({ hangup: {} });
    return { version: '1.0.0', sections: { main } };
}

export interface InboundIvrParams {
    actionUrl: string; // absolute URL to `/swml/ivr-action`
}

export function inboundIvrSwml(params: InboundIvrParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                { say: { text: 'Thank you for calling Elite Portfolio Management.' } },
                {
                    prompt: {
                        say: 'Press 1 to make a payment. Press 2 to speak with an agent. Press 3 to leave a voicemail.',
                        max_digits: 1,
                        digit_timeout: 10,
                    },
                    on_success: [
                        {
                            request: {
                                url: params.actionUrl,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: { digit: '%{args.result}' },
                            },
                        },
                    ],
                    on_failure: [
                        { say: { text: 'We did not receive your selection. Goodbye.' } },
                        { hangup: {} },
                    ],
                },
            ],
        },
    };
}

export interface IvrSelectionParams {
    digit: string;
    connectAgentUrl: string; // `/swml/connect-agent`
    voicemailUrl: string;    // `/swml/voicemail`
}

export function ivrSelectionSwml(params: IvrSelectionParams): SwmlDocument {
    switch (params.digit) {
        case '1':
            return {
                version: '1.0.0',
                sections: {
                    main: [
                        { say: { text: 'Connecting you to our payment system. Please hold.' } },
                        { request: { url: params.connectAgentUrl, method: 'POST' } },
                    ],
                },
            };
        case '2':
            return {
                version: '1.0.0',
                sections: {
                    main: [
                        { say: { text: 'Please hold while we connect you with an agent.' } },
                        { request: { url: params.connectAgentUrl, method: 'POST' } },
                    ],
                },
            };
        case '3':
            return {
                version: '1.0.0',
                sections: {
                    main: [
                        { say: { text: 'Please leave your message after the tone.' } },
                        {
                            record: {
                                max_length: 120,
                                end_silence_timeout: 3,
                                beep: true,
                                terminators: '#',
                            },
                        },
                        { say: { text: 'Thank you for your message. Goodbye.' } },
                        { hangup: {} },
                    ],
                },
            };
        default:
            return {
                version: '1.0.0',
                sections: {
                    main: [
                        { say: { text: 'Invalid selection. Goodbye.' } },
                        { hangup: {} },
                    ],
                },
            };
    }
}

export interface ConnectAgentParams {
    extension: string;
    spaceUrl: string; // e.g. "mytest.signalwire.com"
    fallbackVoicemailUrl: string;
}

export function connectAgentSwml(params: ConnectAgentParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { say: { text: 'Please hold while we connect you.' } },
                {
                    connect: {
                        to: `sip:${params.extension}@${params.spaceUrl}`,
                        timeout: 20,
                        answer_on_bridge: true,
                    },
                    on_failure: [
                        { say: { text: 'We could not reach an agent. Please leave a voicemail after the tone.' } },
                        { request: { url: params.fallbackVoicemailUrl, method: 'POST' } },
                    ],
                },
            ],
        },
    };
}

export function voicemailSwml(): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { say: { text: 'Please leave your message after the tone. Press pound when finished.' } },
                {
                    record: {
                        max_length: 120,
                        end_silence_timeout: 3,
                        beep: true,
                        terminators: '#',
                    },
                },
                { say: { text: 'Thank you for your message. A representative will return your call shortly. Goodbye.' } },
                { hangup: {} },
            ],
        },
    };
}

export interface QueueHoldParams {
    voicemailUrl: string;
}

export function queueHoldSwml(params: QueueHoldParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { say: { text: 'All agents are currently assisting other callers. Your call is important to us.' } },
                { play: { url: '/audio/hold-music.mp3' } },
                {
                    prompt: {
                        say: 'Press 1 to continue holding, or press 2 to leave a voicemail.',
                        max_digits: 1,
                        digit_timeout: 10,
                    },
                    on_success: [
                        {
                            switch: {
                                variable: '%{args.result}',
                                case: {
                                    '2': [
                                        { request: { url: params.voicemailUrl, method: 'POST' } },
                                    ],
                                    default: [
                                        { say: { text: 'Thank you for your patience. Please continue to hold.' } },
                                        { play: { url: '/audio/hold-music.mp3' } },
                                    ],
                                },
                            },
                        },
                    ],
                    on_failure: [
                        { say: { text: 'Thank you for your patience. Please continue to hold.' } },
                        { play: { url: '/audio/hold-music.mp3' } },
                    ],
                },
            ],
        },
    };
}

export interface BridgeOutboundParams {
    to: string;   // E.164 phone number
    from: string; // caller ID
}

export function bridgeOutboundSwml(params: BridgeOutboundParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                {
                    connect: {
                        to: params.to,
                        from: params.from,
                        timeout: 30,
                        answer_on_bridge: true,
                    },
                    on_failure: [{ hangup: {} }],
                },
                { record_call: { stereo: true, format: 'mp3' } },
            ],
        },
    };
}

export interface TransferSwmlParams {
    to: string;   // E.164 phone number or `sip:user@host` URI
    from?: string; // caller ID to present
}

export function transferSwml(params: TransferSwmlParams): SwmlDocument {
    const to = isPhoneNumber(params.to) || params.to.startsWith('sip:') ? params.to : params.to;
    return {
        version: '1.0.0',
        sections: {
            main: [
                { say: { text: 'Please hold while we transfer your call.' } },
                {
                    connect: {
                        to,
                        ...(params.from ? { from: params.from } : {}),
                        timeout: 30,
                        answer_on_bridge: true,
                    },
                    on_failure: [
                        { say: { text: 'We were unable to complete the transfer. Goodbye.' } },
                        { hangup: {} },
                    ],
                },
            ],
        },
    };
}

export interface BridgeOutboundAiParams {
    retellSipAddress: string; // sip:agent_xxx@host
    from: string;             // caller ID (DID)
}

export function bridgeOutboundAiSwml(params: BridgeOutboundAiParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                {
                    connect: {
                        to: params.retellSipAddress,
                        from: params.from,
                        timeout: 30,
                        answer_on_bridge: true,
                    },
                    on_failure: [{ hangup: {} }],
                },
                { record_call: { stereo: true, format: 'mp3' } },
            ],
        },
    };
}

// --- Power-dial Phase 2 builders --------------------------------------------
// detect_machine smoke test on executive-strategy.signalwire.com confirmed:
//   - The verb is enabled and `wait: true` blocks until detection completes.
//   - `cond` branches on `detect_result` work as documented.
//   - Anything not 'human' (machine, fax, unknown) is folded into the
//     non-human branch in the call paths below — that matches the spec
//     ("else" → voicemail/hangup).

export interface PowerDialDetectParams {
    claimUrl: string;     // absolute URL to /swml/power-dial/claim
    voicemailUrl: string; // absolute URL to /swml/power-dial/voicemail
    batchId: string;
    legId: string;
    campaignId: string;
    // The worker knows the DID it originated with (per-campaign DID routing
    // means it can vary). Threading it through the URL means the claim/
    // voicemail routes don't need to re-derive a default.
    callerId: string;
}

// Inline SWML for the customer leg POSTed to /api/calling/calls.
// Flow: answer → detect_machine (AMD, wait for result) → branch on detect_result.
// Human → /swml/power-dial/claim (server decides bridge-or-overflow atomically).
// Anything else → /swml/power-dial/voicemail (hangup or leave_message per campaign).
export function powerDialDetectSwml(p: PowerDialDetectParams): SwmlDocument {
    const cid = encodeURIComponent(p.callerId);
    const claimUrl = `${p.claimUrl}?batchId=${encodeURIComponent(p.batchId)}&legId=${encodeURIComponent(p.legId)}&campaignId=${encodeURIComponent(p.campaignId)}&callerId=${cid}`;
    const voicemailUrl = `${p.voicemailUrl}?campaignId=${encodeURIComponent(p.campaignId)}&legId=${encodeURIComponent(p.legId)}`;
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
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
                                { request: { url: claimUrl, method: 'POST' } },
                            ],
                        },
                        {
                            else: [
                                { request: { url: voicemailUrl, method: 'POST' } },
                            ],
                        },
                    ],
                },
            ],
        },
    };
}

export interface PowerDialBridgeAgentParams {
    targetRef: string; // email local-part used at /private/<ref>
    callerId: string;  // DID for caller_id presentation; carries through bridge
}

// Returned from /swml/power-dial/claim when a leg wins the race for the agent slot.
// Connects the customer to the agent's Fabric address. Same shape the softphone
// outbound uses — keep it identical so the agent SDK's incoming-Fabric handler
// doesn't need a new branch.
export function powerDialBridgeAgentSwml(p: PowerDialBridgeAgentParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                {
                    connect: {
                        to: `/private/${p.targetRef}`,
                        from: p.callerId,
                        timeout: 30,
                        answer_on_bridge: true,
                    },
                    on_failure: [{ hangup: {} }],
                },
                { record_call: { stereo: true, format: 'mp3' } },
            ],
        },
    };
}

export interface PowerDialOverflowParams {
    mode: 'ai' | 'hangup' | 'leave_message';
    retellSipAddress?: string;
    callerId?: string;
    voicemailMessage?: string;
}

// Returned from /swml/power-dial/claim for race losers, and from
// /swml/power-dial/voicemail for non-human detect results when the campaign
// has voicemailBehavior='leave_message'. For 'hangup' (or any incomplete
// config — missing retellSipAddress, missing voicemailMessage), falls back
// to a clean hangup.
export function powerDialOverflowSwml(p: PowerDialOverflowParams): SwmlDocument {
    if (p.mode === 'ai' && p.retellSipAddress && p.callerId) {
        return {
            version: '1.0.0',
            sections: {
                main: [
                    {
                        connect: {
                            to: p.retellSipAddress,
                            from: p.callerId,
                            timeout: 30,
                            answer_on_bridge: true,
                        },
                        on_failure: [{ hangup: {} }],
                    },
                    { record_call: { stereo: true, format: 'mp3' } },
                ],
            },
        };
    }
    if (p.mode === 'leave_message' && p.voicemailMessage) {
        return {
            version: '1.0.0',
            sections: {
                main: [
                    { play: { url: `say:${p.voicemailMessage}` } },
                    { hangup: {} },
                ],
            },
        };
    }
    return hangupSwml();
}
