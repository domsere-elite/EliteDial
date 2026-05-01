# Phase 3c: WebRTC Pre-Warm via Per-Agent Rooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut post-answer-to-audio latency on power-dial bridges and manual outbound bridges from 3-5 seconds (cold WebRTC negotiation) to <500ms by keeping the agent's PeerConnection warm in a SignalWire conference room while their `Profile.status === 'available'`.

**Architecture:** Status-aligned per-agent SignalWire room (`join_room: agent-room-{agentId}`). Frontend dials the room when status flips to `available`, hangs up on `break`/`offline`. Customer leg's bridge SWML replaces `connect: /private/<ref>` with `join_room` + `connect:` fallback (`wait_for_moderator: true`, `timeout: 3` for race protection). System never gets worse than today (cold-bridge fallback always available).

**Tech Stack:** Express + Prisma (Supabase Postgres) + Socket.IO on the backend; Next.js 14 + `@signalwire/js@3.28.1` (do NOT bump) on the frontend; node:test + supertest for backend tests; existing `useProfileStatus` from Phase 3b for the lifecycle trigger.

---

## Required reading before starting

A fresh agent picking up this plan from a cold session must read these in order:

1. **`docs/superpowers/specs/2026-04-30-phase-3c-webrtc-pre-warm-design.md`** — the design spec this plan implements. Contains lifecycle table, sequence diagram, failure modes, cost model.
2. **`docs/superpowers/context-handoffs/2026-04-30-phase-3b-shipped.md`** — the prod state Phase 3c builds on. Phase 3b shipped `Profile.status` state machine + `useProfileStatus` hook; both are central to Phase 3c lifecycle.
3. **`backend/CLAUDE.md`** (in repo root as `EliteDial/CLAUDE.md`) — architectural rules: SWML only (no LaML/TwiML), all SWML construction in `backend/src/services/swml/builder.ts`, JSON webhooks only at `/signalwire/events/*`, never hit real SignalWire from tests.
4. **`backend/src/services/swml/builder.ts`** — the existing SWML builder. Add new functions following the established pattern (pure, no I/O).

---

## Branch + commit conventions

- **Branch:** off `feat/phase-3b-wrap-up` (Phase 3b is not yet merged to main; pile Phase 3c onto the same branch and we'll merge them together).
- **Commits:** small + frequent + signed `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Test posture:** TDD — write the failing test, run it, write minimal impl to pass, run full suite. No real SignalWire calls from tests (mock `fetch` via constructor injection per CLAUDE.md).

---

## Phase 0: Spike (MANDATORY — do not skip to Phase 1)

The full design rests on three SignalWire-side hypotheses that we cannot reason our way through. The spike validates them in 2-4 hours. **If H1 fails, abandon the room architecture and switch to the "light pre-warm" alternative documented in the spec's "Alternative if spike fails" section.**

### Task 0: Phase 0 spike — validate H1, H2, H3

**Files:**
- Create: `backend/src/routes/swml.ts` (modify — add 2 spike-only routes)
- Create: `frontend/src/app/dashboard/page.tsx` (modify — add a temporary "Spike" button under existing dial pad)
- Create: `backend/scripts/spike-phase-3c-customer-dial.ts` (new — origination script that targets the test cell)

- [ ] **Step 1: Add spike SWML routes**

In `backend/src/routes/swml.ts`, inside `createSwmlRouter`, add two routes (anywhere before `return router`):

```typescript
// SPIKE: agent-side moderator room for Phase 3c validation. Remove after spike concludes.
router.post('/spike-agent-room', (_req: Request, res: Response): void => {
    res.json({
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                {
                    join_room: {
                        name: 'spike-room-test',
                        moderator: true,
                        start_conference_on_enter: true,
                        end_conference_on_exit: true,
                        muted: false,
                    },
                },
                { hangup: {} },
            ],
        },
    });
});

// SPIKE: customer-side joiner with wait_for_moderator + timeout fallback. Remove after spike concludes.
router.post('/spike-customer-room', (_req: Request, res: Response): void => {
    res.json({
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                {
                    join_room: {
                        name: 'spike-room-test',
                        wait_for_moderator: true,
                        timeout: 3,
                    },
                },
                // If the join_room above timed out without a moderator, fall through
                // to a hard-coded TTS that signals "fallback path taken" for spike measurement.
                { play: { url: 'say:Spike fallback path taken — wait for moderator timed out.' } },
                { hangup: {} },
            ],
        },
    });
});
```

- [ ] **Step 2: Add spike origination script**

Create `backend/scripts/spike-phase-3c-customer-dial.ts`:

```typescript
// Origination script for Phase 3c spike. Dials the test cell with the
// spike-customer-room SWML. Run AFTER the agent's browser has joined
// /swml/spike-agent-room (so the moderator is present) to test H1 (instant
// late-joiner audio). Run BEFORE the agent has joined to test H2
// (wait_for_moderator timeout fallback).
//
// Usage:
//   railway run npx tsx backend/scripts/spike-phase-3c-customer-dial.ts
import { config } from '../src/config';

const TO = process.env.TO || '+18327979834';
const FROM = process.env.FROM || '+13467760336';

async function main() {
    const baseUrl = `https://${config.signalwire.spaceUrl}`;
    const auth = `Basic ${Buffer.from(`${config.signalwire.projectId}:${config.signalwire.apiToken}`).toString('base64')}`;
    const callbackUrl = config.publicUrls.backend;

    console.log(`Dialing ${TO} from ${FROM} → /swml/spike-customer-room ...`);
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
                status_url: `${callbackUrl}/signalwire/events/conference-status`,
                status_events: ['answered', 'ended'],
            },
        }),
    });
    console.log('Status:', resp.status);
    console.log('Body:', await resp.text());
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add temporary spike button to dashboard**

In `frontend/src/app/dashboard/page.tsx`, find the existing dial pad section. Above or beside the "Dial" button, add a temporary "Spike: Join Room" button:

```tsx
{/* SPIKE — Phase 3c room pre-warm validation. Remove after spike concludes. */}
<button
    className="btn btn-secondary"
    style={{ marginTop: 8 }}
    onClick={async () => {
        if (!sw.connected) {
            console.warn('[spike] sw not connected');
            return;
        }
        console.info('[spike] dialing /swml/spike-agent-room at', new Date().toISOString());
        try {
            // @ts-expect-error — clientRef is internal to useSignalWire; for spike only.
            const client = (sw as any)._client || (sw as any).clientRef?.current;
            if (!client?.dial) {
                console.error('[spike] client.dial not available; SDK shape changed');
                return;
            }
            const t0 = performance.now();
            const session = await client.dial(`${window.location.origin.replace('frontend', 'backend')}/swml/spike-agent-room`);
            console.info('[spike] room session resolved in', Math.round(performance.now() - t0), 'ms', session);
        } catch (err) {
            console.error('[spike] dial failed:', err);
        }
    }}
>
    Spike: Join Room
</button>
```

NOTE: the `client` access via `_client` is a hack for spike only — `useSignalWire` does NOT expose `clientRef`. The cleanest spike approach: add a temporary `dialRoom(url)` method to `useSignalWire` that wraps `clientRef.current.dial(url)`. Pick whichever the executing engineer prefers; the goal is just to fire one outbound `client.dial` to the room SWML.

- [ ] **Step 4: Deploy spike to prod**

```bash
cd backend && railway up backend --path-as-root --service backend --ci
cd frontend && railway up frontend --path-as-root --service frontend --ci
```

Wait for both to come up (`curl https://backend-production-e2bf.up.railway.app/health` returns `{"status":"ok"}`, frontend returns 200).

