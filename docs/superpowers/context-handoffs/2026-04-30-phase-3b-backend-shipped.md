# Phase 3b — Backend Shipped, Frontend Pending

**Date:** 2026-04-30
**Branch:** `feat/phase-3b-wrap-up` (DO NOT merge to master yet — frontend incomplete)
**Predecessor:** [2026-04-29-power-dial-phase-3a-shipped.md](2026-04-29-power-dial-phase-3a-shipped.md)
**Plan:** [docs/superpowers/plans/2026-04-29-phase-3b-wrap-up.md](../plans/2026-04-29-phase-3b-wrap-up.md)
**Pick this up by reading:** this doc, then jump to the plan for Tasks 7-13.

---

## TL;DR

Phase 3b is **6 of 13 tasks done**. The entire **server-side state machine for auto-wrap-up + auto-resume** is implemented, tested, and typecheck-clean on `feat/phase-3b-wrap-up`. Backend tests: **275/275 pass** (was 261 at baseline; +14 new tests across schema, validation, service, scheduler, and webhook integration).

What's done: schema migration, validation widening, pure-function wrap-up service, production deps factory, auto-resume scheduler with crash-recovery sweep, signalwire-events webhook wiring.

What's left: `POST /api/agents/:id/ready` endpoint (Task 7), worker regression test (Task 8), frontend hook + UI changes (Tasks 9-12), prod deploy + smoke (Task 13). About **2 hours of frontend work + 1 hour of deploy/smoke**.

The work was paused mid-branch by user request to switch sessions; nothing is broken or in flight.

---

## Commit history on this branch

```
ebc3bda feat(wrap-up): replace releaseAgent with enterWrapUp on call-status terminal   ← Task 5
c2ff937 feat(wrap-up): auto-resume scheduler + tick/boot sweep for crash recovery      ← Task 6
5596969 feat(wrap-up): wire production Prisma + Socket.IO deps                          ← Task 4
454ad46 feat(wrap-up): pure-function service for enter/exit/sweep transitions          ← Task 3
27a4762 feat(validation): accept wrap-up status + wrapUpSeconds campaign field          ← Task 2
7dbeec4 feat(schema): Phase 3b — Profile.wrapUpUntil + Campaign.wrapUpSeconds           ← Task 1
67a4ae6 docs(plan): Phase 3b — auto-wrap-up + auto-resume implementation plan
cb1c6d7 docs(power-dial): Phase 3a context handoff for next session                     ← previous session
```

