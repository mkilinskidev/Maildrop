import { ImapFlow, type ImapFlowOptions, type ListResponse } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import {
  MailProviderOperationError,
  relevantImapCapabilities,
  type ConnectionFailureCategory,
  type ConnectionReport,
  type MailboxDiscoveryResult,
  type MailProvider,
  type ProtocolConnectionResult,
  type ProviderAccount,
  type ProviderConnection,
  type ProviderImapAccount,
  type RemoteMailbox,
  type RelevantImapCapability,
} from "../domain/mail-provider";

const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;

type ImapClient = {
  connect(): Promise<unknown>;
  list(options?: {
    statusQuery?: {
      messages?: boolean;
      unseen?: boolean;
      uidNext?: boolean;
      uidValidity?: boolean;
      highestModseq?: boolean;
    };
  }): Promise<ListResponse[]>;
  capabilities: Map<string, boolean | number>;
  enabled: Set<string>;
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

const STANDARD_SPECIAL_USE = new Set([
  "\\All",
  "\\Archive",
  "\\Drafts",
  "\\Flagged",
  "\\Junk",
  "\\Sent",
  "\\Trash",
]);

function decimal(value: number | bigint | undefined): string | undefined {
  return value === undefined ? undefined : value.toString(10);
}

export function normalizeMailbox(mailbox: ListResponse): RemoteMailbox {
  const attributes = [...mailbox.flags].sort();
  const specialUse = attributes.filter((attribute) =>
    STANDARD_SPECIAL_USE.has(attribute),
  );
  // INBOX is protocol-defined by its case-insensitive path, not guessed from a
  // localized display name. Other ImapFlow name heuristics are deliberately ignored.
  if (mailbox.path.toUpperCase() === "INBOX") specialUse.unshift("\\Inbox");
  if (
    mailbox.specialUseSource === "extension" &&
    mailbox.specialUse &&
    !specialUse.includes(mailbox.specialUse)
  ) {
    specialUse.push(mailbox.specialUse);
  }

  return {
    remotePath: mailbox.path,
    name: mailbox.name,
    delimiter: mailbox.delimiter || null,
    attributes,
    selectable:
      !mailbox.flags.has("\\Noselect") && !mailbox.flags.has("\\NonExistent"),
    specialUse,
    // ImapFlow intentionally reports true when no subscription source answers,
    // so only a reported false can be represented as reliable here.
    ...(mailbox.subscribed === false ? { subscribed: false } : {}),
    ...(mailbox.status?.messages === undefined
      ? {}
      : { messageCount: decimal(mailbox.status.messages) }),
    ...(mailbox.status?.unseen === undefined
      ? {}
      : { unseenCount: decimal(mailbox.status.unseen) }),
    ...(mailbox.status?.uidValidity === undefined
      ? {}
      : { uidValidity: decimal(mailbox.status.uidValidity) }),
    ...(mailbox.status?.uidNext === undefined
      ? {}
      : { uidNext: decimal(mailbox.status.uidNext) }),
    ...(mailbox.status?.highestModseq === undefined
      ? {}
      : { highestModseq: decimal(mailbox.status.highestModseq) }),
  };
}

export function normalizeCapabilities(
  capabilities: Iterable<string>,
  enabled: Iterable<string>,
): RelevantImapCapability[] {
  const available = new Set(
    [...capabilities, ...enabled].map((capability) => capability.toUpperCase()),
  );
  return relevantImapCapabilities.filter((capability) =>
    available.has(capability),
  );
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

  async listMailboxes(
    account: ProviderImapAccount,
  ): Promise<MailboxDiscoveryResult> {
    const client = this.factories.createImap(imapOptions(account.imap));
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const listed = await client.list({
        statusQuery: {
          messages: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
          highestModseq: true,
        },
      });
      return {
        capabilities: normalizeCapabilities(
          client.capabilities.keys(),
          client.enabled,
        ),
        mailboxes: listed.map(normalizeMailbox),
      };
    } catch (error) {
      throw new MailProviderOperationError(sanitizeError(error, "IMAP"));
    } finally {
      if (connected) {
        try {
          await client.logout();
        } catch {
          // The discovery result/failure remains authoritative; close below.
        }
      }
      client.close();
    }
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
