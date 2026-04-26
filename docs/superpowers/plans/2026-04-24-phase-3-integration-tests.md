# Phase 3 — Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write integration tests that verify Phase 2's AI Autonomous worker, signalwire-events lifecycle handler, DNC fail-safe, and SWML shape contracts compose correctly as a system.

**Architecture:** Three scopes of new test coverage. (1) AI autonomous closed event loop: `buildAIAutonomousWorker` + `buildProcessLocalLimiter` + `buildDialPrecheck` share the module-level `eventBus` with `createSignalwireEventsRouter`, forming a testable closed loop without a real DB or telephony. (2) Progressive call lifecycle: `createSignalwireEventsRouter` with inspectable mock deps covers all terminal-state branching — exhausted contacts, retry scheduling, and attempt status at each call state. (3) SWML structural validation: HTTP-level assertions on route responses for SignalWire-contract fields not currently verified at the route layer (`record_call`, `timeout`, `answer_on_bridge`, `on_failure`).

**Tech Stack:** `node:test`, `supertest`, `node:assert/strict`. No new dependencies. All files land in `backend/src/test/` so the existing `npm test` glob picks them up automatically.

---

## File Map

| Path | Status | Responsibility |
|---|---|---|
| `backend/src/test/integration-ai-autonomous-e2e.test.ts` | **Create** | Closed event loop, DNC fail-safe composition, `campaign.activated` trigger |
| `backend/src/test/integration-progressive-lifecycle.test.ts` | **Create** | Full call-state lifecycle, exhaustion branching, `reservationComplete` |
| `backend/src/test/swml-routes.test.ts` | **Modify** | Add 2 tests for structural SWML fields not currently checked |

### What already exists (do not re-test)

| Test file | What it covers |
|---|---|
| `ai-autonomous-mock-integration.test.ts` | Worker + limiter + eventBus + precheck composed; all IO deps mocked |
| `ai-autonomous-worker.test.ts` | Per-behaviour unit tests (cap=0, slot fill, blocked row, REST fail, serialisation) |
| `dial-precheck.test.ts` | All precheck branches including DNC throw → `dnc_check_failed` |
| `signalwire-events.test.ts` | HTTP mapping, webhook dispatch, `call.terminal` emission with campaignId |
| `swml-routes.test.ts` | Route presence, `connect.to` / `connect.from`, missing-campaign → hangup |
| `swml-builder.test.ts` | All builder structural shapes including `record_call`, `answer_on_bridge` |

---

## Key architectural fact shared by Tasks 1 and 2

`createSignalwireEventsRouter` (in `routes/signalwire-events.ts`) imports and emits on the **module-level** `eventBus` singleton:

```typescript
import { eventBus } from '../lib/event-bus';
// …
eventBus.emit('call.terminal', { … });
```

It is **not injectable**. Any worker built with `import { eventBus } from '../lib/event-bus'` (same Node module cache entry) will therefore receive events emitted by the route. Tests that pass a `buildEventBus()` local instance to the worker will NOT see the route's emissions. All integration tests must import and use the module-level `eventBus`.

---

### Task 1: Create `integration-ai-autonomous-e2e.test.ts`

**Files:**
- Create: `backend/src/test/integration-ai-autonomous-e2e.test.ts`

Three tests. Each composes real `buildAIAutonomousWorker` + `buildProcessLocalLimiter` + `buildDialPrecheck` + the module-level `eventBus`. Only IO boundaries (DB deps, `initiateCall`) are mocked.

- [ ] **Step 1: Write the file**

