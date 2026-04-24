# Phase 0 — Dial-Mode Scope Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce EliteDial's campaign dial modes from four (`manual | preview | progressive | predictive`) to three (`manual | progressive | ai_autonomous`), delete the predictive dialer worker, simplify the dialer-guardrails module to concurrency-only, drop predictive-specific Campaign schema columns, and update backend + frontend code paths — without breaking the mock-mode flow or any surviving compliance test.

**Architecture:**
- `Campaign.dialMode` enum (String column) becomes `manual | progressive | ai_autonomous`; default changes from `"predictive"` to `"manual"`.
- `predictive-worker.ts` and its boot + route wiring are deleted. There is no new worker added in this plan — the AI Autonomous worker is Phase 2 work and is built after the SWML migration so it targets the new SWML `connect` flow directly.
- `dialer-guardrails.ts` is rewritten to a concurrency-only check: `baseConcurrentLimit = maxConcurrentCalls OR availableAgents`, with `no_available_agents` + `queue_backpressure` blocked-reasons retained. Abandon-rate math, `dialRatio`, `predictiveOverdialEnabled`, and `safe_predictive_cap` are removed.
- Predictive-specific Campaign columns (`abandonRateLimit`, `dialRatio`, `aiOverflowNumber`, `aiTargetEnabled`, `aiTarget`) are dropped via a Prisma migration. The runtime `Call.mode` / `CallSession.mode` classification vocabulary (which includes `ai_outbound`, `inbound`, etc.) is **not touched** — that's orthogonal to campaign dial modes and will be revisited if needed after Phase 2.
- Runtime "preview vs manual" distinction in `calls.ts` (`linkedContact ? 'preview' : 'manual'`) collapses to always `'manual'` — the agent clicking a contact card is still a manual dial, just one with contact metadata attached. `accountPreview` (the agent-facing debtor info card) is unrelated and is kept.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Express 4, Prisma 5.x, Zod, `node:test`, Next.js 14 / React 18 (frontend).

**Execution environment:** Work happens on a dedicated branch `phase-0-scope-cut` off `main`. Each task ends with a commit. Final task merges back to `main` and pushes.

**Decisions locked (from scoping on 2026-04-23):**
1. Three dial modes only: `manual | progressive | ai_autonomous` — no preview, no predictive.
2. AI Autonomous worker is NOT built in this plan; built post-SWML in Phase 2.
3. Predictive-specific columns dropped via Prisma migration (not left as orphans).
4. Runtime call-mode vocabulary (`Call.mode`, `CallSession.mode`) is not changed — history is preserved verbatim; new writes use the reduced runtime set (`manual | inbound | ai_outbound`).
5. AMD logic and `webhooks.ts` are NOT touched here — they are removed by the SWML migration plan (Task 5/6) which runs after Phase 0.
6. `maxConcurrentCalls` column stays and becomes the concurrency cap used by AI Autonomous in Phase 2.
7. Workspace `accountPreview` code stays untouched.

---

## File Structure (created / modified / deleted)

**Deleted files:**
- `backend/src/services/predictive-worker.ts`

**Modified files (backend):**
- `backend/src/lib/validation.ts` — update `dialMode` Zod enums (lines 116, 130), drop `abandonRateLimit`/`dialRatio` fields
- `backend/src/services/dialer-guardrails.ts` — rewritten; drop abandon-rate, drop `isPredictive` branch, drop `safe_predictive_cap`
- `backend/src/services/providers/types.ts` — `HumanCallMode` loses `preview` and `predictive`
- `backend/src/services/call-session-service.ts:13` — mode union loses `preview` and `predictive`
- `backend/src/routes/campaigns.ts` — drop `predictiveWorker` import + boot/run endpoints (lines 5, 234, 329–330); update filters (lines 214, 239) to new enum; drop `abandonRateLimit`/`dialRatio`/`predictiveOverdialEnabled` from guardrail input (lines 286–294, 300–305); update dialer-status response
- `backend/src/routes/calls.ts:161, 414` — replace `linkedContact ? 'preview' : 'manual'` with `'manual'`
- `backend/src/index.ts` — drop `import { predictiveWorker } …` (line 26) and `predictiveWorker.start()` / `.stop()` (lines 115, 123)
- `backend/prisma/schema.prisma:275` — update `dialMode` default to `"manual"` + comment; drop `abandonRateLimit`, `dialRatio`, `aiOverflowNumber`, `aiTargetEnabled`, `aiTarget` columns (lines 278, 279, 282–283, 289)

**Modified files (backend tests):**
- `backend/src/test/guardrails.test.ts` — rewritten for concurrency-only shape
- `backend/src/test/validation.test.ts:144` — change expected default from `'predictive'` to `'manual'`; add one test that `'ai_autonomous'` is accepted and `'predictive'` is rejected

**Modified files (frontend):**
- `frontend/src/components/campaigns/CampaignForm.tsx` — update `dialMode` union type (line 9), default (line 22), `<select>` options (lines 111–113); remove `dialRatio` and `abandonRateLimit` from form state (lines 11, 13, 24, 26), field validators (lines 74–75) and JSX inputs (lines 135–152)
- `frontend/src/components/campaigns/tabs/SettingsTab.tsx` — remove `dialRatio`, `abandonRateLimit` props (lines 13, 15) and their `<Row>` displays (lines 80, 82); keep `dialMode` display (line 74)
- `frontend/src/components/campaigns/tabs/OverviewTab.tsx` — remove `abandonRateLimit` props (lines 8, 28, 96); remove `safe_predictive_cap` warning-label entry (line 52)
- `frontend/src/app/dashboard/campaigns/page.tsx` — update any dial-mode filter/display that lists predictive or preview

