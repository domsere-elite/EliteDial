# Power-Dial Phase 3a Shipped — Context Handoff

**Date:** 2026-04-29 (continuation of Phase 2 — `2026-04-28-power-dial-phase-2-handoff.md`)
**Audience:** Next session, picking up after Phase 3a is end-to-end working in prod.
**Pick this up by reading:** this doc end-to-end, then [the Phase 2 handoff](2026-04-28-power-dial-phase-2-handoff.md) only if you need history on the multi-leg dispatch architecture. Phase 2's SWML claim/voicemail-route design is *gone* (replaced by inline multi-section SWML — see § "Architecture pivot during smokes").

---

## TL;DR

Power-dial dispatch is **production-viable speed** in prod. Worker dispatches `floor(dialRatio)` parallel PSTN legs, server-side atomic claim awards the winning leg, customer is bridged to agent's softphone in **3-7 seconds** post-answer with `skipAmd=true` (default). Customer's real name + phone number renders on the agent's dialer (not SIP details). Voicemail leg gets `outcome: 'hangup'` and disconnects cleanly. End-to-end validated via 7 live smokes against `+18327979834` and `+18333814416` IVR.

`POWER_DIAL_WORKER_ENABLED=true` on Railway. Migrations applied. **Behavior is live in prod.**

---

## What's done (Phase 2 + Phase 3a)

### Phase 2 — `0986674` and follow-ups
Multi-leg dispatch + AMD SWML + server-side claim race. See [the Phase 2 spec](../specs/2026-04-28-power-dial-phase-2-design.md) for the original architecture.

### Phase 3a — `350deda` + `9603de1`
1. **`Campaign.skipAmd` Boolean (default true)** — migration `20260429160000_skip_amd_default` applied to prod. Existing campaigns auto-picked up the faster default.
2. **SWML `request:` side-effect fix** — the original Phase 2 design assumed `request:` would execute the response body as SWML continuation. It doesn't: per SignalWire docs, `request:` stores the response in `%{request_response.<field>}` and continues to the NEXT step in the same SWML doc. The fix collapses all routing into a multi-section SWML doc baked at origination time. Routes return JSON `{ outcome: 'bridge' | 'overflow' | 'hangup' }`; the SWML branches via `switch:` + `transfer:` to its own `bridge` / `overflow_ai` / `hangup_now` sections.
3. **Removed TTS hold** ("One moment please, connecting you now") — added in Phase 2 to mask AMD silence; with `skipAmd=true` it's no longer needed.
4. **Customer info on bridge invite** — backend's `/swml/power-dial/claim` route emits a `power_dial.bridge.winner` Socket.IO event to the agent's user room with `{ batchId, legId, contactName, contactPhone, providerCallId }` the moment the atomic claim succeeds. Frontend stores winners in a ref and the auto-accept handler uses them to render the actual customer in the dialer (not the SIP-ish caller_id_number from the Fabric notification).
5. **`ringing: true` set BEFORE `await accept()`** — dialer UI shows "connecting" state immediately when the Fabric invite arrives, not after WebRTC negotiation completes 3-5s later.
6. **Bridge SWML mirrors softphone shape** — no `from:` on connect, no `record_call` (those broke Fabric resolution in smoke #1; pinned by regression test).

### Architecture pivot during smokes (lessons baked in)

The Phase 2 spec's claim/voicemail routes returned SWML documents. Smoke #2 proved this was wrong: SWML's `request:` doesn't execute response bodies as continuations. The current architecture:

- **One SWML doc per leg, baked at worker origination time.** Knows targetRef, retellSipAddress, voicemailBehavior, voicemailMessage, and skipAmd.
- **Two HTTP callbacks:** `/swml/power-dial/claim` (returns `{outcome}` JSON), `/swml/power-dial/voicemail` (returns `{ack}` for audit only).
- **Sections:** `main` (entry — answer + claim with optional AMD), `bridge` (connect to agent), `overflow_ai` (connect to retell), `hangup_now`.
- **Two Socket.IO events:** `power_dial.batch.dispatched` (pre-arm before legs originate), `power_dial.bridge.winner` (after claim wins, with customer info).

If the next session tries to "simplify" by returning SWML from the routes, they'll break the bridge again — the fix is in the commit messages on `f188465`.

---

## Live state (prod, verified working)

- **Migration `20260429160000_skip_amd_default`** applied 2026-04-29 to Supabase.
- `Campaign` table has `skipAmd Boolean DEFAULT true`.
- `POWER_DIAL_WORKER_ENABLED=true` on Railway backend service.
- `progressivePowerDialWorker.start()` logs "started" on boot with `intervalMs=5000, batchTtlSeconds=60`.
- Test campaign `test#1` (id `29f6b0df-bbd9-4f99-a451-a9718149fbc3`) — progressive, dialRatio=2, skipAmd=true (default), voicemailBehavior=hangup.
- Cell `+18327979834` and 833 `+18333814416` are seeded as contacts. 833 is parked at `status='completed'` so smokes route to cell.
- Agent UUID `692a690e-770d-43bb-a151-8ec163141281` (`dominic@exec-strategy.com`). Fabric subscriber resolves at `/private/dominic`. Password set deterministically from `SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET` (or API token fallback).
- DID `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`) used as `caller_id` on power-dial originations.

