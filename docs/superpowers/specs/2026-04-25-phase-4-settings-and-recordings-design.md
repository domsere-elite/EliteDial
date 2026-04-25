# Phase 4 — Settings Page & Recording Playback Design

**Date:** 2026-04-25
**Status:** Approved (awaiting implementation plan)
**Phase context:** Phase 4 of the EliteDial production path. Phase 3 (integration tests) shipped on 2026-04-25 (commits `e6e08f7`, `f70498c`, `1d64447`).

## Goal

Two small, independent frontend additions plus one backend dedup fix:

1. **Settings page** at `/dashboard/settings` — admin-only UI for the existing `ai_overflow_number` system setting.
2. **Recording playback wire-up** — render the existing `<CallRecordingPlayer>` component on AttemptsTab rows and Reports page rows where a recording exists.
3. **De-duplicate recordings on AI Autonomous calls** — stop Retell webhooks from overwriting the SignalWire-recorded `Call.recordingUrl`; SignalWire's bridge-leg recording is canonical for compliance.

## Scope changes vs the production-path memo

The memo listed Phase 4 as "Accounts page, Settings page, recording playback wire-up. Campaign form mode-selector updated to new enum."

- **Accounts page — dropped.** Confirmed unnecessary.
- **Campaign form mode-selector — already done** in Phase 0. `frontend/src/lib/dialMode.ts` and `CampaignForm.tsx` use the 3-mode enum (`manual | progressive | ai_autonomous`). The memo entry was a status note.
- **Recording dedup — added.** Surfaced during design when we noticed both `retell-webhooks.ts` and `signalwire-events.ts` write to the same `Call.recordingUrl` field for AI Autonomous calls, where SignalWire records the bridge leg and Retell records its own copy.

Final Phase 4 work is approximately one day, not the originally-scoped 3–4 days.

---

## 1. Settings page

### Route and gating

- New file: `frontend/src/app/dashboard/settings/page.tsx`
- `'use client'`, uses `useAuth().hasRole('admin')` — non-admins redirect to `/dashboard`. Matches the pattern used elsewhere (NavSidebar already filters this link by `minRole: 'admin'`).
- The dead `/dashboard/settings` nav link in `NavSidebar.tsx` (currently 404s) becomes live.

### UI

A single-form page with one labeled input:

```
AI Overflow Number
[+15551234567        ]   [Save]
Last updated 2026-04-25 by dominic@exec-strategy.com
```

- Input placeholder: `+15551234567`
- Helper text below input: "E.164 format, used as the fallback DID when no campaign DID is configured for AI Autonomous calls."
- Save button disabled until the value differs from what's loaded.
- On save success: toast (use whatever toast pattern other admin pages use; the admin page uses inline status messages — match that), refresh `updatedAt` / `updatedBy` from the response.
- On save error (400 = invalid E.164): show the backend's error message inline below the input.

### Data flow

- Mount: `GET /api/settings/ai-overflow-number` → populates `value`, `updatedAt`, `updatedBy`.
- Save: `PUT /api/settings/ai-overflow-number` with `{ value }` → returns the same shape, re-render with the new metadata.

Both endpoints already exist (`backend/src/routes/settings.ts:11` and `:20`) and are admin-gated server-side.

### Tests

No frontend tests (no harness exists). Backend tests for these endpoints are not added in this phase — the routes already have validation logic; if existing coverage is insufficient that's a separate ticket.

---

## 2. Recording playback wire-up

### Where it renders

The `<CallRecordingPlayer>` component already exists at `frontend/src/components/CallRecordingPlayer.tsx` and is currently orphaned. Two consumer surfaces:

#### AttemptsTab (`frontend/src/components/campaigns/tabs/AttemptsTab.tsx`)

- Each row gets a small collapsible affordance — text link "▶ Play recording" — visible only when `attempt.call?.recordingUrl` is present.
- Click expands an inline panel within the row that renders `<CallRecordingPlayer recordingUrl={…} duration={attempt.call.duration} />`.
- Collapsed by default. Only one row can be expanded at a time (state held in the tab component).

#### Reports page (`frontend/src/app/dashboard/reports/page.tsx`)

- Same pattern. The reports endpoint already returns `recordingUrl` (`backend/src/routes/reports.ts:190`).
- Verify on implementation that the frontend types and table render include it; add the column/expander if missing.

