# Softphone Architecture Pivot — Context Handoff

**Date:** 2026-04-27
**Audience:** Next session, picking up after two failed Phase-1 outbound iterations.
**Pick this up by reading:** this doc end-to-end. Don't re-read the earlier handoffs unless something in this one references them.

---

## TL;DR

Backend now correctly originates outbound calls via SignalWire REST (was previously routed to mock telephony by a stale `TELEPHONY_PROVIDER=voximplant` env override). But the destination it dials — `sip:<agent-uuid>@<space>.signalwire.com` — does **not** route to the agent's Fabric subscriber browser. SignalWire's REST `command:dial` API has no documented way to ring a Fabric subscriber. The Phase-1 plan was architecturally wrong, not just buggy.

**Decision made at end of session: pivot to Option 1 (SignalWire Fabric Address/Resource pattern), in a fresh session.**

---

## Current state (commit `b81ae30`, pushed to `origin/main`)

### What works
- Login (Supabase JWT verified by backend JWKS, Profile lookup by `claims.sub`).
- Frontend deploys to Railway (`db09e63a SUCCESS` 2026-04-27 09:44).
- Backend deploys to Railway (`16ef186b SUCCESS` 2026-04-27 09:42).
- `/health` → `{db:connected, signalwire:true, retell:true, crm:false}`.
- 217/217 backend tests pass; both halves typecheck and build clean.
- The new code path runs end-to-end. Backend log proves it:
  ```
  Browser-originated outbound call placed
    agent="dominic@exec-strategy.com"
    agentSipReference="692a690e-770d-43bb-a151-8ec163141281"
    callId="165c5b18-..."  from="+13467760336"  to="+18327979834"
    providerCallId="d397f146-31ca-479e-a9c0-d3b04a3f07ad"
  ```
- The agent's Fabric subscriber resource exists (id `728fc07d-2205-4e3e-917c-29e0d0b860e3`, reference `692a690e-770d-43bb-a151-8ec163141281`, created 14:58 UTC when the user first logged in after `SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true` went live).

