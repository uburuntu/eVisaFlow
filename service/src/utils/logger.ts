import pino from "pino";

export const redactSensitiveText = (value: string): string =>
  value
    .replace(/\b[A-Z0-9]{3}\s?[A-Z0-9]{3}\s?[A-Z0-9]{3}\b/gi, "[share-code]")
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, "[date]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[date]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
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

export function createLogger(opts?: { verbose?: boolean }) {
  return pino({
    level: opts?.verbose ? "debug" : "info",
    redact: {
      paths: [
        "*.text",
        "*.caption",
        "*.token",
        "*.TELEGRAM_BOT_TOKEN",
        "*.SUPABASE_SERVICE_ROLE_KEY",
        "*.ENCRYPTION_KEY",
        "*.shareCode",
        "*.dateOfBirth",
        "*.documentNumber",
        "*.securityCode",
        "*.otp",
        "*.authorization",
        "headers.authorization",
        "req.headers.authorization",
        "*.applicant.dateOfBirth",
        "*.applicant.identityDocument.number",
        "*.identityDocument.number",
        "*.url",
        "update.message.text",
        "update.message.caption",
        "update.callback_query.message.text",
        "update.callback_query.message.caption",
      ],
      censor: "[redacted]",
    },
    serializers: {
      err: errorSerializer,
      error: errorSerializer,
    },
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino/file", options: { destination: 1 } }
        : undefined,
  });
}

export type Logger = pino.Logger;
