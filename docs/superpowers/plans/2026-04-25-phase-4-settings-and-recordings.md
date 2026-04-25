# Phase 4 — Settings Page & Recording Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/dashboard/settings` UI for `ai_overflow_number`, wire `<CallRecordingPlayer>` into AttemptsTab + Reports rows, and make SignalWire's bridge recording canonical (Retell stops overwriting `Call.recordingUrl`).

**Architecture:** Three small, independent changes. Backend tasks come first because the frontend depends on the `/attempts` projection change. Each backend task uses TDD; frontend tasks have no automated harness so verification is `npm run build` plus manual inspection.

**Tech Stack:** Backend: TypeScript, Prisma, Express, node:test, supertest. Frontend: Next.js 14 App Router (client components), no test harness.

---

## Spec reference

`docs/superpowers/specs/2026-04-25-phase-4-settings-and-recordings-design.md`

## Implementation order rationale

1. **Task 1 (recording dedup)** — backend-only, blocks nothing else; ship first to fix latent bug.
2. **Task 2 (`/attempts` projection)** — frontend Task 4 reads `recordingUrl` from this endpoint; must land first.
3. **Task 3 (Settings page)** — frontend; independent.
4. **Task 4 (Recording playback wire-up)** — frontend; depends on Task 2.

---

## File Map

| Path | Status | Responsibility |
|---|---|---|
| `backend/src/services/call-session-service.ts` | **Modify** | Add `updateCallRecordingUrl` flag to `RecordingInput`; default true |
| `backend/src/routes/retell-webhooks.ts` | **Modify** | Pass `updateCallRecordingUrl: false` when calling `addRecording` |
| `backend/src/test/call-session-service-recording.test.ts` | **Create** | New tests for the flag behavior |
| `backend/src/routes/campaigns.ts` | **Modify** | Add `recordingUrl` to `/attempts` `call` projection (line 483) |
| `backend/src/test/campaigns-attempts.test.ts` | **Create** | New test asserting `recordingUrl` in the projection |
| `frontend/src/app/dashboard/settings/page.tsx` | **Create** | Settings page (admin-gated) |
| `frontend/src/components/campaigns/tabs/AttemptsTab.tsx` | **Modify** | Add expandable recording row |
| `frontend/src/app/dashboard/reports/page.tsx` | **Modify** | Add expandable recording row in calls table |

---

## Task 1: De-duplicate AI Autonomous recordings

**Goal:** SignalWire's bridge recording stays canonical for `Call.recordingUrl`. Retell still creates `CallRecording` rows (needed for transcript linking) but does NOT overwrite the `Call.recordingUrl` field.

**Files:**
- Modify: `backend/src/services/call-session-service.ts:276-322`
- Modify: `backend/src/routes/retell-webhooks.ts:127-145` (the `addRecording` call site)
- Create: `backend/src/test/call-session-service-recording.test.ts`

### Background context

`callSessionService.addRecording` is shared by both signalwire-events (`/signalwire/events/recording`) and retell-webhooks. Today both providers cause the call's `recordingUrl` field to be overwritten — last-writer wins. Adding a per-call flag that defaults to `true` (preserving current SignalWire behavior) and is explicitly set to `false` from the Retell call site makes SignalWire's bridge recording authoritative without disrupting the Retell `CallRecording` row creation.

### Steps

- [ ] **Step 1: Read current `RecordingInput` type and `addRecording` body**

```bash
sed -n '1,50p' backend/src/services/call-session-service.ts
sed -n '270,325p' backend/src/services/call-session-service.ts
```

Locate the `RecordingInput` interface definition (search for `interface RecordingInput`).

- [ ] **Step 2: Write the failing test**

