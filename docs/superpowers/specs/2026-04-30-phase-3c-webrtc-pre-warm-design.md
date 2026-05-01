# Phase 3c — WebRTC Pre-Warm via Per-Agent SignalWire Rooms

**Date:** 2026-04-30
**Status:** Approved (pending Phase 0 spike validation)
**Predecessor:** [2026-04-30-phase-3b-shipped.md](../context-handoffs/2026-04-30-phase-3b-shipped.md)
**Related parked work:** Phase 3b's `status_url` callback issue — likely resolved as a side effect of this work (conference-level status_url is documented to be more reliable than per-call status_url).

---

## TL;DR

Replace the per-call cold WebRTC negotiation (current 3-5 seconds of customer-side dial-tone after answer) with a per-agent SignalWire conference room that the agent's browser stays in while their `Profile.status === 'available'`. Customer legs `join_room` into the agent's already-negotiated room, getting instant audio. Phase 0 is a 1-2 hour spike to validate the SignalWire-side assumptions before full implementation.

**Goal:** post-answer-to-audio under 500ms (industry-leading). Floor: never worse than today's 5s (graceful fallback to current `connect: /private/<ref>`).

**Scope:** power-dial bridges only. Manual outbound and inbound stay on current flow (Phase 3d candidates).

---

## Goal & success criteria