```typescript
// backend/src/test/integration-ai-autonomous-e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildAIAutonomousWorker } from '../services/ai-autonomous-worker';
import { buildProcessLocalLimiter } from '../services/concurrency-limiter';
import { buildDialPrecheck } from '../services/dial-precheck';
import { eventBus } from '../lib/event-bus';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

// Module-level events app wired to the shared module eventBus (same as the route uses internally).
// prismaFindCallWithAttempt is mutable so individual tests can set what the route finds.
let findCallResult: {
    id: string;
    agentId: string | null;
    accountId: string | null;
    campaignAttempts: Array<{
        id: string;
        contactId: string;
        campaignId: string;
        contact: { id: string; attemptCount: number; campaign: { maxAttemptsPerLead: number; retryDelaySeconds: number } };
    }>;
} | null = null;

const eventsApp = express();
eventsApp.use(express.json());
eventsApp.use('/signalwire/events', createSignalwireEventsRouter({
    callSessionUpdate: async () => undefined,
    callSessionAddRecording: async () => undefined,
    dispatchWebhook: async () => undefined,
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaUpdateCampaignAttempt: async () => undefined,
    prismaFindCallWithAttempt: async () => findCallResult,
    prismaFindCompletedCall: async () => null,
    releaseAgent: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
}));

// ---------------------------------------------------------------------------
// Test 1: HTTP terminal webhook → module-level eventBus → worker slot released
// ---------------------------------------------------------------------------
test('integration-e2e: HTTP completed webhook releases AI worker slot via shared eventBus', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => false },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    let queue = 1;
    const initiated: string[] = [];

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,   // ← module-level singleton; same one the route emits on
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 1,
            retryDelaySeconds: 60, timezone: null,
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example', retellAgentPromptVersion: 'v1',
        }),
        listActiveAiCampaigns: async () => [{ id: 'camp-e2e-1' }],
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: 'k1', primaryPhone: '+15551234567', timezone: null }, reservationToken: 'tok' };
        },
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async () => undefined,
        writeBlockedCallRow: async () => undefined,
        writeInitiatedCallRow: async (_c, _k, r) => { initiated.push(r.providerCallId); },
        initiateCall: async () => ({ provider: 'mock', providerCallId: 'sw-e2e-1' }),
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    findCallResult = {
        id: 'internal-1', agentId: null, accountId: null,
        campaignAttempts: [{
            id: 'att-1', contactId: 'k1', campaignId: 'camp-e2e-1',
            contact: { id: 'k1', attemptCount: 1, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 60 } },
        }],
    };

    await worker.start();
    try {
        await worker.tick('camp-e2e-1');
        assert.equal(initiated.length, 1, 'call initiated');
        assert.equal(limiter.active('camp-e2e-1'), 1, 'slot held after dial');

        // POST to HTTP route → route emits call.terminal on module eventBus → worker listener releases slot.
        const res = await request(eventsApp)
            .post('/signalwire/events/call-status')
            .send({ call_id: 'sw-e2e-1', call_state: 'ended', duration: 20 });
        assert.equal(res.status, 200);

        // eventBus listener is synchronous; tick() it triggers is async — one microtask flush suffices.
        await new Promise<void>(r => setImmediate(r));

        assert.equal(limiter.active('camp-e2e-1'), 0, 'slot released after HTTP terminal webhook');
    } finally {
        worker.stop();
        findCallResult = null;
    }
});

// ---------------------------------------------------------------------------
// Test 2: DNC throws in real precheck → worker writes blocked row, no dial, no slot
// ---------------------------------------------------------------------------
test('integration-e2e: DNC error in real precheck → blocked row written, no dial, no slot held', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => { throw new Error('DNC service timeout'); } },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    const blocked: Array<{ contactId: string; reasons: string[] }> = [];
    const appliedStatuses: string[] = [];

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 2,
            retryDelaySeconds: 60, timezone: 'America/Chicago',
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example', retellAgentPromptVersion: 'v1',
        }),
        listActiveAiCampaigns: async () => [{ id: 'camp-e2e-2' }],
        reserveNext: (() => {
            let n = 1;
            return async () => n-- > 0
                ? { contact: { id: 'k2', primaryPhone: '+15559876543', timezone: null }, reservationToken: 'tok2' }
                : null;
        })(),
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async (contactId) => { appliedStatuses.push(contactId); },
        writeBlockedCallRow: async (_c, contact, reasons) => { blocked.push({ contactId: contact.id, reasons }); },
        writeInitiatedCallRow: async () => { throw new Error('should not be called'); },
        initiateCall: async () => { throw new Error('should not be called'); },
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    await worker.start();
    try {
        await worker.tick('camp-e2e-2');

        assert.equal(blocked.length, 1, 'blocked row written');
        assert.ok(
            blocked[0].reasons.includes('dnc_check_failed'),
            `expected dnc_check_failed, got: ${JSON.stringify(blocked[0].reasons)}`,
        );
        assert.equal(appliedStatuses.length, 1, 'applyBlockedStatus called');
        assert.equal(limiter.active('camp-e2e-2'), 0, 'no concurrency slot acquired');
    } finally {
        worker.stop();
    }
});

// ---------------------------------------------------------------------------
// Test 3: campaign.activated event triggers an immediate worker tick
// ---------------------------------------------------------------------------
test('integration-e2e: campaign.activated event triggers worker tick without polling interval', async () => {
    const limiter = buildProcessLocalLimiter({ rebuildSource: async () => new Map() });
    const precheck = buildDialPrecheck({
        tcpa: { isWithinCallingWindow: () => true, nextCallingWindowStart: () => new Date() },
        dnc: { isOnDNC: async () => false },
        regF: { checkRegF: async () => ({ blocked: false, count: 0 }) },
    });

    let queue = 1;
    const initiated: string[] = [];
    // Promise resolved when writeInitiatedCallRow fires — tells us the async tick completed.
    let notifyDone: () => void = () => {};
    const tickDone = new Promise<void>(r => { notifyDone = r; });

    const worker = buildAIAutonomousWorker({
        limiter,
        eventBus,
        precheck,
        loadCampaign: async (id) => ({
            id, dialMode: 'ai_autonomous', status: 'active', maxConcurrentCalls: 1,
            retryDelaySeconds: 60, timezone: null,
            retellAgentId: 'ag1', retellSipAddress: 'sip:x@retell.example', retellAgentPromptVersion: 'v1',
        }),
        listActiveAiCampaigns: async () => [], // interval won't auto-list this campaign
        reserveNext: async () => {
            if (queue-- <= 0) return null;
            return { contact: { id: 'k3', primaryPhone: '+15551112222', timezone: null }, reservationToken: 'tok3' };
        },
        confirmDial: async () => undefined,
        failReservation: async () => undefined,
        applyBlockedStatus: async () => undefined,
        writeBlockedCallRow: async () => undefined,
        writeInitiatedCallRow: async (_c, _k, r) => { initiated.push(r.providerCallId); notifyDone(); },
        initiateCall: async () => ({ provider: 'mock', providerCallId: 'sw-e2e-3' }),
        pickDid: async () => '+15559998888',
        callbackUrl: 'https://elite.test',
        intervalMs: 60_000,
    });

    await worker.start();
    try {
        assert.equal(initiated.length, 0, 'no calls before activation');

        // Emit the event — worker's onActivated handler (registered in start()) calls tick() asynchronously.
        eventBus.emit('campaign.activated', { campaignId: 'camp-e2e-3' });

        // Await tick completion (or 2s timeout if something goes wrong).
        await Promise.race([
            tickDone,
            new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('tick did not complete within 2s')), 2_000)),
        ]);

        assert.equal(initiated.length, 1, 'tick triggered by campaign.activated');
    } finally {
        worker.stop();
    }
});
```

