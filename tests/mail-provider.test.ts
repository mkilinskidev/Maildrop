import { describe, expect, it } from "vitest";

import {
  ImapSmtpMailProvider,
  imapOptions,
  normalizeCapabilities,
  normalizeMailbox,
  smtpOptions,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderAccount } from "@/modules/accounts/domain/mail-provider";
import type { ListResponse } from "imapflow";

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
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {
        if (input?.imapError) throw input.imapError;
      },
      list: async () => [],
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

function listed(
  input: Partial<ListResponse> & Pick<ListResponse, "path" | "name">,
): ListResponse {
  return {
    pathAsListed: input.path,
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set(),
    listed: true,
    subscribed: true,
    ...input,
  };
}

describe("IMAP mailbox normalization", () => {
  it("normalizes INBOX and status observations without using Recent", () => {
    expect(
      normalizeMailbox(
        listed({
          path: "INBOX",
          name: "INBOX",
          flags: new Set(["\\HasNoChildren"]),
          status: {
            path: "INBOX",
            messages: 1284,
            unseen: 12,
            recent: 99,
            uidNext: 2000,
            uidValidity: 4294967295n,
          },
        }),
      ),
    ).toEqual({
      remotePath: "INBOX",
      name: "INBOX",
      delimiter: "/",
      attributes: ["\\HasNoChildren"],
      selectable: true,
      specialUse: ["\\Inbox"],
      messageCount: "1284",
      unseenCount: "12",
      uidValidity: "4294967295",
      uidNext: "2000",
    });
  });

  it("preserves a non-slash hierarchy delimiter, Noselect, and unknown attributes", () => {
    const result = normalizeMailbox(
      listed({
        path: "Archive.2025",
        name: "2025",
        delimiter: ".",
        flags: new Set(["\\Noselect", "\\VendorExtension"]),
        subscribed: false,
      }),
    );
    expect(result).toMatchObject({
      remotePath: "Archive.2025",
      delimiter: ".",
      selectable: false,
      attributes: ["\\Noselect", "\\VendorExtension"],
      subscribed: false,
    });
  });

  it("keeps server SPECIAL-USE and ignores name-derived folder heuristics", () => {
    expect(
      normalizeMailbox(
        listed({
          path: "Localized",
          name: "Localized",
          flags: new Set(["\\Sent", "\\XCustom"]),
          specialUse: "\\Sent",
          specialUseSource: "extension",
        }),
      ).specialUse,
    ).toEqual(["\\Sent"]);
    expect(
      normalizeMailbox(
        listed({
          path: "Sent by name only",
          name: "Sent by name only",
          specialUse: "\\Sent",
          specialUseSource: "name",
        }),
      ).specialUse,
    ).toEqual([]);
  });

  it("allows missing status and preserves large MODSEQ values exactly", () => {
    expect(
      normalizeMailbox(listed({ path: "Empty", name: "Empty" })),
    ).not.toHaveProperty("uidValidity");
    expect(
      normalizeMailbox(
        listed({
          path: "Large",
          name: "Large",
          status: {
            path: "Large",
            highestModseq: 18_446_744_073_709_551_615n,
          },
        }),
      ).highestModseq,
    ).toBe("18446744073709551615");
  });

  it("captures only synchronization-relevant capabilities", () => {
    expect(
      normalizeCapabilities(
        ["IMAP4rev2", "IDLE", "MOVE", "AUTH=PLAIN", "LIST-STATUS"],
        ["CONDSTORE", "QRESYNC"],
      ),
    ).toEqual([
      "IMAP4REV2",
      "IDLE",
      "CONDSTORE",
      "QRESYNC",
      "MOVE",
      "LIST-STATUS",
    ]);
  });
});
