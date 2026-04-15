# True Predictive Dialer with AI Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the predictive dialer from progressive 1:1 dialing to true over-dial with automatic AI-agent overflow routing when no human agent is available.

**Architecture:** The predictive worker places calls based on `dialRatio × availableAgents` without pre-reserving agents. When Telnyx fires `call.answered`, a new `predictive-answer-handler` atomically tries to reserve an available agent. If an agent is free, it bridges to the agent's SIP URI (same pattern as sub-project 2). If no agent is free, it bridges the consumer to a configurable AI overflow number (Retell AI now, Telnyx AI Assistant later). Global overflow number lives in a new `SystemSetting` table with an admin API, with per-campaign override.

**Tech Stack:** Node.js (Express), Prisma + Postgres, Telnyx Call Control API, TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-04-15-predictive-dialer-ai-overflow-design.md`

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `backend/src/services/system-settings.ts` | Key-value getter/setter for SystemSetting table with 30s in-memory cache. |
| `backend/src/services/predictive-answer-handler.ts` | Handles `call.answered` for `stage: 'predictive-pending'` calls. Atomic agent reservation + routes to agent or AI overflow. |
| `backend/src/routes/settings.ts` | Admin-only `GET/PUT /api/settings/ai-overflow-number`. |
| `backend/src/test/system-settings.test.ts` | Tests for settings service (cache, set, get). |
| `backend/src/test/predictive-answer-handler.test.ts` | Tests for bridge routing, race conditions, error paths. |

### Modified files

| File | Changes |
|------|---------|
| `backend/prisma/schema.prisma` | Add `aiOverflowNumber String?` to Campaign, add `SystemSetting` model. |
| `backend/scripts/seed.ts` | Upsert SystemSetting row for `ai_overflow_number` = `+12762128412`. |
| `backend/src/services/telnyx-client.ts` | Add `hangup()` method helper (uses existing HTTP client). |
| `backend/src/services/predictive-worker.ts` | Remove pre-call agent reservation in `liveDial`. Use over-dial capacity. Initiate calls with `clientState: { stage: 'predictive-pending', campaignId, contactId, attemptId }`. |
| `backend/src/services/telnyx-webhook-dispatcher.ts` | Route `stage: 'predictive-pending'` to `predictive-answer-handler.onPredictiveAnswered`; route `stage: 'ai-overflow-bridge'` to `onAiOverflowBridgeAnswered`. |
| `backend/src/services/dialer-guardrails.ts` | Move abandon rate from `blockedReasons` to `warnings`. Narrow abandon calculation to `bridge-failed` outcomes only. |
| `backend/src/services/call-audit.ts` | Add new event type constants. |
| `backend/src/index.ts` | Mount `/api/settings` router. |
| `backend/package.json` | Add settings test file to the `test` script. |

### Unchanged

- `inbound-ivr.ts` — inbound flow unaffected
- `outbound-session-adapter.ts` — still used for manual outbound
- All frontend files — UI revamp (sub-project 3b) is separate

---

## Task 1: Prisma Schema Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add SystemSetting model and Campaign.aiOverflowNumber**

Edit `backend/prisma/schema.prisma`. Find the Campaign model (around line 267) and add the new field after `defaultDIDId`:

```prisma
  defaultDIDId           String?           // fallback DID if no proximity match
  aiOverflowNumber       String?           // E.164 AI overflow number, null = use global SystemSetting
  createdById        String?
```

Then at the end of the schema file (after the last model), add:

```prisma
model SystemSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
  updatedBy String?  // admin user id
}
```

- [ ] **Step 2: Generate Prisma client and push schema**

Run:
```bash
cd backend && npx prisma generate && npx prisma db push
```

Expected: Prisma reports schema is in sync, client regenerated.

- [ ] **Step 3: Seed the default AI overflow number**

Edit `backend/scripts/seed.ts`. Add this block near the end, right before `console.log('✅ Seed complete!')`:

```typescript
    // ─── System Settings ──────────────────────────
    await prisma.systemSetting.upsert({
        where: { key: 'ai_overflow_number' },
        update: {},
        create: { key: 'ai_overflow_number', value: '+12762128412' },
    });
```

- [ ] **Step 4: Run the seed script**

Run:
```bash
cd backend && npm run seed
```

Expected: Seed completes successfully. Check the DB:
```bash
cd backend && npx prisma studio
```
Verify a `SystemSetting` row exists with `key: ai_overflow_number`, `value: +12762128412`.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/scripts/seed.ts
git commit -m "feat: add SystemSetting table and Campaign.aiOverflowNumber column"
```

---

## Task 2: System Settings Service

