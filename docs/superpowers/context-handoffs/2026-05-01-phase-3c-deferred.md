# Phase 3c — Deferred (warm bridge bridge SWML reverted, infrastructure kept)

**Date:** 2026-05-01
**Branch:** feat/phase-3b-wrap-up
**Status:** Phase 1, 2, 5 of plan **shipped to prod and stable**. Phase 3, 4 of plan **reverted** after live smoke surfaced a structural flaw in H3.

---

## TL;DR

The pre-warm conference architecture has a structural flaw I missed in the Phase 0 spike: **`client.dial({ to: <https-url> })` from the v3 SDK returns a `FabricRoomSession` synchronously without ever fetching the SWML URL.** The agent's UI showed "Bridge ready" but SignalWire never executed our `/swml/agent-room/:id` route, so the agent was never actually in a conference. Customer legs would `wait_for_moderator: true; timeout: 3` against an empty room, time out, and fall through to the cold connect — a net **3s WORSE** than today's behavior (3s of silence + the existing 3-5s cold ringback = 6-8s).

I reverted commits `67aecd6` (power-dial bridge `join_room`) and `8a17840` (manual outbound `join_room`). Prod is back to today's known-working behavior. All other Phase 3c work (builder, signed URLs, hook, conference webhook, plus a useful Phase-3b status-event fix) is committed and dark — waiting on the right SignalWire-side primitive to make client-initiated rooms actually work.

---

## What's still in production from this session

These commits add **inert infrastructure**: nothing in the live call path uses them yet. Safe to leave.

| Commit | Branch state |
|---|---|
| `649a683` feat(swml): `agentRoomSwml` builder | Pure function, only used by `/swml/agent-room/:id` route below |
| `364b014` feat(signed-url): HMAC `signAgentRoomUrl`/`verifyAgentRoomSignature` | Used only by the agent-room route |
| `285cde0` feat(swml): `/swml/agent-room/:id` + `/api/agents/:id/room-url` mint endpoint | World-callable but no client invokes it (revert removed the dashboard call sites) |
| `8b80322` feat(frontend): `dialRoom` on `useSignalWire`, `useAgentRoom` hook, dashboard mount | Hook is mounted on the dashboard but with the bridge SWML reverted, the customer leg never tries to `join_room` so the warm room is irrelevant |
| `0202a0a` fix(agents): emit `profile.status` socket event on manual Avail/Break toggle | **Real fix unrelated to Phase 3c** — pre-existing latent bug surfaced. Manual status toggles now reflect on the dashboard's `useProfileStatus` state in real time. |
| `44bf187` feat(wrap-up): conference-status webhook + `agentRoomSwml.statusUrl` | Webhook is wired up but no conference exists to fire events from |
| `579969e` fix(useProfileStatus): re-subscribe + rehydrate on socket reconnect | **Real fix unrelated to Phase 3c** — pre-existing latent bug where `useSocket.on` silently no-op'd when subscribed before connect |
| `f8fcd44` fix(useAgentRoom): retry reconcile when user.id or sw.connected become available | Hook resilience fix (no effect with bridge SWML reverted) |
| `f4810d5` fix(useAgentRoom): take `sw` as a param so we share dashboard's connection | Hook architecture fix (no effect with bridge SWML reverted) |

## What got reverted

| Reverted commit | Original SHA | Why |
|---|---|---|
| `7b6c11f` Revert | `8a17840` feat(softphone): manual outbound `join_room` + cold fallback | Bridge SWML's `join_room` finds no moderator → 3s timeout silence + cold connect = 3s WORSE than today |
| `499d71e` Revert | `67aecd6` feat(power-dial): bridge SWML `join_room` + cold fallback | Same reason, on the power-dial path |

After reverts: `bridgeSection` in `powerDialDetectSwml` and the inline SWML in `originateAgentBrowserCall` are byte-identical to the pre-Phase-3c versions running in prod since 2026-04-29. Verified: `npm test` green (302/302), tsc clean.

