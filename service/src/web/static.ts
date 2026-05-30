import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { Logger } from "../utils/logger.js";
import type { WebFastifyInstance } from "./server.js";

/**
 * Serves the built Astro web bundle (`web/dist`) from the same Fastify origin as
 * the API, so the SPA and `/api/*` share one host (cookies are literally
 * same-origin) and self-host is a single process — no separate static server, no
 * Astro SSR.
 *
 * Two concerns, kept in one place:
 *
 * 1. **Static files.** `@fastify/static` with `wildcard: false` globs the built
 *    files at registration and registers one route per real file (including each
 *    directory's `index.html`, because Astro builds with `format: "directory"`).
 *    A request for a path that is NOT a real file therefore matches no route and
 *    falls through to the not-found handler below — it does NOT install a catch-all
 *    `/*`, so the API and health routes keep their precedence.
 * 2. **SPA fallback.** The app island is a single client-routed SPA mounted at
 *    `/app`; only `web/dist/app/index.html` exists on disk, so a deep link like
 *    `/app/run/123` (or any unknown `/app/*`) has no file. The not-found handler
 *    serves the app shell for those, letting the in-browser router take over.
 *    `/api/*` (and the `/ready`/`/live` probes) keep returning JSON 404s so API
 *    clients never receive HTML.
 *
 * Degrades gracefully: if the bundle is absent (e.g. the API is run without first
 * building `web`), nothing is registered and a one-line hint is logged. The API
 * and health endpoints stay fully functional; only the browser app is missing.
 */
export interface StaticAssetsDeps {
  /** Absolute (or cwd-relative) path to the built `web/dist` directory. */
  webDistPath: string;
  log: Logger;
}

/**
 * Path prefix the client-routed SPA owns. Any unmatched GET/HEAD navigation under
 * this prefix is rewritten to the app shell so deep links and reloads work.
 */
const APP_PREFIX = "/app";

/**
 * Request path prefixes that must NEVER fall back to HTML. API and health
 * endpoints answer JSON (or stream bytes); a 404 there has to stay a JSON 404 so
 * `fetch`/`EventSource` callers get a machine-readable error rather than the app
 * shell. Everything the server mounts programmatically lives under one of these.
 */
const NON_SPA_PREFIXES = ["/api", "/ready", "/live"];

/** True when `pathname` is `/app` exactly or anything under `/app/`. */
function isAppRoute(pathname: string): boolean {
  return pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`);
}

/** True when `pathname` is owned by the API/health layer (never HTML-fallback). */
function isApiRoute(pathname: string): boolean {
  return NON_SPA_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Registers static serving of `web/dist` plus the SPA fallback on `app`.
 *
 * Call this AFTER the API and health routes are registered: those are concrete
 * routes and always win the router match; this only adds file routes and a
 * not-found handler, neither of which can shadow an existing route. Returns
 * `true` when the bundle was found and mounted, `false` when it was absent (so
 * callers/tests can assert the graceful-degradation path).
 */
export function registerStaticAssets(
  app: WebFastifyInstance,
  deps: StaticAssetsDeps
): boolean {
  const { log } = deps;
  const root = path.resolve(deps.webDistPath);
  const indexPath = path.join(root, "index.html");

  // The directory alone is not enough — an empty or partial `web/dist` would let
  // `@fastify/static` register with nothing to serve. Gate on the shell entry
  // file so "the web app was built" is what actually decides registration.
  if (!existsSync(indexPath)) {
    log.warn(
      { webDistPath: root },
      "Web bundle not found (no index.html); serving API only. " +
        "Build it with `pnpm --filter @evisaflow/web build`, or set WEB_DIST_PATH " +
        "to the built bundle."
    );
    return false;
  }

  // `wildcard: false` → one route per real file (no catch-all `/*`), so API and
  // health routes keep precedence and unknown paths reach the not-found handler.
  // `decorateReply` (default true) installs `reply.sendFile`, used by the SPA
  // fallback below. `index: ["index.html"]` makes each directory resolve to its
  // `index.html` (Astro's `format: "directory"` output), served at the
  // trailing-slash URL (e.g. `/security/`).
  //
  // NOTE: we deliberately do NOT pass `redirect: true` (which would auto-redirect
  // bare directory paths to their trailing-slash form): combined with the root
  // `index.html` it makes the plugin register a redirect route with an empty
  // path, which Fastify's router rejects ("path could not be empty"). The
  // not-found handler below resolves the bare-path → trailing-slash case itself.
  app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: ["index.html"],
  });

  // SPA fallback. Fires for any request that matched no concrete route and no
  // static file. `/app/*` deep links render the app shell; API/health misses stay
  // JSON 404; other unknown navigations get the prebuilt 404 page when present.
  const notFoundPagePath = path.join(root, "404.html");
  const hasNotFoundPage = existsSync(notFoundPagePath);

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;

    // API/health 404s are JSON, matching Fastify's default not-found shape, so
    // programmatic callers never receive the HTML shell.
    if (isApiRoute(pathname)) {
      return reply.code(404).send({
        message: `Route ${request.method}:${pathname} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }

    // Only navigations (GET/HEAD) get HTML; other verbs on an unknown path are a
    // genuine 404, not an app load.
    const isNavigation = request.method === "GET" || request.method === "HEAD";

    if (isNavigation && isAppRoute(pathname)) {
      // Deep link / reload inside the client-routed app → serve the shell and let
      // the in-browser router resolve the rest. `app/index.html` is a real file
      // (Astro emits it), so this streams a 200 and never re-enters this handler.
      return reply.type("text/html").sendFile("app/index.html");
    }

    // Bare directory path (`/security`) → 301 to its trailing-slash canonical
    // (`/security/`) when the directory's `index.html` exists. Astro's
    // directory-format output registers pages only at the trailing-slash URL, so
    // a user who types or links the slash-less form would otherwise hit the 404
    // below. We redirect (rather than serve the file here) to keep a single
    // canonical URL matching the page's <link rel="canonical">. The traversal
    // guard rejects any `..` that would resolve outside the bundle root.
    if (isNavigation && pathname.length > 1 && !pathname.endsWith("/")) {
      const candidateDir = path.join(root, pathname);
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (
        candidateDir.startsWith(rootWithSep) &&
        existsSync(path.join(candidateDir, "index.html"))
      ) {
        const query = request.url.slice(pathname.length); // preserves "?..."
        return reply.redirect(`${pathname}/${query}`, 301);
      }
    }

    if (isNavigation && hasNotFoundPage) {
      // Unknown non-app navigation (a stale marketing link, a typo): serve the
      // styled 404 page Astro built, with a real 404 status.
      return reply.code(404).type("text/html").sendFile("404.html");
    }

    // Non-navigation, or no built 404 page: plain JSON 404.
    return reply.code(404).send({
      message: `Route ${request.method}:${pathname} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  log.info(
    { webDistPath: root },
    "Serving web bundle from Fastify (SPA fallback on /app)"
  );
  return true;
}
