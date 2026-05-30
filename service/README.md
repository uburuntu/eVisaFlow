# eVisaFlow service (self-hostable web app + optional Telegram bot)

The eVisaFlow service automates UK eVisa share code retrieval for families. It is
**web-first**: a Fastify API + SSE + a built Astro/React frontend, all on one
in-process run engine driving Playwright. The **Telegram bot is opt-in** — a
pure-web self-host runs with **no Telegram account**. Built on top of the
[evisa-flow](https://github.com/uburuntu/eVisaFlow) npm package.

## Features

- Web app: end-to-end-encrypted (client-held key) member storage, live run screen
  with in-browser 2FA, and in-browser artifact decryption
- Optional Telegram bot: add up to 6 family members, on-demand `/run`, automatic
  monthly reminders, and PDF/checker delivery in chat
- Concurrent queue with per-user serialization and queue-position updates
- Health/readiness endpoints (`/ready`, `/live`) for container deployments

## Self-host quickstart (one command, web-first)

Bring up the whole app — a **bundled Postgres** plus the web server — with a
single command. No Telegram account is required.

**Requirements:** Docker with Compose v2 (`docker compose`). Nothing else.

```bash
# 1. Clone
git clone https://github.com/uburuntu/eVisaFlow.git
cd eVisaFlow

# 2. Configure: copy the example env and set a session secret
cp service/.env.selfhost.example service/.env
# Generate a secret and put it in service/.env as SESSION_SECRET=...
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))"

# 3. Start (builds the image on first run, applies DB migrations automatically)
docker compose -f service/docker-compose.selfhost.yml up

# 4. Open the app
open http://localhost:8080      # or just visit it in a browser
```

`SESSION_SECRET` is the only value you must set for a pure-web install — the
compose file supplies the database connection, `DEPLOYMENT_MODE=selfhost`, and
`ENABLE_BOT=false` for you. The bundled Postgres data persists in a named Docker
volume; migrations run on every boot and are idempotent. Stop with `Ctrl-C` (or
`docker compose -f service/docker-compose.selfhost.yml down`).

> SAFETY: the bundled Postgres is for local/self-host use. Never point the app at
> a managed/production database, and never commit `service/.env` (it is
> gitignored). Secrets are supplied at runtime only — nothing is baked into the
> image.

### Enabling the Telegram bot (optional)

The bot is off by default. To also run it, edit `service/.env`:

```bash
ENABLE_BOT=true
TELEGRAM_BOT_TOKEN=...   # from @BotFather
ENCRYPTION_KEY=...       # 32-byte hex (server-custody AES for the bot)
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then restart: `docker compose -f service/docker-compose.selfhost.yml up`. Web
runs stay client-custody (end-to-end encrypted) and never use `ENCRYPTION_KEY`;
it is required only for the bot's server-custody storage.

### Bot-only deployment (external database)

To run against a database you manage (e.g. Supabase) instead of the bundled
Postgres, use `docker-compose.yml`, which omits the database service and reads
`DATABASE_URL` from `service/.env`:

```bash
docker compose -f service/docker-compose.yml up -d
```

## Setup (manual / non-Docker)

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Set Up Postgres

The bot talks to any Postgres database over a single `DATABASE_URL` connection
string (Drizzle + `pg`). You do **not** paste SQL anywhere — the built-in
migration runner applies the schema for you.

- **Self-host:** use the bundled Postgres from `docker compose` (default
  `postgres://postgres:postgres@localhost:5432/evisaflow`), or point at any
  Postgres you manage.
- **Supabase:** create a project, then copy the project's Postgres connection
  string from **Settings → Database → Connection string** into `DATABASE_URL`.
  The service role key is no longer needed.

On startup the service runs the migration runner against `DATABASE_URL`. It owns
a `schema_migrations` ledger and applies every `migrations/NNN_*.sql` that has
not been recorded yet, each in its own transaction; a second run is a no-op. You
can also apply them manually with `node dist/db/migrate.js`.

The existing migrations `001`–`003` are **baselined automatically**: if a
database already carries the core tables (`users`, `family_members`, `runs`,
`run_events`) but has no ledger yet — as the original Supabase database does —
those versions are recorded as already-applied **without re-running their DDL**,
so an existing schema is never re-migrated or broken. Fresh databases have
neither the tables nor the ledger, so every migration runs normally.

> Migration `003` removed the legacy plaintext `runs.share_code` column. The bot
> stores encrypted share-code bytes plus metadata only.

> SAFETY: only ever point `DATABASE_URL` (and the migration runner) at a
> local/ephemeral Postgres while developing or testing — never at a
> managed/production database.

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in the values (see `.env.example` for the full, commented set):

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string. **Required.** Self-host with the bundled Postgres uses the compose default; Supabase uses the project Postgres connection string. Use a local/ephemeral DB for dev/test only. |
| `SESSION_SECRET` | Signs the session cookie. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Optional for the bot/dev; required by the self-host compose. |
| `PORT` | Single port for the web UI, API, and `/live` / `/ready` probes (default: 8080) |
| `PUBLIC_BASE_URL` | Externally reachable origin (no trailing slash) used to build magic-link URLs |
| `ENABLE_BOT` | `true` to run the Telegram bot (default: `false`). When true, `TELEGRAM_BOT_TOKEN` and `ENCRYPTION_KEY` are required. |
| `TELEGRAM_BOT_TOKEN` | From BotFather. Required only when `ENABLE_BOT=true`. |
| `ENCRYPTION_KEY` | Server-custody AES key for the bot. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Required only when `ENABLE_BOT=true`. |
| `QUEUE_CONCURRENCY` | Max parallel browsers (default: 2) |
| `EVISA_HEADLESS` | Run browser automation headlessly (default: true) |
| `EVISA_DIAGNOSTICS_MODE` | `off`, `sanitized`, `raw`, or `sanitized_on_failure` (default) |
| `SCHEDULER_CRON` | Cron expression for daily check (default: `0 9 * * *`) |
| `SCHEDULE_INTERVAL_DAYS` | Days between scheduled runs per user (default: 30) |
| `WEB_DIST_PATH` | Path to the built web bundle served at this same origin. Optional — defaults to the workspace `web/dist`. If the build is absent the API still runs (a hint is logged). |

### 4. Run

For Docker, use the [self-host quickstart](#self-host-quickstart-one-command-web-first)
above (bundled Postgres) or `docker-compose.yml` (external database). To run
directly on the host without Docker:

```bash
# Install dependencies (including Playwright)
corepack enable
pnpm install
pnpm exec playwright install chromium --with-deps

# Build and start
pnpm run build:service
pnpm --filter evisa-flow-bot start
```

> `build:service` compiles only the backend (library + bot/API). To also build
> the web app for a single-origin self-host, run the root `pnpm run build`, which
> chains `build:service` and `build:web` (`pnpm --filter @evisaflow/web build`).

## Web app (single origin)

This same Fastify process serves the built [web app](../web) (`web/dist`) at the
**same origin** as the API, so the SPA and `/api/*` literally share one host and
the session cookie flows without CORS. There is **no Astro SSR server** in
self-host — the app is pre-rendered static assets.

- **Static files** are served from `web/dist`. The marketing/SEO pages, the
  login page, and hashed `_astro/*` assets are real files.
- **SPA fallback**: the app island is a single client-routed SPA mounted at
  `/app`. Any unknown `/app/*` deep link (e.g. `/app/run/123`) or a reload there
  is served the app shell (`web/dist/app/index.html`) so the in-browser router
  takes over.
- **API precedence**: `/api/*` and the `/ready` / `/live` probes always win the
  route match, and a miss under them returns a **JSON 404** (never the HTML
  shell), so API clients always get a machine-readable response.
- **Graceful degradation**: if `web/dist` is missing (you ran the backend
  without building the web app), the API and health endpoints stay up and a hint
  is logged — only the browser app is unavailable. Build it with
  `pnpm --filter @evisaflow/web build`, or point `WEB_DIST_PATH` at a built
  bundle elsewhere.

### Local development

For the production single-origin behavior, run the root `pnpm run build` and
start the service — it serves both the API and `web/dist` on `PORT`.

For a fast frontend dev loop, run the Astro dev server and the API separately;
the Astro dev server proxies `/api/*` to Fastify so the browser still talks to a
same-origin `/api` and cookies flow:

```bash
# Terminal 1 — the API (and bot)
pnpm --filter evisa-flow-bot start          # serves /api on :8080

# Terminal 2 — the web app with hot reload, proxying /api → :8080
pnpm --filter @evisaflow/web dev            # http://localhost:4321
```

If the API runs on a non-default port, point the proxy at it:

```bash
API_PROXY_TARGET=http://localhost:9000 pnpm --filter @evisaflow/web dev
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
            Postgres (Drizzle + pg)
```

- **Long polling + health server** — Telegram updates use long polling; `/live` and `/ready` expose container health
- **Queue** — max 2 concurrent Playwright browsers (configurable)
- **Encryption** — AES-256-GCM for document numbers
- **Scheduling** — per-user 30-day cycle (load spread evenly)

## Deploy Notes

The GitHub deploy workflow builds an immutable service image, runs `node dist/preflight.js` in that image, then replaces the live container only if Telegram and Postgres readiness checks pass. If the new container fails `/ready`, the workflow restores the previous container.

Before merging deploy changes, make sure the server has the current `.env` values from `.env.example` (in particular `DATABASE_URL` — the `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` pair is no longer used), and that the deployment user can run Docker Compose. The schema is applied automatically by the migration runner on startup, so there is no manual SQL step.