**New files:** none. No new tests — the Phase 0 surface is subtractive.

---

## Baseline invariants

Before starting: confirm `cd backend && npm run test` shows `11 pass, 0 fail` and `cd backend && npm run typecheck` exits 0. The same commands must pass at the end of every task that touches code.

The post-plan baseline target is `8 pass` (three tests removed — `guardrails.test.ts` is rewritten in-place and still counts as one test file with approximately five tests; the removed tests are the abandon-rate and predictive-overdial branches).

---

## Task Breakdown

### Task 0: Preflight — branch setup and baseline verification

**Files:** none (environment setup)

- [ ] **Step 1: Create the Phase 0 branch from `main`**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git checkout main
git pull --rebase origin main
git checkout -b phase-0-scope-cut
```

Expected: `Switched to a new branch 'phase-0-scope-cut'`.

- [ ] **Step 2: Baseline backend build + tests**

```bash
cd backend
npm install --silent
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | tail -20
```

Expected: typecheck exits 0; tests show `# pass 11` (or similar positive pass count, 0 fail). **If either fails, stop — the baseline is broken before any Phase 0 changes. Report and do not proceed.**

- [ ] **Step 3: Baseline frontend typecheck + build**

```bash
cd ../frontend
npm install --silent
npx tsc --noEmit 2>&1 | tail -5
```

Expected: exits 0 with no errors. **If fails, stop and report.**

- [ ] **Step 4: Inventory of symbols that must vanish**

Capture the before-state so the verification sweep at the end has a concrete target:

```bash
cd ..
echo '--- predictive references (baseline) ---'
grep -rn "predictive\|PREDICTIVE" backend/src frontend/src --include='*.ts' --include='*.tsx' | wc -l
echo '--- preview-mode references (baseline, incl. unrelated accountPreview) ---'
grep -rn "'preview'\|\"preview\"" backend/src frontend/src --include='*.ts' --include='*.tsx' | wc -l
echo '--- abandonRate references (baseline) ---'
grep -rn "abandonRate\|abandon_rate\|abandonedAttempts" backend/src frontend/src --include='*.ts' --include='*.tsx' | wc -l
```

Record these three numbers in the PR description later. (No action required here beyond capture.)

- [ ] **Step 5: Commit nothing; branch is ready**

No commit at Task 0. The branch contains no changes yet.

---

### Task 1: Backend validation — collapse `dialMode` enum (TDD)

**Files:**
- Modify: `backend/src/lib/validation.ts` (lines 116, 130 — `dialMode` Zod enums; lines 119, 120, 133, 134 — remove `abandonRateLimit` + `dialRatio`)
- Modify: `backend/src/test/validation.test.ts` (line 144 — default expectation; add new tests)

- [ ] **Step 1: Write the failing tests**

Open `backend/src/test/validation.test.ts` and append these tests at the bottom of the file (after line 248 or wherever the file currently ends):

```typescript
// ─── Phase 0: new dialMode enum ───

test('createCampaignSchema: default dialMode is manual', () => {
    const result = createCampaignSchema.safeParse({ name: 'Default Mode Campaign' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'manual');
});

test('createCampaignSchema: ai_autonomous is accepted', () => {
    const result = createCampaignSchema.safeParse({ name: 'AI Campaign', dialMode: 'ai_autonomous' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'ai_autonomous');
});

test('createCampaignSchema: predictive is rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Old Campaign', dialMode: 'predictive' });
    assert.equal(result.success, false);
});

test('createCampaignSchema: preview is rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Old Campaign', dialMode: 'preview' });
    assert.equal(result.success, false);
});

test('updateCampaignSchema: predictive is rejected', () => {
    const result = updateCampaignSchema.safeParse({ dialMode: 'predictive' });
    assert.equal(result.success, false);
});
```

Also, in the existing `test('createCampaignSchema: valid with defaults', ...)` block at line 141, update the assertions to match the new defaults. Replace lines 141–148 with:

```typescript
test('createCampaignSchema: valid with defaults', () => {
    const result = createCampaignSchema.safeParse({ name: 'Test Campaign' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'manual');
    assert.equal(result.data!.timezone, 'America/Chicago');
    assert.equal(result.data!.maxAttemptsPerLead, 6);
});
```

(Note: `dialRatio` assertion removed because the field is being dropped in this task.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
npx tsx --test src/test/validation.test.ts 2>&1 | tail -30
```

Expected: multiple failures. The new tests fail because the old enum still includes `predictive`/`preview`, and the "valid with defaults" test now asserts `dialMode === 'manual'` against an actual default of `'predictive'`.

- [ ] **Step 3: Update the Zod schemas**

In `backend/src/lib/validation.ts`, replace lines 113–139 (the entire `createCampaignSchema` and `updateCampaignSchema` blocks) with:

```typescript
// ─── Campaign Schemas ────────────────────────────
export const createCampaignSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: optionalString,
    dialMode: z.enum(['manual', 'progressive', 'ai_autonomous']).optional().default('manual'),
    timezone: z.string().optional().default('America/Chicago'),
    maxAttemptsPerLead: z.number().int().min(1).max(50).optional().default(6),
    retryDelaySeconds: z.number().int().min(30).optional().default(600),
    maxConcurrentCalls: z.number().int().min(0).optional().default(0),
});