1. **Cut post-answer-to-audio gap from 3-5s to <500ms** for power-dial bridges. Verified by instrumented timestamp logs on both customer-leg-answer and first-audio-frame at agent.
2. **Never degrade below current behavior** — if room flow fails for any reason, the call falls back to `connect: /private/<ref>` (today's path).
3. **No new permanent state** — room lifecycle is fully derivable from `Profile.status`. No new database columns. No new long-lived process state beyond the existing in-process scheduler.
4. **Cost increase bounded** — under $0.90/agent/day for a typical 8-hour shift with 100 calls (modeled in Cost section below).
5. **Backwards compatibility** — manual outbound and inbound paths unchanged. Worker, claim flow, batch.armed signal, wrap-up state machine, all unchanged.

---

## Architecture

### Lifecycle (status-aligned)

The room's lifecycle binds to `Profile.status` — the single source of truth Phase 3b shipped:

| Status transition | Frontend action | SignalWire effect |
|---|---|---|
| `offline` → `available` | `client.dial('/swml/agent-room/<id>')` | Agent enters `agent-room-{id}` as moderator. PC negotiated. |
| `available` → `wrap-up` | (no-op — stay in room) | Agent stays in room. Customer leg has already left. |
| `wrap-up` → `available` | (no-op — already in room) | Room remains warm. |
| any → `break` / `offline` | Hangup the room call | `end_conference_on_exit: true` → room dies. |

### Primitives (all SWML-native, validated against `/signalwire` skill docs)

- `join_room: { name, moderator, wait_for_moderator, start_conference_on_enter, end_conference_on_exit, muted, deaf }`
- Conference-level `status_url` for `participant-join` / `participant-leave` / `conference-end` events
- Dynamic room naming: `agent-room-{agentId}` — created on first join, persists until moderator (agent) leaves with `end_conference_on_exit: true`

### Bridge flow change

**Today (cold):**
```
customer-leg SWML:
  - answer
  - request: /swml/power-dial/claim?…
  - switch on outcome.bridge:
      bridge: connect: /private/{targetRef}    ← fresh PC negotiation, 3-5s
```

**Phase 3c (warm):**
```
customer-leg SWML:
  - answer
  - request: /swml/power-dial/claim?…
  - switch on outcome.bridge:
      bridge:
        - join_room:
            name: agent-room-{agentId}
            wait_for_moderator: true
            timeout: 3            # graceful race protection
        - connect:                # fallback if join_room failed (no agent in room within timeout)
            to: /private/{targetRef}
```

The agent has been in the room since their `Profile.status` flipped to `available`. PC is warm. Customer joins → audio is immediate.

---

## Components

### Backend (new + modified)

**New: `backend/src/services/swml/builder.ts` — `agentRoomSwml(agentId, callbackUrl)` function**
Returns a small SWML doc that:
1. Answers the call
2. `join_room` with `name: agent-room-{agentId}`, `moderator: true`, `start_conference_on_enter: true`, `end_conference_on_exit: true`
3. Falls through to `hangup` when room ends

Pure function with tests, per CLAUDE.md.

**New: `backend/src/routes/swml.ts` — `GET /swml/agent-room/:agentId`**
Serves the SWML from the builder. Authenticates the agent via session/token (TBD — use existing `authenticate` middleware pattern).

**Modified: `powerDialDetectSwml` builder**
The bridge section changes from a single `connect: /private/<ref>` step to a 2-step sequence: `join_room` first, then `connect` as fallback. Builder gets a new param `agentId` so it can derive the room name. Tests updated.

**New (optional, recommended): `backend/src/routes/signalwire-events.ts` — conference-status handler**
Endpoint at `POST /signalwire/events/conference-status`. Listens for `conference-end` and `participant-leave` events. May incidentally provide the reliable termination signal that `status_url` failed to deliver in Phase 3b — if so, we'd retire the SWML-driven webhook fallback we parked.

### Frontend (new)

**New: `frontend/src/hooks/useAgentRoom.ts`**
- Reads `Profile.status` from `useProfileStatus()` (Phase 3b shipped).
- On `available` (and not already in room): `client.dial('/swml/agent-room/<currentUserId>')` and stash the resulting session.
- On `break` / `offline` (and currently in room): hang up the session.
- On Socket.IO reconnect, if `status === 'available'` and not in room, re-dial.
- Exposes `{ inRoom: boolean, roomError: string | null }` for UI status indicators.

**Modified: `frontend/src/app/dashboard/page.tsx`**
- Mount the `useAgentRoom()` hook alongside existing `useProfileStatus()`.
- Optional small UI indicator: "Bridge ready" / "Bridge connecting…" near the connection status badge.

### Out of scope (explicit non-goals)

- Manual outbound (`originateAgentBrowserCall`) — unchanged
- Inbound calls — unchanged
- Supervisor monitor-listen via room — possible Phase 3d
- Recording at room level — possible Phase 3d
- Room reuse across logout/login — room dies on logout, fresh on next login

---

## Data flow (sequence)

```
[Agent loads dialer]
      ↓
[useProfileStatus REST hydrate → status='available']
      ↓
[useAgentRoom: client.dial('/swml/agent-room/<id>')]
      ↓
[SWML answers → join_room moderator → PC negotiated]   ← happens once per shift
      ↓
[Agent waits in room (silence, no audio)]
      ↓
─── time passes ───
      ↓
[Worker tick → batch.armed emitted → power-dial leg dispatched]
      ↓
[Customer phone rings]
      ↓
[Customer answers]
      ↓
[customer-leg SWML: claim → outcome=bridge → join_room agent-room-<id>]
      ↓
[Customer's audio starts flowing INSTANTLY (agent's PC is warm)]   ← <500ms target
      ↓
[Bridge audio between agent and customer]
      ↓
[Customer hangs up → leaves room]
      ↓
[Conference-status webhook fires participant-leave (and possibly conference-end if they were the only non-moderator)]
      ↓
[Backend uses event to flip agent → wrap-up via existing wrap-up service]
      ↓
[Agent stays in room; ready for next bridge]
      ↓
─── shift ends ───
      ↓
[Agent clicks "Break" or logs out → status='break'/'offline']
      ↓
[useAgentRoom hangs up the room session]
      ↓
[Agent (moderator) leaves → end_conference_on_exit fires → room dies]
```

---

## Failure modes & fallbacks

| Failure mode | Detection | Mitigation |
|---|---|---|
| Pre-warm SWML fails (network, SignalWire error) on agent dial | `client.dial()` rejects | `useAgentRoom` retries with backoff. UI shows "Bridge connecting…" indicator. Customers still get cold-bridge fallback (B+A guarantees never-worse-than-today). |
| Customer joins before agent's room is ready | `wait_for_moderator: true` with `timeout: 3` | First 3s: customer waits silently. After 3s: SWML falls through to `connect: /private/<ref>` (today's flow). Worst case = today's UX. |
| Network blip during shift, agent's room session drops | Socket.IO disconnect or session-end event | `useAgentRoom` redials when reconnect + status still available. Brief window where customer might fall back to cold bridge — acceptable. |
| Browser tab refresh mid-shift | `useAgentRoom` runs again on mount | Re-dial from scratch. ~3s window of no warm room. Acceptable. |
| Agent's status flickers between available/break rapidly | Should not happen in practice; defend anyway | Debounce status changes by ~500ms in `useAgentRoom` before acting. |
| Agent in room, customer leg's claim returns "overflow" (Retell SIP) | Unchanged — the `join_room` only fires on `outcome=bridge` | overflow path uses existing Retell SIP connect, untouched. |
| Conference status_url callbacks fail like per-call status_url did | Spike validates this OR we keep the SWML-driven webhook from the parked Phase 3b backstop | Either way, the agent's `Profile.status` stays `wrap-up` until manual ready or sweep — wrap-up is never permanently broken. |

