# EliteDial — Production Readiness Framework

## Current State Assessment

EliteDial is a **well-architected collections dialer** with strong fundamentals. The core dialing engine, compliance guardrails, campaign automation, and agent workspace are all implemented. The codebase is TypeScript throughout, uses Prisma ORM with a solid schema, and has a pluggable provider architecture.

### What's Working
- Multi-mode dialing (Manual, Preview, Progressive, Predictive, AI)
- SignalWire telephony integration with browser softphone
- Retell AI for automated outbound calls
- TCPA calling window enforcement (8am-9pm local time)
- DNC list management with pre-dial checks
- Campaign management with CSV lead import
- DID proximity matching with 4-tier area code cascade
- DID health scoring and cooldown rotation
- Dialer guardrails (abandon rate tracking, concurrent limits)
- JWT auth with role-based access (Agent/Supervisor/Admin)
- Call audit trail and event logging
- Reporting (summary, per-agent, hourly breakdown)
- Voicemail inbox with transcription
- Rate limiting, CORS, Helmet security headers

### What Needs Work
- Several UI pages are stubs (Accounts, Settings)
- CRM integration is framework-only
- No test coverage beyond a foundation test
- No deployment pipeline (CI/CD)
- No WebSocket real-time updates (polling-based)
- Call recording/transcription playback missing from UI
- Callback scheduling incomplete

---

## Production Framework — Prioritized Phases

### PHASE 1: Critical Path (Must-Have Before Go-Live)
> Goal: Get agents making live collection calls safely

| # | Task | Priority | Effort |
|---|------|----------|--------|
| 1.1 | **SignalWire Live Configuration** — Provision project, buy DIDs, configure webhooks, test outbound/inbound | P0 | 1 day |
| 1.2 | **Environment & Secrets** — Production .env, secure JWT_SECRET, database connection pooling | P0 | 0.5 day |
| 1.3 | **Database Migration** — Run `prisma db push` on production Supabase instance, verify schema | P0 | 0.5 day |
| 1.4 | **Seed Production Data** — Disposition codes, admin user, phone numbers | P0 | 0.5 day |
| 1.5 | **Softphone Testing** — Verify browser-to-PSTN calling works end-to-end | P0 | 1 day |
| 1.6 | **Inbound Call Routing** — Test IVR + agent connect flow on live SignalWire | P0 | 1 day |
| 1.7 | **FDCPA Mini-Miranda Script** — Hardcode compliant disclosure in call flows | P0 | 0.5 day |
| 1.8 | **DNC Import** — Import existing DNC lists, verify pre-dial blocking | P0 | 0.5 day |
| 1.9 | **Deploy Backend** — Railway/Render/Fly.io with health check endpoint | P0 | 1 day |
| 1.10 | **Deploy Frontend** — Vercel with environment variables | P0 | 0.5 day |
| 1.11 | **SSL/Domain** — HTTPS for both backend API and frontend | P0 | 0.5 day |

**Phase 1 Total: ~7 days**

---

### PHASE 2: Agent Productivity (Week 2)
> Goal: Make agents efficient and supervisors effective

| # | Task | Priority | Effort |
|---|------|----------|--------|
| 2.1 | **Account Lookup Page** — Search by account #, phone, name; display balance, status, payment history | P1 | 2 days |
| 2.2 | **CRM Context in Dialer** — Show debtor info (balance, last payment, account age) during call | P1 | 1 day |
| 2.3 | **Call Recording Playback** — Audio player in call detail view | P1 | 1 day |
| 2.4 | **Callback Scheduling** — Agent sets future callback date/time, system auto-dials at scheduled time | P1 | 2 days |
| 2.5 | **Real-Time Agent Dashboard** — Supervisor view: who's on a call, idle time, calls in queue | P1 | 1.5 days |
| 2.6 | **Settings Page** — Agent preferences (default status, notification sounds, timezone) | P2 | 1 day |
| 2.7 | **Transcription Display** — Show call transcript in call detail view | P2 | 0.5 day |

**Phase 2 Total: ~9 days**

---

### PHASE 3: Compliance & Quality (Week 3)
> Goal: Pass audit, protect the agency license