export const updateCampaignSchema = z.object({
    name: optionalString,
    description: optionalString,
    dialMode: z.enum(['manual', 'progressive', 'ai_autonomous']).optional(),
    timezone: z.string().optional(),
    maxAttemptsPerLead: z.number().int().min(1).max(50).optional(),
    retryDelaySeconds: z.number().int().min(30).optional(),
    maxConcurrentCalls: z.number().int().min(0).optional(),
});
```

This drops `abandonRateLimit`, `dialRatio`, `aiTargetEnabled`, and `aiTarget` from both schemas.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/test/validation.test.ts 2>&1 | tail -20
```

Expected: all validation tests pass. Typecheck may fail in other files that still reference dropped fields — that's OK, those are fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
cd ..
git add backend/src/lib/validation.ts backend/src/test/validation.test.ts
git commit -m "$(cat <<'EOF'
refactor(validation): collapse dialMode enum to manual|progressive|ai_autonomous

Drop abandonRateLimit, dialRatio, aiTargetEnabled, aiTarget from campaign
schemas — predictive-specific fields being removed in Phase 0 scope cut.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Simplify `dialer-guardrails.ts` (TDD)

**Files:**
- Modify: `backend/src/services/dialer-guardrails.ts` (full rewrite)
- Modify: `backend/src/test/guardrails.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite the test file for the simplified contract**

Replace the entire contents of `backend/src/test/guardrails.test.ts` with:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeDialerGuardrails,
    DIALER_STATS_WINDOW_MINUTES,
} from '../services/dialer-guardrails';

// ─── DIALER_STATS_WINDOW_MINUTES ───────────────

test('DIALER_STATS_WINDOW_MINUTES is 15', () => {
    assert.equal(DIALER_STATS_WINDOW_MINUTES, 15);
});

// ─── Progressive mode: 1 call per available agent ───

test('progressive: baseConcurrentLimit equals availableAgents when maxConcurrentCalls=0', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 5,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 5);
    assert.equal(result.effectiveConcurrentLimit, 5);
    assert.equal(result.dispatchCapacity, 5);
    assert.deepEqual(result.blockedReasons, []);
});

test('progressive: maxConcurrentCalls caps the limit when lower than agent count', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 3,
        availableAgents: 10,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 3);
    assert.equal(result.dispatchCapacity, 3);
});

test('progressive: no agents blocks with no_available_agents', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.ok(result.blockedReasons.includes('no_available_agents'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── AI Autonomous mode: maxConcurrentCalls is the cap; agents are irrelevant ───

test('ai_autonomous: uses maxConcurrentCalls directly; availableAgents ignored', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 10,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.equal(result.baseConcurrentLimit, 10);
    assert.equal(result.dispatchCapacity, 10);
    assert.ok(!result.blockedReasons.includes('no_available_agents'));
});

test('ai_autonomous: maxConcurrentCalls=0 blocks with no_concurrency_configured', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 0,
        availableAgents: 0,
        activeCalls: 0,
    });
    assert.ok(result.blockedReasons.includes('no_concurrency_configured'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Manual mode: no worker-driven dispatch expected ───

test('manual: dispatchCapacity is 0 (manual does not auto-dispatch)', () => {
    const result = computeDialerGuardrails({
        dialMode: 'manual',
        maxConcurrentCalls: 0,
        availableAgents: 5,
        activeCalls: 0,
    });
    assert.equal(result.dispatchCapacity, 0);
    assert.ok(result.blockedReasons.includes('manual_mode'));
});

// ─── Queue backpressure ───

test('queue backpressure: blocked when activeCalls >= effectiveConcurrentLimit', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 3,
        activeCalls: 3,
    });
    assert.ok(result.blockedReasons.includes('queue_backpressure'));
    assert.equal(result.dispatchCapacity, 0);
});

// ─── Queue pressure metric ───

test('queuePressure: activeCalls / availableAgents for progressive', () => {
    const result = computeDialerGuardrails({
        dialMode: 'progressive',
        maxConcurrentCalls: 0,
        availableAgents: 4,
        activeCalls: 2,
    });
    assert.equal(result.queuePressure, 0.5);
});

test('queuePressure: activeCalls / maxConcurrentCalls for ai_autonomous', () => {
    const result = computeDialerGuardrails({
        dialMode: 'ai_autonomous',
        maxConcurrentCalls: 10,
        availableAgents: 0,
        activeCalls: 4,
    });
    assert.equal(result.queuePressure, 0.4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
npx tsx --test src/test/guardrails.test.ts 2>&1 | tail -30
```

Expected: fails because (a) `GuardrailInputs` still requires `dialRatio`, `abandonRateLimit`, `recentCompletedAttempts`, `recentAbandonedAttempts`, `predictiveOverdialEnabled`; (b) new blocked-reasons `no_concurrency_configured` and `manual_mode` don't exist yet.

- [ ] **Step 3: Rewrite `dialer-guardrails.ts`**

Replace the entire contents of `backend/src/services/dialer-guardrails.ts` with:

```typescript
export type DialMode = 'manual' | 'progressive' | 'ai_autonomous';

type GuardrailInputs = {
    dialMode: DialMode | string;
    maxConcurrentCalls: number;
    availableAgents: number;
    activeCalls: number;
};

export type DialerGuardrailSummary = {
    baseConcurrentLimit: number;
    effectiveConcurrentLimit: number;
    dispatchCapacity: number;
    queuePressure: number;
    blockedReasons: string[];
    warnings: string[];
};

export const DIALER_STATS_WINDOW_MINUTES = 15;

export const computeDialerGuardrails = (input: GuardrailInputs): DialerGuardrailSummary => {
    const blockedReasons: string[] = [];
    const warnings: string[] = [];

    // Manual mode: no worker dispatch — agent initiates each call explicitly.
    if (input.dialMode === 'manual') {
        return {
            baseConcurrentLimit: 0,
            effectiveConcurrentLimit: 0,
            dispatchCapacity: 0,
            queuePressure: 0,
            blockedReasons: ['manual_mode'],
            warnings: [],
        };
    }

    let baseConcurrentLimit: number;

    if (input.dialMode === 'ai_autonomous') {
        // AI Autonomous: cap is the campaign's maxConcurrentCalls. No agents needed.
        if (input.maxConcurrentCalls <= 0) {
            blockedReasons.push('no_concurrency_configured');
        }
        baseConcurrentLimit = Math.max(0, input.maxConcurrentCalls);
    } else {
        // Progressive (default fall-through): 1 call per available agent, capped by maxConcurrentCalls if set.
        if (input.availableAgents <= 0) {
            blockedReasons.push('no_available_agents');
        }
        baseConcurrentLimit = input.availableAgents;
        if (input.maxConcurrentCalls > 0) {
            baseConcurrentLimit = Math.min(baseConcurrentLimit, input.maxConcurrentCalls);
        }
    }

    const effectiveConcurrentLimit = baseConcurrentLimit;

    if (effectiveConcurrentLimit > 0 && input.activeCalls >= effectiveConcurrentLimit) {
        blockedReasons.push('queue_backpressure');
    }

    const dispatchCapacity = blockedReasons.length > 0
        ? 0
        : Math.max(0, effectiveConcurrentLimit - input.activeCalls);

    const denominator = input.dialMode === 'ai_autonomous'
        ? input.maxConcurrentCalls
        : input.availableAgents;

    const queuePressure = denominator > 0
        ? input.activeCalls / denominator
        : (input.activeCalls > 0 ? 1 : 0);

    return {
        baseConcurrentLimit,
        effectiveConcurrentLimit,
        dispatchCapacity,
        queuePressure,
        blockedReasons,
        warnings,
    };
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/test/guardrails.test.ts 2>&1 | tail -20
```

Expected: all guardrails tests pass. Other files (`campaigns.ts`, `OverviewTab.tsx`) still reference the old fields — those are fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
cd ..
git add backend/src/services/dialer-guardrails.ts backend/src/test/guardrails.test.ts
git commit -m "$(cat <<'EOF'
refactor(guardrails): simplify to concurrency-only; add ai_autonomous + manual modes

- Drop abandon-rate tracking, predictive over-dial logic, safe_predictive_cap.
- Manual mode short-circuits to dispatchCapacity=0 with blocked_reason=manual_mode
  (agent-initiated, no worker).
- AI Autonomous uses maxConcurrentCalls directly, blocks with
  no_concurrency_configured when unset.
- Progressive is now 1:1 agents-to-calls, capped by maxConcurrentCalls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Delete `predictive-worker.ts` and all call sites

**Files:**
- Delete: `backend/src/services/predictive-worker.ts`
- Modify: `backend/src/index.ts` (lines 26, 115, 123)
- Modify: `backend/src/routes/campaigns.ts` (line 5 import; lines 234, 329–330 worker-control endpoints)

- [ ] **Step 1: Read the current index.ts boot hooks**

```bash
cd backend
grep -n "predictiveWorker" src/index.ts
```

Expected output (for reference):
```
26:import { predictiveWorker } from './services/predictive-worker';
115:    predictiveWorker.start();
123:    predictiveWorker.stop();
```

- [ ] **Step 2: Remove the import and boot calls from `index.ts`**

Delete line 26 entirely (the import). Delete line 115 (the `.start()` call) and line 123 (the `.stop()` call). Keep surrounding `app.listen` / signal-handler code intact. After the edit, `grep -n "predictiveWorker" src/index.ts` must produce no output.

- [ ] **Step 3: Remove the predictive-worker routes from `campaigns.ts`**

In `backend/src/routes/campaigns.ts`:

1. Delete line 5: `import { predictiveWorker } from '../services/predictive-worker';`

2. Find the `/dialer/status` handler (starting around line 233) and replace the line:
   ```typescript
   const worker = predictiveWorker.getStatus();
   ```
   with:
   ```typescript
   const worker = { running: false, lastRunAt: null as Date | null, note: 'deprecated' };
   ```
   (The response shape is preserved so the admin UI's dialer-status page doesn't crash. The worker concept itself is gone in Phase 0, re-introduced in a different shape in Phase 2.)

3. Find the `/dialer/run-now` POST route (around line 327–330) that calls `predictiveWorker.runNow()`. Delete the entire route handler — it's dead. The surrounding context looks like:
   ```typescript
   router.post('/dialer/run-now', authenticate, requireMinRole('supervisor'), async (_req: Request, res: Response): Promise<void> => {
       const stats = await predictiveWorker.runNow();
       res.json({ ok: true, stats, worker: predictiveWorker.getStatus() });
   });
   ```
   Remove the entire `router.post('/dialer/run-now', ...)` block.

After these edits, `grep -n "predictiveWorker" src/routes/campaigns.ts` must produce no output.