### What's broken
After SignalWire accepts the originate POST and returns a `providerCallId`, **nothing else happens**. No SIP invite reaches the subscriber's browser. No PSTN leg dials. UI hangs on "connecting". No follow-up `call.state` events. SignalWire's LaML `Calls.json` list is empty (suggests the call was never actually placed onto the network) and `/api/calling/calls/<id>` returns 404 (that endpoint isn't a real GET).

### Root cause (this is the important part)
SignalWire's REST `POST /api/calling/calls` with `{command: 'dial', params: {from, to, url, status_url}}` (the legacy LaML-adjacent shape) **doesn't route to Fabric subscribers**. Subscribers aren't SIP endpoints; they're addressable via the Fabric pubsub address book, which is consumed by the browser SDK's `client.dial({to: "/private/<name>"})`. Server-originated calls have no equivalent.

Confirmed by checking SignalWire docs via Context7: every documented "outbound from a Fabric subscriber" example uses the BROWSER SDK to initiate. There is no documented backend pattern that originates a call AND lands the audio leg in a Fabric subscriber's browser. The Phase-1 plan ("Option B" in the previous handoff) assumed this was possible. It isn't.

---

## Two iterations that failed this evening

### Iteration A (Phase-1 as merged, 9511e29)
`useSignalWire.dial(toNumber)` did `client.dial({ to: toNumber, audio: true })`. Fabric's `to` requires a subscriber URN like `/private/jane-doe`; passing a bare E.164 didn't originate PSTN. The SDK still fired some `call.state` events for a phantom call, so the UI showed "connected" while no real call existed. Compounded by `TELEPHONY_PROVIDER=voximplant` forcing the backend to mock telephony.

### Iteration B (this session, b81ae30)
Removed the bad SDK call. Backend now does `POST /api/calling/calls` with `command:dial from=<DID> to=sip:<agent-uuid>@<space>` and a `url=/swml/bridge?to=<PSTN>&from=<DID>` callback. The hook stores a pending-outbound correlator and lets `incomingCallHandlers.all` auto-accept the matching SIP invite. Code is clean and tested. **But SignalWire never delivers the SIP invite to the subscriber.** SIP routing and Fabric routing are disjoint.

---

## Decision: Option 1 — SignalWire Fabric Address / Resource

The SignalWire-native pattern for click-to-dial in a Fabric setup:

1. Create a **Resource** in the SignalWire dashboard whose handler is a SWML script we host at `/swml/outbound-bridge` (or similar).
2. The Resource has a stable Fabric address like `/private/outbound-bridge`.
3. Browser does `client.dial({ to: "/private/outbound-bridge" })` and passes the PSTN destination as a custom field — likely via SWML variables, headers, or a query string the dashboard config supports.
4. Resource SWML reads the destination, runs `connect: { to: <PSTN E.164>, from: <DID> }`. Audio bridges browser ↔ SWML session ↔ PSTN.

This is the *documented* Fabric click-to-call shape and it lines up with SignalWire's intent: subscribers dial named addresses; addresses can be SWML scripts; SWML can bridge to PSTN.

Risks / unknowns to research **before writing code** in the next session:
- Exact mechanism for passing per-call data (PSTN destination, account context) from `client.dial` to the Resource's SWML script. Custom headers? `clientState` field? Resource template variables? Need to confirm in dashboard + docs.
- Whether per-agent caller-ID can be set per-call or has to live in the SWML.
- Whether the Resource needs to be created via dashboard or whether SignalWire Resource API can provision one programmatically — we don't want a dashboard step if we can avoid it.
- Whether SignalWire bills the Resource SWML differently from a normal call (probably no, but check).

---

## What to do first in the next session

1. **Don't write code yet.** Read SignalWire's Fabric Address/Resource docs end-to-end:
   - https://docs.signalwire.com/main/home/platform/call-fabric/ (start here)
   - The "Resources" / "Addresses" pages specifically
   - Use Context7 (`/signalwire/docs`) for code examples — it had useful results this session
2. **Try it manually first.** Create one Resource in the SignalWire dashboard pointing at `/swml/bridge?to=<HARDCODED_TEST_NUMBER>&from=+13467760336`. Have the user (Dominic) `client.dial({to: "/private/<resource-name>"})` from a browser console at the deployed dashboard URL. Confirm Dominic's cell rings. If that fails, we don't have an architecture; if it succeeds, we have a target.
3. **Then design how to pass the destination dynamically.** Likely options:
   - One generic Resource + dynamic SWML query params from `clientState` or custom params on `client.dial`
   - Per-call short-lived Resource creation via API (probably overkill)
   - SWML script that reads from a backend-provided URL we generate per call
4. **Then refactor the code** — both `useSignalWire.ts` and `/api/calls/browser-session`. The backend probably stops originating altogether; it just becomes the compliance gate that returns a signed payload the SDK can use in its `client.dial`.

---

## Things to NOT redo (locked in or already correct)

- **Auth.** Done, working, don't touch.
- **Deploy mechanics.** `railway up <subdir> --path-as-root --service <name> --ci` is the working invocation for this monorepo on this machine. `railway up` without `--path-as-root` uploads from the project root and railpack fails. (The link config has `projectPath` pinned to repo root and there's no per-service link.) Don't waste time re-discovering this.
- **Env vars on Railway backend.** All four are correct now: `DIALER_MODE=live`, `SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true`, `SIGNALWIRE_SOFTPHONE_TRANSPORT=sip-endpoint`, `TELEPHONY_PROVIDER` is *deleted*. The `softphoneTransport=sip-endpoint` value is now slightly inaccurate — Option 1 won't be SIP — but it doesn't matter, it only gates a warning in `/api/system/readiness`. Reset to `fabric-v3` or whatever fits when Option 1 lands.
- **Subscriber provisioning.** The per-agent Fabric subscriber auto-creates correctly on first token request. Reference is `Profile.extension || Profile.id` (the seed admin's extension is null, so it uses the UUID).
- **Backend `originateAgentBrowserCall` in `signalwire.ts`.** Will be unused under Option 1 but the unit tests are fine. **Decision for next session:** delete it as part of the rewrite, or keep it dormant until we're sure Option 1 works. Lean toward delete.
- **`bridgeOutboundSwml` builder.** The Resource SWML in Option 1 will reuse this exact shape (`connect: {to: PSTN, from: DID, answer_on_bridge: true}`). Don't rewrite the builder; just point a new route at it.

---

## Files changed this session (commit b81ae30)

```
backend/src/routes/calls.ts                 +71 -10
backend/src/services/signalwire.ts          +53
backend/src/test/signalwire-service.test.ts +55  (3 new tests, all passing)
frontend/src/hooks/useSignalWire.ts         +85 -23
```

If Option 1 turns out to need a clean slate, `git revert b81ae30` is safe — it touches only the outbound dial path. The env-var changes on Railway are independent and should stay.

---

## Quick orientation

- **Repo:** `C:\Users\Elite Portfolio Mgmt\Downloads\EliteDial2.0\EliteDial` (Windows clone). Branch `main`. Commit `b81ae30`. Working tree clean.
- **Railway services:** `elite-dialer` workspace `domsere-elite's Projects`. Backend at `https://backend-production-e2bf.up.railway.app`, frontend at `https://frontend-production-8067.up.railway.app`.
- **SignalWire space:** `executive-strategy.signalwire.com`. Project ID `fa653ed2-5eed-4403-8c70-74c285bb5ac2`. DID `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`), voice webhook → `/swml/inbound`.
- **Seed admin:** `dominic@exec-strategy.com` / `TempPass2026`. UUID `692a690e-770d-43bb-a151-8ec163141281`. No `extension` set — fallback to UUID throughout. Fabric subscriber `728fc07d-2205-4e3e-917c-29e0d0b860e3`.
- **Inbound** (`+1 346-776-0336` → IVR → press 2 → SWML connect to `sip:<extension>@<space>`): also untested live. Likely has the SAME Fabric routing problem as outbound. Don't be surprised if inbound dies the moment it tries to reach an agent.

---

## Out of scope for next session
- Re-doing auth, deploy, env vars.
- Defending the Phase-1 architecture. It was wrong; pivot.
- Frontend tests. Still zero. Phase 6 in the original roadmap.
- Retell AI mode. Different code path. Works (or works enough) via `/api/ai-agents/:id/launch`.
