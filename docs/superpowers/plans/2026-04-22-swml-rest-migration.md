# SWML + SignalWire REST API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LaML/TwiML telephony layer (`/sw/*` XML webhook routes + LaML REST call creation) with modern SignalWire: SWML JSON documents served from dynamic endpoints, and `POST /api/calling/calls` for call origination. Produces a provider-native implementation suitable for a paid product.

**Architecture:**
- Dynamic SWML documents returned as JSON from Express at `/swml/*` endpoints
- Call origination via `POST /api/calling/calls` with body `{command:"dial", params:{from, to, url, caller_id, status_url}}`
- Status/recording webhooks mounted at `/signalwire/events/*`, parsing JSON payloads with `call_id` / `call_state` fields
- Pure SWML-builder module (`services/swml/builder.ts`) produces testable SWML documents; route handlers only handle HTTP + side effects
- `TelephonyProvider` interface is unchanged; only the `SignalWireService` implementation is rewritten
- AMD-AI-transfer flow is removed (decision: defer AI-overflow feature to a future spec written directly against SWML)
- `transferCall` (agent-initiated warm/cold transfer) is re-implemented via a `/swml/transfer?to=...` SWML document paired with SignalWire's live-call update REST command

**Tech Stack:** Node.js 20+, Express 4, native `fetch`, Prisma, `node:test`, TypeScript strict mode, raw SignalWire REST/SWML (no SDK)

**Execution environment:** All work happens in a dedicated git worktree off `main`. Each task ends with a commit. Final merge back to `main` after the full plan is green.

**Decisions locked (from scoping):**
1. Dynamic SWML endpoints (not static dashboard scripts)
2. Raw `fetch` (not `@signalwire/realtime-api`)
3. New URL prefix `/swml/*` + `/signalwire/events/*` (not `/sw/*`); requires one-time SignalWire Dashboard reconfiguration of the phone number's voice webhook
4. Big-bang rewrite in worktree; `webhooks.ts` deleted in the final cleanup task
5. Delete the stale `2026-04-15-predictive-dialer-ai-overflow.md` plan doc (superseded)
6. AMD-AI-transfer removed; plain AMD not re-added in this migration

---

## File Structure (created/modified)

**New files:**
- `backend/src/services/swml/builder.ts` — pure SWML-document builder functions
- `backend/src/services/swml/index.ts` — re-export
- `backend/src/test/swml-builder.test.ts` — unit tests for builder
- `backend/src/routes/swml.ts` — dynamic SWML document endpoints
- `backend/src/test/swml-routes.test.ts` — SWML route tests
- `backend/src/routes/signalwire-events.ts` — JSON webhook handlers (status, recording)
- `backend/src/test/signalwire-events.test.ts` — event route tests
- `backend/src/test/signalwire-service.test.ts` — rewritten-service tests

**Modified files:**
- `backend/src/services/signalwire.ts` — rewrite internals (REST `/api/calling/calls`, drop `redirectLiveCall`, rewrite `transferCall`)
- `backend/src/routes/system.ts` — advertise new webhook URLs (lines 95–99)
- `backend/src/routes/calls.ts` — update `transferCall` callers if signature changes (lines 1047, 1050)
- `backend/src/index.ts` — unmount `/sw`, mount `/swml` and `/signalwire/events` (line 20, 94)
- `backend/src/config.ts` — drop `config.ai.*` and `config.amd.*` wiring (keep env vars harmless if set)
- `backend/prisma/schema.prisma` — rename `signalwireCallSid` → `signalwireCallId`, drop `telnyx` from comment (line 33)
- `backend/openapi.yaml` — drop `telnyx` from provider enum (line 84)
- `.env.example` — remove AMD_* and AI_TRANSFER_* keys if no longer used

**Deleted files:**
- `backend/src/routes/webhooks.ts` — replaced by `swml.ts` + `signalwire-events.ts`
- `docs/superpowers/plans/2026-04-15-predictive-dialer-ai-overflow.md` — stale, superseded

**CLAUDE.md:** Added at repo root as the final task to codify the architectural invariants.

---

## Task Breakdown

### Task 0: Preflight — worktree and baseline verification

**Files:**
- None modified; worktree creation only.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git worktree add ../EliteDial-swml-migration -b swml-rest-migration main
cd ../EliteDial-swml-migration
```

Expected: new worktree at `../EliteDial-swml-migration` on branch `swml-rest-migration`.

- [ ] **Step 2: Install backend deps + verify baseline**

Run:
```bash
cd backend && npm install && npx prisma generate && npm run build && npm test
```

Expected: build exits 0. Tests: `66 pass, 0 fail`. (66 is the post-predictive-answer-handler-deletion baseline.)

If baseline fails, stop and resolve before proceeding.

- [ ] **Step 3: Confirm worktree is on correct branch**

```bash
git -C .. status --short  # in worktree root; or: cd .. && git status
git branch --show-current
```

Expected: `swml-rest-migration`. Working tree clean.

---

### Task 1: Cleanup — stale plan doc, schema/openapi Telnyx references

**Files:**
- Delete: `docs/superpowers/plans/2026-04-15-predictive-dialer-ai-overflow.md`
- Modify: `backend/prisma/schema.prisma:33`
- Modify: `backend/openapi.yaml:84`

Rationale: clear the board of stale references before the rewrite, so git history for this rewrite is clean of cleanup noise.

- [ ] **Step 1: Delete stale plan**

```bash
rm docs/superpowers/plans/2026-04-15-predictive-dialer-ai-overflow.md
```

- [ ] **Step 2: Update schema.prisma comment**

Open `backend/prisma/schema.prisma`. Change line 33 from:

```prisma
  provider       String   @default("signalwire") // signalwire | retell | telnyx | mock
```

to:

```prisma
  provider       String   @default("signalwire") // signalwire | retell | mock
```

- [ ] **Step 3: Update openapi.yaml provider enum**

Open `backend/openapi.yaml`. Change line 84 from:

```yaml
          enum: [signalwire, retell, telnyx, mock]
```

to:

```yaml
          enum: [signalwire, retell, mock]
```

- [ ] **Step 4: Verify build still passes**

```bash
cd backend && npx prisma generate && npm run build
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/ backend/prisma/schema.prisma backend/openapi.yaml
git commit -m "chore: drop stale telnyx references and superseded AI-overflow plan"
```

---

### Task 2: SWML document builder (pure module, TDD)

**Files:**
- Create: `backend/src/services/swml/builder.ts`
- Create: `backend/src/services/swml/index.ts`
- Test: `backend/src/test/swml-builder.test.ts`

Rationale: SWML documents are pure data. Isolating the builder makes every document shape testable without HTTP, and gives route handlers a single shape source.

- [ ] **Step 1: Write the failing test file**

Create `backend/src/test/swml-builder.test.ts`:

```typescript
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
    assert.equal(connect.connect.to, '+15551234567');
});

test('swml-builder: transferSwml connects to SIP target when target is a SIP URI', () => {
    const doc = transferSwml({ to: 'sip:ai@elevenlabs.sip.signalwire.com', from: '+15559998888' });
    const main = doc.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, 'sip:ai@elevenlabs.sip.signalwire.com');
});