Create `backend/src/test/call-session-service-recording.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildCallSessionService } from '../services/call-session-service';

// Minimal in-memory mock of the prisma surface addRecording uses.
function makeMockPrisma() {
    const callRecordings: any[] = [];
    const callUpdates: Array<{ id: string; data: any }> = [];
    const callSessions = new Map<string, { id: string; callId: string | null }>();
    callSessions.set('sess-1', { id: 'sess-1', callId: 'call-1' });

    const prismaLike = {
        callSession: {
            findFirst: async () => callSessions.get('sess-1') || null,
            create: async ({ data }: any) => { const s = { id: 'sess-new', ...data }; callSessions.set(s.id, s); return s; },
            update: async ({ where, data }: any) => ({ id: where.id, ...data }),
        },
        callRecording: {
            findFirst: async () => null,
            create: async ({ data }: any) => { const rec = { id: `rec-${callRecordings.length}`, ...data }; callRecordings.push(rec); return rec; },
            update: async ({ where, data }: any) => { const idx = callRecordings.findIndex(r => r.id === where.id); callRecordings[idx] = { ...callRecordings[idx], ...data }; return callRecordings[idx]; },
        },
        call: {
            update: async ({ where, data }: any) => { callUpdates.push({ id: where.id, data }); return { id: where.id, ...data }; },
        },
    };

    return { prismaLike, callRecordings, callUpdates };
}

test('addRecording: default behavior writes Call.recordingUrl', async () => {
    const { prismaLike, callUpdates } = makeMockPrisma();
    const svc = buildCallSessionService({ prisma: prismaLike as any });

    await svc.addRecording({
        provider: 'signalwire',
        providerCallId: 'pcid-1',
        callId: 'call-1',
        url: 'https://signalwire.example/rec.mp3',
        status: 'available',
    });

    assert.equal(callUpdates.length, 1, 'Call.recordingUrl updated by default');
    assert.equal(callUpdates[0].data.recordingUrl, 'https://signalwire.example/rec.mp3');
});

test('addRecording: updateCallRecordingUrl=false skips Call.recordingUrl write', async () => {
    const { prismaLike, callRecordings, callUpdates } = makeMockPrisma();
    const svc = buildCallSessionService({ prisma: prismaLike as any });

    await svc.addRecording({
        provider: 'retell',
        providerCallId: 'pcid-2',
        callId: 'call-1',
        url: 'https://retell.example/rec.mp3',
        status: 'available',
        updateCallRecordingUrl: false,
    });

    assert.equal(callUpdates.length, 0, 'Call.recordingUrl NOT updated when flag is false');
    assert.equal(callRecordings.length, 1, 'CallRecording row still created');
    assert.equal(callRecordings[0].url, 'https://retell.example/rec.mp3');
});
```

**Note on architecture:** `callSessionService` currently exports a singleton bound to the real prisma client (line ~330ish: `export const callSessionService = new CallSessionService();`). For these tests to work without a live DB, the service needs a minimal DI seam. If `buildCallSessionService` does not exist as a factory, **add it** in Step 3 below as part of the implementation; export the singleton as `callSessionService = buildCallSessionService({ prisma })`.

- [ ] **Step 3: Inspect existing service to decide DI shape**

```bash
grep -n "export\|class CallSessionService\|new CallSessionService\|callSessionService" backend/src/services/call-session-service.ts | head -20
```

Two cases:

**Case A** — service is a `class CallSessionService` instantiated as `export const callSessionService = new CallSessionService()`:
- Convert constructor to accept an optional `{ prisma }` dep, defaulting to the real `prisma` import.
- Add `export function buildCallSessionService(deps?: { prisma?: PrismaLike }): CallSessionService` that wraps `new CallSessionService(deps)`.

**Case B** — service is already a factory or accepts deps:
- Just add the `updateCallRecordingUrl` flag.

- [ ] **Step 4: Add the flag to `RecordingInput` and gate the Call update**

Find the `RecordingInput` interface in `call-session-service.ts` (likely near the top with other input interfaces). Add the flag:

```typescript
export interface RecordingInput {
    // ... existing fields ...
    /** When true (default), updates Call.recordingUrl after creating the CallRecording row.
     *  Set false on duplicate-source providers (e.g. Retell) where SignalWire is canonical. */
    updateCallRecordingUrl?: boolean;
}
```

Then in `addRecording`, guard the call update at lines 314-319:

```typescript
const shouldUpdateCallRecordingUrl = input.updateCallRecordingUrl !== false;
if (input.callId && shouldUpdateCallRecordingUrl) {
    await prisma.call.update({
        where: { id: input.callId },
        data: { recordingUrl: input.url },
    });
}
```

(The `!== false` form preserves backward-compat: anyone calling without the flag continues to update the call.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npm test 2>&1 | grep -E "addRecording|✔|✗|fail" | head -10
```

Expected: 2 `✔` lines for the new tests, `ℹ fail 0` overall.

- [ ] **Step 6: Update `retell-webhooks.ts` to pass the flag**

Open `backend/src/routes/retell-webhooks.ts` and find the `addRecording` call (~line 127). Change:

```typescript
await callSessionService.addRecording({
    provider: 'retell',
    providerCallId,
    callId,
    providerRecordingId: readString(payload.recording_id),
    url: recordingUrl,
    status: 'available',
    metadata: payload,
});
```

to:

```typescript
await callSessionService.addRecording({
    provider: 'retell',
    providerCallId,
    callId,
    providerRecordingId: readString(payload.recording_id),
    url: recordingUrl,
    status: 'available',
    metadata: payload,
    updateCallRecordingUrl: false,
});
```

- [ ] **Step 7: Build**

```bash
cd backend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 8: Run full test suite**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: `ℹ tests 198` (was 196, +2). `ℹ fail 0`.

- [ ] **Step 9: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/services/call-session-service.ts \
        backend/src/routes/retell-webhooks.ts \
        backend/src/test/call-session-service-recording.test.ts
git commit -m "fix(recording): SignalWire bridge recording is canonical; Retell no longer overwrites Call.recordingUrl"
```

---

## Task 2: Add `recordingUrl` to `/attempts` projection

**Goal:** Frontend AttemptsTab needs `attempt.call.recordingUrl` to decide whether to render the play affordance. Currently the route only projects `{ id, duration, status }`.

**Files:**
- Modify: `backend/src/routes/campaigns.ts:483`
- Create: `backend/src/test/campaigns-attempts.test.ts`

### Steps

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/campaigns-attempts.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

// We test the projection shape via a small Express harness that mounts a minimal version of
// the route logic. Rather than mounting the real router (which pulls auth + the real prisma),
// this test asserts the contract by verifying the campaigns.ts source includes recordingUrl
// in the attempts call select.
import * as fs from 'node:fs';
import * as path from 'node:path';

test('campaigns /:id/attempts projection includes call.recordingUrl', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../routes/campaigns.ts'),
        'utf8',
    );
    // Locate the attempts route's call select.
    const attemptsBlock = src.match(/router\.get\('\/:id\/attempts'[\s\S]*?res\.json\(\{ attempts/);
    assert.ok(attemptsBlock, 'attempts route block found');
    const callSelectMatch = attemptsBlock![0].match(/call:\s*\{\s*select:\s*\{([^}]+)\}/);
    assert.ok(callSelectMatch, 'call select object found');
    const fields = callSelectMatch![1];
    assert.match(fields, /\bid:\s*true\b/);
    assert.match(fields, /\bduration:\s*true\b/);
    assert.match(fields, /\bstatus:\s*true\b/);
    assert.match(fields, /\brecordingUrl:\s*true\b/);
});
```

**Why a source-level assertion rather than a live HTTP test:** the existing test suite has no Prisma test harness for this route; mounting it would require mocking `authenticate` middleware and the entire prisma client. A source-level contract test is fast and catches the regression we care about (someone removing `recordingUrl` from the projection).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npm test 2>&1 | grep -E "campaigns-attempts|✔|✗" | head -5
```

Expected: 1 `✗` failure on the `recordingUrl: true` assertion.

- [ ] **Step 3: Update the projection**

Open `backend/src/routes/campaigns.ts` and find line 483:

```typescript
call: { select: { id: true, duration: true, status: true } },
```

Change to:

```typescript
call: { select: { id: true, duration: true, status: true, recordingUrl: true } },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && npm test 2>&1 | grep -E "campaigns-attempts|✔|✗" | head -5
```

Expected: 1 `✔` line for the projection test.

- [ ] **Step 5: Build**

```bash
cd backend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 6: Verify total test count**

```bash
cd backend && npm test 2>&1 | tail -10
```

Expected: `ℹ tests 199` (was 198 after Task 1, +1). `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add backend/src/routes/campaigns.ts backend/src/test/campaigns-attempts.test.ts
git commit -m "feat(campaigns): include recordingUrl in /attempts call projection"
```

---

## Task 3: Settings page

**Goal:** New `/dashboard/settings` page with a single field for `ai_overflow_number`, admin-gated, wired to existing endpoints.

**Files:**
- Create: `frontend/src/app/dashboard/settings/page.tsx`

### Reference patterns to follow

Before writing the new page, **read** `frontend/src/app/dashboard/admin/page.tsx` and `frontend/src/app/dashboard/reports/page.tsx` to match:
- How `useAuth().hasRole('admin')` redirects unauthorized users
- How API errors are surfaced (inline message vs toast — admin uses inline; match it)
- Loading state pattern
- API client usage (`import api from '@/lib/api'`)

### Steps

- [ ] **Step 1: Read patterns**

```bash
sed -n '1,80p' frontend/src/app/dashboard/admin/page.tsx
```

Note the auth gate, loading state, and error-surfacing approach.

- [ ] **Step 2: Create the page**

Create `frontend/src/app/dashboard/settings/page.tsx`:

```typescript
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';

interface SettingResponse {
    value: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

const E164 = /^\+[1-9]\d{1,14}$/;

export default function SettingsPage() {
    const { hasRole, loading: authLoading } = useAuth();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [value, setValue] = useState('');
    const [loaded, setLoaded] = useState<SettingResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading) return;
        if (!hasRole('admin')) {
            router.replace('/dashboard');
            return;
        }
        api.get<SettingResponse>('/settings/ai-overflow-number')
            .then((r) => {
                setLoaded(r.data);
                setValue(r.data.value || '');
            })
            .catch(() => setError('Failed to load setting'))
            .finally(() => setLoading(false));
    }, [authLoading, hasRole, router]);

    const dirty = (loaded?.value || '') !== value;

    const handleSave = useCallback(async () => {
        setError(null);
        setSuccess(null);
        if (!E164.test(value)) {
            setError('Must be a valid E.164 phone number (e.g. +12762128412)');
            return;
        }
        setSaving(true);
        try {
            const r = await api.put<SettingResponse>('/settings/ai-overflow-number', { value });
            setLoaded(r.data);
            setSuccess('Saved');
        } catch (e: any) {
            setError(e?.response?.data?.error || 'Save failed');
        } finally {
            setSaving(false);
        }
    }, [value]);

    if (authLoading || loading) {
        return <div style={{ padding: 'var(--space-lg)' }}>Loading…</div>;
    }

    return (
        <div style={{ padding: 'var(--space-lg)', maxWidth: 640 }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 'var(--space-md)' }}>Settings</h1>

            <div className="card" style={{ padding: 'var(--space-md)' }}>
                <label htmlFor="ai-overflow" className="section-label">AI Overflow Number</label>
                <input
                    id="ai-overflow"
                    className="input"
                    type="text"
                    placeholder="+15551234567"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={saving}
                    style={{ width: '100%', marginTop: 'var(--space-xs)' }}
                />
                <div style={{ fontSize: '0.786rem', color: 'var(--text-secondary)', marginTop: 'var(--space-xs)' }}>
                    E.164 format. Used as the fallback DID when no campaign DID is configured for AI Autonomous calls.
                </div>

                {error && (
                    <div style={{ color: 'var(--danger, #dc2626)', marginTop: 'var(--space-sm)', fontSize: '0.875rem' }}>
                        {error}
                    </div>
                )}
                {success && (
                    <div style={{ color: 'var(--success, #16a34a)', marginTop: 'var(--space-sm)', fontSize: '0.875rem' }}>
                        {success}
                    </div>
                )}

                <div style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    {loaded?.updatedAt && (
                        <span style={{ fontSize: '0.786rem', color: 'var(--text-secondary)' }}>
                            Last updated {new Date(loaded.updatedAt).toLocaleString()}
                            {loaded.updatedBy ? ` by ${loaded.updatedBy}` : ''}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
```

**Note on class names:** the codebase uses utility classes `card`, `input`, `btn btn-primary`, `section-label` — confirm these exist by grepping `frontend/src/app/globals.css` (or the equivalent stylesheet). If a name doesn't match, swap to the correct one before committing.

- [ ] **Step 3: Verify class names exist**

```bash
grep -E "\.(card|input|btn-primary|section-label)\b" frontend/src/app/globals.css 2>/dev/null | head -10
```

If any are missing, find the equivalent in admin or reports pages and substitute.

- [ ] **Step 4: Build the frontend**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 5: Manual smoke test**

Start the dev servers (backend + frontend), log in as admin, navigate to `/dashboard/settings`. Verify:
- The current `ai_overflow_number` (if any) loads in the input.
- Editing and saving with a valid E.164 succeeds and updates the "Last updated" line.
- Invalid input (e.g. `12762128412` without `+`) shows the error inline.
- Logging in as a non-admin and visiting `/dashboard/settings` redirects to `/dashboard`.

If servers are not available in the implementation environment, document this as "manual verification deferred to next dev session" in the commit message body.

- [ ] **Step 6: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add frontend/src/app/dashboard/settings/page.tsx
git commit -m "feat(settings): admin page for ai_overflow_number"
```

---

## Task 4: Recording playback in AttemptsTab and Reports

**Goal:** Both the AttemptsTab (per-campaign attempts list) and Reports page (cross-campaign call list) get a per-row "▶ Play recording" link that lazy-renders `<CallRecordingPlayer>` on click.

**Files:**
- Modify: `frontend/src/components/campaigns/tabs/AttemptsTab.tsx`
- Modify: `frontend/src/app/dashboard/reports/page.tsx`

### Reused component

`frontend/src/components/CallRecordingPlayer.tsx` — already exports default. No changes needed there.

### Steps for AttemptsTab

- [ ] **Step 1: Read the current AttemptsTab implementation**

```bash
cat frontend/src/components/campaigns/tabs/AttemptsTab.tsx
```

- [ ] **Step 2: Update the `Attempt` interface to include `recordingUrl`**

Find the `Attempt` interface (around line 5-13). Update the `call` field:

```typescript
call?: { id: string; duration: number; status: string; recordingUrl?: string | null } | null;
```

- [ ] **Step 3: Add expand-row state and import the player**

At the top of the file:

```typescript
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import CallRecordingPlayer from '@/components/CallRecordingPlayer';
```

In the component body, add:

```typescript
const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(null);
```

- [ ] **Step 4: Render the play affordance and conditional player**

Find where each attempt row is rendered (look for the row JSX inside the `attempts.map(...)`). At the end of each row's content, add:

```tsx
{a.call?.recordingUrl ? (
    <button
        type="button"
        className="link-button"
        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: '0.786rem' }}
        onClick={() => setExpandedAttemptId(expandedAttemptId === a.id ? null : a.id)}
    >
        {expandedAttemptId === a.id ? '▼ Hide recording' : '▶ Play recording'}
    </button>
) : null}
{expandedAttemptId === a.id && a.call?.recordingUrl ? (
    <div style={{ marginTop: 'var(--space-sm)' }}>
        <CallRecordingPlayer recordingUrl={a.call.recordingUrl} duration={a.call.duration} />
    </div>
) : null}
```

**Where exactly to place this:** After the existing outcome badge / status display and before the row's closing tag. If the row is a `<tr>` cell-based layout, place the affordance in a new `<td>` and render the expanded player as a follow-up `<tr>` with `colSpan` matching the table's column count. Inspect the existing JSX to decide which pattern fits.

- [ ] **Step 5: Build**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

### Steps for Reports page

- [ ] **Step 6: Read the current Reports page calls table**

```bash
sed -n '1,200p' frontend/src/app/dashboard/reports/page.tsx
```

Locate the `CallRecord` interface and the JSX where each call row is rendered.

- [ ] **Step 7: Update `CallRecord` interface**

Find the `CallRecord` interface (around line 8). Add:

```typescript
recordingUrl?: string | null;
```

The backend already returns this field (`reports.ts:190`); we just need it typed.

- [ ] **Step 8: Add expand-row state and import the player**

At the top of the file (already has `useState` imported):

```typescript
import CallRecordingPlayer from '@/components/CallRecordingPlayer';
```

In the component body, add:

```typescript
const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
```

- [ ] **Step 9: Render the play affordance and conditional player**

In the calls table row JSX (find where each `CallRecord` is rendered as a row), add the same pattern as AttemptsTab — adapted to the table structure used by Reports. Use `c.id` (or whatever the row's call id variable is named) instead of `a.id`:

```tsx
{c.recordingUrl ? (
    <button
        type="button"
        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: '0.786rem' }}
        onClick={() => setExpandedCallId(expandedCallId === c.id ? null : c.id)}
    >
        {expandedCallId === c.id ? '▼ Hide' : '▶ Play'}
    </button>
) : null}
```

Render the expanded player either inline next to the row or as a follow-up row matching the table's structure. If Reports uses a `<table>`, prefer a follow-up `<tr><td colSpan={N}>` row.

- [ ] **Step 10: Build**

```bash
cd frontend && npm run build; echo "EXIT: $?"
```

Expected: `EXIT: 0`.

- [ ] **Step 11: Manual smoke test**

If dev servers are available:
- Open a campaign with completed attempts that have recordings (or use test data). Verify the "▶ Play recording" link appears only for rows with a `recordingUrl`. Click — the player loads and the audio plays. Click again — collapses.
- Open the Reports page. Same behavior.
- Verify lazy-load: open Network tab, confirm no recording GETs fire on initial page load; they only fire on expand.

If servers aren't available, defer manual verification and note it in the commit message.

- [ ] **Step 12: Commit**

```bash
cd /home/lite_ortfolio_gmt/projects/EliteDial2.0/EliteDial
git add frontend/src/components/campaigns/tabs/AttemptsTab.tsx \
        frontend/src/app/dashboard/reports/page.tsx
