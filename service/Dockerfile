# Combined web + service image for self-host.
#
# One container runs the whole app: the Fastify web server (API + SSE + the built
# Astro/React frontend) and, when ENABLE_BOT=true, the Telegram bot — all on the
# single in-process run engine, driving Playwright Chromium.
#
# Multi-stage:
#   1. builder  — installs the full workspace (incl. dev deps) and builds the web
#                 app (web/dist) AND the service (root lib dist + service/dist).
#   2. runtime  — a lean image: production-only node_modules (workspace symlinks
#                 intact) + the built artifacts + SQL migrations + the base
#                 image's pre-installed Chromium. No source, no dev deps.
#
# Build context is the repo ROOT (see service/docker-compose.yml / deploy.yml).
# NOTHING secret is baked in — all configuration is supplied via runtime env.
#
# Base: the Playwright image ships Chromium under /ms-playwright
# (PLAYWRIGHT_BROWSERS_PATH) matched to playwright 1.59.1, plus Node. We set
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD so `pnpm install` (the `playwright` dep) never
# re-downloads browsers — the pre-installed ones are used at runtime.

# ---------------------------------------------------------------------------
# Stage 1: builder — install everything and build web + service.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS builder

WORKDIR /app

# Use the base image's pre-installed browsers; do not download during install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN corepack enable

# Install deps first, from manifests + lockfile only, so this layer is cached
# until a dependency changes. Every workspace's package.json is required for a
# frozen-lockfile install to resolve the workspace graph (root + service + web).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY service/package.json ./service/package.json
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

# Source + configs needed to build all three packages.
#   - root lib (tsup): src, tsconfig.json, biome.json
#   - service (tsc):    service/src, service/tsconfig.json
#   - web (astro):      web/src, web/public, web/astro.config.mjs, web/tsconfig.json
COPY tsconfig.json biome.json ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts
COPY service/tsconfig.json ./service/tsconfig.json
COPY service/src ./service/src
COPY service/migrations ./service/migrations
COPY web/astro.config.mjs web/tsconfig.json ./web/
COPY web/src ./web/src
COPY web/public ./web/public

# Build the web bundle (web/dist) and the service (root lib dist + service/dist).
# `build:service` runs tsup for the root `evisa-flow` lib then `tsc` for service.
RUN pnpm --filter @evisaflow/web build \
  && pnpm run build:service

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with prod deps + built artifacts + Chromium.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runtime

# Install and lay out the workspace under /app (the final WORKDIR is /app/service,
# set below, so `dist/...` paths and deploy.yml's `node dist/preflight.js` resolve).
WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN corepack enable

# Production-only install of just the service subgraph from the SAME lockfile.
#   --prod                      drops dev deps (tsup, tsc, astro, biome, ...).
#   --filter "evisa-flow-bot..." installs ONLY the service AND its workspace deps
#                               (the root `evisa-flow` lib), excluding the `web`
#                               package's runtime deps (astro/react) — at runtime
#                               only its built `web/dist` is served, never its
#                               node_modules — so the store stays lean.
#   --ignore-scripts            skips the `playwright` browser download (the base
#                               image's pre-installed Chromium is used).
# This recreates the workspace symlinks the service imports at runtime — notably
# service/node_modules/evisa-flow -> ../.. — which the built dist dirs copied on
# top below make resolve to real compiled code. Every workspace's package.json is
# still required so the frozen-lockfile install can validate the workspace graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY service/package.json ./service/package.json
COPY web/package.json ./web/package.json
COPY bin ./bin
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "evisa-flow-bot..." \
  && pnpm store prune

# Built artifacts from the builder stage:
#   - /app/dist          : the `evisa-flow` library (resolved via the workspace
#                          symlink the service imports as "evisa-flow")
#   - /app/service/dist  : the compiled service (index.js, db/migrate.js, ...)
#   - /app/service/migrations : SQL files read at runtime by the migration runner
#   - /app/web/dist      : the built Astro/React app, served by Fastify. This is
#                          exactly where resolveWebDistPath() looks by default
#                          (two levels up from service/dist), so no WEB_DIST_PATH
#                          override is needed.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/service/dist ./service/dist
COPY --from=builder /app/service/migrations ./service/migrations
COPY --from=builder /app/web/dist ./web/dist

# Run from the service package so `dist/...` paths resolve and deploy.yml's
# `node dist/preflight.js` (no explicit workdir) keeps working.
WORKDIR /app/service

# Entrypoint: apply DB migrations (idempotent, baseline-safe) then start the
# server. A tiny script is used so `exec` hands PID 1 to node — SIGTERM reaches
# it for the graceful 15s drain on shutdown.
COPY service/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Readiness probe: the Fastify `/ready` endpoint on PORT (default 8080). Returns
# 200 only once the DB is ready (and, when ENABLE_BOT, Telegram + the runner).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const port=process.env.PORT||8080; fetch('http://127.0.0.1:'+port+'/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
# Default command: start the server (the entrypoint migrates first for this path).
# An explicit override (e.g. `node dist/preflight.js`) runs as-is, without
# migrating — see docker-entrypoint.sh.
CMD ["node", "dist/index.js"]
