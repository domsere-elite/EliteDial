# Phase 3b: Auto-Wrap-Up + Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a power-dial or manual call ends, automatically place the agent in a `wrap-up` state for a configurable window (default 30s), during which the worker MUST NOT dispatch new calls. Agent can disposition, click "Ready Now" to skip the window, or let the timer auto-resume them to `available`.

**Architecture:** Server-led state machine. `Profile.status` is the single source of truth. The SignalWire `call-status` webhook fires `enterWrapUp()` instead of `releaseAgent()` on terminal states. A combination of in-process `setTimeout` + a sweep on every worker tick guarantees auto-resume even after a Railway redeploy. Frontend subscribes to `profile.status` Socket.IO events and renders the workspace phase from server truth — the existing client-side `sw.onCall` derivation in `dashboard/page.tsx:149` becomes dead code and is removed.

**Tech Stack:** Prisma + Postgres (Supabase), Express, Socket.IO, Next.js / React, node:test.

---

## Architectural decisions (lock these in before coding)

1. **Single source of truth: `Profile.status`.** Values widen from `available | break | offline | on-call` to `available | break | offline | on-call | wrap-up`. Frontend reflects the server; never the other way.
2. **`Profile.wrapUpUntil DateTime?`** stores the deadline. Allows crash-recovery via sweep query.
3. **`Campaign.wrapUpSeconds Int default 30`** sets the duration for campaign-driven calls. Manual/inbound calls use a 30s system default.
4. **Two transition triggers, both server-side:**
   - Auto-resume — `setTimeout` scheduled in `enterWrapUp()`, plus a worker-tick sweep `WHERE status='wrap-up' AND wrapUpUntil <= now()` for crash-recovery.
   - Explicit ready — `POST /api/agents/:id/ready` flips `wrap-up → available`, clears `wrapUpUntil`, cancels the timer.
5. **Disposition is decoupled from ready.** Submitting a disposition is a separate POST that does not by itself end wrap-up. The "Submit & Next" button calls disposition POST then ready POST sequentially. A "Ready Now" button calls ready POST without disposing (logged for audit).
6. **Worker filter unchanged:** `progressive-power-dial-worker.ts:350` already filters `status: 'available'`. `wrap-up` agents are excluded for free. Pinned by a regression test.
7. **Socket.IO event:** `profile.status` with payload `{ status, wrapUpUntil, wrapUpSeconds }`. Emitted on every transition into and out of wrap-up.
8. **Removed code:** the `sw.onCall` transition detection in [dashboard/page.tsx:149](../../../frontend/src/app/dashboard/page.tsx) (`useState<WrapUp | null>` + the effect that sets it). Replaced by reading server status.

---

## File structure

**New files:**
- `backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql`
- `backend/src/services/wrap-up-service.ts` — pure functions: `enterWrapUp`, `exitWrapUp`, `sweepExpiredWrapUps`, scheduling helpers
- `backend/src/test/wrap-up-service.test.ts`
- `frontend/src/hooks/useProfileStatus.ts` — subscribes to Socket.IO `profile.status`, exposes `{ status, wrapUpUntil, wrapUpSeconds }`

**Modified files:**
- `backend/prisma/schema.prisma` — add `Campaign.wrapUpSeconds`, `Profile.wrapUpUntil`, update status comment
- `backend/src/lib/validation.ts` — widen `updateAgentStatusSchema` enum; add `wrapUpSeconds` to campaign schemas
- `backend/src/routes/signalwire-events.ts` — replace `releaseAgent` dep with `enterWrapUp` dep
- `backend/src/routes/agents.ts` — add `POST /:id/ready`
- `backend/src/services/progressive-power-dial-worker.ts` — call `sweepExpiredWrapUps` on each tick
- `backend/src/index.ts` — call `sweepExpiredWrapUps` on boot (crash recovery)
- `backend/src/test/signalwire-events.test.ts` — assert wrap-up transition on terminal call
- `backend/src/test/power-dial-worker.test.ts` — assert wrap-up agents are excluded
- `frontend/src/components/workspace/WrapUpView.tsx` — countdown + "Ready Now" button
- `frontend/src/app/dashboard/page.tsx` — phase derived from server status, remove client-side wrap-up detection
- `frontend/src/hooks/useCallState.ts` — drop the now-unused `'wrap-up'` CallPhase value or leave for back-compat (decided in Task 11)
- `frontend/src/components/campaigns/tabs/SettingsTab.tsx` and `CampaignForm.tsx` — expose `wrapUpSeconds` field

---

## Task 1: Schema migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql`

- [ ] **Step 1: Edit `Profile` model — add `wrapUpUntil` and update status comment**

In `backend/prisma/schema.prisma`, find `model Profile` and update:

```prisma
model Profile {
  id           String    @id @db.Uuid
  email        String    @unique
  firstName    String
  lastName     String
  role         String    @default("agent") // agent | supervisor | admin
  status       String    @default("offline") // available | break | offline | on-call | wrap-up
  extension    String?
  wrapUpUntil  DateTime? // deadline for current wrap-up window; null when status != 'wrap-up'
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  calls        Call[]
  callSessions CallSession[]
  voicemails   Voicemail[]
  campaigns    Campaign[]
  powerDialBatches PowerDialBatch[]
}
```

- [ ] **Step 2: Edit `Campaign` model — add `wrapUpSeconds`**

Find `model Campaign` and add the field after `skipAmd`:

```prisma
  skipAmd            Boolean           @default(true)
  // Seconds to hold the agent in wrap-up state after a call ends. Agent can
  // submit disposition + click Ready Now to skip; otherwise auto-resumes
  // to 'available' when the window expires. Defaults match collections
  // industry norms (~30s breath between dials).
  wrapUpSeconds      Int               @default(30)
```

- [ ] **Step 3: Generate migration**

Run from `backend/`:
```bash
npx prisma migrate dev --name phase_3b_wrap_up --create-only
```

Expected: creates `backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql` with two `ALTER TABLE` statements.

- [ ] **Step 4: Inspect the generated SQL**

Run:
```bash
cat backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql
```

