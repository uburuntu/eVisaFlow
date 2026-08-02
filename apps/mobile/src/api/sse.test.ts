import { describe, expect, it } from "vitest";
import { ServerSentEventParser } from "./sse";

describe("ServerSentEventParser", () => {
  it("reassembles split frames and ignores heartbeats", () => {
    const parser = new ServerSentEventParser();
    expect(parser.push(": heartbeat\n\nid: 4\nevent: phase\nda")).toEqual([]);
    expect(parser.push('ta: {"id":4}\n\n')).toEqual([
      { id: "4", event: "phase", data: '{"id":4}' },
    ]);
  });

  it("supports CRLF and joins multiline data", () => {
    const parser = new ServerSentEventParser();
    expect(parser.push("id: 7\r\ndata: first\r\ndata: second\r\n\r\n")).toEqual([
      { id: "7", data: "first\nsecond" },
    ]);
  });
});
