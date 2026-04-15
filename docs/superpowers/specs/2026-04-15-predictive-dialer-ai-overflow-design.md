# True Predictive Dialer with AI Overflow — Design Spec

**Date:** 2026-04-15
**Sub-project:** 3c (backend)
**Sibling:** 3b (Campaigns UI revamp — separate spec, built after this)
**Prerequisite:** Sub-projects 1, 2, 3 complete (Telnyx backend, WebRTC softphone, UI revamp).

---

## Goal

Convert EliteDial from progressive 1:1 dialing to a true predictive dialer that over-dials based on `dialRatio`. When a consumer answers and no agent is available, bridge the consumer to a configurable AI overflow number (Retell AI now, Telnyx AI Assistant later) instead of hanging up on them.

## Problem

The current `predictive-worker.ts` reserves an agent **before** placing the call. This makes it effectively a progressive dialer with a `dialRatio` field that's never used for over-dialing. Consequences:

1. Agents sit idle while the worker places one call at a time per agent
2. No mechanism for over-dial — the schema has `dialRatio` but the code ignores it
3. No fallback when the dial rate spikes and agents are all busy — calls just aren't placed

The fix: over-dial based on `dialRatio`, and when an answered call has no agent available, bridge the consumer to an AI agent that can hold the conversation (or hand back to a human) rather than dropping the call.

## Non-Goals

- Reg F auto-pause at 3% abandon rate — user explicitly wants warning only, not hard block
- Telnyx AI Assistants integration — deferred to sub-project 4
- Campaigns UI changes — separate spec (sub-project 3b)
- TCPA logic changes — existing per-campaign and per-contact timezone checks stay as-is
- Inbound flow — not affected by this change

---

## Data Model Changes

### `Campaign` — new column

```prisma
model Campaign {
  // ... existing fields ...
  aiOverflowNumber String? // E.164 format, per-campaign override. Null → falls back to global SystemSetting.
}
```

### `SystemSetting` — new table

```prisma
model SystemSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
  updatedBy String?  // admin user id
}
```

Seeded default row:
- `key: "ai_overflow_number"`, `value: "+12762128412"`, `updatedBy: null`

### `CampaignAttempt` — new outcome values