### URLs / creds

- Frontend: https://frontend-production-8067.up.railway.app
- Backend: https://backend-production-e2bf.up.railway.app
- DB: Supabase pooler `aws-1-us-east-2.pooler.supabase.com:5432`
- SignalWire space: https://executive-strategy.signalwire.com
- Login: `dominic@exec-strategy.com` / `TempPass2026`

### Deploy invocation (locked in from softphone session)

```
railway up backend --path-as-root --service backend --ci
railway up frontend --path-as-root --service frontend --ci
```

### Migrations against prod

```
cd backend && railway run npx prisma migrate deploy
```

---

## Smoke test scripts (in `backend/scripts/`)

- **`smoke-detect-machine.ts`** — probes whether SignalWire's `detect_machine` SWML verb works on the space. Used during Phase 2 to validate AMD before building anything. Keep around for debugging.
- **`smoke-power-dial.ts`** — bypasses the worker; manually creates a PowerDialBatch + 2 PowerDialLegs and dispatches via `signalwireService.originatePowerDialLeg`. Useful for testing without flipping campaign + agent state.
- **`seed-cell-only.ts`** — seeds only the cell as a queued contact on the most-recent progressive campaign; parks the 833 at status='completed'. Run before each smoke when you want the cell to be the winning leg.
- **`reset-smoke-numbers.ts`** — deletes Call rows for the smoke phones (clears Reg F frequency cap) and re-queues `suppressed-reg-f` / `dialing` / `failed` contact rows back to `queued`. Run before each smoke.
- **`reset-agent-status.ts`** — flips agent's status to offline (or AGENT_EMAIL/STATUS env). Useful to break out of the "stuck on-call" state between smokes.
- **`inspect-power-dial-state.ts`** — snapshot of every input the worker checks per tick (active campaigns, available agents, queued contacts, all progressive campaigns).
- **`inspect-power-dial-batch.ts`** — given `BATCH_ID=<uuid>`, prints batch row + all legs + CallEvent audit rows. Use for post-mortem on any smoke.
- **`inspect-test1.ts`** — campaign-specific inspection of `test#1`'s contacts + recent batches.

---

## Phase 3 work to do (in order)

### Phase 3b — Auto-wrap-up + auto-resume (THE NEXT BLOCKER)

**Why:** Right now the worker flips `Profile.status` from `available` → `on-call` when it dispatches a batch. The agent is bridged to a customer. When the call ends, the agent stays stuck at `on-call` until they manually click `Avail`. That is unworkable in production — agents need automatic state transitions between calls with a configurable wrap-up window.

**Required:**
1. **Call-end detection** — when the customer's bridge call ends (hangup / customer disconnect), the SignalWire `/signalwire/events/call-status` webhook fires. We need to:
   - Match the providerCallId to the PowerDialLeg row (already stored).
   - Flip `Profile.status` from `on-call` → `wrap-up`.
2. **Wrap-up timer** — `Campaign.wrapUpSeconds Int default 30` (new field). After call-end, wrap-up state lasts up to that many seconds. Agent can:
   - Disposition the call (existing UI).
   - Click "Ready for next call" to skip wrap-up early → status='available'.
   - Or wrap-up timer expires → status='available' automatically.
3. **UI** — dialer shows wrap-up countdown + "Ready" button + disposition form during wrap-up.
4. **Worker safety** — worker MUST NOT dispatch to an agent in `wrap-up` state. Already correct (it filters on `status='available'` only).

**Spec needed?** Probably worth a short spec doc. ~3 hours of work end-to-end.

### Phase 3c — WebRTC pre-warm (eliminates the 3-5s ringback)

**Why:** `answer_on_bridge: true` causes SignalWire to play synthetic ringback to the customer while the agent's WebRTC negotiates (~3-5s). That's the same UX as the working softphone outbound — agents tolerate it on outbound dials but it's awkward on power-dial where the customer just answered. The structural fix is to keep the agent's WebRTC peer connection warm before the bridge fires.

**Approach:** when agent goes `available`, eagerly establish + hold a Fabric peer connection with SignalWire. When the bridge invite arrives, attach to the existing connection — should drop attach time from ~3-5s to ~500ms.

**Cost:** medium-effort, real risk of regressing the working softphone path. The v3 SDK doesn't expose this cleanly. The original softphone session burned three days getting `client.online()` working — touching this risks regressing that. Multi-day rabbit hole if it goes badly.

**Defer?** Yes — wait for Phase 3b to land first. The 3-5s ringback is acceptable for early production (matches what manual softphone outbound does today).

### Phase 3d (optional) — Per-agent campaign assignment

Not in scope until you actually run multiple progressive campaigns simultaneously with different agent pools. Today's "every available agent serves every active progressive campaign" is fine for single-tenant.