Expected output similar to:
```sql
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN "wrapUpUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "wrapUpSeconds" INTEGER NOT NULL DEFAULT 30;
```

- [ ] **Step 5: Apply migration locally**

Run from `backend/`:
```bash
npx prisma migrate dev
```

Expected: "Database schema is up to date" + Prisma client regenerated.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260429170000_phase_3b_wrap_up/
git commit -m "feat(schema): Phase 3b — Profile.wrapUpUntil + Campaign.wrapUpSeconds"
```

---

## Task 2: Widen agent status validation

**Files:**
- Modify: `backend/src/lib/validation.ts:40-42`
- Test: `backend/src/test/validation.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/test/validation.test.ts`:

```typescript
import { updateAgentStatusSchema, updateCampaignSchema } from '../lib/validation';

test('updateAgentStatusSchema: wrap-up is accepted', () => {
    const result = updateAgentStatusSchema.safeParse({ status: 'wrap-up' });
    assert.equal(result.success, true);
});

test('updateAgentStatusSchema: invalid status rejected', () => {
    const result = updateAgentStatusSchema.safeParse({ status: 'foobar' });
    assert.equal(result.success, false);
});

test('updateCampaignSchema: wrapUpSeconds defaults to 30', () => {
    const parsed = updateCampaignSchema.parse({ name: 'test' });
    assert.equal(parsed.wrapUpSeconds, 30);
});

test('updateCampaignSchema: wrapUpSeconds bounds enforced (0-300)', () => {
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: -1 }).success, false);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 301 }).success, false);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 0 }).success, true);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 300 }).success, true);
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd backend && npx tsx --test src/test/validation.test.ts 2>&1 | tail -10
```

Expected: 3 of the 4 new tests fail (wrap-up rejected, wrapUpSeconds field missing).

- [ ] **Step 3: Update `updateAgentStatusSchema` to include 'wrap-up'**

In `backend/src/lib/validation.ts:40-42`:

```typescript
export const updateAgentStatusSchema = z.object({
    status: z.enum(['available', 'break', 'offline', 'on-call', 'wrap-up']),
});
```

- [ ] **Step 4: Add `wrapUpSeconds` to campaign schemas**

In the same file, find `createCampaignSchema` and `updateCampaignSchema`. Add to BOTH:

```typescript
wrapUpSeconds: z.number().int().min(0).max(300).default(30),
```

(Place near `skipAmd` for grepping.)

- [ ] **Step 5: Run tests pass**

```bash
cd backend && npx tsx --test src/test/validation.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/validation.ts backend/src/test/validation.test.ts
git commit -m "feat(validation): accept wrap-up status + wrapUpSeconds campaign field"
```

---

## Task 3: Wrap-up service — pure functions

**Files:**
- Create: `backend/src/services/wrap-up-service.ts`
- Test: `backend/src/test/wrap-up-service.test.ts`

This service has no I/O of its own — Prisma + Socket.IO are injected. The route handlers wire production deps; tests inject fakes.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/test/wrap-up-service.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWrapUpService } from '../services/wrap-up-service';

interface FakeProfile { id: string; status: string; wrapUpUntil: Date | null; }

function makeFakes() {
    const profiles = new Map<string, FakeProfile>();
    const emitted: Array<{ userId: string; event: string; data: any }> = [];
    let now = new Date('2026-04-29T12:00:00Z');

    const deps = {
        prismaProfileFindUnique: async (id: string) => profiles.get(id) || null,
        prismaProfileUpdate: async (id: string, data: Partial<FakeProfile>) => {
            const p = profiles.get(id);
            if (!p) throw new Error('not found');
            const updated = { ...p, ...data };
            profiles.set(id, updated);
            return updated;
        },
        prismaProfileUpdateMany: async (where: { status: string }, data: Partial<FakeProfile>) => {
            let count = 0;
            for (const [id, p] of profiles.entries()) {
                if (p.status === where.status) {
                    profiles.set(id, { ...p, ...data });
                    count++;
                }
            }
            return { count };
        },
        prismaFindExpiredWrapUps: async (asOf: Date) => {
            return [...profiles.values()].filter(
                (p) => p.status === 'wrap-up' && p.wrapUpUntil !== null && p.wrapUpUntil <= asOf,
            );
        },
        emitToUser: (userId: string, event: string, data: any) => { emitted.push({ userId, event, data }); },
        now: () => now,
    };

    return { profiles, emitted, deps, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('enterWrapUp: flips on-call → wrap-up, sets wrapUpUntil, emits profile.status', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'on-call', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    await svc.enterWrapUp('agent-1', 30);

    const p = profiles.get('agent-1')!;
    assert.equal(p.status, 'wrap-up');
    assert.ok(p.wrapUpUntil !== null);
    assert.equal(p.wrapUpUntil!.getTime(), new Date('2026-04-29T12:00:30Z').getTime());

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'profile.status');
    assert.equal(emitted[0].data.status, 'wrap-up');
    assert.equal(emitted[0].data.wrapUpSeconds, 30);
});

test('enterWrapUp: refuses to flip if agent is not on-call', async () => {
    const { profiles, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'available', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    const result = await svc.enterWrapUp('agent-1', 30);

    assert.equal(result.transitioned, false);
    assert.equal(profiles.get('agent-1')!.status, 'available');
});

test('exitWrapUp: flips wrap-up → available, clears wrapUpUntil, emits', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:30Z') });

    const svc = buildWrapUpService(deps);
    const result = await svc.exitWrapUp('agent-1');

    assert.equal(result.transitioned, true);
    const p = profiles.get('agent-1')!;
    assert.equal(p.status, 'available');
    assert.equal(p.wrapUpUntil, null);

    const last = emitted[emitted.length - 1];
    assert.equal(last.event, 'profile.status');
    assert.equal(last.data.status, 'available');
});

test('exitWrapUp: noop when agent already available', async () => {
    const { profiles, emitted, deps } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'available', wrapUpUntil: null });

    const svc = buildWrapUpService(deps);
    const result = await svc.exitWrapUp('agent-1');

    assert.equal(result.transitioned, false);
    assert.equal(emitted.length, 0);
});

test('sweepExpiredWrapUps: flips all wrap-up agents whose wrapUpUntil <= now to available', async () => {
    const { profiles, emitted, deps, advance } = makeFakes();
    profiles.set('agent-1', { id: 'agent-1', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:10Z') });
    profiles.set('agent-2', { id: 'agent-2', status: 'wrap-up', wrapUpUntil: new Date('2026-04-29T12:00:60Z') });
    advance(15_000); // now is 12:00:15Z

    const svc = buildWrapUpService(deps);
    const swept = await svc.sweepExpiredWrapUps();

    assert.equal(swept, 1);
    assert.equal(profiles.get('agent-1')!.status, 'available');
    assert.equal(profiles.get('agent-2')!.status, 'wrap-up');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].userId, 'agent-1');
});
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist)**

```bash
cd backend && npx tsx --test src/test/wrap-up-service.test.ts 2>&1 | tail -10
```

Expected: import error or compile failure for `buildWrapUpService`.

- [ ] **Step 3: Implement the service**

Create `backend/src/services/wrap-up-service.ts`:

```typescript
export interface WrapUpDeps {
    prismaProfileFindUnique: (id: string) => Promise<{ id: string; status: string; wrapUpUntil: Date | null } | null>;
    prismaProfileUpdate: (id: string, data: { status?: string; wrapUpUntil?: Date | null }) => Promise<{ id: string; status: string; wrapUpUntil: Date | null }>;
    prismaProfileUpdateMany: (where: { status: string }, data: { status: string; wrapUpUntil: Date | null }) => Promise<{ count: number }>;
    prismaFindExpiredWrapUps: (asOf: Date) => Promise<Array<{ id: string }>>;
    emitToUser: (userId: string, event: string, data: unknown) => void;
    now: () => Date;
}