| # | Task | Priority | Effort |
|---|------|----------|--------|
| 3.1 | **Call Recording Consent** — Two-party state detection, auto-announce recording | P0 | 1.5 days |
| 3.2 | **National DNC Registry Sync** — Scheduled check against FTC DNC list | P1 | 1 day |
| 3.3 | **State-Level Compliance Rules** — Per-state calling restrictions (frequency caps, time zones) | P1 | 1.5 days |
| 3.4 | **Reg F Compliance** — 7-in-7 call frequency cap per consumer (CFPB) | P0 | 1 day |
| 3.5 | **Call Logging Retention** — 3-year retention policy for call records | P1 | 0.5 day |
| 3.6 | **Abandon Rate Enforcement** — Hard 3% ceiling with real-time monitoring | P0 | 1 day |
| 3.7 | **Voicemail Drop Compliance** — Pre-recorded message that meets FDCPA requirements | P1 | 1 day |
| 3.8 | **Audit Export** — Download call logs, disposition reports, compliance records as CSV | P1 | 1 day |

**Phase 3 Total: ~8.5 days**

---

### PHASE 4: Testing & Reliability (Week 3-4)
> Goal: Confidence that nothing breaks in production

| # | Task | Priority | Effort |
|---|------|----------|--------|
| 4.1 | **API Integration Tests** — Auth, calls, campaigns, admin endpoints | P1 | 2 days |
| 4.2 | **Compliance Unit Tests** — DNC check, TCPA window, Reg F frequency | P0 | 1 day |
| 4.3 | **Predictive Worker Tests** — Guardrail blocking, contact reservation, retry logic | P1 | 1 day |
| 4.4 | **Frontend E2E Tests** — Login flow, dial, disposition, campaign create | P2 | 2 days |
| 4.5 | **Error Monitoring** — Sentry or equivalent for backend + frontend | P1 | 0.5 day |
| 4.6 | **Health Check & Uptime** — `/api/system/health` endpoint + external monitor | P1 | 0.5 day |
| 4.7 | **Database Backup** — Automated Supabase snapshots + point-in-time recovery | P1 | 0.5 day |
| 4.8 | **CI/CD Pipeline** — GitHub Actions: lint, test, build, deploy on merge | P1 | 1 day |

**Phase 4 Total: ~8.5 days**

---

### PHASE 5: Scale & Optimize (Post-Launch)
> Goal: Support growing agent team, improve efficiency

| # | Task | Priority | Effort |
|---|------|----------|--------|
| 5.1 | **WebSocket Real-Time Updates** — Live call status, queue depth, agent presence | P2 | 2 days |
| 5.2 | **Call Whisper/Barge** — Supervisor listen-in, whisper coaching, barge-in | P2 | 2 days |
| 5.3 | **Advanced Reporting** — Scheduled email reports, CSV export, custom date ranges | P2 | 2 days |
| 5.4 | **Payment Processing Integration** — Accept payments during call (PCI compliance) | P2 | 3 days |
| 5.5 | **SMS/Email Follow-Up** — Send payment reminders after call | P2 | 2 days |
| 5.6 | **Multi-Tenant Support** — Serve multiple client portfolios | P3 | 3 days |
| 5.7 | **Mobile Agent Interface** — Responsive PWA for remote agents | P3 | 2 days |
| 5.8 | **AI Call Scoring** — Auto-score call quality from transcripts | P3 | 2 days |

---

## Architecture Diagram

```
                    ┌──────────────┐
                    │   Agents     │
                    │  (Browser)   │
                    └──────┬───────┘
                           │ HTTPS
                    ┌──────▼───────┐
                    │   Next.js    │  ← Vercel
                    │   Frontend   │
                    └──────┬───────┘
                           │ REST API
                    ┌──────▼───────┐
                    │   Express    │  ← Railway/Render
                    │   Backend    │
                    └──┬───┬───┬───┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Supabase │ │SignalWire│ │ Retell   │
        │ Postgres │ │Telephony│ │ AI Agent │
        └──────────┘ └──────────┘ └──────────┘
```

## Quick Wins (Can Do Today)

1. Fix the Accounts page stub — even a basic search form helps agents
2. Add call recording playback URL to the call detail API response
3. Wire up the Settings page with timezone + notification preferences
4. Add `Reg F` frequency check (query call attempts in last 7 days before dialing)
5. Add a `/health` endpoint returning `{status: "ok", timestamp}` for uptime monitoring
