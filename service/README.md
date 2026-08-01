# eVisaFlow Service

Playwright worker, Telegram transport, scheduler, and authenticated mobile API built on
the [`evisa-flow`](https://github.com/uburuntu/eVisaFlow) package.

## Features

- Add up to 6 family members with encrypted document storage
- On-demand share code retrieval via `/run`
- Automatic monthly reminders with "I'm Ready" button
- eVisa PDF plus status-check HTML/PDF delivery directly in Telegram
- Concurrent queue with per-user serialization and queue position updates
- Health/readiness endpoint for container deployments

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Set Up Supabase

1. Create a free account at [supabase.com](https://supabase.com)
2. Create a new project (name it e.g. "evisa-bot")
3. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (under "Project API keys") → `SUPABASE_SERVICE_ROLE_KEY`
4. Go to **SQL Editor** and run the migration files in order:
   - `migrations/001_initial_schema.sql`
   - `migrations/002_bot_runtime_hardening.sql`
   - `migrations/003_drop_plaintext_share_code.sql`
   - `migrations/004_mobile_api.sql`
5. Verify the tables (`users`, `family_members`, `runs`, `run_events`) appear in the **Table Editor**

Migration `003` removes the legacy plaintext `runs.share_code` column. Migration `004`
adds the service-role-only mobile run tables, private artifact bucket, profile/free-use
enforcement, and atomic result claiming. Enable anonymous sign-ins under Supabase Auth
before testing the mobile client.

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in the values:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `SUPABASE_URL` | From Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase project settings |
| `ENCRYPTION_KEY` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `QUEUE_CONCURRENCY` | Max parallel browsers (default: 2) |
| `EVISA_HEADLESS` | Run browser automation headlessly (default: true) |
| `EVISA_DIAGNOSTICS_MODE` | `off`, `sanitized`, `raw`, or `sanitized_on_failure` (default) |
| `HEALTH_PORT` | HTTP health port for `/live` and `/ready` (default: 8080) |
| `MOBILE_API_PORT` | Internal mobile API port (default: 8090) |
| `MOBILE_API_HOST` | Mobile API bind address inside the container (default: `0.0.0.0`) |
| `SCHEDULER_CRON` | Cron expression for daily check (default: `0 9 * * *`) |
| `SCHEDULE_INTERVAL_DAYS` | Days between scheduled runs per user (default: 30) |

### 4. Run

#### With Docker (recommended)

```bash
docker compose up -d
```

#### Without Docker

```bash
# Install dependencies (including Playwright)
corepack enable
pnpm install
pnpm exec playwright install chromium --with-deps

# Build and start
pnpm run build:service
pnpm --filter evisa-flow-bot start
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Register and see welcome message |
| `/add` | Add a family member |
| `/members` | View or remove family members |
| `/run` | Get share codes (one member or all) |
| `/help` | Show available commands |

## How It Works

1. You add family members with their document details (encrypted at rest)
2. When you run `/run`, the bot launches a headless browser and automates the GOV.UK eVisa flow
3. When 2FA is needed, the bot asks you to enter the code sent to the family member's phone/email
4. The bot sends the share code, eVisa PDF, standalone status-check HTML, and status-check PDF directly in the Telegram chat
5. Every 30 days (configurable), the bot reminds you to refresh share codes

## Architecture

```
Telegram ←→ grammY Bot (long polling) ←→ eVisaFlow (Playwright)
                  │
                  ↓
            Supabase (Postgres)
```

- **Long polling + health server** — Telegram updates use long polling; `/live` and `/ready` expose container health
- **Queue** — max 2 concurrent Playwright browsers (configurable)
- **Encryption** — AES-256-GCM for document numbers
- **Scheduling** — per-user 30-day cycle (load spread evenly)
- **Mobile API** — Supabase bearer authentication, opaque profile slots, resumable
  runs and OTP challenges, one-time result claims, and authenticated artifact downloads
- **Mobile retention** — encrypted transient requests/results, one-hour private
  artifacts, startup cleanup, 15-minute expiry cleanup, and 30-day event retention

## Mobile API deployment

The Compose service binds the mobile API to `127.0.0.1:8090` on the host. Terminate TLS
in a host reverse proxy and forward only the public API hostname to that port. Do not
publish the health port, Supabase service-role key, encryption key, or private Storage
bucket. Configure request/body limits at the proxy in addition to Fastify's limits.

The public client authenticates with Supabase anonymous Auth and supports:

- `GET` and `DELETE /v1/me`
- `PUT` and `DELETE /v1/profile-slots/:id`
- `POST /v1/runs` and `GET /v1/runs/:id`
- `GET /v1/runs/:id/events`
- `POST /v1/runs/:id/challenge`, `/cancel`, and `/claim-result`
- `GET /v1/runs/:id/artifacts/:artifactId`

All `/v1` responses are private/no-store. Applicant payloads and results are encrypted
with `ENCRYPTION_KEY`; OTP values exist only in memory and are never logged or stored.

## Deploy Notes

The GitHub deploy workflow builds an immutable service image, runs `node dist/preflight.js` in that image, then replaces the live container only if Telegram and Supabase readiness checks pass. If the new container fails `/ready`, the workflow restores the previous container.

Before merging deploy changes, make sure the server has the current `.env` values from `.env.example`, the Supabase migrations above have been applied, and the deployment user can run Docker Compose.