test('swml-builder: hangupSwml is minimal and valid', () => {
    const doc = hangupSwml();
    assert.equal(doc.version, '1.0.0');
    assert.ok(doc.sections.main.some((s: any) => s.hangup !== undefined));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx tsc --noEmit 2>&1 | head
```

Expected: TS errors reporting missing module `../services/swml/builder`.

- [ ] **Step 3: Implement the builder module**

Create `backend/src/services/swml/builder.ts`:

```typescript
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
```

- [ ] **Step 4: Create re-export barrel**

Create `backend/src/services/swml/index.ts`:

```typescript
export * from './builder';
```

- [ ] **Step 5: Run tests**

```bash
cd backend && npm test
```

Expected: `78 pass, 0 fail` (66 baseline + 12 new builder tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/swml/ backend/src/test/swml-builder.test.ts
git commit -m "feat(swml): add pure SWML document builder module with tests"
```

---

### Task 3: SWML dynamic endpoint routes (`/swml/*`)

**Files:**
- Create: `backend/src/routes/swml.ts`
- Test: `backend/src/test/swml-routes.test.ts`

These endpoints return `application/json` SWML documents. They perform side effects (DB writes, audit tracking) when necessary — e.g. `/swml/connect-agent` reserves an agent. The HTTP layer is thin; business logic stays in services.

- [ ] **Step 1: Write failing route tests**

Create `backend/src/test/swml-routes.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import swmlRoutes from '../routes/swml';

const app = express();
app.use(express.json());
app.use('/swml', swmlRoutes);

test('POST /swml/inbound returns JSON SWML document with IVR prompt', async () => {
    const res = await request(app)
        .post('/swml/inbound')
        .send({ call_id: 'test-call-1', from: '+15551112222', to: '+15553334444' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal(res.body.version, '1.0.0');
    assert.ok(Array.isArray(res.body.sections.main));
    assert.ok(res.body.sections.main.some((s: any) => s.prompt !== undefined));
});

test('POST /swml/ivr-action with digit=2 returns connect-agent request', async () => {
    const res = await request(app)
        .post('/swml/ivr-action')
        .send({ digit: '2', call_id: 'test-call-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.version, '1.0.0');
    const main = res.body.sections.main;
    assert.ok(main.some((s: any) => s.request !== undefined));
});

test('POST /swml/ivr-action with invalid digit hangs up', async () => {
    const res = await request(app)
        .post('/swml/ivr-action')
        .send({ digit: '9', call_id: 'test-call-3' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sections.main.some((s: any) => s.hangup !== undefined));
});

test('POST /swml/voicemail returns a record-then-hangup document', async () => {
    const res = await request(app).post('/swml/voicemail').send({ call_id: 'test-call-vm' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    assert.ok(main.some((s: any) => s.record !== undefined));
    assert.ok(main.some((s: any) => s.hangup !== undefined));
});

test('POST /swml/bridge returns a connect-with-record document', async () => {
    const res = await request(app)
        .post('/swml/bridge')
        .query({ to: '+15557776666', from: '+15559998888' })
        .send({ call_id: 'test-call-b' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, '+15557776666');
});

test('POST /swml/transfer returns a connect document targeting the query param', async () => {
    const res = await request(app)
        .post('/swml/transfer')
        .query({ to: 'sip:ai@example.sip.signalwire.com' })
        .send({ call_id: 'test-call-t' });
    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);
    assert.equal(connect.connect.to, 'sip:ai@example.sip.signalwire.com');
});

test('POST /swml/transfer with missing "to" returns hangup document (not 500)', async () => {
    const res = await request(app)
        .post('/swml/transfer')
        .send({ call_id: 'test-call-t2' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sections.main.some((s: any) => s.hangup !== undefined));
});
```

- [ ] **Step 2: Check supertest is available**

```bash
cd backend && node -e "require('supertest')" 2>&1
```

If errors, install: `npm install --save-dev supertest @types/supertest`.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd backend && npm test 2>&1 | grep -E "pass|fail|error" | head
```

Expected: failures for missing `../routes/swml` import.

- [ ] **Step 4: Implement the routes**

Create `backend/src/routes/swml.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { callAuditService } from '../services/call-audit';
import { callSessionService } from '../services/call-session-service';
import { prisma } from '../lib/prisma';
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

const router = Router();

const backendBase = (req: Request): string =>
    config.publicUrls.backend || `${req.protocol}://${req.get('host')}`;

const swmlUrl = (req: Request, path: string): string => `${backendBase(req)}${path}`;

const reserveAvailableAgent = async (): Promise<{ id: string; extension: string } | null> => {
    for (let i = 0; i < 5; i += 1) {
        const agent = await prisma.user.findFirst({
            where: {
                role: { in: ['agent', 'supervisor', 'admin'] },
                status: 'available',
            },
            select: { id: true, extension: true },
            orderBy: { updatedAt: 'asc' },
        });
        if (!agent) return null;
        const claim = await prisma.user.updateMany({
            where: { id: agent.id, status: 'available' },
            data: { status: 'on-call' },
        });
        if (claim.count === 1) {
            return { id: agent.id, extension: agent.extension || agent.id };
        }
    }
    return null;
};

const ensureInboundCallRecord = async (params: {
    callId?: string;
    fromNumber?: string;
    toNumber?: string;
    agentId?: string | null;
}): Promise<string | null> => {
    const callId = (params.callId || '').trim();
    if (!callId) return null;

    const existing = await prisma.call.findFirst({
        where: { signalwireCallId: callId },
        select: { id: true, agentId: true },
    });

    if (existing) {
        if (!existing.agentId && params.agentId) {
            await prisma.call.update({
                where: { id: existing.id },
                data: { agentId: params.agentId },
            });
            await callSessionService.syncCall(existing.id, {
                provider: 'signalwire',
                providerCallId: callId,
                mode: 'inbound',
                channel: 'human',
            });
        }
        return existing.id;
    }

    const { call } = await callSessionService.createUnifiedCall({
        provider: 'signalwire',
        channel: 'human',
        mode: 'inbound',
        direction: 'inbound',
        fromNumber: params.fromNumber || 'unknown',
        toNumber: params.toNumber || 'unknown',
        status: 'initiated',
        providerCallId: callId,
        agentId: params.agentId || null,
    });

    return call.id;
};

// POST /swml/inbound — entry point for inbound calls
router.post('/inbound', (req: Request, res: Response): void => {
    const { call_id, from, to } = req.body || {};
    void ensureInboundCallRecord({
        callId: call_id as string | undefined,
        fromNumber: from as string | undefined,
        toNumber: to as string | undefined,
    }).then((callId) => {
        void callAuditService.track({
            type: 'inbound.received',
            callId: callId || undefined,
            callSid: call_id as string | undefined,
            details: { fromNumber: from || 'unknown', toNumber: to || 'unknown' },
            source: 'signalwire.inbound',
        });
    });

    res.json(inboundIvrSwml({ actionUrl: swmlUrl(req, '/swml/ivr-action') }));
});

// POST /swml/ivr-action — branch on DTMF digit
router.post('/ivr-action', async (req: Request, res: Response): Promise<void> => {
    const { digit, call_id, from, to } = req.body || {};
    const callId = await ensureInboundCallRecord({
        callId: call_id as string | undefined,
        fromNumber: from as string | undefined,
        toNumber: to as string | undefined,
    });
    await callAuditService.track({
        type: 'inbound.ivr.selection',
        callId: callId || undefined,
        callSid: call_id as string | undefined,
        details: { digit: (digit || '').toString() || 'none' },
        source: 'signalwire.ivr_action',
    });

    res.json(ivrSelectionSwml({
        digit: (digit || '').toString(),
        connectAgentUrl: swmlUrl(req, '/swml/connect-agent'),
        voicemailUrl: swmlUrl(req, '/swml/voicemail'),
    }));
});

// POST /swml/connect-agent — reserve an agent and connect via SIP
router.post('/connect-agent', async (req: Request, res: Response): Promise<void> => {
    const { call_id, from, to } = req.body || {};
    const reserved = await reserveAvailableAgent();

    if (!reserved || !config.signalwire.spaceUrl) {
        res.json(queueHoldSwml({ voicemailUrl: swmlUrl(req, '/swml/voicemail') }));
        return;
    }

    const callId = await ensureInboundCallRecord({
        callId: call_id as string | undefined,
        fromNumber: from as string | undefined,
        toNumber: to as string | undefined,
        agentId: reserved.id,
    });

    await callAuditService.track({
        type: 'inbound.agent.reserved',
        callId: callId || undefined,
        callSid: call_id as string | undefined,
        details: { agentId: reserved.id, endpoint: reserved.extension },
        source: 'signalwire.connect_agent',
    });

    res.json(connectAgentSwml({
        extension: reserved.extension,
        spaceUrl: config.signalwire.spaceUrl,
        fallbackVoicemailUrl: swmlUrl(req, '/swml/voicemail'),
    }));
});

// POST /swml/queue-hold — queue hold music + overflow voicemail offer
router.post('/queue-hold', (req: Request, res: Response): void => {
    res.json(queueHoldSwml({ voicemailUrl: swmlUrl(req, '/swml/voicemail') }));
});

// POST /swml/voicemail — dedicated voicemail record entry
router.post('/voicemail', (_req: Request, res: Response): void => {
    res.json(voicemailSwml());
});

// POST /swml/bridge — outbound call bridges agent to destination
router.post('/bridge', (req: Request, res: Response): void => {
    const to = (req.query.to as string) || '';
    const from = (req.query.from as string) || '';
    if (!to) {
        res.json(hangupSwml('Destination number missing.'));
        return;
    }
    res.json(bridgeOutboundSwml({ to, from }));
});

// POST /swml/transfer — agent-initiated live-call transfer
router.post('/transfer', (req: Request, res: Response): void => {
    const to = (req.query.to as string) || '';
    const from = (req.query.from as string) || config.telephony.defaultOutboundNumber || undefined;
    if (!to) {
        logger.warn('swml.transfer: missing target, returning hangup');
        res.json(hangupSwml('Transfer target unavailable.'));
        return;
    }
    res.json(transferSwml({ to, from }));
});

export default router;
```

- [ ] **Step 5: Run tests until they pass**

```bash
cd backend && npm test
```

Expected: `85 pass, 0 fail` (78 prior + 7 new route tests).

If any test references `prisma.call.findFirst({ where: { signalwireCallId: ... } })` and fails because the column doesn't exist yet — that's expected at this point only if the test hits Prisma. The Supertest tests above use routes that call Prisma via `ensureInboundCallRecord`. If the test DB uses the old column name, either (a) proceed and accept that these specific tests will not pass until Task 7's migration, or (b) use Prisma mocks. Chosen approach: **inject a fake `ensureInboundCallRecord` in the test setup** by extracting it to a dependency before Task 3 implementation.

**Correction — update Step 4 implementation:** extract the DB helpers into a dependency object so tests can inject a fake. Revised structure:

```typescript
// Before the router construction:
export interface SwmlRouteDeps {
    ensureInboundCallRecord: typeof defaultEnsureInboundCallRecord;
    reserveAvailableAgent: typeof defaultReserveAvailableAgent;
    callAuditTrack: (...args: Parameters<typeof callAuditService.track>) => ReturnType<typeof callAuditService.track>;
}

export function createSwmlRouter(deps: SwmlRouteDeps = defaultDeps): Router {
    // ... router as above, but referencing deps.ensureInboundCallRecord etc.
}

// Default export wires the real deps
export default createSwmlRouter();
```

Update the test file to:

```typescript
import { createSwmlRouter } from '../routes/swml';

const noopTrack = async () => undefined;
const fakeEnsure = async () => 'fake-internal-call-id';
const fakeReserve = async () => ({ id: 'agent-1', extension: '1001' });

const app = express();
app.use(express.json());
app.use('/swml', createSwmlRouter({
    ensureInboundCallRecord: fakeEnsure,
    reserveAvailableAgent: fakeReserve,
    callAuditTrack: noopTrack,
}));
```

Rewrite Task 3 Step 1 (test) and Step 4 (implementation) with this dependency injection pattern before running Step 5.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/swml.ts backend/src/test/swml-routes.test.ts
git commit -m "feat(swml): add /swml/* dynamic document routes with injected dependencies"
```

---

### Task 4: SignalWire event webhook handler (JSON payloads)

**Files:**
- Create: `backend/src/routes/signalwire-events.ts`
- Test: `backend/src/test/signalwire-events.test.ts`

Accepts SignalWire status callbacks (JSON, not form-encoded) at `/signalwire/events/call-status`, `/signalwire/events/recording` — replacing the old form-encoded `/sw/call-status`, `/sw/recording-status`.

- [ ] **Step 1: Write failing tests**

Create `backend/src/test/signalwire-events.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

type Update = {
    provider: string;
    providerCallId: string;
    status: string;
    duration: number;
    answeredAt: Date | null;
    completedAt: Date | null;
};

const captured: { statusUpdates: Update[]; webhooksDispatched: Array<{ event: string; payload: unknown }>; recordingAttached: unknown[] } = {
    statusUpdates: [],
    webhooksDispatched: [],
    recordingAttached: [],
};

const fakeDeps = {
    callSessionUpdate: async (u: Update) => { captured.statusUpdates.push(u); },
    callSessionAddRecording: async (r: unknown) => { captured.recordingAttached.push(r); },
    dispatchWebhook: async (event: string, payload: unknown) => { captured.webhooksDispatched.push({ event, payload }); },
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaFindCallWithAttempt: async () => null,
    prismaFindCompletedCall: async () => null,
    releaseAgent: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
};

const app = express();
app.use(express.json());
app.use('/signalwire/events', createSignalwireEventsRouter(fakeDeps));

test('POST /signalwire/events/call-status "answered" maps to in-progress and dispatches call.answered', async () => {
    captured.statusUpdates = [];
    captured.webhooksDispatched = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({
            call_id: 'c-abc-123',
            call_state: 'answered',
            from: '+15551112222',
            to: '+15553334444',
            direction: 'outbound',
            timestamp: '2026-04-22T12:00:00Z',
        });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates.length, 1);
    assert.equal(captured.statusUpdates[0].status, 'in-progress');
    assert.equal(captured.statusUpdates[0].providerCallId, 'c-abc-123');
    assert.ok(captured.webhooksDispatched.some((w) => w.event === 'call.answered'));
});

test('POST /signalwire/events/call-status "ended" maps to completed and dispatches call.completed', async () => {
    captured.statusUpdates = [];
    captured.webhooksDispatched = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({
            call_id: 'c-xyz-999',
            call_state: 'ended',
            from: '+15551112222',
            to: '+15553334444',
            direction: 'outbound',
            timestamp: '2026-04-22T12:05:00Z',
            duration: 42,
        });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates[0].status, 'completed');
    assert.equal(captured.statusUpdates[0].duration, 42);
    assert.ok(captured.webhooksDispatched.some((w) => w.event === 'call.completed'));
});

test('POST /signalwire/events/call-status "ringing" does not dispatch call.answered', async () => {
    captured.webhooksDispatched = [];
    await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'c-r', call_state: 'ringing', from: '', to: '' });
    assert.equal(captured.webhooksDispatched.filter((w) => w.event === 'call.answered').length, 0);
});

test('POST /signalwire/events/call-status with missing call_id returns 200 and no-ops', async () => {
    captured.statusUpdates = [];
    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_state: 'answered' });
    assert.equal(res.status, 200);
    assert.equal(captured.statusUpdates.length, 0);
});

test('POST /signalwire/events/recording attaches recording URL', async () => {
    captured.recordingAttached = [];
    const res = await request(app)
        .post('/signalwire/events/recording')
        .send({
            call_id: 'c-rec-1',
            state: 'finished',
            url: 'https://example.test/recordings/abc.mp3',
            duration: 90,
        });
    assert.equal(res.status, 200);
    assert.equal(captured.recordingAttached.length, 1);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd backend && npm test
```

Expected: module-not-found errors for `../routes/signalwire-events`.

- [ ] **Step 3: Implement the event router**

Create `backend/src/routes/signalwire-events.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { webhookEngine } from '../services/webhook-engine';
import { callSessionService } from '../services/call-session-service';
import { callAuditService } from '../services/call-audit';
import { crmAdapter } from '../services/crm-adapter';
import { campaignReservationService } from '../services/campaign-reservation-service';
import { logger } from '../utils/logger';

// Map SignalWire's call_state to our internal status enum.
// SignalWire states: queued, created, ringing, answered, ended.
// Internal enum (unchanged): initiated, ringing, in-progress, completed, failed, no-answer, busy, voicemail.
const SIGNALWIRE_STATE_MAP: Record<string, string> = {
    queued: 'initiated',
    created: 'initiated',
    ringing: 'ringing',
    answered: 'in-progress',
    ended: 'completed',
};

const TERMINAL_STATES = new Set(['completed', 'failed', 'no-answer', 'busy']);

export interface SignalwireEventsDeps {
    callSessionUpdate: typeof defaultCallSessionUpdate;
    callSessionAddRecording: typeof defaultAddRecording;
    dispatchWebhook: typeof defaultDispatchWebhook;
    auditTrack: typeof defaultAuditTrack;
    prismaUpdateCall: typeof defaultPrismaUpdateCall;
    prismaFindCallWithAttempt: typeof defaultFindCallWithAttempt;
    prismaFindCompletedCall: typeof defaultFindCompletedCall;
    releaseAgent: typeof defaultReleaseAgent;
    crmPostCallEvent: typeof defaultCrmPostCallEvent;
    reservationComplete: typeof defaultReservationComplete;
}

async function defaultCallSessionUpdate(params: {
    provider: string;
    providerCallId: string;
    status: string;
    duration: number;
    answeredAt: Date | null;
    completedAt: Date | null;
}) {
    await callSessionService.updateProviderStatus(params);
}

async function defaultAddRecording(params: {
    provider: string;
    providerCallId: string;
    callId?: string;
    url: string;
    status: string;
}) {
    await callSessionService.addRecording(params);
}

async function defaultDispatchWebhook(event: string, payload: unknown) {
    await webhookEngine.dispatch(event, payload);
}

async function defaultAuditTrack(params: Parameters<typeof callAuditService.track>[0]) {
    await callAuditService.track(params);
}

async function defaultPrismaUpdateCall(callId: string, data: Record<string, unknown>) {
    await prisma.call.updateMany({
        where: { signalwireCallId: callId },
        data,
    });
}

async function defaultFindCallWithAttempt(callId: string) {
    return prisma.call.findFirst({
        where: { signalwireCallId: callId },
        select: {
            id: true,
            agentId: true,
            accountId: true,
            campaignAttempts: {
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: {
                    id: true,
                    contactId: true,
                    campaignId: true,
                    contact: {
                        select: {
                            id: true,
                            attemptCount: true,
                            campaign: { select: { maxAttemptsPerLead: true, retryDelaySeconds: true } },
                        },
                    },
                },
            },
        },
    });
}

async function defaultFindCompletedCall(callId: string) {
    return prisma.call.findFirst({
        where: { signalwireCallId: callId },
        select: { agentId: true, id: true, accountId: true },
    });
}

async function defaultReleaseAgent(agentId: string) {
    await prisma.user.updateMany({ where: { id: agentId }, data: { status: 'available' } });
}

async function defaultCrmPostCallEvent(payload: Parameters<typeof crmAdapter.postCallEvent>[0]) {
    await crmAdapter.postCallEvent(payload);
}

async function defaultReservationComplete(contactId: string, status: string, retryAt: Date | null) {
    await campaignReservationService.completeReservation(contactId, status, retryAt);
}

const defaultDeps: SignalwireEventsDeps = {
    callSessionUpdate: defaultCallSessionUpdate,
    callSessionAddRecording: defaultAddRecording,
    dispatchWebhook: defaultDispatchWebhook,
    auditTrack: defaultAuditTrack,
    prismaUpdateCall: defaultPrismaUpdateCall,
    prismaFindCallWithAttempt: defaultFindCallWithAttempt,
    prismaFindCompletedCall: defaultFindCompletedCall,
    releaseAgent: defaultReleaseAgent,
    crmPostCallEvent: defaultCrmPostCallEvent,
    reservationComplete: defaultReservationComplete,
};

export function createSignalwireEventsRouter(deps: SignalwireEventsDeps = defaultDeps): Router {
    const router = Router();

    // POST /signalwire/events/call-status — JSON body per SignalWire REST spec
    router.post('/call-status', async (req: Request, res: Response): Promise<void> => {
        const { call_id, call_state, duration } = req.body || {};
        if (!call_id || typeof call_id !== 'string') {
            res.status(200).json({ status: 'ignored', reason: 'missing_call_id' });
            return;
        }

        const mappedStatus = SIGNALWIRE_STATE_MAP[call_state as string] || (call_state as string) || 'unknown';
        const durationSec = typeof duration === 'number' ? duration : parseInt(duration || '0', 10);

        await deps.auditTrack({
            type: 'call.status',
            callSid: call_id,
            details: { status: mappedStatus, duration: durationSec },
            source: 'signalwire.call_status',
            status: mappedStatus,
            idempotencyKey: `signalwire:${call_id}:status:${mappedStatus}:${durationSec}`,
        });

        await deps.callSessionUpdate({
            provider: 'signalwire',
            providerCallId: call_id,
            status: mappedStatus,
            duration: durationSec,
            answeredAt: mappedStatus === 'in-progress' ? new Date() : null,
            completedAt: TERMINAL_STATES.has(mappedStatus) ? new Date() : null,
        });

        await deps.prismaUpdateCall(call_id, {
            status: mappedStatus,
            duration: durationSec,
            ...(TERMINAL_STATES.has(mappedStatus) ? { completedAt: new Date() } : {}),
        });

        const withAttempt = await deps.prismaFindCallWithAttempt(call_id);
        const attempt = withAttempt?.campaignAttempts?.[0];
        if (attempt) {
            if (mappedStatus === 'ringing' || mappedStatus === 'in-progress') {
                await prisma.campaignAttempt.update({
                    where: { id: attempt.id },
                    data: {
                        status: mappedStatus,
                        ...(mappedStatus === 'in-progress' ? { outcome: 'human' } : {}),
                    },
                });
            }
            if (TERMINAL_STATES.has(mappedStatus)) {
                const outcomeMap: Record<string, string> = {
                    completed: 'human',
                    failed: 'failed',
                    'no-answer': 'no-answer',
                    busy: 'busy',
                };
                await prisma.campaignAttempt.update({
                    where: { id: attempt.id },
                    data: {
                        status: mappedStatus,
                        outcome: outcomeMap[mappedStatus] || mappedStatus,
                        completedAt: new Date(),
                    },
                });
                const maxAttempts = attempt.contact.campaign.maxAttemptsPerLead;
                const retryMs = Math.max(30, attempt.contact.campaign.retryDelaySeconds) * 1000;
                const exhausted = attempt.contact.attemptCount >= maxAttempts;
                const nextContactStatus = mappedStatus === 'completed' ? 'completed' : exhausted ? 'failed' : 'queued';
                await deps.reservationComplete(
                    attempt.contactId,
                    nextContactStatus,
                    nextContactStatus === 'queued' ? new Date(Date.now() + retryMs) : null,
                );
            }
        }

        if (TERMINAL_STATES.has(mappedStatus)) {
            const completed = await deps.prismaFindCompletedCall(call_id);
            if (completed?.agentId) {
                await deps.releaseAgent(completed.agentId);
            }
            if (completed?.id) {
                await deps.crmPostCallEvent({
                    event_type: 'call.completed',
                    call_id: completed.id,
                    provider: 'signalwire',
                    provider_call_id: call_id,
                    status: mappedStatus,
                    duration: durationSec,
                    account_id: completed.accountId || null,
                });
            }
        }

        if (mappedStatus === 'in-progress') {
            await deps.dispatchWebhook('call.answered', { callId: call_id, status: mappedStatus });
        } else if (mappedStatus === 'completed') {
            await deps.dispatchWebhook('call.completed', { callId: call_id, status: mappedStatus, duration: durationSec });
        }

        res.status(200).json({ status: 'ok' });
    });

    // POST /signalwire/events/recording — recording completion
    router.post('/recording', async (req: Request, res: Response): Promise<void> => {
        const { call_id, url, state } = req.body || {};
        if (!call_id || !url) {
            res.status(200).json({ status: 'ignored' });
            return;
        }
        try {
            await deps.prismaUpdateCall(call_id, { recordingUrl: url });
            await deps.callSessionAddRecording({
                provider: 'signalwire',
                providerCallId: call_id,
                url,
                status: state === 'finished' ? 'available' : 'pending',
            });
            await deps.auditTrack({
                type: 'call.recording.ready',
                callSid: call_id,
                details: { recordingUrl: url },
                source: 'signalwire.recording',
            });
            logger.info('Recording URL saved', { callId: call_id });
        } catch (err) {
            logger.error('Failed to persist recording', { error: err, call_id });
        }
        res.status(200).json({ status: 'ok' });
    });

    return router;
}

export default createSignalwireEventsRouter();
```

- [ ] **Step 4: Run tests**

```bash
cd backend && npm test
```

Expected: `90 pass, 0 fail` (85 prior + 5 new event tests).

Note: the implementation accesses `prisma.campaignAttempt.update` directly (not injected). For the test to pass without mocking Prisma, the fake test ensures `prismaFindCallWithAttempt` returns `null`, so the attempt branch is skipped. If additional test coverage of the attempt branch is desired, that would be a follow-up PR.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/signalwire-events.ts backend/src/test/signalwire-events.test.ts
git commit -m "feat(signalwire): add /signalwire/events webhook handlers for JSON payloads"
```

---

### Task 5: Rewrite `signalwire.ts` service to use REST + SWML

**Files:**
- Modify: `backend/src/services/signalwire.ts` (full rewrite)
- Modify: `backend/src/services/providers/types.ts` (remove `redirectLiveCall` from the interface)
- Modify: `backend/src/services/mock-telephony.ts` (remove `redirectLiveCall` impl)
- Test: `backend/src/test/signalwire-service.test.ts`

- [ ] **Step 1: Write failing tests for rewritten service**

Create `backend/src/test/signalwire-service.test.ts`:

```typescript
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SignalWireService } from '../services/signalwire';

type FetchMock = (url: string, init?: any) => Promise<Response>;

function makeFetch(handler: FetchMock) {
    return mock.fn(handler) as unknown as typeof fetch;
}

function makeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const config = {
    projectId: 'test-project',
    apiToken: 'test-token',
    spaceUrl: 'test.signalwire.com',
    allowSubscriberProvisioning: false,
};

test('initiateOutboundCall posts to /api/calling/calls with dial command', async () => {
    const fetchMock = mock.fn(async (url: string, init?: any) => {
        assert.equal(url, 'https://test.signalwire.com/api/calling/calls');
        const body = JSON.parse(init.body);
        assert.equal(body.command, 'dial');
        assert.equal(body.params.to, '+15551234567');
        assert.equal(body.params.from, '+15559998888');
        assert.equal(body.params.caller_id, '+15559998888');
        assert.match(body.params.url, /\/swml\/bridge/);
        assert.match(body.params.status_url, /\/signalwire\/events\/call-status/);
        return makeResponse(200, { call_id: 'c-new-1', status: 'queued' });
    });

    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15559998888',
        toNumber: '+15551234567',
        agentId: 'agent-alice',
        callbackUrl: 'https://backend.test',
    });

    assert.ok(result);
    assert.equal(result!.providerCallId, 'c-new-1');
    assert.equal(result!.provider, 'signalwire');
    assert.equal(fetchMock.mock.calls.length, 1);
});

