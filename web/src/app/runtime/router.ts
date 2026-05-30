/**
 * A minimal hash-based router for the app island — no routing dependency.
 *
 * The island is a `client:only` SPA mounted at `/app`. Using the URL hash
 * (`/app#/run/<id>`) keeps all navigation on the client: the static server only
 * ever serves `/app`, so there are no deep-link 404s and no SPA-fallback config
 * needed for in-app routes. Routes are simple strings; {@link useRoute} re-renders
 * on `hashchange`, and {@link navigate} updates the hash.
 */
import { useEffect, useState } from "react";

/** The app's screens, keyed off the hash path after `#`. */
export type Route =
  | { name: "dashboard" }
  | { name: "add-member" }
  | { name: "run"; runId?: string; memberId?: string }
  | { name: "history" };

/** Parses `location.hash` into a {@link Route}, defaulting to the dashboard. */
export function parseHash(hash: string): Route {
  // Normalise "#/run/abc" → "run/abc"; an empty/"#"/"#/" hash is the dashboard.
  const path = hash.replace(/^#\/?/, "").trim();
  if (path === "" || path === "dashboard") return { name: "dashboard" };
  if (path === "add-member") return { name: "add-member" };
  if (path === "history") return { name: "history" };
  const runMatch = path.match(/^run(?:\/([^/?]+))?(?:\?(.*))?$/);
  if (runMatch) {
    const runId = runMatch[1] ? decodeURIComponent(runMatch[1]) : undefined;
    const params = new URLSearchParams(runMatch[2] ?? "");
    const memberId = params.get("member") ?? undefined;
    return { name: "run", runId, memberId };
  }
  return { name: "dashboard" };
}

/** Builds the hash string for a {@link Route} (the inverse of {@link parseHash}). */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case "dashboard":
      return "#/dashboard";
    case "add-member":
      return "#/add-member";
    case "history":
      return "#/history";
    case "run": {
      const base = route.runId ? `#/run/${encodeURIComponent(route.runId)}` : "#/run";
      return route.memberId
        ? `${base}?member=${encodeURIComponent(route.memberId)}`
        : base;
    }
  }
}

/** Subscribes to the current route, re-rendering on hash changes. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window === "undefined" ? "" : window.location.hash)
  );
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    // Sync once on mount in case the hash was set before this effect ran.
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Navigates to a route by updating the URL hash. */
export function navigate(route: Route): void {
  window.location.hash = routeToHash(route);
}
