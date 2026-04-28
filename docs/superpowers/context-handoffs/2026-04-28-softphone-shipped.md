# Outbound Softphone Shipped — Context Handoff

**Date:** 2026-04-28 (continuation of `2026-04-27-fabric-dial-stuck-at-new.md`)
**Audience:** Next session, picking up after the outbound softphone is finally end-to-end working.
**Pick this up by reading:** this doc, then the **earlier handoff** (`2026-04-27-fabric-dial-stuck-at-new.md`) only if you need history on dead-ends. The Fabric Resource architecture from that doc is gone — don't try to revive it.

---

## TL;DR

Outbound browser-to-PSTN calling works. Agent clicks dial, customer's cell rings, agent's browser auto-accepts a Fabric notification when the customer answers, audio bridges both ways, hangup works. UI shows connected state and the call duration timer ticks.

Final architecture is **PSTN-first Fabric bridge**: backend originates a call to the customer's PSTN number with inline SWML that, on customer-answer, connects to the agent's Fabric address `/private/<email-local-part>`. The agent's browser receives a native Fabric notification (NOT a SIP invite — that pattern is what broke for three sessions). `incomingCallHandlers.all` matches it to a `pendingOutboundRef` set just before the POST and auto-accepts silently.

Current commit: `720c927` (frontend timer fix). Working tree clean.

---

## Architecture as built (do not redo)

### Token mint flow ([backend/src/services/signalwire.ts:118-187](backend/src/services/signalwire.ts:118))

`generateBrowserToken(agentId, agentName, agentEmail, endpointReference)` is called from `/api/agents/token/signalwire`. The endpointReference is now **the agent's email** (e.g. `dominic@exec-strategy.com`), not the UUID — this was the missing piece for two days.

Flow:
1. `requestSubscriberToken({reference: email})` — returns `{token, subscriber_id}`. SignalWire auto-creates the subscriber if none matches the reference (it stores reference verbatim in the `email` field).
2. `ensureSubscriberPassword(subscriber_id, reference, email)` — PUT `/api/fabric/subscribers/{id}` with `{email, password}`. Idempotent. The `password` is derived deterministically from `SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET` (or the API token as fallback) hashed with the reference.
3. Return token.

Why both fields on PUT: the endpoint validates email format. PUT `{password}` alone returns 422 "Email is invalid" because the auto-created subscriber's email is a string we don't control. Sending the real email + password in one PUT both replaces the bogus auto-email and sets the password.

Why this is required at all: SignalWire's `POST /api/fabric/subscribers/tokens` auto-creates a subscriber if no match, but the auto-created subscriber has **no password**. Without a password, `client.online()` registration fails server-side with `code: -32603 "WebRTC endpoint registration failed"` and the SDK retries in a tight loop. Setting password after every mint fixes registration permanently.

### Outbound origination ([backend/src/services/signalwire.ts:189-237](backend/src/services/signalwire.ts:189))

`originateAgentBrowserCall({agentSipReference, toNumber, callerIdNumber, callbackUrl})` POSTs to `/api/calling/calls`:

```json
{
  "command": "dial",
  "params": {
    "from": "<DID>",
    "to": "<customer PSTN>",
    "caller_id": "<DID>",
    "swml": "version: 1.0.0\nsections:\n  main:\n    - answer: {}\n    - connect:\n        to: /private/<agentSipReference>\n        timeout: 30\n        answer_on_bridge: true\n    - hangup: {}",
    "status_url": "<backend>/signalwire/events/call-status"
  }
}
```

`agentSipReference` is the email's local-part (e.g. `dominic`). Derived in [calls.ts:434-438](backend/src/routes/calls.ts:434) as `agentProfile.extension || emailForFabric.split('@')[0] || req.user!.id`. It MUST match the Resource display_name SignalWire auto-derives from the subscriber's email (the local part), or `/private/<ref>` won't resolve.

