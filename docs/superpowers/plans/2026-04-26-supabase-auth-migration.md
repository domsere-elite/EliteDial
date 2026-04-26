# Supabase Auth Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace EliteDial's custom JWT auth (bcryptjs + jsonwebtoken + tokenBlacklist + custom `/login`/`/refresh`/`/logout` routes) with Supabase Auth, preserving the existing brand-controlled login form.

**Architecture:** Rename `User` → `Profile` (PK = `auth.users.id`). Frontend keeps custom form, calls `supabase.auth.signInWithPassword` directly. Backend verifies Supabase JWT via shared HS256 secret (no JWKS round-trip). Role stays in `Profile.role`. A Postgres trigger on `auth.users` auto-creates the matching Profile row.

**Tech Stack:** Backend: TypeScript, Prisma, Express, `@supabase/supabase-js`, `jsonwebtoken` (verify only), Zod, node:test, supertest. Frontend: Next.js 14 App Router, `@supabase/supabase-js`. Postgres on Supabase.

**Spec:** `docs/superpowers/specs/2026-04-26-supabase-auth-migration-design.md`

---

## File Map

| Path | Status | Responsibility |
|---|---|---|
| `backend/.env.example` | **Modify** | Add `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` |
| `backend/src/config.ts` | **Modify** | Add `supabase` block |
| `backend/src/lib/env-validation.ts` | **Modify** | Fail-fast check for the Supabase env vars |
| `backend/src/test/env-validation.test.ts` | **Modify** | Test the new validation rule |
| `backend/src/lib/supabase-admin.ts` | **Create** | Backend-only Supabase client (service-role key) |
| `backend/package.json` | **Modify** | Add `@supabase/supabase-js`; drop `bcryptjs` + `@types/bcryptjs` (Task 4) |
| `backend/prisma/schema.prisma` | **Modify** (T3, T4) | T3 renames User→Profile; T4 drops password/username + adds FK to auth.users |
| `backend/prisma/migrations/<ts>_rename_user_to_profile/` | **Create** (T3) | Generated rename migration |
| `backend/prisma/migrations/<ts>_supabase_auth_swap/` | **Create** (T4) | Drop columns + FK + trigger SQL |
| `backend/src/middleware/auth.ts` | **Modify** (T4) | Replace `verifyToken` with Supabase JWT verify; lookup Profile by `sub` |
| `backend/src/routes/auth.ts` | **Modify** (T4) | Delete `/login`, `/refresh`, `/logout`, `/change-password`. Keep slim `/register` (Supabase admin SDK) + `/me` |
| `backend/src/routes/admin.ts` | **Modify** (T4) | `/agents` reset-password / delete / put → Supabase admin SDK |
| `backend/src/lib/socket.ts` | **Modify** (T4) | Verify Supabase JWT instead of our own |
| `backend/src/lib/validation.ts` | **Modify** (T4) | Remove `blacklistToken` + `isTokenBlacklisted` exports |
| `backend/src/test/validation.test.ts` | **Modify** (T4) | Drop blacklist tests |
| `backend/src/utils/jwt.ts` | **Delete** (T4) | Custom JWT mint/verify no longer needed |
| `backend/src/test/jwt.test.ts` | **Delete** (T4) | Tested deleted code |
| `backend/src/test/auth-middleware.test.ts` | **Create** (T4) | New middleware contract tests |
| `backend/src/test/auth-route.test.ts` | **Create** (T4) | `/register` + `/me` route tests |
| `backend/src/test/{ai-autonomous-worker,foundation,...}.test.ts` | **Modify** (T3) | Rename `User` fixtures to `Profile`, drop `passwordHash`/`username` if present |
| All 32 callsites of `prisma.user` (15 files) | **Modify** (T3) | Rename to `prisma.profile` |
| `backend/scripts/seed-admin.ts` | **Create** (T5) | One-shot script: `supabase.auth.admin.createUser` |
| `frontend/.env.example` (or local docs) | **Modify** (T2) | Document `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `frontend/package.json` | **Modify** (T2) | Add `@supabase/supabase-js` |
| `frontend/src/lib/supabase.ts` | **Create** (T2) | Browser Supabase client |
| `frontend/src/lib/api.ts` | **Modify** (T4) | Replace token interceptor + 401 handler |
| `frontend/src/app/page.tsx` (or whichever holds login form) | **Modify** (T4) | Switch form to email + `signInWithPassword` |
| `frontend/src/app/dashboard/layout.tsx` | **Modify** (T4) | Replace token-presence check with `onAuthStateChange` |
| `frontend/src/hooks/useSocket.ts` | **Modify** (T4) | Read token from `supabase.auth.getSession()` |
| `README.md` | **Modify** (T5) | "Run `npm run seed:admin` after first migration" |

---

## Task 1: Backend foundation — deps, config, env-validation, supabase-admin singleton, new middleware in a new file

**Goal:** Land everything new on the backend that has no behavioral consequence yet. Existing auth still works exactly as today. After this task, the backend imports `@supabase/supabase-js`, has the new middleware ready to swap in, and refuses to boot without the new env vars.

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/config.ts`
- Modify: `backend/.env.example`
- Modify: `backend/src/lib/env-validation.ts`
- Modify: `backend/src/test/env-validation.test.ts`
- Create: `backend/src/lib/supabase-admin.ts`
- Create: `backend/src/middleware/auth-supabase.ts` (temp file; merged into `auth.ts` in Task 4)
- Create: `backend/src/test/auth-middleware.test.ts`

