# EliteDial

**Standalone telephony platform for debt collections operations**

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-proprietary-blue)

---

## Overview

EliteDial is a full-stack dialer platform built for collections agencies and debt recovery operations. It supports manual, preview, progressive, and predictive dialing modes with built-in TCPA/DNC compliance, DID routing with local presence, predictive dialer abandon rate guardrails, real-time agent management, and campaign management with list import.

The system runs in mock mode by default, so you can develop and demo without a live telephony provider.

---

## Features

### Dialer Modes
- **Manual** -- agent clicks to dial individual contacts
- **Preview** -- agent sees contact details before the call is placed
- **Progressive** -- auto-dials the next contact when an agent becomes available
- **Predictive** -- dials multiple contacts ahead of agent availability using abandon rate guardrails and answering machine detection (AMD)

### Compliance
- TCPA 8 AM--9 PM calling window enforcement per contact timezone
- DNC list enforcement with fail-safe deny-on-error
- FDCPA flags for consumer protection rules
- Full call audit trail with dispositions

### DID Routing and Local Presence
- 4-tier proximity matching: area code, state, region, fallback
- DID health scoring with automatic rotation
- LRU-based caller ID rotation to avoid number fatigue

### Campaign Management
- Full CRUD for campaigns
- CSV and JSON contact list import
- Duplicate and DNC suppression on import
- Contact reservation to prevent double-dialing

### Call Management
- Call initiation, transfer, and recording
- Disposition tracking with custom codes
- Call session lifecycle management
- Audit trail for every call event

### Agent Management
- Real-time agent status tracking (available, busy, wrap-up, offline)
- Role-based access control (agent, supervisor, admin)
- Per-agent performance statistics

### AI Outbound
- Retell AI integration for automated outbound calls
- AI-to-agent live transfer support
- Webhook-based call event handling

### CRM Integration
- Webhook-based CRM adapter for external system sync
- Configurable endpoint and authentication

### Real-Time Updates
- Socket.IO for live call events, agent status changes, and campaign progress
- Frontend receives push updates without polling

### Reporting
- Call volume summaries with answer and abandon rates
- Per-agent performance breakdowns
- Hourly call distribution charts

### UI
- Dark mode interface built with Next.js
- Recharts-based reporting dashboards

---

## Tech Stack

| Layer | Technology |
|------------|-----------------------------------------------------|
| Backend | Node.js, Express, TypeScript, Prisma, PostgreSQL (Supabase) |
| Frontend | Next.js 14, React 18, TypeScript, Recharts |
| Telephony | SignalWire (Relay + Fabric), Retell AI |
| Real-time | Socket.IO |
| Auth | JWT + bcrypt, role-based (agent / supervisor / admin) |
| Validation | Zod |
| Infra | Docker, Docker Compose |

---

## Quick Start

```bash
# Clone
git clone <repo-url>
cd EliteDial

# Configure
cp .env.example .env
# Edit .env with your database URL and credentials

# Backend
cd backend
npm install
npx prisma db push
npx prisma generate
npm run seed        # Optional: seed demo data
npm run dev

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

The backend starts on `http://localhost:5000` and the frontend on `http://localhost:3000`.

> **Note:** The system starts in mock mode by default (`DIALER_MODE=mock`). No SignalWire or Retell credentials are required for local development.

---

## Environment Variables

All variables are defined in `.env.example`. Key groups:

### Core

| Variable | Description |
|----------------|--------------------------------------|
| `PORT` | Backend server port (default `5000`) |
| `JWT_SECRET` | Secret key for JWT signing |
| `JWT_EXPIRES_IN` | Token expiration (default `8h`) |
| `NODE_ENV` | `development` or `production` |

### Database

| Variable | Description |
|----------------|----------------------------------------------|
| `DATABASE_URL` | Pooled PostgreSQL connection string (Supabase) |
| `DIRECT_URL` | Direct connection string for Prisma Migrate |