---

## What we learned that the spike didn't tell us

### The `client.dial({ to: <https-url> })` lie

In the spike I observed `[spike] room session resolved 7ms` and accepted that as H3 partial-pass. The hypothesis was that 7ms was just SDK promise resolution and the underlying WebRTC negotiation continues async. I was wrong. **`client.dial` accepts the `to` parameter, returns a session synchronously, and never fetches the URL at all** — the session is a dud. Confirmed during live smoke today:

- Frontend logs: `[useAgentRoom] dialRoom resolved {ms: 22, hasSession: true}`
- Backend logs: zero hits to `/swml/agent-room/692a690e-...` from SignalWire
- "Bridge ready" UI showed but no conference existed

The v3 SDK's `DialParams.to` is documented for **Fabric resource addresses** (`/private/<id>`, `/public/<id>`, `/swml/<resource-name>` where resource is registered in the dashboard). Arbitrary HTTPS URLs are **silently accepted but not executed**.

### What the right primitive is (for next session)

To actually put a browser into a SignalWire-side SWML room, we need to **register the agent-room SWML as a Fabric SWML Script Resource** via `POST /api/fabric/resources/swml_scripts`. That endpoint is already used elsewhere in `signalwire.ts` (lines 433, 524). The flow becomes:

1. **One-time per agent (or one shared resource):** POST a SWML doc to `/api/fabric/resources/swml_scripts`, get back a Resource ID + addressable Fabric path (something like `/swml/agent-room-shared` or per-agent `/swml/agent-room-<id>`).
2. **Per shift:** `client.dial({ to: '/swml/agent-room-<id>' })` — SignalWire looks up the resource, executes its SWML (which contains `join_room`), agent enters the conference.
3. The signed-URL HMAC stuff we built becomes irrelevant (Fabric address auth is handled at SignalWire's end via subscriber identity).

Alternatively, we could keep the `/swml/agent-room/:id` Express route as the SWML source-of-truth and have the resource registration POST a small SWML doc that just contains a `request:` step pointing back at our route. That preserves the codebase pattern of "all SWML lives in `swml/builder.ts`" while letting Fabric address resolution work.

### Real bugs surfaced unrelated to Phase 3c

1. **`PATCH /api/agents/:id/status` didn't emit `profile.status` socket events.** Only server-driven transitions (`enterWrapUp`, `exitWrapUp`, sweep) emitted. Manual Avail/Break/Offline clicks updated the DB but the dashboard's `useProfileStatus` stayed stale. **Fixed in `0202a0a`.** This was a latent issue since Phase 3b shipped.
2. **`useSocket.on` silently no-op'd subscriptions made before the socket connected.** `socketRef.current?.on(event, handler)` — the optional chaining swallowed pre-connect subscriptions. `useProfileStatus` subscribed at mount with `[on, off]` deps that never changed, so it never re-subscribed after connect. **Fixed in `579969e`** by adding `connected` to the deps + rehydrating from REST on connect. Other hooks (`useSignalWire`) accidentally worked because their deps included the whole `realtime` context object which changes on re-render.

Both fixes survive the Phase 3c revert and are real wins.

---

## State of prod after this session

- Backend: Phase 3a + Phase 3b unchanged. Bridge SWML restored to pre-Phase-3c form. New routes/handlers (`agent-room`, `room-url`, `conference-status`) deployed dark.
- Frontend: `useAgentRoom` hook still mounts on dashboard but is a no-op against the cold-fallback flow. "Bridge connecting…" indicator may briefly show in the header on Avail toggle (cosmetic — the hook fires, mints a URL, dials, gets a dud session, then sits as `inRoom: true` despite no real conference). Could clean this up but it's functionally harmless.
- Tests: 302/302 pass.
- Manual outbound + power-dial bridges: 3-5s cold ringback, **same as 2026-04-29 prod state**.

### Cosmetic cleanup recommended for next session

If we don't pivot back to Phase 3c soon, consider unmounting `useAgentRoom` from the dashboard so the "Bridge connecting…" / "Bridge ready" header text stops showing. One-line edit in `dashboard/page.tsx`. Low priority — the false "Bridge ready" doesn't break anything, just confuses anyone reading the header.

---

## Phase 3d / next-session plan

**Two viable paths:**

### Path A — Fabric SWML Script Resource registration (the "right" way)

1. New service in `backend/src/services/signalwire.ts`: `ensureAgentRoomResource(agentId)` — POSTs/PUTs a SWML script resource via `/api/fabric/resources/swml_scripts`, returns `{ resourceAddress: '/swml/agent-room-<id>', resourceId }`.
2. Modify `useAgentRoom`: instead of GET `/api/agents/:id/room-url` and dialing the HTTPS URL, GET `/api/agents/:id/room-address` and dial `/swml/agent-room-<id>`.
3. Re-cherry-pick the bridge SWML changes (`67aecd6`, `8a17840`) from this session — they're already correct as written (just blocked on the room actually existing).
4. Conference-status webhook (already shipped) wires up automatically once the conference actually exists.
5. Smoke against the same `+18327979834` cell. Real H1 validation this time.

**Estimated effort:** 1-1.5 days. Most of the code is already written; just needs the SignalWire-side resource registration plumbing + a refactor of the hook's URL → address pivot.

### Path B — "Light pre-warm" alternative (the spec's documented fallback)

Documented in `docs/superpowers/specs/2026-04-30-phase-3c-webrtc-pre-warm-design.md` § "Alternative if spike fails":
- At login, `useSignalWire.connect()` also calls `getUserMedia({ audio: true })` and holds the MediaStream open in a ref.
- Pre-fetch SignalWire's iceServers config and cache.
- Pre-instantiate a throwaway `RTCPeerConnection` to warm browser internals (TURN, DNS).
- When real bridge fires, `accept({ rootElement, mediaStream: cachedStream })` — passing the existing stream avoids re-acquiring the audio device.
- Estimated improvement: 5s → 1-2s. Industry standard, not industry-leading.
- Smaller surface area; doesn't depend on conference-room semantics.

**Estimated effort:** 1 day. No SignalWire-side resource plumbing needed. Doesn't deliver the <500ms target but is a safer ship.

### Recommendation

**Path A first**, with Path B as a fallback if SignalWire's resource registration turns out to have its own quirks. Path A reuses ~80% of the code already shipped this session. Path B requires entirely different frontend changes (and discards most of the room infrastructure).

If Path A's resource registration is straightforward (it's documented and used elsewhere in `signalwire.ts`), this is a half-day to bring Phase 3c home.

---

## Files of interest for the next session

- **Spec:** `docs/superpowers/specs/2026-04-30-phase-3c-webrtc-pre-warm-design.md` (still accurate; failure-mode and alternative sections are the relevant parts)
- **Plan:** `docs/superpowers/plans/2026-04-30-phase-3c-webrtc-pre-warm.md` (Tasks 1-6 + 10 are shipped/dark; Tasks 7-9 are reverted — re-cherry-pickable for Path A)
- **Spike results:** `docs/superpowers/context-handoffs/2026-05-01-phase-3c-spike-results.md` (now superseded — H3 was a false positive)
- **This doc:** `docs/superpowers/context-handoffs/2026-05-01-phase-3c-deferred.md`

## Resume instruction for the next session

Read this doc + the spec § "Failure modes" + "Alternative if spike fails". Decide Path A or Path B with the user (or default Path A if no preference). For Path A: implement `ensureAgentRoomResource`, refactor `useAgentRoom` to use the Fabric address, cherry-pick the two reverted commits' content (they're correct in spirit; just need the room to actually exist), smoke. For Path B: revert/unmount Phase 3c frontend pieces, build the light-pre-warm path on top of `useSignalWire.connect()`.
