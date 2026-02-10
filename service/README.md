# eVisaFlow Telegram Bot

Telegram bot that automates UK eVisa share code retrieval for families. Built on top of the [evisa-flow](https://github.com/uburuntu/eVisaFlow) npm package.

## Features

- Add up to 6 family members with encrypted document storage
- On-demand share code retrieval via `/run`
- Automatic monthly reminders with "I'm Ready" button
- PDF delivery directly in Telegram
- Concurrent queue (2 parallel browsers by default)
- Queue position updates

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
4. Go to **SQL Editor** → paste the contents of `migrations/001_initial_schema.sql` → click **Run**
5. Verify the tables (`users`, `family_members`, `runs`) appear in the **Table Editor**

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
| `EVISA_OUTPUT_DIR` | PDF output directory (default: ./downloads) |
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
npm install
npx playwright install chromium --with-deps

# Build and start
npm run build
npm start
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
4. The bot sends the PDF and share code directly in the Telegram chat
5. Every 30 days (configurable), the bot reminds you to refresh share codes

## Architecture

```
Telegram ←→ grammY Bot (long polling) ←→ eVisaFlow (Playwright)
                  │
                  ↓
            Supabase (Postgres)
```

- **No web server** — uses Telegram long polling
- **Queue** — max 2 concurrent Playwright browsers (configurable)
- **Encryption** — AES-256-GCM for document numbers
- **Scheduling** — per-user 30-day cycle (load spread evenly)