### Why lazy-render rather than always-rendered audio elements

50 `<audio>` elements with `src` set will trigger 50 GET requests to SignalWire's recording-storage URLs on page load. Lazy-rendering on click keeps the page light and avoids burning bandwidth/auth tokens for recordings users won't actually play.

### Backend change required

The `/api/campaigns/:id/attempts` endpoint's `call` projection currently returns only `{ id, duration, status }`. Add `recordingUrl` to the projection.

- File: `backend/src/routes/campaigns.ts` (or wherever `/attempts` lives — verify path on implementation).
- Add one backend test in the existing relevant test file asserting the projection now includes `recordingUrl`.

### Tests

- Backend: 1 new test for the `/attempts` projection.
- Frontend: none.

---

## 3. De-duplicate AI Autonomous recordings

### Problem

For AI Autonomous calls:

- SignalWire records the bridge leg via `record_call` SWML and POSTs to `/signalwire/events/recording`, which writes `Call.recordingUrl`.
- Retell also records its own copy of the same conversation and POSTs to the Retell webhook handler at `retell-webhooks.ts:126-133`, which **also** writes `Call.recordingUrl`.

These are duplicate recordings of the same audio from different vantage points. Whichever webhook arrives second wins, and the field has no way to distinguish source.

### Resolution

Make SignalWire's bridge recording **canonical** for compliance.

- File: `backend/src/routes/retell-webhooks.ts`
- Change: in the `call_ended` (or equivalent) handler, **stop writing `recordingUrl`** to the Call. Keep persisting other Retell-only metadata (transcript, sentiment, agent ID, etc.). Specifically the `recordingUrl` line at `:127-133` should be removed; everything else around it stays.

### Why SignalWire is canonical

- The bridge leg is what compliance auditors actually need: it's the leg the FCC AI-disclosure and FDCPA mini-Miranda played on, and it's the audio with both parties on the line.
- Retell's recording is the same audio captured downstream — useful for transcription/QA, but redundant for compliance review.
- We already record-call via SWML on every AI bridge (`swml/builder.ts` builds `record_call` into `bridgeOutboundAiSwml`).

### Tests

- Existing test in `backend/src/test/retell-webhooks.test.ts` (if one exists for the call-ended path) needs updating to assert `recordingUrl` is **not** written.
- If no such test exists, add one.

---

## File map

| Path | Status | Why |
|---|---|---|
| `frontend/src/app/dashboard/settings/page.tsx` | **Create** | Settings page (Section 1) |
| `frontend/src/components/campaigns/tabs/AttemptsTab.tsx` | **Modify** | Add expandable recording row (Section 2) |
| `frontend/src/app/dashboard/reports/page.tsx` | **Modify** | Add expandable recording row (Section 2) |
| `backend/src/routes/campaigns.ts` (verify path) | **Modify** | Add `recordingUrl` to `/attempts` `call` projection (Section 2) |
| `backend/src/routes/retell-webhooks.ts` | **Modify** | Stop writing `recordingUrl` (Section 3) |
| `backend/src/test/<attempts-test>.test.ts` | **Modify** | Assert `recordingUrl` in projection (Section 2) |
| `backend/src/test/retell-webhooks.test.ts` (verify exists) | **Modify or Create** | Assert `recordingUrl` not written (Section 3) |

## Out of scope

- Recording retention configuration (per the brainstorm — not built today; storage in SignalWire).
- Org-wide branding, additional org settings.
- Dedicated `/dashboard/recordings` page with filters.
- Frontend test harness.
- A "ZIP all recordings for this campaign" download feature (compliance audit nice-to-have, not pilot-blocking).

## Acceptance criteria

- `npm run build` exits 0 (backend and frontend).
- `npm test` (backend) — all existing tests pass plus the new ones from Sections 2 and 3.
- Manual: an admin can navigate to `/dashboard/settings`, see the current `ai_overflow_number`, change it, and reload to confirm persistence. Non-admins are redirected.
- Manual: in AttemptsTab and Reports, attempt rows with recordings expose a play affordance; rows without do not. The audio element loads only when expanded.
- Manual / DB inspection: an AI Autonomous call generates exactly one `Call.recordingUrl` value (from SignalWire), unchanged by subsequent Retell webhooks for the same call.
