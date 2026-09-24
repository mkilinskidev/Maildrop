# Maildock

Maildock is a single-user, self-hosted web application intended to bring multiple email accounts into one browser interface.

Maildock is in **early development**. Phase 1A provides one-owner setup/login plus encrypted IMAP/SMTP account configuration and real connection verification. It does **not** synchronize mail, discover or persist mailboxes, send messages, fetch attachments, search mail, or render message content.

The authoritative design is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), governed by the accepted records in [`docs/adr/`](docs/adr/).

## Requirements

- Node.js 24.15 or newer in the Node 24 LTS line (the container pins 24.21.0)
- pnpm 12.6.0 through Corepack
- PostgreSQL 18 for direct local development
- Docker for the integration tests and Docker workflow

## Configuration and secrets

Copy `.env.example` to `.env` and replace every empty secret. Generate `AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` independently:

```sh
openssl rand -base64 32
```

`AUTH_SECRET` must decode to at least 32 bytes. `CREDENTIALS_ENCRYPTION_KEY` must be canonical base64 for exactly 32 random bytes. `CREDENTIALS_ENCRYPTION_KEY_ID` identifies that key (start with `v1`). Do not commit `.env`, place secrets in images, reuse keys, or print them in logs. Production should inject them using a secret manager, mounted secret, or protected orchestrator secret.

Mail account passwords are encrypted with AES-256-GCM using a fresh 96-bit IV, a 128-bit authentication tag, and account/protocol-bound AAD. The JSON envelope records format version, algorithm, key ID, IV, ciphertext, and tag. IMAP and SMTP use these exact AAD formats:

```text
maildock:account-credential:v1:<account-id>:imap
maildock:account-credential:v1:<account-id>:smtp
```

**Backup warning:** a PostgreSQL backup containing encrypted credentials is useless for credential recovery without the corresponding Maildock encryption key. Back up the key securely and separately from PostgreSQL. Losing it means stored provider credentials cannot be recovered and affected mail accounts must be reconfigured.

For controlled future rotation, `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS` accepts a JSON object such as `{"v1":"<old-base64-key>"}`. Keep the old key available, configure a new active key/ID, restart, re-encrypt every stored credential with fresh IVs through a reviewed operator procedure, verify it, and only then remove the old key. Phase 1A provides the multi-key decryption seam but no rotation UI or job.

`APP_ORIGIN` is the exact canonical browser origin. Production requires HTTPS. `ATTACHMENTS_PATH` must be absolute and readable/writable by Maildock.

Phase 0 intentionally has no password reset flow. Until a reviewed administrative recovery procedure is added, losing the owner password can require manual operator intervention. Back up PostgreSQL and the attachment volume as one logical recovery set.

## Local development

Start PostgreSQL (or provide another PostgreSQL 18 instance), fill `.env`, then run:

```sh
corepack enable
corepack prepare pnpm@12.6.0 --activate
pnpm install
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000/setup` for first-run owner creation. After setup, sign in at `/login`; `/` is the protected mail-account list. The owner username is immutable.

Useful commands:

```sh
pnpm dev
pnpm build
pnpm start
pnpm start:worker
pnpm lint
pnpm typecheck
pnpm test
pnpm db:generate
pnpm db:migrate
```

Integration tests start a disposable PostgreSQL 18 container and require a working Docker daemon.

## Docker

For a local two-service deployment, put development values in `.env` (including `APP_ORIGIN=http://localhost:3000`) and run:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The development override binds the app and PostgreSQL only to localhost. The production-oriented base file contains exactly `app` and `postgres`, does not publish PostgreSQL, and only exposes the app port to its private Compose network for an external reverse proxy.

The app entrypoint waits for Compose's PostgreSQL health check, runs migrations, then starts the web and worker composition roots. The same image can later run only one role by setting `MAILDOCK_ROLE=web` or `MAILDOCK_ROLE=worker`.

Health endpoints:

- `GET /api/health/live` checks only that the HTTP process is alive.
- `GET /api/health/ready` checks the database, migration foundation, and writable attachment storage without contacting mail providers or exposing internal errors.

Stop the stack with `docker compose -f docker-compose.yml -f docker-compose.dev.yml down`. Named PostgreSQL and attachment volumes are retained unless explicitly removed.

## Current data model

The `mail_accounts` table stores instance-owned account identity, non-secret provider settings, status, and JSONB encrypted password envelopes. It has no `user_id` and no plaintext credential column. Phase 1A adds no mailbox or message tables. Better Auth retains its separate infrastructure `account` table, and pg-boss manages its own schema.

## Mail accounts and connection testing

The owner can add, edit, enable/disable, retest, and delete accounts from `/`. Saving does not require a successful connection test: this deliberately permits configuration while a self-hosted provider is temporarily unavailable, and the account remains clearly unverified. Connection tests authenticate to IMAP and call SMTP verification without sending mail. TLS certificates and hostnames remain validated; STARTTLS mode requires a successful upgrade and never downgrades to plaintext.

Stored passwords are never returned to the browser. An empty password field on edit preserves its encrypted envelope; entering a replacement creates new ciphertext with a fresh random IV.