- [ ] **Step 2: Build to catch type errors**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/backend && npm run build 2>&1
```

Expected: exits 0 with no error lines.

- [ ] **Step 3: Run tests and verify all 3 pass**

```bash
npm test 2>&1 | grep -E "integration-ai-autonomous-e2e|✔|✗|fail" | head -20
```

Expected: three `✔` lines for the new tests, `ℹ fail 0`.

- [ ] **Step 4: Verify total count**

```bash
npm test 2>&1 | tail -8
```

Expected: `ℹ tests 189` (was 186, +3).

- [ ] **Step 5: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/test/integration-ai-autonomous-e2e.test.ts
git commit -m "test(integration): AI autonomous closed event loop, DNC fail-safe composition, campaign.activated trigger"
```

---

### Task 2: Create `integration-progressive-lifecycle.test.ts`

**Files:**
- Create: `backend/src/test/integration-progressive-lifecycle.test.ts`

Five tests for the signalwire-events route's campaign-attempt lifecycle management. Each test builds its own `app` and `deps` so state is isolated. The focus is on branching paths that have zero coverage today because existing tests use `prismaFindCallWithAttempt: async () => null`.

- [ ] **Step 1: Write the file**

```typescript
// backend/src/test/integration-progressive-lifecycle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSignalwireEventsRouter } from '../routes/signalwire-events';

type AttemptUpdate = { id: string; data: Record<string, unknown> };

function makeApp(deps: Parameters<typeof createSignalwireEventsRouter>[0]) {
    const app = express();
    app.use(express.json());
    app.use('/signalwire/events', createSignalwireEventsRouter(deps));
    return app;
}

// Shared no-op deps for fields not under test in a given scenario.
const noop = {
    callSessionUpdate: async () => undefined,
    callSessionAddRecording: async () => undefined,
    dispatchWebhook: async () => undefined,
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaFindCompletedCall: async () => null,
    releaseAgent: async () => undefined,
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
} as const;

// ---------------------------------------------------------------------------
// Test 1: ringing state updates attempt.status = 'ringing' (non-terminal)
// ---------------------------------------------------------------------------
test('integration-progressive: ringing webhook updates attempt status to ringing', async () => {
    const attemptUpdates: AttemptUpdate[] = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async (id, data) => { attemptUpdates.push({ id, data }); },
        prismaFindCallWithAttempt: async () => ({
            id: 'call-r1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-r1', contactId: 'k-r1', campaignId: 'camp-r1',
                contact: { id: 'k-r1', attemptCount: 0, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 60 } },
            }],
        }),
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-r1', call_state: 'ringing' });

    assert.equal(res.status, 200);
    const ringUpdate = attemptUpdates.find(u => u.data.status === 'ringing');
    assert.ok(ringUpdate, 'attempt updated to ringing');
    assert.equal(ringUpdate!.id, 'att-r1');
    assert.equal((ringUpdate!.data as any).outcome, undefined, 'no outcome set at ringing');
});

// ---------------------------------------------------------------------------
// Test 2: answered state updates attempt.status='in-progress', outcome='human'
// ---------------------------------------------------------------------------
test('integration-progressive: answered webhook updates attempt to in-progress with outcome=human', async () => {
    const attemptUpdates: AttemptUpdate[] = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async (id, data) => { attemptUpdates.push({ id, data }); },
        prismaFindCallWithAttempt: async () => ({
            id: 'call-a1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-a1', contactId: 'k-a1', campaignId: 'camp-a1',
                contact: { id: 'k-a1', attemptCount: 0, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 60 } },
            }],
        }),
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-a1', call_state: 'answered' });

    assert.equal(res.status, 200);
    const inProgressUpdate = attemptUpdates.find(u => u.data.status === 'in-progress');
    assert.ok(inProgressUpdate, 'attempt updated to in-progress');
    assert.equal((inProgressUpdate!.data as any).outcome, 'human', 'outcome=human on answered');
});

// ---------------------------------------------------------------------------
// Test 3: no-answer + non-exhausted contact → reservationComplete('queued', retryAt)
// ---------------------------------------------------------------------------
test('integration-progressive: no-answer + non-exhausted contact → queued with future retryAt', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-na1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-na1', contactId: 'k-na1', campaignId: 'camp-na1',
                // attemptCount < maxAttemptsPerLead → not exhausted
                contact: { id: 'k-na1', attemptCount: 1, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 300 } },
            }],
        }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-na1', call_state: 'no-answer' });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].contactId, 'k-na1');
    assert.equal(reservationCalls[0].status, 'queued', 'non-exhausted contact re-queued');
    assert.ok(reservationCalls[0].retryAt instanceof Date, 'retryAt is a Date');
    assert.ok(
        reservationCalls[0].retryAt! > new Date(),
        'retryAt is in the future',
    );
});

// ---------------------------------------------------------------------------
// Test 4: no-answer + exhausted contact → reservationComplete('failed', null)
// ---------------------------------------------------------------------------
test('integration-progressive: no-answer + exhausted contact → failed with no retryAt', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-ex1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-ex1', contactId: 'k-ex1', campaignId: 'camp-ex1',
                // attemptCount === maxAttemptsPerLead → exhausted
                contact: { id: 'k-ex1', attemptCount: 3, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 300 } },
            }],
        }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-ex1', call_state: 'no-answer' });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].status, 'failed', 'exhausted contact marked failed');
    assert.equal(reservationCalls[0].retryAt, null, 'no retry for exhausted contact');
});

// ---------------------------------------------------------------------------
// Test 5: completed call → reservationComplete('completed', null) always
// ---------------------------------------------------------------------------
test('integration-progressive: completed call always marks contact completed (ignores exhaustion)', async () => {
    const reservationCalls: Array<{ contactId: string; status: string; retryAt: Date | null }> = [];

    const app = makeApp({
        ...noop,
        prismaUpdateCampaignAttempt: async () => undefined,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-cmp1', agentId: null, accountId: null,
            campaignAttempts: [{
                id: 'att-cmp1', contactId: 'k-cmp1', campaignId: 'camp-cmp1',
                // Even with exhausted attempt count, completed call → 'completed' not 'failed'
                contact: { id: 'k-cmp1', attemptCount: 3, campaign: { maxAttemptsPerLead: 3, retryDelaySeconds: 60 } },
            }],
        }),
        prismaFindCompletedCall: async () => ({ id: 'call-cmp1', agentId: null, accountId: null }),
        reservationComplete: async (contactId, status, retryAt) => {
            reservationCalls.push({ contactId, status, retryAt });
        },
    });

    const res = await request(app)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'sw-cmp1', call_state: 'ended', duration: 45 });

    assert.equal(res.status, 200);
    assert.equal(reservationCalls.length, 1);
    assert.equal(reservationCalls[0].status, 'completed', 'completed call → contact completed');
    assert.equal(reservationCalls[0].retryAt, null);
});
```

