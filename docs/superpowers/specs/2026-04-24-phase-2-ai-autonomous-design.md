# Phase 2 — AI Autonomous Worker + Compliance Preamble (Design)

**Status:** approved 2026-04-24 (brainstorming)
**Author:** Dominic + Claude
**Follows:** [Phase 0 scope cut](../plans/2026-04-23-phase-0-scope-cut.md), [SWML/REST migration](../plans/2026-04-22-swml-rest-migration.md)
**Feeds into:** `docs/superpowers/plans/2026-MM-DD-phase-2-ai-autonomous.md` (to be written by the writing-plans skill)
**Estimated effort:** 5–6 days

---

## Goal

Build the AI Autonomous outbound worker for EliteDial: a concurrency-capped, compliance-gated dial loop that places SignalWire calls whose SWML connect-leg bridges to a per-campaign Retell agent's SIP endpoint. Phase 1 (SWML + REST migration) and Phase 0 (dial-mode scope cut to `manual | progressive | ai_autonomous`) are already live on `main`.

## Non-goals for Phase 2

- **Recording-consent state check** — deferred; campaign operators manage this manually at campaign setup time.
- **State-DNC list ingestion** — assumed pre-loaded by ops into the existing `DNCEntry` table. Ingestion tooling out of scope.
- **Retell opener script content** — owned inside Retell's dashboard per campaign. EliteDial stores only a `retellAgentPromptVersion` audit tag.
- **Multi-agent routing per campaign** (English/Spanish, biz-hours/after-hours) — YAGNI for pilot; one Retell agent per campaign.
- **Horizontal scale of the worker** — single Node process. `ConcurrencyLimiter` is an interface so a DB-backed impl can replace the process-local one without touching callers.
- **Manual + Progressive pre-dial compliance** — scoped to `ai_autonomous` for now. `DialPrecheck` will be reusable by those modes in a later phase.

## Architecture overview

Five new/changed building blocks, all under `backend/src/`.

```
worker.tick(campaignId)
  → reservationService.reserveNextWorkerContact()   [RegF filter + atomic claim]
  → dialPrecheck.precheck(campaign, contact)         [authoritative TCPA + DNC + RegF]
  → limiter.acquire(campaignId, cap)
  → signalwireService.initiateOutboundCall({..., swmlQuery:{mode,campaignId,from}})
  → SignalWire fetches /swml/bridge?mode=ai_autonomous&campaignId=...&from=...
  → bridgeOutboundAiSwml → connect:{to: "sip:agent@retell"} + record_call
  → signalwire-events terminal-status webhook
  → limiter.release(campaignId)
  → event-bus emits call.terminal → worker.tick(campaignId) again
```

Event bus + 30s safety-net interval together drive `tick`. The interval is self-healing against dropped webhooks; the event path is fast slot-reuse.

## Decisions locked (from brainstorming 2026-04-24)

1. **Concurrency cap:** process-local semaphore behind a `ConcurrencyLimiter` interface. Single Node process for Phase 2; DB-backed impl can replace it later.
2. **Retell agent data model:** two new columns on `Campaign` — `retellAgentId` (source of truth in Retell) and `retellSipAddress` (cached SIP URI, resolved at campaign-save time via `retellService.getAgent`). One agent per campaign.
3. **Compliance check placement:** new `DialPrecheck` service composes TCPA, DNC, Reg F. It is the authoritative gate. `campaignReservationService` keeps its existing Reg F check as a cheap early filter.
4. **Recording-consent state check:** out of Phase 2. Operator responsibility.
5. **Script opener:** owned by Retell's agent prompt. EliteDial stores only `Campaign.retellAgentPromptVersion` (operator-set string); required non-empty to activate an `ai_autonomous` campaign. Value is mirrored onto every `Call` row for audit.
6. **Worker cadence:** hybrid — event-driven on `call.terminal` + `campaign.activated`, plus 30s safety-net interval.
7. **SWML query plumbing:** `OutboundCallRequest.swmlQuery: Record<string,string>`. SignalWire service always serializes it into the SWML URL. Progressive passes `{to,from}`; AI autonomous passes `{mode:'ai_autonomous', campaignId, from}`.
8. **Blocked-precheck dials recorded:** one `Call` row per attempt, including blocked ones (`status='blocked-precheck'`, `duration=0`, `precheckBlockedReasons=<csv>`). One table, full audit trail.
9. **Fail-fast env validation:** partial SignalWire config exits the process; SignalWire-configured-but-Retell-missing warns only (per-campaign activation check is the hard gate).

---

## Schema changes

