import pino, { Logger as PinoLogger } from "pino";
import type { Logger } from "../types.js";

export interface LoggerOptions {
  verbose: boolean;
}

export const createLogger = (options: LoggerOptions): Logger => {
  const baseLogger: PinoLogger = pino({
    level: options.verbose ? "debug" : "info",
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