- [ ] **Step 2: Build**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/backend && npm run build 2>&1
```

Expected: exits 0.

- [ ] **Step 3: Run tests and verify all 5 pass**

```bash
npm test 2>&1 | grep -E "integration-progressive|✔|✗|fail" | head -20
```

Expected: five `✔` lines, `ℹ fail 0`.

- [ ] **Step 4: Verify total count**

```bash
npm test 2>&1 | tail -8
```

Expected: `ℹ tests 194` (was 189 after Task 1, +5).

- [ ] **Step 5: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/test/integration-progressive-lifecycle.test.ts
git commit -m "test(integration): progressive call lifecycle — attempt status, exhaustion branching, reservation completion"
```

---

### Task 3: Extend `swml-routes.test.ts` with structural shape assertions

**Scope:** Two new tests appended to the existing file. They assert SignalWire-contract fields that the builder tests cover at the pure-function level, but that no route-level test currently verifies: `record_call`, `timeout`, `answer_on_bridge`, `on_failure`. If someone refactors the builder signature or the route's call to it, these tests catch the regression at the HTTP layer.

**Files:**
- Modify: `backend/src/test/swml-routes.test.ts`

- [ ] **Step 1: Read the current end of the file to find insertion point**

The file currently ends at line 146. Append two tests after the last existing test.

