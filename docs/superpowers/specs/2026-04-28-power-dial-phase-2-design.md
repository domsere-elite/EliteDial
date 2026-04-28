# Power Dial Phase 2 — Design Spec

**Date:** 2026-04-28 (continuation of Phase 1 commit `f4c9ea0`)
**Status:** Design only. Not yet implemented.
**Audience:** Next session picking up after Phase 1. Read this doc + the [softphone shipped handoff](../context-handoffs/2026-04-28-softphone-shipped.md) before touching code.

---

## What's already done (Phase 1, commit `f4c9ea0`)

- `Campaign.dialRatio` (Float, default 1.0, bounded [1.0, 5.0]) — schema, validation, mid-campaign editable.
- `Campaign.voicemailBehavior` (`hangup | leave_message`) + `Campaign.voicemailMessage` (TTS text).
- `dialer-guardrails.computeDialerGuardrails` multiplies `availableAgents * dialRatio` and uses the multiplied limit as the queuePressure denominator.
- `/api/campaigns/dialer/status` selects + returns `dialRatio`.
- `CampaignForm` renders a 1.0–5.0x slider (progressive only) and a voicemail-behavior select with conditional message textarea.
- `SettingsTab` displays both as read-only rows.

**What's not yet done:** Runtime is still 1:1. Setting `dialRatio = 3` raises the dashboard's effective concurrency number but no worker dispatches three legs per agent — the agents still pull `/active/next-contact` and dial via the softphone one customer at a time.

---

## Goal of Phase 2

When a `progressive` campaign has `dialRatio > 1.0`, dispatch `floor(availableAgents * dialRatio)` simultaneous outbound legs across the queued contacts, route the first AMD-confirmed-human answer to a free agent's `/private/<email-local-part>` Fabric address, and route subsequent live answers to AI overflow (when the campaign has a `retellSipAddress` configured) or hang up.

For machine answers, follow `voicemailBehavior`:
- `hangup`: silent disconnect.
- `leave_message`: play `voicemailMessage` TTS, then hang up.

**Out of scope for Phase 2:** abandoned-call message playback (TCPA 2-second window), recording-playback UI changes, multi-tenant agent pools, hold music for the agent during ring.

**Critical constraint:** Don't refactor the softphone. The PSTN-first Fabric bridge with email-as-reference + `password-after-mint` is fragile (took three sessions to land). All Phase 2 origination paths must reuse the same Fabric address shape (`/private/<email-local-part>`) and the same SDK pin (`@signalwire/js@3.28.1`). The agent's browser receives a normal Fabric notification per existing `incomingCallHandlers.all` plumbing.

---

## Architecture

### High-level flow (one dispatch tick, one agent)

1. Worker picks a `progressive` campaign with `status='active'`.
2. Worker reads `dispatchCapacity` from `computeDialerGuardrails`. If `0`, skip.
3. Worker reserves `dispatchCapacity` contacts via `campaignReservationService.reserveNextWorkerContact` (already exists; reuse).
4. For each reserved contact, the worker:
   - Generates a `PowerDialBatch` Postgres row (or per-leg `PowerDialLeg` rows under one batch). Each leg has `batchId`, `agentId` (the agent whose `/private/<ref>` is the target), `contactId`, `legIndex`, `status='dialing'`, `claimed=false`.
   - POSTs `/api/calling/calls` with `{command: "dial", params: {from: DID, to: contact.primaryPhone, caller_id: DID, swml: <inline power-dial SWML>, status_url: <backend>/signalwire/events/call-status}}`.
5. SignalWire dials all legs in parallel from the agent's perspective.
6. **On customer answer** (per leg), SWML executes:
   - `answer:`
   - `detect_machine` (timeout 7s, `wait: true`, `detectors: amd`)
   - `cond` branches on `%{detect_result}`:
     - `human` → `request:` to `/swml/power-dial/claim?batchId=X&legId=Y` (returns the SWML to bridge — see § server-side claim).
     - `machine` / `fax` / unknown → `request:` to `/swml/power-dial/voicemail?campaignId=Z&legId=Y` (returns either hangup SWML or TTS+hangup based on `voicemailBehavior`).
7. **Server-side claim** (`/swml/power-dial/claim`):
   - Atomic Postgres `UPDATE PowerDialLeg SET claimed=true, claimedAt=now() WHERE batchId=X AND claimed=false RETURNING legId` — first leg to win the row gets the agent slot.
   - If returned row's `legId === request.legId` → return SWML connecting to `/private/<email-local-part>`.
   - Otherwise (someone else won the race) → return SWML connecting to `retellSipAddress` if set, else `hangup` SWML.
8. **Race losers** that go to AI: the AI agent (Retell) handles the conversation independently. The agent's session and the AI session are unrelated bridges from SignalWire's view.

