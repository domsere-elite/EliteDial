# Supabase Auth Migration — Design Spec

**Date:** 2026-04-26
**Sub-project:** Replace EliteDial's custom JWT auth with Supabase Auth.
**Status:** Approved by stakeholder; ready for implementation plan.

## Goal

Replace the home-grown auth stack (`bcryptjs` + `jsonwebtoken` + custom `User`/`tokenBlacklist` tables + custom `/login`/`/refresh`/`/logout` routes) with **Supabase Auth**. The Postgres database is already on Supabase; this sub-project lights up the auth layer that ships alongside it. Eliminates ~250 lines of auth surface area and unblocks email verification, password reset, and MFA without further auth-stack work.

## Constraints

- **No real production users exist.** Migration is destructive; no data migration logic needed.
- **Postgres is already Supabase-hosted.** No DB infra change.
- **Brand-controlled login UX must be preserved.** No hosted Supabase Auth UI; we keep our existing form and call `supabase-js` from it.
- **`role`-gated authorization stays exactly as-is at the call site.** `requireRole('admin')` etc. read `req.user.role` — that doesn't change. Only the source of `req.user` changes.

## Decisions (all locked during brainstorm)

| # | Decision |
|---|---|
| D1 | Rename `User` → `Profile`. PK is `Profile.id` = `auth.users.id` (Supabase pattern B). |
| D2 | Frontend keeps custom login form, calls `supabase.auth.signInWithPassword` directly. |
| D3 | `role` lives on `Profile.role` (Prisma-managed), not in `auth.users.app_metadata`. |
| D4 | Backend verifies Supabase JWT via shared HS256 secret (`SUPABASE_JWT_SECRET`) — stateless, no JWKS round-trip, no Supabase API call per request. |
| D5 | Login is **email-only**. `username` column dropped from Profile. |
| D6 | Profile is auto-created from `auth.users` via a Postgres trigger (`on_auth_user_created`). |
| D7 | `Profile.id` has FK to `auth.users(id) ON DELETE CASCADE`. Deleting from Supabase admin SDK cascades to Profile. |
| D8 | `change-password` is frontend-only (`supabase.auth.updateUser`). Backend `change-password` route deleted. |
| D9 | `reset-password` (admin-initiated) keeps its backend route; uses `supabase.auth.admin.updateUserById`. |

## Architecture

### Auth flow (login)

1. User submits email + password in custom login form.
2. Frontend: `supabase.auth.signInWithPassword({ email, password })`.
3. `supabase-js` stores access + refresh token in localStorage; handles silent refresh.
4. Frontend: `router.push('/dashboard')`.

### Auth flow (authenticated request)

1. Axios request interceptor reads `supabase.auth.getSession()`, sets `Authorization: Bearer <jwt>`.
2. Backend `authenticate` middleware verifies JWT signature with `SUPABASE_JWT_SECRET` (HS256) and `audience: 'authenticated'`.
3. Middleware extracts `sub` (Supabase user ID), looks up `Profile` by that ID, attaches `{ id, email, role, firstName, lastName, extension }` to `req.user`.
4. `requireRole` / `requireMinRole` middleware unchanged — read `req.user.role`.

### Auth flow (logout)

Frontend calls `supabase.auth.signOut()`. No backend hop. No token blacklist.

### Socket.IO

Token from handshake auth header → same `jwt.verify` + Profile lookup as the HTTP middleware. On the client, `supabase.auth.onAuthStateChange('TOKEN_REFRESHED')` triggers a Socket.IO reconnect with the new token.

## Components

### Backend

**New:**
- `backend/src/lib/supabase-admin.ts` — singleton Supabase client constructed with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Used by admin routes only. **Never** exposed to frontend.

**Rewritten:**
- `backend/src/middleware/auth.ts` — `authenticate` verifies Supabase JWT (HS256), looks up Profile, attaches `req.user`. Drops password/JWT-mint logic.
- `backend/src/routes/auth.ts` — slimmed from 178 lines to ~50. Keeps only:
  - `POST /register` (admin-only; uses `supabase.auth.admin.createUser`; trigger creates Profile)
  - `GET /me` (returns `req.user`)