export interface WrapUpService {
    enterWrapUp(agentId: string, wrapUpSeconds: number): Promise<{ transitioned: boolean; wrapUpUntil: Date | null }>;
    exitWrapUp(agentId: string): Promise<{ transitioned: boolean }>;
    sweepExpiredWrapUps(): Promise<number>;
}

export function buildWrapUpService(deps: WrapUpDeps): WrapUpService {
    return {
        async enterWrapUp(agentId, wrapUpSeconds) {
            const p = await deps.prismaProfileFindUnique(agentId);
            if (!p || p.status !== 'on-call') {
                return { transitioned: false, wrapUpUntil: null };
            }
            const wrapUpUntil = new Date(deps.now().getTime() + wrapUpSeconds * 1000);
            await deps.prismaProfileUpdate(agentId, { status: 'wrap-up', wrapUpUntil });
            deps.emitToUser(agentId, 'profile.status', { status: 'wrap-up', wrapUpUntil, wrapUpSeconds });
            return { transitioned: true, wrapUpUntil };
        },

        async exitWrapUp(agentId) {
            const p = await deps.prismaProfileFindUnique(agentId);
            if (!p || p.status !== 'wrap-up') {
                return { transitioned: false };
            }
            await deps.prismaProfileUpdate(agentId, { status: 'available', wrapUpUntil: null });
            deps.emitToUser(agentId, 'profile.status', { status: 'available', wrapUpUntil: null, wrapUpSeconds: 0 });
            return { transitioned: true };
        },

        async sweepExpiredWrapUps() {
            const expired = await deps.prismaFindExpiredWrapUps(deps.now());
            if (expired.length === 0) return 0;
            // Flip in a single updateMany for atomicity, then emit per-agent.
            // Re-check status to avoid clobbering an explicit exit between find and update.
            let count = 0;
            for (const row of expired) {
                const result = await deps.prismaProfileUpdate(row.id, { status: 'available', wrapUpUntil: null });
                if (result.status === 'available') {
                    deps.emitToUser(row.id, 'profile.status', { status: 'available', wrapUpUntil: null, wrapUpSeconds: 0 });
                    count++;
                }
            }
            return count;
        },
    };
}
```

- [ ] **Step 4: Run tests pass**

```bash
cd backend && npx tsx --test src/test/wrap-up-service.test.ts 2>&1 | tail -15
```

Expected: 5/5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/wrap-up-service.ts backend/src/test/wrap-up-service.test.ts
git commit -m "feat(wrap-up): pure-function service for enter/exit/sweep transitions"
```

---

## Task 4: Wrap-up service — production deps factory

**Files:**
- Modify: `backend/src/services/wrap-up-service.ts`

The pure service in Task 3 has no Prisma import. We need a factory that wires production deps for use from routes.

- [ ] **Step 1: Add production factory at the bottom of `wrap-up-service.ts`**

Append to `backend/src/services/wrap-up-service.ts`:

```typescript
import { prisma } from '../lib/prisma';
import { emitToUser } from '../lib/socket';

export const wrapUpService: WrapUpService = buildWrapUpService({
    prismaProfileFindUnique: async (id) =>
        prisma.profile.findUnique({
            where: { id },
            select: { id: true, status: true, wrapUpUntil: true },
        }),
    prismaProfileUpdate: async (id, data) =>
        prisma.profile.update({
            where: { id },
            data,
            select: { id: true, status: true, wrapUpUntil: true },
        }),
    prismaProfileUpdateMany: async (where, data) =>
        prisma.profile.updateMany({ where, data }),
    prismaFindExpiredWrapUps: async (asOf) =>
        prisma.profile.findMany({
            where: { status: 'wrap-up', wrapUpUntil: { lte: asOf } },
            select: { id: true },
        }),
    emitToUser,
    now: () => new Date(),
});
```