### Why server-side claim instead of letting SWML race for `/private/<ref>` directly

The agent's Fabric subscriber **can technically receive multiple notifications**, but the SDK's auto-accept handler can only meaningfully bridge one at a time. Letting two `connect: to: /private/<ref>` legs race causes:
- Second leg's bridge silently fails or grabs a phantom session.
- Auto-accept handler sees two notifications in <100ms; `pendingOutboundRef` matching gets confused.
- Worst case: poisoned agent SDK state (we saw similar in the softphone session — see [2026-04-28-softphone-shipped.md](../context-handoffs/2026-04-28-softphone-shipped.md) § "What was tried and ruled out").

A Postgres `UPDATE … WHERE claimed=false` is atomic, returns the winning row, and is observable for monitoring. Worth the extra HTTP round-trip per leg.

### What about agents going `available` mid-batch?

A different agent becoming free during an in-flight batch does NOT participate in that batch — their `/private/<ref>` is different. The next dispatch tick gives them their own batch.

This is a deliberate simplification. Cross-agent overflow ("agent A's batch finds a human; agent B is free; route to B instead") is more complex and not in scope for Phase 2.

---

## Schema additions (new migration)

```prisma
model PowerDialBatch {
    id           String   @id @default(uuid())
    campaignId   String
    campaign     Campaign @relation(fields: [campaignId], references: [id])
    agentId      String   // Profile.id; the agent this batch's first-human-answer is targeted at
    agent        Profile  @relation(fields: [agentId], references: [id])
    targetRef    String   // email local-part used for /private/<ref>; cached so we don't re-derive it on the SWML claim path
    legCount     Int      // floor(availableAgents * dialRatio) at dispatch time, but per agent
    status       String   @default("dispatching") // dispatching | claimed | exhausted
    claimedAt    DateTime?
    createdAt    DateTime @default(now())
    expiresAt    DateTime // dispatch + ~60s; rows past expiry are cleanup-eligible

    legs         PowerDialLeg[]

    @@index([campaignId, status])
    @@index([agentId, status])
    @@index([expiresAt])
}

model PowerDialLeg {
    id              String   @id @default(uuid())
    batchId         String
    batch           PowerDialBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
    contactId       String
    contact         CampaignContact @relation(fields: [contactId], references: [id])
    legIndex        Int      // 0..legCount-1
    providerCallId  String?  // populated after origination
    status          String   @default("dialing") // dialing | rejected | machine | human-claimed | human-overflow | failed
    detectResult    String?  // 'human' | 'machine' | 'fax' | 'unknown'
    claimedAgent    Boolean  @default(false) // true iff this leg won the agent slot
    overflowTarget  String?  // 'ai' | 'hangup' (set when claimedAgent=false but detectResult='human')
    createdAt       DateTime @default(now())
    completedAt     DateTime?

    @@unique([batchId, legIndex])
    @@index([providerCallId])
    @@index([status])
}
```