### Steps

- [ ] **Step 1: Install the Supabase backend SDK**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/backend
npm install @supabase/supabase-js
```

Expected: `package.json` and `package-lock.json` updated, exit 0.

- [ ] **Step 2: Add `supabase` block to `config.ts`**

Open `backend/src/config.ts`. Find the existing `retell:` block. Add a `supabase` block immediately after it:

```typescript
    supabase: {
        url: process.env.SUPABASE_URL || '',
        anonKey: process.env.SUPABASE_ANON_KEY || '',
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        jwtSecret: process.env.SUPABASE_JWT_SECRET || '',
    },
```

(No other config changes; the existing `jwtSecret` / `jwtExpiresIn` at root level stays for now — removed in Task 4.)

- [ ] **Step 3: Update `.env.example`**

Open `backend/.env.example`. Below the existing Supabase `DATABASE_URL` (or in a new section), add:

```bash
# ─── Supabase Auth ─────────────────────────────────
# All four are required. Copy from Supabase dashboard → Project Settings → API.
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
# DO NOT commit. DO NOT expose to frontend. Server-side only.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
# JWT signing secret (HS256). Settings → API → JWT Settings → JWT Secret.
SUPABASE_JWT_SECRET=super-long-random-secret
```

- [ ] **Step 4: Create `lib/supabase-admin.ts`**

Create `backend/src/lib/supabase-admin.ts`:

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let _client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
    if (_client) return _client;
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return _client;
}
```

- [ ] **Step 5: Add Supabase env-validation rule**

Open `backend/src/lib/env-validation.ts`. Find the existing fail-fast section that validates required vars. Add the Supabase block (placement: alongside whichever block validates SignalWire, before `validateActivationsOrWarn`):

```typescript
    const required: Array<[string, string | undefined]> = [
        ['SUPABASE_URL', process.env.SUPABASE_URL],
        ['SUPABASE_JWT_SECRET', process.env.SUPABASE_JWT_SECRET],
        ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
    ];
    const missing = required.filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
        throw new Error(`Missing required Supabase env vars: ${missing.join(', ')}`);
    }
```

If the file already has a similar `required` array, append the three Supabase entries to it instead of creating a second array.

- [ ] **Step 6: Test env validation**

Open `backend/src/test/env-validation.test.ts`. Add this test (use an existing fixture pattern from the file for setup/teardown):

```typescript
test('env-validation: missing SUPABASE_JWT_SECRET throws on boot', async () => {
    const original = process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    try {
        await assert.rejects(
            () => validateEnvOrThrow(),
            /Missing required Supabase env vars.*SUPABASE_JWT_SECRET/,
        );
    } finally {
        if (original !== undefined) process.env.SUPABASE_JWT_SECRET = original;
    }
});
```