- [ ] **Step 5: Run H3 + H1 — agent in room, customer joins**

1. Hard-refresh the dialer in a browser tab. Log in as `dominic@exec-strategy.com`.
2. Open DevTools console.
3. Click "Spike: Join Room" button. Confirm console logs `[spike] room session resolved in <N> ms` (H3 passes if N is reasonable, e.g. <5000ms — and no `-32603` errors).
4. From a separate terminal on your laptop:
   ```bash
   cd backend && railway run npx tsx scripts/spike-phase-3c-customer-dial.ts
   ```
5. Answer the test cell `+18327979834`. **Time how long after answer until you can hear yourself / the agent**. Target: <500ms = H1 passes. 1-2s = H1 marginal. 3-5s = H1 fails.

- [ ] **Step 6: Run H2 — customer joins with no agent in room**

1. Reload the dialer (kicks the agent out of the room).
2. WITHOUT clicking "Spike: Join Room", run the customer-dial script again.
3. Answer the cell. You should hear silence for ~3 seconds, then the TTS "Spike fallback path taken — wait for moderator timed out." If yes → H2 passes (timeout works, falls through to next SWML step).

- [ ] **Step 7: Spike outcome decision**

Document results in `docs/superpowers/context-handoffs/2026-04-30-phase-3c-spike-results.md`:

```markdown
# Phase 3c Spike Results

**Date:** YYYY-MM-DD
**Branch:** spike/phase-3c-room-prewarm (or feat/phase-3b-wrap-up if no separate branch)

## H1 — Late-joiner audio is instant
- Result: PASS / FAIL / MARGINAL
- Measured time post-answer to audio: <ms>
- Notes: …

## H2 — wait_for_moderator timeout falls through
- Result: PASS / FAIL
- Notes: …

## H3 — v3 SDK 3.28.1 dials SWML URL
- Result: PASS / FAIL
- Notes: …

## Decision
- All three PASS → proceed with Phase 1 of plan as written.
- H1 FAIL → abandon room architecture; pivot to light pre-warm alternative (see spec).
- H2 FAIL → restructure customer SWML fallback (see spec Open Questions).
- H3 FAIL → significant pivot; may require SDK upgrade investigation.
```

- [ ] **Step 8: Remove spike code (only if all hypotheses pass)**

If proceeding to Phase 1, remove the spike routes, script, and button. They served their purpose.

```bash
git rm backend/scripts/spike-phase-3c-customer-dial.ts
# Manually edit backend/src/routes/swml.ts to remove spike-agent-room + spike-customer-room
# Manually edit frontend/src/app/dashboard/page.tsx to remove the Spike button
git add -A
git commit -m "chore(phase-3c): remove spike scaffolding after hypotheses validated"
```

If H1 failed, STOP HERE and pivot to the light-pre-warm alternative. Do not proceed to Phase 1 of this plan.

**Gate:** Phase 1 below assumes the spike has confirmed all three hypotheses. Do not begin Phase 1 unless `2026-04-30-phase-3c-spike-results.md` shows all PASS.

---

## Phase 1: Agent room SWML builder + signed URL route

### Task 1: Build pure `agentRoomSwml` function

**Files:**
- Modify: `backend/src/services/swml/builder.ts`
- Test: `backend/src/test/swml-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/test/swml-builder.test.ts`:

```typescript
test('swml-builder: agentRoomSwml builds moderator join_room with end_conference_on_exit', () => {
    const doc = agentRoomSwml({ agentId: 'agent-uuid-123' });
    assert.equal(doc.version, '1.0.0');
    const main = doc.sections.main;
    assert.deepEqual(main[0], { answer: {} });
    assert.ok(main[1].join_room, 'join_room step present');
    assert.equal(main[1].join_room.name, 'agent-room-agent-uuid-123');
    assert.equal(main[1].join_room.moderator, true);
    assert.equal(main[1].join_room.start_conference_on_enter, true);
    assert.equal(main[1].join_room.end_conference_on_exit, true);
    assert.equal(main[1].join_room.muted, false);
    assert.deepEqual(main[2], { hangup: {} }, 'hangup after room ends');
});

test('swml-builder: agentRoomSwml — agentId is encoded into the room name verbatim', () => {
    const doc = agentRoomSwml({ agentId: 'unusual+chars/in_id' });
    const main = doc.sections.main;
    assert.equal(main[1].join_room.name, 'agent-room-unusual+chars/in_id');
});
```

Add to the import block at the top:

```typescript
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
    agentRoomSwml,                  // ← NEW
} from '../services/swml/builder';
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/swml-builder.test.ts 2>&1 | tail -10
```

Expected: TS error or assertion fail — `agentRoomSwml` not exported.

- [ ] **Step 3: Implement `agentRoomSwml`**

Append to `backend/src/services/swml/builder.ts`:

```typescript
export interface AgentRoomParams {
    agentId: string;
}

/**
 * Per-agent moderator room used to keep the WebRTC PeerConnection warm so
 * customer legs can `join_room` into an already-negotiated session and get
 * instant audio (Phase 3c).
 *
 * Room lifecycle is bound to the agent's `Profile.status === 'available'`.
 * `end_conference_on_exit: true` means the room dies the moment the agent
 * leaves (status flips to break/offline, browser refresh, network drop).
 */
export function agentRoomSwml(params: AgentRoomParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                {
                    join_room: {
                        name: `agent-room-${params.agentId}`,
                        moderator: true,
                        start_conference_on_enter: true,
                        end_conference_on_exit: true,
                        muted: false,
                    },
                },
                { hangup: {} },
            ],
        },
    };
}
```

- [ ] **Step 4: Run tests pass**

```bash
cd backend && npx tsx --test src/test/swml-builder.test.ts 2>&1 | tail -10
```

Expected: all tests pass (existing 17 + 2 new = 19).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/swml/builder.ts backend/src/test/swml-builder.test.ts
git commit -m "$(cat <<'EOF'
feat(swml): agentRoomSwml builder for Phase 3c per-agent pre-warm rooms

Returns the moderator-side SWML that a logged-in available agent dials
to keep their WebRTC PeerConnection warm. Room name is derived from
agentId; end_conference_on_exit ties the room's lifecycle to the agent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Signed URL helper for `/swml/agent-room/:agentId`

**Why signed:** the agent-room SWML route is keyed by `:agentId` and would otherwise be world-callable. Anyone with knowledge of the agent UUID could pre-warm someone else's room. A signed URL with HMAC over `{agentId, expiresAt}` proven at request time prevents this.

**Files:**
- Create: `backend/src/lib/signed-url.ts`
- Test: `backend/src/test/signed-url.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/test/signed-url.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAgentRoomUrl, verifyAgentRoomSignature } from '../lib/signed-url';

const SECRET = 'test-secret-do-not-use-in-prod';

test('signAgentRoomUrl: returns sig + exp params and they verify round-trip', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    assert.ok(sig.length > 0);
    assert.ok(exp > Math.floor(Date.now() / 1000));
    const result = verifyAgentRoomSignature('agent-1', sig, exp, SECRET);
    assert.equal(result.ok, true);
});

test('verifyAgentRoomSignature: rejects expired sig', () => {
    const { sig } = signAgentRoomUrl('agent-1', 60, SECRET);
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    const result = verifyAgentRoomSignature('agent-1', sig, expiredExp, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
});

test('verifyAgentRoomSignature: rejects mismatched agentId', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-2', sig, exp, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_signature');
});

test('verifyAgentRoomSignature: rejects tampered signature', () => {
    const { exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-1', 'tampered', exp, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_signature');
});

test('verifyAgentRoomSignature: rejects when secret differs', () => {
    const { sig, exp } = signAgentRoomUrl('agent-1', 60, SECRET);
    const result = verifyAgentRoomSignature('agent-1', sig, exp, 'different-secret');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_signature');
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/signed-url.test.ts 2>&1 | tail -10
```

