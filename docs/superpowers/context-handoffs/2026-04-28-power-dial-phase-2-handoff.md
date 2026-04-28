# Power Dial Phase 2 — Context Handoff

**Date:** 2026-04-28 (continuation of Phase 1, commits `f4c9ea0` + `d2b4020`)
**Audience:** Next session, executing Phase 2 of the power-dial rollout.
**Pick this up by reading:**
1. This doc end-to-end.
2. The Phase 2 design spec at [docs/superpowers/specs/2026-04-28-power-dial-phase-2-design.md](../specs/2026-04-28-power-dial-phase-2-design.md) — every architectural decision, the SWML builder signatures, the schema, the atomic-claim SQL, the rollout plan.
3. The just-shipped softphone handoff at [docs/superpowers/context-handoffs/2026-04-28-softphone-shipped.md](2026-04-28-softphone-shipped.md) — **do not refactor that architecture**. Power-dial reuses the same `/private/<email-local-part>` Fabric pattern and the same `@signalwire/js@3.28.1` pin.

---

## TL;DR

Phase 1 (config layer) is shipped, tested, and the migration is **applied to production** (Supabase pooler `aws-1-us-east-2.pooler.supabase.com:5432`, all 12 migrations clean).

`Campaign.dialRatio`, `Campaign.voicemailBehavior`, `Campaign.voicemailMessage` exist live. Existing campaigns auto-defaulted to `dialRatio=1.0` + `voicemailBehavior=hangup` + `voicemailMessage=NULL` so runtime is unchanged.

Setting `dialRatio > 1.0` in the UI updates `/api/campaigns/dialer/status` capacity numbers but does NOT yet originate multiple legs. That's Phase 2's job.

---

## What's done (don't redo)

### Phase 1 commit `f4c9ea0`

- Schema: `Campaign.dialRatio` (Float, default 1.0, bounded [1.0, 5.0]), `voicemailBehavior` (String, default `'hangup'`), `voicemailMessage` (nullable String).
- Validation: Zod schemas accept the fields on POST + PATCH (mid-campaign editable). Refuses `leave_message` without a message body.
- Guardrails: `computeDialerGuardrails` returns `baseConcurrentLimit = floor(availableAgents * dialRatio)` for progressive mode, capped by `maxConcurrentCalls`. `queuePressure` denominator follows the multiplied limit.
- Routes: `/api/campaigns` POST/PATCH save the new fields; `/api/campaigns/dialer/status` selects `dialRatio` and surfaces it in the response.
- Frontend: [CampaignForm.tsx](../../frontend/src/components/campaigns/CampaignForm.tsx) renders a 1.0–5.0x slider on progressive campaigns + voicemail-behavior select with conditional message textarea. [SettingsTab.tsx](../../frontend/src/components/campaigns/tabs/SettingsTab.tsx) shows them read-only.
- Tests: 232 pass. New coverage: ratio multiply, clamp, max-cap interaction, queue-pressure denominator, voicemail validation.

### Phase 2 design commit `d2b4020`

The spec at [docs/superpowers/specs/2026-04-28-power-dial-phase-2-design.md](../specs/2026-04-28-power-dial-phase-2-design.md) covers everything you need to build. Don't re-derive the architecture — it's done. Just execute it.

### Live state (production)

- Migration `20260428000000_phase_1_power_dial_config` applied 2026-04-28.
- `Campaign` table now has `dialRatio` (DOUBLE PRECISION DEFAULT 1.0), `voicemailBehavior` (TEXT DEFAULT 'hangup'), `voicemailMessage` (TEXT NULL).
- All existing campaigns: `dialRatio=1.0`, `voicemailBehavior='hangup'`, `voicemailMessage=NULL`.
- Backend on Railway is live; the app can read/write these columns. Dispatching is still 1:1 because Phase 2 worker doesn't exist yet.

---

## Phase 2 work to do (in order)

The full spec is at [docs/superpowers/specs/2026-04-28-power-dial-phase-2-design.md](../specs/2026-04-28-power-dial-phase-2-design.md). The TL;DR for ordering:

1. **Schema migration** — add `PowerDialBatch` + `PowerDialLeg` tables. See spec § "Schema additions".
2. **SWML builders** — `powerDialDetectSwml`, `powerDialBridgeAgentSwml`, `powerDialOverflowSwml` in `backend/src/services/swml/builder.ts`. See spec § "SWML builders to add". Add unit tests in `backend/src/test/swml-builder.test.ts`.
3. **SWML routes** — `POST /swml/power-dial/claim` and `POST /swml/power-dial/voicemail` in `backend/src/routes/swml.ts`. The atomic claim SQL is in the spec § "Atomic claim SQL". Add route tests.
4. **SignalWire service** — `signalwireService.originatePowerDialLeg(params)` mirroring `originateAgentBrowserCall`. Spec § "SignalWire origination contract".
5. **Worker** — `progressive-power-dial-worker.ts` modelled on `ai-autonomous-worker.ts`. Boot wiring in `backend/src/index.ts`. Behind env flag `POWER_DIAL_WORKER_ENABLED` (default `false`). Spec § "New worker".
6. **Tests** — `power-dial-worker.test.ts` and `swml-routes-power-dial.test.ts`. Spec § "Tests to add".
7. **Smoke test in dev** — set `dialRatio=2.0` on a test campaign with the env flag on. Spec § "Rollout plan".