- [ ] **Step 4: Delete the worker module itself**

```bash
rm src/services/predictive-worker.ts
```

- [ ] **Step 5: Typecheck and test**

```bash
npm run typecheck 2>&1 | tail -10
npm test 2>&1 | tail -10
```

Expected: typecheck may still fail due to `campaigns.ts` referencing `abandonRateLimit`/`dialRatio` (fixed in Task 4). The guardrails + validation tests must pass. If typecheck fails on something OTHER than the known campaigns.ts references, stop and report.

- [ ] **Step 6: Commit**

```bash
cd ..
git add backend/src/services/predictive-worker.ts backend/src/index.ts backend/src/routes/campaigns.ts
git commit -m "$(cat <<'EOF'
refactor: delete predictive-worker and its boot/route wiring

Remove the service module, its start/stop hooks in index.ts, its import
and POST /campaigns/dialer/run-now route, and replace the worker.getStatus()
call in /dialer/status with a stub shape so the admin dialer-status UI
stays functional until a new worker ships in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update campaigns route to the new guardrail + enum shape

**Files:**
- Modify: `backend/src/routes/campaigns.ts` (lines 214, 239, 285–320 approx — the `/dialer/status` handler and any other `dialMode` filter)

- [ ] **Step 1: Update the `/active/next-contact` dialMode filter**

Find the line (around 214):
```typescript
dialMode: { in: ['preview', 'progressive'] },
```
Replace with:
```typescript
dialMode: 'progressive',
```

(Preview is gone; AI Autonomous dials don't reserve contacts for agents — only progressive does.)

- [ ] **Step 2: Update the `/dialer/status` dialMode filter**

Find the line (around 239):
```typescript
dialMode: { in: ['predictive', 'progressive'] },
```
Replace with:
```typescript
dialMode: { in: ['progressive', 'ai_autonomous'] },
```

- [ ] **Step 3: Remove dropped fields from the campaign select**

In the same handler, the `select:` block lists `abandonRateLimit: true` and `dialRatio: true`. Remove those two lines. The resulting select looks like:

```typescript
select: {
    id: true,
    name: true,
    dialMode: true,
    status: true,
    retryDelaySeconds: true,
    maxConcurrentCalls: true,
    _count: { select: { contacts: true, attempts: true } },
},
```

- [ ] **Step 4: Simplify the `computeDialerGuardrails` call**

Find the block (around line 285):

```typescript
const controls = computeDialerGuardrails({
    dialMode: campaign.dialMode,
    dialRatio: campaign.dialRatio,
    maxConcurrentCalls: campaign.maxConcurrentCalls,
    availableAgents,
    activeCalls: activeAttempts,
    abandonRateLimit: campaign.abandonRateLimit,
    recentCompletedAttempts,
    recentAbandonedAttempts,
    predictiveOverdialEnabled: config.dialer.mode === 'mock',
});
```

Replace with:

```typescript
const controls = computeDialerGuardrails({
    dialMode: campaign.dialMode,
    maxConcurrentCalls: campaign.maxConcurrentCalls,
    availableAgents,
    activeCalls: activeAttempts,
});
```

Also delete the two `prisma.campaignAttempt.count(...)` calls in the Promise.all that compute `recentCompletedAttempts` and `recentAbandonedAttempts` — they're no longer needed. The surrounding destructure must be updated to remove those two variables.

- [ ] **Step 5: Simplify the response shape**

In the return object (around line 297–320), remove these lines:
- `abandonRateLimit: campaign.abandonRateLimit,`
- `dialRatio: campaign.dialRatio,`
- `recentAbandonRate: controls.recentAbandonRate,`
- `recentCompletedAttempts: controls.recentCompletedAttempts,`

- [ ] **Step 6: Scan the rest of the file for residual dropped fields**

```bash
cd backend
grep -n "abandonRateLimit\|dialRatio\|predictiveOverdial\|aiTargetEnabled\|aiTarget\|aiOverflow" src/routes/campaigns.ts
```

Expected: no matches. If any remain, inspect and remove the surrounding logic. The route body at line 177 / 193 originally wrote these fields on campaign create — those bindings must also be removed.

- [ ] **Step 7: Typecheck and test**

```bash
npm run typecheck 2>&1 | tail -10
npm test 2>&1 | tail -10
```

Expected: typecheck exits 0. Tests pass (11 tests total still, since we haven't removed the Prisma columns yet — the campaigns route just stops referencing them). If typecheck fails, inspect the error — most likely an unused import (`config` may no longer be needed; remove it if so).

- [ ] **Step 8: Commit**

```bash
cd ..
git add backend/src/routes/campaigns.ts
git commit -m "$(cat <<'EOF'
refactor(routes/campaigns): adopt simplified guardrails contract and new enum

- /active/next-contact now filters on dialMode='progressive' only (preview gone).
- /dialer/status filters on progressive|ai_autonomous, drops abandon-rate
  aggregation queries and predictive-only campaign fields.
- computeDialerGuardrails call shrinks to the four-arg shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Collapse preview-mode runtime classification in `calls.ts` and provider types

**Files:**
- Modify: `backend/src/routes/calls.ts` (lines 161, 414)
- Modify: `backend/src/services/providers/types.ts` (line 1)
- Modify: `backend/src/services/call-session-service.ts` (line 13)

- [ ] **Step 1: Collapse `linkedContact ? 'preview' : 'manual'` to `'manual'`**

In `backend/src/routes/calls.ts`, at line 161 (approximate; grep for the ternary to confirm location):

