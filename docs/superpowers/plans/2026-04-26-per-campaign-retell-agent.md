# Per-Campaign Retell Agent Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the per-campaign Retell agent assignment that the backend already half-supports — drop the unused `retellAgentPromptVersion` column, add a `/api/retell/agents` proxy, surface an "AI Agent" dropdown in the campaign form, and display the assigned agent on the campaign settings tab.

**Architecture:** Subtractive Prisma migration removes one column. New backend route proxies Retell's list-agents API. Frontend gains a conditional dropdown (only when `dialMode === 'ai_autonomous'`) that loads once on form mount and persists `retellAgentId` + `retellSipAddress` together. SettingsTab reads the same list to show the assigned agent's name.

**Tech Stack:** Backend: TypeScript, Prisma, Express, Zod, node:test, supertest. Frontend: Next.js 14 App Router (client components), no test harness.

**Spec:** `docs/superpowers/specs/2026-04-25-per-campaign-retell-agent-design.md`

---

## File Map

| Path | Status | Responsibility |
|---|---|---|
| `backend/prisma/schema.prisma` | **Modify** | Drop `retellAgentPromptVersion` from `Campaign` |
| `backend/prisma/migrations/<timestamp>_drop_retell_agent_prompt_version/migration.sql` | **Create** (generated) | Subtractive migration |
| `backend/src/lib/validation.ts` | **Modify** | Drop field from `updateCampaignSchema`; add retell fields to `createCampaignSchema` |
| `backend/src/routes/campaigns.ts` | **Modify** | Drop field from activation guard; persist retell fields on create; drop from PATCH handler |
| `backend/src/services/ai-autonomous-worker.ts` | **Modify** | Drop field from interface, select projection, reservation request building, missing-config guard |
| `backend/src/lib/env-validation.ts` | **Modify** | Drop field from `validateActivationsOrWarn` query |
| `backend/src/test/campaigns-activation.test.ts` | **Modify** | Update test fixtures and assertions |
| `backend/src/test/ai-autonomous-worker.test.ts` | **Modify** | Update fixtures |
| `backend/src/test/ai-autonomous-mock-integration.test.ts` | **Modify** | Update fixtures |
| `backend/src/test/integration-ai-autonomous-e2e.test.ts` | **Modify** | Update fixtures |
| `backend/src/test/campaigns-create.test.ts` | **Create** | Test create handler persists `retellAgentId` + `retellSipAddress` |
| `backend/src/services/retell-agents-service.ts` | **Create** | Pure service: `listAgents({ fetchImpl, apiKey, baseUrl })` returns `[{id,name,sipAddress}]` |
| `backend/src/routes/retell-agents.ts` | **Create** | `GET /api/retell/agents` route |
| `backend/src/test/retell-agents-service.test.ts` | **Create** | Unit tests for the service |
| `backend/src/test/retell-agents-route.test.ts` | **Create** | Route tests with mocked service |
| `backend/src/index.ts` | **Modify** | Mount the new route |
| `frontend/src/lib/retellAgents.ts` | **Create** | Tiny client helper: `RetellAgent` type + `fetchRetellAgents()` |
| `frontend/src/components/campaigns/CampaignForm.tsx` | **Modify** | Add `retellAgentId`/`retellSipAddress` to values; render AI Agent card |
| `frontend/src/components/campaigns/tabs/SettingsTab.tsx` | **Modify** | Show AI Agent row when `dialMode === 'ai_autonomous'` |
| `frontend/src/app/dashboard/campaigns/[id]/edit/page.tsx` | **Modify** | Hydrate `retellAgentId` + `retellSipAddress` from campaign GET |
| `frontend/src/app/dashboard/campaigns/[id]/page.tsx` | **Modify** (if needed) | Ensure `dialMode` + `retellAgentId` flow into SettingsTab |

---

## Task 1: Drop `retellAgentPromptVersion` (backend cleanup)

**Goal:** Remove the unused audit-tag column and all references in a single shippable commit. Tests stay green throughout.

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/lib/validation.ts`
- Modify: `backend/src/routes/campaigns.ts`
- Modify: `backend/src/services/ai-autonomous-worker.ts`
- Modify: `backend/src/lib/env-validation.ts`
- Modify: `backend/src/test/campaigns-activation.test.ts`
- Modify: `backend/src/test/ai-autonomous-worker.test.ts`
- Modify: `backend/src/test/ai-autonomous-mock-integration.test.ts`
- Modify: `backend/src/test/integration-ai-autonomous-e2e.test.ts`

### Steps

- [ ] **Step 1: Confirm current references**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
grep -rn "retellAgentPromptVersion" backend/ --include="*.ts" --include="*.prisma" | wc -l
```

Expected: 19 (snapshot taken during planning; off-by-a-few is fine — we delete every occurrence).

- [ ] **Step 2: Drop the field from `schema.prisma`**

Open `backend/prisma/schema.prisma`, find the `Campaign` model, delete the line:

```prisma
  retellAgentPromptVersion  String?   // Operator-set audit tag, required non-empty to activate ai_autonomous
```

