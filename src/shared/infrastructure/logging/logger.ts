import pino from "pino";

import type { AppConfig } from "../config/config.js";

export function createLogger(config: Pick<AppConfig, "logLevel">) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "password",
        "*.password",
        "**.password",
        "auth.pass",
        "*.auth.pass",
        "**.auth.pass",
        "secret",
        "token",
        "authorization",
        "cookie",
        "req.headers.authorization",
        "req.headers.cookie",
        "databaseUrl",
        "authSecret",
        "credentialsEncryptionKey",
        "credentialsEncryption",
      ],
      censor: "[REDACTED]",
    },
  });
}
