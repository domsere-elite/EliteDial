# Outbound Browser Dial Stuck at WebRTC State `new` — Context Handoff

**Date:** 2026-04-27 (continuation of `2026-04-27-softphone-architecture.md`)
**Audience:** Next session, picking up after a full implementation of Option 1 (Fabric Resource pattern). The architecture is built. It does not work yet.
**Pick this up by reading:** this doc end-to-end. Don't re-read the earlier handoffs unless something here references them.

---

## TL;DR

Built the Fabric Resource architecture end-to-end. Backend gets/creates a per-agent SWML script Resource and rewrites its inline SWML to bridge to the requested PSTN destination. Frontend `client.dial("/private/agent-dial-<uuid>")` returns a `FabricRoomSession` with `id="..."` and `state="new"`. **The state never progresses past `new`.** No `call.state` events fire. The SWML on SignalWire's side never executes. The cell never rings.

This is a different failure mode than the previous handoff's `WebRTC endpoint registration failed`. That is gone. This is a new wall: WebRTC media negotiation between the browser and SignalWire isn't completing. ICE gathering hits a 10-second timeout every time, and the SDK proceeds anyway with an incomplete offer.

---

## Where we ended (commit `bdf773f`, deployed to Railway 2026-04-27 ~21:31 UTC)

### What works
- Login.
- Frontend serves `https://frontend-production-8067.up.railway.app/`, dashboard renders, dial pad opens, `+18327979834` types into the input.
- Backend `/health`: `{db:connected, signalwire:true, retell:true, crm:false}`.
- 217/217 backend tests pass.
- `client.online()` failure is no longer a blocker — we removed the call entirely (handler body preserved as a comment in [useSignalWire.ts](frontend/src/hooks/useSignalWire.ts)).
- Backend `/api/calls/browser-session` returns a valid SWML Resource address. Verified live: agent's Resource ID `eef48bba-c7a8-4acd-94ae-cf6b3b33bd85`, address `/private/agent-dial-692a690e-770d-43bb-a151-8ec163141281`. Resource's inline SWML is exactly:
  ```yaml
  version: 1.0.0
  sections:
    main:
      - answer: {}
      - connect:
          to: +18327979834
          from: +13467760336
          timeout: 30
          answer_on_bridge: true
      - hangup: {}
  ```
- Frontend dial path runs cleanly through every step we instrumented:
  - `[SW-DIAL] AudioContext state before resume: running`
  - `[SW-DIAL] mic permission OK, tracks: ['Microphone Array …']`
  - `[SW-DIAL] client.dial → address: /private/agent-dial-692a690e-…`
  - `[SW-DIAL] dial returned room session, attaching events. roomId: 127f625d-2d01-4175-b206-c8c530fe5a4d roomState: new`

### What's broken
After `client.dial()` returns the FabricRoomSession in state `new`, **nothing else happens**. Captured behavior:
- Periodic poll every 5s shows `state: new` indefinitely (we sample for 30s).
- Zero `call.state` events fire.
- Zero `destroy` events fire.
- No POST to `/api/calls/<id>/browser-status` reaches the backend.
- The SWML on SignalWire's side does not execute (cell never rings, no PSTN dial attempt).

### The smoking gun in the logs
Every dial sequence logs `ICE gathering timeout, proceeding anyway` from the SDK 10s after pool init. The pool then claims success — `Pool initialized with 1 connections / Connection pool initialized successfully` — but the resulting peer connection apparently can't complete SDP negotiation with SignalWire's edge.

---

## Architecture as built (do not redo)

### Backend ([signalwire.ts:262](backend/src/services/signalwire.ts:262))
Two new methods on `signalwireService`:
- `ensureAgentDialResource(agentReference)` — lists `/api/fabric/resources?page_size=200`, finds the existing `swml_script` Resource named `agent-dial-<agentRef>` if present, creates one if not. Returns `{resourceId, address}` where address is `/private/agent-dial-<agentRef>` (no `?channel=audio` — the SDK silently fails with that query string).
- `updateAgentDialResource(resourceId, {to, from, name})` — PUTs the Resource's inline SWML to `[answer, connect{to,from,timeout:30,answer_on_bridge:true}, hangup]`. ~200ms per dial. Confirmed working live.