Leave `retellAgentId` and `retellSipAddress` intact.

- [ ] **Step 3: Generate the migration**

```bash
cd backend && npx prisma migrate dev --name drop_retell_agent_prompt_version --create-only
```

Expected: a new directory `prisma/migrations/<ts>_drop_retell_agent_prompt_version/` with a `migration.sql` containing roughly:

```sql
ALTER TABLE "Campaign" DROP COLUMN "retellAgentPromptVersion";
```

If the migration body looks correct, apply it:

```bash
cd backend && npx prisma migrate dev
```

Expected: migration applied, `prisma generate` runs automatically, exit 0.

- [ ] **Step 4: Update `updateCampaignSchema` in `validation.ts`**

Open `backend/src/lib/validation.ts`. Find the `updateCampaignSchema` (line ~123). Delete the line:

```typescript
    retellAgentPromptVersion: z.string().nullable().optional(),
```

Then **add the two retell fields to `createCampaignSchema`** (currently they're missing — bug fix bundled here). After `maxConcurrentCalls`:

```typescript
export const createCampaignSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: optionalString,
    dialMode: z.enum(['manual', 'progressive', 'ai_autonomous']).optional().default('manual'),
    timezone: z.string().optional().default('America/Chicago'),
    maxAttemptsPerLead: z.number().int().min(1).max(50).optional().default(6),
    retryDelaySeconds: z.number().int().min(30).optional().default(600),
    maxConcurrentCalls: z.number().int().min(0).optional().default(0),
    retellAgentId: z.string().nullable().optional(),
    retellSipAddress: z.string().nullable().optional(),
});
```

- [ ] **Step 5: Update `campaigns.ts` route**

Open `backend/src/routes/campaigns.ts`.

**5a — Activation guard (lines 19-37):**

```typescript
export function checkAiAutonomousActivation(c: {
    dialMode: string;
    status: string;
    retellAgentId: string | null;
    retellSipAddress: string | null;
}): { ok: true } | { ok: false; missing: string[] } {
    if (c.dialMode !== 'ai_autonomous') return { ok: true };
    if (c.status !== 'active') return { ok: true };
    const missing: string[] = [];
    if (!c.retellAgentId) missing.push('retellAgentId');
    if (!c.retellSipAddress) missing.push('retellSipAddress');
    if (missing.length) return { ok: false, missing };
    return { ok: true };
}
```

(Remove the `retellAgentPromptVersion` parameter and check.)

**5b — POST handler (lines 194-219), persist retell fields on create:**

```typescript
router.post('/', authenticate, requireMinRole('supervisor'), validate(createCampaignSchema), async (req: Request, res: Response): Promise<void> => {
    const {
        name,
        description,
        dialMode,
        timezone,
        maxAttemptsPerLead,
        retryDelaySeconds,
        maxConcurrentCalls,
        retellAgentId,
        retellSipAddress,
    } = req.body;

    const campaign = await prisma.campaign.create({
        data: {
            name,
            description,
            dialMode,
            timezone,
            maxAttemptsPerLead,
            retryDelaySeconds: Math.max(30, Math.round(toNumber(retryDelaySeconds, 600))),
            maxConcurrentCalls: Math.max(0, Math.round(toNumber(maxConcurrentCalls, 0))),
            retellAgentId: retellAgentId ?? null,
            retellSipAddress: retellSipAddress ?? null,
            createdById: req.user?.id,
        },
    });

    res.status(201).json(campaign);
});
```

**5c — PATCH handler (line 378):** delete the line `retellAgentPromptVersion: validated.retellAgentPromptVersion,`. Leave `retellAgentId` and `retellSipAddress` untouched.

- [ ] **Step 6: Update `ai-autonomous-worker.ts`**

Open `backend/src/services/ai-autonomous-worker.ts`.

**6a — Interface (line ~32-34):** delete `retellAgentPromptVersion: string | null;` from the `CampaignSlim` (or whichever interface defines those three fields).

**6b — Missing-config guard (line 122):**

```typescript
if (!campaign.retellAgentId || !campaign.retellSipAddress) {
    const skipKey = `retell-missing:${campaignId}`;
```

**6c — Select projection (line ~325):** delete `retellAgentPromptVersion: true,`.

**6d — Reservation/dispatch construction (lines ~382 and ~408):** delete the `retellAgentPromptVersion: campaign.retellAgentPromptVersion,` lines. If a downstream type requires the field, also remove it from that type's interface in this file.

- [ ] **Step 7: Update `env-validation.ts`**

Open `backend/src/lib/env-validation.ts`. Find `validateActivationsOrWarn` (line ~53-72). Update the OR clause:

```typescript
    const broken = await prisma.campaign.findMany({
        where: {
            status: 'active',
            dialMode: 'ai_autonomous',
            OR: [
                { retellAgentId: null },
                { retellSipAddress: null },
            ],
        },
        select: { id: true, name: true },
    });
```

- [ ] **Step 8: Update `campaigns-activation.test.ts`**

Open `backend/src/test/campaigns-activation.test.ts` and replace its body with:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../lib/event-bus';
import { checkAiAutonomousActivation } from '../routes/campaigns';

test('campaigns-activation: non-ai_autonomous always passes', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'progressive', status: 'active',
        retellAgentId: null, retellSipAddress: null,
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: ai_autonomous + draft passes (not yet activating)', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'draft',
        retellAgentId: null, retellSipAddress: null,
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: ai_autonomous + active + missing → reports missing fields', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'active',
        retellAgentId: 'ag1', retellSipAddress: null,
    });
    assert.equal(r.ok, false);
    assert.deepEqual((r as { ok: false; missing: string[] }).missing, ['retellSipAddress']);
});