Expected: import error — module doesn't exist.

- [ ] **Step 3: Implement `signed-url.ts`**

Create `backend/src/lib/signed-url.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 signed URLs for SWML routes that must be parameterised by
 * agent id but cannot rely on a Bearer token (SignalWire fetches the URL
 * server-to-server, no Authorization header from the agent's session).
 *
 * Format: `?sig=<hex>&exp=<unix-seconds>`
 * Secret: process.env.SWML_URL_SIGNING_SECRET, falling back to apiToken in dev.
 */
function computeSignature(agentId: string, exp: number, secret: string): string {
    return createHmac('sha256', secret).update(`${agentId}:${exp}`).digest('hex');
}

export function signAgentRoomUrl(agentId: string, ttlSeconds: number, secret: string): { sig: string; exp: number } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = computeSignature(agentId, exp, secret);
    return { sig, exp };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'expired' | 'invalid_signature' };

export function verifyAgentRoomSignature(agentId: string, sig: string, exp: number, secret: string): VerifyResult {
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: 'expired' };
    }
    const expected = computeSignature(agentId, exp, secret);
    const expectedBuf = Buffer.from(expected, 'hex');
    let actualBuf: Buffer;
    try {
        actualBuf = Buffer.from(sig, 'hex');
    } catch {
        return { ok: false, reason: 'invalid_signature' };
    }
    if (actualBuf.length !== expectedBuf.length) {
        return { ok: false, reason: 'invalid_signature' };
    }
    if (!timingSafeEqual(actualBuf, expectedBuf)) {
        return { ok: false, reason: 'invalid_signature' };
    }
    return { ok: true };
}
```

- [ ] **Step 4: Run tests pass**

```bash
cd backend && npx tsx --test src/test/signed-url.test.ts 2>&1 | tail -10
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/signed-url.ts backend/src/test/signed-url.test.ts
git commit -m "$(cat <<'EOF'
feat(signed-url): HMAC signing helper for SWML routes parameterised by agent id

Used by /swml/agent-room/:agentId so SignalWire's server-to-server
fetch can prove the URL was minted by us for that specific agent
within a short TTL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GET /swml/agent-room/:agentId` route + token mint endpoint

**Files:**
- Modify: `backend/src/routes/swml.ts`
- Modify: `backend/src/routes/agents.ts` (add `GET /:id/room-url` to mint a signed URL for the frontend)
- Test: `backend/src/test/swml-routes.test.ts`
- Test: `backend/src/test/agents-room-url.test.ts` (new)

- [ ] **Step 1: Write failing tests for the SWML route**

Append to `backend/src/test/swml-routes.test.ts` (or create section if file doesn't exist for swml routes):

```typescript
test('GET /swml/agent-room/:agentId — returns agentRoomSwml when sig is valid', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter()); // default deps fine — route is pure

    const { signAgentRoomUrl } = await import('../lib/signed-url');
    const { sig, exp } = signAgentRoomUrl('agent-uuid-1', 60, SECRET);

    const res = await request(app).get(`/swml/agent-room/agent-uuid-1?sig=${sig}&exp=${exp}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, '1.0.0');
    assert.equal(res.body.sections.main[1].join_room.name, 'agent-room-agent-uuid-1');
    assert.equal(res.body.sections.main[1].join_room.moderator, true);
});

test('GET /swml/agent-room/:agentId — 403 on missing sig', async () => {
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter());
    const res = await request(app).get('/swml/agent-room/agent-uuid-1');
    assert.equal(res.status, 403);
});

test('GET /swml/agent-room/:agentId — 403 on tampered sig', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const { signAgentRoomUrl } = await import('../lib/signed-url');
    const { exp } = signAgentRoomUrl('agent-uuid-1', 60, SECRET);
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter());
    const res = await request(app).get(`/swml/agent-room/agent-uuid-1?sig=deadbeef&exp=${exp}`);
    assert.equal(res.status, 403);
});

test('GET /swml/agent-room/:agentId — 403 on expired sig', async () => {
    const SECRET = 'test-secret-room';
    process.env.SWML_URL_SIGNING_SECRET = SECRET;
    const { signAgentRoomUrl } = await import('../lib/signed-url');
    // Sign with negative TTL so it's already expired.
    const { sig } = signAgentRoomUrl('agent-uuid-1', -60, SECRET);
    const exp = Math.floor(Date.now() / 1000) - 30;
    const app = express();
    app.use(express.json());
    app.use('/swml', createSwmlRouter());
    const res = await request(app).get(`/swml/agent-room/agent-uuid-1?sig=${sig}&exp=${exp}`);
    assert.equal(res.status, 403);
});
```

If the test file doesn't already import `express`/`request`/`createSwmlRouter`, add the imports.

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/swml-routes.test.ts 2>&1 | tail -15
```

Expected: 404 from the missing route.

- [ ] **Step 3: Add the route to `createSwmlRouter`**

In `backend/src/routes/swml.ts`, near the other `/swml/*` routes inside `createSwmlRouter`:

```typescript
import { agentRoomSwml } from '../services/swml/builder';
import { verifyAgentRoomSignature } from '../lib/signed-url';

// ... inside createSwmlRouter ...

// GET /swml/agent-room/:agentId — Phase 3c per-agent pre-warm room SWML.
// Signed URL keyed by agentId; SignalWire fetches this server-to-server
// when the frontend's client.dial(...) hits it, so we cannot rely on
// session auth — HMAC signing closes that gap.
router.get('/agent-room/:agentId', (req: Request, res: Response): void => {
    const agentId = String(req.params.agentId || '');
    const sig = String(req.query.sig || '');
    const exp = Number(req.query.exp || 0);
    const secret = process.env.SWML_URL_SIGNING_SECRET || config.signalwire.apiToken;
    if (!secret) {
        res.status(500).json({ error: 'signing_secret_unset' });
        return;
    }
    const verified = verifyAgentRoomSignature(agentId, sig, exp, secret);
    if (!verified.ok) {
        res.status(403).json({ error: verified.reason });
        return;
    }
    res.json(agentRoomSwml({ agentId }));
});
```

(SignalWire will fetch via POST in some configurations and GET in others. Per project convention `swml/*` are POST. Verify by reading the current spike: if SignalWire posted to /swml/spike-agent-room successfully, use POST. Match whichever the spike used. **Default: POST.**)

If POST is the right verb for this codebase, change `router.get` to `router.post` and update the test verbs to `request(app).post(...)`.

- [ ] **Step 4: Tests pass**

```bash
cd backend && npx tsx --test src/test/swml-routes.test.ts 2>&1 | tail -10
```

Expected: 4/4 new tests pass.

- [ ] **Step 5: Add `GET /api/agents/:id/room-url` for frontend**

Open `backend/src/routes/agents.ts`. The router was refactored in Phase 3b to `buildAgentsRouter(deps)` factory. Add a new route inside the factory:

```typescript
import { signAgentRoomUrl } from '../lib/signed-url';
import { config } from '../config';

// ... inside buildAgentsRouter ...

// GET /api/agents/:id/room-url — mints a short-lived signed URL the frontend
// passes to client.dial(...) to enter the agent's pre-warm room. Auth: agent
// can only mint a URL for themselves; supervisor/admin can mint for anyone.
router.get('/:id/room-url', authenticate, (req: Request, res: Response): void => {
    const id = paramValue(req.params.id);
    if (req.user!.role === 'agent' && req.user!.id !== id) {
        res.status(403).json({ error: 'Cannot mint room URL for another agent' });
        return;
    }
    const secret = process.env.SWML_URL_SIGNING_SECRET || config.signalwire.apiToken;
    if (!secret) {
        res.status(500).json({ error: 'signing_secret_unset' });
        return;
    }
    const { sig, exp } = signAgentRoomUrl(id, 60, secret); // 60-second TTL
    const url = `${config.publicUrls.backend}/swml/agent-room/${id}?sig=${sig}&exp=${exp}`;
    res.json({ url, exp });
});
```

- [ ] **Step 6: Test the room-url endpoint**

Create `backend/src/test/agents-room-url.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { RequestHandler } from 'express';
import request from 'supertest';
import { buildAgentsRouter } from '../routes/agents';

function appAsAgent(agentId: string, role: 'agent' | 'supervisor' | 'admin' = 'agent') {
    process.env.SWML_URL_SIGNING_SECRET = 'test-secret';
    process.env.BACKEND_PUBLIC_URL = 'https://backend.test';
    const stubAuth: RequestHandler = (req: any, _res, next) => {
        req.user = { id: agentId, email: 'a@b', role, firstName: 'A', lastName: 'B', extension: null };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/agents', buildAgentsRouter({
        exitWrapUp: async () => ({ transitioned: false }),
        cancelAutoResume: () => {},
        authenticate: stubAuth,
    }));
    return app;
}

test('GET /api/agents/:id/room-url — same agent gets a signed URL', async () => {
    const app = appAsAgent('agent-1');
    const res = await request(app).get('/api/agents/agent-1/room-url');
    assert.equal(res.status, 200);
    assert.match(res.body.url, /\/swml\/agent-room\/agent-1\?sig=[a-f0-9]+&exp=\d+/);
    assert.ok(res.body.exp > Math.floor(Date.now() / 1000));
});

test('GET /api/agents/:id/room-url — agent cannot mint for another agent (403)', async () => {
    const app = appAsAgent('agent-1');
    const res = await request(app).get('/api/agents/agent-2/room-url');
    assert.equal(res.status, 403);
});

test('GET /api/agents/:id/room-url — supervisor can mint for any agent', async () => {
    const app = appAsAgent('agent-1', 'supervisor');
    const res = await request(app).get('/api/agents/agent-2/room-url');
    assert.equal(res.status, 200);
    assert.match(res.body.url, /\/swml\/agent-room\/agent-2\?sig=/);
});
```

- [ ] **Step 7: Tests pass**

```bash
cd backend && npx tsx --test src/test/agents-room-url.test.ts 2>&1 | tail -10
```

Expected: 3/3 pass.

- [ ] **Step 8: Full suite + tsc**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
cd backend && npm test 2>&1 | tail -10
```

Expected: tsc clean, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/swml.ts backend/src/routes/agents.ts backend/src/test/swml-routes.test.ts backend/src/test/agents-room-url.test.ts
git commit -m "$(cat <<'EOF'
feat(swml): /swml/agent-room/:id route + signed-URL minting endpoint

POST /swml/agent-room/:agentId serves the agent's pre-warm room SWML;
sig+exp query params are HMAC-verified before serving (closes the gap
where the route is keyed by agent id but cannot rely on session auth).

GET /api/agents/:id/room-url is the frontend's mint endpoint —
authenticated agents mint short-lived signed URLs for themselves;
supervisors/admins can mint for anyone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Frontend `useAgentRoom` hook

### Task 4: Expose room-dial primitive on `useSignalWire`

**Files:**
- Modify: `frontend/src/hooks/useSignalWire.ts`

The existing hook closes `clientRef` over its closure and never exposes it. We need a stable callback the new `useAgentRoom` hook can call to dial a room URL. Add a thin `dialRoom(url)` method.

- [ ] **Step 1: Read the hook to find the right insertion point**

```bash
grep -n "useCallback\|return " frontend/src/hooks/useSignalWire.ts | head -20
```

Find the place where `connect`, `dial`, `hangup` etc. are returned. Add `dialRoom` next to them.

- [ ] **Step 2: Add the dialRoom callback**

Inside `useSignalWire`, add (placement: alongside other `useCallback` definitions, near `dial`):

```typescript
/**
 * Phase 3c — dial a SWML URL to enter a pre-warm room. Returns the
 * resolved Fabric session so the caller can hang up later. Throws if
 * the SDK isn't connected; caller should call connect() first.
 */
const dialRoom = useCallback(async (roomUrl: string): Promise<any | null> => {
    if (!clientRef.current) {
        await connect();
    }
    if (!clientRef.current) {
        throw new Error('SignalWire client not connected');
    }
    // The v3 SDK's client.dial accepts either an address (sip:.../private/...)
    // or an HTTPS URL serving SWML. The latter is what we use for /swml/agent-room.
    return await (clientRef.current as any).dial(roomUrl);
}, [connect]);
```

In the hook's return object, add `dialRoom` to the exported set.

- [ ] **Step 3: Frontend tsc**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean. (No frontend tests in the codebase yet, so no test step.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useSignalWire.ts
git commit -m "$(cat <<'EOF'
feat(frontend): expose dialRoom(url) on useSignalWire for Phase 3c rooms

Thin wrapper over clientRef.current.dial that lets a parallel hook
(useAgentRoom) initiate room calls without breaking the encapsulation
of the existing softphone client.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `useAgentRoom` hook — bind room lifecycle to Profile.status

**Files:**
- Create: `frontend/src/hooks/useAgentRoom.ts`

- [ ] **Step 1: Create the hook**

Create `frontend/src/hooks/useAgentRoom.ts`:

```typescript
'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useSignalWire } from './useSignalWire';
import { useProfileStatus, type ProfileStatus } from './useProfileStatus';
import { useAuth } from './useAuth';

const ROOM_DEBOUNCE_MS = 500;

interface AgentRoomState {
    inRoom: boolean;
    roomError: string | null;
}

/**
 * Phase 3c — keeps the agent's WebRTC PeerConnection warm by dialing a
 * per-agent SignalWire room while Profile.status === 'available'. Customer
 * legs `join_room` into the same room and get instant audio.
 *
 * Lifecycle:
 *   offline/break → available  → mint signed URL, dial room, store session
 *   available → wrap-up        → no-op (stay in room)
 *   wrap-up → available        → no-op (already in room)
 *   any → break/offline        → hangup the session, drop reference
 *
 * Resilience: on Socket.IO reconnect, if status is still 'available' but
 * we don't have a session, redial.
 */