Current:
```typescript
: (linkedContact ? 'preview' : 'manual');
```
Replace with:
```typescript
: 'manual';
```

At line 414 (approximate):

Current:
```typescript
const callMode = linkedContact ? 'preview' : 'manual';
```
Replace with:
```typescript
const callMode = 'manual';
```

The `linkedContact` variable itself may still be used elsewhere (for attaching contact metadata to the call record); leave it alone.

- [ ] **Step 2: Update the `HumanCallMode` type**

In `backend/src/services/providers/types.ts`, line 1:

Current:
```typescript
export type HumanCallMode = 'manual' | 'preview' | 'progressive' | 'predictive' | 'inbound';
```
Replace with:
```typescript
export type HumanCallMode = 'manual' | 'progressive' | 'inbound';
```

The `UnifiedCallMode` union on line 2 (`HumanCallMode | 'ai_outbound'`) stays as-is — `ai_outbound` remains the runtime call-mode label; this is orthogonal to Campaign.dialMode.

- [ ] **Step 3: Update the `call-session-service.ts` mode union**

At line 13:

Current:
```typescript
mode: 'manual' | 'preview' | 'progressive' | 'predictive' | 'ai_outbound' | 'inbound';
```
Replace with:
```typescript
mode: 'manual' | 'progressive' | 'ai_outbound' | 'inbound';
```

- [ ] **Step 4: Typecheck**

```bash
cd backend
npm run typecheck 2>&1 | tail -15
```

Expected: exits 0. If not, inspect the error — most likely a call-session-service consumer that passes `'preview'` or `'predictive'`; update that call site too. (Do NOT silently loosen the type back to `string`.)

- [ ] **Step 5: Test**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd ..
git add backend/src/routes/calls.ts backend/src/services/providers/types.ts backend/src/services/call-session-service.ts
git commit -m "$(cat <<'EOF'
refactor: drop 'preview' and 'predictive' from runtime call-mode unions

The 'preview' runtime classification (agent dials from a contact card) is
folded into 'manual' — same dial path, contact metadata is already carried
separately. HumanCallMode + call-session mode union lose both values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Prisma schema — drop predictive-only columns + migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (line 275 + lines 278, 279, 282–283, 289)
- Create: `backend/prisma/migrations/<timestamp>_phase_0_dial_mode_scope_cut/migration.sql` (generated by Prisma)

- [ ] **Step 1: Update the `Campaign.dialMode` field**

At line 275, change:
```prisma
dialMode           String            @default("predictive") // predictive | progressive | preview
```
to:
```prisma
dialMode           String            @default("manual") // manual | progressive | ai_autonomous
```

- [ ] **Step 2: Drop the five predictive-specific columns**

Remove these lines from the `Campaign` model (numbers approximate):
- Line 278: `abandonRateLimit   Float             @default(0.03)`
- Line 279: `dialRatio          Float             @default(3.0)`
- Line 282: `aiTargetEnabled        Boolean           @default(false)`
- Line 283: `aiTarget               String?           // Transfer number or SIP URI for AI agent`
- Line 289: `aiOverflowNumber       String?           // E.164 AI overflow number, null = use global SystemSetting`

Sanity-check by re-reading the Campaign model after edits — only keep `dialMode`, `timezone`, `maxAttemptsPerLead`, `retryDelaySeconds`, `maxConcurrentCalls`, `proximityMatchEnabled`, `autoRotateEnabled`, `maxCallsPerDIDPerDay`, `avoidRepeatDID`, `defaultDIDId`, and the relation fields.

- [ ] **Step 3: Generate and apply the migration**

```bash
cd backend
npx prisma migrate dev --name phase_0_dial_mode_scope_cut
```

Expected: Prisma generates a migration that (a) alters the `dialMode` column default, (b) drops the five columns. Review the generated SQL in `prisma/migrations/<timestamp>_phase_0_dial_mode_scope_cut/migration.sql` — it should be ~8–12 lines, no surprises. If Prisma asks to reset the database, **stop and report** — the migration should be additive/removal only, no data loss of rows.

If the local dev DB has campaign rows with `dialMode='predictive'` or `'preview'`, update them first:
```bash
# Before running migrate dev, if needed:
npx prisma studio
# or manually:
# psql $DATABASE_URL -c "UPDATE \"Campaign\" SET \"dialMode\" = 'manual' WHERE \"dialMode\" IN ('predictive', 'preview');"
```

- [ ] **Step 4: Regenerate the Prisma client**

```bash
npx prisma generate
```

Expected: client regenerates without error.

- [ ] **Step 5: Typecheck + test**

```bash
npm run typecheck 2>&1 | tail -10
npm test 2>&1 | tail -15
```

Expected: exits 0, all tests pass. Any remaining typecheck error is a code reference to a dropped field — track it down and fix; do not re-add the column.

- [ ] **Step 6: Commit**