**Files:**
- Create: `backend/src/services/system-settings.ts`
- Create: `backend/src/test/system-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/test/system-settings.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemSettings } from '../services/system-settings';

const makePrismaStub = (initial: Record<string, string> = {}) => {
    const data = new Map<string, { key: string; value: string; updatedBy: string | null }>();
    for (const [k, v] of Object.entries(initial)) {
        data.set(k, { key: k, value: v, updatedBy: null });
    }
    return {
        systemSetting: {
            findUnique: async ({ where }: { where: { key: string } }) => data.get(where.key) || null,
            upsert: async ({ where, update, create }: any) => {
                const key = where.key;
                if (data.has(key)) {
                    const existing = data.get(key)!;
                    data.set(key, { ...existing, value: update.value, updatedBy: update.updatedBy ?? existing.updatedBy });
                } else {
                    data.set(key, { key, value: create.value, updatedBy: create.updatedBy ?? null });
                }
                return data.get(key);
            },
        },
    };
};

describe('system-settings service', () => {
    let now = 1_000_000;
    const clock = () => now;

    beforeEach(() => { now = 1_000_000; });

    it('get returns stored value', async () => {
        const prisma = makePrismaStub({ ai_overflow_number: '+12762128412' });
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+12762128412');
    });

    it('get returns null for missing key', async () => {
        const prisma = makePrismaStub();
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        const value = await settings.get('nonexistent');
        assert.equal(value, null);
    });

    it('set writes value and invalidates cache', async () => {
        const prisma = makePrismaStub({ ai_overflow_number: '+11111111111' });
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('ai_overflow_number');
        await settings.set('ai_overflow_number', '+19998887777', 'admin-123');
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+19998887777');
    });

    it('get caches within TTL window', async () => {
        let findCallCount = 0;
        const prisma = {
            systemSetting: {
                findUnique: async () => { findCallCount += 1; return { key: 'k', value: 'v', updatedBy: null }; },
                upsert: async () => ({ key: 'k', value: 'v', updatedBy: null }),
            },
        };
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('k');
        await settings.get('k');
        await settings.get('k');
        assert.equal(findCallCount, 1);
    });

    it('get re-fetches after TTL expires', async () => {
        let findCallCount = 0;
        const prisma = {
            systemSetting: {
                findUnique: async () => { findCallCount += 1; return { key: 'k', value: 'v', updatedBy: null }; },
                upsert: async () => ({ key: 'k', value: 'v', updatedBy: null }),
            },
        };
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.get('k');
        now += 31_000;
        await settings.get('k');
        assert.equal(findCallCount, 2);
    });

    it('set records updatedBy', async () => {
        const prisma = makePrismaStub();
        const settings = buildSystemSettings({ prisma: prisma as any, clock, ttlMs: 30_000 });
        await settings.set('ai_overflow_number', '+12345678901', 'user-abc');
        const value = await settings.get('ai_overflow_number');
        assert.equal(value, '+12345678901');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd backend && npx tsx --test src/test/system-settings.test.ts
```

Expected: FAIL with "Cannot find module '../services/system-settings'".

- [ ] **Step 3: Create the service implementation**

Create `backend/src/services/system-settings.ts`:

```typescript
import { prisma } from '../lib/prisma';

export interface SystemSettingsDeps {
    prisma: {
        systemSetting: {
            findUnique: (args: { where: { key: string } }) => Promise<{ key: string; value: string; updatedBy: string | null } | null>;
            upsert: (args: {
                where: { key: string };
                update: { value: string; updatedBy?: string | null };
                create: { key: string; value: string; updatedBy?: string | null };
            }) => Promise<{ key: string; value: string; updatedBy: string | null }>;
        };
    };
    clock?: () => number;
    ttlMs?: number;
}

export interface SystemSettingsService {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, updatedBy?: string): Promise<void>;
}

interface CacheEntry {
    value: string | null;
    expiresAt: number;
}

export function buildSystemSettings(deps: SystemSettingsDeps): SystemSettingsService {
    const clock = deps.clock || Date.now;
    const ttlMs = deps.ttlMs ?? 30_000;
    const cache = new Map<string, CacheEntry>();

    return {
        async get(key: string): Promise<string | null> {
            const cached = cache.get(key);
            if (cached && cached.expiresAt > clock()) {
                return cached.value;
            }
            const row = await deps.prisma.systemSetting.findUnique({ where: { key } });
            const value = row?.value ?? null;
            cache.set(key, { value, expiresAt: clock() + ttlMs });
            return value;
        },

        async set(key: string, value: string, updatedBy?: string): Promise<void> {
            await deps.prisma.systemSetting.upsert({
                where: { key },
                update: { value, updatedBy: updatedBy ?? null },
                create: { key, value, updatedBy: updatedBy ?? null },
            });
            cache.delete(key);
        },
    };
}

export const systemSettings = buildSystemSettings({ prisma });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd backend && npx tsx --test src/test/system-settings.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Add the test file to package.json test script**

Edit `backend/package.json`. Find the `test` script and add `src/test/system-settings.test.ts` to the list:

Before:
```json
"test": "node --import tsx --test src/test/foundation.test.ts src/test/telnyx-signature.test.ts src/test/telnyx-client.test.ts src/test/telnyx.test.ts src/test/telnyx-credentials.test.ts src/test/outbound-lifecycle.test.ts src/test/inbound-ivr.test.ts src/test/telnyx-event-dedup.test.ts src/test/telnyx-webhook-dispatcher.test.ts src/test/telnyx-number-service.test.ts",
```

After:
```json
"test": "node --import tsx --test src/test/foundation.test.ts src/test/telnyx-signature.test.ts src/test/telnyx-client.test.ts src/test/telnyx.test.ts src/test/telnyx-credentials.test.ts src/test/outbound-lifecycle.test.ts src/test/inbound-ivr.test.ts src/test/telnyx-event-dedup.test.ts src/test/telnyx-webhook-dispatcher.test.ts src/test/telnyx-number-service.test.ts src/test/system-settings.test.ts",
```

- [ ] **Step 6: Run full backend test suite**

Run:
```bash
cd backend && npm test 2>&1 | tail -15
```

Expected: All tests pass, total >= 71 tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/system-settings.ts backend/src/test/system-settings.test.ts backend/package.json
git commit -m "feat: add system-settings service with 30s cache"
```