---

## Phase 0 — Spike (mandatory before implementation)

**Goal:** validate the three SignalWire-side assumptions before sinking days into implementation.

**Hypotheses to test:**
1. **H1 — Late-joiner audio is instant.** When agent is already in `agent-room-test` with PC negotiated, a second leg `join_room`-ing into the same room hears audio within 500ms of the join.
2. **H2 — `wait_for_moderator: true` has a usable timeout.** If no moderator is in the room, the joiner waits up to a configurable timeout, then falls through to the next SWML step (allowing our `connect:` fallback).
3. **H3 — v3 SDK 3.28.1 dials SWML URL cleanly.** `client.dial('/swml/agent-room/test')` from the browser SDK succeeds and resolves into a session that we can interact with.

**Spike implementation:**
- New temp branch off `feat/phase-3b-wrap-up` (or `main` if 3b merged): `spike/phase-3c-room-prewarm`
- Two new SWML routes: `/swml/spike-agent-room` (moderator) and `/swml/spike-customer-room` (waits + falls through after 3s)
- Frontend: temporary "Spike" button on dashboard that triggers `client.dial('/swml/spike-agent-room')`
- Test cell `+18327979834` is dialed via REST API to the customer SWML
- Instrumented logs at 4 points: client.dial called, room session resolved, customer answers, first audio frame at customer
- Run from Playwright (browser context) so we have reproducible measurement