export function useAgentRoom(): AgentRoomState {
    const { user } = useAuth();
    const sw = useSignalWire();
    const profile = useProfileStatus();

    const [inRoom, setInRoom] = useState(false);
    const [roomError, setRoomError] = useState<string | null>(null);

    // Active room session reference (whatever client.dial returned).
    const sessionRef = useRef<any | null>(null);
    // Debounce timer for status flutters.
    const debounceRef = useRef<NodeJS.Timeout | null>(null);
    // Reentrancy guard so a status flutter doesn't double-dial.
    const inflightRef = useRef<boolean>(false);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const targetStatus = profile.status;
        debounceRef.current = setTimeout(() => {
            void reconcile(targetStatus);
        }, ROOM_DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [profile.status]);

    // On socket reconnect, if we're available but not in room, retry.
    useEffect(() => {
        if (!sw.connected) return;
        if (profile.status !== 'available') return;
        if (sessionRef.current) return;
        void reconcile('available');
    }, [sw.connected, profile.status]);

    async function reconcile(status: ProfileStatus): Promise<void> {
        if (inflightRef.current) return;
        inflightRef.current = true;
        try {
            const wantInRoom = status === 'available' || status === 'wrap-up' || status === 'on-call';
            if (wantInRoom && !sessionRef.current) {
                if (!user?.id) return;
                if (!sw.connected) return; // wait for connect; second effect will retry
                await enterRoom(user.id);
            } else if (!wantInRoom && sessionRef.current) {
                await leaveRoom();
            }
        } finally {
            inflightRef.current = false;
        }
    }

    async function enterRoom(agentId: string): Promise<void> {
        try {
            const { data } = await api.get(`/agents/${agentId}/room-url`);
            const url = data?.url;
            if (!url) throw new Error('no room url');
            const session = await sw.dialRoom(url);
            sessionRef.current = session;
            setInRoom(true);
            setRoomError(null);
        } catch (err: any) {
            const message = err?.message || 'Failed to enter room';
            setInRoom(false);
            setRoomError(message);
            // Customer legs still get cold-bridge fallback per spec — non-fatal.
        }
    }

    async function leaveRoom(): Promise<void> {
        const session = sessionRef.current;
        sessionRef.current = null;
        setInRoom(false);
        if (!session) return;
        try {
            // SignalWire v3 sessions expose a hangup() method on the resolved object.
            if (typeof session.hangup === 'function') {
                await session.hangup();
            }
        } catch {
            // Ignored — room may have died already (network drop, etc.).
        }
    }

    return { inRoom, roomError };
}
```

- [ ] **Step 2: Frontend tsc**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useAgentRoom.ts
git commit -m "$(cat <<'EOF'
feat(frontend): useAgentRoom hook — Profile.status-aligned pre-warm room

Dials /swml/agent-room/<id> via signed URL when status flips to
available; hangs up on break/offline. Stays in room across wrap-up
transitions so the next bridge gets instant audio. Resilient to socket
reconnects; debounced against status flutters.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Mount `useAgentRoom` on the dashboard

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx`

- [ ] **Step 1: Import and mount the hook**

In `frontend/src/app/dashboard/page.tsx`, near the existing `useProfileStatus`:

```typescript
import { useProfileStatus } from '@/hooks/useProfileStatus';
import { useAgentRoom } from '@/hooks/useAgentRoom';                  // ← NEW
```

Inside the component body, alongside the existing `const profile = useProfileStatus();`:

```typescript
const profile = useProfileStatus();
const room = useAgentRoom();                                          // ← NEW
```

- [ ] **Step 2: Surface room state in the header**

Find where `Softphone connected. Real-time live.` is rendered (in the page header / sub-header). Augment it:

```tsx
<p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
    {sw.connected ? 'Softphone connected. Real-time live.' : sw.error || 'Connecting softphone...'}
    {room.inRoom && ' Bridge ready.'}
    {!room.inRoom && profile.status === 'available' && ' Bridge connecting...'}
    {room.roomError && ` Room error: ${room.roomError}`}
</p>
```

- [ ] **Step 3: Frontend tsc**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/dashboard/page.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): mount useAgentRoom on dashboard + surface bridge state

"Bridge ready" / "Bridge connecting..." indicator under the softphone
status line so agents (and us during smoke) can see the pre-warm
lifecycle at a glance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Power-dial bridge SWML — `join_room` + fallback

### Task 7: Modify `powerDialDetectSwml` for room-based bridge with cold fallback

**Files:**
- Modify: `backend/src/services/swml/builder.ts`
- Test: `backend/src/test/swml-builder.test.ts`

- [ ] **Step 1: Update `PowerDialDetectParams` type and add tests**

The builder's bridge section currently produces `connect: /private/<targetRef>`. Phase 3c adds a `join_room` step before the connect, with `wait_for_moderator: true` + `timeout: 3` to handle pre-warm-not-ready races. Builder needs the agent id (which is already known to the worker — passed in Task 9).

In `backend/src/test/swml-builder.test.ts`, append:

```typescript
test('swml-builder: powerDialDetectSwml — bridge section join_rooms agent-room then falls through to connect', () => {
    const doc = powerDialDetectSwml({
        claimUrl: 'https://x.test/swml/power-dial/claim',
        voicemailUrl: 'https://x.test/swml/power-dial/voicemail',
        batchId: 'b1', legId: 'l1', campaignId: 'c1', callerId: '+15551110000',
        targetRef: 'dominic',
        agentId: 'agent-uuid-9',
        retellSipAddress: null,
        voicemailBehavior: 'hangup', voicemailMessage: null,
        skipAmd: true,
    });
    const bridge = doc.sections.bridge;
    assert.ok(bridge, 'bridge section present');
    // Step 0: join_room with wait_for_moderator + timeout
    const joinStep = bridge[0] as any;
    assert.ok(joinStep.join_room, 'first step is join_room');
    assert.equal(joinStep.join_room.name, 'agent-room-agent-uuid-9');
    assert.equal(joinStep.join_room.wait_for_moderator, true);
    assert.equal(joinStep.join_room.timeout, 3);
    assert.equal(joinStep.join_room.moderator, false);
    // Step 1: fallback connect: /private/<ref>
    const connectStep = bridge[1] as any;
    assert.ok(connectStep.connect, 'fallback connect step after join_room');
    assert.equal(connectStep.connect.to, '/private/dominic');
    assert.equal(connectStep.connect.answer_on_bridge, true);
    // Step 2: hangup
    assert.deepEqual(bridge[2], { hangup: {} });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/swml-builder.test.ts 2>&1 | tail -15
```

Expected: type error on `agentId` (new param) AND assertion fails on the bridge section.

- [ ] **Step 3: Update builder**

In `backend/src/services/swml/builder.ts`, modify `PowerDialDetectParams`:

```typescript
export interface PowerDialDetectParams {
    claimUrl: string;
    voicemailUrl: string;
    batchId: string;
    legId: string;
    campaignId: string;
    callerId: string;
    targetRef: string;
    /** Phase 3c — used to derive `agent-room-{agentId}` for the pre-warm join_room. */
    agentId: string;
    retellSipAddress: string | null;
    voicemailBehavior: 'hangup' | 'leave_message';
    voicemailMessage?: string | null;
    skipAmd: boolean;
}
```

Replace the existing `bridgeSection` definition:

```typescript
// Phase 3c bridge section: try the warm room first (agent has been
// in agent-room-<id> while their status is available, so PC is
// already negotiated). wait_for_moderator with a 3s timeout covers
// the race window between worker.batch.armed and customer answer.
// If the moderator never shows (status flicker, network blip, room
// dial failed entirely), the SWML falls through to the cold-bridge
// connect — same path Phase 3a used. System is never WORSE than
// today; in the happy path it's <500ms vs the current 3-5s.
const bridgeSection: SwmlStep[] = [
    {
        join_room: {
            name: `agent-room-${p.agentId}`,
            moderator: false,
            wait_for_moderator: true,
            timeout: 3,
        },
    },
    {
        connect: {
            to: `/private/${p.targetRef}`,
            timeout: 30,
            answer_on_bridge: true,
        },
    },
    { hangup: {} },
];
```

- [ ] **Step 4: Run tests pass**

```bash
cd backend && npx tsx --test src/test/swml-builder.test.ts 2>&1 | tail -10
```

Expected: existing power-dial tests still pass + new test passes. If existing tests fail because they don't pass `agentId` in fixtures, update those fixtures to add `agentId: 'agent-fixture'`.