- `backend/src/routes/admin.ts` — `/agents` sub-resource:
  - `POST /agents/:id/reset-password` → `supabase.auth.admin.updateUserById(id, { password })`
  - `DELETE /agents/:id` → `supabase.auth.admin.deleteUser(id)` (Profile cascades)
  - `PUT /agents/:id` → Prisma update on Profile; if email changes, also `supabase.auth.admin.updateUserById(id, { email })`
- `backend/src/index.ts` — Socket.IO middleware updated to use new `authenticate`-equivalent JWT verify + Profile lookup.
- `backend/src/lib/env-validation.ts` — fail-fast check that `SUPABASE_JWT_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are set.
- `backend/src/config.ts` — adds `supabase: { url, serviceRoleKey, jwtSecret, anonKey }`.

**Deleted:**
- `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `POST /api/auth/change-password` (route handlers)
- `lib/tokenBlacklist.ts` (and any blacklist DB table if one exists)
- `bcryptjs`, `@types/bcryptjs` deps
- `jwt.test.ts` (covers our own JWT minting which is gone)

**Kept:**
- `jsonwebtoken` (still used for `jwt.verify` in middleware)
- `middleware/roles.ts` — unchanged

**Added deps:**
- `@supabase/supabase-js`

### Frontend

**New:**
- `frontend/src/lib/supabase.ts` — browser Supabase client (`createClient` with `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

**Rewritten:**
- `frontend/src/lib/api.ts` — request interceptor reads token from `supabase.auth.getSession()`; 401 response handler calls `supabase.auth.signOut()` and redirects. Manual refresh queue + `failedQueue` deleted.
- Login page (form posts to `supabase.auth.signInWithPassword` instead of `POST /api/auth/login`). Form changes username field → email field.
- `frontend/src/app/dashboard/layout.tsx` — replaces token-presence check with `supabase.auth.onAuthStateChange` subscription.
- `frontend/src/hooks/useSocket.ts` — gets token from `supabase.auth.getSession()`.

**Deleted (logic, not files):**
- All references to `elitedial_token`, `elitedial_refresh_token`, `elitedial_user` localStorage keys.
- Manual refresh-token flow in `api.ts`.

**Added deps:**
- `@supabase/supabase-js`

### Database

**Migration 1 (Prisma):** rename `User` → `Profile`, drop `username` + `passwordHash`, change `id` to `String @id @db.Uuid` (no `@default(uuid())` — Supabase generates it). Add FK to `auth.users(id) ON DELETE CASCADE`. Update relation references in dependent models (`Call.assignedAgent`, `CallSession.user`, `Voicemail.user`, `Campaign.createdBy`, etc.).

**Migration 2 (raw SQL):** create the `on_auth_user_created` trigger:

```sql
CREATE OR REPLACE FUNCTION public.handle_new_supabase_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public."Profile" (id, email, "firstName", "lastName", role, status, "createdAt", "updatedAt")
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'firstName', ''),
        COALESCE(NEW.raw_user_meta_data->>'lastName', ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'agent'),
        'offline',
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_supabase_user();
```

**Optional Migration 3:** `AFTER UPDATE OF email ON auth.users` trigger mirroring email to Profile. Out of scope unless email-change UX is exercised.

**Existing data:** drop `User` rows before migration (none in production).

## Data Flow

### Register a new agent (admin)

1. Frontend admin UI → `POST /api/auth/register` with `{ email, password, firstName, lastName, role }`.
2. Backend route → `requireRole('admin')` passes.
3. Backend → `supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { firstName, lastName, role } })`.
4. Postgres trigger fires, creates `Profile` row keyed by `auth.users.id`.
5. Backend reads back the Profile, returns `{ id, email, firstName, lastName, role, ... }` to caller.
6. Admin UI shows the new agent in the list.

### Log in

1. Login form → `supabase.auth.signInWithPassword({ email, password })`.
2. `supabase-js` stores session in localStorage.
3. Frontend redirects to `/dashboard`.
4. Dashboard layout's `onAuthStateChange` confirms session, mounts the dashboard.
5. First `/api/auth/me` call sets in-memory user state.

### Authenticated API call

1. Axios interceptor → `supabase.auth.getSession()` → `Authorization: Bearer <jwt>`.
2. Backend middleware → `jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'], audience: 'authenticated' })`.
3. Middleware → `prisma.profile.findUnique({ where: { id: claims.sub } })`.
4. `req.user` set; route runs.