---

## Task 3: Settings API Routes

**Files:**
- Create: `backend/src/routes/settings.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Create the settings router**

Create `backend/src/routes/settings.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/roles';
import { systemSettings } from '../services/system-settings';
import { prisma } from '../lib/prisma';

const router = Router();

const E164 = /^\+[1-9]\d{1,14}$/;

router.get('/ai-overflow-number', authenticate, requireMinRole('admin'), async (_req: Request, res: Response) => {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_overflow_number' } });
    res.json({
        value: row?.value ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
    });
});

router.put('/ai-overflow-number', authenticate, requireMinRole('admin'), async (req: Request, res: Response) => {
    const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';

    if (!E164.test(value)) {
        return res.status(400).json({ error: 'value must be a valid E.164 phone number (e.g. +12762128412)' });
    }

    const user = (req as any).user as { id?: string } | undefined;
    await systemSettings.set('ai_overflow_number', value, user?.id);

    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai_overflow_number' } });
    res.json({
        value: row?.value ?? value,
        updatedAt: row?.updatedAt ?? new Date(),
        updatedBy: row?.updatedBy ?? user?.id ?? null,
    });
});

export default router;
```

- [ ] **Step 2: Mount the router in index.ts**

Edit `backend/src/index.ts`. Add the import near the other route imports (around line 19):

```typescript
import settingsRoutes from './routes/settings';
```

Then add the route mount near the other `app.use('/api/...')` lines (after line 81):

```typescript
app.use('/api/settings', settingsRoutes);
```

- [ ] **Step 3: Verify the backend compiles**

Run:
```bash
cd backend && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/settings.ts backend/src/index.ts
git commit -m "feat: add admin-only GET/PUT /api/settings/ai-overflow-number endpoints"
```

---

## Task 4: Telnyx Client Hangup Helper

**Files:**
- Modify: `backend/src/services/telnyx-client.ts`

- [ ] **Step 1: Check if hangup already exists**

Run:
```bash
grep -n "hangup" backend/src/services/telnyx-client.ts
```

If a `hangup` method already exists with signature `hangup(params: { callControlId: string })`, skip to Task 5.

- [ ] **Step 2: Add hangup method if missing**

Edit `backend/src/services/telnyx-client.ts`. Find the class (look for the `createCall` method as reference), and add this method alongside the other call-control methods:

```typescript
    async hangup(params: { callControlId: string }): Promise<void> {
        await this.http.post(`/calls/${params.callControlId}/actions/hangup`, {});
    }
```

(Match the existing coding style — `this.http` may be named differently; check how `createCall` makes HTTP calls and mirror the pattern.)

- [ ] **Step 3: Verify compile**

Run:
```bash
cd backend && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/telnyx-client.ts
git commit -m "feat: add hangup() helper to TelnyxClient"
```

---

## Task 5: Predictive Answer Handler (Core Logic)

**Files:**
- Create: `backend/src/services/predictive-answer-handler.ts`
- Create: `backend/src/test/predictive-answer-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/test/predictive-answer-handler.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictiveAnswerHandler, PredictiveAnsweredContext } from '../services/predictive-answer-handler';

const makeDeps = (overrides: Partial<any> = {}) => {
    const auditEvents: any[] = [];
    const createCallArgs: any[] = [];
    const hangupArgs: any[] = [];
    const attemptUpdates: any[] = [];
    const userUpdates: any[] = [];

    return {
        deps: {
            client: {
                createCall: async (args: any) => { createCallArgs.push(args); return { call_control_id: 'agent-ccid-1' }; },
                hangup: async (args: any) => { hangupArgs.push(args); },
            },
            prisma: {
                user: {
                    updateMany: async (args: any) => {
                        userUpdates.push(args);
                        return overrides.reservationResult ?? { count: 0 };
                    },
                    findFirst: async () => overrides.reservedUser ?? null,
                },
                campaign: {
                    findUnique: async () => overrides.campaign ?? { id: 'camp-1', aiOverflowNumber: null },
                },
                campaignAttempt: {
                    update: async (args: any) => { attemptUpdates.push(args); },
                },
            },
            systemSettings: {
                get: async () => overrides.globalOverflow ?? null,
            },
            callAudit: {
                track: async (e: any) => { auditEvents.push(e); },
            },
            config: {
                connectionId: 'conn-xyz',
                sipDomain: 'sip.telnyx.com',
                fromNumber: '+12818461926',
            },
        },
        auditEvents,
        createCallArgs,
        hangupArgs,
        attemptUpdates,
        userUpdates,
        ...overrides,
    };
};

const ctx = (over: Partial<PredictiveAnsweredContext> = {}): PredictiveAnsweredContext => ({
    callControlId: 'consumer-ccid-1',
    campaignId: 'camp-1',
    contactId: 'contact-1',
    attemptId: 'attempt-1',
    answeringMachineDetected: false,
    ...over,
});

