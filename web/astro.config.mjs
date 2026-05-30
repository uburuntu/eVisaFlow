// @ts-check
import { createRequire } from "node:module";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

/**
 * Resolve `libsodium-wrappers-sumo` to its CommonJS entry for the browser bundle.
 *
 * The vault (`src/crypto/vault.ts`) needs the "sumo" build for Argon2id
 * (`crypto_pwhash`). That package's ESM entry does `import "./libsodium-sumo.mjs"`
 * — a SIBLING path that does not exist under pnpm's non-hoisted layout (the real
 * file lives in the separate `libsodium-sumo` package), so Rollup cannot resolve
 * it and the build fails. Its CommonJS entry instead does `require("libsodium-sumo")`
 * (a bare specifier Vite/Rollup resolves correctly) and inlines the WASM, so we
 * alias the package to that build. Vite's commonjs interop bundles it for the
 * browser; the WASM still loads and runs in-page, and every byte stays identical
 * to the server's standard build. (`vitest.config.ts` applies the same alias for
 * the Node test runtime.)
 */
const require = createRequire(import.meta.url);
const libsodiumSumoCjs = require.resolve("libsodium-wrappers-sumo");

/**
 * Astro configuration for the eVisaFlow web app.
 *
 * Output is fully static (`output: "static"`): the marketing/SEO pages and the
 * `/app` shell are pre-rendered to plain HTML/CSS/JS and served by the Fastify
 * web server from `web/dist` in self-host — there is NO Astro SSR server. The
 * React integration powers the interactive `client:*` islands (the E2EE app
 * island ships in a later step); marketing pages stay zero-JS.
 *
 * The API is always called same-origin at `/api/*` so the browser sends the
 * session cookie (`HttpOnly; Secure; SameSite=Lax`). In production the same
 * Fastify process serves both the static bundle and the API, so same-origin is
 * literal. During `astro dev` the two run on different ports, so the dev server
 * proxies `/api` (and the magic-link verify redirect target) to Fastify; set
 * `API_PROXY_TARGET` to point at a non-default Fastify port.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  output: "static",
  // Absolute base origin of the deployed site. Used to emit canonical URLs and
  // absolute Open Graph URLs in <head>. Overridable per environment; defaults to
  // the production origin. Not a secret.
  site: process.env.PUBLIC_SITE_URL ?? "https://evisaflow.uk",
  integrations: [
    react(),
    // Generates `sitemap-index.xml` (+ a `sitemap-0.xml`) from the static pages
    // for crawlers; the public, indexable marketing pages are included. The
    // authenticated `/app` shell is `noindex` and excluded below.
    sitemap({
      filter: (page) => !page.includes("/app"),
    }),
  ],
  // Keep the build output predictable for the Fastify static mount: directory
  // style means each route is `route/index.html`, which serves cleanly under
  // `@fastify/static` without extension rewrites.
  build: {
    format: "directory",
  },
  vite: {
    resolve: {
      alias: {
        // Steer the browser bundle to the CJS sumo build (see note above): the
        // ESM entry's sibling import breaks under pnpm.
        "libsodium-wrappers-sumo": libsodiumSumoCjs,
      },
    },
    server: {
      proxy: {
        // Forward every API call to the Fastify backend during local dev so the
        // browser still talks to a same-origin `/api/*` and cookies flow. SSE
        // (`/api/runs/:id/events`) needs buffering disabled to stream promptly.
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          // EventSource keeps a long-lived connection; do not let the proxy
          // buffer or time it out aggressively.
          ws: false,
        },
      },
    },
  },
});
