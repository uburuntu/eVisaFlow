import pino from "pino";

export function createLogger(opts?: { verbose?: boolean }) {
  return pino({
    level: opts?.verbose ? "debug" : "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino/file", options: { destination: 1 } }
        : undefined,
  });
}

export type Logger = pino.Logger;
