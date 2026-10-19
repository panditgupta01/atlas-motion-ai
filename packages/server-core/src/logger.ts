import { pino, type Logger } from "pino";

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", "password", "*.password", "passwordHash", "*.apiKey"],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