- [ ] **Step 5: Commit (DEFERRED — wait until Task 8 wires agentId through)**

The builder now requires `agentId` but the worker doesn't pass it yet. Don't commit alone — combine with Task 8.

---

### Task 8: Wire `agentId` through `progressive-power-dial-worker.ts`

**Files:**
- Modify: `backend/src/services/progressive-power-dial-worker.ts`
- Test: `backend/src/test/power-dial-worker.test.ts`

- [ ] **Step 1: Add agentId to the powerDialDetectSwml call in the worker**

The worker already has `agent.id` available locally (line ~221, `agentId: agent.id` on the batch insert). Find the `powerDialDetectSwml({...})` call (around line 252) and add `agentId`:

```typescript
const swml = powerDialDetectSwml({
    claimUrl: `${callbackUrl}/swml/power-dial/claim`,
    voicemailUrl: `${callbackUrl}/swml/power-dial/voicemail`,
    batchId,
    legId,
    campaignId: campaign.id,
    callerId: fromNumber,
    targetRef,
    agentId: agent.id,                               // ← NEW
    retellSipAddress: campaign.retellSipAddress,
    voicemailBehavior: (campaign.voicemailBehavior === 'leave_message' ? 'leave_message' : 'hangup'),
    voicemailMessage: campaign.voicemailMessage,
    skipAmd: campaign.skipAmd,
});
```

- [ ] **Step 2: Update worker tests if any reference powerDialDetectSwml directly**

```bash
cd backend && grep -n "powerDialDetectSwml" src/test/power-dial-worker.test.ts | head -5
```

Update fixtures/calls in any matching tests to include `agentId`. Most worker tests don't call the builder directly (they mock `originateLeg` instead), so this should be a small or zero-touch change.

- [ ] **Step 3: Run full backend suite**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
cd backend && npm test 2>&1 | tail -10
```

Expected: tsc clean, all tests pass.

- [ ] **Step 4: Commit Tasks 7+8 together**

```bash
git add backend/src/services/swml/builder.ts backend/src/services/progressive-power-dial-worker.ts backend/src/test/swml-builder.test.ts backend/src/test/power-dial-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(power-dial): bridge SWML uses join_room with cold-connect fallback

Phase 3c bridge section is now [join_room (wait_for_moderator, 3s)]
→ [connect /private/<ref>] → [hangup]. Agent has been in
agent-room-<agentId> since their status flipped to available, so the
join_room joins an already-negotiated room and audio is instant. If
the moderator isn't there within 3s, the SWML falls through to the
cold-bridge connect — same path Phase 3a used. Never worse than today.

powerDialDetectSwml gains an agentId param threaded from the worker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Manual outbound — same `join_room` + fallback

### Task 9: Modify `originateAgentBrowserCall` for room-based bridge

**Files:**
- Modify: `backend/src/services/signalwire.ts`
- Test: `backend/src/test/signalwire-service.test.ts`

- [ ] **Step 1: Update tests**

In `backend/src/test/signalwire-service.test.ts`, find the existing `originateAgentBrowserCall posts dial to=PSTN with inline SWML connecting to /private/<ref>` test (around line 146). Replace its assertions:

```typescript
test('originateAgentBrowserCall posts dial with inline SWML — join_room → connect fallback', async () => {
    const fetchMock = mock.fn(async (url: string, init?: any) => {
        assert.equal(url, 'https://test.signalwire.com/api/calling/calls');
        const body = JSON.parse(init.body);
        assert.equal(body.command, 'dial');
        assert.equal(body.params.from, '+13467760336');
        assert.equal(body.params.to, '+18327979834');
        // Top-level inline-object SWML
        assert.equal(typeof body.swml, 'object');
        const main = body.swml.sections.main;
        assert.deepEqual(main[0], { answer: {} });
        // Step 1: join_room (warm path)
        assert.ok(main[1].join_room, 'join_room step present');
        assert.equal(main[1].join_room.name, 'agent-room-agent-uuid-1');
        assert.equal(main[1].join_room.wait_for_moderator, true);
        assert.equal(main[1].join_room.timeout, 3);
        // Step 2: connect (fallback)
        assert.equal(main[2].connect.to, '/private/agent-uuid-1');
        assert.equal(main[2].connect.answer_on_bridge, true);
        // Step 3: hangup
        assert.deepEqual(main[3], { hangup: {} });
        assert.match(body.params.status_url, /\/signalwire\/events\/call-status/);
        assert.deepEqual(body.params.status_events, ['answered', 'ended']);
        return makeResponse(200, { id: 'sw-call-42' });
    });

    const svc = new SignalWireService(config, { fetch: fetchMock as unknown as typeof fetch });
    const result = await svc.originateAgentBrowserCall({
        agentId: 'agent-uuid-1',
        agentSipReference: 'agent-uuid-1',
        toNumber: '+18327979834',
        callerIdNumber: '+13467760336',
        callbackUrl: 'https://backend.test',
    });

    assert.ok(result, 'result returned');
    assert.equal(result!.providerCallId, 'sw-call-42');
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/signalwire-service.test.ts 2>&1 | tail -15
```

Expected: type error on `agentId` (new param) AND assertion failures on the SWML structure.

- [ ] **Step 3: Update `originateAgentBrowserCall`**

In `backend/src/services/signalwire.ts`, modify the method signature and inline SWML:

```typescript
async originateAgentBrowserCall(params: {
    agentId: string;                                  // ← NEW: drives agent-room name
    agentSipReference: string;                        // existing: drives /private/<ref> fallback
    toNumber: string;
    callerIdNumber: string;
    callbackUrl: string;
}): Promise<OutboundCallResult | null> {
    if (!this.isConfigured) {
        logger.warn('SignalWire not configured; returning mock agent-call id');
        return { provider: this.name, providerCallId: `mock-agent-call-${Date.now()}` };
    }

    try {
        const statusUrl = `${params.callbackUrl}/signalwire/events/call-status`;
        const fabricTarget = `/private/${params.agentSipReference}`;
        // Phase 3c inline SWML: warm join_room first, cold connect fallback,
        // hangup. Same structure power-dial bridge SWML uses.
        const inlineSwml = {
            version: '1.0.0',
            sections: {
                main: [
                    { answer: {} },
                    {
                        join_room: {
                            name: `agent-room-${params.agentId}`,
                            moderator: false,
                            wait_for_moderator: true,
                            timeout: 3,
                        },
                    },
                    { connect: { to: fabricTarget, timeout: 30, answer_on_bridge: true } },
                    { hangup: {} },
                ],
            },
        };

        const response = await this.fetchImpl(`${this.baseUrl}/api/calling/calls`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
            body: JSON.stringify({
                command: 'dial',
                params: {
                    from: params.callerIdNumber,
                    to: params.toNumber,
                    caller_id: params.callerIdNumber,
                    status_url: statusUrl,
                    status_events: ['answered', 'ended'],
                },
                swml: inlineSwml,
            }),
        });

        if (!response.ok) {
            const bodyText = await response.text();
            logger.error('SignalWire agent-browser call origination failed', { status: response.status, body: bodyText });
            return null;
        }

        const data = (await response.json()) as { id?: string; call_id?: string };
        return {
            provider: this.name,
            providerCallId: data.id || data.call_id || '',
            raw: { fabricTarget, callerIdNumber: params.callerIdNumber, toNumber: params.toNumber, transport: 'pstn-first-fabric-bridge-with-room' },
        };
    } catch (err) {
        logger.error('SignalWire agent-browser call origination error', { error: err });
        return null;
    }
}
```