### Why PSTN-first (not subscriber-first)

The earlier session (and the start of this one) tried the reverse: dial `/private/<ref>` from REST, get a SIP invite at the browser, auto-accept. Symptoms with the v3 browser SDK (`@signalwire/js@3.28.1`):

- The SDK doesn't fully track SIP-invite-driven calls in its Fabric event store. Console fills with `Got an unknown fabric event {type: 'call.state'}` warnings.
- WebRTC media negotiation never completes (peer connection stays in "new"; the answer-side RTP path never establishes).
- SignalWire's edge tears the call down ~4s after answer with `end_reason: "hangup", end_source: "none"` — system-initiated, neither leg hung up.

PSTN-first sidesteps the SDK limitation: when the customer answers and SignalWire executes the inline SWML's `connect:`, the agent's browser receives a **native Fabric notification**, not a SIP invite. The SDK handles those properly.

Trade-off: the agent waits ~3-30s while the customer rings — no progress audio. We could layer a hold-music or TTS step on the customer leg before the bridge, but punted for now.

### Frontend auto-accept ([frontend/src/hooks/useSignalWire.ts](frontend/src/hooks/useSignalWire.ts))

- `connect()` (called from a `useEffect` on dashboard mount) calls `await client.online({incomingCallHandlers: {all: ...}})`.
- `dial(toNumber)` sets `pendingOutboundRef.current` synchronously **before** the POST (placeholder ids, real `placedAt`), then awaits `POST /api/calls/browser-session`. If the Fabric notification beats the network round-trip (it can), the auto-accept handler still has a recent pending entry to match against.
- The `inviteMatchesPending` 60-second age fallback covers customer answer time.
- Auto-accept calls `notification.invite.accept({rootElement: ensureMediaRoot()})` — **just rootElement**, no audio/video flags. The container is a 1×1 fixed-position offscreen div appended to body. Both details matter; passing the wrong shape to `accept()` was a contributor to the 4s hangup.
- After `accept()` resolves, the handler **immediately** sets `onCall: true` (the bridge is already live by then). `wireRoomEvents` is forward-only — only `ending`/`ended` clears `onCall`; intermediate `created`/`ringing` events don't regress the UI.

### Dashboard call timer fix

`useEffect` at [page.tsx:150-160](frontend/src/app/dashboard/page.tsx:150) had `timer` in its dep array, which mutated every second as `seconds` updated, which re-fired the effect, which called `timer.start()` again, resetting to 0. Guarded with `wasOnCallRef` so `timer.start()` only fires on the transition INTO the call.

### SDK pin: 3.28.1

`@signalwire/js` is pinned at `3.28.1` exactly. Do not bump. v3.29+ introduced a connection pool that pre-creates RTCPeerConnections at session-init time before any user gesture; ICE gathering on those PCs times out (10s default), and the resulting poisoned PCs break dial. 3.28.1 predates the pool entirely.

---

## Live state (verified working)

- Subscriber: `df6a2e45-...` (or whatever exists at the moment — they auto-recreate). Email: `dominic@exec-strategy.com`. Password set.
- Agent UUID: `692a690e-770d-43bb-a151-8ec163141281`. Email: `dominic@exec-strategy.com`. No `extension` set in profile.
- Fabric address: `/private/dominic`. Resolves to `sip:dominic@fa653ed2-5eed-4403-8c70-74c285bb5ac2.call.signalwire.com;context=private` server-side.
- DID: `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`).
- Test cell: `+18327979834`.

### Backend env (Railway)

```
SIGNALWIRE_PROJECT_ID=fa653ed2-5eed-4403-8c70-74c285bb5ac2
SIGNALWIRE_API_TOKEN=PT3a64b405c35e7e48f01bf3fd79867b51e7ef9b117540f70b
SIGNALWIRE_SPACE_URL=executive-strategy.signalwire.com
SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true
SIGNALWIRE_SUBSCRIBER_PASSWORD_SECRET=<not set; falls back to API token>
```

