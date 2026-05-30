import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, apiUrl } from "./api.js";

/**
 * Unit tests for the same-origin API client. These verify the contract the
 * login page and the later React island rely on: relative `/api` URLs, cookies
 * always sent, JSON bodies encoded with the right header, empty/204 responses
 * mapped to `undefined`, and non-2xx responses surfaced as a typed
 * {@link ApiError} carrying the server's `error` code.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(response: Response) {
  const spy = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("apiUrl", () => {
  it("prefixes /api and tolerates a missing leading slash", () => {
    expect(apiUrl("/auth/me")).toBe("/api/auth/me");
    expect(apiUrl("auth/me")).toBe("/api/auth/me");
  });
});

describe("apiFetch", () => {
  it("sends cookies and parses a JSON 200 body", async () => {
    const spy = mockFetchOnce(
      new Response(JSON.stringify({ id: "u1", email: "a@b.co" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const body = await apiFetch<{ id: string }>("/auth/me");

    expect(body).toEqual({ id: "u1", email: "a@b.co" });
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/auth/me");
    expect(init?.credentials).toBe("same-origin");
  });

  it("encodes a JSON body and sets the content-type header", async () => {
    const spy = mockFetchOnce(new Response(null, { status: 204 }));

    const result = await apiFetch("/auth/magic-link", {
      method: "POST",
      json: { email: "person@example.com" },
    });

    expect(result).toBeUndefined();
    const init = spy.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ email: "person@example.com" }));
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("maps an empty 200 response to undefined", async () => {
    mockFetchOnce(new Response("", { status: 200 }));
    await expect(apiFetch("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("throws ApiError with the server error code on non-2xx", async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(apiFetch("/auth/me")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "unauthorized",
    });
  });

  it("throws ApiError with undefined code when the error body is not JSON", async () => {
    mockFetchOnce(new Response("Bad Gateway", { status: 502 }));

    const error = await apiFetch("/auth/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBeUndefined();
  });
});