### Reset password (admin-initiated)

1. Admin UI → `POST /api/admin/agents/:id/reset-password` with new password.
2. Backend → `supabase.auth.admin.updateUserById(id, { password })`.
3. User's existing sessions remain valid until refresh; new logins use new password.

### Delete agent

1. Admin UI → `DELETE /api/admin/agents/:id`.
2. Backend → `supabase.auth.admin.deleteUser(id)`.
3. `auth.users` row deleted; FK cascade deletes Profile row.
4. Cascading deletes on dependent tables (`Call.assignedAgentId` etc.) handled by their own `onDelete` rules — verify those during impl.

## Error Handling

| Failure mode | Response |
|---|---|
| Missing `Authorization` header | 401 `{ error: 'Missing or malformed Authorization header' }` |
| Malformed Bearer prefix | 401 same as above |
| JWT signature invalid / wrong secret | 401 `{ error: 'Invalid or expired token' }` |
| JWT expired | 401 same as above |
| JWT valid but `sub` not in Profile (trigger failed; Supabase user has no Profile) | 401 `{ error: 'Profile not found for authenticated user' }` |
| Boot without `SUPABASE_JWT_SECRET` set | Process exits with clear error from `env-validation.ts` |
| `supabase.auth.admin.createUser` rejects (e.g. duplicate email) | 400 with the Supabase error message bubbled up |
| Trigger silently fails to insert Profile | Logged to `profile_sync_errors` table (from `ON CONFLICT`); login subsequently 401s with the "Profile not found" message; smoke test catches this |

## Testing

### Tests deleted
- `backend/src/test/jwt.test.ts` — covered our custom JWT minting; obsolete.
- Any test fixture that includes `passwordHash` / `username` on a `User` shape.
- Token-blacklist tests (if any).

### Tests added
- `backend/src/test/auth-middleware.test.ts` (~6 tests):
  - Valid token → `req.user` populated correctly
  - Missing Authorization header → 401
  - Malformed Bearer prefix → 401
  - Invalid signature → 401
  - Expired exp → 401
  - Valid token but unknown `sub` (no Profile) → 401
  - Tokens minted in-test by `jwt.sign(claims, SUPABASE_JWT_SECRET, { algorithm: 'HS256' })` — no Supabase round-trip.
- `backend/src/test/auth-route.test.ts` (~4 tests):
  - `POST /register` admin-only (non-admin → 403)
  - `POST /register` validates body via Zod (missing email → 400)
  - `POST /register` calls `supabase.auth.admin.createUser` with the right args (DI-stubbed admin SDK)
  - `GET /me` returns `req.user` shape

### Tests not added (out of scope)
- Frontend login flow — no frontend test harness exists; deferred to its own sub-project.
- Supabase Auth itself — Supabase's responsibility.
- Admin user CRUD HTTP-level tests — captured by the route-tests sub-project we shelved.
- Trigger tests — validated by smoke test in step 6 of migration; pg-tap not introduced for one trigger.

### Test count delta
Baseline: 212. Removed: ~12 (jwt.test.ts). Added: ~10 (middleware + route). Net: ~210.

### Verification checklist (post-implementation)
1. `npm run build` (backend) — passes.
2. `npm test` (backend) — ~210 pass / 0 fail.
3. Backend boots without `SUPABASE_JWT_SECRET` → fails fast.
4. Backend boots with all Supabase env → succeeds.
5. Manual smoke:
   - Run `seed-admin.ts` script → admin user created in Supabase + Profile.
   - Log in via UI → redirected to dashboard.
   - `/api/auth/me` returns admin role.
   - Hit an admin-only route (e.g. `GET /api/admin/agents`) → 200.
   - Hit a supervisor-or-above route as agent → 403.
   - Logout button → redirected to login; subsequent API call → 401.
   - Reload page after login → still authenticated (session persisted).