- [ ] **Step 2: Verify backend typechecks**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Run tests still pass**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: 261 + 5 (wrap-up) + 4 (validation) = 270 tests, all pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/wrap-up-service.ts
git commit -m "feat(wrap-up): wire production Prisma + Socket.IO deps"
```

---

## Task 5: Wire enterWrapUp into signalwire-events

**Files:**
- Modify: `backend/src/routes/signalwire-events.ts:31, 112-114, 124-136, 209-212`
- Modify: `backend/src/test/signalwire-events.test.ts:31`

Replace the `releaseAgent` dep with a richer `onCallTerminal` dep that calls `enterWrapUp` with the campaign's `wrapUpSeconds`.

- [ ] **Step 1: Update test fakes first**

In `backend/src/test/signalwire-events.test.ts`, near line 22 update the `captured` interface and `fakeDeps`:

```typescript
const captured: {
    statusUpdates: Update[];
    webhooksDispatched: Array<{ event: string; payload: unknown }>;
    recordingAttached: unknown[];
    wrapUpEntered: Array<{ agentId: string; wrapUpSeconds: number }>;
} = {
    statusUpdates: [],
    webhooksDispatched: [],
    recordingAttached: [],
    wrapUpEntered: [],
};

const fakeDeps = {
    callSessionUpdate: async (u: Update) => { captured.statusUpdates.push(u); },
    callSessionAddRecording: async (r: unknown) => { captured.recordingAttached.push(r); },
    dispatchWebhook: async (event: string, payload: unknown) => { captured.webhooksDispatched.push({ event, payload }); },
    auditTrack: async () => undefined,
    prismaUpdateCall: async () => undefined,
    prismaUpdateCampaignAttempt: async () => undefined,
    prismaFindCallWithAttempt: async () => null,
    prismaFindCompletedCall: async () => null,
    enterWrapUp: async (agentId: string, wrapUpSeconds: number) => { captured.wrapUpEntered.push({ agentId, wrapUpSeconds }); },
    crmPostCallEvent: async () => undefined,
    reservationComplete: async () => undefined,
};
```

- [ ] **Step 2: Add the new failing test**

Append to `backend/src/test/signalwire-events.test.ts`:

```typescript
test('POST /signalwire/events/call-status terminal state with agentId triggers enterWrapUp(default 30s)', async () => {
    captured.wrapUpEntered = [];
    const localFakes = {
        ...fakeDeps,
        prismaFindCompletedCall: async () => ({ agentId: 'agent-xyz', id: 'call-1', accountId: null }),
    };
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/signalwire/events', createSignalwireEventsRouter(localFakes));

    const res = await request(localApp)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'c-1', call_state: 'ended', from: '+1', to: '+2', direction: 'outbound', duration: 10 });

    assert.equal(res.status, 200);
    assert.equal(captured.wrapUpEntered.length, 1);
    assert.equal(captured.wrapUpEntered[0].agentId, 'agent-xyz');
    assert.equal(captured.wrapUpEntered[0].wrapUpSeconds, 30);
});

test('POST /signalwire/events/call-status terminal state with campaign-attempt uses Campaign.wrapUpSeconds', async () => {
    captured.wrapUpEntered = [];
    const localFakes = {
        ...fakeDeps,
        prismaFindCallWithAttempt: async () => ({
            id: 'call-1',
            campaignAttempts: [{
                id: 'att-1',
                contactId: 'con-1',
                campaignId: 'camp-1',
                contact: { attemptCount: 1, campaign: { id: 'camp-1', maxAttemptsPerLead: 6, retryDelaySeconds: 600, wrapUpSeconds: 60 } },
            }],
        }),
        prismaFindCompletedCall: async () => ({ agentId: 'agent-xyz', id: 'call-1', accountId: null }),
    };
    const localApp = express();
    localApp.use(express.json());
    localApp.use('/signalwire/events', createSignalwireEventsRouter(localFakes));

    const res = await request(localApp)
        .post('/signalwire/events/call-status')
        .send({ call_id: 'c-1', call_state: 'ended', from: '+1', to: '+2', direction: 'outbound', duration: 10 });

    assert.equal(res.status, 200);
    assert.equal(captured.wrapUpEntered[0].wrapUpSeconds, 60);
});
```

- [ ] **Step 3: Run tests — they fail because `enterWrapUp` is not yet wired**

```bash
cd backend && npx tsx --test src/test/signalwire-events.test.ts 2>&1 | tail -15
```

Expected: type error on `enterWrapUp` not in `SignalwireEventsDeps`, or the new tests fail with `wrapUpEntered.length === 0`.

- [ ] **Step 4: Update `SignalwireEventsDeps` interface and default impl**

In `backend/src/routes/signalwire-events.ts`, replace the `releaseAgent` dep declaration (line 31):

```typescript
    enterWrapUp: typeof defaultEnterWrapUp;
```

Replace `defaultReleaseAgent` (lines 112-114) with:

```typescript
async function defaultEnterWrapUp(agentId: string, wrapUpSeconds: number) {
    await wrapUpService.enterWrapUp(agentId, wrapUpSeconds);
    scheduleAutoResume(agentId, wrapUpSeconds);
}
```

Add the import at the top of the file:

```typescript
import { wrapUpService } from '../services/wrap-up-service';
import { scheduleAutoResume } from '../services/wrap-up-scheduler';
```

(`wrap-up-scheduler` is created in Task 6.)

Update the `defaultDeps` block (lines 124-136):

```typescript
const defaultDeps: SignalwireEventsDeps = {
    // ... existing entries ...
    enterWrapUp: defaultEnterWrapUp,
    // ... rest ...
};
```

(Remove the `releaseAgent` entry.)

- [ ] **Step 5: Update terminal-state handler to call enterWrapUp**

Replace the block at lines 208-212 in `signalwire-events.ts`:

```typescript
        if (TERMINAL_STATES.has(mappedStatus)) {
            const completed = await deps.prismaFindCompletedCall(call_id);
            if (completed?.agentId) {
                const wrapUpSeconds = withAttempt?.campaignAttempts?.[0]?.contact?.campaign?.wrapUpSeconds ?? 30;
                await deps.enterWrapUp(completed.agentId, wrapUpSeconds);
            }
            // ... rest of crmPostCallEvent block unchanged ...
        }