- [ ] **Step 4: Update callers of `originateAgentBrowserCall`**

```bash
cd backend && grep -rn "originateAgentBrowserCall" src/ | grep -v test
```

Each call site needs the new `agentId` param. The primary call site is in `backend/src/routes/calls.ts` (manual outbound dial endpoint). Find it, add `agentId: req.user!.id` (or whichever variable holds the agent's id at that scope).

- [ ] **Step 5: Run full backend suite**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
cd backend && npm test 2>&1 | tail -10
```

Expected: tsc clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/signalwire.ts backend/src/routes/calls.ts backend/src/test/signalwire-service.test.ts
git commit -m "$(cat <<'EOF'
feat(softphone): manual outbound also uses join_room + cold fallback

originateAgentBrowserCall's inline SWML mirrors the Phase 3c power-dial
bridge: join_room agent-room-<id> first (warm), connect /private/<ref>
on timeout (cold). Both outbound paths now get instant audio when the
agent's pre-warm room is up, with the same never-worse-than-today
guarantee on failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Conference-status webhook handler (recommended)

This phase wires SignalWire's conference-level callbacks into the existing wrap-up service. Phase 3b's per-call `status_url` callback never fired in production (parked, see context handoff). Conference-level callbacks are documented as a separate event channel and are a natural fit for room-based bridges.

### Task 10: `POST /signalwire/events/conference-status` route

**Files:**
- Modify: `backend/src/routes/signalwire-events.ts`
- Test: `backend/src/test/signalwire-events.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/test/signalwire-events.test.ts`:

```typescript
test('POST /signalwire/events/conference-status — participant-leave for non-moderator triggers enterWrapUp on agent', async () => {
    captured.wrapUpEntered = [];
    const localFakes = {
        ...fakeDeps,
        // Conference-status handler resolves the agent via the room name (agent-room-<agentId>)
        resolveAgentFromRoomName: async (name: string) => name.startsWith('agent-room-') ? name.slice('agent-room-'.length) : null,
        // Default wrap-up seconds for non-campaign-tagged conferences.
        defaultWrapUpSeconds: 30,
    } as any;
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/signalwire/events', createSignalwireEventsRouter(localFakes));

    const res = await request(localApp)
        .post('/signalwire/events/conference-status')
        .send({
            event_type: 'calling.call.conference',
            params: {
                event: 'participant-leave',
                room_name: 'agent-room-agent-xyz',
                participant: { is_moderator: false, call_id: 'sw-call-1' },
            },
        });

    assert.equal(res.status, 200);
    assert.equal(captured.wrapUpEntered.length, 1);
    assert.equal(captured.wrapUpEntered[0].agentId, 'agent-xyz');
});

test('POST /signalwire/events/conference-status — participant-leave for moderator does NOT trigger enterWrapUp', async () => {
    captured.wrapUpEntered = [];
    const localFakes = {
        ...fakeDeps,
        resolveAgentFromRoomName: async (name: string) => name.startsWith('agent-room-') ? name.slice('agent-room-'.length) : null,
        defaultWrapUpSeconds: 30,
    } as any;
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/signalwire/events', createSignalwireEventsRouter(localFakes));

    const res = await request(localApp)
        .post('/signalwire/events/conference-status')
        .send({
            event_type: 'calling.call.conference',
            params: {
                event: 'participant-leave',
                room_name: 'agent-room-agent-xyz',
                participant: { is_moderator: true, call_id: 'sw-call-2' },
            },
        });

    assert.equal(res.status, 200);
    assert.equal(captured.wrapUpEntered.length, 0, 'moderator leave does not trigger wrap-up');
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/signalwire-events.test.ts 2>&1 | tail -15
```

Expected: 404 from missing route AND missing dep `resolveAgentFromRoomName`.

- [ ] **Step 3: Add the route + deps**

In `backend/src/routes/signalwire-events.ts`, extend `SignalwireEventsDeps` interface:

```typescript
export interface SignalwireEventsDeps {
    // ... existing fields ...
    resolveAgentFromRoomName: (roomName: string) => Promise<string | null>;
    defaultWrapUpSeconds: number;
}
```

Add the default impl near other defaults:

```typescript
async function defaultResolveAgentFromRoomName(roomName: string): Promise<string | null> {
    // Phase 3c rooms are named `agent-room-<agentId>`. Strip prefix to get the id.
    if (!roomName.startsWith('agent-room-')) return null;
    return roomName.slice('agent-room-'.length);
}
```

Add it to `defaultDeps`:

```typescript
const defaultDeps: SignalwireEventsDeps = {
    // ... existing entries ...
    resolveAgentFromRoomName: defaultResolveAgentFromRoomName,
    defaultWrapUpSeconds: 30,
};
```

Inside `createSignalwireEventsRouter`, add the new route:

```typescript
router.post('/conference-status', async (req: Request, res: Response): Promise<void> => {
    const body = req.body || {};
    const params = body.params || {};
    const event = String(params.event || '');
    const roomName = String(params.room_name || '');
    const participant = params.participant || {};
    const isModerator = !!participant.is_moderator;

    // Only act on participant-leave for non-moderator (= customer leg leaving).
    // Moderator leaves correspond to agent going offline; that's handled by
    // useAgentRoom hangup directly, not via this webhook.
    if (event === 'participant-leave' && !isModerator) {
        const agentId = await deps.resolveAgentFromRoomName(roomName);
        if (agentId) {
            await deps.enterWrapUp(agentId, deps.defaultWrapUpSeconds);
        }
    }

    res.json({ status: 'ok' });
});
```

- [ ] **Step 4: Tests pass**

```bash
cd backend && npx tsx --test src/test/signalwire-events.test.ts 2>&1 | tail -10
```

Expected: existing tests + 2 new tests all pass.

- [ ] **Step 5: Wire conference-level status_url into the agent-room SWML**

The conference fires events to whatever URL is configured as `status_url` on the join_room verb. Update `agentRoomSwml` to set this. In `backend/src/services/swml/builder.ts`:

```typescript
export interface AgentRoomParams {
    agentId: string;
    statusUrl?: string;  // ← NEW: optional conference-level callback URL
}

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
        sections: { main: [{ answer: {} }, { join_room: joinRoom }, { hangup: {} }] },
    };
}
```

Add a corresponding test that verifies status_url is passed through.

In the SWML route handler, supply the status_url:

```typescript
router.post('/agent-room/:agentId', (req: Request, res: Response): void => {
    // ... existing sig verification ...
    const statusUrl = `${config.publicUrls.backend}/signalwire/events/conference-status`;
    res.json(agentRoomSwml({ agentId, statusUrl }));
});
```

- [ ] **Step 6: Run full suite + tsc**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
cd backend && npm test 2>&1 | tail -10
```

Expected: tsc clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/swml/builder.ts backend/src/routes/swml.ts backend/src/routes/signalwire-events.ts backend/src/test/swml-builder.test.ts backend/src/test/signalwire-events.test.ts
git commit -m "$(cat <<'EOF'
feat(wrap-up): conference-status webhook fires enterWrapUp on customer leave

Phase 3b's per-call status_url never fired (see parked work in handoff).
Phase 3c rooms emit conference-level callbacks which are documented
to be more reliable. agentRoomSwml passes status_url to the join_room
verb; the new /signalwire/events/conference-status handler resolves
the agentId from the room name and calls enterWrapUp on participant-leave
(non-moderator only — moderator leaves are agent-going-offline, not
end-of-call).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6: Deploy + smoke

### Task 11: Deploy + smoke against the test cell

- [ ] **Step 1: Deploy backend + frontend**

```bash
cd backend && railway up backend --path-as-root --service backend --ci
cd frontend && railway up frontend --path-as-root --service frontend --ci
```

Wait for healthy:

```bash
until curl -s -m 10 https://backend-production-e2bf.up.railway.app/health | grep -q '"status":"ok"'; do sleep 5; done; echo "backend healthy"
```

- [ ] **Step 2: Set environment variable**

```bash
railway variables set --service backend SWML_URL_SIGNING_SECRET="$(openssl rand -hex 32)"
```

(Re-deploys once you set this; wait for healthy again.)

- [ ] **Step 3: Pre-smoke prep**

```bash
cd backend
railway run npx tsx scripts/reset-smoke-numbers.ts
railway run npx tsx scripts/seed-cell-only.ts
AGENT_EMAIL=dominic@exec-strategy.com STATUS=offline railway run npx tsx scripts/reset-agent-status.ts
```

Note: agent stays `offline` until the user logs into the dialer — otherwise the worker dispatches before the user is in a room.

- [ ] **Step 4: Live smoke walkthrough**

1. Open the dialer in **one** browser tab. Hard refresh.
2. Log in as `dominic@exec-strategy.com / TempPass2026`.
3. Watch the page header: should show "Softphone connected. Real-time live. Bridge connecting..." → "Bridge ready" within ~3-5 seconds.
4. In a second terminal, flip the agent to available so the worker dispatches:
   ```bash
   curl -X PATCH "https://backend-production-e2bf.up.railway.app/api/agents/692a690e-770d-43bb-a151-8ec163141281/status" \
     -H "Authorization: Bearer <YOUR_SUPABASE_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"status":"available"}'
   ```
   (Or simply click the "Available" status button in the dialer UI if one exists.)
5. The cell `+18327979834` should ring within ~5s. Answer the cell.
6. **Time it.** Audio should bridge in <500ms (target). 1-2s = marginal. 3+s = something's off.
7. Hang up the cell. Watch dialer:
   - Wrap-up panel should appear within ~1s (conference-status webhook firing enterWrapUp).
   - 30s countdown ticks.
   - Auto-resume to `available`.
8. Watch the page header: "Bridge ready" should remain throughout (room stays alive across wrap-up).
9. Click "Break" (or whatever button toggles status to break). Watch:
   - Page header: "Bridge connecting..." disappears.
   - Backend Railway logs: should show `participant-leave` for the agent (moderator) at the conference-status URL.

- [ ] **Step 5: Smoke verification queries**

Pull DB state to confirm wrap-up actually fired:

```bash
cd backend && railway run npx tsx scripts/inspect-recent-call.ts
```

Expected: `Profile.status` flipped to `wrap-up` then back to `available` (or whatever your final state was).

```bash
railway logs --service backend | grep -iE "conference-status|participant-leave|enterWrapUp"
```

Expected: actual event entries from SignalWire (vs. the empty result from Phase 3b's parked status_url issue).

- [ ] **Step 6: If audio is still cold**

If you observed >1s of post-answer dial-tone:

- The room may not have been warm. Check page header — was "Bridge ready" showing?
- The customer leg may have hit the cold-bridge fallback. Check Railway logs for `connect: /private/<ref>` invocation vs. `join_room`.
- This means H1 was correctly validated in Phase 0 but a real-world variable is biting. File as a bug, do NOT roll back — system is at parity with Phase 3b state.

- [ ] **Step 7: Commit any smoke-derived fixes**

If smoke surfaced bugs, fix them and commit. Otherwise no commit needed for this task.

---

## Phase 7: Shipped handoff

### Task 12: Write Phase 3c shipped handoff

**Files:**
- Create: `docs/superpowers/context-handoffs/2026-04-XX-phase-3c-shipped.md`

- [ ] **Step 1: Write the handoff**

Use `2026-04-30-phase-3b-shipped.md` as the structural template. Sections to include:

- TL;DR (status: shipped, branch state, test count delta, key metric: post-answer-to-audio measured)
- Final commit list on branch
- Architecture (live in code) — quote the lifecycle table from the spec
- Live state in prod (URLs, what's now automatic)
- Known caveats (e.g., conference status_url reliability — was it solid in smoke?)
- Test count progression
- Phase 3d notes (inbound popup-vs-auto-connect direction)
- Resume instruction for the next session

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/context-handoffs/2026-04-XX-phase-3c-shipped.md
git commit -m "$(cat <<'EOF'
docs(phase-3c): handoff — WebRTC pre-warm shipped, post-answer-to-audio at <Nms>

Per-agent SignalWire room keeps PC warm while Profile.status='available'.
Customer legs join_room into the warm room → instant audio bridge.
Manual outbound also rebuilt on the same primitive.

Smoke results: <fill in>. Phase 3d (inbound rebuild) deferred.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Update project memory**

Append to `C:\Users\Elite Portfolio Mgmt\.claude\projects\C--\memory\project_elitedial.md` so the next session knows where things stand:

```markdown
## Phase 3c state (shipped 2026-04-XX)

[Brief description of what shipped, current branch state, post-answer-to-audio measured.]
```

- [ ] **Step 4: Decide on merge**

If smoke is green and Phase 3b + 3c are both stable on `feat/phase-3b-wrap-up`, merge to `main` and tag `phase-3c`. If still iterating, hold the branch.

---

## Self-review

**Spec coverage:**
- ✅ Goal: post-answer-to-audio <500ms — tasks 1-9 implement; task 11 verifies
- ✅ Never degrade: cold-bridge fallback in tasks 7+9
- ✅ No new permanent state: room lifecycle from Profile.status only
- ✅ Cost increase bounded: design-time, no implementation toggle needed
- ✅ Backwards compatibility: tasks 7-8 (power-dial), task 9 (manual outbound), inbound untouched
- ✅ Lifecycle (status-aligned): Tasks 5+6 (`useAgentRoom` hook + dashboard mount)
- ✅ Primitives (`join_room` etc.): Tasks 1, 7, 9
- ✅ Bridge flow change: Tasks 7-9
- ✅ `agentRoomSwml` builder: Task 1
- ✅ `/swml/agent-room/:agentId` route: Task 3
- ✅ `useAgentRoom` hook: Task 5
- ✅ Dashboard mount: Task 6
- ✅ `originateAgentBrowserCall` modification: Task 9
- ✅ Conference-status webhook (optional but recommended): Task 10
- ✅ Failure modes (race, network, refresh, debounce): all in Task 5 hook impl
- ✅ Phase 0 spike: Task 0 mandatory gate, with explicit pivot path documented
- ✅ Cost model: design-time only, no implementation step required
- ✅ Open questions: signed URL (Task 2-3), conference status_url reliability (Task 10 + 11 smoke validation)
- ✅ Migration plan steps 1-7: tasks 1-12 cover all phases

**Placeholder scan:** none. All `<placeholder>` style references in the migration plan have been turned into actual tasks with code.

**Type consistency:**
- `agentRoomSwml({ agentId, statusUrl? })` — defined Task 1, extended Task 10. Consistent.
- `powerDialDetectSwml` adds `agentId` — defined Task 7, used Task 8. Consistent.
- `originateAgentBrowserCall` adds `agentId` — defined Task 9, callers updated Task 9. Consistent.
- `signAgentRoomUrl` / `verifyAgentRoomSignature` — defined Task 2, used Task 3. Consistent.
- `useAgentRoom` returns `{ inRoom, roomError }` — defined Task 5, consumed Task 6. Consistent.

Plan is internally consistent and self-contained.
