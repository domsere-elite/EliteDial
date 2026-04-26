# Functionality Pass — Context Handoff

**Date:** 2026-04-26
**Audience:** Next session, focused on getting actual feature flows working in the browser (not auth).

---

## TL;DR

The Supabase Auth migration shipped today. **Auth works.** Dominic logged in with `dominic@exec-strategy.com`, hit the dashboard, and started exercising features. Two issues surfaced during smoke testing — one cosmetic (Retell agent names wrong), one blocking a call-out test (SignalWire 422). Neither is an auth problem. This doc is the briefing for the next session that fixes them.

---

## Current state (verified working)

- Login form → Supabase `signInWithPassword` → dashboard, no flicker
- `/api/auth/me` returns the seeded admin Profile with `role: 'admin'`
- JWT verification path: ES256 + JWKS via `jose.createRemoteJWKSet` (project uses asymmetric keys; spec D4's HS256 path was abandoned)
- Postgres trigger on `auth.users` INSERT auto-creates `Profile` row
- Backend boots clean, 214/214 backend tests pass
- Rate limiter scoped to `/api/auth/register` only (was previously bombing `/api/auth/me` after each onAuthStateChange)
- Seed admin script: `SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… npm run seed:admin`

**Seed admin user (dev):**
- ID: `692a690e-770d-43bb-a151-8ec163141281`
- Email: `dominic@exec-strategy.com`
- Password: temporarily `TempPass2026` (was `Elite936$` — the `$` may have caused browser autofill issues; we reset to the simple password to unblock smoke testing). **Change after first real login.**
- Name: Dominic Sere (admin)

**Supabase project:** `wqcnumychtjlsstsvnyl` (us-east-2). Memory file `deployment_architecture.md` still references an older project ref `bfgudkpvhcokbbdsroir` — that memory is stale; the live one is what `backend/.env` uses.

---

## Issue 1: SignalWire test call fails with `to_destination_unresolvable` (422)

**User report:** Tried to make a test call from the dashboard; got an error.

**Backend log line (verbatim from `/tmp/elitedial-backend.log`):**

```
[ERROR] SignalWire call initiation failed {
  "status": 422,
  "body": "{\"errors\":[{\"type\":\"validation_error\",\"code\":\"to_destination_unresolvable\",\"message\":\"To does not resolve to a valid destination.\",\"attribute\":\"to\"}]}"
}
```

**What this means:** SignalWire rejected the `to` field in the call-create payload. Possible root causes — list in order of likelihood:

1. **Number not in E.164 format.** SignalWire requires `+1XXXXXXXXXX` for US. If the dial pad submits `(555) 123-4567` or `5551234567`, SignalWire rejects. Check the frontend dial-pad → backend `/api/calls` payload. The normaliser may be missing or stripping the `+`.
2. **Trial-account restriction.** If the SignalWire account is on a trial, only verified numbers can be dialed. Confirm in the SignalWire dashboard whether the test number is verified.
3. **DEFAULT_OUTBOUND_NUMBER misconfigured.** `backend/.env` has `DEFAULT_OUTBOUND_NUMBER=+15551000002` — that's a placeholder/fictional number. If the backend uses this as the *from* number and SignalWire validates it pre-flight, the call may fail before it reaches the *to* check. (The error message blames `to`, but it's worth verifying *both* sides.)

**Where to start:**
- `backend/src/services/providers/signalwire-service.ts` (or wherever the call-origination payload is built — search for `to_destination_unresolvable` to find the call site that bubbled up the error)
- The frontend dial-pad component — confirm it sends digits, not a partially-typed string. Look in `frontend/src/components/` and `frontend/src/app/dashboard/`.

**Don't get distracted by:** anything in `backend/src/middleware/auth.ts`, `backend/src/lib/socket.ts`, `backend/src/lib/supabase-admin.ts`, the trigger SQL, or `frontend/src/lib/supabase.ts`. None of those are involved.

---

## Issue 2: AI Agents page shows wrong / inaccurate Retell agent names

**User report (verbatim):** "ai agents are not accurate retell agent names"

**Translation:** The dashboard's AI Agents section displays names that don't match what's actually in the Retell account. Either:
- Cached/stale data in our DB (we sync once and never refresh)
- The display layer reads a wrong field (e.g. `name` vs `voice_id` vs whatever Retell exposes)
- Fixture/seed data masquerading as live data

**Backend env state:** `RETELL_API_KEY` is set in `backend/.env` (`key_51d5b134aec78bf2aba71a56b235`). Boot log says `Retell configured: false` though — that's because the config getter `isRetellConfigured` requires *both* `apiKey` *and* `defaultAgentId`, and `RETELL_AGENT_ID=` is blank. So the backend may be skipping live Retell calls and falling back to whatever is in the local DB. **This is suspect #1.**

**Where to start:**
- `backend/src/routes/` — find the route serving the AI Agents page (likely `/api/retell/agents` or similar)
- `frontend/src/app/dashboard/ai-agents/` — see what shape it expects and renders
- Decide: should the page hit Retell live every time, or sync periodically? The config gate currently treats Retell as unconfigured without a default agent ID — that gate may be too strict.

---

## Quick orientation

**Repo root:** `/home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial`
**Branch:** `main` (working tree clean, last commit `2b2f0ce`)
**Dev servers (already running, log files in /tmp):**
- Backend: `http://localhost:5000` (`tsx watch src/index.ts` from `backend/`, log at `/tmp/elitedial-backend.log`)
- Frontend: `http://localhost:3000` (Next.js dev, log at `/tmp/elitedial-frontend.log`)

If they've stopped, restart with:
```bash
cd backend && nohup npm run dev > /tmp/elitedial-backend.log 2>&1 & disown
cd frontend && nohup npm run dev > /tmp/elitedial-frontend.log 2>&1 & disown
```

**Telephony provider rule (CLAUDE.md):** SignalWire REST + SWML only. **No LaML / TwiML / `text/xml` responses.** Call flows live in `backend/src/services/swml/builder.ts`. Webhooks live under `/swml/*` and `/signalwire/events/*`.

**Auth contract (post-migration):**
- Frontend: `supabase-js` localStorage, `Authorization: Bearer <jwt>` on every API call via the `lib/api.ts` axios interceptor
- Backend: `middleware/auth.ts` verifies the JWT against the project's JWKS (`https://wqcnumychtjlsstsvnyl.supabase.co/auth/v1/.well-known/jwks.json`) and looks up `Profile` by `claims.sub`
- `req.user = { id, email, role, firstName, lastName, extension }` — same shape as before, just sourced differently
- `requireRole('admin')` etc. unchanged

---

## Out of scope for the next session

- Anything auth-related — it's done. Don't refactor middleware, swap JWKS for HS256, or add new tests for auth.
- Email-change UX, password-reset email flow, MFA — separate sub-projects per the spec.
- Renaming files, "while we're here" cleanups — stay focused on the two issues above.

If a third functionality issue surfaces during testing, file it in this same doc rather than spawning yet another handoff.