(Replace `validateEnvOrThrow` with the actual exported name in `env-validation.ts` — read the file's existing exports and match.)

- [ ] **Step 7: Run env-validation tests**

```bash
cd backend
npm test -- --test-name-pattern="env-validation" 2>&1 | tail -10
```

Expected: the new test fails (because the unset env var test runs in a process that already has the var set, OR the throw isn't triggered yet). Set `SUPABASE_JWT_SECRET=dev` in your local `.env` or shell, re-run; expected pass.

If the test framework doesn't support pattern filter, fall back to `npm test 2>&1 | grep env-validation`.

- [ ] **Step 8: Create `auth-middleware.test.ts` (test-first)**

Create `backend/src/test/auth-middleware.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { authenticate } from '../middleware/auth-supabase';

const TEST_SECRET = 'test-jwt-secret';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

function makeApp(profileLookup: (id: string) => Promise<any>) {
    const app = express();
    app.get('/protected', authenticate({ profileLookup }), (req: any, res) => {
        res.json({ user: req.user });
    });
    return app;
}

function signToken(claims: Partial<{ sub: string; email: string; aud: string; exp: number }>) {
    const fullClaims = {
        sub: 'user-1',
        email: 'user@example.com',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
    };
    return jwt.sign(fullClaims, TEST_SECRET, { algorithm: 'HS256' });
}

test('authenticate: valid token populates req.user from Profile', async () => {
    const app = makeApp(async (id) => ({
        id, email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'admin', extension: '101',
    }));
    const token = signToken({ sub: 'user-1' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, 'user-1');
    assert.equal(res.body.user.role, 'admin');
});

test('authenticate: missing Authorization header returns 401', async () => {
    const app = makeApp(async () => null);
    const res = await request(app).get('/protected');
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Missing or malformed Authorization header/);
});

test('authenticate: malformed Bearer prefix returns 401', async () => {
    const app = makeApp(async () => null);
    const res = await request(app).get('/protected').set('Authorization', 'Token xyz');
    assert.equal(res.status, 401);
});

test('authenticate: invalid signature returns 401', async () => {
    const app = makeApp(async () => null);
    const badToken = jwt.sign({ sub: 'x', aud: 'authenticated', exp: Math.floor(Date.now()/1000)+60 }, 'wrong-secret', { algorithm: 'HS256' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: expired token returns 401', async () => {
    const app = makeApp(async () => null);
    const expired = signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
});

test('authenticate: valid token but no Profile returns 401', async () => {
    const app = makeApp(async () => null);
    const token = signToken({ sub: 'unknown-user' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Profile not found/);
});
```

- [ ] **Step 9: Implement `middleware/auth-supabase.ts` to make tests pass**

Create `backend/src/middleware/auth-supabase.ts`:

```typescript
import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { config } from '../config';

interface SupabaseJwtClaims {
    sub: string;
    email: string;
    aud: string;
    exp: number;
}

interface AuthDeps {
    profileLookup?: (id: string) => Promise<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
        extension: string | null;
    } | null>;
}

export function authenticate(deps: AuthDeps = {}): RequestHandler {
    const lookup = deps.profileLookup ?? (async (id: string) => {
        return prisma.profile.findUnique({
            where: { id },
            select: { id: true, email: true, firstName: true, lastName: true, role: true, extension: true },
        });
    });

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or malformed Authorization header' });
            return;
        }
        const token = header.slice(7);
        let claims: SupabaseJwtClaims;
        try {
            claims = jwt.verify(token, config.supabase.jwtSecret, {
                algorithms: ['HS256'],
                audience: 'authenticated',
            }) as SupabaseJwtClaims;
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }
        const profile = await lookup(claims.sub);
        if (!profile) {
            res.status(401).json({ error: 'Profile not found for authenticated user' });
            return;
        }
        (req as any).user = {
            id: profile.id,
            email: profile.email,
            role: profile.role,
            firstName: profile.firstName,
            lastName: profile.lastName,
            extension: profile.extension,
        };
        next();
    };
}
```

Note: this file is intentionally ALONGSIDE the existing `middleware/auth.ts`. The two coexist after this task. Task 4 deletes the old one and merges this into `middleware/auth.ts` at the canonical path.

The `prisma.profile` reference will not resolve until Task 3 renames the model. That's fine because no production code uses this file yet — only the test, which DI-injects the `profileLookup`. The default branch (calling `prisma.profile`) is unreachable in this task.

- [ ] **Step 10: Run middleware tests**

```bash
cd backend && npm test 2>&1 | grep -E "auth-middleware|fail" | head -10
```

Expected: 6 `✔` lines for the new tests, 0 `✗`.

- [ ] **Step 11: Run full test suite + build**

```bash
cd backend && npm run build 2>&1 | tail -5 && npm test 2>&1 | tail -8
```

Expected: build exit 0; `ℹ tests 218` (212 existing + 6 new); `ℹ fail 0`.

- [ ] **Step 12: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/package.json backend/package-lock.json backend/.env.example \
        backend/src/config.ts \
        backend/src/lib/env-validation.ts backend/src/test/env-validation.test.ts \
        backend/src/lib/supabase-admin.ts \
        backend/src/middleware/auth-supabase.ts \
        backend/src/test/auth-middleware.test.ts
git commit -m "feat(auth): backend foundation for Supabase Auth migration"
```

---

## Task 2: Frontend foundation — deps + browser Supabase client

**Goal:** Frontend has `@supabase/supabase-js` available and a singleton client. Nothing wired in yet — login form still posts to `/api/auth/login`.

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/lib/supabase.ts`
- Modify: `frontend/.env.example` (or `.env.local.example` — match existing pattern; if no example file, skip)

### Steps

- [ ] **Step 1: Install the SDK**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/frontend
npm install @supabase/supabase-js
```

- [ ] **Step 2: Create `lib/supabase.ts`**

Create `frontend/src/lib/supabase.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
}

export const supabase = createClient(url, anonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
    },
});
```

- [ ] **Step 3: Document the env vars**

If `frontend/.env.example` exists, add:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

If no `.env.example` in frontend, add a brief note to `README.md` under "Environment variables" (or create that section if missing).

- [ ] **Step 4: Set the env vars locally and build**

Add the same two `NEXT_PUBLIC_*` values to `frontend/.env.local` (create if missing).

```bash
cd frontend && npm run build 2>&1 | tail -10; echo "EXIT: $?"
```

Expected: `EXIT: 0`. If the build fails because the env vars aren't set, the `lib/supabase.ts` throw is firing — set them and rerun.

- [ ] **Step 5: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add frontend/package.json frontend/package-lock.json frontend/src/lib/supabase.ts
# include .env.example or README.md if you edited them
git commit -m "feat(auth): frontend foundation for Supabase Auth migration"
```

---

## Task 3: Schema rename `User` → `Profile` (no auth behavior change)

**Goal:** Rename the model to `Profile` and update all 32 `prisma.user` callsites + test fixtures. **Keep `passwordHash` and `username` columns** for now — auth still works as today on the renamed table. This is a mechanical rename; no FK changes, no auth.users link, no trigger.

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<ts>_rename_user_to_profile/migration.sql`
- Modify: ~15 backend `.ts` files containing `prisma.user`
- Modify: test fixtures referencing `User` shape

### Steps

- [ ] **Step 1: Confirm baseline**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
grep -rn "prisma\.user\b" backend/src --include="*.ts" | wc -l
```

Expected: 32 (snapshot at planning time — accept ±2).

- [ ] **Step 2: Rename the model in `schema.prisma`**

Open `backend/prisma/schema.prisma`. Find `model User { ... }`. Change the model name to `Profile`. Leave all fields unchanged for now.

Then update relation references in dependent models. Search for `User?` and `User[]` and rename them to `Profile?` / `Profile[]`. Examples:

- `Call.assignedAgent User? @relation("AssignedAgent", ...)` → `assignedAgent Profile? @relation("AssignedAgent", ...)`
- `CallSession.user User? @relation(...)` → `user Profile? @relation(...)`
- Same for `Voicemail`, `Campaign.createdBy`, etc.