Existing `outcome` field is a free-form string. New values used by the predictive answer handler:
- `bridged-to-agent` — consumer answered and was bridged to a live agent
- `bridged-to-ai` — consumer answered and was bridged to AI overflow
- `early-hangup` — consumer answered but hung up before bridge completed (<500ms)
- `bridge-failed` — bridge attempt failed (SIP error, AI DID didn't answer)

Existing outcomes (`human`, `voicemail`, `no-answer`, `failed`) still supported — these come from the mock path and from outcomes where the worker itself handles completion.

---

## Predictive Worker Rewrite

### Current flow (removed)

```
for each campaign:
  availableAgents = count users status='available'
  capacity = guardrails.dispatchCapacity
  for i in 0..capacity:
    reserve contact
    reserve agent (atomic)
    if no agent → release contact, break
    initiate call with agentId → Telnyx
    bridge agent on answer
```

### New flow

```
for each campaign:
  availableAgents = count users status='available'
  overDialCapacity = floor(availableAgents × campaign.dialRatio)
  capacity = min(overDialCapacity, guardrails.dispatchCapacity)
  for i in 0..capacity:
    reserve contact
    initiate call with clientState={ stage: 'predictive-pending', campaignId, contactId, attemptId }
    (no agent reservation, no bridge yet)
```

Calls dispatched with `stage: 'predictive-pending'` tell the webhook dispatcher to route `call.answered` events to the new `predictive-answer-handler` instead of existing handlers.

### Guardrails changes

In `dialer-guardrails.ts`:
- Abandon rate limit moves from `blockedReasons` to `warnings`
- New warning: `abandonRateExceeded` when `recentAbandonRate > abandonRateLimit`
- All other guardrails stay as blockers (concurrent call limit, TCPA window, etc.)

---

## Predictive Answer Handler

New file: `backend/src/services/predictive-answer-handler.ts`

Entry point: `onPredictiveAnswered(event: TelnyxCallAnsweredEvent)`

### Flow

```
1. Parse clientState: { campaignId, contactId, attemptId }
2. Check AMD result in event payload:
   → If 'machine' detected: mark CampaignAttempt outcome='voicemail', hang up, done.
   → Else continue.

3. Atomic agent reservation:
   UPDATE "User" SET status='on-call', updated_at=now()
   WHERE id = (SELECT id FROM "User" WHERE role IN ('agent','supervisor','admin') AND status='available'
               ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING id;

4a. If agentId returned:
    - Get agent's telnyxSipUsername
    - Telnyx client.createCall({
        connectionId: CALL_CONTROL_APP_ID,
        to: 'sip:' + agentSipUsername + '@sip.telnyx.com',
        from: campaign ANI,
        clientState: { stage: 'agent-bridge', bridgeWith: <consumer callControlId>, campaignId, contactId }
      })
    - (Agent browser auto-accepts via pendingDialRef pattern established in sub-project 2)
    - When agent leg answers, existing onAgentBridgeAnswered handler bridges the two legs
    - Update CampaignAttempt: status='in-progress', outcome=null (set on hangup)
    - Log: callAudit.track({ type: 'dialer.predictive.bridged-agent', ... })

4b. If no agent returned (overflow):
    - overflowNumber = campaign.aiOverflowNumber ?? systemSettings.get('ai_overflow_number')
    - If overflowNumber is null or empty:
        → hang up consumer call
        → Update CampaignAttempt: status='failed', outcome='bridge-failed'
        → Log: callAudit.track({ type: 'dialer.predictive.bridge-failed', reason: 'no_overflow_configured' })
        → return
    - Telnyx client.createCall({
        connectionId: CALL_CONTROL_APP_ID,
        to: overflowNumber,
        from: campaign ANI,
        clientState: { stage: 'ai-overflow-bridge', bridgeWith: <consumer callControlId>, campaignId, contactId }
      })
    - When AI leg answers, new onAiOverflowBridgeAnswered handler bridges the two legs
    - Update CampaignAttempt: status='in-progress', outcome='bridged-to-ai'
    - Log: callAudit.track({ type: 'dialer.predictive.overflow-to-ai', overflowNumber, campaignId, contactId })

5. If any Telnyx API call throws:
   - Hang up consumer leg
   - Update CampaignAttempt: status='failed', outcome='bridge-failed'
   - If agent was reserved: reset user status='available'
   - Log: callAudit.track({ type: 'dialer.predictive.bridge-failed', error })
```

### Consumer hangup before bridge

If the `call.hangup` webhook fires for the consumer leg while the state is still `predictive-pending` (i.e., before we got to step 4):

- Update CampaignAttempt: status='completed', outcome='early-hangup'
- Does NOT count toward abandon rate — consumer never heard silence because no bridge was attempted
- Log: callAudit.track({ type: 'dialer.predictive.early-hangup', ... })

### Atomic reservation invariant

The SQL uses `FOR UPDATE SKIP LOCKED` to guarantee that two concurrent `call.answered` webhooks cannot both reserve the same agent. If two calls answer simultaneously and one agent is available:
- Webhook A: reserves the agent, bridges to agent
- Webhook B: SQL returns null (skip-locked row is unavailable), bridges to AI overflow

This is a database-enforced invariant — no race condition possible.

---

## System Settings Service

New file: `backend/src/services/system-settings.ts`

```typescript
export const systemSettings = {
  async get(key: string): Promise<string | null>,
  async set(key: string, value: string, updatedBy?: string): Promise<void>,
  // Internal 30-second cache for frequent reads (ai_overflow_number hit on every predictive answer)
  _cache: Map<string, { value: string | null, expiresAt: number }>,
}
```

Cache invalidates on `set()`. 30-second TTL for reads — acceptable freshness for a setting that changes rarely.

---

## Settings API Routes

New file: `backend/src/routes/settings.ts`

Routes (all admin-only, behind `requireMinRole('admin')`):

- `GET /api/settings/ai-overflow-number` → `{ value: string | null, updatedAt: string, updatedBy: string | null }`
- `PUT /api/settings/ai-overflow-number` with body `{ value: string }` → `{ value: string, updatedAt: string }`
  - Validates E.164 format (`^\+[1-9]\d{1,14}$`)
  - Records `updatedBy` from authenticated user id

Mounted in `index.ts` under `/api/settings`.

---

## Webhook Dispatcher Changes

In `telnyx-webhook-dispatcher.ts`:

Existing routing logic dispatches based on `clientState.stage`. Two new stages:

| Stage | Handler | Description |
|-------|---------|-------------|
| `predictive-pending` | `predictive-answer-handler.onPredictiveAnswered` | Consumer answered, decide routing |
| `ai-overflow-bridge` | `predictive-answer-handler.onAiOverflowBridgeAnswered` | AI leg answered, bridge to consumer |

Existing `agent-bridge` stage continues to route to `onAgentBridgeAnswered` (unchanged from sub-project 2).

---

## Abandon Rate & Reg F

Soft warning model per user preference:

| Scenario | Outcome logged | Counts as Reg F abandon? |
|----------|---------------|--------------------------|
| Bridged to live agent | `bridged-to-agent` | No |
| Bridged to AI overflow | `bridged-to-ai` | Not counted as technical abandon by this system — consumer is engaged by AI voice, not silence. Reg F safe-harbor qualification is a legal/compliance question the user must confirm separately. |
| Consumer hung up before bridge | `early-hangup` | No — no silence heard |
| Bridge failed (SIP error, AI DID didn't pick up) | `bridge-failed` | Yes — consumer heard silence/dead air |

`recentAbandonRate` in guardrails is now computed as:
```
bridge-failed attempts / total completed attempts in last N minutes
```

The rate shows as a warning in the Campaigns and Diagnostics UI (built in sub-project 3b) but does NOT block new dials.

---

## Observability

New `callAudit.track()` event types:

- `dialer.predictive.call-initiated` — predictive call placed (tracks over-dial count per cycle)
- `dialer.predictive.bridged-agent` — successful agent bridge
- `dialer.predictive.bridged-ai` — successful AI overflow bridge
- `dialer.predictive.overflow-to-ai` — triggers whenever overflow path is taken (for rate monitoring)
- `dialer.predictive.bridge-failed` — any bridge failure path
- `dialer.predictive.early-hangup` — consumer hung up before bridge

These flow into the existing `/api/calls/audit/recent` endpoint, so the Diagnostics page displays them without changes.

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `backend/src/services/predictive-answer-handler.ts` | Handles `call.answered` webhooks for predictive-pending calls. Atomic agent reservation, bridge routing. |
| `backend/src/services/system-settings.ts` | Key/value getter/setter for SystemSetting table with 30s cache. |
| `backend/src/routes/settings.ts` | GET/PUT `/api/settings/ai-overflow-number` admin routes. |
| `backend/src/test/predictive-answer-handler.test.ts` | Tests for bridge paths, race conditions, error handling. |
| `backend/src/test/system-settings.test.ts` | Tests for settings service including cache behavior. |

### Modified files
| File | Changes |
|------|---------|
| `backend/prisma/schema.prisma` | Add `aiOverflowNumber` to Campaign, add SystemSetting table. |
| `backend/src/services/predictive-worker.ts` | Remove pre-call agent reservation. Implement over-dial via `dialRatio`. Add `clientState: { stage: 'predictive-pending' }` on initiated calls. Remove `reserveAvailableAgentId` method (moved to predictive-answer-handler). |
| `backend/src/services/telnyx-webhook-dispatcher.ts` | Route `predictive-pending` and `ai-overflow-bridge` stages to new handlers. |
| `backend/src/services/dialer-guardrails.ts` | Move abandon rate from `blockedReasons` to `warnings`. Narrow abandon calculation to only `bridge-failed` outcomes. |
| `backend/src/services/call-audit.ts` | New event type constants for predictive dialer events. |
| `backend/src/index.ts` | Register `/api/settings` routes. |
| `backend/scripts/seed.ts` | Seed SystemSetting with `ai_overflow_number = "+12762128412"`. |

### Unchanged
- `inbound-ivr.ts`, `inbound-session-adapter.ts` — inbound flow untouched
- `outbound-session-adapter.ts` — still used for manual/non-dialer outbound
- `telnyx-client.ts` — `createCall` already supports all needed params
- All frontend — UI changes are sub-project 3b, separate spec

---

## Test Coverage

### `predictive-answer-handler.test.ts`

1. **Agent available → bridges to agent** — mock DB reservation returns user, verify Telnyx createCall params point to agent SIP URI with `stage: 'agent-bridge'` clientState.
2. **No agents + campaign override set → bridges to campaign number** — campaign has `aiOverflowNumber: "+19998887777"`, verify createCall goes to that number with `stage: 'ai-overflow-bridge'`.
3. **No agents + no campaign override + global setting set → bridges to global** — campaign override null, SystemSetting returns `+12762128412`, verify createCall goes there.
4. **No agents + no overrides anywhere → hangs up + logs bridge-failed** — campaign override null, global null, verify Telnyx hangup called, CampaignAttempt outcome='bridge-failed'.
5. **AMD detected machine → skips routing, logs voicemail** — event has `answering_machine_detected: true`, verify hangup + CampaignAttempt outcome='voicemail'.
6. **Two concurrent webhooks, one agent available** — simulate both calls trying to reserve same agent; verify exactly one gets `bridged-to-agent`, other gets `bridged-to-ai`.
7. **Telnyx bridge API throws → logs bridge-failed, resets agent status** — mock createCall throws, verify agent status returns to `available`, CampaignAttempt outcome='bridge-failed'.
8. **Consumer hangs up during decision window** — verify CampaignAttempt outcome='early-hangup', no abandon counted.

### `system-settings.test.ts`

9. **get returns seeded value** — seed SystemSetting, verify `get('ai_overflow_number')` returns it.
10. **set updates value and invalidates cache** — set value, verify next get returns new value (not cached old value).
11. **get caches for 30s** — set value, mutate DB directly, verify get still returns cached value within 30s.
12. **set records updatedBy** — call `set(key, value, 'admin-user-id')`, verify `updatedBy` column is populated.

### Existing `predictive-worker.test.ts` updates

13. **Over-dials based on dialRatio** — 2 available agents, `dialRatio: 2.0`, 4 contacts queued → 4 calls initiated with `stage: 'predictive-pending'`, no agent pre-reserved.
14. **Capacity respects guardrails** — 2 available agents, `dialRatio: 2.0`, `maxConcurrentCalls: 3` → only 3 calls initiated (guardrail wins).

Target: 14 new/updated tests. Backend suite goes from 65 → ~79.

---

## Manual Test Plan

After deploy to Railway with Telnyx configured:

1. **Mock mode smoke test:** Set `DIALER_MODE=mock`, create a test campaign with 5 contacts, start it. Verify `CampaignAttempt` rows appear with sensible outcomes. No real calls placed.
2. **Live 1:1 agent bridge:** Set `DIALER_MODE=live`, `dialRatio=1.0`, 1 available agent, 1 contact (your cell phone). Start campaign. Your phone rings, agent browser rings, two-way audio. Hang up → disposition → done.
3. **Live overflow test:** `dialRatio=2.0`, mark 1 agent `available`, queue 3 contacts. Start campaign. Verify:
   - Call 1: agent bridges normally
   - Call 2: no agent available → bridges to `+12762128412` (Retell)
   - Call 3: no agent + Call 2 AI bridge still active → also bridges to Retell
4. **Admin overflow number edit:** PUT `/api/settings/ai-overflow-number` with a different number, run another campaign cycle, verify new number is used.
5. **Per-campaign override:** Set campaign's `aiOverflowNumber` to a third number, verify that campaign uses it while others use the global.
6. **Diagnostics visibility:** Load Diagnostics page, verify `dialer.predictive.overflow-to-ai` events appear in the audit stream.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Consumer hears dead air during decision window | Decision + bridge happens server-side in <500ms. Future: play a 500ms ambient tone on consumer leg via Telnyx `play` command during decision. |
| AI DID unreachable (Retell down) | Falls through to `bridge-failed`, hang up consumer. Error logged. Supervisors see via Diagnostics. Manual retry by restarting campaign. |
| Over-dial creates abandon spike | `abandonRateLimit` still tracked and surfaced as warning. User can adjust `dialRatio` down if abandon rate spikes. |
| Two webhooks race for same agent | SQL `FOR UPDATE SKIP LOCKED` makes this impossible — one gets the agent, other gets AI overflow. Tested explicitly. |
| Admin changes global overflow number to invalid value | API validates E.164 format. Campaign dialing continues with old value if DB write fails. |
| Prisma migration on Railway | SystemSetting table add is additive, non-breaking. aiOverflowNumber column is nullable, non-breaking. Deploy in one step. |

---

## Success Criteria

- Predictive worker dispatches `floor(availableAgents × dialRatio)` calls per cycle without pre-reserving agents
- When consumer answers with an agent free, agent bridge completes in <1 second
- When consumer answers with no agent free, Retell bridge completes in <1 second
- No race conditions in agent reservation under concurrent webhook load
- Global AI overflow number editable via admin API
- All 14 new/updated tests pass
- Live-verified on Railway with real Retell AI picking up overflow calls
