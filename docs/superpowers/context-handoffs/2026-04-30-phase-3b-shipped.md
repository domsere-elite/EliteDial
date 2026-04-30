# Phase 3b — Auto Wrap-Up + Auto-Resume — Shipped to Prod

**Date:** 2026-04-30
**Branch:** `feat/phase-3b-wrap-up` (deployed; ready to merge once live smoke confirms)
**Predecessor:** [2026-04-30-phase-3b-backend-shipped.md](2026-04-30-phase-3b-backend-shipped.md) (mid-branch checkpoint)
**Plan:** [2026-04-29-phase-3b-wrap-up.md](../plans/2026-04-29-phase-3b-wrap-up.md) — all 13 tasks complete.

---

## TL;DR

Server-led auto-wrap-up + auto-resume is **live in prod**. Migration applied, both Railway services deployed, pre-smoke prep complete. Agents now flip to `wrap-up` for 30s (per-campaign tunable) at call-end, the worker honors that as a no-dispatch window, and they auto-resume via in-process timer + worker-tick sweep + boot sweep. Frontend reads server truth via Socket.IO `profile.status`.

Backend tests: **279/279 pass** (was 261 baseline; +18 across schema, validation, service, scheduler, webhook, and routes). Backend + frontend tsc clean.

The branch is **not yet merged to `main`** — kept on `feat/phase-3b-wrap-up` until live PSTN smoke confirms.

---

## Final commit list on this branch

```
280c8ed chore(wrap-up): scheduler debug log; drop unused cancelAll + updateMany dep
b1209eb feat(campaigns): expose wrapUpSeconds in CampaignForm + SettingsTab
d78fed1 feat(frontend): derive wrap-up phase from server status; countdown + Ready Now
a627cff feat(frontend): useProfileStatus hook — server-truth status via REST + Socket.IO
f884df4 test(power-dial): pin worker filter — wrap-up agents excluded from dispatch
a5e2f8c feat(agents): POST /api/agents/:id/ready + GET /me/status; refactor to factory
d0527cb docs(power-dial): Phase 3b backend shipped — handoff for next session
ebc3bda feat(wrap-up): replace releaseAgent with enterWrapUp on call-status terminal
c2ff937 feat(wrap-up): auto-resume scheduler + tick/boot sweep for crash recovery
5596969 feat(wrap-up): wire production Prisma + Socket.IO deps
454ad46 feat(wrap-up): pure-function service for enter/exit/sweep transitions
27a4762 feat(validation): accept wrap-up status + wrapUpSeconds campaign field
7dbeec4 feat(schema): Phase 3b — Profile.wrapUpUntil + Campaign.wrapUpSeconds
67a4ae6 docs(plan): Phase 3b — auto-wrap-up + auto-resume implementation plan
```

---

## Live state

- **Migration `20260429170000_phase_3b_wrap_up`** — applied via `railway run npx prisma migrate deploy` (ran 2026-04-30 ~17:45 UTC).
- **Backend** — `https://backend-production-e2bf.up.railway.app` — `/health` returns `db:connected`, `/api/agents/me/status` returns 401 unauthenticated (proves new factory routes are live).
- **Frontend** — `https://frontend-production-8067.up.railway.app` — 200, new bundle deployed.
- **Pre-smoke state:**
  - `+18327979834` (test cell) re-queued, Reg F counters cleared.
  - 833 contact moved to `status=completed` so it doesn't dispatch.
  - `dominic@exec-strategy.com` set to `status=available`.

---

## Architecture (now live in prod)

**Single source of truth: `Profile.status`.** Values: `available | break | offline | on-call | wrap-up`.

**New schema (live):**
- `Profile.wrapUpUntil DateTime?`
- `Campaign.wrapUpSeconds Int @default(30)`

**Server-side transitions:**
1. **Enter wrap-up** — SignalWire `call-status` terminal → `defaultEnterWrapUp(agentId, wrapUpSeconds)` flips `on-call → wrap-up`, sets `wrapUpUntil = now + N`, emits `profile.status` Socket.IO event, schedules in-process `setTimeout`.
2. **Auto-resume (timer)** — `wrap-up-scheduler.ts` fires `wrapUpService.exitWrapUp(agentId)` after the window.
3. **Auto-resume (sweep)** — Worker tick AND boot run `sweepExpiredWrapUps()` — `WHERE status='wrap-up' AND wrapUpUntil <= now` → flip to `available`. Crash recovery across Railway redeploys.
4. **Explicit ready** — `POST /api/agents/:id/ready` cancels the timer + flips wrap-up → available. Used by the disposition submit handler and the new "Ready Now" button.

**Worker filter:** `progressive-power-dial-worker.ts:355` filters `status: 'available'`. Wrap-up agents excluded for free; pinned by [power-dial-worker.test.ts](../../backend/src/test/power-dial-worker.test.ts) regression test.