Don't change the FK column names (`assignedAgentId`, `userId`, `createdById`) — those stay.

- [ ] **Step 3: Generate the migration**

```bash
cd backend
npx prisma migrate dev --name rename_user_to_profile --create-only 2>&1 | tail -10
```

Inspect the generated `migration.sql`. Expected: a series of `ALTER TABLE ... RENAME TO "Profile"` plus FK constraint renames. Should NOT drop columns. If Prisma generates anything unexpected (like a destructive drop-and-recreate), STOP and ask.

- [ ] **Step 4: Apply the migration**

```bash
cd backend && npx prisma migrate dev 2>&1 | tail -10
```

Expected: migration applied, Prisma client regenerated.

- [ ] **Step 5: Mechanical rename of `prisma.user` → `prisma.profile`**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
grep -rl "prisma\.user\b" backend/src --include="*.ts" | xargs sed -i 's/\bprisma\.user\b/prisma.profile/g'
grep -rn "prisma\.user\b" backend/src --include="*.ts"
```

Expected: second grep returns 0 lines.

- [ ] **Step 6: Rename `User` type imports**

Some files import `User` from `@prisma/client`. Find them and rename:

```bash
grep -rn "from '@prisma/client'" backend/src --include="*.ts" | grep -E "User\b"
```

For each match, rename `User` → `Profile` in the import (and at usages within the file).

- [ ] **Step 7: Update test fixtures**

```bash
grep -rln "passwordHash\|username:" backend/src/test --include="*.ts"
```

For each test fixture object that constructs a `User`-shaped record, leave the fixture as-is (Profile still has those columns). Just verify nothing breaks. (Task 4 is where we drop `passwordHash`/`username` and update fixtures.)

- [ ] **Step 8: Build + tests**

```bash
cd backend && npm run build 2>&1 | tail -10 && npm test 2>&1 | tail -8
```

Expected: build exit 0; `ℹ tests 218`; `ℹ fail 0`.

If TypeScript errors mention "prisma.user does not exist", the rename missed somewhere. Re-run the grep from Step 5.

- [ ] **Step 9: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/prisma/schema.prisma backend/prisma/migrations/ backend/src/
git commit -m "refactor(auth): rename User model to Profile (no behavior change)"
```

---

## Task 4: The swap — drop password/username, activate Supabase Auth end-to-end

**Goal:** Drop `passwordHash` + `username` columns, add FK to `auth.users` + trigger, swap the auth middleware, slim auth routes, swap admin user-CRUD to Supabase admin SDK, swap Socket.IO auth, rewire frontend. **System is unbootable mid-task** — everything ships in one commit.

**Files:** see File Map for the full list. This task touches ~20 files.

### Steps

- [ ] **Step 1: Schema migration — drop columns + FK + trigger**

Open `backend/prisma/schema.prisma`. In the `Profile` model:

- Delete the `username String @unique` line
- Delete the `passwordHash String` line
- Change `id String @id @default(uuid())` to `id String @id @db.Uuid` (no `@default`; Supabase generates the UUID).

Generate the migration:

```bash
cd backend && npx prisma migrate dev --name supabase_auth_swap --create-only 2>&1 | tail -10
```

Open the generated `migration.sql`. Append the FK + trigger:

```sql
-- Foreign key from Profile.id to auth.users(id)
ALTER TABLE "Profile"
    ADD CONSTRAINT "Profile_id_fkey"
    FOREIGN KEY ("id") REFERENCES auth.users(id) ON DELETE CASCADE;

-- Trigger: auto-create Profile when a Supabase user is created
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

Apply:

```bash
cd backend && npx prisma migrate dev 2>&1 | tail -10
```

Expected: migration applied, exit 0. If the FK fails because Profile has rows whose `id` isn't in `auth.users`, run `DELETE FROM "Profile";` in Supabase SQL Editor first (no production data — confirmed in spec).

- [ ] **Step 2: Replace `middleware/auth.ts` with the Supabase implementation**

Read `backend/src/middleware/auth-supabase.ts` (created in Task 1). Copy its exports into `backend/src/middleware/auth.ts`, replacing the file's entire contents. Then delete `auth-supabase.ts`.

Important: the old `middleware/auth.ts` exported `authenticate` AND `authenticateApiKey`. Keep `authenticateApiKey` — it's used for webhook routes. The full new contents:

```typescript
import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { config } from '../config';

interface SupabaseJwtClaims {
    sub: string;
    email: string;
    aud: string;
    exp: number;
}

interface AuthDeps {
    profileLookup?: (id: string) => Promise<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
        extension: string | null;
    } | null>;
}

function authenticateImpl(deps: AuthDeps = {}): RequestHandler {
    const lookup = deps.profileLookup ?? (async (id: string) => {
        return prisma.profile.findUnique({
            where: { id },
            select: { id: true, email: true, firstName: true, lastName: true, role: true, extension: true },
        });
    });

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or malformed Authorization header' });
            return;
        }
        const token = header.slice(7);
        let claims: SupabaseJwtClaims;
        try {
            claims = jwt.verify(token, config.supabase.jwtSecret, {
                algorithms: ['HS256'],
                audience: 'authenticated',
            }) as SupabaseJwtClaims;
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }
        const profile = await lookup(claims.sub);
        if (!profile) {
            res.status(401).json({ error: 'Profile not found for authenticated user' });
            return;
        }
        (req as any).user = {
            id: profile.id,
            email: profile.email,
            role: profile.role,
            firstName: profile.firstName,
            lastName: profile.lastName,
            extension: profile.extension,
        };
        next();
    };
}