test('campaigns-activation: ai_autonomous + active + complete passes', () => {
    const r = checkAiAutonomousActivation({
        dialMode: 'ai_autonomous', status: 'active',
        retellAgentId: 'ag1', retellSipAddress: 'sip:x@y',
    });
    assert.equal(r.ok, true);
});

test('campaigns-activation: campaign.activated event flows through eventBus', () => {
    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventBus.on('campaign.activated', listener);
    eventBus.emit('campaign.activated', { campaignId: 'k1' });
    eventBus.off('campaign.activated', listener);
    assert.deepEqual(seen, [{ campaignId: 'k1' }]);
});
```

- [ ] **Step 9: Update remaining test fixtures**

In `backend/src/test/ai-autonomous-worker.test.ts` (lines 19, 40, 103), `backend/src/test/ai-autonomous-mock-integration.test.ts` (line 29), and `backend/src/test/integration-ai-autonomous-e2e.test.ts` (lines 57, 121, 177): delete `retellAgentPromptVersion: 'v1',` (or `: null,`) from each fixture object.

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
grep -rn "retellAgentPromptVersion" backend/ --include="*.ts" --include="*.prisma"
```

Expected: 0 lines.

- [ ] **Step 10: Build and run tests**

```bash
cd backend && npm run build && npm test 2>&1 | tail -10
```

Expected: build exit 0; `ℹ tests 199` (unchanged from baseline because we only edited fixtures, not added/removed tests yet); `ℹ fail 0`.

If any test fails because a TypeScript fixture object no longer matches a stricter type, the type narrowed correctly in this task — fix the fixture, not the type.

- [ ] **Step 11: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/prisma/schema.prisma \
        backend/prisma/migrations/ \
        backend/src/lib/validation.ts \
        backend/src/routes/campaigns.ts \
        backend/src/services/ai-autonomous-worker.ts \
        backend/src/lib/env-validation.ts \
        backend/src/test/campaigns-activation.test.ts \
        backend/src/test/ai-autonomous-worker.test.ts \
        backend/src/test/ai-autonomous-mock-integration.test.ts \
        backend/src/test/integration-ai-autonomous-e2e.test.ts
git commit -m "refactor(campaigns): drop unused retellAgentPromptVersion; persist retell fields on create"
```

---

## Task 2: Test that POST `/campaigns` persists retell fields

**Goal:** Lock down the create-handler bug fix from Task 1 with a regression test.

**Files:**
- Create: `backend/src/test/campaigns-create.test.ts`

### Steps

- [ ] **Step 1: Read existing route-test patterns to match style**

```bash
ls backend/src/test/ | grep -i route
sed -n '1,40p' backend/src/test/campaigns-activation.test.ts
```

The repo's preferred pattern for route logic is to test the pure helpers (e.g. `checkAiAutonomousActivation`) directly. For the create handler, we don't have a pure helper. The simplest contract test: assert the schema parses retell fields and the route handler reads them from `req.body`. We do this with a source-level assertion plus a schema parse test.

- [ ] **Step 2: Write the test**

Create `backend/src/test/campaigns-create.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCampaignSchema } from '../lib/validation';

test('createCampaignSchema accepts retellAgentId and retellSipAddress', () => {
    const parsed = createCampaignSchema.parse({
        name: 'Test',
        retellAgentId: 'agent_abc',
        retellSipAddress: 'sip:agent_abc@retell.example',
    });
    assert.equal(parsed.retellAgentId, 'agent_abc');
    assert.equal(parsed.retellSipAddress, 'sip:agent_abc@retell.example');
});

test('createCampaignSchema accepts null retell fields (manual mode)', () => {
    const parsed = createCampaignSchema.parse({
        name: 'Test',
        retellAgentId: null,
        retellSipAddress: null,
    });
    assert.equal(parsed.retellAgentId, null);
    assert.equal(parsed.retellSipAddress, null);
});

