"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { MailAccountView } from "@/modules/accounts/application/accounts-service";

export function AccountList({ accounts }: { accounts: MailAccountView[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  async function mutate(
    id: string,
    action: "test" | "toggle" | "delete",
    enabled?: boolean,
  ) {
    if (
      action === "delete" &&
      !window.confirm("Delete this mail account? This action cannot be undone.")
    )
      return;
    setPending(id);
    setError(undefined);
    const response = await fetch(
      action === "toggle"
        ? `/api/accounts/${id}/enabled`
        : `/api/accounts/${id}${action === "test" ? "/test" : ""}`,
      {
        method:
          action === "toggle"
            ? "PATCH"
            : action === "delete"
              ? "DELETE"
              : "POST",
        headers:
          action === "delete"
            ? undefined
            : { "Content-Type": "application/json" },
        body:
          action === "toggle"
            ? JSON.stringify({ enabled })
            : action === "test"
              ? ""
              : undefined,
      },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(result.error ?? "The account action failed.");
    } else {
      router.refresh();
    }
    setPending(undefined);
  }

  if (accounts.length === 0) {
    return (
      <div className="empty-state">
        <h2>No mail accounts</h2>
        <p>
          Add your first email account to test and store its IMAP and SMTP
          configuration.
        </p>
        <Link className="button-link" href="/accounts/new">
          Add your first email account
        </Link>
      </div>
    );
  }

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <div className="account-list">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div>
              <h2>{account.displayName}</h2>
              <p>{account.email}</p>
              <p className="muted">
                {account.enabled ? "Enabled" : "Disabled"} ·{" "}
                {account.connectionStatus === "verified"
                  ? "Connection verified"
                  : account.connectionStatus === "error"
                    ? "Connection error"
                    : "Not yet verified"}
              </p>
              <p className="muted">
                Last successful test:{" "}
                {account.lastSuccessfulConnectionTestAt
                  ? new Date(
                      account.lastSuccessfulConnectionTestAt,
                    ).toLocaleString()
                  : "Never"}
              </p>
              {account.imapResult.error ? (
                <p className="error">IMAP: {account.imapResult.error}</p>
              ) : null}
              {account.smtpResult.error ? (
                <p className="error">SMTP: {account.smtpResult.error}</p>
              ) : null}
            </div>
            <div className="actions">
              <Link
                className="button-link secondary"
                href={`/accounts/${account.id}/edit`}
              >
                Edit
              </Link>
              <button
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "test")}
              >
                Test connection
              </button>
              <button
                className="secondary"
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "toggle", !account.enabled)}
              >
                {account.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="danger"
                disabled={pending === account.id}
                onClick={() => mutate(account.id, "delete")}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