// Default-export-style: bare middleware that uses real Prisma. Backwards-compatible
// with all existing `app.use(authenticate)` / `router.get(..., authenticate, ...)` callsites.
export const authenticate: RequestHandler = authenticateImpl();

// Used by route tests that want to inject a stubbed profile lookup.
export const buildAuthenticate = authenticateImpl;

// Existing API-key auth — preserved unchanged from the previous middleware.
// (Copy the body of the previous `authenticateApiKey` function here verbatim.)
export async function authenticateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    // ... copy the existing implementation from the old middleware/auth.ts ...
}
```

Read the old `middleware/auth.ts` to copy `authenticateApiKey` verbatim into the new file. Don't lose that function.

Update `backend/src/test/auth-middleware.test.ts`: change the import from `'../middleware/auth-supabase'` to `'../middleware/auth'` and the helper now calls `buildAuthenticate({ profileLookup })` instead of `authenticate({ profileLookup })`:

```typescript
import { buildAuthenticate } from '../middleware/auth';
// ...
function makeApp(profileLookup: (id: string) => Promise<any>) {
    const app = express();
    app.get('/protected', buildAuthenticate({ profileLookup }), (req: any, res) => {
        res.json({ user: req.user });
    });
    return app;
}
```

Delete `backend/src/middleware/auth-supabase.ts`:

```bash
rm backend/src/middleware/auth-supabase.ts
```

- [ ] **Step 3: Slim `routes/auth.ts`**

Replace the entire contents of `backend/src/routes/auth.ts` with:

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { validate } from '../middleware/validation';
import { supabaseAdmin } from '../lib/supabase-admin';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const router = Router();

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    role: z.enum(['agent', 'supervisor', 'admin']).optional().default('agent'),
    extension: z.string().optional().nullable(),
});

router.post('/register', authenticate, requireRole('admin'), validate(registerSchema), async (req: Request, res: Response): Promise<void> => {
    const { email, password, firstName, lastName, role, extension } = req.body;
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { firstName, lastName, role },
    });
    if (error || !data?.user) {
        logger.warn('register failed', { error: error?.message });
        res.status(400).json({ error: error?.message || 'register failed' });
        return;
    }
    // The trigger on auth.users INSERT creates the Profile row. Set the optional
    // extension here since the trigger doesn't know about it.
    if (extension) {
        await prisma.profile.update({ where: { id: data.user.id }, data: { extension } });
    }
    const profile = await prisma.profile.findUnique({ where: { id: data.user.id } });
    res.status(201).json(profile);
});

router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
    res.json((req as any).user);
});

export default router;
```

- [ ] **Step 4: Update `routes/admin.ts` agent CRUD**

Open `backend/src/routes/admin.ts`. Find the four `/agents` handlers and rewrite them:

**`POST /agents/:id/reset-password`** — replace bcrypt logic with Supabase admin SDK:

```typescript
router.post('/agents/:id/reset-password', authenticate, requireRole('admin'), validate(resetPasswordSchema), async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.id;
    const { newPassword } = req.body;
    const { error } = await supabaseAdmin().auth.admin.updateUserById(agentId, { password: newPassword });
    if (error) {
        res.status(400).json({ error: error.message });
        return;
    }
    res.json({ ok: true });
});
```

**`DELETE /agents/:id`** — replace Prisma delete with Supabase admin delete (FK cascade handles Profile):

```typescript
router.delete('/agents/:id', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.id;
    const { error } = await supabaseAdmin().auth.admin.deleteUser(agentId);
    if (error) {
        res.status(400).json({ error: error.message });
        return;
    }
    res.json({ ok: true });
});
```

**`PUT /agents/:id`** — Profile update; if email changes, also update Supabase:

```typescript
router.put('/agents/:id', authenticate, requireRole('admin'), validate(updateAgentSchema), async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.id;
    const { email, firstName, lastName, role, extension } = req.body;
    if (email) {
        const { error } = await supabaseAdmin().auth.admin.updateUserById(agentId, { email });
        if (error) {
            res.status(400).json({ error: error.message });
            return;
        }
    }
    const updated = await prisma.profile.update({
        where: { id: agentId },
        data: {
            ...(email !== undefined && { email }),
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(role !== undefined && { role }),
            ...(extension !== undefined && { extension }),
        },
    });
    res.json(updated);
});
```

**`GET /agents`** — usually just `prisma.profile.findMany`. If it currently returns `passwordHash`, drop it from the select.

Add the import at the top of `admin.ts`:

```typescript
import { supabaseAdmin } from '../lib/supabase-admin';
```

Remove the `import bcrypt from 'bcryptjs';` line.

If `updateAgentSchema` (in `lib/validation.ts`) currently allows `username` or `password` fields, remove them. The schema should now look like:

```typescript
export const updateAgentSchema = z.object({
    email: z.string().email().optional(),
    firstName: optionalString,
    lastName: optionalString,
    role: z.enum(['agent', 'supervisor', 'admin']).optional(),
    extension: z.string().optional().nullable(),
});
```

- [ ] **Step 5: Update `lib/socket.ts` to verify Supabase JWT**

Replace the body of the auth handler in `backend/src/lib/socket.ts`:

```typescript
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from './prisma';

// Inside the io.use(...) handler — replace verifyToken + isTokenBlacklisted logic with:
const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.toString().replace(/^Bearer /, '');
if (!token) {
    return next(new Error('Authentication required'));
}
let claims: any;
try {
    claims = jwt.verify(token, config.supabase.jwtSecret, {
        algorithms: ['HS256'],
        audience: 'authenticated',
    });
} catch {
    return next(new Error('Invalid or expired token'));
}
const profile = await prisma.profile.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, role: true, firstName: true, lastName: true },
});
if (!profile) {
    return next(new Error('Profile not found'));
}
(socket as any).user = profile;
next();
```

(Read the current file first to preserve any non-auth handling around the auth block.) Drop the `import { verifyToken, TokenPayload } from '../utils/jwt'` and `import { isTokenBlacklisted } from './validation'` lines.

- [ ] **Step 6: Drop `lib/validation.ts` blacklist exports**

Open `backend/src/lib/validation.ts`. Delete `blacklistToken` and `isTokenBlacklisted` functions plus any internal `Set<string>` they share. Keep all Zod schemas untouched.

Open `backend/src/test/validation.test.ts`. Delete the two `blacklistToken` / `isTokenBlacklisted` tests.

- [ ] **Step 7: Delete `utils/jwt.ts` + `test/jwt.test.ts`**

```bash
rm backend/src/utils/jwt.ts backend/src/test/jwt.test.ts
```

Search for any remaining imports:

```bash
grep -rn "from.*utils/jwt\|verifyToken\|generateToken" backend/src --include="*.ts"
```

Expected: 0 results. If any remain, fix them (Socket.IO file from Step 5 should already be clean; auth middleware doesn't import jwt utils anymore).

- [ ] **Step 8: Drop `bcryptjs` from `package.json`**

```bash
cd backend && npm uninstall bcryptjs @types/bcryptjs
```

Verify no remaining imports:

```bash
grep -rn "from 'bcryptjs'\|from \"bcryptjs\"" backend/src --include="*.ts"
```

Expected: 0 results.

- [ ] **Step 9: Add `auth-route.test.ts`**

Create `backend/src/test/auth-route.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { Router } from 'express';

// Build a minimal stand-in router that mirrors the real /api/auth shape but
// with DI'd Supabase admin SDK and DI'd auth middleware so we don't need a
// real JWT or DB.
function buildTestAuthRouter(deps: {
    requireAdmin?: boolean;
    createUserResult?: { data: any; error: any };
    profile?: any;
}) {
    const router = Router();
    const fakeAuth: express.RequestHandler = (req: any, _res, next) => {
        req.user = { id: 'admin-1', role: deps.requireAdmin ? 'admin' : 'agent' };
        next();
    };
    const fakeRequireRole = (role: string): express.RequestHandler => (req: any, res, next) => {
        if (req.user?.role !== role) {
            res.status(403).json({ error: 'forbidden' });
            return;
        }
        next();
    };
    router.post('/register', fakeAuth, fakeRequireRole('admin'), express.json(), async (req, res) => {
        const { email, password, firstName, lastName } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: 'email and password required' });
            return;
        }
        const r = deps.createUserResult ?? { data: { user: { id: 'new-1', email } }, error: null };
        if (r.error) {
            res.status(400).json({ error: r.error.message });
            return;
        }
        res.status(201).json({ id: r.data.user.id, email, firstName, lastName });
    });
    router.get('/me', fakeAuth, (req: any, res) => res.json(req.user));
    return router;
}

test('POST /register: non-admin returns 403', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: false }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'a@b.c', password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 403);
});

test('POST /register: missing email returns 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 400);
});

test('POST /register: admin + valid body returns 201 with profile shape', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'a@b.c', password: 'pw12345678', firstName: 'A', lastName: 'B' });
    assert.equal(res.status, 201);
    assert.equal(res.body.email, 'a@b.c');
    assert.ok(res.body.id);
});

test('GET /me: returns req.user', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', buildTestAuthRouter({ requireAdmin: true }));
    const res = await request(app).get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'admin');
});
```

This test exercises the contract (auth gate, validation, response shape) without depending on real Supabase.

- [ ] **Step 10: Frontend — rewire `lib/api.ts`**

Open `frontend/src/lib/api.ts`. Replace the existing request interceptor and the 401 response handler so the file looks like:

```typescript
import axios from 'axios';
import { supabase } from './supabase';

const api = axios.create({
    baseURL: '/api',
    headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`;
    }
    return config;
});

api.interceptors.response.use(
    (r) => r,
    async (error) => {
        if (error.response?.status === 401) {
            await supabase.auth.signOut();
            if (typeof window !== 'undefined') {
                window.location.href = '/';
            }
        }
        return Promise.reject(error);
    },
);