test('campaigns POST handler passes retell fields into prisma.campaign.create', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../routes/campaigns.ts'),
        'utf8',
    );
    const postBlock = src.match(/router\.post\('\/'[\s\S]*?res\.status\(201\)\.json\(campaign\)/);
    assert.ok(postBlock, 'POST / handler block found');
    assert.match(postBlock![0], /retellAgentId/);
    assert.match(postBlock![0], /retellSipAddress/);
    assert.match(postBlock![0], /retellAgentId:\s*retellAgentId\s*\?\?\s*null/);
    assert.match(postBlock![0], /retellSipAddress:\s*retellSipAddress\s*\?\?\s*null/);
});
```

- [ ] **Step 3: Run the test to verify it passes**

```bash
cd backend && npm test 2>&1 | grep -E "campaigns-create|✔|✗" | head -10
```

Expected: 3 `✔` lines for the new tests.

- [ ] **Step 4: Run full test suite**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: `ℹ tests 202` (199 + 3); `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/test/campaigns-create.test.ts
git commit -m "test(campaigns): assert createCampaignSchema + POST handler persist retell fields"
```

---

## Task 3: `GET /api/retell/agents` proxy

**Goal:** New backend endpoint that lists Retell agents, used by the frontend campaign form.

**Files:**
- Create: `backend/src/services/retell-agents-service.ts`
- Create: `backend/src/test/retell-agents-service.test.ts`
- Create: `backend/src/routes/retell-agents.ts`
- Create: `backend/src/test/retell-agents-route.test.ts`
- Modify: `backend/src/index.ts`

### Background

Retell's list-agents API: `GET https://api.retellai.com/list-agents` with `Authorization: Bearer ${RETELL_API_KEY}`. Response is an array of agent objects. The fields we care about per agent: `agent_id` (string), `agent_name` (string, nullable), and the SIP URI which Retell exposes via the agent endpoint settings — for the standard SIP integration the URI follows the format `sip:${agent_id}@5t4n6j0wnrl.sip.livekit.cloud` (host configured per Retell account). The actual response field name varies by API version.

To keep the plan robust to Retell schema drift, the service maps the response defensively: extract `agent_id`, prefer `agent_name` falling back to the id, and read SIP from any of `sip_uri`, `sip_address`, `voice_phone_number_sip_uri`, or build the canonical URI as `sip:${agent_id}@${process.env.RETELL_SIP_HOST}` if present. The mapping function is exported so the test can drive it.

### Steps

- [ ] **Step 1: Read `config.ts` to confirm env shape**

```bash
sed -n '30,40p' backend/src/config.ts
```

Confirms `config.retell.apiKey` and `config.retell.baseUrl`.

- [ ] **Step 2: Write the service test first**

Create `backend/src/test/retell-agents-service.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRetellAgents, mapAgentResponse } from '../services/retell-agents-service';

test('mapAgentResponse: extracts id/name/sipAddress from common shapes', () => {
    const mapped = mapAgentResponse({
        agent_id: 'agent_abc',
        agent_name: 'Sales Bot',
        sip_uri: 'sip:agent_abc@retell.sip.livekit.cloud',
    });
    assert.deepEqual(mapped, { id: 'agent_abc', name: 'Sales Bot', sipAddress: 'sip:agent_abc@retell.sip.livekit.cloud' });
});

test('mapAgentResponse: falls back to id when name missing', () => {
    const mapped = mapAgentResponse({
        agent_id: 'agent_abc',
        agent_name: null,
        sip_address: 'sip:agent_abc@host',
    });
    assert.equal(mapped?.name, 'agent_abc');
});

test('mapAgentResponse: returns null when agent_id missing', () => {
    assert.equal(mapAgentResponse({ agent_name: 'X' }), null);
});

test('mapAgentResponse: returns null when no sip variant present', () => {
    assert.equal(mapAgentResponse({ agent_id: 'agent_abc', agent_name: 'X' }), null);
});

test('listRetellAgents: happy path returns mapped list', async () => {
    const mockFetch = async (url: string, init?: any) => {
        assert.equal(url, 'https://api.retellai.com/list-agents');
        assert.equal(init.headers.Authorization, 'Bearer key123');
        return {
            ok: true,
            status: 200,
            json: async () => ([
                { agent_id: 'a1', agent_name: 'Agent 1', sip_uri: 'sip:a1@h' },
                { agent_id: 'a2', agent_name: 'Agent 2', sip_uri: 'sip:a2@h' },
                { agent_id: 'a3', agent_name: null }, // dropped: no sip
            ]),
        } as any;
    };
    const result = await listRetellAgents({
        fetchImpl: mockFetch as any,
        apiKey: 'key123',
        baseUrl: 'https://api.retellai.com',
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a1');
    assert.equal(result[1].id, 'a2');
});

test('listRetellAgents: throws ConfigError when apiKey empty', async () => {
    await assert.rejects(
        () => listRetellAgents({ fetchImpl: (async () => { throw new Error('should not be called'); }) as any, apiKey: '', baseUrl: 'https://api.retellai.com' }),
        /RETELL_API_KEY not configured/,
    );
});

test('listRetellAgents: throws UpstreamError on 5xx', async () => {
    const mockFetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' } as any);
    await assert.rejects(
        () => listRetellAgents({ fetchImpl: mockFetch as any, apiKey: 'k', baseUrl: 'https://api.retellai.com' }),
        /Retell list-agents upstream error: 502/,
    );
});
```

- [ ] **Step 3: Implement the service**

Create `backend/src/services/retell-agents-service.ts`:

```typescript
export interface RetellAgent {
    id: string;
    name: string;
    sipAddress: string;
}

export interface ListAgentsDeps {
    fetchImpl: typeof fetch;
    apiKey: string;
    baseUrl: string;
}

export function mapAgentResponse(raw: any): RetellAgent | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.agent_id === 'string' ? raw.agent_id : null;
    if (!id) return null;
    const name = (typeof raw.agent_name === 'string' && raw.agent_name) ? raw.agent_name : id;
    const sipAddress =
        (typeof raw.sip_uri === 'string' && raw.sip_uri) ||
        (typeof raw.sip_address === 'string' && raw.sip_address) ||
        (typeof raw.voice_phone_number_sip_uri === 'string' && raw.voice_phone_number_sip_uri) ||
        null;
    if (!sipAddress) return null;
    return { id, name, sipAddress };
}

export async function listRetellAgents(deps: ListAgentsDeps): Promise<RetellAgent[]> {
    if (!deps.apiKey) {
        throw new Error('RETELL_API_KEY not configured');
    }
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/list-agents`;
    const res = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${deps.apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Retell list-agents upstream error: ${res.status} ${body}`);
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
        throw new Error('Retell list-agents returned non-array body');
    }
    return json.map(mapAgentResponse).filter((a): a is RetellAgent => a !== null);
}
```

- [ ] **Step 4: Run service tests**

```bash
cd backend && npm test 2>&1 | grep -E "retell-agents-service|✔|✗" | head -15
```

Expected: 7 `✔` lines.

- [ ] **Step 5: Write the route test**

Create `backend/src/test/retell-agents-route.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildRetellAgentsRouter } from '../routes/retell-agents';

function appWith(deps: { listAgents: () => Promise<any> }) {
    const app = express();
    // Bypass auth for tests by mounting a stub authenticator into the route's deps.
    app.use('/api/retell', buildRetellAgentsRouter({
        listAgents: deps.listAgents,
        authenticate: (_req, _res, next) => next(),
    }));
    return app;
}

test('GET /api/retell/agents: 200 with mapped list on success', async () => {
    const app = appWith({
        listAgents: async () => ([{ id: 'a1', name: 'A1', sipAddress: 'sip:a1@h' }]),
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { agents: [{ id: 'a1', name: 'A1', sipAddress: 'sip:a1@h' }] });
});

test('GET /api/retell/agents: 503 with error message when service throws', async () => {
    const app = appWith({
        listAgents: async () => { throw new Error('Retell list-agents upstream error: 502 bad gateway'); },
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /Retell list-agents upstream error: 502/);
});

test('GET /api/retell/agents: 503 with config message when key missing', async () => {
    const app = appWith({
        listAgents: async () => { throw new Error('RETELL_API_KEY not configured'); },
    });
    const res = await request(app).get('/api/retell/agents');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /RETELL_API_KEY not configured/);
});
```

- [ ] **Step 6: Implement the route with DI seam**

Create `backend/src/routes/retell-agents.ts`:

```typescript
import { Router, Request, Response, RequestHandler } from 'express';
import { authenticate as defaultAuthenticate } from '../middleware/auth';
import { listRetellAgents, RetellAgent } from '../services/retell-agents-service';
import { config } from '../config';
import { logger } from '../utils/logger';

interface Deps {
    listAgents?: () => Promise<RetellAgent[]>;
    authenticate?: RequestHandler;
}

export function buildRetellAgentsRouter(deps: Deps = {}): Router {
    const router = Router();
    const auth = deps.authenticate ?? defaultAuthenticate;
    const list = deps.listAgents ?? (() => listRetellAgents({
        fetchImpl: fetch,
        apiKey: config.retell.apiKey,
        baseUrl: config.retell.baseUrl,
    }));

    router.get('/agents', auth, async (_req: Request, res: Response): Promise<void> => {
        try {
            const agents = await list();
            res.json({ agents });
        } catch (err: any) {
            logger.warn('GET /api/retell/agents failed', { error: err?.message });
            res.status(503).json({ error: err?.message || 'Retell agents unavailable' });
        }
    });

    return router;
}

export default buildRetellAgentsRouter();
```

- [ ] **Step 7: Run route tests**

```bash
cd backend && npm test 2>&1 | grep -E "retell-agents-route|✔|✗" | head -10
```

Expected: 3 `✔` lines.

- [ ] **Step 8: Mount the router**

Open `backend/src/index.ts`. Find the section where `campaignRoutes` is mounted (around line 112). Add:

```typescript
import retellAgentsRoutes from './routes/retell-agents';
```

Then near the existing `app.use('/api/campaigns', campaignRoutes);`:

```typescript
app.use('/api/retell', retellAgentsRoutes);
```

(Note: `/retell` without `/api` is already used for Retell's webhook callbacks at line 116 — `app.use('/retell', retellWebhookRoutes);`. Mount the new agents router at `/api/retell` to keep the API surface separate from inbound webhooks.)

- [ ] **Step 9: Build and run full suite**

```bash
cd backend && npm run build && npm test 2>&1 | tail -10
```

Expected: build exit 0; `ℹ tests 212` (202 from Task 2 + 7 service + 3 route); `ℹ fail 0`.

- [ ] **Step 10: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/services/retell-agents-service.ts \
        backend/src/test/retell-agents-service.test.ts \
        backend/src/routes/retell-agents.ts \
        backend/src/test/retell-agents-route.test.ts \
        backend/src/index.ts
git commit -m "feat(retell): GET /api/retell/agents proxy for campaign agent picker"
```

---

## Task 4: CampaignForm — AI Agent dropdown

**Goal:** Operator can pick a Retell agent when `dialMode === 'ai_autonomous'`. Selected `retellAgentId` and `retellSipAddress` flow through create and edit submissions.

**Files:**
- Create: `frontend/src/lib/retellAgents.ts`
- Modify: `frontend/src/components/campaigns/CampaignForm.tsx`
- Modify: `frontend/src/app/dashboard/campaigns/[id]/edit/page.tsx`

### Steps

- [ ] **Step 1: Create the client helper**

Create `frontend/src/lib/retellAgents.ts`:

```typescript
import api from './api';

export interface RetellAgent {
    id: string;
    name: string;
    sipAddress: string;
}

export async function fetchRetellAgents(): Promise<RetellAgent[]> {
    const res = await api.get<{ agents: RetellAgent[] }>('/retell/agents');
    return res.data.agents;
}
```

(`@/lib/api` is the existing axios instance; the base URL already includes `/api`, so `/retell/agents` resolves to `/api/retell/agents`. Verify by grepping `api.ts` if uncertain.)

- [ ] **Step 2: Update `CampaignFormValues`**

Open `frontend/src/components/campaigns/CampaignForm.tsx`. Update the interface and defaults:

```typescript
import { useEffect, useState } from 'react';
import { DialMode, DIAL_MODE_OPTIONS } from '@/lib/dialMode';
import { fetchRetellAgents, RetellAgent } from '@/lib/retellAgents';

export interface CampaignFormValues {
    name: string;
    description: string;
    dialMode: DialMode;
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
    retellAgentId: string | null;
    retellSipAddress: string | null;
}

const DEFAULT_VALUES: CampaignFormValues = {
    name: '',
    description: '',
    dialMode: 'manual',
    timezone: 'America/Chicago',
    maxConcurrentCalls: 0,
    maxAttemptsPerLead: 6,
    retryDelaySeconds: 600,
    retellAgentId: null,
    retellSipAddress: null,
};
```

(Replace the existing interface and `DEFAULT_VALUES` constant. `useState` is already imported; add `useEffect`.)

- [ ] **Step 3: Add the agents-list state and lazy load**

Inside the component body, after the existing `useState` calls:

```typescript
    const [agents, setAgents] = useState<RetellAgent[] | null>(null);
    const [agentsLoading, setAgentsLoading] = useState(false);
    const [agentsError, setAgentsError] = useState<string | null>(null);

    useEffect(() => {
        if (values.dialMode !== 'ai_autonomous') return;
        if (agents !== null || agentsLoading) return;
        setAgentsLoading(true);
        fetchRetellAgents()
            .then(list => {
                setAgents(list);
                setAgentsError(null);
            })
            .catch((err: any) => {
                setAgentsError(err?.response?.data?.error || 'Failed to load Retell agents');
            })
            .finally(() => setAgentsLoading(false));
    }, [values.dialMode, agents, agentsLoading]);
```

- [ ] **Step 4: Update `validate()` to require agent in ai_autonomous**

In the existing `validate()` function, after the existing checks:

```typescript
        if (values.dialMode === 'ai_autonomous' && !values.retellAgentId) {
            errs.retellAgentId = 'Pick a Retell agent';
        }
```

- [ ] **Step 5: Render the AI Agent card**

Insert this JSX between the Concurrency card and the Retry card (after the `{values.dialMode !== 'manual' && (...)}` block, before `{/* RETRY */}`):

```tsx
            {/* AI AGENT — only when dialMode is ai_autonomous */}
            {values.dialMode === 'ai_autonomous' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>AI Agent</div>
                    {agentsLoading && (
                        <div style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>Loading agents from Retell…</div>
                    )}
                    {agentsError && (
                        <div className="notice notice-error" style={{ fontSize: '0.786rem' }}>
                            {agentsError}
                        </div>
                    )}
                    {agents && agents.length === 0 && (
                        <div className="notice notice-error" style={{ fontSize: '0.786rem' }}>
                            No agents found in your Retell account. Create one in the Retell dashboard, then reload this page.
                        </div>
                    )}
                    {agents && agents.length > 0 && (
                        <>
                            <label>Retell Agent</label>
                            <select
                                className="select"
                                value={values.retellAgentId ?? ''}
                                onChange={e => {
                                    const id = e.target.value || null;
                                    const sip = id ? (agents.find(a => a.id === id)?.sipAddress ?? null) : null;
                                    setValues(prev => ({ ...prev, retellAgentId: id, retellSipAddress: sip }));
                                    setFieldErrors(prev => ({ ...prev, retellAgentId: '' }));
                                }}
                            >
                                <option value="">— Select an agent —</option>
                                {agents.map(a => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                            {/* Edit mode: previously assigned agent missing from list */}
                            {values.retellAgentId && !agents.find(a => a.id === values.retellAgentId) && (
                                <div className="notice notice-error" style={{ fontSize: '0.786rem', marginTop: 6 }}>
                                    Previously assigned agent <code>{values.retellAgentId}</code> was not found in your Retell account. Pick a new one.
                                </div>
                            )}
                            {fieldErrors.retellAgentId && (
                                <div style={{ color: 'var(--status-red-text)', fontSize: '0.786rem', marginTop: 4 }}>
                                    {fieldErrors.retellAgentId}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
```

- [ ] **Step 6: Hydrate `retellAgentId` + `retellSipAddress` on the edit page**

Open `frontend/src/app/dashboard/campaigns/[id]/edit/page.tsx`. In the `setInitial` call inside the GET handler:

```typescript
            setInitial({
                name: c.name || '',
                description: c.description || '',
                dialMode: c.dialMode,
                timezone: c.timezone,
                maxConcurrentCalls: c.maxConcurrentCalls,
                maxAttemptsPerLead: c.maxAttemptsPerLead,
                retryDelaySeconds: c.retryDelaySeconds,
                retellAgentId: c.retellAgentId ?? null,
                retellSipAddress: c.retellSipAddress ?? null,
            });
```

(The new page does not need updates — `DEFAULT_VALUES` already covers the null defaults.)

- [ ] **Step 7: Build the frontend**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 8: Manual smoke test (if dev servers available)**

Start backend and frontend, log in as supervisor:

1. New Campaign → set Dial Mode to `AI Autonomous` → confirm "AI Agent" card appears with a loading message, then a populated dropdown.
2. Select an agent → save → confirm campaign POST succeeds and the saved campaign carries `retellAgentId`/`retellSipAddress` (check via `/dashboard/campaigns/<id>` or the API).
3. Try to save with no agent picked → inline error blocks submit.
4. Edit Campaign on an existing AI autonomous campaign → confirm the dropdown pre-selects the saved agent after the list loads.
5. If `RETELL_API_KEY` is missing or the upstream is unreachable, confirm the form shows the error message inline.

If servers aren't available, defer manual verification and note it in the commit message body.

- [ ] **Step 9: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add frontend/src/lib/retellAgents.ts \
        frontend/src/components/campaigns/CampaignForm.tsx \
        frontend/src/app/dashboard/campaigns/[id]/edit/page.tsx
git commit -m "feat(campaigns): per-campaign Retell agent picker in CampaignForm"
```

---

## Task 5: SettingsTab — display assigned AI agent

**Goal:** When viewing an AI autonomous campaign, the Settings tab shows which Retell agent is assigned.

**Files:**
- Modify: `frontend/src/components/campaigns/tabs/SettingsTab.tsx`
- Modify: `frontend/src/app/dashboard/campaigns/[id]/page.tsx` (only if `retellAgentId` isn't already on the `Campaign` object passed to SettingsTab)

### Steps

- [ ] **Step 1: Confirm the campaign object reaches SettingsTab with `retellAgentId`**

```bash
sed -n '1,80p' frontend/src/app/dashboard/campaigns/[id]/page.tsx
grep -n "retellAgentId" frontend/src/app/dashboard/campaigns/[id]/page.tsx
```

If `retellAgentId` is not on the page's `Campaign` interface or in the GET response shape, add it. The backend GET returns the full row, so the only change needed is typing.

- [ ] **Step 2: Update SettingsTab**

Open `frontend/src/components/campaigns/tabs/SettingsTab.tsx`. Replace the file body with:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDialMode } from '@/lib/dialMode';
import { fetchRetellAgents, RetellAgent } from '@/lib/retellAgents';

interface Campaign {
    id: string;
    name: string;
    description: string | null;
    dialMode: string;
    timezone: string;
    maxConcurrentCalls: number;
    maxAttemptsPerLead: number;
    retryDelaySeconds: number;
    retellAgentId?: string | null;
}

interface Props {
    campaign: Campaign;
}

const TIMEZONE_LABELS: Record<string, string> = {
    'America/New_York': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Los_Angeles': 'Pacific',
};

function formatRetry(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')} hours`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ fontSize: '0.786rem', color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: '0.857rem', fontWeight: 500 }}>{value}</span>
        </div>
    );
}

export function SettingsTab({ campaign }: Props) {
    const router = useRouter();
    const [agents, setAgents] = useState<RetellAgent[] | null>(null);

    useEffect(() => {
        if (campaign.dialMode !== 'ai_autonomous') return;
        fetchRetellAgents().then(setAgents).catch(() => setAgents([]));
    }, [campaign.dialMode]);

    const assignedAgent =
        campaign.dialMode === 'ai_autonomous' && campaign.retellAgentId
            ? (agents?.find(a => a.id === campaign.retellAgentId) ?? null)
            : null;

    const agentLabel: React.ReactNode = (() => {
        if (campaign.dialMode !== 'ai_autonomous') return null;
        if (!campaign.retellAgentId) return <span style={{ color: 'var(--status-red-text)' }}>Not assigned</span>;
        if (agents === null) return 'Loading…';
        if (assignedAgent) return assignedAgent.name;
        return <code>{campaign.retellAgentId}</code>;
    })();

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={() => router.push(`/dashboard/campaigns/${campaign.id}/edit`)}>
                    Edit
                </button>
            </div>

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Basics</div>
                <Row label="Name" value={campaign.name} />
                <Row label="Description" value={campaign.description || '—'} />
                <Row label="Dial Mode" value={formatDialMode(campaign.dialMode)} />
                <Row label="Timezone" value={TIMEZONE_LABELS[campaign.timezone] || campaign.timezone} />
            </div>

            {campaign.dialMode === 'ai_autonomous' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>AI Agent</div>
                    <Row label="Assigned Agent" value={agentLabel} />
                </div>
            )}

            {campaign.dialMode !== 'manual' && (
                <div className="card">
                    <div className="section-label" style={{ marginBottom: 10 }}>Concurrency</div>
                    <Row label="Max Concurrent Calls" value={campaign.maxConcurrentCalls === 0 ? 'Auto (use available agents)' : campaign.maxConcurrentCalls} />
                </div>
            )}

            <div className="card">
                <div className="section-label" style={{ marginBottom: 10 }}>Retry Strategy</div>
                <Row label="Max Attempts Per Lead" value={campaign.maxAttemptsPerLead} />
                <Row label="Retry Delay" value={formatRetry(campaign.retryDelaySeconds)} />
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Add `retellAgentId` to the parent page's Campaign type if missing**

If Step 1 found that the `Campaign` interface in `frontend/src/app/dashboard/campaigns/[id]/page.tsx` doesn't include `retellAgentId`, add it as `retellAgentId?: string | null;`. The GET response already carries the field; this is a typing-only change.

- [ ] **Step 4: Build the frontend**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 5: Manual smoke test (if dev servers available)**

Open the campaign detail page for an `ai_autonomous` campaign with an assigned agent. Verify:
- "AI Agent" card appears.
- "Assigned Agent" row shows "Loading…" briefly, then the agent's name.
- For a campaign without an assignment, it shows "Not assigned" in red.
- For a `manual` or `progressive` campaign, the card doesn't render.

If servers aren't available, defer and note in commit message.

- [ ] **Step 6: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add frontend/src/components/campaigns/tabs/SettingsTab.tsx \
        frontend/src/app/dashboard/campaigns/[id]/page.tsx
git commit -m "feat(campaigns): show assigned Retell agent on SettingsTab"
```

---

## Final verification

- [ ] **Step 1: Backend build + tests**

```bash
cd backend && npm run build && npm test 2>&1 | tail -10
```

Expected: build exit 0; `ℹ tests 212`; `ℹ fail 0`.

- [ ] **Step 2: Frontend build**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 3: Push**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial && git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Drop `retellAgentPromptVersion` (schema, migration, validation, route, worker, tests) | Task 1 |
| Add retell fields to `createCampaignSchema` and POST handler | Task 1 (Steps 4 + 5b), Task 2 (test) |
| New `GET /api/retell/agents` proxy with auth + 503 failure modes | Task 3 |
| Frontend AI Agent dropdown, edit pre-select, save validation | Task 4 |
| SettingsTab "AI Agent" row with name lookup + fallback | Task 5 |
| Activation guard simplified to two fields | Task 1 (Step 5a) + Task 1 (Step 8 test update) |

All spec sections covered.

**Placeholder scan:** No "TBD" or vague handwaving. Two steps invite environment-specific verification (Task 4 Step 8, Task 5 Step 5) and explicitly say "defer if servers aren't available, note in commit message" — these are real verification steps with a documented fallback.

**Type consistency:**
- `RetellAgent` shape (`{ id, name, sipAddress }`) is identical in `retell-agents-service.ts` (Task 3 Step 3), `retellAgents.ts` (Task 4 Step 1), `CampaignForm.tsx` (Task 4), and `SettingsTab.tsx` (Task 5).
- `CampaignFormValues` adds `retellAgentId: string | null` and `retellSipAddress: string | null` (Task 4 Step 2); the edit page (Task 4 Step 6) hydrates both; the create page already passes `values` through unchanged.
- Activation guard signature in Task 1 Step 5a (`{ dialMode, status, retellAgentId, retellSipAddress }`) matches the test fixtures in Task 1 Step 8.

**Test count math:**
- Baseline: 199 (current).
- Task 1: same tests, fixtures updated. Net +0 → 199.
- Task 2: +3 → 202.
- Task 3: +7 service +3 route → 212.
- Tasks 4, 5: frontend, no harness, +0.
- Final: `ℹ tests 212`.

**Risk notes (already in spec, restated for the implementer):**
- The `retellSipAddress` SIP host depends on the Retell account; the service's `mapAgentResponse` falls back across three field names. If Retell's response shape doesn't include any of them, agents will be silently dropped from the list — surface this by reading the upstream payload in dev once before merging.
- Dropping the prompt-version column is irreversible. Verified by the spec; mentioned here because the migration is the only step in the plan that can't be reverted by a code revert.