### SignalWire

| Variable | Description |
|---------------------------|-------------------------------|
| `SIGNALWIRE_PROJECT_ID` | SignalWire project identifier |
| `SIGNALWIRE_API_TOKEN` | SignalWire API token |
| `SIGNALWIRE_SPACE_URL` | SignalWire space URL |

### Retell AI

| Variable | Description |
|--------------------------|---------------------------------------|
| `RETELL_API_KEY` | Retell AI API key |
| `RETELL_AGENT_ID` | Default Retell agent for AI calls |
| `RETELL_WEBHOOK_SECRET` | Secret for validating Retell webhooks |

### Dialer

| Variable | Description |
|--------------------------|-----------------------------------------------|
| `DIALER_MODE` | `mock`, `progressive`, or `predictive` |
| `DIALER_POLL_INTERVAL_MS`| Worker polling interval (default `5000`) |

### Frontend

| Variable | Description |
|--------------------------|--------------------------------------|
| `NEXT_PUBLIC_API_URL` | Backend URL the frontend calls |
| `NEXT_PUBLIC_APP_NAME` | Application display name |

---

## Architecture

```
Frontend (Next.js)  -->  REST API (Express)  -->  PostgreSQL (Prisma)
                              |                         |
                          Socket.IO              SignalWire / Retell
```

**Key layers:**

- **Routes** -- HTTP endpoint definitions with Zod request validation
- **Services** -- Business logic: dialer worker, DID routing, TCPA checks, campaign reservation, call sessions, CRM adapter
- **Providers** -- Telephony abstraction layer with a provider registry (SignalWire, Retell, mock)
- **Middleware** -- JWT authentication, role-based authorization, rate limiting, error handling

---

## API Overview

| Route Group | Description |
|-------------------|---------------------------------------------------|
| `/api/auth` | Login, register, token refresh, logout |
| `/api/agents` | Agent management, status updates, token provisioning |
| `/api/calls` | Call initiation, status, disposition, transfer |
| `/api/campaigns` | Campaign CRUD, list import, dialer start/stop |
| `/api/voicemails` | Voicemail inbox, mark read, assign to agent |
| `/api/reports` | Summary stats, per-agent metrics, hourly breakdown |
| `/api/admin` | User, phone number, DNC, queue, and webhook management |
| `/api/system` | Readiness checks, diagnostics |

---

## Docker Deployment

```bash
cp .env.example .env
# Configure .env with production values

docker-compose up --build
```

- Backend: `http://localhost:5000`
- Frontend: `http://localhost:3000`

The backend container includes a health check at `/health`. Both services restart automatically unless stopped.

---

## Project Structure

```
EliteDial/
  backend/
    src/
      routes/          # Express route handlers
      services/        # Business logic and telephony providers
        providers/     # Telephony provider implementations
      middleware/      # Auth, RBAC, rate limiting, error handling
      lib/             # Prisma client, Socket.IO setup
      utils/           # Helpers and shared utilities
      test/            # Test suites
      config.ts        # Centralized configuration
      index.ts         # Application entry point
  frontend/
    src/
      app/             # Next.js app router pages
      components/      # React UI components
      hooks/           # Custom React hooks
      lib/             # API client, utilities
  docker-compose.yml
  .env.example
```

---

## Security

- **JWT with blacklist** -- tokens are invalidated on logout via a server-side blacklist
- **Password hashing** -- bcrypt with 12 salt rounds
- **Security headers** -- Helmet middleware with HSTS enabled
- **Rate limiting** -- applied to authentication endpoints to prevent brute force
- **Input validation** -- Zod schemas on all request bodies
- **Role-based access control** -- three tiers (agent, supervisor, admin) enforced at the middleware layer
- **DNC fail-safe** -- if the DNC lookup errors, the call is denied rather than allowed

---

## License

Proprietary -- all rights reserved.
