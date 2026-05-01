# Phase 3c Spike Results

**Date:** 2026-05-01
**Branch:** feat/phase-3b-wrap-up (no separate spike branch — scaffolding committed inline, removed in cleanup commit)

## Decision

**Proceed with Phase 1 of plan as written**, accepting partial-validation risk. The cold-bridge fallback (`join_room` → `connect: /private/<ref>` on timeout) guarantees system never degrades below today's behaviour. If H1 turns out to be false in production smoke, fall back to the spec's documented "light pre-warm" alternative.

## H3 — v3 SDK 3.28.1 dials SWML URL via Fabric address

**Result:** PASS (partial)

`client.dial({ to: '/swml/spike-agent-room' })` from the SignalWire v3 SDK 3.28.1 **resolves a Fabric session in ~7ms**. The session object returned is a `FabricRoomSession` (minified class name `ul`). No `-32603` errors, no SDK rejection.

**Caveat:** SDK promise resolution at 7ms is just JS-side resolution; whether the agent's PeerConnection actually negotiated and entered a SignalWire conference room is **unverified** in this spike. Phase 1's actual implementation will surface this — if the warm room isn't real, the cold-bridge fallback in the customer-leg SWML covers it.

## H1 — Late-joiner audio is instant

**Result:** UNVALIDATED — could not test

Standalone customer-leg SWML calls (via `signalwireService.originatePowerDialLeg` in a script harness, AND via direct `params.url` / inline `swml:` REST calls) all answered → hung up immediately on the test cell. No SWML execution audible.

**Hypothesis for why the harness failed:** SignalWire executes outbound-dial SWML *during the ring*, before the customer answers. The `say:` TTS played into the ringing leg, finished before pickup, and the call ended on `hangup:` the moment the user picked up. Standalone harness can't be made to behave like an inbound call without significant restructuring.

**Counter-evidence:** The production power-dial worker fired a real dispatch at 14:48 UTC during this spike session. CallEvent `power_dial.bridge.claimed` fired correctly, and the user confirmed end-to-end bridge audio with the documented 3-5s cold WebRTC ringback. **The prod power-dial code path is healthy on 2026-05-01.** The standalone harness is what's broken, not the SignalWire API contract or the inline SWML pattern.

## H2 — `wait_for_moderator` timeout falls through

**Result:** UNVALIDATED — same harness issue

Per SignalWire skill docs, `wait_for_moderator: true` is documented but `timeout:` as a sibling param is not. The plan's customer-side SWML used `timeout: 3` for race protection. We dropped it during diagnostics. Live behaviour with no timeout: customer would wait silently for moderator indefinitely. This is a design risk to validate during Phase 6 smoke (Task 11).

## Confirmed real motivation

**The 3-5s cold WebRTC ringback is real and reproducible.** User answered the prod power-dial call at 14:5x and reported "still a ring before connection, a few second delay" — exactly the UX gap Phase 3c targets.

## What we learned that revises plan assumptions

1. **SignalWire fetches outbound-dial SWML URLs via HTTP GET, not POST.** Existing SWML routes in this repo are POST-only (configured via dashboard for inbound). Phase 1 Task 3's `/swml/agent-room/:agentId` route should be **POST** to match repo convention (Task 3 already specifies POST, and SignalWire's behaviour for `client.dial`-resolved Fabric addresses needs verification — the SDK may use a different fetch path than the REST API's `params.url`).

2. **`timeout:` on `wait_for_moderator` is undocumented in SignalWire's published SWML grammar.** Phase 3 Task 7 should drop `timeout: 3` from `powerDialDetectSwml`'s bridge section, OR accept the risk. With no timeout, a missing moderator means the customer waits silently — at 30s SignalWire's outer call timeout fires. If the agent's pre-warm room session reliably establishes when status flips to available, this is fine. If it's flaky, customers experience long silent holds. **Recommendation:** keep `timeout: 3` in the plan (it costs nothing if SignalWire ignores it; if SignalWire honours it, we get the race-protection we want).

3. **Standalone `signalwireService.originatePowerDialLeg` calls from a `railway run` script don't behave the same as the deployed worker.** Likely a config/env difference or DB-state precondition (PowerDialBatch row needed for `/swml/power-dial/claim` to succeed). Future spikes should run inside the deployed worker, not a standalone script.

## Cleanup

Spike scaffolding (`/swml/spike-*` routes, `dialRoom` on `useSignalWire`, dashboard SPIKE button, `scripts/spike-*.ts`) removed in the cleanup commit immediately following this doc.

## Next session

Resume at Phase 1 Task 1 of `docs/superpowers/plans/2026-04-30-phase-3c-webrtc-pre-warm.md` — build `agentRoomSwml` builder.