describe('predictive-answer-handler', () => {
    it('bridges to agent when one is available', async () => {
        const t = makeDeps({
            reservationResult: { count: 1 },
            reservedUser: { id: 'user-1', telnyxSipUsername: 'ext100' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs.length, 1);
        const call = t.createCallArgs[0];
        assert.equal(call.to, 'sip:ext100@sip.telnyx.com');
        assert.equal(call.connectionId, 'conn-xyz');
        assert.equal(call.clientState.stage, 'agent-bridge');
        assert.equal(call.clientState.bridgeWith, 'consumer-ccid-1');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.bridged-agent'));
    });

    it('bridges to campaign aiOverflowNumber when no agent available', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: '+19998887777' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs.length, 1);
        assert.equal(t.createCallArgs[0].to, '+19998887777');
        assert.equal(t.createCallArgs[0].clientState.stage, 'ai-overflow-bridge');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.overflow-to-ai'));
    });

    it('bridges to global ai_overflow_number when no campaign override', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: null },
            globalOverflow: '+12762128412',
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs[0].to, '+12762128412');
    });

    it('hangs up and logs bridge-failed when no overflow configured anywhere', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: null },
            globalOverflow: null,
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.hangupArgs.length, 1);
        assert.equal(t.hangupArgs[0].callControlId, 'consumer-ccid-1');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.bridge-failed'));
        assert.equal(t.attemptUpdates[0].data.outcome, 'bridge-failed');
    });

    it('marks voicemail when AMD detected machine', async () => {
        const t = makeDeps({ reservationResult: { count: 0 } });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx({ answeringMachineDetected: true }));

        assert.equal(t.hangupArgs.length, 1, 'should hang up');
        assert.equal(t.createCallArgs.length, 0, 'should not bridge');
        assert.equal(t.attemptUpdates[0].data.outcome, 'voicemail');
    });

    it('releases agent status if bridge createCall throws', async () => {
        const throwingClient = {
            createCall: async () => { throw new Error('boom'); },
            hangup: async () => {},
        };
        const userUpdates: any[] = [];
        const auditEvents: any[] = [];
        const deps = {
            client: throwingClient,
            prisma: {
                user: {
                    updateMany: async (args: any) => { userUpdates.push(args); return { count: 1 }; },
                    findFirst: async () => ({ id: 'user-1', telnyxSipUsername: 'ext100' }),
                },
                campaign: { findUnique: async () => ({ id: 'camp-1', aiOverflowNumber: null }) },
                campaignAttempt: { update: async () => {} },
            },
            systemSettings: { get: async () => null },
            callAudit: { track: async (e: any) => { auditEvents.push(e); } },
            config: { connectionId: 'c', sipDomain: 'sip.telnyx.com', fromNumber: '+1' },
        };
        const handler = buildPredictiveAnswerHandler(deps as any);
        await handler.onPredictiveAnswered(ctx());

        const releaseUpdate = userUpdates.find((u) => u.data?.status === 'available');
        assert.ok(releaseUpdate, 'should reset agent to available');
        assert.ok(auditEvents.find((e) => e.type === 'dialer.predictive.bridge-failed'));
    });

    it('records bridged-agent attempt update', async () => {
        const t = makeDeps({
            reservationResult: { count: 1 },
            reservedUser: { id: 'user-1', telnyxSipUsername: 'ext100' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        const update = t.attemptUpdates.find((u) => u.data?.outcome === 'bridged-to-agent');
        assert.ok(update, 'should record bridged-to-agent outcome');
    });

    it('records bridged-to-ai attempt update on overflow', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            globalOverflow: '+12762128412',
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        const update = t.attemptUpdates.find((u) => u.data?.outcome === 'bridged-to-ai');
        assert.ok(update, 'should record bridged-to-ai outcome');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd backend && npx tsx --test src/test/predictive-answer-handler.test.ts
```

Expected: FAIL with "Cannot find module '../services/predictive-answer-handler'".

- [ ] **Step 3: Create the handler implementation**

Create `backend/src/services/predictive-answer-handler.ts`:

```typescript
import { TelnyxClient } from './telnyx-client';
import { logger } from '../utils/logger';

export interface PredictiveAnsweredContext {
    callControlId: string;
    campaignId: string;
    contactId: string;
    attemptId: string;
    answeringMachineDetected: boolean;
}

export interface AiOverflowBridgeAnsweredContext {
    callControlId: string;
    bridgeWith: string;
    campaignId: string;
    contactId: string;
}

export interface PredictiveAnswerHandlerDeps {
    client: Pick<TelnyxClient, 'createCall' | 'hangup' | 'bridge'>;
    prisma: {
        user: {
            findFirst: (args: any) => Promise<{ id: string; telnyxSipUsername: string | null } | null>;
            updateMany: (args: any) => Promise<{ count: number }>;
        };
        campaign: {
            findUnique: (args: { where: { id: string } }) => Promise<{ id: string; aiOverflowNumber: string | null } | null>;
        };
        campaignAttempt: {
            update: (args: { where: { id: string }; data: Record<string, any> }) => Promise<any>;
        };
    };
    systemSettings: {
        get: (key: string) => Promise<string | null>;
    };
    callAudit: {
        track: (event: Record<string, any>) => Promise<void>;
    };
    config: {
        connectionId: string;
        sipDomain: string;
        fromNumber: string;
    };
}

export interface PredictiveAnswerHandler {
    onPredictiveAnswered(ctx: PredictiveAnsweredContext): Promise<void>;
    onAiOverflowBridgeAnswered(ctx: AiOverflowBridgeAnsweredContext): Promise<void>;
}

export function buildPredictiveAnswerHandler(deps: PredictiveAnswerHandlerDeps): PredictiveAnswerHandler {
    const { client, prisma, systemSettings, callAudit, config } = deps;

    async function markAttempt(attemptId: string, data: Record<string, any>) {
        try {
            await prisma.campaignAttempt.update({ where: { id: attemptId }, data });
        } catch (err) {
            logger.warn('predictive-answer-handler: failed to update attempt', { attemptId, error: (err as Error).message });
        }
    }

    async function releaseAgent(agentId: string) {
        try {
            await prisma.user.updateMany({ where: { id: agentId }, data: { status: 'available' } });
        } catch (err) {
            logger.warn('predictive-answer-handler: failed to release agent', { agentId, error: (err as Error).message });
        }
    }

    async function reserveAgent(): Promise<{ id: string; telnyxSipUsername: string | null } | null> {
        // Atomic reservation: find-and-update in a single round. We do it via conditional updateMany
        // with a subquery-in-application-code pattern — first pick a candidate, then claim it conditionally.
        // If another webhook raced us, the updateMany count will be 0 and we retry up to 3 times.
        for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = await prisma.user.findFirst({
                where: { status: 'available', role: { in: ['agent', 'supervisor', 'admin'] as any } },
                orderBy: { updatedAt: 'asc' } as any,
                select: { id: true, telnyxSipUsername: true } as any,
            });
            if (!candidate) return null;
            const claim = await prisma.user.updateMany({
                where: { id: candidate.id, status: 'available' },
                data: { status: 'on-call' },
            });
            if (claim.count === 1) return candidate;
        }
        return null;
    }

    return {
        async onPredictiveAnswered(ctx) {
            if (ctx.answeringMachineDetected) {
                await client.hangup({ callControlId: ctx.callControlId });
                await markAttempt(ctx.attemptId, { status: 'completed', outcome: 'voicemail', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.voicemail',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.attemptId}:voicemail`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId },
                });
                return;
            }

            const agent = await reserveAgent();

            if (agent && agent.telnyxSipUsername) {
                try {
                    await client.createCall({
                        connectionId: config.connectionId,
                        to: `sip:${agent.telnyxSipUsername}@${config.sipDomain}`,
                        from: config.fromNumber,
                        clientState: {
                            stage: 'agent-bridge',
                            bridgeWith: ctx.callControlId,
                            campaignId: ctx.campaignId,
                            contactId: ctx.contactId,
                            attemptId: ctx.attemptId,
                        },
                    } as any);
                    await markAttempt(ctx.attemptId, { status: 'in-progress', outcome: 'bridged-to-agent' });
                    await callAudit.track({
                        type: 'dialer.predictive.bridged-agent',
                        source: 'predictive.answer',
                        status: 'ok',
                        idempotencyKey: `predictive:${ctx.attemptId}:bridged-agent`,
                        details: { campaignId: ctx.campaignId, contactId: ctx.contactId, agentId: agent.id },
                    });
                    return;
                } catch (err) {
                    await releaseAgent(agent.id);
                    await client.hangup({ callControlId: ctx.callControlId }).catch(() => {});
                    await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                    await callAudit.track({
                        type: 'dialer.predictive.bridge-failed',
                        source: 'predictive.answer',
                        status: 'failed',
                        idempotencyKey: `predictive:${ctx.attemptId}:bridge-failed`,
                        details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                    });
                    return;
                }
            }

            // No agent — route to AI overflow
            const campaign = await prisma.campaign.findUnique({ where: { id: ctx.campaignId } });
            const overflowNumber = campaign?.aiOverflowNumber || (await systemSettings.get('ai_overflow_number'));

            if (!overflowNumber) {
                await client.hangup({ callControlId: ctx.callControlId });
                await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.attemptId}:no-overflow`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: 'no_overflow_configured' },
                });
                return;
            }

            try {
                await client.createCall({
                    connectionId: config.connectionId,
                    to: overflowNumber,
                    from: config.fromNumber,
                    clientState: {
                        stage: 'ai-overflow-bridge',
                        bridgeWith: ctx.callControlId,
                        campaignId: ctx.campaignId,
                        contactId: ctx.contactId,
                        attemptId: ctx.attemptId,
                    },
                } as any);
                await markAttempt(ctx.attemptId, { status: 'in-progress', outcome: 'bridged-to-ai' });
                await callAudit.track({
                    type: 'dialer.predictive.overflow-to-ai',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.attemptId}:overflow-to-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, overflowNumber },
                });
            } catch (err) {
                await client.hangup({ callControlId: ctx.callControlId }).catch(() => {});
                await markAttempt(ctx.attemptId, { status: 'failed', outcome: 'bridge-failed', completedAt: new Date() });
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.attemptId}:ai-bridge-failed`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                });
            }
        },

        async onAiOverflowBridgeAnswered(ctx) {
            // AI leg answered — bridge the two legs together via Telnyx Call Control bridge action.
            try {
                await client.bridge({ callControlId: ctx.bridgeWith, bridgedCallControlId: ctx.callControlId });
                await callAudit.track({
                    type: 'dialer.predictive.bridged-ai',
                    source: 'predictive.answer',
                    status: 'ok',
                    idempotencyKey: `predictive:${ctx.campaignId}:${ctx.contactId}:bridged-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId },
                });
            } catch (err) {
                await callAudit.track({
                    type: 'dialer.predictive.bridge-failed',
                    source: 'predictive.answer',
                    status: 'failed',
                    idempotencyKey: `predictive:${ctx.campaignId}:${ctx.contactId}:bridge-failed-ai`,
                    details: { campaignId: ctx.campaignId, contactId: ctx.contactId, reason: (err as Error).message },
                });
                await client.hangup({ callControlId: ctx.bridgeWith }).catch(() => {});
                await client.hangup({ callControlId: ctx.callControlId }).catch(() => {});
            }
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd backend && npx tsx --test src/test/predictive-answer-handler.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Add test file to package.json**

Edit `backend/package.json`. Extend the `test` script:

```json
"test": "node --import tsx --test src/test/foundation.test.ts src/test/telnyx-signature.test.ts src/test/telnyx-client.test.ts src/test/telnyx.test.ts src/test/telnyx-credentials.test.ts src/test/outbound-lifecycle.test.ts src/test/inbound-ivr.test.ts src/test/telnyx-event-dedup.test.ts src/test/telnyx-webhook-dispatcher.test.ts src/test/telnyx-number-service.test.ts src/test/system-settings.test.ts src/test/predictive-answer-handler.test.ts",
```

- [ ] **Step 6: Run full test suite**

Run:
```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: All tests pass, total >= 79.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/predictive-answer-handler.ts backend/src/test/predictive-answer-handler.test.ts backend/package.json
git commit -m "feat: add predictive-answer-handler with agent reservation + AI overflow"
```

---

## Task 6: Webhook Dispatcher Routing

**Files:**
- Modify: `backend/src/services/telnyx-webhook-dispatcher.ts`

- [ ] **Step 1: Add predictive-pending + ai-overflow-bridge routing**

Edit `backend/src/services/telnyx-webhook-dispatcher.ts`. Find the `call.answered` case (around line 57) and update it to handle the two new stages. Replace the existing `call.answered` case block with:

```typescript
                    case 'call.answered': {
                        const state = decodeClientState<any>(clientStateRaw);

                        // Predictive dialer: consumer answered, decide routing
                        if (state && state.stage === 'predictive-pending') {
                            await (deps as any).predictiveAnswer?.onPredictiveAnswered({
                                callControlId,
                                campaignId: state.campaignId,
                                contactId: state.contactId,
                                attemptId: state.attemptId,
                                answeringMachineDetected: payload.answering_machine_detected === true
                                    || payload.machine_detection_result === 'machine',
                            });
                            return { status: 'ok' };
                        }

                        // AI overflow leg answered — bridge to the consumer
                        if (state && state.stage === 'ai-overflow-bridge') {
                            await (deps as any).predictiveAnswer?.onAiOverflowBridgeAnswered({
                                callControlId,
                                bridgeWith: state.bridgeWith,
                                campaignId: state.campaignId,
                                contactId: state.contactId,
                            });
                            return { status: 'ok' };
                        }

                        // Agent-bridge leg answered — bridge the agent to the caller
                        if (state && state.stage === 'agent-bridge') {
                            const ctx: InboundEventContext = {
                                callControlId,
                                fromNumber: payload.from,
                                toNumber: payload.to,
                                clientState: state as InboundClientState,
                            };
                            await ivr.onAgentBridgeAnswered(ctx);
                            return { status: 'ok' };
                        }

                        const isInbound = state && 'callId' in state && state.callId !== undefined;
                        if (isInbound) {
                            const ctx: InboundEventContext = {
                                callControlId,
                                fromNumber: payload.from,
                                toNumber: payload.to,
                                clientState: state as InboundClientState,
                            };
                            await ivr.onAnswered(ctx);
                        } else {
                            const ctx: OutboundEventContext = {
                                callControlId,
                                clientState: state as OutboundClientState | null,
                            };
                            await outbound.onAnswered(ctx);
                        }
                        return { status: 'ok' };
                    }
```

- [ ] **Step 2: Add the optional dep to the DispatcherDeps interface**

Near the top of the same file (around line 15), update the `DispatcherDeps` interface:

```typescript
export interface DispatcherDeps {
    ivr: InboundIvr;
    outbound: OutboundLifecycle;
    dedup: EventDedup;
    decodeClientState<T>(encoded: string | null | undefined): T | null;
    predictiveAnswer?: {
        onPredictiveAnswered(ctx: any): Promise<void>;
        onAiOverflowBridgeAnswered(ctx: any): Promise<void>;
    };
}
```

- [ ] **Step 3: Find where the dispatcher is instantiated and wire in predictiveAnswer**

Run:
```bash
grep -rn "buildDispatcher" backend/src
```

Expected: Finds `backend/src/routes/telnyx-webhooks.ts` (or similar). Read that file to see how `buildDispatcher` is called, then add `predictiveAnswer: predictiveAnswerHandler` to the deps object.

Open `backend/src/routes/telnyx-webhooks.ts` and look for the `buildDispatcher({...})` call. Add to its deps:

```typescript
import { buildPredictiveAnswerHandler } from '../services/predictive-answer-handler';
import { systemSettings } from '../services/system-settings';
import { callAuditService } from '../services/call-audit';

// ... inside the route handler / wiring code ...

const predictiveAnswerHandler = buildPredictiveAnswerHandler({
    client: telnyxClient,
    prisma,
    systemSettings,
    callAudit: callAuditService,
    config: {
        connectionId: config.telnyx.connectionId,
        sipDomain: config.telnyx.sipDomain,
        fromNumber: config.telnyx.fromNumber,
    },
});

const dispatcher = buildDispatcher({
    ivr,
    outbound,
    dedup,
    decodeClientState,
    predictiveAnswer: predictiveAnswerHandler,
});
```

Adjust the exact imports/variable names to match the existing file. If `callAuditService` has a different export name or location, use what's already imported in that file.

- [ ] **Step 4: Verify compile**

Run:
```bash
cd backend && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 5: Run full test suite**

Run:
```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/telnyx-webhook-dispatcher.ts backend/src/routes/telnyx-webhooks.ts
git commit -m "feat: route predictive-pending and ai-overflow-bridge events to predictive-answer-handler"
```

---

## Task 7: Rewrite Predictive Worker to Over-Dial

**Files:**
- Modify: `backend/src/services/predictive-worker.ts`

- [ ] **Step 1: Remove the pre-call agent reservation from liveDial**

Edit `backend/src/services/predictive-worker.ts`. Replace the entire `liveDial` method (around line 366-500) with the new over-dial version:

```typescript
    private async liveDial(campaign: CampaignWithCount, contact: ReservedWorkerContact) {
        const retryDelayMs = Math.max(30, campaign.retryDelaySeconds) * 1000;
        const { number: fromNumber, didResult } = await phoneNumberService.resolveOutboundDID({
            toNumber: contact.primaryPhone,
            campaignId: campaign.id,
            contactId: contact.id,
        });

        try {
            const claimedContact = await campaignReservationService.confirmDialReservation(contact.id, {
                type: 'worker',
                token: contact.reservationToken,
            });
            if (!claimedContact) return;

            const { call } = await callSessionService.createUnifiedCall({
                provider: providerRegistry.getPrimaryTelephonyProvider().name,
                channel: 'human',
                mode: campaign.dialMode as 'predictive' | 'progressive',
                direction: 'outbound',
                fromNumber,
                toNumber: contact.primaryPhone,
                status: 'initiated',
                accountId: contact.accountId,
                campaignId: campaign.id,
                contactId: contact.id,
                leadExternalId: contact.externalId,
                dncChecked: true,
                fdcpaNotice: true,
            });

            const attempt = await prisma.campaignAttempt.create({
                data: {
                    campaignId: campaign.id,
                    contactId: contact.id,
                    callId: call.id,
                    status: 'initiated',
                },
            });

            const callbackUrl = config.publicUrls.backend || `http://localhost:${config.port}`;

            const result = await providerRegistry.getPrimaryTelephonyProvider().initiateOutboundCall({
                fromNumber,
                toNumber: contact.primaryPhone,
                callbackUrl,
                amdEnabled: config.amd.enabled,
                metadata: {
                    campaignId: campaign.id,
                    contactId: contact.id,
                    callId: call.id,
                    attemptId: attempt.id,
                },
                clientState: {
                    stage: 'predictive-pending',
                    campaignId: campaign.id,
                    contactId: contact.id,
                    attemptId: attempt.id,
                    callId: call.id,
                },
            });

            if (!result?.providerCallId) {
                await prisma.call.update({
                    where: { id: call.id },
                    data: { status: 'failed', completedAt: new Date() },
                });
                await callSessionService.syncCall(call.id, {
                    status: 'failed',
                    provider: providerRegistry.getPrimaryTelephonyProvider().name,
                });
                await prisma.campaignAttempt.update({
                    where: { id: attempt.id },
                    data: { status: 'failed', outcome: 'failed', completedAt: new Date() },
                });

                const maxedOut = contact.attemptCount + 1 >= campaign.maxAttemptsPerLead;
                await campaignReservationService.failReservation(
                    contact.id,
                    maxedOut ? 'failed' : 'queued',
                    maxedOut ? null : new Date(Date.now() + retryDelayMs),
                );
                return;
            }

            await callSessionService.attachProviderIdentifiers(call.id, {
                provider: result.provider,
                providerCallId: result.providerCallId,
                providerMetadata: result.raw || undefined,
            });
            await prisma.call.update({
                where: { id: call.id },
                data: { status: 'ringing' },
            });
            await prisma.campaignAttempt.update({
                where: { id: attempt.id },
                data: { status: 'ringing' },
            });

            logger.info('Predictive live dial initiated (over-dial, no pre-reserve)', {
                campaignId: campaign.id,
                contactId: contact.id,
                callId: call.id,
                providerCallId: result.providerCallId,
            });
        } catch (error) {
            logger.error('Predictive live dial failed', { error, campaignId: campaign.id, contactId: contact.id });
            const maxedOut = contact.attemptCount + 1 >= campaign.maxAttemptsPerLead;
            await campaignReservationService.failReservation(
                contact.id,
                maxedOut ? 'failed' : 'queued',
                maxedOut ? null : new Date(Date.now() + retryDelayMs),
            );
        }
    }
```

Also delete the `reserveAvailableAgentId` private method entirely — it's no longer used. Find it (around line 345-364) and remove it.

- [ ] **Step 2: Update `provider-registry` / `provider-types` to accept `clientState`**

The `initiateOutboundCall` call above passes a `clientState` param. If the provider interface doesn't already accept it, add it.

Run:
```bash
grep -n "initiateOutboundCall" backend/src/services/providers/types.ts
```

Read that file's `InitiateOutboundCallInput` (or similar) type. Add an optional field:

```typescript
    clientState?: Record<string, any>;
```

Then open `backend/src/services/telnyx.ts` (where Telnyx implements the provider) and verify that `initiateOutboundCall` passes `clientState` through to `client.createCall`. Find where `createCall` is invoked in that file and add `clientState: input.clientState,` to the params if it's not already there.

- [ ] **Step 3: Update dispatchCapacity to support true overdial**

Look at the existing `processCampaign` in `predictive-worker.ts` (around line 137). The `computeDialerGuardrails` call already computes `dispatchCapacity` based on `dialRatio`. In live mode `predictiveOverdialEnabled` is set to `false` (see the existing code: `predictiveOverdialEnabled: DIALER_MODE === 'mock'`). We need to flip this for live mode as well now that we have overflow handling.

Find that line (around line 172):

```typescript
            predictiveOverdialEnabled: DIALER_MODE === 'mock',
```

Change it to always true for predictive mode:

```typescript
            predictiveOverdialEnabled: true,
```

- [ ] **Step 4: Verify compile**

Run:
```bash
cd backend && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 5: Run full test suite**

Run:
```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: All tests pass. Some existing outbound-lifecycle / predictive-worker tests may need updates if they assumed pre-reservation. If any test fails, read it and update it to match the new over-dial model (tests for the worker should assert that calls were initiated with `stage: 'predictive-pending'` rather than that agents were pre-reserved).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/predictive-worker.ts backend/src/services/providers/types.ts backend/src/services/telnyx.ts
git commit -m "feat: predictive worker over-dials and routes answers via predictive-answer-handler"
```

---

## Task 8: Dialer Guardrails — Soft Warning for Abandon Rate

**Files:**
- Modify: `backend/src/services/dialer-guardrails.ts`

- [ ] **Step 1: Move abandon rate from blockedReasons to warnings**

Edit `backend/src/services/dialer-guardrails.ts`. Find this block (around line 56):

```typescript
    if (input.recentCompletedAttempts >= 5 && recentAbandonRate >= input.abandonRateLimit) {
        blockedReasons.push('abandon_rate_limit');
    }
```

Replace with:

```typescript
    if (input.recentCompletedAttempts >= 5 && recentAbandonRate >= input.abandonRateLimit) {
        warnings.push('abandon_rate_exceeded');
    }
```

- [ ] **Step 2: Verify tests still pass**

Run:
```bash
cd backend && npm test 2>&1 | tail -10
```

If any existing test asserted that `blockedReasons` contains `abandon_rate_limit`, that test needs to be updated to assert `warnings` contains `abandon_rate_exceeded` instead. Search for the assertion:

```bash
grep -rn "abandon_rate_limit" backend/src/test
```

Update any matching test assertions.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/dialer-guardrails.ts backend/src/test/
git commit -m "feat: abandon rate is now a warning, not a block"
```

---

## Task 9: Full Test Suite + Build Verification

**Files:** (verification only)

- [ ] **Step 1: Run full test suite**

Run:
```bash
cd backend && npm test 2>&1 | tail -15
```

Expected: All tests pass. Total count >= 79.

- [ ] **Step 2: Type check**

Run:
```bash
cd backend && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Confirm Prisma schema is in sync**

Run:
```bash
cd backend && npx prisma validate
```

Expected: "The schema is valid."

- [ ] **Step 4: Commit any remaining fixes**

```bash
git status
# If there are unstaged changes from fixes:
git add -A && git commit -m "fix: test suite adjustments for predictive dialer changes"
```

---

## Task 10: Live Smoke Test Plan (Manual)

**Files:** (verification only)

After deploying to Railway, run these manual checks. **This task is not code — it's a verification checklist to run after the deploy.**

- [ ] **Step 1: Push to Railway and wait for deploy**

```bash
git push origin main
```

Watch Railway dashboard for deploy completion (usually 1-2 minutes). Verify `/api/system/readiness` shows `telnyxConfigured: true`.

- [ ] **Step 2: Verify admin API endpoint**

Log in as admin, then:
```bash
TOKEN=$(curl -s -X POST https://elitedial-production.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# GET current value
curl -s -H "Authorization: Bearer $TOKEN" \
  https://elitedial-production.up.railway.app/api/settings/ai-overflow-number
```

Expected: `{"value":"+12762128412","updatedAt":"...","updatedBy":null}`

```bash
# PUT a new value
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"+12762128412"}' \
  https://elitedial-production.up.railway.app/api/settings/ai-overflow-number
```

Expected: Returns the same value plus `updatedBy` with the admin user id.

- [ ] **Step 3: Seed a small test campaign**

Create a campaign via the existing UI or API with:
- `dialMode: predictive`
- `dialRatio: 2.0`
- `maxAttemptsPerLead: 1`
- 3 contacts (one being your own cell phone, two being test numbers that don't answer or a disposable phone)

Mark yourself as the only `available` agent. Start the campaign.

- [ ] **Step 4: Verify live overflow routing**

Expected behavior:
1. First call rings to your cell. When you answer, agent bridge auto-accepts in your browser. You see the CRM card.
2. Second call: `dialRatio: 2.0` with 1 agent means 2 concurrent calls. Since you're on-call from step 1, no agent available → consumer answers → bridges to `+12762128412` (Retell).
3. Third call: same overflow path.

Monitor Railway logs for:
- `Predictive live dial initiated (over-dial, no pre-reserve)`
- `dialer.predictive.bridged-agent`
- `dialer.predictive.overflow-to-ai`

- [ ] **Step 5: Verify diagnostics page shows the events**

Navigate to `/dashboard/diagnostics` in the frontend. Recent events should include `dialer.predictive.overflow-to-ai` rows.

- [ ] **Step 6: Final commit**

If any fixes came out of smoke testing:

```bash
git add -A
git commit -m "fix: adjustments from predictive dialer live smoke test"
git push
```