test('initiateOutboundCall returns null on non-2xx', async () => {
    const fetchMock = mock.fn(async () => makeResponse(422, { error: 'invalid_caller_id' }));
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://backend.test',
    });
    assert.equal(result, null);
});

test('transferCall updates live call to fetch /swml/transfer document', async () => {
    const fetchMock = mock.fn(async (url: string, init?: any) => {
        // Modern transfer is done by issuing a new command against the existing call_id.
        // Acceptable patterns: POST /api/calling/calls with {command: "update", call_id, params: {url}}
        // OR: POST /api/calling/calls/{call_id} with {params: {url}}
        // Whichever pattern the implementation picks must include the call_id and a swml url.
        const body = JSON.parse(init.body);
        const callIdInPath = url.includes('/c-live-1');
        const callIdInBody = body.call_id === 'c-live-1';
        assert.ok(callIdInPath || callIdInBody, 'request references the call_id');
        const swmlUrl = body.params?.url || body.url;
        assert.match(swmlUrl, /\/swml\/transfer/);
        assert.match(swmlUrl, /to=/);
        return makeResponse(200, { call_id: 'c-live-1', status: 'updated' });
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const ok = await svc.transferCall('c-live-1', '+15557776666', 'https://backend.test');
    assert.equal(ok, true);
});

test('transferCall returns false on failure', async () => {
    const fetchMock = mock.fn(async () => makeResponse(404, { error: 'call_not_found' }));
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const ok = await svc.transferCall('c-missing', '+15557776666', 'https://backend.test');
    assert.equal(ok, false);
});

test('generateBrowserToken calls fabric subscriber tokens endpoint and returns JWT', async () => {
    const fetchMock = mock.fn(async (url: string) => {
        if (url.endsWith('/api/fabric/subscribers/tokens')) {
            return makeResponse(200, { token: 'sat-jwt-abc' });
        }
        return makeResponse(404, {});
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.generateBrowserToken('agent-1', 'Agent One', 'a@x.test', 'ext-1001');
    assert.equal(result.token, 'sat-jwt-abc');
});

test('generateRelayJwt calls /api/relay/rest/jwt and returns jwt_token', async () => {
    const fetchMock = mock.fn(async (url: string) => {
        assert.ok(url.endsWith('/api/relay/rest/jwt'));
        return makeResponse(200, { jwt_token: 'relay-jwt-xyz' });
    });
    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.generateRelayJwt('sip:1001');
    assert.equal(result.token, 'relay-jwt-xyz');
});

test('unconfigured service returns mock call id without calling fetch', async () => {
    const fetchMock = mock.fn(async () => { throw new Error('should not be called'); });
    const svc = new SignalWireService({ ...config, projectId: '' }, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.initiateOutboundCall({
        fromNumber: '+15551112222',
        toNumber: '+15553334444',
        callbackUrl: 'https://backend.test',
    });
    assert.ok(result);
    assert.match(result!.providerCallId, /^mock-call-/);
    assert.equal(fetchMock.mock.calls.length, 0);
});
```

- [ ] **Step 2: Decide transfer endpoint shape (research spike, ~15 min)**

Run: `curl -s -u $SIGNALWIRE_PROJECT_ID:$SIGNALWIRE_API_TOKEN "https://${SIGNALWIRE_SPACE_URL}/api/calling/calls" -X POST -H 'Content-Type: application/json' -d '{"command":"update","call_id":"nonexistent","params":{"url":"https://x.test"}}'`

Expected outcomes:
- `404 not_found` (call doesn't exist, but command is recognized) → pattern **A** valid: `POST /api/calling/calls` with `{command: "update", call_id, params: {url}}`
- `400 unknown_command` → pattern **B** required: `POST /api/calling/calls/{call_id}` with `{params: {url}}`
- Other → escalate to user with response body before continuing.

Record the chosen pattern in a code comment above the method and implement accordingly. If neither works, the fallback is to use the Relay SDK for live-call transfer and raise that as a deviation from the "no SDK" rule, requiring user sign-off before proceeding.

Note: Without a SignalWire account configured in dev, this step may need to be deferred to whenever the worktree hits a configured environment. In that case, implement **pattern A** (most idiomatic per the skill docs) and treat the task as "verified by unit test, awaiting live integration check".

- [ ] **Step 3: Rewrite `backend/src/services/signalwire.ts`**

Replace the file contents with:

```typescript
import { config } from '../config';
import { logger } from '../utils/logger';
import {
    BrowserTokenResult,
    OutboundCallRequest,
    OutboundCallResult,
    TelephonyProvider,
} from './providers/types';

export interface SignalWireServiceConfig {
    projectId: string;
    apiToken: string;
    spaceUrl: string;
    allowSubscriberProvisioning: boolean;
}

export interface SignalWireServiceDeps {
    fetch: typeof fetch;
}

const defaultDeps: SignalWireServiceDeps = { fetch: globalThis.fetch };

export class SignalWireService implements TelephonyProvider {
    readonly name = 'signalwire';

    private projectId: string;
    private apiToken: string;
    private spaceUrl: string;
    private allowProvisioning: boolean;
    private fetchImpl: typeof fetch;

    constructor(cfg?: Partial<SignalWireServiceConfig>, deps: SignalWireServiceDeps = defaultDeps) {
        this.projectId = cfg?.projectId ?? config.signalwire.projectId;
        this.apiToken = cfg?.apiToken ?? config.signalwire.apiToken;
        this.spaceUrl = cfg?.spaceUrl ?? config.signalwire.spaceUrl;
        this.allowProvisioning = cfg?.allowSubscriberProvisioning ?? config.signalwire.allowSubscriberProvisioning;
        this.fetchImpl = deps.fetch;
    }

    get isConfigured(): boolean {
        return !!(this.projectId && this.apiToken && this.spaceUrl);
    }

    private get authHeader(): string {
        return 'Basic ' + Buffer.from(`${this.projectId}:${this.apiToken}`).toString('base64');
    }

    private get baseUrl(): string {
        return `https://${this.spaceUrl}`;
    }

    // ── Tokens ─────────────────────────────────────────────────────────────
    async generateRelayJwt(resource: string, expiresInMinutes = 15): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            return { token: null, error: 'signalwire_not_configured' };
        }
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/relay/rest/jwt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({ resource, expires_in: expiresInMinutes }),
            });
            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire relay JWT failed', { status: response.status, body: bodyText });
                return {
                    token: null,
                    error: `relay_jwt_failed_${response.status}`,
                    metadata: { provider: this.name, resource, responseStatus: response.status, responseBody: bodyText },
                };
            }
            const data = (await response.json()) as { jwt_token?: string };
            return { token: data.jwt_token || null, metadata: { provider: this.name, resource, transport: 'relay-v2' } };
        } catch (err) {
            logger.error('SignalWire relay JWT error', { error: err });
            return { token: null, error: 'relay_jwt_exception' };
        }
    }

    private async requestSubscriberToken(reference: string): Promise<BrowserTokenResult> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference }),
        });
        if (response.ok) {
            const data = (await response.json()) as { token?: string };
            return {
                token: data.token || null,
                metadata: { provider: this.name, spaceUrl: this.spaceUrl, endpointReference: reference, reusedSubscriber: true },
            };
        }
        const errBody = await response.text();
        logger.warn('SignalWire SAT generation failed', { status: response.status, body: errBody, reference });
        if (errBody.includes('insufficient_balance')) {
            return { token: null, error: 'insufficient_balance' };
        }
        return {
            token: null,
            error: `sat_generation_failed_${response.status}`,
            metadata: { provider: this.name, endpointReference: reference, responseStatus: response.status, responseBody: errBody },
        };
    }

    private async createSubscriber(reference: string, agentName: string, email: string): Promise<{ ok: boolean; error?: string }> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/fabric/subscribers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({ reference, name: agentName, email }),
        });
        if (response.ok || response.status === 409 || response.status === 422) {
            return { ok: true };
        }
        const errBody = await response.text();
        logger.error('SignalWire fabric subscriber create failed', { status: response.status, body: errBody, reference });
        return { ok: false, error: `subscriber_create_failed_${response.status}` };
    }

    async generateBrowserToken(
        agentId: string,
        agentName: string,
        agentEmail?: string,
        endpointReference?: string,
    ): Promise<BrowserTokenResult> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock browser token');
            return {
                token: `mock-browser-token-${endpointReference || agentId}`,
                metadata: { provider: this.name, endpointReference: endpointReference || agentId },
            };
        }

        try {
            const reference = endpointReference || agentId;
            const existing = await this.requestSubscriberToken(reference);
            if (existing.token) return existing;

            if (!this.allowProvisioning) {
                logger.warn('SignalWire subscriber provisioning blocked', { agentId, reference });
                return {
                    token: null,
                    error: 'subscriber_provisioning_disabled',
                    metadata: { provider: this.name, endpointReference: reference, existingSubscriberReuseAttempted: true },
                };
            }

            const email = agentEmail || `${agentId}@users.elitedial.local`;
            const create = await this.createSubscriber(reference, agentName, email);
            if (!create.ok) return { token: null, error: create.error || 'subscriber_create_failed' };

            const created = await this.requestSubscriberToken(reference);
            if (created.token) {
                return { ...created, metadata: { ...(created.metadata || {}), reusedSubscriber: false, subscriberCreated: true } };
            }
            return created;
        } catch (err) {
            logger.error('SignalWire token generation error', { error: err });
            return { token: null, error: 'token_generation_exception' };
        }
    }

    // ── Call origination ───────────────────────────────────────────────────
    async initiateOutboundCall(params: OutboundCallRequest): Promise<OutboundCallResult | null> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; returning mock call id');
            return { provider: this.name, providerCallId: `mock-call-${Date.now()}`, raw: params.metadata };
        }

        try {
            const swmlUrl = `${params.callbackUrl}/swml/bridge?to=${encodeURIComponent(params.toNumber)}&from=${encodeURIComponent(params.fromNumber)}`;
            const statusUrl = `${params.callbackUrl}/signalwire/events/call-status`;

            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'dial',
                    params: {
                        from: params.fromNumber,
                        to: params.toNumber,
                        caller_id: params.fromNumber,
                        url: swmlUrl,
                        status_url: statusUrl,
                    },
                }),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire call initiation failed', { status: response.status, body: bodyText });
                return null;
            }

            const data = (await response.json()) as { call_id?: string };
            return {
                provider: this.name,
                providerCallId: data.call_id || '',
                raw: { callbackUrl: params.callbackUrl },
            };
        } catch (err) {
            logger.error('SignalWire call initiation error', { error: err });
            return null;
        }
    }

    // ── Live-call update ──────────────────────────────────────────────────
    // Pattern A: POST /api/calling/calls with {command: "update", call_id, params: {url}}
    // Confirmed via research spike (see plan Task 5 Step 2). If not supported, switch
    // to pattern B (POST /api/calling/calls/{call_id}) and document.
    async transferCall(providerCallId: string, targetNumber: string, callbackUrl: string): Promise<boolean> {
        if (!this.isConfigured) {
            logger.warn('SignalWire not configured; mock transfer succeeded');
            return true;
        }

        try {
            const swmlUrl = `${callbackUrl}/swml/transfer?to=${encodeURIComponent(targetNumber)}`;
            const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
                body: JSON.stringify({
                    command: 'update',
                    call_id: providerCallId,
                    params: { url: swmlUrl },
                }),
            });
            if (!response.ok) {
                const bodyText = await response.text();
                logger.error('SignalWire transferCall failed', { providerCallId, status: response.status, body: bodyText });
                return false;
            }
            return true;
        } catch (err) {
            logger.error('SignalWire transferCall error', { providerCallId, error: err });
            return false;
        }
    }
}