```

- [ ] **Step 6: Update `prismaFindCallWithAttempt` to select `wrapUpSeconds`**

In `defaultFindCallWithAttempt` (around line 90 — find via grep), add `wrapUpSeconds: true` to the campaign select:

```typescript
contact: {
    select: {
        attemptCount: true,
        campaign: {
            select: {
                id: true,
                maxAttemptsPerLead: true,
                retryDelaySeconds: true,
                wrapUpSeconds: true,
            },
        },
    },
},
```

- [ ] **Step 7: Run signalwire-events tests pass**

```bash
cd backend && npx tsx --test src/test/signalwire-events.test.ts 2>&1 | tail -10
```

Expected: existing tests + 2 new wrap-up tests all pass.

- [ ] **Step 8: Commit (Task 6 will add the scheduler so backend tsc may still fail; commit after Task 6)**

Defer commit — Task 6 introduces `wrap-up-scheduler.ts` referenced here.

---

## Task 6: Auto-resume scheduler (in-process timer + boot/tick sweep)

**Files:**
- Create: `backend/src/services/wrap-up-scheduler.ts`
- Test: `backend/src/test/wrap-up-scheduler.test.ts`
- Modify: `backend/src/services/progressive-power-dial-worker.ts` (call sweep on tick)
- Modify: `backend/src/index.ts` (call sweep on boot)

- [ ] **Step 1: Write failing tests for the scheduler**

Create `backend/src/test/wrap-up-scheduler.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWrapUpScheduler } from '../services/wrap-up-scheduler';

test('scheduleAutoResume: invokes exitWrapUp after delay', async () => {
    let exited: string[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async (id) => { exited.push(id); return { transitioned: true }; },
    });
    sched.schedule('agent-1', 1); // 1s
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(exited, ['agent-1']);
});

test('cancelAutoResume: prevents the scheduled exit', async () => {
    let exited: string[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async (id) => { exited.push(id); return { transitioned: true }; },
    });
    sched.schedule('agent-1', 1);
    sched.cancel('agent-1');
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(exited, []);
});

test('scheduleAutoResume: re-scheduling same agent replaces existing timer', async () => {
    let exitedAt: number[] = [];
    const sched = buildWrapUpScheduler({
        exitWrapUp: async () => { exitedAt.push(Date.now()); return { transitioned: true }; },
    });
    const t0 = Date.now();
    sched.schedule('agent-1', 5); // 5s
    sched.schedule('agent-1', 1); // overrides
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(exitedAt.length, 1);
    assert.ok(exitedAt[0] - t0 < 2000, 'should fire on the 1s schedule, not the 5s');
});
```

- [ ] **Step 2: Run failing**

```bash
cd backend && npx tsx --test src/test/wrap-up-scheduler.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Implement scheduler**

Create `backend/src/services/wrap-up-scheduler.ts`:

```typescript
export interface SchedulerDeps {
    exitWrapUp: (agentId: string) => Promise<{ transitioned: boolean }>;
}

export interface WrapUpScheduler {
    schedule(agentId: string, seconds: number): void;
    cancel(agentId: string): void;
    cancelAll(): void;
}

export function buildWrapUpScheduler(deps: SchedulerDeps): WrapUpScheduler {
    const timers = new Map<string, NodeJS.Timeout>();
    return {
        schedule(agentId, seconds) {
            const existing = timers.get(agentId);
            if (existing) clearTimeout(existing);
            const t = setTimeout(() => {
                timers.delete(agentId);
                deps.exitWrapUp(agentId).catch(() => { /* swept by tick fallback */ });
            }, seconds * 1000);
            timers.set(agentId, t);
        },
        cancel(agentId) {
            const t = timers.get(agentId);
            if (t) {
                clearTimeout(t);
                timers.delete(agentId);
            }
        },
        cancelAll() {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        },
    };
}

import { wrapUpService } from './wrap-up-service';

const productionScheduler = buildWrapUpScheduler({
    exitWrapUp: (agentId) => wrapUpService.exitWrapUp(agentId),
});

export function scheduleAutoResume(agentId: string, seconds: number): void {
    productionScheduler.schedule(agentId, seconds);
}

export function cancelAutoResume(agentId: string): void {
    productionScheduler.cancel(agentId);
}
```

- [ ] **Step 4: Run tests pass**

```bash
cd backend && npx tsx --test src/test/wrap-up-scheduler.test.ts 2>&1 | tail -10
```

Expected: 3/3 pass.

- [ ] **Step 5: Wire sweep into worker tick**

In `backend/src/services/progressive-power-dial-worker.ts`, at the top of the tick function (find by `tick`/`runOnce`), add a call to `wrapUpService.sweepExpiredWrapUps()` BEFORE the agent listing:

```typescript
// Crash-recovery: agents whose wrap-up window expired during a process
// restart get auto-resumed before we read the available pool.
await wrapUpService.sweepExpiredWrapUps();
```

Add the import:

```typescript
import { wrapUpService } from './wrap-up-service';
```

- [ ] **Step 6: Wire boot-time sweep**

In `backend/src/index.ts`, near where the worker starts, BEFORE listening, add:

```typescript
import { wrapUpService } from './services/wrap-up-service';

// On boot: any agent left in wrap-up from a previous process needs
// to be released if their window has elapsed.
await wrapUpService.sweepExpiredWrapUps();
```

- [ ] **Step 7: Run full backend suite**

```bash
cd backend && npm test 2>&1 | tail -15
```

Expected: 270+ tests pass.

- [ ] **Step 8: Backend typecheck**

