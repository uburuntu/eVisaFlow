/**
 * Tiny same-origin API client for the eVisaFlow web app.
 *
 * Every call targets the API at a same-origin `/api/*` path so the browser sends
 * the session cookie (`HttpOnly; Secure; SameSite=Lax`). In production the same
 * Fastify process serves both this static bundle and the API, so same-origin is
 * literal; during `astro dev` the Vite dev proxy forwards `/api` to Fastify (see
 * astro.config.mjs), so the very same relative paths work there too.
 *
 * This module is intentionally framework-agnostic and dependency-free: the
 * marketing/login pages use a sliver of it, and the React app island reuses it
 * later. It NEVER stores credentials — auth is cookie-based and owned by the
 * server. No request/response body is logged here.
 */

/** Root path all endpoints hang off. Same-origin by construction. */
export const API_BASE = "/api";

/** A failed API call: carries the HTTP status and the parsed `error` code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message?: string) {
    super(message ?? code ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Builds a same-origin URL for an API path (leading slash optional). */
export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${suffix}`;
}

/**
 * Reads the JSON `{ error }` code from a failed response without throwing if the
 * body is empty or not JSON (some endpoints reply 204/empty). Returns undefined
 * when no code can be parsed.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.clone().json()) as { error?: unknown };
    return typeof data?.error === "string" ? data.error : undefined;
  } catch {
    return undefined;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  /** JSON-serialisable body; sets `content-type: application/json` for you. */
  json?: unknown;
}

/**
 * Performs a same-origin `fetch` with credentials, JSON encoding, and uniform
 * error handling. Resolves to the parsed JSON body (typed by the caller) for 2xx
 * responses, or `undefined` for an empty/204 response. Throws {@link ApiError}
 * for any non-2xx status, carrying the server's `error` code when present.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T | undefined> {
  const { json, headers, ...rest } = options;
  const init: RequestInit = {
    // Always send the session cookie; the API and SPA are same-origin.
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    ...rest,
  };

  const response = await fetch(apiUrl(path), init);

  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new ApiError(response.status, code);
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text) as T;
}