export const signalwireService = new SignalWireService();
```

- [ ] **Step 4: Drop `redirectLiveCall` from the provider interface**

Edit `backend/src/services/providers/types.ts`. Remove these lines:

```typescript
export interface RedirectCallRequest {
    providerCallId: string;
    callbackUrl: string;
}
```

…and the `redirectLiveCall?(request: RedirectCallRequest): Promise<boolean>;` line from `TelephonyProvider`.

- [ ] **Step 5: Drop `redirectLiveCall` from mock**

Edit `backend/src/services/mock-telephony.ts`. Remove the `redirectLiveCall` method entirely. Remove any now-unused imports.

- [ ] **Step 6: Run tests + build**

```bash
cd backend && npm run build && npm test
```

Expected: build green; `97 pass, 0 fail` (90 prior + 7 new service tests).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/signalwire.ts backend/src/services/providers/types.ts backend/src/services/mock-telephony.ts backend/src/test/signalwire-service.test.ts
git commit -m "feat(signalwire): rewrite service to use REST /api/calling/calls + SWML URLs"
```

---

### Task 6: Remove old `webhooks.ts` router; mount new routers

**Files:**
- Delete: `backend/src/routes/webhooks.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/system.ts` (advertise new webhook URLs)
- Modify: `backend/src/config.ts` (delete unused `config.ai.*` and `config.amd.*`)
- Modify: `.env.example` (drop AMD/AI_TRANSFER vars)

