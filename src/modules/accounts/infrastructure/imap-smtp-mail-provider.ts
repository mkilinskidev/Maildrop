import { ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import type {
  ConnectionFailureCategory,
  ConnectionReport,
  MailProvider,
  ProtocolConnectionResult,
  ProviderAccount,
  ProviderConnection,
} from "@/modules/accounts/domain/mail-provider";

const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;

type ImapClient = {
  connect(): Promise<unknown>;
  logout(): Promise<unknown>;
  close(): void;
};
type SmtpTransport = {
  verify(): Promise<unknown>;
  close(): void;
};

export type ProtocolClientFactories = Readonly<{
  createImap(options: ImapFlowOptions): ImapClient;
  createSmtp(options: SMTPTransport.Options): SmtpTransport;
}>;

const defaultFactories: ProtocolClientFactories = {
  createImap: (options) => new ImapFlow(options),
  createSmtp: (options) => nodemailer.createTransport(options),
};

export function imapOptions(connection: ProviderConnection): ImapFlowOptions {
  const starttls = connection.security === "starttls";
  return {
    host: connection.host,
    port: connection.port,
    secure: !starttls,
    doSTARTTLS: starttls,
    auth: { user: connection.username, pass: connection.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableAutoIdle: true,
    logger: false,
    tls: { rejectUnauthorized: true, servername: connection.host },
  };
}

export function smtpOptions(
  connection: ProviderConnection,
): SMTPTransport.Options {
  const starttls = connection.security === "starttls";
  return {
    host: connection.host,
    port: connection.port,
    secure: !starttls,
    requireTLS: starttls,
    ignoreTLS: false,
    auth: { user: connection.username, pass: connection.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true, servername: connection.host },
  };
}

function sanitizeError(
  error: unknown,
  protocol: "IMAP" | "SMTP",
): Exclude<ProtocolConnectionResult, { success: true }> {
  const candidate = error as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  const code =
    typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  const message =
    typeof candidate?.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  let category: ConnectionFailureCategory = "internal_error";

  if (code === "EAUTH" || /auth|credential|login|password/.test(message)) {
    category = "authentication_rejected";
  } else if (/starttls/.test(message)) {
    category = "starttls_unavailable";
  } else if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code) ||
    /certificate|tls|ssl/.test(message)
  ) {
    category = "tls_certificate_failure";
  } else if (code === "ETIMEDOUT" || /timed? out|timeout/.test(message)) {
    category = "connection_timeout";
  } else if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(code)
  ) {
    category = "dns_or_host_unreachable";
  } else if (protocol === "SMTP") {
    category = "verification_failed";
  }

  const descriptions: Record<ConnectionFailureCategory, string> = {
    dns_or_host_unreachable: "DNS lookup failed or the host is unreachable.",
    connection_timeout: "The connection timed out.",
    tls_certificate_failure: "TLS certificate validation failed.",
    authentication_rejected: `${protocol} authentication was rejected.`,
    starttls_unavailable: `${protocol} did not provide the required STARTTLS upgrade.`,
    verification_failed: "SMTP verification failed.",
    internal_error: `${protocol} connection failed.`,
  };
  return { success: false, category, message: descriptions[category] };
}

export class ImapSmtpMailProvider implements MailProvider {
  constructor(
    private readonly factories: ProtocolClientFactories = defaultFactories,
  ) {}

  async testConnection(account: ProviderAccount): Promise<ConnectionReport> {
    return {
      imap: await this.testImap(account.imap),
      smtp: await this.testSmtp(account.smtp),
    };
  }

  private async testImap(
    connection: ProviderConnection,
  ): Promise<ProtocolConnectionResult> {
    const client = this.factories.createImap(imapOptions(connection));
    try {
      await client.connect();
      await client.logout();
      return { success: true };
    } catch (error) {
      return sanitizeError(error, "IMAP");
    } finally {
      client.close();
    }
  }

  private async testSmtp(
    connection: ProviderConnection,
  ): Promise<ProtocolConnectionResult> {
    const transport = this.factories.createSmtp(smtpOptions(connection));
    try {
      await transport.verify();
      return { success: true };
    } catch (error) {
      return sanitizeError(error, "SMTP");
    } finally {
      transport.close();
    }
  }
}