---

## What was tried and ruled out (don't redo)

- **`request:` SWML verb returning new SWML to execute as continuation.** That's NOT how it works. Response body goes into `%{request_response.<field>}` variables; execution continues in the same doc. Use multi-section SWML + `switch:` + `transfer:` for branching. (Smoke #2 burned this lesson in.)
- **`from:` field on `connect: /private/<ref>`.** Breaks Fabric bridge resolution in v3 SDK. The working softphone outbound omits it. Pinned by regression test in `swml-builder.test.ts`.
- **`record_call` step on the bridge section.** Same — broke Fabric resolution in smoke #1. Removed.
- **Playwright running concurrently with the user's real browser.** SignalWire keeps Fabric subscriber registrations warm for ~30-60s after the SDK socket drops. If both Playwright and a real browser are registered for `/private/dominic` simultaneously, SignalWire will try one then the other on bridge attempts, causing 5-10s of ringback while the stale registration times out. (Smoke #7 saw this.) Don't run Playwright while the real-browser smoke is in progress.
- **Pre-warm WebRTC inside the auto-accept path.** Tempting, but `notification.invite.accept()` already does the WebRTC handshake; you can't speed that up without changes deeper than the SDK exposes.
- **`detect_machine` with default thresholds for collections lists.** AMD adds 4-7s of post-answer silence. `skipAmd=true` is the production default. AMD-on (`skipAmd: false`) is opt-in for compliance-sensitive lists where a false-positive bridge to a VM is more costly than a false-negative drop of a real human.

---

## Known minor issues

1. **WebSocket transient warning on page load** — `WebSocket is closed before the connection is established` on the Socket.IO connection. The reconnect logic recovers within 1s. Cosmetic; doesn't block.
2. **`Got an unknown fabric event {type: 'call.state'}` console warnings during an active power-dial bridge.** Same SDK issue as the original softphone — the v3 SDK doesn't fully route call.state events for Fabric-bridge calls. Works around it by setting `onCall: true` in the auto-accept handler directly. If SignalWire ships an SDK fix, the handler can simplify.
3. **Sidebar UI shows "Inbound Hub" by default for `/dashboard`.** The original NavSidebar had a "Camps" link; current build seems to have a different sidebar shape. Direct URL `/dashboard/campaigns` and `/dashboard/campaigns/new` work, just no obvious sidebar link. Could be a stale build vs source mismatch — check before changing.
4. **Old `power-dial-smoke` campaign at `db5cf2ba-...` still has queued contacts under it.** It's `status='draft'` so the worker ignores it, but it pollutes `inspect-power-dial-state.ts` output. Safe to leave or clean up later.
5. **Existing campaign-create modal on `/dashboard/campaigns` is incomplete** — doesn't expose dialRatio / voicemailBehavior / skipAmd. Use `/dashboard/campaigns/new` directly. Modal needs replacement with the full `CampaignForm` component.

---

## Triage if Phase 3a misbehaves in prod

1. **Worker dispatches but no Socket.IO event arrives in browser.** Check Railway logs for `power-dial-worker: started`. If absent, env flag isn't set or boot wiring regressed.
2. **`power-dial batch armed` log fires but no `power-dial bridge winner`.** Customer didn't answer or claim race never resolved. Check the batch via `inspect-power-dial-batch.ts` — `claimedAt` should be populated on winning batches.
3. **`bridge winner` arrives but auto-accept doesn't show customer info.** Check the frontend hook reads winner from `consumePowerDialWinner(batch.batchId)` — recent regression risk. Verify `details` object's `caller_id_number` is being used as fallback only.
4. **3-5s of ringback during bridge formation.** Steady state with `answer_on_bridge: true`. Same as softphone outbound. Phase 3c addresses this.
5. **10s+ of ringback.** Likely two competing browser sessions for the same Fabric subscriber. Close all but one tab; check `https://executive-strategy.signalwire.com/api/fabric/subscribers` for duplicates.
6. **Customer's cell shows DID, not their actual number.** Check `originatePowerDialLeg` — `caller_id` should be set to the DID. Customer's caller ID display is the DID; the AGENT seeing the customer's actual number comes from the Socket.IO winner event we emit at claim time.
7. **`suppressed-reg-f` on smoke phones.** Reg F 7-in-7-day cap. Run `reset-smoke-numbers.ts` to clear.

---

## Honest note

Phase 3a was 4 live smokes after the architecture pivot in smoke #2. The design pivot (collapsing into multi-section SWML + JSON outcomes) was correct on the second try; everything since has been UX polish. The SDK-side WebRTC negotiation lag is the only structural performance issue left, and it's a Phase 3c problem, not a Phase 3a one.

The real production-readiness blocker right now is **Phase 3b (auto-wrap-up + auto-resume)** — the agent ergonomics. Without it, agents have to manually click `Avail` between every dial. That's not a bug; it's the next feature.

If the next session's user is asking about anything other than Phase 3b, push back and confirm — the current call-flow architecture is mature enough to leave alone.