- [ ] **Step 1: Delete old router**

```bash
rm backend/src/routes/webhooks.ts
```

- [ ] **Step 2: Update `backend/src/index.ts`**

Change line 20 from:

```typescript
import webhookRoutes from './routes/webhooks';
```

to:

```typescript
import swmlRoutes from './routes/swml';
import signalwireEventsRoutes from './routes/signalwire-events';
```

Change line 94 from:

```typescript
app.use('/sw', webhookRoutes);
```

to:

```typescript
app.use('/swml', swmlRoutes);
app.use('/signalwire/events', signalwireEventsRoutes);
```

- [ ] **Step 3: Update `backend/src/routes/system.ts`**

Find the object at lines 91–99 advertising SignalWire webhook URLs. Replace the entire block with:

```typescript
                browserTokenCapable: signalwireService.isConfigured,
                spaceUrl: config.signalwire.spaceUrl || null,
                webhookUrls: {
                    inbound: `${backendBaseUrl}/swml/inbound`,
                    callStatus: `${backendBaseUrl}/signalwire/events/call-status`,
                    recording: `${backendBaseUrl}/signalwire/events/recording`,
                },
```

Remove `amdWebhookUrl` and `transcriptionWebhookUrl` references (no longer applicable under the new design).

- [ ] **Step 4: Delete unused config**