```bash
cd ..
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "$(cat <<'EOF'
feat(schema): drop predictive-only Campaign columns; dialMode default=manual

Migration phase_0_dial_mode_scope_cut drops abandonRateLimit, dialRatio,
aiTargetEnabled, aiTarget, aiOverflowNumber. dialMode enum comment updated
to manual|progressive|ai_autonomous; default changes from 'predictive' to
'manual'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Frontend — Campaign form + tabs

**Files:**
- Modify: `frontend/src/components/campaigns/CampaignForm.tsx`
- Modify: `frontend/src/components/campaigns/tabs/SettingsTab.tsx`
- Modify: `frontend/src/components/campaigns/tabs/OverviewTab.tsx`
- Modify: `frontend/src/app/dashboard/campaigns/page.tsx`

- [ ] **Step 1: Update `CampaignForm.tsx` — type union, defaults, and select options**

Line 9, change:
```typescript
dialMode: 'predictive' | 'progressive' | 'preview';
```
to:
```typescript
dialMode: 'manual' | 'progressive' | 'ai_autonomous';
```

Line 22, change the default:
```typescript
dialMode: 'predictive',
```
to:
```typescript
dialMode: 'manual',
```

Lines 11, 13, 24, 26 — remove `dialRatio` and `abandonRateLimit` from both the type and the default values. The `CampaignFormValues` type and `DEFAULT_VALUES` object both shrink.

Lines 74–75 — remove the validator lines:
```typescript
if (values.dialRatio < 0.5 || values.dialRatio > 5.0) errs.dialRatio = 'Must be between 0.5 and 5.0';
if (values.abandonRateLimit < 0 || values.abandonRateLimit > 0.10) errs.abandonRateLimit = 'Must be between 0% and 10%';
```

Lines 111–113 — replace the select options:
```tsx
<option value="predictive">Predictive</option>
<option value="progressive">Progressive</option>
<option value="preview">Preview</option>
```
with:
```tsx
<option value="manual">Manual</option>
<option value="progressive">Progressive (1 per available agent)</option>
<option value="ai_autonomous">AI Autonomous (no agents, auto-bridge to AI)</option>
```

Lines 135–152 — remove the `<input>` blocks for `dialRatio` and `abandonRateLimit` (both the inputs and their error-display spans). The surrounding `<div>` layout may need minor cleanup.

- [ ] **Step 2: Update `SettingsTab.tsx` — drop dialRatio/abandonRate rows**

Lines 13, 15 — remove `dialRatio` and `abandonRateLimit` from the `SettingsCampaign` interface.

Lines 80, 82 — remove the two `<Row>` entries:
```tsx
<Row label="Dial Ratio" value={`${campaign.dialRatio.toFixed(1)}x`} />
<Row label="Abandon Rate Limit" value={`${(campaign.abandonRateLimit * 100).toFixed(1)}%`} />
```

Line 74 — keep the `Dial Mode` row, but update its display to be nicer:
```tsx
<Row label="Dial Mode" value={formatDialMode(campaign.dialMode)} />
```
And at the top of the file, add:
```typescript
function formatDialMode(mode: string): string {
    switch (mode) {
        case 'manual': return 'Manual';
        case 'progressive': return 'Progressive';
        case 'ai_autonomous': return 'AI Autonomous';
        default: return mode;
    }
}
```

- [ ] **Step 3: Update `OverviewTab.tsx` — drop abandon-rate UI and safe_predictive_cap label**

Lines 8, 28 — remove `abandonRateLimit` from the two interfaces. Line 96 — remove the `abandonLimit` variable and any UI that renders abandon rate vs. limit.

Line 52 — remove the entry:
```typescript
safe_predictive_cap: { tone: 'info', label: 'Over-dial disabled (config)' },
```

Also, scan the file for `safe_predictive_cap`, `abandon_rate_exceeded`, and `recentAbandonRate` usages and delete them. Add entries for the new blocked-reasons so the UI shows something useful:

```typescript
manual_mode: { tone: 'info', label: 'Manual mode — no auto-dispatch' },
no_concurrency_configured: { tone: 'warn', label: 'Set Max Concurrent Calls to start dialing' },
```

- [ ] **Step 4: Update `dashboard/campaigns/page.tsx`**

```bash
cd frontend
grep -n "predictive\|preview\|abandonRate\|dialRatio" src/app/dashboard/campaigns/page.tsx
```

Inspect each hit. Most will be display / filter / badge formatting. Replace `'predictive' | 'preview' | 'progressive'` unions with the new triple and drop any predictive-specific stat columns. If a stat row shows `Abandon Rate: X%`, remove it.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Expected: exits 0. Any error is a missed reference — grep for the field name and fix.

- [ ] **Step 6: Commit**

```bash
cd ..
git add frontend/src/components/campaigns/ frontend/src/app/dashboard/campaigns/page.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): campaign form + tabs reflect Manual|Progressive|AI Autonomous

- CampaignForm mode selector replaces Predictive/Progressive/Preview with
  the new triple; dialRatio and abandon-rate-limit inputs removed.
- SettingsTab drops dial-ratio and abandon-rate rows; adds formatDialMode.
- OverviewTab replaces safe_predictive_cap + abandon_rate_exceeded warnings
  with manual_mode + no_concurrency_configured labels for the new guardrails.
- Dashboard campaigns list loses predictive-only columns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Verification sweep

**Files:** none (audit-only)