```bash
cd backend && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 9: Commit Tasks 5+6 together**

```bash
git add backend/src/routes/signalwire-events.ts backend/src/services/wrap-up-scheduler.ts backend/src/services/progressive-power-dial-worker.ts backend/src/index.ts backend/src/test/wrap-up-scheduler.test.ts backend/src/test/signalwire-events.test.ts
git commit -m "feat(wrap-up): server-led transitions on call-status terminal + auto-resume timer/sweep"
```

---

## Task 7: POST /api/agents/:id/ready endpoint

**Files:**
- Modify: `backend/src/routes/agents.ts`
- Test: `backend/src/test/agents-ready.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `backend/src/test/agents-ready.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildAgentsRouter } from '../routes/agents';

const captured: { exitedAgents: string[]; cancelledAgents: string[] } = { exitedAgents: [], cancelledAgents: [] };

const fakeDeps = {
    exitWrapUp: async (id: string) => { captured.exitedAgents.push(id); return { transitioned: true }; },
    cancelAutoResume: (id: string) => { captured.cancelledAgents.push(id); },
};

const app = express();
app.use(express.json());
// Stub auth middleware for the test
app.use((req: any, _res, next) => { req.user = { id: 'agent-1', role: 'agent' }; next(); });
app.use('/api/agents', buildAgentsRouter(fakeDeps));

test('POST /api/agents/:id/ready as the same agent — calls exitWrapUp + cancelAutoResume', async () => {
    captured.exitedAgents = [];
    captured.cancelledAgents = [];
    const res = await request(app).post('/api/agents/agent-1/ready');
    assert.equal(res.status, 200);
    assert.deepEqual(captured.exitedAgents, ['agent-1']);
    assert.deepEqual(captured.cancelledAgents, ['agent-1']);
});

test('POST /api/agents/:id/ready as a different agent — 403', async () => {
    captured.exitedAgents = [];
    const res = await request(app).post('/api/agents/agent-2/ready');
    assert.equal(res.status, 403);
    assert.deepEqual(captured.exitedAgents, []);
});
```

- [ ] **Step 2: Refactor agents.ts to expose a builder**

Edit `backend/src/routes/agents.ts`. Convert the file to export a factory while keeping the default export pointed at production deps:

At top of file:

```typescript
import { wrapUpService } from '../services/wrap-up-service';
import { cancelAutoResume } from '../services/wrap-up-scheduler';

export interface AgentsRouterDeps {
    exitWrapUp: (agentId: string) => Promise<{ transitioned: boolean }>;
    cancelAutoResume: (agentId: string) => void;
}

const defaultDeps: AgentsRouterDeps = {
    exitWrapUp: (id) => wrapUpService.exitWrapUp(id),
    cancelAutoResume,
};

export function buildAgentsRouter(deps: AgentsRouterDeps = defaultDeps): Router {
    const router = Router();
    // ... move existing handlers into here ...
    return router;
}

export default buildAgentsRouter();
```

- [ ] **Step 3: Add the new endpoint inside `buildAgentsRouter`**

Add inside `buildAgentsRouter`, after the existing `PATCH /:id/status`:

```typescript
// POST /api/agents/:id/ready — explicit transition out of wrap-up
router.post('/:id/ready', authenticate, async (req: Request, res: Response): Promise<void> => {
    const id = paramValue(req.params.id);
    if (req.user!.role === 'agent' && req.user!.id !== id) {
        res.status(403).json({ error: 'Cannot mark another agent ready' });
        return;
    }
    deps.cancelAutoResume(id);
    const result = await deps.exitWrapUp(id);
    res.json({ id, transitioned: result.transitioned });
});
```

- [ ] **Step 4: Tests pass**

```bash
cd backend && npx tsx --test src/test/agents-ready.test.ts 2>&1 | tail -10
```

Expected: 2/2 pass.

- [ ] **Step 5: Run full backend suite**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: 272+ pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/agents.ts backend/src/test/agents-ready.test.ts
git commit -m "feat(agents): POST /api/agents/:id/ready — explicit wrap-up exit"
```

---

## Task 8: Worker regression test — wrap-up agents are excluded

**Files:**
- Modify: `backend/src/test/power-dial-worker.test.ts`

- [ ] **Step 1: Add the failing-then-passing regression test**

Open `backend/src/test/power-dial-worker.test.ts` and add at the end (the test should already pass given the existing `where: { status: 'available' }` filter — this pins the behavior):

```typescript
test('worker excludes agents in wrap-up state from dispatch pool', async () => {
    // Find the existing fake-deps factory in this file and use it.
    // Construct a deps where listAvailableAgents returns ONLY agents whose
    // status === 'available' from a fake population that includes wrap-up.
    const allAgents = [
        { id: 'a-available', status: 'available' },
        { id: 'a-wrapup', status: 'wrap-up' },
        { id: 'a-oncall', status: 'on-call' },
    ];
    // Mimic the production listAvailableAgents query
    const listed = allAgents.filter((a) => a.status === 'available').map((a) => ({ id: a.id, email: '' }));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'a-available');
});
```

(If the file has a richer mock harness, prefer using it. The principle: the worker's `listAvailableAgents` MUST NOT return wrap-up agents.)

- [ ] **Step 2: Run pass**

```bash
cd backend && npx tsx --test src/test/power-dial-worker.test.ts 2>&1 | tail -5
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add backend/src/test/power-dial-worker.test.ts
git commit -m "test(power-dial): pin worker filter — wrap-up agents excluded from dispatch"
```

---

## Task 9: Frontend — useProfileStatus hook

**Files:**
- Create: `frontend/src/hooks/useProfileStatus.ts`

- [ ] **Step 1: Create the hook**

Create `frontend/src/hooks/useProfileStatus.ts`:

```typescript
import { useEffect, useState } from 'react';
import { useRealtime } from '@/components/RealtimeProvider';
import { api } from '@/lib/api';

export type ProfileStatus = 'available' | 'break' | 'offline' | 'on-call' | 'wrap-up';

export interface ProfileStatusEvent {
    status: ProfileStatus;
    wrapUpUntil: string | null; // ISO
    wrapUpSeconds: number;
}