**Socket.IO:** `profile.status` event with `{ status, wrapUpUntil, wrapUpSeconds }`. Hydrated on hook mount via `GET /api/agents/me/status`.

---

## What the user actually sees

When a call ends in prod:
1. Within ~1s of SignalWire's call-status terminal webhook, the dialer flips to the wrap-up screen.
2. A `Wrap-up — Ns remaining` badge counts down in the disposition panel header.
3. "Ready Now" button (right of the countdown) immediately POSTs `/agents/<id>/ready` to skip the window.
4. "Submit & Next" POSTs the disposition then `/agents/<id>/ready`.
5. If neither is clicked, the timer fires after `Campaign.wrapUpSeconds` (default 30) and the worker dispatches the next batch on its next tick.

The campaign edit form (`/dashboard/campaigns/<id>/edit`) exposes `wrapUpSeconds` as a number input (0–300, default 30). The campaign view's Settings tab shows the configured value read-only.

---

## Live smoke walkthrough (RUN THIS NEXT)

Open the dialer in **one browser tab only** (no Playwright running — see prior handoff's race note).

1. Log in as `dominic@exec-strategy.com / TempPass2026`.
2. Navigate to `test#1` campaign and confirm it's `active`. Confirm `wrapUpSeconds=30` in Settings tab.
3. Wait for worker dispatch. Within ~5s a leg should hit `+18327979834`.
4. Answer the cell, confirm bridge to the dialer (~3-7s post-answer-to-bridge with skipAmd=true).
5. **Hang up the cell.** Within ~1s the dialer should switch to the wrap-up screen with a 30s countdown.
6. **Verify the worker does NOT dispatch a new batch during wrap-up.** Tail Railway backend logs — no `power-dial batch armed` until the timer expires or you click Ready Now.
7. Click **Ready Now** → workspace returns to idle, worker dispatches within one tick.
8. Repeat: this time **submit a disposition**. Confirm disposition saves AND status returns to available (worker dispatches).
9. Repeat: this time **wait the full 30s**. Confirm timer expires automatically and worker dispatches.
10. Crash-recovery sanity: while in wrap-up, redeploy backend (or just `railway service restart backend`). After restart the boot sweep should immediately flip the agent back to available (next `GET /me/status` returns `status=available`, `wrapUpUntil=null`).

Smoke prep already run via:
```bash
cd backend && railway run npx tsx scripts/reset-smoke-numbers.ts
                railway run npx tsx scripts/seed-cell-only.ts
AGENT_EMAIL=dominic@exec-strategy.com STATUS=available railway run npx tsx scripts/reset-agent-status.ts
```

---

## Known caveats / edge cases

1. **Disposition save uses `lastCallContextRef`.** When the call ends, `sw.callId` may clear before the user opens the disposition form. The dashboard captures the just-ended call's id into a ref during the existing call-end effect. If a future refactor removes that effect or changes the `wasOnCallRef` lifecycle, disposition POSTs will miss their callId. There is no test pinning this on the frontend (no frontend tests exist yet).

2. **WrapUpView component is dead code.** `frontend/src/components/workspace/WrapUpView.tsx` was kept in sync with the new props (`wrapUpUntil`, `onReadyNow`) but it is not rendered anywhere — the dashboard uses an inline disposition panel. If anyone later wires WrapUpView in, the props match.

3. **In-process scheduler is single-instance.** If multiple backend replicas run in parallel (currently we run one), the in-process timer fires only on the replica that handled the call-status webhook. The sweep on every tick across all replicas is the safety net — worst-case the agent is in wrap-up `wrapUpSeconds + tickInterval` total, not stuck.

4. **`reset-agent-status.ts` does not clear `wrapUpUntil`.** It only updates `status`. If used during smoke recovery, also run `await prisma.profile.update({ where:{email}, data:{ wrapUpUntil: null } })` if you want a fully clean state. (The worker filter is `status='available'`, so a stale `wrapUpUntil` with `status='available'` is harmless in practice.)

---

## What didn't change

- **No SWML changes.** [builder.ts](../../backend/src/services/swml/builder.ts) is untouched.
- **No telephony-provider changes.** `signalwireService` and the provider abstraction are unmodified.
- **No call-flow URL or webhook changes.** SignalWire dashboard config is unchanged.
- **`@signalwire/js@3.28.1` still pinned.** Don't bump.

---

## Phase 3c

WebRTC pre-warm (target: shave 3-5s off bridge ringback) is the next planned phase. Defer until Phase 3b live-smoke is signed off and the branch is merged.

---

## Resume instruction for next session

If smoke is **green**:
> Phase 3b smoke passed — merge `feat/phase-3b-wrap-up` to `main` and tag `phase-3b`. Then start Phase 3c (WebRTC pre-warm) with a brainstorm of the architecture options.

If smoke **finds an issue**:
> Phase 3b smoke surfaced an issue: [describe]. Read `docs/superpowers/context-handoffs/2026-04-30-phase-3b-shipped.md` then debug from `feat/phase-3b-wrap-up`.