### Deploy invocation (locked in)

```
railway up backend --path-as-root --service backend --ci
railway up frontend --path-as-root --service frontend --ci
```

Push triggers nothing — Railway auto-deploy is not wired.

### URLs

- Frontend: https://frontend-production-8067.up.railway.app
- Backend: https://backend-production-e2bf.up.railway.app
- SignalWire space: https://executive-strategy.signalwire.com
- Repo: `C:\Users\Elite Portfolio Mgmt\Downloads\EliteDial2.0\EliteDial`. Branch `main`.

### Login

`dominic@exec-strategy.com` / `TempPass2026`.

---

## Commit graph (chronological — all this session)

```
720c927 fix(dashboard): guard timer.start() on call-into transition only ← timer fix
b1ac2d6 fix(softphone): make wireRoomEvents forward-only ← UI bouncing fix
74574e5 fix(softphone): mark onCall=true on auto-accept
18bceff feat(softphone): PSTN-first origination ← THE PIVOT
30ad090 fix(swml): explicit answer + drop pre-bridge say
998dc38 fix(softphone): simplify invite.accept + 1x1 offscreen media root
26471da fix(signalwire): use email (not UUID) as subscriber reference ← MAJOR
7219f9d fix(signalwire): include email when PUTting subscriber password
a01456f fix(signalwire): force-set password after every SAT mint ← REGISTRATION FIX
8b55657 fix(softphone): pass rootElement to invite.accept and guard empty callId
b84e499 fix(softphone): set pendingOutboundRef before POST (race fix)
4569e62 fix(signalwire): originate to Fabric address /private/<ref>
b2018be fix(signalwire): include password in fabric subscriber creation
a866943 revert(softphone): back to legacy SIP-invite flow (Fabric Resource dead-end)
89ce725 diag(signalwire): discover Resource address via /api/fabric/addresses
949aecc fix(softphone): pin @signalwire/js to 3.28.1
bf43ba5 fix(softphone): defer SDK init until after mic + audio ready
```

Earlier handoff for context: 42b119d / `docs/superpowers/context-handoffs/2026-04-27-fabric-dial-stuck-at-new.md`.

---

## What was tried and ruled out (don't redo)

- **Fabric Resource pattern** (subscriber dials a SWML script Resource at `/private/<resource-name>`). Dead-end. SWML script Resources have no `addresses` field on the Resource object; SignalWire never exposes a routable address for them, and `/private/<resource-name>` is for `type: subscriber` only. Live diagnostic confirmed: `addressesSample=null` from `/api/fabric/addresses`.
- **Direct PSTN dial via `client.dial("+1...")`** from the browser. The b81ae30 commit message from the prior session documents this: Fabric's `client.dial` accepts only Fabric-address URNs (subscribers/rooms), not bare PSTN. UI showed "connected" against a phantom call.
- **`@signalwire/js@3.29.x`**. Connection pool regression — see SDK pin section.
- **Hand-built SIP URI `sip:<ref>@<space>`**. Wrong host. Direct API probe revealed SignalWire's correct internal SIP shape is `sip:<ref>@<projectId>.call.signalwire.com;context=private`. Better still: just pass `/private/<ref>` and let SignalWire resolve it.
- **`disableUdpIceServers` on `client.dial()`**. Not a documented option. Ignored if passed.
- **Mobile hotspot** (network firewall theory). Doesn't matter — the issues were all logical (config / SDK / API), not network.

---

## Known minor issues (polish, not blockers)

