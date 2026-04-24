// Pure SWML document builders. Return JSON documents that SignalWire executes.
// No side effects. No I/O. No HTTP. Testable in isolation.
//
// SWML spec reference: https://developer.signalwire.com/swml/
// Version pinned to 1.0.0 for the duration of this product; update deliberately.

export type SwmlStep = Record<string, unknown>;

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
                { say: { text: 'Call is being connected.' } },
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
