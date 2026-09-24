import { describe, expect, it } from "vitest";

import {
  ImapSmtpMailProvider,
  imapOptions,
  smtpOptions,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderAccount } from "@/modules/accounts/domain/mail-provider";

const account: ProviderAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  imap: {
    host: "imap.example.test",
    port: 993,
    security: "tls",
    username: "owner",
    password: "imap-secret",
  },
  smtp: {
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
    username: "owner",
    password: "smtp-secret",
  },
};

function factories(input?: {
  imapError?: Error & { code?: string };
  smtpError?: Error & { code?: string };
}) {
  const state = { imapClosed: 0, smtpClosed: 0 };
  const value: ProtocolClientFactories = {
    createImap: () => ({
      connect: async () => {
        if (input?.imapError) throw input.imapError;
      },
      logout: async () => undefined,
      close: () => {
        state.imapClosed += 1;
      },
    }),
    createSmtp: () => ({
      verify: async () => {
        if (input?.smtpError) throw input.smtpError;
      },
      close: () => {
        state.smtpClosed += 1;
      },
    }),
  };
  return { value, state };
}

describe("IMAP/SMTP connection provider", () => {
  it("returns separate successful results and closes both resources", async () => {
    const fake = factories();
    await expect(
      new ImapSmtpMailProvider(fake.value).testConnection(account),
    ).resolves.toEqual({ imap: { success: true }, smtp: { success: true } });
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("represents IMAP failure and SMTP success separately without raw errors", async () => {
    const error = Object.assign(
      new Error("login rejected with secret imap-secret"),
      { code: "EAUTH" },
    );
    const fake = factories({ imapError: error });
    const result = await new ImapSmtpMailProvider(fake.value).testConnection(
      account,
    );
    expect(result.imap).toEqual({
      success: false,
      category: "authentication_rejected",
      message: "IMAP authentication was rejected.",
    });
    expect(result.smtp).toEqual({ success: true });
    expect(JSON.stringify(result)).not.toContain("imap-secret");
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("represents IMAP success and SMTP failure separately and cleans up", async () => {
    const error = Object.assign(new Error("socket timed out smtp-secret"), {
      code: "ETIMEDOUT",
    });
    const fake = factories({ smtpError: error });
    const result = await new ImapSmtpMailProvider(fake.value).testConnection(
      account,
    );
    expect(result.imap).toEqual({ success: true });
    expect(result.smtp).toMatchObject({
      success: false,
      category: "connection_timeout",
    });
    expect(JSON.stringify(result)).not.toContain("smtp-secret");
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("maps implicit TLS and required STARTTLS without disabling certificate checks", () => {
    const implicit = imapOptions(account.imap);
    const starttls = smtpOptions(account.smtp);
    expect(implicit).toMatchObject({
      secure: true,
      doSTARTTLS: false,
      tls: { rejectUnauthorized: true },
    });
    expect(starttls).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true },
    });
  });
});