**Atomic claim SQL** (use raw query in `/swml/power-dial/claim` route, not Prisma's relational `update`):

```sql
UPDATE "PowerDialLeg"
SET "claimedAgent" = true,
    "status" = 'human-claimed',
    "completedAt" = NOW()
WHERE "id" = $1
  AND "batchId" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "PowerDialLeg"
    WHERE "batchId" = $2 AND "claimedAgent" = true
  )
RETURNING "id";
```

If `RETURNING` is empty: this leg lost the race. Mark it `human-overflow` and route to AI/hangup.

---

## SWML builders to add

`backend/src/services/swml/builder.ts` gains three new pure functions:

### `powerDialDetectSwml(params)`

Customer leg's inline SWML. Used as the `swml` param in `POST /api/calling/calls`.

```typescript
export interface PowerDialDetectParams {
    claimUrl: string;     // absolute URL to /swml/power-dial/claim
    voicemailUrl: string; // absolute URL to /swml/power-dial/voicemail
    batchId: string;
    legId: string;
    campaignId: string;
}

export function powerDialDetectSwml(p: PowerDialDetectParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                { answer: {} },
                {
                    detect_machine: {
                        detectors: 'amd',
                        wait: true,
                        timeout: 7,
                    },
                },
                {
                    cond: [
                        {
                            when: "detect_result == 'human'",
                            then: [
                                {
                                    request: {
                                        url: `${p.claimUrl}?batchId=${p.batchId}&legId=${p.legId}`,
                                        method: 'POST',
                                    },
                                },
                            ],
                        },
                        {
                            else: [
                                {
                                    request: {
                                        url: `${p.voicemailUrl}?campaignId=${p.campaignId}&legId=${p.legId}`,
                                        method: 'POST',
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    };
}
```

### `powerDialBridgeAgentSwml(params)`

Returned from `/swml/power-dial/claim` when the leg wins the race.

```typescript
export interface PowerDialBridgeAgentParams {
    targetRef: string; // email local-part
    callerId: string;  // DID for caller_id presentation; carries through bridge
}

export function powerDialBridgeAgentSwml(p: PowerDialBridgeAgentParams): SwmlDocument {
    return {
        version: '1.0.0',
        sections: {
            main: [
                {
                    connect: {
                        to: `/private/${p.targetRef}`,
                        from: p.callerId,
                        timeout: 30,
                        answer_on_bridge: true,
                    },
                    on_failure: [{ hangup: {} }],
                },
                { record_call: { stereo: true, format: 'mp3' } },
            ],
        },
    };
}
```

### `powerDialOverflowSwml(params)`

Returned from `/swml/power-dial/claim` when the leg loses the race (or no agent ever became available — edge case if batch expires) and from `/swml/power-dial/voicemail` for machine-positive results when `voicemailBehavior=leave_message`.

```typescript
export interface PowerDialOverflowParams {
    mode: 'ai' | 'hangup' | 'leave_message';
    retellSipAddress?: string;
    callerId?: string;
    voicemailMessage?: string;
}

export function powerDialOverflowSwml(p: PowerDialOverflowParams): SwmlDocument {
    if (p.mode === 'ai' && p.retellSipAddress && p.callerId) {
        return {
            version: '1.0.0',
            sections: {
                main: [
                    {
                        connect: {
                            to: p.retellSipAddress,
                            from: p.callerId,
                            timeout: 30,
                            answer_on_bridge: true,
                        },
                        on_failure: [{ hangup: {} }],
                    },
                    { record_call: { stereo: true, format: 'mp3' } },
                ],
            },
        };
    }
    if (p.mode === 'leave_message' && p.voicemailMessage) {
        return {
            version: '1.0.0',
            sections: {
                main: [
                    { say: { text: p.voicemailMessage } },
                    { hangup: {} },
                ],
            },
        };
    }
    return hangupSwml();
}
```

---

## New SWML routes (in `backend/src/routes/swml.ts`)

### `POST /swml/power-dial/claim`

Query params: `batchId`, `legId`. Body: SignalWire's request envelope (which includes `vars`/`call.from`/etc).

Logic:
1. Run the atomic claim SQL above.
2. If win → load batch's `targetRef`, return `powerDialBridgeAgentSwml({ targetRef, callerId: <DID from query> })`. Update leg row to `human-claimed`. Update batch row to `claimed`.
3. If loss → load campaign. If `retellSipAddress` set → return `powerDialOverflowSwml({ mode: 'ai', retellSipAddress, callerId: DID })`. Else → return `hangupSwml()`. Update leg row to `human-overflow` with `overflowTarget` set.

### `POST /swml/power-dial/voicemail`

Query params: `campaignId`, `legId`.

Logic:
1. Load campaign; read `voicemailBehavior` + `voicemailMessage`.
2. Update leg row to `machine` with `detectResult` set.
3. If `voicemailBehavior === 'leave_message'` and `voicemailMessage` is set → return `powerDialOverflowSwml({ mode: 'leave_message', voicemailMessage })`.
4. Else → return `hangupSwml()`.

---

## New worker: `progressive-power-dial-worker.ts`

Mirror the structure of `ai-autonomous-worker.ts`. Per-tick:

```
for each agent with status='available':
    for each active progressive campaign assigned to that agent's pool (TBD: agent-to-campaign mapping; for now,
            assume all available agents serve all active progressive campaigns OR use a dedicated assignment field):
        if guardrail.dispatchCapacity > 0:
            legCount = min(floor(dialRatio), guardrail.dispatchCapacity)
            if legCount < 1: continue
            create PowerDialBatch row (agentId, targetRef = agent.email.split('@')[0])
            for i in 0..legCount-1:
                contact = await campaignReservationService.reserveNextWorkerContact(campaign)
                if not contact: break
                create PowerDialLeg row
                signalwireService.originatePowerDialLeg({ to: contact.primaryPhone, from: did, swmlQuery: { batchId, legId, campaignId }, callbackUrl })
            mark agent.status = 'on-call' (atomic; reverts if no legs originated)
            break  # one batch per agent per tick
```

**Key invariants:**
- Each agent gets exactly one in-flight batch at a time. Track via `Profile.activeBatchId` (new nullable column) or via a `WHERE NOT EXISTS` on `PowerDialBatch`.
- A batch's `expiresAt` triggers cleanup: any leg still `dialing` past expiry is hung up via `POST /api/calling/calls/{id}` with `{command: "hangup"}`.
- The worker MUST NOT originate legs for campaigns where `dialRatio === 1.0`. That path stays on the existing softphone — no behaviour change.

**Boot wiring:** add to `backend/src/index.ts` after the `aiAutonomousWorker.start()` call. Add an env flag `POWER_DIAL_WORKER_ENABLED` (default `false`) so we can ship the code dark and turn it on per-environment.

---

## SignalWire origination contract

Reuse `signalwireService.originateAgentBrowserCall` shape as a model, but power-dial origination doesn't target the agent directly — the agent gets the bridge through the SWML claim. Add a new `signalwireService.originatePowerDialLeg(params)` method:

```typescript
export async function originatePowerDialLeg(params: {
    to: string;            // customer PSTN
    from: string;          // DID
    callerId: string;      // DID
    swml: SwmlDocument;    // powerDialDetectSwml output
    statusUrl: string;
}): Promise<{ providerCallId: string }>
```

Internally posts to `/api/calling/calls` with `command: "dial"` + `params: { from, to, caller_id, swml: JSON.stringify(swml) }`. Match the existing softphone origination's auth + error handling.

**Important:** the existing `originateAgentBrowserCall` uses YAML-string SWML built inline in `signalwire.ts:189-237`. For power-dial, pass the SWML object as JSON (SignalWire accepts both). The builder pattern (objects, not YAML strings) keeps the SWML in the testable `swml/builder.ts` module per CLAUDE.md.

---

## Tests to add

### `backend/src/test/swml-builder.test.ts`

- `powerDialDetectSwml: detect_machine + cond branches present`
- `powerDialDetectSwml: claim URL includes batchId+legId; voicemail URL includes campaignId+legId`
- `powerDialBridgeAgentSwml: connect.to is /private/<targetRef>`
- `powerDialOverflowSwml: ai mode connects to retellSipAddress when both retellSipAddress + callerId provided`
- `powerDialOverflowSwml: leave_message mode plays voicemailMessage then hangs up`
- `powerDialOverflowSwml: hangup mode (or missing retell config) returns minimal hangupSwml`

### New `backend/src/test/power-dial-worker.test.ts`

Mock `prisma`, `signalwireService.originatePowerDialLeg`, `computeDialerGuardrails`. Verify:
- `dialRatio === 1.0` → worker skips the campaign entirely.
- `dialRatio === 3.0`, 2 agents available → at most 6 legs originated across two batches.
- `dispatchCapacity === 0` → no originations.
- One batch per agent per tick.
- Agent transitions to `on-call` only if at least one leg originates successfully.

### New `backend/src/test/swml-routes-power-dial.test.ts`

Mock prisma. Verify:
- `/swml/power-dial/claim` first call returns bridge-to-agent SWML.
- Subsequent calls (other legs in same batch) return overflow SWML.
- Subsequent calls return hangup SWML when campaign has no `retellSipAddress`.
- `/swml/power-dial/voicemail` returns hangup or leave_message based on campaign config.

---

## Rollout plan (suggested)

1. Land schema migration + new `PowerDialBatch`/`PowerDialLeg` models. No worker yet, no behaviour change.
2. Land SWML builder functions + unit tests.
3. Land SWML routes (`/claim`, `/voicemail`) + route tests.
4. Land worker behind `POWER_DIAL_WORKER_ENABLED=false`. Smoke-test in dev with `dialRatio=1.0` (worker skips).
5. Set `dialRatio=2.0` on a single test campaign in dev. Watch logs:
   - Two legs originate.
   - First customer answer with human → bridges to agent.
   - Second customer answer with human → routes to AI overflow (or hangs up).
   - Customer answer with VM → hangs up (or plays TTS).
6. Production rollout: enable env flag, set one campaign to `dialRatio=2.0`, monitor for 24h, then expand.

**Rollback:** flip env flag off. Worker stops dispatching; existing in-flight batches drain naturally on `expiresAt`.

---

## Open questions for the next session

1. **Agent-to-campaign assignment.** Today there's no field linking an agent to specific campaigns. The naive "all available agents serve all active progressive campaigns" works for a single-tenant single-campaign world but not multi-campaign. Add a `Profile.assignedCampaignIds: String[]` array, or a join table?
2. **Per-agent dialRatio override.** Some agents may want a lower ratio than the campaign default. Out of scope for v1 unless the user asks.
3. **Recording behaviour.** The bridge SWML currently includes `record_call` for both human and AI overflow paths. Confirm the existing recording UI surfaces these — if not, that's a Phase 3 concern.
4. **Latency budget.** `detect_machine` adds 4–7s. Combined with PSTN ring (3–30s), the agent waits ~10–30s from dispatch to answer. Acceptable for collections; confirm with the user before shipping.
5. **What if SignalWire's `detect_machine` SWML verb is gated behind a beta flag in our space?** Test in dev with a known-machine target (your own voicemail) before relying on it.
