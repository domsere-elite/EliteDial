# EliteDial Architectural Rules

## Telephony provider: SignalWire REST + SWML

**Do NOT use LaML or TwiML XML in this repo.** The telephony layer is built on:
- `POST /api/calling/calls` (JSON) for call origination and live-call updates.
- SWML (YAML/JSON documents) for call-flow control, served dynamically from Express at `/swml/*`.
- JSON webhooks at `/signalwire/events/*` for call-status and recording callbacks.

If you find yourself writing `<Response>`, `<Dial>`, `<Gather>`, `<Say>`, or returning `text/xml` from an Express route, stop — that's the deprecated LaML path. Every call-flow change goes through `backend/src/services/swml/builder.ts` (pure functions that return SWML documents).

## Provider abstraction

`TelephonyProvider` in `backend/src/services/providers/types.ts` is the provider-neutral interface. New providers implement it. Production uses `signalwireService` via `provider-registry.ts`.

Mock telephony (`mock-telephony.ts`) is used when `SIGNALWIRE_PROJECT_ID` is unset; it returns deterministic fake IDs so the rest of the system can run in dev without live credentials.

## Webhook body parsing

SignalWire's modern REST webhooks are JSON. `express.json()` is mounted globally. Never re-introduce `text/xml` or `application/x-www-form-urlencoded` handlers under `/signalwire/events/*` or `/swml/*`.

## SignalWire Dashboard configuration

The SignalWire phone number's voice webhook URL must point at `https://<backend>/swml/inbound` (method: POST). The `status_url` for outbound calls is set per-call at origination — do not configure a default in the dashboard.

## When adding new call flows

1. Add a pure builder function in `backend/src/services/swml/builder.ts` with tests.
2. Add a route in `backend/src/routes/swml.ts` that returns the builder's output.
3. Never embed SWML JSON literals in route handlers — they go in the builder.
4. Never redirect calls by returning XML — use the `request:` SWML verb to chain, or the REST `{command: "update"}` pattern for out-of-band updates.

## Testing

Tests mock `fetch` (injected via service constructor) and inject Prisma-adjacent dependencies through route factory functions. Never hit real SignalWire endpoints from tests. Never depend on a running SignalWire space for the test suite.