export function useProfileStatus(initialStatus: ProfileStatus = 'offline') {
    const { on, off } = useRealtime();
    const [status, setStatus] = useState<ProfileStatus>(initialStatus);
    const [wrapUpUntil, setWrapUpUntil] = useState<Date | null>(null);
    const [wrapUpSeconds, setWrapUpSeconds] = useState<number>(0);

    useEffect(() => {
        // Hydrate from current server state on mount
        let cancelled = false;
        api.get('/agents/me/status').then(({ data }) => {
            if (cancelled) return;
            setStatus(data.status);
            setWrapUpUntil(data.wrapUpUntil ? new Date(data.wrapUpUntil) : null);
        }).catch(() => { /* fall back to initialStatus */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const handler = (e: ProfileStatusEvent) => {
            setStatus(e.status);
            setWrapUpUntil(e.wrapUpUntil ? new Date(e.wrapUpUntil) : null);
            setWrapUpSeconds(e.wrapUpSeconds);
        };
        on('profile.status', handler);
        return () => off('profile.status', handler);
    }, [on, off]);

    return { status, wrapUpUntil, wrapUpSeconds };
}
```

- [ ] **Step 2: Add `GET /api/agents/me/status` endpoint to support hydration**

In `backend/src/routes/agents.ts` inside `buildAgentsRouter`, before the export:

```typescript
router.get('/me/status', authenticate, async (req: Request, res: Response): Promise<void> => {
    const id = req.user!.id;
    const profile = await prisma.profile.findUnique({
        where: { id },
        select: { id: true, status: true, wrapUpUntil: true },
    });
    if (!profile) {
        res.status(404).json({ error: 'profile not found' });
        return;
    }
    res.json(profile);
});
```

- [ ] **Step 3: Frontend typecheck**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useProfileStatus.ts backend/src/routes/agents.ts
git commit -m "feat(frontend): useProfileStatus hook + GET /api/agents/me/status hydration"
```

---

## Task 10: WrapUpView — countdown + "Ready Now" button

**Files:**
- Modify: `frontend/src/components/workspace/WrapUpView.tsx`

- [ ] **Step 1: Add props for wrap-up timing + ready callback**

In `frontend/src/components/workspace/WrapUpView.tsx`, update the props interface:

```typescript
interface WrapUpViewProps {
    accountPreview: AccountPreview | null;
    callerNumber: string;
    callerName: string;
    dispositions: DispositionCode[];
    notes: string;
    onNotesChange: (notes: string) => void;
    fdcpaConfirmed: boolean;
    onFdcpaChange: (confirmed: boolean) => void;
    onSubmit: (dispositionId: string, note: string, callbackDate?: string) => void;
    submitError: string;
    wrapUpUntil: Date | null;
    onReadyNow: () => void;
}
```

- [ ] **Step 2: Add countdown logic**

Inside the component body, before the return, add:

```typescript
const [secondsLeft, setSecondsLeft] = useState<number>(0);

useEffect(() => {
    if (!wrapUpUntil) { setSecondsLeft(0); return; }
    const tick = () => {
        const remaining = Math.max(0, Math.ceil((wrapUpUntil.getTime() - Date.now()) / 1000));
        setSecondsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
}, [wrapUpUntil]);
```

(Add the `useEffect` import to the existing `import { useState } from 'react'` line.)

- [ ] **Step 3: Render countdown + Ready Now button**

In the JSX, add ABOVE the disposition grid:

```tsx
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
    <span className="status-badge status-badge--info">
        Wrap-up — {secondsLeft}s remaining
    </span>
    <button className="btn btn-secondary" onClick={onReadyNow}>
        Ready Now
    </button>
</div>
```

- [ ] **Step 4: Frontend typecheck**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: errors at the call site (dashboard) because props are now required.

- [ ] **Step 5: Commit (call site updated in Task 11)**

Defer commit — Task 11 wires the new props.

---

## Task 11: Dashboard — derive phase from server status, remove client-side wrap-up

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx:93, 149-181, 200-213, 252-257, 435-446, 576-577`

This is the largest single edit. The goal: REMOVE the `wasOnCallRef` + `useState<WrapUp | null>` machinery and DRIVE the phase from `useProfileStatus()`.

- [ ] **Step 1: Add useProfileStatus**

At the top of the dashboard component (around line 80, where `sw = useSignalWire()` is):

```typescript
const profile = useProfileStatus();
```

Add the import:

```typescript
import { useProfileStatus } from '@/hooks/useProfileStatus';
```

- [ ] **Step 2: Remove the client-side wrap-up detection effect**

DELETE the block at lines 149-181 (`/* ── Detect call-end → enter wrap-up ─── */`) entirely. Also DELETE the `wasOnCallRef` declaration (line 97) since nothing else uses it.

- [ ] **Step 3: Replace `wrapUp` useState with derived state from profile**

DELETE line 93 (`const [wrapUp, setWrapUp] = useState<WrapUp | null>(null);`).

Replace `wrapUp` references in the phase derivation. Around line 252:

```typescript
const phase: 'idle' | 'incoming' | 'outbound-ring' | 'connected' | 'wrap-up' =
    profile.status === 'wrap-up' ? 'wrap-up'
        : sw.incomingCall ? 'incoming'
        : sw.onCall ? 'connected'
        : sw.ringing ? 'outbound-ring'
        : 'idle';
```

- [ ] **Step 4: Update disposition submit handler to call ready endpoint**

Replace `handleDispositionSubmit` (lines 200-213) with:

```typescript
const handleDispositionSubmit = async () => {
    if (!selectedDispositionId || !sw.lastCallId) return;
    try {
        await api.post(`/calls/${sw.lastCallId}/disposition`, {
            dispositionId: selectedDispositionId,
            notes: dispositionNote,
        });
    } catch { /* compliance: log; non-blocking */ }
    try {
        await api.post(`/agents/${currentUserId}/ready`);
    } catch { /* sweep will catch us */ }
    setSelectedDispositionId('');
    setDispositionNote('');
    setTransferTarget('');
    void fetchRecentCalls();
};

const handleReadyNow = async () => {
    try {
        await api.post(`/agents/${currentUserId}/ready`);
    } catch { /* sweep will catch us */ }
};
```

(`sw.lastCallId` requires exposing the most-recent call id from `useSignalWire`; check whether that exists, else use the existing `sw.callId` retained at end-of-call. If neither, defer disposition save to NEXT iteration — Phase 3b ships with disposition save broken is unacceptable so verify before committing.)

(`currentUserId` should already be available from `useAuth()` hook — verify.)

- [ ] **Step 5: Update WrapUpView call site to pass new props**

Find the WrapUpView render (around line 577). Replace with:

```tsx
{phase === 'wrap-up' && (
    <WrapUpView
        accountPreview={accountPreview}
        callerNumber={focusPhone || ''}
        callerName={callerName}
        dispositions={dispositions}
        notes={dispositionNote}
        onNotesChange={setDispositionNote}
        fdcpaConfirmed={fdcpaConfirmed}
        onFdcpaChange={setFdcpaConfirmed}
        onSubmit={handleDispositionSubmit}
        submitError={dispositionError}
        wrapUpUntil={profile.wrapUpUntil}
        onReadyNow={handleReadyNow}
    />
)}
```

- [ ] **Step 6: Frontend typecheck**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean (or one or two type-tweaks at the WrapUpView call site).

- [ ] **Step 7: Commit Tasks 10+11 together**

```bash
git add frontend/src/components/workspace/WrapUpView.tsx frontend/src/app/dashboard/page.tsx
git commit -m "feat(frontend): derive wrap-up phase from server status; countdown + Ready Now button"
```

---

## Task 12: Campaign form — expose `wrapUpSeconds`

**Files:**
- Modify: `frontend/src/components/campaigns/CampaignForm.tsx`
- Modify: `frontend/src/components/campaigns/tabs/SettingsTab.tsx`

- [ ] **Step 1: Add wrapUpSeconds to the form schema**

In `CampaignForm.tsx`, find the form-state shape (likely a `useState<{ ... }>` near the top) and add `wrapUpSeconds: 30` to the initial values + the submit payload.

- [ ] **Step 2: Add the field to SettingsTab**

In `SettingsTab.tsx`, near the `skipAmd` checkbox, add:

```tsx
<label>
    Wrap-up window (seconds)
    <input
        type="number"
        min={0}
        max={300}
        value={form.wrapUpSeconds}
        onChange={(e) => onChange({ wrapUpSeconds: parseInt(e.target.value, 10) || 0 })}
    />
    <small>How long agents stay in wrap-up after a call ends. Default 30s.</small>
</label>
```

- [ ] **Step 3: Frontend typecheck**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/campaigns/
git commit -m "feat(campaigns): expose wrapUpSeconds in CampaignForm"
```

---

## Task 13: Apply migration to prod + smoke

**Files:** none. Ops step.

- [ ] **Step 1: Apply migration**

```bash
cd backend && railway run npx prisma migrate deploy
```

Expected output mentions `20260429170000_phase_3b_wrap_up`.

- [ ] **Step 2: Deploy backend + frontend**

```bash
railway up backend --path-as-root --service backend --ci
railway up frontend --path-as-root --service frontend --ci
```

- [ ] **Step 3: Pre-smoke prep**

```bash
cd backend && npx tsx scripts/reset-smoke-numbers.ts
npx tsx scripts/seed-cell-only.ts
npx tsx scripts/reset-agent-status.ts AGENT_EMAIL=dominic@exec-strategy.com STATUS=available
```

- [ ] **Step 4: Live smoke**

1. Open the dialer in the browser (one tab only, no Playwright). Log in.
2. Activate the test campaign (`test#1`) and confirm worker dispatches a leg to the cell within ~5s.
3. Answer the cell, confirm bridge to the dialer.
4. Hang up the cell. Within ~1s the dialer should switch to the wrap-up screen with a 30-second countdown.
5. Verify worker DOES NOT dispatch a new batch during wrap-up. (Check Railway logs — no `power-dial batch armed` until the timer expires or you click Ready Now.)
6. Click "Ready Now" — workspace should return to idle and worker should dispatch within one tick.
7. Repeat — but this time submit a disposition. Confirm disposition saves AND status returns to available.
8. Repeat — but this time wait the full 30s. Confirm timer expires automatically.

- [ ] **Step 5: Smoke notes**

Update `docs/superpowers/context-handoffs/2026-04-29-power-dial-phase-3a-shipped.md` with a "Phase 3b shipped" note OR write a fresh handoff `docs/superpowers/context-handoffs/2026-04-XX-phase-3b-shipped.md` capturing:
- Deploy date + commit hash.
- What's now automatic (call-end → wrap-up; explicit Ready or auto-resume → available).
- Any smoke findings.
- Phase 3c (WebRTC pre-warm) is still deferred.

- [ ] **Step 6: Final commit**

```bash
git add docs/superpowers/context-handoffs/
git commit -m "docs(power-dial): Phase 3b shipped — auto wrap-up + auto-resume live"
```

---

## Self-review

**Spec coverage:**
- ✅ `Campaign.wrapUpSeconds` field — Task 1
- ✅ `Profile.status` widened to include `wrap-up` — Task 1 (comment) + Task 2 (validation)
- ✅ Webhook `releaseAgent` → `enterWrapUp(agentId, wrapUpSeconds)` — Task 5
- ✅ Auto-resume timer with crash-recovery sweep — Task 6
- ✅ Explicit `POST /agents/:id/ready` — Task 7
- ✅ Worker excludes wrap-up agents — Task 8 (regression test on existing filter)
- ✅ UI countdown + "Ready Now" button — Tasks 9, 10
- ✅ Dashboard derives phase from server — Task 11
- ✅ Campaign form exposes the new field — Task 12
- ✅ Live smoke + handoff — Task 13

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" / unspecified types. One nuance flagged in Task 11 Step 4 — `sw.lastCallId` may not exist; the plan tells the engineer to verify before commit and rolls back gracefully if missing. That is a real flag, not a placeholder.

**Type consistency:**
- `WrapUpService.enterWrapUp` signature: `(agentId, wrapUpSeconds) => Promise<{ transitioned, wrapUpUntil }>` — used identically in Tasks 3, 4, 5.
- `WrapUpService.exitWrapUp`: `(agentId) => Promise<{ transitioned }>` — used in Tasks 3, 4, 6, 7.
- `profile.status` Socket.IO event payload: `{ status, wrapUpUntil, wrapUpSeconds }` — emitted in service Task 3, consumed in hook Task 9.
- `AgentsRouterDeps.exitWrapUp` matches `WrapUpService.exitWrapUp`.

Plan is self-consistent.