## Migration Plan

Each numbered step is a logical commit unless noted. Steps 2-4 are **one commit** because the system is unbootable between them.

1. **Provision Supabase Auth.** Enable email/password in Supabase dashboard. Add `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` to backend `.env`. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` to frontend `.env.local`. Update `.env.example` files. *(Manual + small commit for `.env.example`.)*
2. **DB migration:** rename User → Profile, drop password/username, FK to auth.users, raw-SQL trigger.
3. **Backend swap:** new middleware, slim auth router, supabase-admin singleton, env validation, package.json deps. Drop bcryptjs + tokenBlacklist + jwt.test.ts.
4. **Frontend swap:** lib/supabase.ts, rewire api.ts interceptors, login form to signInWithPassword, dashboard layout to onAuthStateChange, useSocket.ts, package.json dep.
5. **Seed initial admin script.** `backend/scripts/seed-admin.ts` calls `supabase.auth.admin.createUser`. README mentions running it once after migration.
6. **Manual smoke test** per the verification checklist.

## Risks

| Risk | Mitigation |
|---|---|
| Trigger silently fails on insert (e.g. email collision) → Supabase user exists without Profile, login 401s | Trigger uses `ON CONFLICT (id) DO NOTHING`; smoke test asserts Profile exists after register; log Profile-missing 401s with `claims.sub` so we can detect drift. |
| Future Supabase upgrade changes `auth.users` schema and breaks trigger | Trigger reads only `id`, `email`, `raw_user_meta_data` (Supabase commits to these). Pin Supabase version in dashboard. |
| `SUPABASE_SERVICE_ROLE_KEY` leak | Backend-only env var, never exposed to frontend, never logged. Add to logger redaction list. Document in `.env.example` with a clear "DO NOT commit / DO NOT expose to client" warning. |
| JWT secret rotation invalidates all sessions | Documented as expected — rotation forces re-auth. Acceptable for this app's UX. |
| Socket.IO connections hold expired JWTs after refresh | Client reconnects on `TOKEN_REFRESHED`; server re-verifies token on each meaningful event. |
| Profile and `auth.users` email drift after change | Add `AFTER UPDATE` trigger (Migration 3) OR document that email changes are admin-only and the admin route updates both sides. Pick one during impl. |
| Admin SDK rate limits during seed / bulk register | Out of scope — single-user seed is fine. Bulk import would need its own sub-project. |
| Backend tests that assumed our own JWT contract break | Replace `jwt.test.ts` with `auth-middleware.test.ts`; audit other tests for `User` fixtures and `passwordHash` references. |

## Out of Scope

- Email verification flow (Supabase supports; needs UI work — own sub-project).
- User-initiated password reset (`resetPasswordForEmail` flow + `/reset-password` page — own sub-project).
- MFA.
- OAuth providers (Google, etc.).
- Migrating any production users (none exist).
- Supabase Row-Level Security policies (Prisma bypasses RLS via service-role connection — keep that pattern).
- Frontend test harness (own sub-project).
- HTTP-level tests for admin user CRUD routes (own sub-project — the one we shelved at the top of this brainstorm).

## Self-Review

**Placeholders:** None. All decisions named explicitly.

**Internal consistency:** Schema (Section "Database") matches Components (Section "Backend"). Migration steps reference only the artifacts defined elsewhere in the doc.

**Scope:** Single sub-project. Implementation plan should fit in a single multi-task plan (probably 5-7 tasks: schema + backend + frontend + tests + seed + smoke + cleanup).

**Ambiguity:** One open call: email-change mirroring (Migration 3 vs admin-route-handles-both). Documented as a Risk with explicit "pick one during impl" — implementer must choose, but both options are spelled out, so no rabbit hole.