export default api;
```

Delete the existing manual refresh-queue logic, the `failedQueue`, the `isRefreshing` flag, and all `localStorage.getItem/setItem/removeItem('elitedial_*')` calls.

- [ ] **Step 11: Frontend — login form**

Find the login form. Likely at `frontend/src/app/page.tsx`. Read it; locate the submit handler that POSTs to `/api/auth/login`. Replace with:

```typescript
import { supabase } from '@/lib/supabase';
// ...
const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
        setError(error.message);
        return;
    }
    router.push('/dashboard');
};
```

Change the username input to an email input (`type="email"`, `value={email}`, `onChange={e => setEmail(e.target.value)}`). Rename the state variable `username` → `email`.

If the form has a "remember me" checkbox or token-storage logic, remove it — `supabase-js` handles persistence automatically.

- [ ] **Step 12: Frontend — dashboard layout**

Open `frontend/src/app/dashboard/layout.tsx`. Replace the existing on-mount token-presence check with:

```typescript
import { supabase } from '@/lib/supabase';
// ...
useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
        if (mounted && !session) router.push('/');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!session) router.push('/');
    });
    return () => { mounted = false; subscription.unsubscribe(); };
}, [router]);
```

Remove all `localStorage.getItem/setItem('elitedial_*')` references in this file. If the file used `elitedial_user` to populate a header avatar, replace with a fetch to `GET /api/auth/me` on mount.

- [ ] **Step 13: Frontend — `useSocket.ts`**

Open `frontend/src/hooks/useSocket.ts`. Replace token-from-localStorage with:

```typescript
import { supabase } from '@/lib/supabase';
// ...
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;
if (!token) return; // not authenticated; don't connect
const socket = io(url, {
    auth: { token },
    transports: ['websocket'],
});
```

Reconnect on token refresh:

```typescript
const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED' && socket) {
        socket.disconnect();
        socket.connect();
    }
});
return () => { subscription.unsubscribe(); socket.disconnect(); };
```

- [ ] **Step 14: Backend tests + build**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/backend
npm run build 2>&1 | tail -10
npm test 2>&1 | tail -10
```

Expected: build exit 0; tests around `~210` (218 from end of Task 1, minus ~12 jwt.test.ts, plus 4 auth-route, minus 2 blacklist tests in validation.test.ts ≈ 208). Some specific count is fine — what matters is `ℹ fail 0`.

If any test fails because a fixture references `username` or `passwordHash`, fix the fixture (drop those fields). If any TypeScript error mentions `verifyToken` / `generateToken`, an import survived — grep and fix.

- [ ] **Step 15: Frontend build**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial/frontend
npm run build 2>&1 | tail -15
echo "EXIT: $?"
```

Expected: `EXIT: 0`. Common failure: a stale `localStorage.getItem('elitedial_token')` reference somewhere. Grep:

```bash
grep -rn "elitedial_token\|elitedial_user\|elitedial_refresh" frontend/src
```

Expected: 0.

- [ ] **Step 16: Single big commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add -A
git status  # verify only intended files are staged
git commit -m "feat(auth): switch to Supabase Auth end-to-end"
```

If `git status` shows files you didn't expect (e.g. unrelated edits), unstage them with `git reset HEAD <file>` and commit only the migration changes.

---

## Task 5: Seed initial admin + manual smoke + README

**Goal:** Provide a one-shot script to create the first admin user in Supabase + Profile, document it, and run the manual smoke checklist.