**Do NOT:**
- Touch `signalwire.ts:118-237` (the softphone token mint + originate path). Power-dial uses a parallel origination function.
- Use `client.dial(/private/<ref>)` from N legs simultaneously to "let SignalWire race for the agent slot." That breaks the SDK. Server-side claim is mandatory — see softphone handoff § "What was tried and ruled out" for why.
- Bump `@signalwire/js` past `3.28.1`. The connection pool regression in `3.29.x` is documented in the softphone handoff.
- Re-use the Compatibility-API `MachineDetection` LaML param. EliteDial's CLAUDE.md forbids LaML/TwiML. The SWML `detect_machine` verb is the right tool.

---

## Key environmental references

- **Frontend:** https://frontend-production-8067.up.railway.app
- **Backend:** https://backend-production-e2bf.up.railway.app
- **DB:** Supabase (`aws-1-us-east-2.pooler.supabase.com:5432`, project linked via Railway)
- **SignalWire space:** `executive-strategy.signalwire.com`
- **DID for outbound:** `+13467760336` (SID `e6ba0acb-3d8d-4611-b508-457cd4c1aa1b`)
- **Test cell:** `+18327979834`
- **Login:** `dominic@exec-strategy.com` / `TempPass2026`
- **Repo:** `C:\Users\Elite Portfolio Mgmt\Downloads\EliteDial2.0\EliteDial`. Branch `main`. HEAD = `d2b4020`.

### Deploy invocation (locked in from softphone session)

```
railway up backend --path-as-root --service backend --ci
railway up frontend --path-as-root --service frontend --ci
```

### Migrations against prod

```
cd backend && railway run npx prisma migrate deploy
```

---

## Open questions for the user before writing code

The spec lists these (§ "Open questions"). Decide them with the user **before** building:

1. **Agent-to-campaign assignment.** Today there's no `Profile.assignedCampaignIds` field. Naive default ("all available agents serve all active progressive campaigns") works for one tenant. Confirm with Dominic whether multi-campaign assignment is in scope for Phase 2 or deferred.
2. **Latency budget.** `detect_machine` adds 4–7s. Combined with PSTN ring (3–30s), agent waits ~10–30s from dispatch to bridge. Standard in collections; confirm acceptable.
3. **`detect_machine` SWML verb availability.** Confirm in dev that `executive-strategy.signalwire.com` has the verb enabled (some SWML verbs are gated). Test against a known-VM number (your own voicemail) before production rollout.
4. **Recording behaviour for AI overflow.** The bridge SWML in the spec includes `record_call: { stereo: true, format: 'mp3' }`. Confirm recordings of AI-overflow calls should surface alongside agent recordings, or if they should be tagged differently.

---

## Triage if Phase 2 misbehaves in dev

1. **Worker dispatches but no legs ring.** Check Railway logs for `originatePowerDialLeg` errors. Most likely: SignalWire origination POST is missing `caller_id` or the inline SWML failed validation. Test the SWML by POSTing to `/api/calling/calls` directly with `curl`.
2. **Customer answers but `detect_machine` never fires.** Inspect the SignalWire call detail page. If `detect_machine` is unsupported on your space, you'll see an error. Fall back to a press-1 challenge (covered in the softphone session as a failsafe pattern).
3. **First leg wins claim, but second leg also bridges to agent.** The atomic claim SQL is wrong or the route isn't reading the response correctly. Verify the `WHERE NOT EXISTS` clause and the `RETURNING` check. Add a Postgres advisory lock as a backstop if needed.
4. **Race-loser leg goes nowhere.** Either `retellSipAddress` isn't loaded for the campaign, or `powerDialOverflowSwml` is returning empty. Inspect the SWML returned from `/swml/power-dial/claim` for a losing leg in Railway logs.
5. **Agent gets a Fabric notification but the bridge fails.** The softphone's `pendingOutboundRef` matching may not handle multi-leg origination correctly. Power-dial legs don't go through `/api/calls/browser-session` — they originate from the worker, so the notification arrives **without** a pending ref. The auto-accept handler needs a new branch for "incoming from power-dial worker, accept silently if `incomingCallHandlers.all` matches a known target ref." Read [frontend/src/hooks/useSignalWire.ts](../../frontend/src/hooks/useSignalWire.ts) carefully before changing this.

---

## Honest note

Phase 1 was a clean schema + math + UI commit and landed in one session. Phase 2 is genuinely riskier — it adds a new dispatch path that runs in parallel with the just-shipped softphone, and a regression in the worker can corrupt agent state mid-call.

Suggested approach for Phase 2:
1. Build everything behind `POWER_DIAL_WORKER_ENABLED=false`.
2. Run all unit tests + a dry-run smoke (worker logs what it WOULD dispatch without actually POSTing) before flipping the flag.
3. Test on a single campaign with `dialRatio=2.0` and one test cell. Watch the agent's softphone manually for one call.
4. Ramp slowly. Don't go straight to `dialRatio=3.0` across all campaigns.

If anything looks wrong in the softphone path during Phase 2 work, **stop and back out** — the softphone took three sessions to land and is the foundation of the entire outbound flow.