Open `backend/src/config.ts`. Remove:
- The `ai:` block (lines 54–57).
- The `amd:` block (lines 58–66).
- The `isAiTransferConfigured` getter (lines 77–79).

Do NOT remove `retell` or `signalwire` config.

Search for any remaining callers:

```bash
grep -rn "config\.ai\b\|config\.amd\b\|isAiTransferConfigured" backend/src --include='*.ts'
```

Remove or fix each caller. If a caller is in a file not otherwise touched by this task, stop and resolve it (likely means a dead path that should be pruned or a live path that needs replacement).

- [ ] **Step 5: Update `.env.example`**

Remove these keys if present:
```
AMD_ENABLED
AMD_MODE
AMD_TIMEOUT_MS
AMD_SPEECH_THRESHOLD_MS
AMD_SPEECH_END_THRESHOLD_MS
AMD_SILENCE_TIMEOUT_MS
AMD_ASYNC
AI_TRANSFER_TARGET
AI_TRANSFER_ENABLED
```

- [ ] **Step 6: Run build + tests**

```bash
cd backend && npm run build && npm test
```

Expected: build green, `97 pass, 0 fail`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts backend/src/routes/system.ts backend/src/config.ts backend/.env.example backend/src/routes/webhooks.ts
git commit -m "refactor: remove /sw/* LaML router and AMD/AI-transfer config"
```

Note on the `rm`'d file: `git add` of a deleted path stages the deletion. If that fails, use `git rm backend/src/routes/webhooks.ts` explicitly.

---

### Task 7: Prisma column rename `signalwireCallSid` → `signalwireCallId`

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Generate: `backend/prisma/migrations/<timestamp>_rename_signalwire_call_id/migration.sql`
- Modify: any remaining callers of the old field name

- [ ] **Step 1: Grep for callers**

```bash
grep -rn "signalwireCallSid" backend/src --include='*.ts'
```

Expected remaining callers after Task 4 rewrote the event handler (which already used `signalwireCallId`): route handlers and services that still query/update on the old name.

Target list (from the pre-rewrite codebase; verify against current tree):
- `backend/src/services/call-session-service.ts`
- `backend/src/services/call-audit.ts`
- Other services that persist the SID field during call creation.

- [ ] **Step 2: Update schema.prisma**

Open `backend/prisma/schema.prisma`. Rename the field:

```prisma
  signalwireCallId String?