**Files:**
- Create: `backend/scripts/seed-admin.ts`
- Modify: `README.md` (or `backend/README.md` if that's the convention)

### Steps

- [ ] **Step 1: Create `seed-admin.ts`**

Create `backend/scripts/seed-admin.ts`:

```typescript
import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase-admin';

async function main() {
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    const firstName = process.env.SEED_ADMIN_FIRST_NAME || 'Admin';
    const lastName = process.env.SEED_ADMIN_LAST_NAME || 'User';
    if (!email || !password) {
        console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars before running.');
        process.exit(1);
    }
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { firstName, lastName, role: 'admin' },
    });
    if (error) {
        console.error('Failed:', error.message);
        process.exit(1);
    }
    console.log(`Created admin user ${data.user.id} (${email}). Trigger created the matching Profile.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

Open `backend/package.json`. In `scripts`, add:

```json
"seed:admin": "tsx scripts/seed-admin.ts"
```

(If `tsx` isn't a dev dep, use `ts-node scripts/seed-admin.ts` — match whichever is already used by other `seed*` scripts.)

- [ ] **Step 3: Document in README**

Open the project README. Add or update a section:

```markdown
## First-time setup (Supabase Auth)

1. Provision Supabase Auth: dashboard → Authentication → Providers → enable Email.
2. Set backend env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`.
3. Set frontend env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Run migrations: `cd backend && npx prisma migrate deploy`.
5. Seed the first admin:
   ```bash
   cd backend
   SEED_ADMIN_EMAIL=admin@yourcompany.com SEED_ADMIN_PASSWORD=<strong-password> npm run seed:admin
   ```
6. Log in at the frontend with that email + password.
```

- [ ] **Step 4: Run the seed**

```bash
cd backend
SEED_ADMIN_EMAIL=test-admin@example.com SEED_ADMIN_PASSWORD=ChangeMe!12345 npm run seed:admin
```

Expected output: `Created admin user <uuid> (test-admin@example.com). Trigger created the matching Profile.`

Verify in Supabase Studio (SQL editor):

```sql
SELECT id, email FROM auth.users WHERE email = 'test-admin@example.com';
SELECT id, email, role FROM public."Profile" WHERE email = 'test-admin@example.com';
```

Both queries should return one row with the same `id`.

- [ ] **Step 5: Manual smoke test**

Start backend and frontend dev servers. In a browser:

1. Navigate to the login page.
2. Log in with `test-admin@example.com` / `ChangeMe!12345`.
3. Confirm redirect to `/dashboard`.
4. Open browser devtools → Network → confirm an `Authorization: Bearer <jwt>` header on requests to `/api/*`.
5. Hit `/api/auth/me` (via the dashboard or curl with the token) → expect `{ id, email, role: 'admin', ... }`.
6. Navigate to an admin-only page (e.g. `/dashboard/admin`) → loads.
7. Click logout → confirm redirect to `/`.
8. Reload the page after login → still authenticated (session persisted in localStorage).
9. In Supabase Studio, set the password for the test user via the admin SDK (or change it through your own `POST /api/admin/agents/:id/reset-password` endpoint) — log in with new password works.
10. Delete the test user via `DELETE /api/admin/agents/:id` → confirm both `auth.users` and `Profile` rows are gone (FK cascade).

If any step fails, fix the underlying issue before committing.

- [ ] **Step 6: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/scripts/seed-admin.ts backend/package.json README.md
git commit -m "feat(auth): seed-admin script + first-time setup docs"
```

- [ ] **Step 7: Push**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial && git push
```

(Wait for explicit user approval before running `git push`. If executing this plan via the executing-plans skill, the executor stops here and asks first.)

---

## Final verification

- [ ] Backend: `npm run build && npm test` — build exit 0, ~208 tests pass / 0 fail.
- [ ] Frontend: `npm run build` — exit 0.
- [ ] All 10 manual smoke steps from Task 5 Step 5 passed.
- [ ] Spec checklist: all 9 decisions from `docs/superpowers/specs/2026-04-26-supabase-auth-migration-design.md` shipped.

---

## Self-Review

**Spec coverage:**

| Spec section / decision | Covered by |
|---|---|
| D1 Profile rename + PK = auth.users.id | Task 3 (rename) + Task 4 Step 1 (PK shape) |
| D2 Custom login form calling supabase-js | Task 4 Step 11 |
| D3 role on Profile.role | Task 3 (preserved through rename) + Task 4 (untouched in schema cleanup) |
| D4 HS256 JWT verify with shared secret | Task 1 Step 9 (middleware), Task 4 Step 5 (Socket.IO) |
| D5 email-only login | Task 4 Step 1 (drop username column), Task 4 Step 11 (form input) |
| D6 trigger auto-creates Profile | Task 4 Step 1 (raw SQL in migration) |
| D7 FK ON DELETE CASCADE | Task 4 Step 1 |
| D8 change-password is frontend-only | Task 4 Step 3 (route deleted from backend) |
| D9 admin reset-password via Supabase admin SDK | Task 4 Step 4 |
| Slim auth.ts (only /register + /me) | Task 4 Step 3 |
| Drop /login, /refresh, /logout | Task 4 Step 3 (all deleted in route rewrite) |
| Drop tokenBlacklist | Task 4 Step 6 |
| Drop bcryptjs + jsonwebtoken (mint) | Task 4 Step 8 (bcrypt); jwt verify kept |
| Drop jwt.test.ts | Task 4 Step 7 |
| Add auth-middleware.test.ts (~6 tests) | Task 1 Step 8 |
| Add auth-route.test.ts (~4 tests) | Task 4 Step 9 |
| frontend api.ts rewrite | Task 4 Step 10 |
| dashboard layout onAuthStateChange | Task 4 Step 12 |
| useSocket.ts | Task 4 Step 13 |
| seed-admin script | Task 5 Step 1 |
| Manual smoke 10 items | Task 5 Step 5 |
| env-validation fail-fast on Supabase vars | Task 1 Step 5 |
| Risk: trigger-fail-on-conflict | Mitigated in trigger SQL via `ON CONFLICT DO NOTHING` (Task 4 Step 1) |
| Risk: service-role key leak | Documented in `.env.example` (Task 1 Step 3) |

All spec sections covered.

**Placeholder scan:** No "TBD" / "fill in details" / "similar to Task N". Step 2 of Task 4 says "copy `authenticateApiKey` verbatim" — that's an instruction the implementer can execute by reading the old file (3 lines of context). Step 5 of Task 4 says "preserve any non-auth handling" — same instruction. Both are acceptable because the surrounding code (which we don't want to fully reproduce here) is small and clear at the actual file.

**Type consistency:**
- `req.user` shape (`{ id, email, role, firstName, lastName, extension }`) is identical in `auth-middleware.test.ts` (Task 1), `middleware/auth.ts` (Task 4 Step 2), and `routes/auth.ts` (Task 4 Step 3 — `GET /me` returns it).
- `Profile` field set (`id`, `email`, `firstName`, `lastName`, `role`, `status`, `extension`, `createdAt`, `updatedAt`) is identical in trigger SQL (Task 4 Step 1) and Prisma schema (after Step 1).
- `buildAuthenticate` and `authenticate` exports from `middleware/auth.ts` (Task 4 Step 2) match the test's `buildAuthenticate` import (Task 4 Step 2 explicitly updates it).

**Test count:**
- Baseline: 212.
- Task 1: +6 (auth-middleware) + 1 (env-validation) → 219.
- Task 3: 0 (rename only) → 219.
- Task 4: −12 (jwt.test.ts) − 2 (validation blacklist tests) + 4 (auth-route) → 209.
- Task 5: 0 (script + manual smoke) → 209.
- Final target: ~209.

**Risk notes (already in spec, restated):**
- The single big commit in Task 4 is ~20 file changes across backend + frontend. If anything goes wrong mid-task, abort and `git reset --hard` rather than committing a half-state. The `git status` check before commit at Step 16 is the safety net.
- The trigger silently dropping a Profile insert is the highest-impact risk; the `ON CONFLICT DO NOTHING` clause + the smoke test in Task 5 covers it.
- The `frontend/src/app/page.tsx` location for the login form is a guess. Step 11 of Task 4 says "Find the login form. Likely at `frontend/src/app/page.tsx`." If it's elsewhere, the implementer reads the directory listing and picks the right file — small lookup, not a plan failure.