1. **`Got an unknown fabric event {type: 'call.state'}` console warnings**. The v3 SDK doesn't fully route call.state events for Fabric-bridge calls to `room.on('call.state', ...)`. We sidestep it: optimistic `onCall: true` after accept, listen for `call.left` for cleanup. Functional but noisy. If SignalWire ships an SDK fix for this, we can simplify the handler.
2. **No customer-side hold audio during ring**. While the customer's cell rings and the bridge forms, the agent waits in silence on a "Connecting…" UI. Could add a TTS step or hold music in the inline SWML before `connect:`. Optional.
3. **`/api/calls/<id>/browser-status` may receive empty-id POSTs in fast-race scenarios**. Guarded server-side already (the route returns 404 for empty id), and the frontend now skips the POST when `backendCallId` is empty. No actual breakage, just minor log noise.
4. **`useRealtime` Socket.IO connection error**: `WebSocket is closed before the connection is established`. Not blocking, prints in console at page load. Separate from the softphone path.
5. **favicon.ico 404**. Cosmetic.

---

## Out of scope for next session

- Inbound calling. Hasn't been touched. The `incomingCallHandlers.all` handler has the genuine-inbound branch (sets `pendingInviteRef`, surfaces UI) but it's never been exercised live. The DID's voice webhook points at `/swml/inbound`. Test path: call `+13467760336` from a real phone, verify the browser shows an Accept/Reject prompt, accept, audio works.
- Multi-agent. Right now there's one user. Subscriber provisioning is per-email so it should "just work" but hasn't been tested.
- Recording playback UI. `/swml/bridge` SWML still has `record_call: { stereo: true, format: 'mp3' }` but the recordings aren't surfaced in the UI.
- Outbound dial UX polish (ring tone, status patter). Acceptable as-is.

---

## Quick orientation for the next session

If something breaks, in this order:

1. **`WebRTC endpoint registration failed` in console.** Check that the subscriber has a password set. Use the API directly:
   ```bash
   PROJECT=fa653ed2-5eed-4403-8c70-74c285bb5ac2
   TOKEN=<api token from Railway env>
   AUTH=$(echo -n "$PROJECT:$TOKEN" | base64 -w0)
   curl "https://executive-strategy.signalwire.com/api/fabric/subscribers?page_size=20" -H "Authorization: Basic $AUTH"
   ```
   If a subscriber's email is a UUID instead of `dominic@exec-strategy.com`, the password setter didn't fire — check Railway logs for `ensureSubscriberPassword` errors. If multiple duplicate subscribers exist, the email-as-reference flow may have regressed.

2. **Cell doesn't ring at all.** Backend log shows `Browser-originated outbound call placed` but no `swml.bridge invoked`? Means SignalWire didn't even try to dial PSTN. Check the inline SWML in `originateAgentBrowserCall` is well-formed (YAML indentation matters). The unit test at [signalwire-service.test.ts:146](backend/src/test/signalwire-service.test.ts:146) asserts the structure.

3. **Cell rings but browser doesn't react when agent answers.** Means the Fabric notification didn't reach the browser. Check `client.online()` succeeded (no `-32603` in console). Check `pendingOutboundRef.current` was set and is within 60s. If both look right, the Fabric address `/private/<local-part>` may have drifted from the subscriber's actual auto-derived display_name — list resources via API to verify:
   ```bash
   curl "https://executive-strategy.signalwire.com/api/fabric/resources?page_size=20" -H "Authorization: Basic $AUTH"
   ```
   Look for the `type: subscriber` entry; its `display_name` is what `/private/<...>` must match.

4. **Audio one-way or no audio.** Make sure the hidden media root container exists in the DOM (`document.getElementById('__sw_media_root')`). Hard refresh evicts stale bundles.

---

## Honest note

This took three sessions over ~36 hours. The single biggest time-sink was treating UUID-as-reference as a non-issue when it was the root cause of the WebRTC registration loop. The second biggest was assuming the SIP-invite-to-subscriber flow was the canonical pattern; it isn't, at least not for the v3 browser SDK. PSTN-first with inline SWML is what SignalWire actually wants.

If the next session needs to extend this (inbound, multi-agent, AI bots, etc.) the architecture is solid. Don't refactor it.
