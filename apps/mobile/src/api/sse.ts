export interface ServerSentEvent {
  id?: string;
  event?: string;
  data: string;
}

export class ServerSentEventParser {
  private buffer = "";

  push(chunk: string): ServerSentEvent[] {
    this.buffer += chunk;
    const events: ServerSentEvent[] = [];
    let boundary = eventBoundary(this.buffer);
    while (boundary) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const parsed = parseFrame(frame);
      if (parsed) events.push(parsed);
      boundary = eventBoundary(this.buffer);
    }
    return events;
  }
}

function eventBoundary(value: string): { index: number; length: number } | null {
  const unixIndex = value.indexOf("\n\n");
  const windowsIndex = value.indexOf("\r\n\r\n");
  if (unixIndex < 0 && windowsIndex < 0) return null;
  if (unixIndex < 0) return { index: windowsIndex, length: 4 };
  if (windowsIndex < 0 || unixIndex < windowsIndex) {
    return { index: unixIndex, length: 2 };
  }
  return { index: windowsIndex, length: 4 };
}

function parseFrame(frame: string): ServerSentEvent | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.replaceAll("\r\n", "\n").split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    let value = separator < 0 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event ? { event } : {}),
    data: data.join("\n"),
  };
}