Single Prisma migration. Name follows the existing convention `YYYYMMDDHHMMSS_phase_2_ai_autonomous_fields` — exact timestamp set when `prisma migrate dev` generates it during implementation.

### `Campaign` — three new columns

```prisma
retellAgentId             String?   // Retell agent ID (mirrors Retell's UI)
retellSipAddress          String?   // Cached SIP URI, resolved from retellAgentId at campaign save
retellAgentPromptVersion  String?   // Operator-set audit tag, required non-empty to activate ai_autonomous
```

**Activation guard** (enforced in `backend/src/routes/campaigns.ts` update/activation handlers — not a DB constraint):
`if dialMode='ai_autonomous' && status='active'`, all three must be non-null. Rejected saves return 400 with a clear error message naming the missing fields. At runtime, the worker skips such campaigns and logs once per tick.

### `Call` — two new columns for audit

```prisma
retellAgentPromptVersion  String?   // copied from Campaign at dial time
precheckBlockedReasons    String?   // comma-separated reasons; null on successful dials
```

### Call status vocabulary extension

Add `blocked-precheck` to the list of allowed `Call.status` values (it's a String column, not an enum, so no migration — just documentation in the schema comment and updated Zod schemas in `backend/src/lib/validation.ts` if present).

### Nothing dropped, no new tables.

Considered a `ComplianceAuditLog` table; rejected in favor of the `Call`-row-per-attempt model.

---

## Component 1: `ConcurrencyLimiter`

File: `backend/src/services/concurrency-limiter.ts`

```typescript
export interface ConcurrencyLimiter {
    acquire(campaignId: string, cap: number): boolean;  // false if cap reached
    release(campaignId: string): void;
    active(campaignId: string): number;
    rebuildFromDb(): Promise<void>;
}
```

Default export `processLocalLimiter: ConcurrencyLimiter` — a `Map<string, number>` backed counter. Node is single-threaded per tick, so no mutex needed; the counter is incremented before the `await` that places the REST call and decremented on terminal-status webhook (or sweeper expiry).

### `rebuildFromDb()`

Run once at boot, before the worker starts its interval. Seeds the map from current DB state to survive crash-restart without over-dialling. Queries `Call` (same table the worker writes to — do not query `CallSession` here; the counter must match what the worker is authoritative about):

```sql
SELECT c."campaignAttempts"->>'campaignId' as campaignId, count(*)
FROM "Call" c
WHERE c.status IN ('initiated','ringing','in-progress')
  AND c.mode = 'ai_outbound'
GROUP BY campaignId;
```

Concretely, the implementation joins through `CampaignAttempt` (which already links `Call` to `Campaign`) rather than a JSON expression — the SQL above is illustrative of intent. The concrete Prisma query lives in the plan.

### Stuck-slot sweeper

A `setInterval` that runs every 60s. For any slot held longer than `CALL_STUCK_SLOT_TIMEOUT_MS` (default 600_000 — 10 minutes), it releases the slot counter in memory and logs `warn`. It does **not** flip the DB row, because a real webhook may still arrive — the DB's eventual consistency is not our problem.

### Observability

`active(campaignId)` is exposed to the `/health/dialer` endpoint (new) so ops can see per-campaign slot occupancy.

### Tests (5)
- acquire below cap returns true, increments counter
- acquire at cap returns false, does not increment
- release decrements; never goes below 0
- `rebuildFromDb` seeds counts from mock Prisma
- stuck-slot sweeper fires after timeout, logs warn, resets counter

---

## Component 2: `DialPrecheck`

File: `backend/src/services/dial-precheck.ts`

```typescript
export interface DialPrecheckResult {
    allowed: boolean;
    blockedReasons: string[];
    deferUntil?: Date;
}

export interface DialPrecheckDeps {
    tcpa: { isWithinCallingWindow(tz: string | null): boolean };
    dnc: { isOnDNC(phone: string): Promise<boolean> };
    regF: { checkRegF(phone: string): Promise<RegFCheckResult> };
    clock?: () => Date;
}

export interface DialPrecheck {
    precheck(campaign: Campaign, contact: CampaignContact): Promise<DialPrecheckResult>;
}

export function buildDialPrecheck(deps: DialPrecheckDeps): DialPrecheck;
```

### Check order (cheapest first, short-circuits)

1. **TCPA quiet-hours** — pure function, no I/O. On fail: `blockedReasons += ['tcpa_quiet_hours']`, `deferUntil = nextCallingWindowStart(contactTz)`. A utility `nextCallingWindowStart(tz: string): Date` is added to `tcpa.ts` returning the next 8 AM in that tz.
2. **DNC** — one lookup via `dncService.isOnDNC(contact.primaryPhone)`. Federal + state share the `DNCEntry` table. On fail: `blockedReasons += ['dnc_listed']`. Fail-safe: DNC lookup error blocks the call (existing behavior in `dnc.ts`).
3. **Reg F 7-in-7** — `complianceFrequency.checkRegF(contact.primaryPhone)`. On fail: `blockedReasons += ['reg_f_cap']`. No `deferUntil` (sliding window reconsidered each tick).

Precheck never short-circuits on `allowed=true`. It always runs all three so multi-reason blocks are reported (audit quality).

### Blocked-reason → contact status mapping

Applied by the **worker** (not the precheck — the precheck stays pure):

| Reason | `CampaignContact.status` | `nextAttemptAt` |
| --- | --- | --- |
| `tcpa_quiet_hours` | `queued` | `deferUntil` |
| `dnc_listed` | `suppressed-dnc` | null (terminal) |
| `reg_f_cap` | `queued` | null (reconsidered next tick) |

If multiple reasons fire, the most-terminal status wins (`suppressed-dnc` > `queued with deferUntil` > `queued`).

### Tests (7)
- all three checks pass → allowed=true
- TCPA-blocked only → deferUntil set to 8am next day in contact tz
- DNC-blocked only
- Reg F-blocked only → no deferUntil
- All three fail → all three reasons present, deferUntil set
- DNC dep throws → fail-safe block
- Clock injected for tz math determinism

---

## Component 3: `AIAutonomousWorker`

File: `backend/src/services/ai-autonomous-worker.ts`

```typescript
export interface AIAutonomousWorker {
    start(): Promise<void>;
    stop(): void;
    tick(campaignId: string): Promise<void>;
}
```

### Lifecycle

Wired from `backend/src/index.ts` after Prisma connects, after `validateActivationsOrWarn()` runs:

```typescript
await aiAutonomousWorker.start();
```

`start()`:
1. `limiter.rebuildFromDb()`
2. Subscribe to `call.terminal`, `campaign.activated`, `campaign.paused` events
3. Start the 30s safety-net `setInterval` that queries all active `ai_autonomous` campaigns and calls `tick(id)`

`stop()` clears the interval and unsubscribes. Called from the existing SIGTERM handler in `index.ts`.

### Event bus

New file `backend/src/lib/event-bus.ts` — a typed wrapper around Node's `EventEmitter`. ~30 lines. No external dep.

```typescript
type Events = {
    'call.terminal':     { callId: string; campaignId: string | null };
    'campaign.activated': { campaignId: string };
    'campaign.paused':    { campaignId: string };
};
export const eventBus: TypedEmitter<Events>;
```

Emitters:
- `backend/src/routes/signalwire-events.ts` — on terminal call status update, emit `call.terminal` after the DB write.
- `backend/src/routes/campaigns.ts` — on status change to `active` / `paused`, emit the corresponding event.

### The tick

Per-campaign serialised via `Map<string, Promise<void>>`. Concurrent calls for the same campaign chain; different campaigns parallelise.

```
tick(campaignId):
  load campaign
  if missing or not active or not ai_autonomous: return
  if missing retellAgentId || retellSipAddress || retellAgentPromptVersion: log-once, return
  while true:
    cap = campaign.maxConcurrentCalls
    if cap <= 0: log-once 'no_concurrency_configured', break
    if limiter.active(campaignId) >= cap: break
    reservation = await reservationService.reserveNextWorkerContact(campaign)
    if !reservation: break
    pre = await dialPrecheck.precheck(campaign, reservation.contact)
    if !pre.allowed:
      await writeBlockedCallRow(campaign, reservation.contact, pre.blockedReasons)
      await applyBlockedContactStatus(reservation.contact.id, pre)
      continue
    if !limiter.acquire(campaignId, cap): break   // raced
    try:
      await reservationService.confirmDialReservation(reservation.contact.id, { type:'worker', token:reservation.reservationToken })
      const result = await signalwireService.initiateOutboundCall({
        fromNumber: pickDid(campaign),
        toNumber: reservation.contact.primaryPhone,
        callbackUrl: config.publicBackendUrl,
        swmlQuery: { mode:'ai_autonomous', campaignId, from: pickDid(campaign) },
        metadata: { campaignId, contactId: reservation.contact.id },
      })
      if (!result) throw new Error('signalwire_initiate_failed')
      await writeInitiatedCallRow(campaign, reservation.contact, result)
    catch (err):
      limiter.release(campaignId)
      await reservationService.failReservation(reservation.contact.id, 'queued', new Date(Date.now() + campaign.retryDelaySeconds*1000))
      logger.error('ai_autonomous dial failed', { campaignId, contactId:reservation.contact.id, err })
```

**DID selection** — `pickDid(campaign, contact)`: reuses the existing DID router (`backend/src/services/did-router.ts`). Out of scope to change DID selection logic. If the router returns no DID, the worker logs an error, releases the slot, and marks the contact `queued` with `nextAttemptAt = now + retryDelaySeconds`.

**Initiated Call row** — created in the worker immediately after REST success, not in the webhook handler. `retellAgentPromptVersion` is copied from campaign. `signalwireCallId` = `result.providerCallId`.

**Mock-mode behaviour** — if `signalwireService.isConfigured === false`, `initiateOutboundCall` returns a mock id; the worker writes a Call row with `signalwireCallId='mock-call-...'` and the limiter slot is held until the mock lifecycle (`mock-call-lifecycle.ts`) emits a terminal event. Dev loop works end-to-end without live creds.

### Tests (6)
- `tick` with cap=0 → no-op, logs `no_concurrency_configured`
- `tick` dials up to cap, stops when cap reached
- `tick` writes blocked Call row + sets contact status on precheck fail
- `tick` releases slot and re-queues contact on REST-call failure
- `tick` skips + logs once when campaign missing Retell config
- two parallel `tick(sameId)` calls serialise (second awaits first)

---

## Component 4: SWML builder + `/swml/bridge` route

### Builder addition — `backend/src/services/swml/builder.ts`

```typescript
export interface BridgeOutboundAiParams {
    retellSipAddress: string;  // sip:agent_xxx@...retell.ai
    from: string;              // caller ID (DID)
}

export function bridgeOutboundAiSwml(params: BridgeOutboundAiParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { connect: {
                    to: params.retellSipAddress,
                    from: params.from,
                    timeout: 30,
                    answer_on_bridge: true,
                  },
                  on_failure: [{ hangup: {} }] },
                { record_call: { stereo: true, format: 'mp3' } },
            ],
        },
    };
}
```

No `say:` preamble — the opener is Retell's responsibility per decision #5.

### Route change — `backend/src/routes/swml.ts`

`/swml/bridge` branches on query params:

```
?mode=ai_autonomous&campaignId=<uuid>&from=<did>
  → load campaign, require retellSipAddress, return bridgeOutboundAiSwml

?to=<e164>&from=<did>     [existing progressive / manual path — unchanged]
  → return bridgeOutboundSwml
```

If `mode=ai_autonomous` but the campaign is missing or `retellSipAddress` is null: respond `503 Service Unavailable` with a SWML hangup document so the call terminates cleanly instead of failing in a noisy way.

### SignalWire service plumbing

`backend/src/services/providers/types.ts` — `OutboundCallRequest` gains:

```typescript
swmlQuery?: Record<string, string>;   // serialized into /swml/bridge URL
```

`backend/src/services/signalwire.ts` `initiateOutboundCall` — replaces hard-coded `?to=&from=` with `new URLSearchParams(request.swmlQuery ?? {}).toString()`. Existing callers (progressive/manual paths) updated to pass `{to, from}` explicitly.

### Tests
- Builder (2): happy path returns doc with `connect.to=<sip>` + `record_call`; record_call is always present
- Route (3): ai_autonomous branch loads campaign and returns correct doc; missing campaign → 503 hangup doc; progressive branch unchanged (regression guard)
- Service (2): `swmlQuery` is URL-encoded; callers pass correct keys per mode

---

## Component 5: Fail-fast env validation

File: `backend/src/lib/env-validation.ts`

Two functions.

### `validateEnvOrExit(): void`

Synchronous. Called from `index.ts` **before** anything else.

- **Partial SignalWire config → exit(1).** `projectId + apiToken + spaceUrl` must all be set or all empty. Mixed partial config is always a mistake.
- **SignalWire configured but Retell not → warn only.** Not fatal — a deployment might temporarily have SignalWire live while provisioning Retell. The worker's per-campaign check is the hard gate.

### `validateActivationsOrWarn(): Promise<void>`

Async. Called after Prisma connects.

- Queries for `active` + `ai_autonomous` campaigns missing any of the three Retell fields.
- Logs `error` with campaign id+name for each.
- Does not exit — misconfigured campaigns get skipped at tick time, don't bring down the process.

### Tests (4)
- all env empty → OK (mock mode boots)
- partial SignalWire config → exits with clear error
- SignalWire configured, Retell missing → warns, does not exit
- all env set → OK

---

## Routes touched (summary)

- **`backend/src/routes/swml.ts`** — `/swml/bridge` gains `mode=ai_autonomous` branch
- **`backend/src/routes/signalwire-events.ts`** — terminal call status emits `call.terminal` event after DB write
- **`backend/src/routes/campaigns.ts`** — activation handler validates Retell fields for `ai_autonomous`; status changes emit `campaign.activated` / `campaign.paused`; one new endpoint `GET /health/dialer` returns per-campaign slot occupancy from the limiter
- **`backend/src/index.ts`** — calls `validateEnvOrExit()` before boot, `validateActivationsOrWarn()` + `aiAutonomousWorker.start()` after Prisma, `aiAutonomousWorker.stop()` in SIGTERM

---

## Testing strategy

~30 new tests across the files above, bringing suite from 147 → ~177. All follow the existing pattern: mock `fetch`, inject Prisma-adjacent deps through factory functions, no live-provider calls.

**Mock-mode integration test** (new, 1 test): end-to-end smoke — seed a campaign + contact, start the worker, tick once, assert a mock `Call` row is created with `signalwireCallId` starting `mock-call-`, assert the limiter holds one slot. Exercises worker + limiter + reservation + precheck + mock telephony together.

**Webhook integration test** (new, 1 test): POST a `completed` status to `/signalwire/events/call-status`, assert `call.terminal` is emitted and the limiter releases.

**Task acceptance rule** (per user memory): every task that modifies code must end green on both `npm test` and `npm run build`.

---

## Risks & open items carried forward

- **Live Retell SIP bridge verification.** The SWML `connect:` to a Retell SIP endpoint is untested against a live space (no credentials in dev — same constraint as Phase 1). First verification happens in Phase 5 (first public deploy). If Retell requires specific `from` formatting or custom SIP headers on the incoming leg, the builder gets a small patch then.
- **Legal review of Retell agent prompts** before any call to a real consumer — per the locked decision, prompts live in Retell's UI. Dominic's responsibility to coordinate review; out of this phase's code scope. The `retellAgentPromptVersion` audit tag exists so the prompt-in-effect is traceable per call.
- **State-DNC list freshness** — outside Phase 2. Assume ops tooling loads/refreshes the `DNCEntry` table.
- **Retell SIP address resolution** — `retellSipAddress` is expected to be resolved from `retellAgentId` at campaign-save time. If Retell's API doesn't expose a SIP address on `getAgent`, the campaign form falls back to operator-pasted SIP URI. (To be verified when we first touch a live Retell account; doesn't block code landing.)

---

## File Structure (created / modified)

**New files:**
- `backend/src/services/concurrency-limiter.ts`
- `backend/src/services/dial-precheck.ts`
- `backend/src/services/ai-autonomous-worker.ts`
- `backend/src/lib/event-bus.ts`
- `backend/src/lib/env-validation.ts`
- `backend/prisma/migrations/<timestamp>_phase_2_ai_autonomous_fields/migration.sql` (timestamp generated by `prisma migrate dev`)
- `backend/src/test/concurrency-limiter.test.ts`
- `backend/src/test/dial-precheck.test.ts`
- `backend/src/test/ai-autonomous-worker.test.ts`
- `backend/src/test/env-validation.test.ts`
- `backend/src/test/event-bus.test.ts`

**Modified files:**
- `backend/prisma/schema.prisma` — `Campaign` +3 cols, `Call` +2 cols
- `backend/src/services/swml/builder.ts` — add `bridgeOutboundAiSwml`
- `backend/src/routes/swml.ts` — `/swml/bridge` branch on `mode`
- `backend/src/routes/signalwire-events.ts` — emit `call.terminal` on terminal status
- `backend/src/routes/campaigns.ts` — activation guard, status events, `/health/dialer`
- `backend/src/services/signalwire.ts` — `swmlQuery` plumbing
- `backend/src/services/providers/types.ts` — `OutboundCallRequest.swmlQuery`
- `backend/src/services/tcpa.ts` — add `nextCallingWindowStart(tz)` utility
- `backend/src/services/retell.ts` — expose a helper to resolve SIP address from an agent (if the API supports it; otherwise no change, operator pastes SIP)
- `backend/src/lib/validation.ts` — Zod schema for new Campaign fields + activation guard
- `backend/src/index.ts` — boot wiring
- `backend/src/test/swml-builder.test.ts` — +2 tests
- `backend/src/test/swml-routes.test.ts` — +3 tests (or equivalent existing file)

**No files deleted.**