Note: Tasks 5 and 6 were executed in **6→5 order** to avoid the deferred-commit dance the plan called out (Task 5 imports `scheduleAutoResume` from Task 6's scheduler).

---

## Architecture (live in code, locked in)

**Single source of truth: `Profile.status`.** Values: `available | break | offline | on-call | wrap-up`.

**Two new schema fields:**
- `Profile.wrapUpUntil DateTime?` — deadline for current wrap-up window; null when status != 'wrap-up'.
- `Campaign.wrapUpSeconds Int @default(30)` — duration for the post-call window; per-campaign tunable.

**Three transition triggers, all server-side:**
1. **Enter wrap-up:** SignalWire call-status webhook fires terminal state → [signalwire-events.ts](../../backend/src/routes/signalwire-events.ts) calls `defaultEnterWrapUp(agentId, wrapUpSeconds)` → flips status `on-call → wrap-up`, sets `wrapUpUntil = now + seconds`, emits `profile.status` Socket.IO event, schedules in-process `setTimeout` for auto-resume.
2. **Auto-resume (timer):** [wrap-up-scheduler.ts](../../backend/src/services/wrap-up-scheduler.ts) `scheduleAutoResume(agentId, seconds)` fires `wrapUpService.exitWrapUp(agentId)` → flips `wrap-up → available`, clears `wrapUpUntil`, emits.
3. **Auto-resume (sweep, crash recovery):** Worker tick AND boot both call `wrapUpService.sweepExpiredWrapUps()` which finds `WHERE status='wrap-up' AND wrapUpUntil <= now` and flips to `available`. Guarantees no agent gets stuck across Railway redeploys.

**Worker filter (already correct, no code change needed):** [progressive-power-dial-worker.ts:350](../../backend/src/services/progressive-power-dial-worker.ts) filters `Profile.status === 'available'`. Wrap-up agents are excluded for free. Task 8 adds a regression test to pin this.

**Socket.IO event:** `profile.status` with payload `{ status, wrapUpUntil, wrapUpSeconds }`. Emitted from `wrapUpService.enterWrapUp`, `wrapUpService.exitWrapUp`, and `wrapUpService.sweepExpiredWrapUps`.

---

## Files created this session

- [backend/src/services/wrap-up-service.ts](../../backend/src/services/wrap-up-service.ts) — pure-function service + production deps factory (Tasks 3+4)
- [backend/src/services/wrap-up-scheduler.ts](../../backend/src/services/wrap-up-scheduler.ts) — in-process setTimeout scheduler + module-level helpers `scheduleAutoResume`/`cancelAutoResume` (Task 6)
- [backend/src/test/wrap-up-service.test.ts](../../backend/src/test/wrap-up-service.test.ts) — 5 TDD tests (Task 3)
- [backend/src/test/wrap-up-scheduler.test.ts](../../backend/src/test/wrap-up-scheduler.test.ts) — 3 TDD tests with real setTimeout (Task 6)
- [backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql](../../backend/prisma/migrations/20260429170000_phase_3b_wrap_up/migration.sql) — two `ALTER TABLE` statements (Task 1)

## Files modified this session

- [backend/prisma/schema.prisma](../../backend/prisma/schema.prisma) — Profile + Campaign field additions (Task 1)
- [backend/src/lib/validation.ts](../../backend/src/lib/validation.ts) — Zod enum widened, wrapUpSeconds added to campaign schemas (Task 2)
- [backend/src/routes/signalwire-events.ts](../../backend/src/routes/signalwire-events.ts) — `releaseAgent` dep replaced with `enterWrapUp`; terminal handler reads `Campaign.wrapUpSeconds` with `?? 30` default; Prisma select widened (Task 5)
- [backend/src/test/signalwire-events.test.ts](../../backend/src/test/signalwire-events.test.ts) — fakes updated, 2 new tests for wrap-up entry (Task 5)
- [backend/src/test/integration-ai-autonomous-e2e.test.ts](../../backend/src/test/integration-ai-autonomous-e2e.test.ts) — campaign fixture updated to match widened Prisma select (Task 5 cascade)
- [backend/src/test/integration-progressive-lifecycle.test.ts](../../backend/src/test/integration-progressive-lifecycle.test.ts) — same cascade
- [backend/src/test/power-dial-worker.test.ts](../../backend/src/test/power-dial-worker.test.ts) — added optional `sweepExpiredWrapUps` mock to test deps (Task 6)
- [backend/src/services/progressive-power-dial-worker.ts](../../backend/src/services/progressive-power-dial-worker.ts) — sweep wired into tick BEFORE listing available agents (Task 6)
- [backend/src/index.ts](../../backend/src/index.ts) — sweep awaited at boot BEFORE workers start (Task 6)

---

## Tasks remaining (start here next session)

The plan ([docs/superpowers/plans/2026-04-29-phase-3b-wrap-up.md](../plans/2026-04-29-phase-3b-wrap-up.md)) has full code for each. Recommended execution order:

### Task 7 — `POST /api/agents/:id/ready` endpoint (~30 min, backend)
Refactor [agents.ts](../../backend/src/routes/agents.ts) into a `buildAgentsRouter(deps)` factory (current file is a flat default export). Add `POST /:id/ready` that calls `cancelAutoResume(id)` then `wrapUpService.exitWrapUp(id)`. New test `agents-ready.test.ts`.

### Task 8 — Worker regression test (~10 min, backend)
Pin the existing worker filter behavior with a test in [power-dial-worker.test.ts](../../backend/src/test/power-dial-worker.test.ts) that asserts `wrap-up` agents are excluded from `listAvailableAgents`. The behavior is already correct — this just guards future regressions.

### Task 9 — Frontend `useProfileStatus` hook + `GET /api/agents/me/status` endpoint (~30 min)
- Add `GET /me/status` to `agents.ts` that returns `{ id, status, wrapUpUntil }` for the authenticated user.
- Create [frontend/src/hooks/useProfileStatus.ts](../../frontend/src/hooks/useProfileStatus.ts) — hydrates from REST on mount, subscribes to `profile.status` Socket.IO event.

### Task 10 — `WrapUpView` countdown + "Ready Now" button (~20 min, frontend)
[WrapUpView.tsx](../../frontend/src/components/workspace/WrapUpView.tsx) gains props `wrapUpUntil: Date | null` and `onReadyNow: () => void`. A 250ms-tick `useEffect` updates `secondsLeft`. New "Ready Now" button rendered above the disposition grid.

### Task 11 — Dashboard reads phase from server status (~30 min, frontend, the trickiest UI task)
[dashboard/page.tsx](../../frontend/src/app/dashboard/page.tsx) currently derives wrap-up state from `sw.onCall` transitions client-side ([line 149](../../frontend/src/app/dashboard/page.tsx)). REMOVE that effect + the `wasOnCallRef` ref + the `useState<WrapUp | null>`. REPLACE with `useProfileStatus()`-derived phase. Update disposition submit handler to call `/agents/:id/ready` after disposition POST. Add `handleReadyNow` that calls `/agents/:id/ready` directly.

**Verify before commit:** Does `useSignalWire` expose `lastCallId` (needed for disposition POST)? If not, defer disposition save logic; the wrap-up flow itself works without it.

### Task 12 — Campaign form exposes `wrapUpSeconds` (~10 min, frontend)
Add the field to [CampaignForm.tsx](../../frontend/src/components/campaigns/CampaignForm.tsx) initial state + payload. Add the input control to [SettingsTab.tsx](../../frontend/src/components/campaigns/tabs/SettingsTab.tsx) near the `skipAmd` checkbox.

### Task 13 — Deploy + smoke (~45 min, ops)
- `cd backend && railway run npx prisma migrate deploy` — applies `20260429170000_phase_3b_wrap_up`.
- `railway up backend --path-as-root --service backend --ci` and same for frontend.
- Live smoke: power-dial against `+18327979834`, hang up customer side, verify dialer shows wrap-up countdown, verify worker doesn't dispatch during the window, click Ready Now and verify the next batch arrives. Repeat for the disposition path and the auto-resume timer path.
- Write `2026-04-XX-phase-3b-shipped.md` handoff replacing this doc.

---

## Deferred polish (end-of-branch cleanup before PR)

The Task 6 code review flagged two non-blocking observability items, deferred per protocol:

1. **Debug-level logging on the scheduler's silent catch.** [wrap-up-scheduler.ts](../../backend/src/services/wrap-up-scheduler.ts) line ~19 currently has `.catch(() => { /* swept by tick fallback */ })`. Add `logger.debug('timer-based exitWrapUp failed, will be swept', { agentId, err })`. Two-line change.

2. **`cancelAll` is in the interface but never exported/called.** Either export `cancelAllAutoResume()` and wire to `process.on('SIGTERM')` for graceful shutdown, OR remove `cancelAll` from `WrapUpScheduler`. Argued either way; data plane is correct without it (process restart clears all timers, then sweep recovers).

Plus one issue from Task 4 review:

3. **`prismaProfileUpdateMany` dep is wired but never called** by `buildWrapUpService`. Remove from `WrapUpDeps` interface OR keep as future-use. No correctness impact.

These are explicitly cosmetic/observability — skip unless you want to clean up before opening the PR.

---

## Architectural rules carried forward (don't violate)

From [CLAUDE.md](../../CLAUDE.md) and prior handoffs:

- **No LaML/TwiML XML.** SWML + REST only. (Phase 3b doesn't touch this layer.)
- **SWML lives in [builder.ts](../../backend/src/services/swml/builder.ts).** Not modified this session.
- **Webhooks are JSON.** `express.json()` global. Phase 3b's enterWrapUp wiring is in the JSON handler at `/signalwire/events/call-status`.
- **Provider abstraction unchanged.** Mock telephony when `SIGNALWIRE_PROJECT_ID` unset.
- **`@signalwire/js@3.28.1` pinned.** Don't bump.
- **SWML `request:` is a side-effect, not a continuation.** Phase 3a-era lesson; not relevant to Phase 3b.

---

## Test count progression

```
Baseline (Phase 3a end):   261 tests
After Task 1 (schema):     261 (no test changes)
After Task 2 (validation): 265 (+4)
After Task 3 (service):    270 (+5)
After Task 4 (factory):    270 (no test changes)
After Task 6 (scheduler):  273 (+3)
After Task 5 (webhook):    275 (+2)
```

All 275 pass. Backend tsc clean. Frontend tsc was clean at baseline; Tasks 9-11 will exercise it.

---

## Live state in prod (NOT yet touched)

Migration `20260429170000_phase_3b_wrap_up` is committed locally but **NOT applied to prod**. Prod still runs the Phase 3a code (commit `cb1c6d7`). Until Task 13:
- Agents still get stuck at `on-call` after every call (current production blocker).
- Workers still dispatch the moment a call ends.

The branch `feat/phase-3b-wrap-up` does not affect prod until merged + deployed.

---

## Honest note

Phase 3b's backend was tighter than expected because of the prep-work in the audit + spec. The pure-function wrap-up service was built TDD-first; the integration into `signalwire-events.ts` exposed a Prisma select drift in two integration tests (auto-fixed by the implementer). Subagent-driven execution with two-stage reviews has caught nothing critical so far — the plan's bite-sized tasks have been mechanical enough that haiku-level models handle them cleanly. Task 5 was upgraded to sonnet for the existing-file modification and went smoothly.

The frontend half (Tasks 9-11) is where this gets interesting again: removing the existing client-side `sw.onCall` wrap-up detection and replacing it with server-truth via Socket.IO, without breaking the connected/incoming/idle phases. Plan that work as a single coherent edit, not three separate ones.