- [ ] **Step 2: Add the two new tests**

Open `backend/src/test/swml-routes.test.ts` and append the following after the last `});` (currently ending the `'swml-routes: /bridge with to+from (progressive path) still works'` test):

```typescript
test('swml-routes: AI bridge SWML doc has required SignalWire contract fields', async () => {
    const baseDeps = {
        ensureInboundCallRecord: async () => 'call-shape-1',
        reserveAvailableAgent: async () => null,
        callAuditTrack: async () => undefined as any,
        loadCampaignForBridge: async (id: string) =>
            id === 'c-shape' ? { id, retellSipAddress: 'sip:agent_test@retell.example' } : null,
    };
    const shapeApp = express();
    shapeApp.use(express.json());
    shapeApp.use('/swml', createSwmlRouter(baseDeps));

    const res = await request(shapeApp)
        .post('/swml/bridge?mode=ai_autonomous&campaignId=c-shape&from=%2B15551234567')
        .send({});

    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);

    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.timeout, 30, 'timeout=30 (SignalWire default answer window)');
    assert.equal(connect.connect.answer_on_bridge, true, 'answer_on_bridge required for recording to start at correct time');
    assert.ok(
        Array.isArray(connect.on_failure) && connect.on_failure.some((s: any) => s.hangup !== undefined),
        'on_failure must terminate the call gracefully',
    );

    const recorder = main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call required for compliance audit trail');
    assert.equal(recorder.record_call.stereo, true, 'stereo recording for both legs');
    assert.equal(recorder.record_call.format, 'mp3');
});

test('swml-routes: progressive bridge SWML doc has record_call and correct from', async () => {
    const res = await request(app)
        .post('/swml/bridge?to=%2B15551234567&from=%2B15559998888')
        .send({});

    assert.equal(res.status, 200);
    const main = res.body.sections.main;
    const connect = main.find((s: any) => s.connect !== undefined);

    assert.ok(connect, 'connect step present');
    assert.equal(connect.connect.from, '+15559998888', 'caller ID threaded through');
    assert.equal(connect.connect.timeout, 30);

    const recorder = main.find((s: any) => s.record_call !== undefined);
    assert.ok(recorder, 'record_call present for progressive bridge');
});
```