### Backend ([calls.ts:381](backend/src/routes/calls.ts:381))
`/api/calls/browser-session` no longer originates via REST. Flow now:
1. Validate `toNumber`, DNC check, agent profile lookup, create unified call record.
2. `signalwireService.ensureAgentDialResource(agentSipReference)` — get/create the Resource.
3. `signalwireService.updateAgentDialResource(resourceId, {to, from, name})` — set the destination.
4. Return `{callId, callSessionId, resourceAddress, status: "ringing", fromNumber, transport: "fabric-resource"}`.

The old `originateAgentBrowserCall` method on `signalwireService` is kept (still exported; its tests still pass) but no longer called by any route. **Decision for next session:** delete it once Fabric flow is fully proven.

### Frontend ([useSignalWire.ts](frontend/src/hooks/useSignalWire.ts))
- `client.online()` is **not called**. The handler body for incoming-call notifications is preserved as a comment block to be restored when SignalWire fixes registration.
- `dial(toNumber)`:
  1. `POST /calls/browser-session` → `{callId, resourceAddress, fromNumber}`.
  2. Resume AudioContext (it auto-init's suspended on page load before any click).
  3. `navigator.mediaDevices.getUserMedia({audio:true})` to force the mic permission prompt before dial. Stream is stopped immediately; SDK requests its own.
  4. `await client.dial({to: resourceAddress, audio: true, video: false})` → returns FabricRoomSession.
  5. `wireRoomEvents(room, callId)` attaches `call.state` and `call.left` listeners.
  6. Diagnostic: also attaches a second `call.state` console.log, a `destroy` console.log, exposes `window.__lastRoom`, and runs a periodic poll printing `room.state` every 5s for 30s.

### SDK + token state
- `@signalwire/js@^3.29.2` (latest as of session date).
- Token: SAT from `POST /api/fabric/subscribers/tokens` with body `{reference: <agentId>}`. Encrypted JWE so its scopes can't be inspected client-side.
- API credential rotated mid-session: old `PT006342…` revoked. Current `PT3a64b405b…40f70b` is set on Railway backend `SIGNALWIRE_API_TOKEN` env. Project ID and space URL unchanged.

### Live Resource state
- Agent subscriber: `692a690e-770d-43bb-a151-8ec163141281` (this is Dominic's Profile UUID; he has no `extension` set so the UUID is the fallback reference everywhere).
- Subscriber Resource (auto-provisioned on first token request): id `a0340349-…` was deleted earlier in the session and recreated as `728fc07d-…` (then deleted again — see Activity log below). Auto-recreates on next token request via `SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true`.
- SWML script Resource for outbound dial: id `eef48bba-c7a8-4acd-94ae-cf6b3b33bd85`, name `agent-dial-692a690e-770d-43bb-a151-8ec163141281`, address `/private/agent-dial-692a690e-770d-43bb-a151-8ec163141281`. **This is real and current, you don't need to recreate it.**
- The earlier test Resource `outbound-bridge-test` (id `94403e00-c301-4b70-90bb-9acd806523f1`) is still live with neutered SWML (just plays a TTS message, no PSTN connect). Safe to leave or delete.

---

## What to try first in the next session

The architecture is correct. Something is preventing the WebRTC peer from completing media negotiation with SignalWire. Suspects in priority order:

### 1. STUN/TURN (likeliest, given the recurring "ICE gathering timeout" log)
The pool initializes with no server-supplied ICE candidates beyond the timeout. SignalWire's edge may be requiring TURN-relay candidates that we never gather because the SDK's defaults aren't configured. Things to try:
- Check the `SignalWire({token})` init options for `iceServers` / `disableUdpIceServers` / `iceTransportPolicy`. The skill doc shows `disableUdpIceServers` as a parameter on the dial options — try `disableUdpIceServers: true` on `client.dial(...)` to force TCP/TLS via TURN.
- Test from a different network (mobile hotspot) to rule out the user's local firewall blocking UDP STUN.
- The skill's `webrtc-enabled-agent.py` example loads the SDK from `https://cdn.signalwire.com/libs/swrtc/2.0.0/signalwire.min.js` (not npm). Try the CDN bundle to rule out a packaging issue with `@signalwire/js@3.29.2`.

### 2. Connection pool created in suspended-AudioContext state
The pool initializes during `await SignalWire({token})` on page load — before any user gesture. AudioContext is suspended at that moment. The SDK pre-creates an RTCPeerConnection with media tracks attached to a suspended audio sink. When dial runs later, even though we resume AudioContext + grant mic, the existing pool connection may be poisoned. Things to try:
- Defer `SignalWire({token})` initialization until after the user clicks the dial pad open (or a "Connect softphone" button). Move it out of `useEffect` / page load.
- Or destroy and recreate the client on each dial.

### 3. The Resource's SWML doesn't actually answer until the WebRTC leg is media-ready
Possible: `connect:` runs as soon as `answer:` resolves, but `answer:` requires the inbound (browser) leg to be in `answered` state, which requires successful SDP negotiation. If our peer is incomplete, `answer:` never fires. Things to try:
- Check the SignalWire dashboard's `Logs > Calls` page for the room ID `127f625d-…` to see if SignalWire sees the dial at all and what state it reports server-side.
- Open a SignalWire support ticket with that room ID; ask whether the edge received our WebRTC offer.

### 4. Bug in `@signalwire/js@3.29.2`
- Pin to an earlier version (3.28.x) and retry. Check the SignalWire SDK changelog/issues for ICE/dial bugs in 3.29.

### Don't bother
- Reverifying the Resource SWML — confirmed correct via API.
- Reverifying the address format — `/private/agent-dial-<uuid>` works (the bare path, NOT with `?channel=audio`).
- Reverifying mic permission / AudioContext — both confirmed working in the latest test.
- Reverifying the subscriber token — it's a valid SAT, the SDK reports `Session authorized`.

---

## Latest test transcript (2026-04-27 21:31:05 UTC)

```
[Session authorized] connection pool / RTCPeerConnection pool init begins
[SW-DIAL] AudioContext state before resume: running
[SW-DIAL] mic permission OK, tracks: ['Microphone Array (Intel® Smart Sound Technology for Digital Microphones)']
[SW-DIAL] client.dial → address: /private/agent-dial-692a690e-770d-43bb-a151-8ec163141281
[SW-DIAL] dial returned room session, attaching events. roomId: 127f625d-2d01-4175-b206-c8c530fe5a4d roomState: new
[SDK] ICE gathering timeout, proceeding anyway   ← key warning, fires every dial
[SDK] Pool initialized with 1 connections
[SDK] Connection pool initialized successfully
[SW-DIAL] periodic poll 1 state: new
[SW-DIAL] periodic poll 2 state: new
[SW-DIAL] periodic poll 3 state: new
… (no further events)
```

Backend log for the same dial:
```
Browser-originated outbound call: Resource configured
  address="/private/agent-dial-692a690e-770d-43bb-a151-8ec163141281"
  agent="dominic@exec-strategy.com"
  callId="<uuid>"
  from="+13467760336" to="+18327979834"
  resourceId="eef48bba-c7a8-4acd-94ae-cf6b3b33bd85"
```

No `/api/calls/<id>/browser-status` POST follows. No SignalWire-side LaML Calls.json entry (LaML is empty for the whole session — expected; LaML doesn't track `/api/calling/` or Fabric-routed calls).

---

## Things changed this session

### Files
- `EliteDial/backend/src/services/signalwire.ts` — added `ensureAgentDialResource`, `updateAgentDialResource`. Kept `originateAgentBrowserCall` (unused but tests still pass).
- `EliteDial/backend/src/routes/swml.ts` — added a `swml.bridge invoked` diagnostic log at the top of `/swml/bridge`. Currently dead code (Fabric Resource flow doesn't go through `/swml/bridge`); safe to keep or remove.
- `EliteDial/backend/src/routes/calls.ts` — rewrote `/api/calls/browser-session` to use Resource update flow. Removed `providerCallId` from response (not available without origination).
- `EliteDial/frontend/src/hooks/useSignalWire.ts` — removed `client.online()` call. Rewrote `dial()` for Resource flow. Added AudioContext resume, mic permission step, periodic state poll, `window.__sw` and `window.__lastRoom` exposure for console inspection. The `pendingOutboundRef`, `inviteMatchesPending`, and the auto-accept logic in incomingCallHandlers are commented out / unreachable but the helper function definitions remain.

### Commits (chronological)
- `0051d2a` — chore(softphone): test hooks for Fabric Resource POC
- `ef8699d` — fix(softphone): treat client.online() failure as non-fatal
- `6309e54` — chore(softphone): log online() error as text for diagnosis
- `da1a17f` — fix(softphone): stop calling client.online() — unblocks outbound dial
- `368130e` — feat(softphone): real outbound via Fabric Resource update + client.dial
- `54bb28c` — fix(softphone): drop ?channel=audio from dial address + add diag logs
- `bdf773f` — fix(softphone): unsuspend AudioContext + request mic before dial *(current)*

If the Fabric pivot is abandoned, `git revert bdf773f 54bb28c 368130e da1a17f 6309e54 ef8699d 0051d2a` is the clean undo. The env var changes on Railway and the `outbound-bridge-test` + `agent-dial-…` Resources on SignalWire are independent and should stay.

### SignalWire-side
- API token rotated. Old `PT006342…84599` revoked. New `PT3a64b405…40f70b` set on Railway backend.
- Resources created/deleted during diagnosis:
  - Probe `outbound-bridge-probe` (deleted)
  - Test `outbound-bridge-test` id `94403e00-c301-4b70-90bb-9acd806523f1` (still live, neutered, harmless)
  - Production `agent-dial-692a690e-…` id `eef48bba-c7a8-4acd-94ae-cf6b3b33bd85` (current, used by the dialer)
- Subscriber `728fc07d-2205-4e3e-917c-29e0d0b860e3` was deleted to clear stale state. Re-created automatically on next login.
- Real PSTN call attempts placed: zero this session (everything stuck at room state `new`). One attempt from the previous session at 16:02 UTC — provider call ID `d397f146-…` — may have billed.

---

## Quick orientation

- **Repo:** `C:\Users\Elite Portfolio Mgmt\Downloads\EliteDial2.0\EliteDial`. Branch `main`. Commit `bdf773f`. Working tree clean.
- **Railway services:** `elite-dialer` workspace `domsere-elite's Projects`. Backend `https://backend-production-e2bf.up.railway.app`, frontend `https://frontend-production-8067.up.railway.app`.
- **Deploy invocation (locked in):** `railway up backend --path-as-root --service backend --ci` (and same for `frontend`). Railway auto-deploy is NOT wired up; pushes to `main` do not trigger a redeploy by themselves.
- **SignalWire space:** `executive-strategy.signalwire.com`. Project ID `fa653ed2-5eed-4403-8c70-74c285bb5ac2`. DID `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`), voice webhook → `/swml/inbound`.
- **Seed admin:** `dominic@exec-strategy.com` / `TempPass2026`. UUID `692a690e-770d-43bb-a151-8ec163141281`. No `extension` set.
- **Test cell:** `+18327979834` (Dominic's).

---

## Out of scope for next session

- Re-doing auth, deploy, env vars, or the Resource architecture itself.
- Re-verifying that the Resource SWML is correct or that backend builds it correctly. Both are confirmed.
- Inbound calling. Until outbound's media path is resolved, inbound (which would use a conference-park + Socket.IO accept pattern, also via `client.dial`) will hit the same wall. Punt until outbound dials successfully.
- The `client.online()` registration issue. Receiving calls in the browser is gated on SignalWire support fixing that. Stay out of it for now.

---

## Honest note

We have a fully-built architecture that's blocked on what looks like a network/SDK media-negotiation issue with SignalWire. The next session should NOT spend time re-building anything. It should focus narrowly on getting the WebRTC leg to actually negotiate with SignalWire's edge — STUN/TURN config, network rule-out, or filing a SignalWire support ticket with room ID `127f625d-2d01-4175-b206-c8c530fe5a4d` for them to look at server-side.

If that path stays blocked beyond a day, the realistic pivot is Telnyx (skill support exists in this environment via `telnyx:telnyx-webrtc-client-js` — that SDK has a much more documented WebRTC path).
