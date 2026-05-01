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
// Architecture note (validated by smoke #2 failure analysis):
//
// SWML's `request:` verb is a SIDE-EFFECT HTTP call. Its response body is
// stored in `%{request_response.<field>}` variables (when save_variables is
// true) and execution continues with the NEXT step in the same SWML doc. The
// response body is NOT executed as SWML continuation — that was the broken
// assumption in the first design. So all routing must live in inline SWML
// sections at origination time; the HTTP callbacks just return data values
// the SWML branches on.
//
// Layout:
//   main           → answer + detect_machine + cond on detect_result
//                    human  → request claim, switch on outcome → goto bridge|overflow|hangup_now
//                    other  → fire-and-forget voicemail audit, then cond on bake-time
//                            voicemailBehavior → leave_message (TTS) or hangup
//   bridge         → connect /private/<targetRef> (the agent's softphone)
//   overflow_ai    → connect <retellSipAddress> (only if campaign has one)
//   hangup_now     → terminal hangup
//
// All campaign-time-known config (targetRef, retellSipAddress,
// voicemailMessage) is baked into the SWML at origination so we don't need
// runtime callbacks for routing decisions — only for the atomic claim race.

export interface PowerDialDetectParams {
    claimUrl: string;     // absolute URL to /swml/power-dial/claim
    voicemailUrl: string; // absolute URL to /swml/power-dial/voicemail (audit only)
    batchId: string;
    legId: string;
    campaignId: string;
    callerId: string;     // DID, threaded into URL params
    targetRef: string;    // agent email local-part for /private/<ref>
    retellSipAddress?: string | null; // campaign's AI overflow target, if configured
    voicemailBehavior: 'hangup' | 'leave_message';
    voicemailMessage?: string | null;
    // When true (production default), the customer-leg SWML skips AMD and goes
    // straight from answer → claim → bridge. Saves 4-7s of post-answer silence
    // at the cost of agents handling voicemails manually. When false, the
    // existing AMD-driven path runs (cond on detect_result, voicemail branch
    // honours voicemailBehavior).
    skipAmd: boolean;
}

export function powerDialDetectSwml(p: PowerDialDetectParams): SwmlDocument {
    const claimUrl = `${p.claimUrl}?batchId=${encodeURIComponent(p.batchId)}&legId=${encodeURIComponent(p.legId)}&campaignId=${encodeURIComponent(p.campaignId)}&callerId=${encodeURIComponent(p.callerId)}`;
    const voicemailUrl = `${p.voicemailUrl}?campaignId=${encodeURIComponent(p.campaignId)}&legId=${encodeURIComponent(p.legId)}`;

    const hasRetell = !!(p.retellSipAddress && p.retellSipAddress.length > 0);
    const willLeaveMessage = p.voicemailBehavior === 'leave_message' && !!(p.voicemailMessage && p.voicemailMessage.length > 0);

    // Bridge target is statically known at origination time, so we hard-code it
    // into the bridge section.
    //
    // No TTS hold here — Phase 3a (skipAmd=true) gets the customer to the
    // bridge in <1s of post-answer time, and the WebRTC negotiation completes
    // within 3-5s. The agent's softphone audio is up before the customer
    // notices any silence. If WebRTC ever regresses or AMD is re-enabled
    // (skipAmd=false), the play step would need to come back.
    const bridgeSection: SwmlStep[] = [
        {
            connect: {
                to: `/private/${p.targetRef}`,
                timeout: 30,
                answer_on_bridge: true,
            },
        },
        { hangup: {} },
    ];

    const overflowAiSection: SwmlStep[] = hasRetell
        ? [
            {
                connect: {
                    to: p.retellSipAddress!,
                    timeout: 30,
                    answer_on_bridge: true,
                },
            },
            { hangup: {} },
        ]
        : [{ hangup: {} }];

    const hangupNowSection: SwmlStep[] = [{ hangup: {} }];

    // After the claim request, branch on the JSON outcome the route returned.
    // The route returns one of: bridge | overflow | hangup. Anything else
    // (network error, response missing) falls into the default → hangup_now.
    const claimSteps: SwmlStep[] = [
        {
            request: {
                url: claimUrl,
                method: 'POST',
                save_variables: true,
                timeout: 10,
            },
        },
        {
            switch: {
                variable: 'request_response.outcome',
                case: {
                    bridge: [{ transfer: 'bridge' }],
                    overflow: [{ transfer: 'overflow_ai' }],
                    hangup: [{ transfer: 'hangup_now' }],
                },
                default: [{ transfer: 'hangup_now' }],
            },
        },
    ];

    // Non-human (machine/fax/unknown) branch. Fire-and-forget the voicemail
    // audit (no save_variables — we don't need the response). Then play the
    // TTS message if configured, else hangup. voicemailMessage is baked at
    // origination from campaign config.
    const voicemailBranch: SwmlStep[] = willLeaveMessage
        ? [
            { request: { url: voicemailUrl, method: 'POST', timeout: 5 } },
            { play: { url: `say:${p.voicemailMessage}` } },
            { hangup: {} },
        ]
        : [
            { request: { url: voicemailUrl, method: 'POST', timeout: 5 } },
            { hangup: {} },
        ];

    // Two main flows:
    //
    // skipAmd=true (production default): answer + claim + branch. No AMD, no
    //   voicemail branch on the customer leg. Total post-answer time before
    //   bridge attempt: ~150ms (the claim HTTP roundtrip). Agents handle VMs.
    //
    // skipAmd=false (compliance-sensitive opt-in): answer + detect_machine
    //   (4-7s) + cond on detect_result. Human → claim. Machine → voicemail
    //   branch (audit + optional TTS).
    const mainSteps: SwmlStep[] = p.skipAmd
        ? [{ answer: {} }, ...claimSteps]
        : [
            { answer: {} },
            { detect_machine: { detectors: 'amd', wait: true, timeout: 10 } },
            {
                cond: [
                    { when: "detect_result == 'human'", then: claimSteps },
                    { else: voicemailBranch },
                ],
            },
        ];

    return {
        version: '1.0.0',
        sections: {
            main: mainSteps,
            bridge: bridgeSection,
            overflow_ai: overflowAiSection,
            hangup_now: hangupNowSection,
        },
    };
}

export interface AgentRoomParams {
    agentId: string;
    /**
     * Optional conference-level callback URL. When set, SignalWire fires
     * participant-join / participant-leave / conference-end events to this URL.
     * Used by Phase 3c to flip the agent into wrap-up when the customer leaves.
     */
    statusUrl?: string;
}

// Per-agent moderator room used to keep the WebRTC PeerConnection warm so
// customer legs can `join_room` into an already-negotiated session and get
// instant audio (Phase 3c). Lifecycle is bound to Profile.status === 'available';
// `end_conference_on_exit: true` ties the room's death to the agent leaving.
export function agentRoomSwml(params: AgentRoomParams): SwmlDocument {
    const joinRoom: Record<string, unknown> = {
        name: `agent-room-${params.agentId}`,
        moderator: true,
        start_conference_on_enter: true,
        end_conference_on_exit: true,
        muted: false,
    };
    if (params.statusUrl) {
        joinRoom.status_url = params.statusUrl;
        joinRoom.status_events = ['conference-start', 'conference-end', 'participant-join', 'participant-leave'];
    }
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                { join_room: joinRoom },
                { hangup: {} },
            ],
        },
    };
}