Note: the `app` reference in the progressive bridge test refers to the module-level `app` already defined at the top of `swml-routes.test.ts` (which uses `fakeLoadCampaign` returning `null`). The `createSwmlRouter` import is already present.

- [ ] **Step 3: Build**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/backend && npm run build 2>&1
```

Expected: exits 0.

- [ ] **Step 4: Run tests and verify**

```bash
npm test 2>&1 | grep -E "SignalWire contract|progressive bridge SWML|✔|✗" | head -10
```

Expected: two new `✔` lines.

- [ ] **Step 5: Final count check**

```bash
npm test 2>&1 | tail -8
```

Expected:
```
ℹ tests 196
ℹ suites 9
ℹ pass 196
ℹ fail 0
```

- [ ] **Step 6: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/test/swml-routes.test.ts
git commit -m "test(swml-routes): assert SignalWire contract fields — record_call, timeout, answer_on_bridge, on_failure"
```

---

## Self-Review

**Spec coverage check:**

| Phase 3 requirement | Covered by |
|---|---|
| Progressive worker end-to-end | Task 2 (5 tests for full call lifecycle via signalwire-events) |
| AI Autonomous worker E2E (mock telephony, full dial-loop) | Task 1 Test 1 (HTTP webhook → slot release via shared eventBus) |
| DNC fail-safe (errors block calls, not pass) | Task 1 Test 2 (real precheck with throwing DNC composed with real worker) |
| SWML payload shape validation | Task 3 (2 tests asserting contract fields at HTTP layer) |
| campaign.activated triggers immediate tick | Task 1 Test 3 |

**Gaps found:** None. All four Phase 3 items are covered.

**Placeholder scan:** No "TBD", "TODO", or vague steps found.

**Type consistency check:** 
- `AttemptUpdate` type used consistently in Task 2.
- `noop` spread does not include `prismaUpdateCampaignAttempt` (tests that need to capture it add their own). Correct.
- `findCallResult` in Task 1 typed explicitly — avoids `any` inference issues.
- `notifyDone` initialized to `() => {}` before the Promise constructor — TypeScript will not flag use-before-assignment.