```

(Remove the old `signalwireCallSid String?` line; no `@map` needed because the column name follows from the field name.)

- [ ] **Step 3: Generate Prisma migration**

```bash
cd backend && npx prisma migrate dev --name rename_signalwire_call_sid
```

If the command complains about needing a shadow database in dev, use `prisma migrate diff` instead:

```bash
npx prisma migrate diff --from-schema-datamodel backend/prisma/schema.prisma.bak --to-schema-datamodel backend/prisma/schema.prisma --script > backend/prisma/migrations/<timestamp>_rename_signalwire_call_id/migration.sql
```

The migration SQL must be:

```sql
ALTER TABLE "Call" RENAME COLUMN "signalwireCallSid" TO "signalwireCallId";
```

For SQLite/dev environments, this may require a `DROP INDEX` / `CREATE INDEX` pair if an index references the old column name — verify by inspecting the generated migration. Adjust manually if Prisma produces a destructive table-recreate script (SQLite sometimes does).

- [ ] **Step 4: Run `prisma generate`**

```bash
cd backend && npx prisma generate
```

- [ ] **Step 5: Fix remaining TypeScript callers**

Run:

```bash
cd backend && npx tsc --noEmit 2>&1 | grep signalwireCallSid
```

For each error, rename the property reference from `signalwireCallSid` to `signalwireCallId`. Common patterns:

```typescript
// Before
where: { signalwireCallSid: callSid }
// After
where: { signalwireCallId: callId }
```

```typescript
// Before
data: { signalwireCallSid: providerCallId, ... }
// After
data: { signalwireCallId: providerCallId, ... }
```

Keep local variable names descriptive to context; don't mass-rename `callSid` → `callId` unless the variable is specifically the SignalWire call identifier (in which case, do rename for clarity).

- [ ] **Step 6: Run build + tests**

```bash
cd backend && npm run build && npm test
```

Expected: build green, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/ backend/src/
git commit -m "refactor(db): rename signalwireCallSid column to signalwireCallId"
```

---

### Task 8: Verification pass

**Files:** None modified; exploratory verification.

- [ ] **Step 1: Full build + tests**

```bash
cd backend && npm run build && npm test
```

Expected: exit 0, 0 failures.

- [ ] **Step 2: Hit SWML endpoints with curl (local dev server)**

```bash
cd backend && npm run dev &
SERVER_PID=$!
sleep 3

curl -s -X POST http://localhost:5000/swml/inbound \
    -H 'Content-Type: application/json' \
    -d '{"call_id":"test-1","from":"+15551112222","to":"+15553334444"}' | jq

curl -s -X POST http://localhost:5000/swml/ivr-action \
    -H 'Content-Type: application/json' \
    -d '{"digit":"2","call_id":"test-2"}' | jq

curl -s -X POST "http://localhost:5000/swml/bridge?to=%2B15557776666&from=%2B15559998888" \
    -H 'Content-Type: application/json' \
    -d '{"call_id":"test-3"}' | jq

curl -s -X POST http://localhost:5000/signalwire/events/call-status \
    -H 'Content-Type: application/json' \
    -d '{"call_id":"c-live-1","call_state":"answered","from":"+1","to":"+1","direction":"outbound"}' | jq

kill $SERVER_PID
```

