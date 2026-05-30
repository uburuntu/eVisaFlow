import { describe, expect, it } from "vitest";
import { parseHash, type Route, routeToHash } from "./router.js";

/**
 * Tests for the hash router that drives in-app navigation. The parse/serialise
 * pair must round-trip so deep links (e.g. resuming a run) and the back button
 * resolve to the right screen.
 */
describe("parseHash", () => {
  it("defaults empty / unknown hashes to the dashboard", () => {
    expect(parseHash("")).toEqual({ name: "dashboard" });
    expect(parseHash("#")).toEqual({ name: "dashboard" });
    expect(parseHash("#/")).toEqual({ name: "dashboard" });
    expect(parseHash("#/nonsense")).toEqual({ name: "dashboard" });
  });

  it("parses the simple screens", () => {
    expect(parseHash("#/dashboard")).toEqual({ name: "dashboard" });
    expect(parseHash("#/add-member")).toEqual({ name: "add-member" });
    expect(parseHash("#/history")).toEqual({ name: "history" });
  });

  it("parses a run with an id", () => {
    expect(parseHash("#/run/abc-123")).toEqual({ name: "run", runId: "abc-123" });
  });

  it("parses a run with a member query and no id", () => {
    expect(parseHash("#/run?member=m-9")).toEqual({
      name: "run",
      runId: undefined,
      memberId: "m-9",
    });
  });

  it("decodes encoded ids", () => {
    expect(parseHash("#/run/a%2Fb")).toEqual({ name: "run", runId: "a/b" });
  });
});

describe("routeToHash round-trip", () => {
  const cases: Route[] = [
    { name: "dashboard" },
    { name: "add-member" },
    { name: "history" },
    { name: "run" },
    { name: "run", runId: "abc-123" },
    { name: "run", memberId: "m-9" },
    { name: "run", runId: "abc-123", memberId: "m-9" },
  ];
  for (const route of cases) {
    it(`round-trips ${JSON.stringify(route)}`, () => {
      const parsed = parseHash(routeToHash(route));
      // Normalise undefined optional fields for comparison.
      expect(parsed).toMatchObject(route);
    });
  }
});
