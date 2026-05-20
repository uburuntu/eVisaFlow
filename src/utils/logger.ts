import pino, { type Logger as PinoLogger } from "pino";
import type { Logger } from "../core/internal-types.js";

export interface LoggerOptions {
  verbose: boolean;
}

const redactSensitiveText = (value: string): string =>
  value
    .replace(/\b[A-Z0-9]{3}\s?[A-Z0-9]{3}\s?[A-Z0-9]{3}\b/gi, "[share-code]")
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, "[date]")
    .replace(
      /([?&](?:session_code|execution|tab_id|token|state|code)=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(/https?:\/\/\S+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[url]";
      }
    });

const errorSerializer = (error: Error): Record<string, unknown> => ({
  type: error.name,
  message: redactSensitiveText(error.message),
  stack: error.stack ? redactSensitiveText(error.stack) : undefined,
});

export const createLogger = (options: LoggerOptions): Logger => {
  const baseLogger: PinoLogger = pino({
    level: options.verbose ? "debug" : "info",
    redact: {
      paths: ["*.token", "*.code", "*.shareCode", "*.dateOfBirth", "*.url"],
      censor: "[redacted]",
    },
    serializers: {
      error: errorSerializer,
      err: errorSerializer,
    },
  });

  return {
    step(stepId, message) {
      baseLogger.info({ step: stepId }, message);
    },
    action(action, detail) {
      baseLogger.debug({ action, detail }, "action");
    },
    info(message, meta) {
      baseLogger.info(meta ?? {}, message);
    },
    warn(message, meta) {
      baseLogger.warn(meta ?? {}, message);
    },
    error(message, meta) {
      baseLogger.error(meta ?? {}, message);
    },
    debug(message, meta) {
      baseLogger.debug(meta ?? {}, message);
    },
    screenshot(label) {
      baseLogger.debug({ label }, "screenshot");
    },
  };
};