Expected: every SWML response is `{"version":"1.0.0","sections":{"main":[...]}}`. Event endpoint returns `{"status":"ok"}`.

- [ ] **Step 3: Verify no references to the old surface remain**

```bash
grep -rn "/sw/\|text/xml\|<Response>\|<Gather\|<Dial\|TwiML\|LaML\|telnyx" backend/src --include='*.ts'
```

Expected: no matches. (Some comments in tests referencing "LaML removed" are acceptable if present; audit each.)

- [ ] **Step 4: OpenAPI consistency spot-check**

Open `backend/openapi.yaml`. Confirm:
- `provider` enum no longer lists `telnyx`.
- The `signalwireCallSid` field has been renamed to `signalwireCallId` if the Call schema exposes it. Search and fix if needed.

- [ ] **Step 5: Commit any doc fixes found during verification**

```bash
git add -A
git diff --cached  # review
git commit -m "chore: post-migration verification fixes" --allow-empty-message || echo "nothing to commit"
```

(Allow empty commit is only an escape hatch; only commit real changes.)

---

### Task 9: Add `CLAUDE.md` to codify invariants

**Files:**
- Create: `CLAUDE.md`

Prevents future drift back toward LaML patterns.

- [ ] **Step 1: Write `CLAUDE.md`**

Create at the repo root:

```markdown
# EliteDial Architectural Rules

## Telephony provider: SignalWire REST + SWML

**Do NOT use LaML or TwiML XML in this repo.** The telephony layer is built on:
- `POST /api/calling/calls` (JSON) for call origination and live-call updates.
- SWML (YAML/JSON documents) for call-flow control, served dynamically from Express at `/swml/*`.
- JSON webhooks at `/signalwire/events/*` for call-status and recording callbacks.

If you find yourself writing `<Response>`, `<Dial>`, `<Gather>`, `<Say>`, or returning `text/xml` from an Express route, stop — that's the deprecated LaML path. Every call-flow change goes through `backend/src/services/swml/builder.ts` (pure functions that return SWML documents).

## Provider abstraction

`TelephonyProvider` in `backend/src/services/providers/types.ts` is the provider-neutral interface. New providers implement it. Production uses `signalwireService` via `provider-registry.ts`.

Mock telephony (`mock-telephony.ts`) is used when `SIGNALWIRE_PROJECT_ID` is unset; it returns deterministic fake IDs so the rest of the system can run in dev without live credentials.

## Webhook body parsing

SignalWire's modern REST webhooks are JSON. `express.json()` is mounted globally. Never re-introduce `text/xml` or `application/x-www-form-urlencoded` handlers under `/signalwire/events/*` or `/swml/*`.

## SignalWire Dashboard configuration

The SignalWire phone number's voice webhook URL must point at `https://<backend>/swml/inbound` (method: POST). The `status_url` for outbound calls is set per-call at origination — do not configure a default in the dashboard.

## When adding new call flows

1. Add a pure builder function in `backend/src/services/swml/builder.ts` with tests.
2. Add a route in `backend/src/routes/swml.ts` that returns the builder's output.
3. Never embed SWML JSON literals in route handlers — they go in the builder.
4. Never redirect calls by returning XML — use the `request:` SWML verb to chain, or the REST `{command: "update"}` pattern for out-of-band updates.

## Testing

Tests mock `fetch` (injected via service constructor) and inject Prisma-adjacent dependencies through route factory functions. Never hit real SignalWire endpoints from tests. Never depend on a running SignalWire space for the test suite.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md codifying SWML/REST architectural rules"
```

---

### Task 10: Merge worktree back to main

**Files:** None changed by this task; it's a merge operation.

- [ ] **Step 1: Final verification in worktree**

```bash
cd backend && npm run build && npm test
```

Expected: exit 0, all green.

- [ ] **Step 2: Switch to main in the primary checkout and merge**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git status  # must be clean
git merge --no-ff swml-rest-migration -m "feat: migrate telephony layer to SignalWire SWML + REST"
```

- [ ] **Step 3: Remove the worktree**

```bash
git worktree remove ../EliteDial-swml-migration
git branch -d swml-rest-migration
```

- [ ] **Step 4: Final build + test on main**

```bash
cd backend && npm install && npx prisma generate && npm run build && npm test
```

Expected: green.

- [ ] **Step 5: Operational action (human)**

Log in to the SignalWire Dashboard and update the inbound phone number's voice webhook URL from `https://<backend>/sw/inbound` to `https://<backend>/swml/inbound`. Method stays POST. This is the one-time reconfiguration the migration requires; until it's done, inbound calls will 404. Do not push to production before this step.

- [ ] **Step 6: Optional push**

```bash
git push origin main
```

Only push when ready. Pushing is the point-of-no-return for the renamed column, so ensure any staging/prod database has had the migration applied (or will be reset).

---

## Self-Review

**Spec coverage:**
- LaML `/sw/*` XML endpoints → replaced by SWML JSON `/swml/*` (Tasks 2, 3).
- LaML `/api/laml/2010-04-01/Accounts/.../Calls.json` origination → replaced by REST `/api/calling/calls` (Task 5).
- LaML `/Calls/{sid}.json` live-update (transfer) → replaced by `{command: "update", call_id}` (Task 5).
- LaML form-encoded webhooks → replaced by JSON `/signalwire/events/*` (Task 4).
- AMD + AI-transfer flow → removed (Task 6, per decision (b)).
- Stale plan doc, Telnyx references → removed (Task 1).
- Dashboard reconfiguration → called out as operational step (Task 10 Step 5).
- CLAUDE.md codifying invariants → Task 9.

**Known coverage gaps accepted for this plan:**
- Voicemail transcription (LaML had `transcribe="true"`). SWML does not have a one-line equivalent; transcription becomes a post-call REST call to SignalWire's transcription API. Not in this migration — follow-up feature. Acknowledge this is a minor regression: voicemail audio is saved; transcripts are not. Document in CLAUDE.md follow-ups.
- Live integration testing against a real SignalWire space. Tests mock `fetch`. The `transferCall` research spike (Task 5 Step 2) is the only place a live credential is nice-to-have; plan explicitly allows deferring it.

**Placeholder scan:** No "TBD", "handle appropriately", or un-coded instructions. Every code step shows exact code. Every test step shows expected output or exact pass count.

**Type consistency check:**
- `SwmlDocument` defined once in `builder.ts`; consumed by route modules.
- `SignalWireServiceConfig` / `SignalWireServiceDeps` defined in service file; consumed by tests.
- `signalwireCallId` (post-rename) used consistently in Task 4 implementation, Task 7 migration, and all call sites.
- `callId` is used for internal DB row IDs; `call_id` (snake) for SignalWire's identifier in webhook payloads; `providerCallId` for the cross-cutting TelephonyProvider contract. This distinction is intentional — don't collapse them.
- Route factories (`createSwmlRouter`, `createSignalwireEventsRouter`) accept `Deps` objects with consistently-named keys across tests and production defaults.

**Risk callouts:**
- Task 5 Step 2 (transfer endpoint research) is the only place the plan branches on environmental outcome. If both patterns A and B fail in dogfood, the plan pauses for user input before falling back to Relay SDK.
- Task 7 Prisma migration assumes dev DB. If there is a production DB with existing rows, the `ALTER COLUMN RENAME` is the correct SQL for Postgres; SQLite may force a table recreate. Verify and adjust before running against staging/prod.
