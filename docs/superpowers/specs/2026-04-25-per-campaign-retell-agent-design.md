# Per-Campaign Retell Agent Selection — Design

**Date:** 2026-04-25
**Status:** Approved (brainstorming → ready for plan)
**Parent:** `docs/superpowers/specs/2026-04-15-predictive-dialer-ai-overflow-design.md` (sub-project 3b — campaigns UI)

## Goal

Let operators assign a specific Retell agent to each `ai_autonomous` campaign through the campaign form, instead of leaving `Campaign.retellAgentId` / `retellSipAddress` unset and blocked at activation.

## Non-goals

- AI-specific status signals on OverviewTab (gap A — deferred).
- Per-campaign sender DID override beyond what `defaultDIDId` / `CampaignDIDGroup` already provide.
- Transcript display in AttemptsTab (gap C — deferred to pre-market UI work).
- Activation prereq UX polish (gap D — deferred).
- Pinning Retell agent versions. Calls always route to the agent's latest published version; auditing happens on Retell's side.

## Current state

Backend is fully wired:
- `Campaign` model carries `retellAgentId`, `retellSipAddress`, `retellAgentPromptVersion`.
- `validation.ts` accepts the three fields nullable/optional.
- `campaigns.ts` route persists them on create and update.
- Activation guard at `campaigns.ts:30-32` rejects `ai_autonomous` activation when any of the three are empty.
- `ai-autonomous-worker.ts` reads all three from the campaign record and refuses to dispatch when any is null.

Frontend has zero exposure of these fields. `CampaignForm.tsx` lets operators pick `dialMode = ai_autonomous` but provides no way to assign the Retell agent — so any AI autonomous campaign created in the UI is permanently un-activatable.

## Architecture

### Schema change (subtractive)

Drop `Campaign.retellAgentPromptVersion`. The field exists only as an audit breadcrumb, and Retell already tracks per-call agent versions on its side. Prisma schema, validation, route, activation guard, worker, and existing tests all lose the reference. Single Prisma migration drops the column.

This is acceptable as a destructive migration: the column has no production consumers besides our own code, which is being removed in the same change.

### New endpoint: `GET /retell/agents`

- Authenticated (any logged-in user with campaign-edit access — same auth tier as the campaigns route).
- Proxies Retell's list-agents API, returns `[{ id: string, name: string, sipAddress: string }]`.
- On upstream failure (5xx, network, timeout): responds `503` with a JSON `{ error: string }` carrying the upstream message.
- On missing `RETELL_API_KEY`: responds `503` with a config error string.
- No caching layer. The endpoint is hit once per form mount; Retell's list-agents is fast enough that adding a TTL cache is premature.

### Server-side save flow

When the campaigns create/update route receives an `ai_autonomous` campaign with `retellAgentId` set, it trusts the client-supplied `retellSipAddress` and persists both columns together. Retell SIP URIs are stable per agent, so re-resolving server-side would be a wasted upstream call.

Activation guard becomes:

```ts
if (campaign.dialMode === 'ai_autonomous') {
    if (!c.retellAgentId) missing.push('retellAgentId');
    if (!c.retellSipAddress) missing.push('retellSipAddress');
}
```

(The `retellAgentPromptVersion` check goes away with the column.)

### Frontend wiring

**`CampaignForm.tsx`:**
- `CampaignFormValues` gains `retellAgentId: string | null` (default `null`) and a hidden `retellSipAddress: string | null` populated alongside it.
- New "AI Agent" card rendered only when `values.dialMode === 'ai_autonomous'`, between the Concurrency and Retry sections.
- On mount (or when dialMode flips to `ai_autonomous`), fire `GET /retell/agents` once. Three render states: loading, error (inline with upstream message), loaded (`<select>` of agent names).
- Selecting an agent stores both its `id` and `sipAddress` in form state.
- Submit validation: `ai_autonomous` requires `retellAgentId` non-null. Inline error if missing.
- Edit mode: `initialValues` carries the existing `retellAgentId`. The dropdown pre-selects it after the list loads. If the assigned agent no longer exists in the list, render a warning ("Previously assigned agent `agent_xxxx` not found — pick a new one") and force a re-pick before save.

**`SettingsTab.tsx`:**
- New "AI Agent" row rendered only when `dialMode === 'ai_autonomous'`.
- Fetches `GET /retell/agents` on mount and displays the matched agent's name. Falls back to the raw `retellAgentId` if the list fails or no agent matches.

**`OverviewTab.tsx`:** unchanged.

## Testing

### Backend (node:test, existing DI patterns)

1. **`/retell/agents` route**
   - Happy path: mocked fetch returns Retell agent list → response is `[{id,name,sipAddress}]`.
   - Upstream 5xx → `503` with string error from upstream.
   - Missing `RETELL_API_KEY` → `503` with config error.
2. **Campaigns create/update**
   - Accepts `retellAgentId` + `retellSipAddress` and persists both.
   - Activation guard rejects `ai_autonomous` activate when either is null.
   - Activation guard accepts when both are present.
   - Existing activation test loses its `retellAgentPromptVersion` assertion.
3. **AI autonomous worker**
   - Existing `retellAgentPromptVersion` references stripped from tests.
   - "Missing config skip" test now triggers on either `retellAgentId` or `retellSipAddress` being null.

### Frontend

No test harness. Verification = `npm run build` (zero errors) plus manual smoke:
- Form: pick `ai_autonomous`, confirm dropdown appears, confirm list loaded from real Retell API.
- Save, reopen edit page, confirm pre-selection.
- Save with no agent picked → inline error blocks submit.
- SettingsTab shows the agent name.

## Rollout order

Each step is a standalone shippable commit:

1. Backend — drop `retellAgentPromptVersion` column, remove all references, update existing tests. Single commit.
2. Backend — `GET /retell/agents` route + tests.
3. Frontend — `CampaignForm` wiring.
4. Frontend — `SettingsTab` display.

## Risk notes

- Trusting the client-supplied `retellSipAddress` means a malicious authenticated user could store an arbitrary SIP URI and route AI autonomous calls there. Mitigation: same-tier auth as campaigns route (operators are trusted), and the worker uses `retellSipAddress` only as the bridge target — exfiltration risk is bounded to the operator's own campaigns. If this becomes a concern, swap to server-side resolution in a follow-up.
- Form mounts that occur before `/retell/agents` returns leave the dropdown in a loading state. Save is disabled until the list is loaded if `dialMode === 'ai_autonomous'`.
- Dropping the prompt-version column is irreversible without a restore. Acceptable because the column carries no information not also tracked in Retell.
