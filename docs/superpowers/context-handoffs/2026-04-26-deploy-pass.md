# Deploy Pass — Context Handoff

**Date:** 2026-04-26 (evening; same day as functionality-pass handoff)
**Audience:** Next session, picking up after the SignalWire/Retell fixes shipped and Railway deploy went live.

---

## TL;DR

Two functionality issues from the morning handoff are fixed and committed. A third surfaced and got fixed too. Both halves of the app are now deployed to Railway and the SignalWire DID points at the deployed backend. Working tree is clean; local is 1 commit ahead of `origin/main` (not pushed).

Smoke testing left to do: log in at the deployed frontend, dial a real number, verify audio bridges through SWML.

---

## What shipped this session

Commit `45b050c`: **fix: outbound calls + Retell agent listing + frontend Docker build**

1. **SignalWire 422 (`to_destination_unresolvable`)** — `/api/calls/initiate` and `/browser-session` now normalize `toNumber`/`fromNumber` to E.164 via the existing `normalizePhone()` helper before handing off to the provider. Also synced the user's real DID `+13467760336` into the `PhoneNumber` table via `didSyncService.syncFromSignalWire()` (the table was empty, so the resolver was falling back to the fictional `+15551000002` placeholder).
2. **Wrong AI agent names on AI Agents page** — `isRetellConfigured` now requires only `apiKey` (was: apiKey **and** defaultAgentId). Added `isRetellOutboundConfigured` for the launch-side gate. The strict gate had been forcing read paths into hardcoded `MOCK_AGENTS` ("Collections Agent - English", etc.). Also fixed two wrong Retell URLs: `listAgents()` and `getAgent()` were hitting `/v2/list-agents` and `/v2/get-agent/{id}` which don't exist; the correct endpoints are unprefixed (`/list-agents`, `/get-agent/{id}`). Only `/v2/create-phone-call` keeps the v2 prefix.
3. **Calls placed but UI showed error** — `signalwireService.initiateOutboundCall` was parsing the response as `{ call_id }` but real SignalWire returns `{ id }`. Result: calls actually went through (Dominic's cell rang) but `providerCallId` came back empty, the route fell into the failure branch, and the UI showed an error. Now parses `data.id || data.call_id`.
4. **Frontend Dockerfile** — declared `ARG`s for `NEXT_PUBLIC_*` vars so Railway's build-time env injection inlines them at `next build`. Without this, Next.js prerender failed with "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set".

214/214 backend tests still pass after all four changes.

---

## Deployment state

**Railway project:** `elite-dialer` (workspace: `domsere-elite's Projects`).

| Service | URL | Status |
|---|---|---|
| backend | https://backend-production-e2bf.up.railway.app | live, `/health` returns `signalwire:true, retell:true, db:connected` |
| frontend | https://frontend-production-8067.up.railway.app | live |
| Postgres | n/a — orphan from a prior attempt, **not used** | running but idle |
| Redis | n/a — orphan from a prior attempt, **not used** | running but idle |

**Database:** Same Supabase project (`wqcnumychtjlsstsvnyl`, us-east-2) for both local dev and Railway prod. So changes to local data (e.g., today's DID sync) are already reflected in production.

**Env vars on Railway:** Pulled from `backend/.env` and `frontend/.env.local`, with these prod-only overrides:
- `BACKEND_PUBLIC_URL=https://backend-production-e2bf.up.railway.app`
- `FRONTEND_URL=https://frontend-production-8067.up.railway.app`
- `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SOCKET_URL` → backend Railway URL
- `NODE_ENV=production`

Empty-valued env vars in `.env` were skipped (Railway CLI rejects empty values): `RETELL_AGENT_ID`, `RETELL_WEBHOOK_SECRET`, `RETELL_DEFAULT_FROM_NUMBER`, `RETELL_FALLBACK_NUMBER`, `CRM_*`, `RECORDING_ARCHIVE_BASE_URL`, `TRANSCRIPT_ARCHIVE_BASE_URL`. Same as local.

**Voximplant cruft:** the Railway services still have `VOXIMPLANT_*` env vars from a much earlier iteration of the app. They're unused (the codebase has zero Voximplant references) but cluttering. Safe to delete; left in place to minimize blast radius during this deploy.

**SignalWire dashboard:** Voice webhook on `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`) was updated via the REST API to `https://backend-production-e2bf.up.railway.app/swml/inbound` (POST). Verified — SignalWire returned 200 with the new value.

---

## Critical context

- **Local is 1 commit ahead of `origin/main`** (`45b050c`). Not pushed. Push when ready.
- **Local dev server may still be running** (`tsx watch src/index.ts`). Not relevant for deployed flow but it's there. Check `ps aux | grep "tsx watch"`.
- **Seed admin password is still `TempPass2026`** (carried over from the morning handoff — that note still applies). Change after first real prod login.
- **Telephony rule unchanged:** SignalWire REST + SWML only. No LaML/TwiML for *call flows*. The LaML *compatibility API* is OK for read/admin operations like inventory listing (`did-sync.ts` uses it) and the IncomingPhoneNumbers webhook-config update I just did. The rule is about not authoring call flows in LaML XML, not about avoiding the entire `/api/laml/` namespace.

---

## Outstanding follow-ups (not done this session)

These were noted but deliberately not tackled:

1. **`/api/ai-agents` is slow.** The route does 3 Prisma queries per agent in parallel even though those queries aren't agent-scoped (same totals every time). At 217 agents that's ~650 redundant DB roundtrips per page load. Pre-existing bug; deferred.
2. **`RETELL_AGENT_ID` still blank.** With the new gate split, this only blocks AI-mode click-to-dial when no explicit `aiAgentId` is in the request body. Pick a default agent_id from the live list and set it in `backend/.env` and on Railway.
3. **Push to `origin/main`** when ready.
4. **Delete orphan Railway Postgres + Redis services** once you've confirmed the new deploy is solid (cost saving). Use the Railway dashboard, not the CLI.
5. **Clean up Voximplant env vars** on Railway services (cosmetic).
6. **End-to-end smoke test** of the deployed app: log in at the frontend URL, dial a real number, verify the call connects with audio. The audio path depends on the SWML doc fetch from the deployed backend, which now resolves correctly to a public URL — but it hasn't been live-tested.
7. **Inbound calls to `+13467760336`.** Now that the webhook URL is set, calling that number should hit `/swml/inbound`. Untested.

---

## Quick orientation

**Repo root:** `/home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial`
**Branch:** `main` (clean, last commit `45b050c`)

**Useful commands:**
```bash
# Inspect deploy status
railway deployment list --service backend
railway logs --service backend
railway variables --service backend --kv

# Redeploy after code changes
cd backend && railway up --service backend --ci      # Backend only
cd frontend && railway up --service frontend --ci    # Frontend only

# Health check
curl -s https://backend-production-e2bf.up.railway.app/health

# Local dev (still works; both halves point at same Supabase)
cd backend && nohup npm run dev > /tmp/elitedial-backend.log 2>&1 & disown
cd frontend && nohup npm run dev > /tmp/elitedial-frontend.log 2>&1 & disown
```

**Auth contract (unchanged from morning handoff):**
- Frontend: supabase-js localStorage, `Authorization: Bearer <jwt>` via `lib/api.ts` axios interceptor
- Backend: `middleware/auth.ts` verifies via JWKS at `https://wqcnumychtjlsstsvnyl.supabase.co/auth/v1/.well-known/jwks.json`, looks up `Profile` by `claims.sub`
- `req.user = { id, email, role, firstName, lastName, extension }`

---

## Out of scope for the next session

- Re-doing the deploy or moving providers — it's done.
- Refactoring the slow `/api/ai-agents` route unless it's actively blocking smoke testing.
- Anything auth-related (still done, still working).

If a new functionality issue surfaces during smoke testing, file it in this doc rather than spawning a third handoff.

---

## Phase 0 progress (2026-04-26 evening, continued)

### Done
- **Pushed `45b050c` to `origin/main`.** Repo and prod deploy now agree.
- **Automated checks against deployed backend:**
  - `/health` → `{db:connected, signalwire:true, retell:true, crm:false}` ✅
  - Frontend root → HTTP 200 ✅
  - `POST /swml/inbound` → returns valid SWML with IVR menu (Press 1/2/3) ✅
  - `GET /api/calls` (no auth) → HTTP 401 ✅ (auth middleware live)
- **Retell agents available on the account: 217 entries, 5 unique IDs.** Candidates for default `RETELL_AGENT_ID`:
  - `agent_bc1ee178c86a69e04484e699f7` — EPM Outbound - Marcus *(natural outbound default)*
  - `agent_fe35cc4e06f39d46349a4b9e36` — EPM Decline Recovery
  - `agent_6047ab5d83632947db0198bead` — EPM Decline Recovery - Andrea (Español)
  - `agent_74b8671dde61f011594e5bb631` — EPM Inbound - Carlos
  - `agent_cf676ce4e6044c864f4ecd7e4b` — EPM Inbound - Erik

### Manual smoke test checklist (requires the user)

These need a real browser session, real audio devices, and a real phone — I can't run them.

**Frontend login**
1. Open https://frontend-production-8067.up.railway.app/
2. Log in as `dominic@exec-strategy.com` / `TempPass2026` (seed admin password)
3. Confirm redirect to `/dashboard` and that the user shows in the top-right.
4. **Change the password immediately** after first login.

**Outbound — agent mode (SignalWire WebRTC)**
1. From the dashboard, type a target number into the dialer (your own cell is fine).
2. Click dial. Phone should ring within ~3s.
3. Answer on the cell. Audio should bridge both ways.
4. Hang up. Disposition modal should appear; pick a code; submit.
5. Verify the call shows in "Recent calls" with the correct disposition.

**Outbound — AI mode (Retell)**
1. Go to `/dashboard/ai-agents`. Confirm the list now shows real names ("EPM Outbound - Marcus" etc.) — not "Collections Agent - English" mock names. *(This is the regression that 45b050c fixed.)*
2. Click any agent → "Launch" modal → enter target number → submit.
3. Phone rings, AI agent talks. Hang up.
4. Verify the call appears in history with `mode=ai` and a transcript link (if Retell webhooks are wired — see follow-up #5 below).

**Inbound (untested since deploy)**
1. From any phone, dial **+1 (346) 776-0336**.
2. You should hear: "Thank you for calling Elite Portfolio Management. Press 1 to make a payment. Press 2 to speak with an agent. Press 3 to leave a voicemail."
3. Press `2`. Verify the call rings into the dashboard for whoever is logged in.
4. Press `3`. Verify a voicemail entry shows up in `/dashboard/voicemail`.

**If any step fails:** add a numbered entry under "New issues found during smoke test" below.

### New issues found during smoke test
*(empty — to be filled by the user as they go)*

### Pending user actions (Phase 0 closeout)

These need a human decision or are remote/destructive:

1. **Pick a default `RETELL_AGENT_ID`** from the candidate list above. Recommend `agent_bc1ee178c86a69e04484e699f7` (EPM Outbound - Marcus). Once chosen, set in `backend/.env` and on Railway:
   ```bash
   railway variables --service backend --set RETELL_AGENT_ID=agent_bc1ee178c86a69e04484e699f7
   ```
2. **Delete orphan Railway services** (Postgres + Redis) — Railway dashboard, not CLI.
3. **Run the manual smoke test checklist above** and report results.

---

## Phase 1 plan — real WebRTC softphone (drafted, awaiting sign-off)

### Current state (the brutal truth)

The frontend has **three competing softphone hooks**, none of which are wired into the dashboard:

| File | LOC | SDK | Status |
|---|---|---|---|
| `frontend/src/hooks/useSignalWire.ts` | 214 | `@signalwire/js@3.29.2` (modern Fabric/Call SDK) | ✅ inbound works (`incomingCallHandlers`), `dial()` is a no-op stub |
| `frontend/src/hooks/useSignalWireRelay.ts` | 416 | Relay v1 from `cdn.signalwire.com/@signalwire/js@1` | ⚠️ mismatched — consumes Relay v2 token but loads v1 CDN. Has full outbound `client.newCall()` plumbing |
| `frontend/src/hooks/useCallState.ts` | 137 | none — pure reducer | clean state machine, idle → ringing → connected → wrap-up |

Verified: **zero components in `frontend/src` import any of these three hooks.** They are dead code.

The actual dashboard at `frontend/src/app/dashboard/page.tsx`:
- Has its own local `useState<CallState>`
- POSTs to `/api/calls/initiate` for outbound
- Calls `setTimeout(() => setCallState('connected'), 2000)` (line 167–169) to fake the connect transition
- Polls `/api/calls` every 15s for inbound updates (no Socket.IO subscription)
- No browser audio is ever opened — calls happen entirely server-side via SWML; the agent isn't actually on the call audio path

Backend has both token endpoints already:
- `GET /api/agents/token/signalwire` → Fabric/subscriber JWT (for `@signalwire/js@3`)
- `GET /api/agents/token/signalwire-relay` → Relay v2 JWT
- Backend `signalwireService.initiateOutboundCall` originates a call FROM a DID (e.g., `+13467760336`) TO destination, with `url=/swml/bridge?to=...&from=...` for call-flow control.

### Architecture decision needed (user input)

Three valid patterns for browser-based agents on SignalWire. Pick one before I cut code.

**Option A — Browser-originated dial (true click-to-dial)**
- Agent's browser uses `@signalwire/js@3` to dial directly: `client.dial({ to: destination })`.
- Backend's only role is to issue a token + log the call.
- **Pros:** simplest mental model, lowest latency, browser is the origin.
- **Cons:** fewer server-side hooks for compliance (DNC/TCPA enforcement happens in the browser API call, not at the call-origination step); harder to swap providers since the frontend talks to SignalWire directly.

**Option B — Backend-originated, browser is "subscriber" endpoint (Fabric-native)**
- Backend POSTs `/api/calling/calls` with `from=fabric:subscriber/<agent-extension>` and `to=<destination>`.
- SignalWire rings the subscribed browser first (via Fabric); SDK fires `incomingCallHandlers.all`; agent answers; then SignalWire dials the destination and bridges.
- **Pros:** server-side compliance gating stays in `/api/calls/initiate` (already there); single auth path; agent endpoint is a first-class SignalWire resource.
- **Cons:** requires every agent to have a Fabric subscriber resource provisioned (extension → subscriber address mapping); slightly counterintuitive ("dialing out feels like an inbound call to me").

**Option C — Backend-originated from DID, SWML bridges to agent (current path, fix the bridge)**
- Backend originates from a DID (today's behavior), SWML `/swml/bridge` does a `connect: fabric:subscriber/<agent>` to ring the agent's browser. The destination and the agent's SDK both connect via the SWML script.
- **Pros:** fewest changes — backend already does this; just need SWML to actually have the subscriber connect step and the agent's browser to be a subscriber.
- **Cons:** two-leg bridging means more state to track (which leg ended); cost is slightly higher (two PSTN+subscriber legs vs one).

**My recommendation: Option B.** Closest to SignalWire's recommended Fabric pattern, keeps server-side compliance gates intact, and the hook code in `useSignalWire.ts` is already 70% wired for it (just needs `dial()` to call the backend instead of being a no-op, then rely on `incomingCallHandlers` to surface the SDK call).

### Plan (assuming Option B)

#### Step 1 — Confirm subscriber provisioning works
Verify that `signalwireService.generateBrowserToken(...)` creates/uses a subscriber resource per agent extension. Read [signalwire.ts:118-160](backend/src/services/signalwire.ts#L118-L160). If subscribers aren't auto-provisioned, we need a one-time provisioning flow (manual via dashboard or REST). Pre-flight check; doesn't block plan.

#### Step 2 — Delete dead/legacy code
- Delete `frontend/src/hooks/useSignalWireRelay.ts` (Relay v1, mismatched). Delete the backend endpoint `GET /api/agents/token/signalwire-relay` ([routes/agents.ts:100-125](backend/src/routes/agents.ts#L100-L125)).
- Keep `useCallState.ts` and `useSignalWire.ts`.

#### Step 3 — Make `useSignalWire.ts` outbound-capable
Replace the no-op `dial()`:
```ts
const dial = async (toNumber: string, mode: 'agent' | 'ai' = 'agent') => {
  const { data } = await api.post('/calls/initiate', { toNumber, mode });
  // backend originates from=fabric:subscriber/<me>; SDK will fire incomingCallHandlers
  return { callId: data.callId };
};
```
Backend `signalwireService.initiateOutboundCall` needs a code path that builds `from=fabric:subscriber/<extension>` instead of `from=<DID>` when the call is for an agent (today it always uses a DID). Add a `subscriberAddress` field on `OutboundCallRequest`; resolve it in the calls route from `req.user.extension`.

#### Step 4 — Wire the hook into the dashboard
Replace dashboard's local `useState<CallState>` with:
```ts
const sw = useSignalWire();         // browser audio
const call = useCallState();        // phase machine
useEffect(() => { sw.connect(); }, []);
```
Map SDK events → reducer dispatches:
- `sw.incomingCall` arrives → `call.incomingCall(...)`
- agent clicks accept → `sw.acceptIncoming()` + `call.answerCall()`
- agent clicks hang up → `sw.hangup()` + `call.endCall()`
- disposition submitted → `call.submitDisposition()`

Delete the `setTimeout(2000)` mock entirely.

#### Step 5 — Replace polling with Socket.IO
Backend already emits `call.status.updated` events from the SignalWire webhook handler ([signalwire-events route](backend/src/routes/signalwire-events.ts)). Frontend just needs to subscribe via the existing `useSocket()` hook. Drop the 15s `setInterval` in [dashboard/page.tsx:113-116](frontend/src/app/dashboard/page.tsx#L113-L116).

#### Step 6 — Audio controls + DTMF + transfer
- Mute/Hold buttons → `sw.toggleMute()` / `sw.toggleHold()` (already in hook)
- DTMF: add `sw.sendDigits(digits)` → `activeCall.sendDigits()` (Fabric SDK supports this)
- Cold transfer: existing backend endpoint `POST /api/calls/:id/transfer`, just wire the button
- Warm transfer: same endpoint with `mode: 'warm'`

#### Step 7 — Wrap-up gating
In `useCallState`, the reducer already prevents `CALL_INCOMING` while `phase !== 'idle'`. Surface this in the UI — disable dial button during `wrap-up`, show a "submit disposition to take next call" hint.

#### Step 8 — Tests
- Add Vitest + React Testing Library to frontend (currently zero tests)
- Test `useCallState` reducer (pure function — easy wins)
- Test `useSignalWire` with mocked `@signalwire/js` (mock `SignalWire()` factory, assert handlers wire up)
- One Playwright e2e against the deployed env: log in → click dial → mocked SignalWire confirms call placed → assert UI transitions

### Acceptance criteria

A real agent can:
1. Log in, see "Connected" status (SDK online).
2. Type a number, click dial. Phone rings within 3s. Audio bridges both ways.
3. Hear ringback in browser.
4. Click hang up. Disposition modal appears. Cannot dial again until submitted.
5. Receive an inbound call (someone dials `+13467760336`, picks "speak to agent" → SDK fires incoming-call handler in agent's browser). Accept. Audio bridges. Hang up. Disposition.
6. All call status changes are event-driven (Socket.IO), not polling.
7. No `setTimeout` mocks anywhere in the call path.

### Estimate

Senior engineer focused: **5–8 working days.** Bulk of risk in Step 3 (subscriber provisioning + `from=fabric:subscriber/...` may need iteration with SignalWire's actual API behavior), and Step 8 (first-time test infra setup).

### Out of scope for Phase 1
- AI-mode click-to-dial (Retell) — different code path, doesn't touch browser audio
- Predictive/power dialing — Phase 5+
- Call recording UI — separate
- Whisper/coach — Phase 5+

### Open questions for the user
1. **Pick A, B, or C** above. Default: B.
2. **Each agent needs a SignalWire Fabric subscriber resource.** Is one already provisioned for `dominic@exec-strategy.com` (extension `?`), or do we need to create as part of step 1? (Backend code suggests auto-provisioning was attempted at some point — see the `subscriber_provisioning_disabled` error branch in [routes/agents.ts:86-89](backend/src/routes/agents.ts#L86-L89).)
3. **Phase 1 acceptance** — is "outbound + inbound, agent mode only, real audio, no polling" the right bar, or do you want AI-mode click-to-dial integrated in the same pass?

---

## Phase 1 — implemented (2026-04-26 evening, continued)

User chose **Option B**, agent-mode only, Retell click-to-dial out of scope. Resolved into a slightly cleaner variant: **the existing `/api/calls/browser-session` endpoint already does server-side compliance gating + DB record creation, leaving the actual SignalWire SDK dial to the browser.** That collapsed Step 3 backend work to zero and let the implementation land in one pass.

### Architecture as built

Outbound:
1. Dashboard calls `useSignalWire.dial(toNumber)`.
2. Hook POSTs `/api/calls/browser-session` → backend runs DNC, TCPA, reservation checks; resolves outbound DID; creates `Call` + `CallSession` rows; returns `{ callId, fromNumber }`.
3. Hook calls `client.dial({ to: toNumber, audio: true, video: false })` on the SignalWire `@signalwire/js@3` Fabric/Call SDK. The agent's browser becomes the audio leg.
4. SDK fires `call.state` events on the `FabricRoomSession`. Hook posts each to `/api/calls/:id/browser-status` → backend persists and now broadcasts `call:status` over Socket.IO.

Inbound:
1. Caller dials `+13467760336` → `/swml/inbound` → IVR → `connect-agent` SWML does `connect: sip:<extension>@<space>.signalwire.com`.
2. Agent's browser (subscriber) receives the invite; SDK fires `incomingCallHandlers.all`.
3. Hook captures the invite. Dashboard renders Accept/Reject.
4. On Accept: hook calls `invite.invite.accept(...)` for audio, then POSTs `/api/calls/inbound/attach` to correlate the SDK's call_sid with the backend `Call` record.
5. Wired room events behave the same as outbound.

Real-time:
- New: backend now calls `broadcastCallStatus(...)` from both `/signalwire/events/call-status` and `/api/calls/:id/browser-status`. (`broadcastCallStatus` was already defined in [lib/realtime.ts](backend/src/lib/realtime.ts) but was never invoked.)
- Dashboard wraps in `<RealtimeProvider>` and subscribes to `call:status` to refresh recent-calls. The 15-second `setInterval` polling is gone.

### Files changed

**Deleted:**
- `frontend/src/hooks/useSignalWireRelay.ts` (Relay v1 dead code)
- The `GET /api/agents/token/signalwire-relay` route handler in `backend/src/routes/agents.ts`

**Rewritten:**
- `frontend/src/hooks/useSignalWire.ts` — `dial()` is no longer a no-op. Wires backend compliance gate → SDK dial → event-driven status sync. Adds `callId`, `providerCallId`, `ringing` to public state.
- `frontend/src/app/dashboard/page.tsx` — full rewrite. Replaces local `useState<CallState>` + `setTimeout(2000)` mock with `useSignalWire()` + `useRealtime()`. Adds incoming-call accept/reject UI, mute/hold/cold-transfer controls, wrap-up gating that blocks the next dial until disposition is submitted.

**Modified:**
- `frontend/src/app/dashboard/layout.tsx` — wraps children in `<RealtimeProvider>`.
- `backend/src/routes/signalwire-events.ts` — calls `broadcastCallStatus` after persisting call state.
- `backend/src/routes/calls.ts` — same in `/:id/browser-status` route.

**Untouched but worth noting:**
- `frontend/src/hooks/useCallState.ts` (137 LOC) and `components/{call,account,workspace}/*.tsx` are still dead code but referenced by each other for type imports. Left in place — deletion is a pre-existing cleanup, not Phase 1 scope.

### Verification

- `tsc --noEmit` clean on both halves.
- `npm test` in backend: **214/214 pass.**
- `npm run build` in frontend: clean Next build, dashboard at 85.6 kB First Load JS.

### Pre-flight — must do before live testing

These are the live-only concerns that can't be unit-tested. None of them is broken; they need configuration on the SignalWire side.

1. **Subscriber must exist for the logged-in user.** The token endpoint `GET /api/agents/token/signalwire` calls `signalwireService.generateBrowserToken(userId, ..., extension)`. If no Fabric subscriber matches the agent's `extension` (or email), the token call returns `subscriber_provisioning_disabled` (HTTP 403) unless `SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true` is set. Two options:
   - Set `SIGNALWIRE_ALLOW_SUBSCRIBER_PROVISIONING=true` on Railway. Backend will auto-create a subscriber on first token request. Safe for dev/staging.
   - Or pre-provision the subscriber in the SignalWire dashboard with reference matching the agent's extension/email.
2. **Subscriber needs outbound permission + caller ID.** SignalWire Fabric subscribers don't dial PSTN unless explicitly allowed and the caller-id is configured on the subscriber's address. If `client.dial(...)` rejects with a permission error, fix at the subscriber resource in the SignalWire dashboard.
3. **Inbound IVR routes to `sip:<extension>@<space>.signalwire.com`** ([builder.ts:137](backend/src/services/swml/builder.ts#L137)). The agent's `Profile.extension` must match a subscriber address that the browser SDK is online for. Confirm the seeded admin's extension exists as a subscriber.

### Known gaps / followups

| Gap | Impact | Fix |
|---|---|---|
| **DTMF in-call** | Agent can't punch digits to a phone tree mid-call | `@signalwire/js@3` types don't expose `sendDigits` on `FabricRoomSession`. Defer until SDK adds it (or use an out-of-band SignalWire REST `command:send_digits` call from backend). |
| **Warm transfer UI** | Backend supports it (`type: 'warm'`), UI only does cold transfer today | Add a toggle in the in-call panel and a callback flow. |
| **Caller-ID display** | Agent's outbound calls show whatever the subscriber default is, not the resolved DID from `/browser-session.fromNumber` | Fabric subscriber model: caller ID is per-address, not per-call. Either align subscriber's caller-id-config with our DID rotation, or push the SDK to support a `from` param. |
| **`useCallState.ts` + `components/{call,account,workspace}/*.tsx`** | Dead code; ~137+ LOC of unused reducer + view components | Delete in a Phase 2 cleanup pass. |
| **No frontend tests** | Phase 1 still has zero frontend test coverage | Phase 6 in the master roadmap. |
| **`/api/calls/initiate` agent-mode guard** | Returns 409 if anyone POSTs human-mode there ([calls.ts:128-139](backend/src/routes/calls.ts#L128-L139)) | Defense-in-depth — keep it. The dashboard now uses `/browser-session` so the guard never fires in normal flow. |

### Acceptance check (do after pre-flight items)

Smoke-test path that proves Phase 1 works:
1. Log in. Top of the dashboard shows "Softphone connected. Real-time live."
2. Open dial pad, type `+1<your cell>`, click Call.
3. Cell rings. Browser shows "ringing" → "connected" without a 2-second pause.
4. Talk both ways. Click Hold → audio mutes both ways. Click Resume.
5. Click Hang Up. Wrap-up screen shows duration. Dial button disabled.
6. Pick disposition + notes → Submit. Dial button re-enabled.
7. From another phone, dial `+13467760336`. Press 2 to reach an agent.
8. Browser shows "Incoming: <number>". Click Accept. Audio bridges. Hang up. Wrap-up + disposition.
9. Open a second browser tab, watch recent-calls update **without polling** (Socket.IO `call:status` events).