- [ ] **Step 1: Grep for zombie references**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
echo '--- PREDICTIVE (expect: zero in backend/src and frontend/src; hits only in docs/ are OK) ---'
grep -rn "predictive\|PREDICTIVE" backend/src frontend/src --include='*.ts' --include='*.tsx'
echo
echo "--- 'preview' as a dial mode (expect: zero; accountPreview in workspace is OK) ---"
grep -rn "'preview'\|\"preview\"" backend/src frontend/src --include='*.ts' --include='*.tsx' | grep -v "accountPreview\|AccountPreview\|SET_ACCOUNT_PREVIEW"
echo
echo '--- abandonRate / dialRatio / aiOverflow / aiTargetEnabled (expect: zero) ---'
grep -rn "abandonRate\|dialRatio\|aiOverflow\|aiTargetEnabled" backend/src frontend/src --include='*.ts' --include='*.tsx'
```

Expected: the first and third commands produce NO matches. The second command produces no matches (the `grep -v` filter excludes the legitimate `accountPreview` UI references).

If any match appears, read the surrounding code and resolve: either it's a legitimate new reference (rare — investigate) or it's a missed delete (fix, re-run this step).

- [ ] **Step 2: Backend build + tests green**

```bash
cd backend
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | tail -20
```

Expected: typecheck exits 0; test output shows `# pass <N>` with 0 failures, where N is at least 10 (we rewrote guardrails.test.ts in place and added 4-5 validation tests; net is roughly equal to baseline 11).

- [ ] **Step 3: Frontend typecheck + build**

```bash
cd ../frontend
npx tsc --noEmit 2>&1 | tail -5
npm run build 2>&1 | tail -10
```

Expected: typecheck exits 0; build succeeds with no type errors. Warnings about unused imports are OK to note but not blocking.

- [ ] **Step 4: Smoke-run backend in mock mode**

```bash
cd ../backend
DIALER_MODE=mock npm run dev &
BACKEND_PID=$!
sleep 5
curl -fsS http://localhost:5000/health | jq . || echo "HEALTH FAILED"
curl -fsS http://localhost:5000/live | jq . || echo "LIVE FAILED"
kill $BACKEND_PID
wait $BACKEND_PID 2>/dev/null
```

Expected: `/health` returns `{"status":"ok", ...}` with 200. `/live` returns 200. No crashes during boot. If boot fails, read the stack trace — most likely a reference to `predictiveWorker` or a dropped field remains somewhere. Fix and re-run.

- [ ] **Step 5: Commit (verification artifacts — no code changes)**

No commit — this task is audit-only. If any fixes were required, they belong to whichever task they logically fit under; amend into that commit or add a tight follow-up commit like:

```bash
git commit --allow-empty -m "chore: Phase 0 verification passed (grep clean, tests green, mock boot OK)"
```

(The empty commit is optional; skip if no fixes were needed. If fixes WERE made, commit them with a normal message.)

---

### Task 9: Merge to `main` and push

**Files:** none (git operations only)

- [ ] **Step 1: Rebase onto current main (in case upstream moved)**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git fetch origin
git rebase origin/main
```

If rebase hits conflicts, resolve them manually. Do NOT skip commits. After resolution:

```bash
git rebase --continue
```

- [ ] **Step 2: Run the full test suite one more time post-rebase**

```bash
cd backend
npm test 2>&1 | tail -15
cd ../frontend
npx tsc --noEmit 2>&1 | tail -5
cd ..
```

Expected: backend tests green, frontend typecheck clean.

- [ ] **Step 3: Fast-forward merge to main**

```bash
git checkout main
git merge --ff-only phase-0-scope-cut
```

If `--ff-only` fails, the branch isn't ahead of main cleanly — rebase again. Do not create a merge commit.

- [ ] **Step 4: Push main to origin**

```bash
git push origin main
```

- [ ] **Step 5: Delete the local branch**

```bash
git branch -d phase-0-scope-cut
```

---

## Self-Review

**Spec coverage:**
- ✅ Delete predictive-worker — Task 3.
- ✅ Delete preview-mode routes/UI — Task 5 (runtime); Task 7 (form selector).
- ✅ Keep simple concurrent-limit guardrail — Task 2 (progressive + ai_autonomous both route through `maxConcurrentCalls`).
- ✅ Prisma `DialMode` update — Task 6 (column + comment; migration). Note: the column is a `String`, not a Prisma enum, so the "enum" is a comment/validation-layer contract.
- ✅ Update seeds — verified in Task 0 that `backend/scripts/seed.ts` has no mode references; no seed change needed.
- ✅ Update campaign seed + admin UI — Task 7 covers the admin campaigns page + form.
- ✅ Update campaign form mode-selector — Task 7, Step 1.
- ✅ Remove tests that target deleted code — Task 2 rewrites guardrails.test.ts in place; validation.test.ts is updated in Task 1. No other tests target deleted code.
- ✅ Build + tests green — Task 8 verification.
- ✅ AI_AUTONOMOUS worker is explicitly deferred to Phase 2 — called out in goal and Task 2 commit message.
- ✅ AMD / webhooks.ts are explicitly out of scope — called out in Architecture and decision 5.

**Placeholder scan:** all code blocks contain full snippets; no "TODO", "similar to Task N", or "fill in" references. Validated.

**Type consistency:**
- `DialMode` triple is used consistently: `manual | progressive | ai_autonomous` in validation.ts (Task 1), guardrails.ts (Task 2), schema.prisma (Task 6), CampaignForm.tsx (Task 7).
- `HumanCallMode` in providers/types.ts (Task 5) and `mode` union in call-session-service.ts (Task 5) both drop `preview` and `predictive` — consistent.
- `computeDialerGuardrails` new signature (four args) is consistent between the impl (Task 2), its test (Task 2), and its caller in campaigns.ts (Task 4).
- Blocked-reason strings (`manual_mode`, `no_concurrency_configured`, `no_available_agents`, `queue_backpressure`) are consistent between guardrails.ts (Task 2), its test (Task 2), and the frontend OverviewTab label map (Task 7, Step 3).