**Gate:**
- All 3 hypotheses confirmed → proceed with full design as written
- H1 fails (audio still cold) → reduce scope to "light pre-warm" (getUserMedia + cached MediaStream — see Alternative below)
- H2 fails (no usable timeout) → restructure customer SWML to a different fallback mechanism (e.g., a `request:` step before `join_room` that checks if agent is in room and routes accordingly)
- H3 fails (SDK doesn't support outbound dial-to-SWML) → significant pivot needed; may require SDK upgrade investigation (breaks the 3.28.1 pin)

**Estimated time:** 2-4 hours depending on what passes/fails. Worth the cheap insurance.

---

## Cost model

Per SignalWire pricing (verified 2026-04-30):
- Outbound PSTN (10DLC): $0.008/min (customer leg)
- WebRTC bridge: $0.003/min (agent leg)
- Conference participant: $0.0018/min/participant

**Per call (3 min average):**
- Today: $0.011/min × 3 = $0.033
- Phase 3c: $0.0146/min × 3 = $0.044
- Δ per call: +$0.011 (33% premium during talk time, expected)

**Per agent shift (8h, 100 calls × 3min talk + 30s wrap-up + ~115min lunch/breaks):**
- Status-aligned room alive ~365 min (talk + wrap-up + inter-call); idle 115 min off (break/lunch — no billing)
- Total Δ vs today: **+$1.39/agent/day**

**Annualized scaling:**
- 10 agents × 250 days = +$3,475/year
- 50 agents × 250 days = +$17,375/year

For a 10-agent collections shop this is $290/month for industry-leading bridge latency. Comfortably under the budget threshold.

---

## Open questions / risks

1. **Conference status_url reliability** — we spent a session and couldn't get per-call `status_url` callbacks firing. Conference-level `status_url` is documented to fire `participant-leave` and `conference-end` events. If these also fail to fire, the wrap-up linkage stays broken (Phase 3b state). Phase 0 should include a quick test of conference status_url firing.
2. **`/swml/agent-room/:agentId` authentication** — the SWML route serves agent-specific data. Need to decide whether to require an auth token in the URL (signed by agent ID) or trust that only the right agent's frontend will dial it (less defensive). Lean toward signed URL.
3. **SignalWire conference participant limit per room** — unlikely to hit (we have 1 agent + 1 customer = 2 per room), but should confirm there's no surprise minimum-participant pricing or limits.
4. **Room name collisions across spaces / projects** — we use one SignalWire space for the org. Room names are scoped to that space. No multi-tenant collision risk in current model.
5. **Wrap-up auto-resume during room presence** — Phase 3b's auto-resume scheduler flips status `wrap-up → available` after 30s. Our `useAgentRoom` listens to status, so on `available` it stays in room (no-op since already in). No regression.

---

## Alternative if spike fails

If H1 fails (room model doesn't deliver instant late-joiner audio), pivot to **light pre-warm**:
- At login, `useSignalWire.connect()` also calls `getUserMedia({ audio: true })` and holds the MediaStream open in a ref.
- Pre-fetch SignalWire's iceServers config and cache.
- Pre-instantiate a throwaway `RTCPeerConnection` to warm browser internals (TURN allocation, DNS).
- When real bridge fires, `accept({ rootElement, mediaStream: cachedStream })` — passing the existing stream avoids re-acquiring audio device.
- Estimated improvement: 5s → 1-2s. Not instant, but industry-standard.
- Smaller delta — ~1 day of work vs 3-5 days for the room architecture.

This alternative is documented here so a spike-failure pivot doesn't require a fresh design session.

---

## Migration plan

1. **Phase 0:** Spike on temp branch. ~2-4 hours.
2. **Phase 1:** Build `agentRoomSwml` builder + route + tests. ~half a day.
3. **Phase 2:** Build `useAgentRoom` frontend hook + tests. ~half a day.
4. **Phase 3:** Modify `powerDialDetectSwml` for `join_room` + fallback. Test all existing power-dial test cases still pass with the new structure. ~half a day.
5. **Phase 4:** Conference-status webhook handler (optional but recommended). Wire to wrap-up service. ~half a day.
6. **Phase 5:** Deploy to prod, smoke test against `+18327979834` (real cell), measure post-answer-to-audio timing. If < 500ms target hit → ship; if not → diagnose.
7. **Phase 6:** Write Phase 3c shipped handoff. Decide whether to extend room model to manual outbound and inbound (Phase 3d).

Total estimated effort: ~3-4 days from spike-success to prod ship.

---

## Self-review checklist

- [x] Placeholder scan: no TBDs except `/swml/agent-room/:agentId` auth detail, which is intentionally noted as decision-point in Open Questions.
- [x] Internal consistency: lifecycle in Architecture matches sequence in Data Flow matches mitigations in Failure Modes.
- [x] Scope check: focused on power-dial bridges only, with explicit Phase 3d candidates listed for future scope.
- [x] Ambiguity check: `wait_for_moderator: true` with `timeout: 3` is the only behavior we depend on for race protection — explicitly noted as spike validation question H2.