git commit -m "feat(recordings): inline playback in AttemptsTab and Reports rows"
```

---

## Final verification

- [ ] **Step 1: Backend build + tests**

```bash
cd backend && npm run build && npm test 2>&1 | tail -10
```

Expected: backend exit 0, `ℹ tests 199` (or higher if other commits land), `ℹ fail 0`.

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
| Settings page (Section 1) | Task 3 |
| Recording playback in AttemptsTab (Section 2) | Task 2 (backend projection) + Task 4 (frontend) |
| Recording playback in Reports (Section 2) | Task 4 |
| AI recording dedup (Section 3) | Task 1 |

All four spec sections are covered.

**Placeholder scan:** No "TBD" or vague handwaving. Two notes use deliberate "verify" language (Step 3 of Task 1 inspects pre-existing code shape; Step 5 of Task 3 confirms CSS classes exist) — these are real verification steps, not placeholders.

**Type consistency:**
- `RecordingInput.updateCallRecordingUrl` (Task 1) — referenced consistently in Steps 4 and 6.
- `Attempt.call.recordingUrl` (Task 4 Step 2) matches the backend projection added in Task 2 Step 3.
- `CallRecord.recordingUrl` (Task 4 Step 7) matches the existing reports.ts:190 projection.

**Test count math:**
- Baseline (after Phase 3): 196.
- After Task 1: +2 → 198.
- After Task 2: +1 → 199.
- After Tasks 3-4: +0 (frontend only, no harness).
- Final: `ℹ tests 199`.

**Risk notes:**
- Task 1 Step 3 acknowledges that `call-session-service.ts` may not currently use the DI pattern the test assumes; the step explicitly calls out adding `buildCallSessionService` if needed.
- Task 4 Steps 4 and 9 acknowledge that exact JSX placement depends on the existing table/list shape; the step provides both inline and `<tr colSpan>` patterns.
