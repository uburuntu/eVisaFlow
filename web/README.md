# @evisaflow/web

The eVisaFlow web frontend: a static [Astro](https://astro.build) site for the
marketing/SEO pages and login, plus a `client:only` React island for the
end-to-end-encrypted application.

This package builds to fully static HTML/CSS/JS in `web/dist`, which the Fastify
web server (`service/`) serves directly — there is **no Astro SSR server** in
self-host. All API calls go to the same-origin `/api/*` paths so the browser
sends the session cookie.

## What's here

**Static shell (zero/again-zero client JS):**

- **Design system** — `src/styles/global.css`: accessible tokens (colour, type,
  spacing), light/dark, semantic components, WCAG-AA contrast, reduced-motion.
- **Layout & shell** — `src/layouts/Layout.astro`, `src/components/*` (SEO head,
  header with accessible mobile nav, footer, logo).
- **Marketing/SEO pages** — `/`, `/pricing`, `/security`, `/docs`, `/self-host`
  (all crawlable, zero client JS beyond the header's nav enhancement).
- **Login** — `/login`: email magic-link form (`POST /api/auth/magic-link`) and
  the Telegram Login Widget (`POST /api/auth/telegram`).
- **Seams** — a same-origin API client (`src/lib/api.ts`, unit-tested),
  `robots.txt`, a custom 404, and a generated sitemap.

**In-browser crypto (`src/crypto/vault.ts`):** the client half of the
client-custody E2EE model, byte-compatible with the server's seal primitives
(`service/src/crypto/seal.ts`) — X25519 keypair, Argon2id KDF, `crypto_secretbox`
key wrapping, a one-time recovery kit, and the "EVA1" sealed-artifact envelope.
The passphrase and private key never leave the browser.

**React app island (`src/app/*`, mounted at `/app` via
`<AppIsland client:only="react" />`):** a hash-routed SPA — vault setup (with the
mandatory one-time recovery kit) and unlock, a dashboard that decrypts each
member's sealed secret locally, an add-member wizard that seals secrets to the
user's own key, a live run screen (SSE progress + 2FA + in-browser artifact
decryption + share-code reveal), and history. libsodium WASM is bundled **only**
into this island, so the marketing pages stay zero-JS.

## Commands

Run from the repo root with pnpm filters, or inside `web/`:

```bash
pnpm --filter @evisaflow/web dev      # astro dev (with /api proxy to Fastify)
pnpm --filter @evisaflow/web build    # astro build → web/dist (the green gate)
pnpm --filter @evisaflow/web preview  # preview the built site
pnpm --filter @evisaflow/web check    # astro check (type-check .astro/.ts/.tsx)
pnpm --filter @evisaflow/web test     # vitest (api client, vault crypto, member-secret, run-event + router)
```

## Dev proxy

`astro dev` serves the site on its own port (default 4321) while the API runs in
the Fastify process (default `:8080`). The Vite dev server proxies `/api/*` to
Fastify so the browser still talks to a same-origin `/api` and cookies flow. Set
the target if Fastify is elsewhere:

```bash
API_PROXY_TARGET=http://localhost:9000 pnpm --filter @evisaflow/web dev
```

In production this is moot — the same Fastify process serves both `web/dist` and
`/api`, so same-origin is literal.

## Public build-time env

These are **public** (exposed to the browser) and prefixed `PUBLIC_`. They are
not secrets.

| Variable                       | Purpose                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| `PUBLIC_TELEGRAM_BOT_USERNAME` | Bot username (no `@`) for the Telegram Login Widget on `/login`. When unset, the widget area shows a config hint and email login still works. |
| `PUBLIC_SITE_URL`              | Absolute site origin for canonical/OG URLs and the sitemap. Defaults to `https://evisaflow.uk`. |
