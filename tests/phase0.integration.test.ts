import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  initializeOwner,
  InstanceAlreadyInitializedError,
  isInstanceInitialized,
} from "@/modules/auth/application/instance-auth";
import { checkOwnerApiAccess } from "@/modules/auth/application/api-access-check";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { getValidSession } from "@/modules/auth/application/session-validation";
import { createAuth } from "@/modules/auth/infrastructure/auth-factory";
import { JobRuntime } from "@/modules/jobs/infrastructure/job-runtime";
import { checkReadiness } from "@/modules/platform/infrastructure/readiness";
import {
  parseConfig,
  type AppConfig,
} from "@/shared/infrastructure/config/config";
import {
  createDatabase,
  type Database,
} from "@/shared/infrastructure/database/database";
import {
  account,
  instanceState,
  loginThrottle,
  mailAccounts,
  rateLimit,
  session,
  user,
  verification,
} from "@/shared/infrastructure/database/schema";
import pino from "pino";

describe("Phase 0 PostgreSQL foundations", () => {
  let container: StartedTestContainer | undefined;
  let database: ReturnType<typeof createDatabase>;
  let db: Database;
  let config: AppConfig;
  let attachmentsPath: string;

  beforeAll(async () => {
    let databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      container = await new GenericContainer("postgres:18.6-bookworm")
        .withEnvironment({
          POSTGRES_DB: "maildock_test",
          POSTGRES_USER: "maildock",
          POSTGRES_PASSWORD: "maildock-test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start();
      databaseUrl = `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_test`;
    }
    attachmentsPath = await mkdtemp(path.join(tmpdir(), "maildock-test-"));
    config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: attachmentsPath,
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    db = database.db;
    await migrate(db, { migrationsFolder: "db/migrations" });
  });

  beforeEach(async () => {
    await db.delete(mailAccounts);
    await db.delete(session);
    await db.delete(account);
    await db.delete(user);
    await db.delete(verification);
    await db.delete(rateLimit);
    await db.delete(loginThrottle);
    await db.update(instanceState).set({
      initializedAt: null,
      passwordAlgorithm: null,
      passwordParameters: null,
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (attachmentsPath)
      await rm(attachmentsPath, { recursive: true, force: true });
  });

  it("allows setup while uninitialized and creates exactly one owner", async () => {
    expect(await isInstanceInitialized(db)).toBe(false);
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    expect(await isInstanceInitialized(db)).toBe(true);
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it("rejects setup after initialization", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    await expect(
      initializeOwner(db, {
        username: "another",
        password: "another sufficiently long password",
      }),
    ).rejects.toBeInstanceOf(InstanceAlreadyInitializedError);
    expect(await db.select().from(user)).toHaveLength(1);
  });

  it("serializes concurrent setup so only one owner can be created", async () => {
    const results = await Promise.allSettled([
      initializeOwner(db, {
        username: "first",
        password: "first sufficiently long password",
      }),
      initializeOwner(db, {
        username: "second",
        password: "second sufficiently long password",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await db.select().from(user)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it("rejects an unauthenticated request and accepts an authenticated session", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    const testAuth = createAuth(config, db);
    expect(await getValidSession(testAuth, new Headers())).toBeNull();

    const loginResponse = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          username: "owner",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookie?.split(";")[0] ?? "";
    expect(
      await getValidSession(testAuth, new Headers({ cookie })),
    ).not.toBeNull();

    const logoutResponse = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          cookie,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(logoutResponse.status).toBe(200);
    expect(await getValidSession(testAuth, new Headers({ cookie }))).toBeNull();
  });

  it("reports readiness only when migrations, database, and attachment storage are available", async () => {
    await mkdir(attachmentsPath, { recursive: true });
    expect(await checkReadiness({ config, query: database.client })).toBe(true);
    await database.client.end();
    expect(await checkReadiness({ config, query: database.client })).toBe(
      false,
    );
    database = createDatabase(config);
    db = database.db;
  });

  it("starts pg-boss, processes a probe job, and shuts down gracefully", async () => {
    const jobs = new JobRuntime(config, pino({ level: "silent" }));
    await jobs.start();
    const queue = `maildock-test-${Date.now()}`;
    await jobs.boss.createQueue(queue);

    const completed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Probe job timed out.")),
        20_000,
      );
      void jobs.boss.work<{ value: string }>(queue, async (batch) => {
        const job = batch[0];
        if (!job) throw new Error("Probe worker received an empty batch.");
        clearTimeout(timeout);
        resolve(job.data.value);
      });
    });

    await jobs.boss.send(queue, { value: "ok" });
    await expect(completed).resolves.toBe("ok");
    await jobs.stop();
  });

  it("stores encrypted account credentials, preserves or replaces them deliberately, and never returns them", async () => {
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: { success: true },
      }),
    };
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    const service = new AccountsService(db, encryption, provider);
    const id = "00000000-0000-4000-8000-000000000011";
    const created = await service.create({
      id,
      displayName: "Primary",
      email: "owner@example.test",
      enabled: false,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "plain-imap-password",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
        password: "plain-smtp-password",
      },
    });

    expect(created.enabled).toBe(false);
    expect(JSON.stringify(created)).not.toContain("plain-imap-password");
    expect(JSON.stringify(created)).not.toContain("plain-smtp-password");
    const [stored] = await db.select().from(mailAccounts);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("plain-imap-password");
    expect(JSON.stringify(stored)).not.toContain("plain-smtp-password");
    expect(stored?.imapPassword).toMatchObject({
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: "v1",
    });
    const originalImapEnvelope = stored?.imapPassword;
    const originalSmtpEnvelope = stored?.smtpPassword;

    await service.update(id, {
      displayName: "Renamed",
      email: "owner@example.test",
      enabled: true,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
      },
    });
    const [preserved] = await db.select().from(mailAccounts);
    expect(preserved?.imapPassword).toEqual(originalImapEnvelope);
    expect(preserved?.smtpPassword).toEqual(originalSmtpEnvelope);

    const updated = await service.update(id, {
      displayName: "Renamed",
      email: "owner@example.test",
      enabled: true,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "new-imap-password",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        useImapCredentials: false,
        username: "sender",
        password: "new-smtp-password",
      },
    });
    const [replaced] = await db.select().from(mailAccounts);
    expect(replaced?.imapPassword).not.toEqual(originalImapEnvelope);
    expect(replaced?.smtpPassword).not.toEqual(originalSmtpEnvelope);
    expect(JSON.stringify(updated)).not.toContain("password");
  });

  it("records separate connection outcomes and deletes an account", async () => {
    const provider: MailProvider = {
      testConnection: async () => ({
        imap: { success: true },
        smtp: {
          success: false,
          category: "authentication_rejected",
          message: "SMTP authentication was rejected.",
        },
      }),
    };
    const service = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      provider,
    );
    const id = "00000000-0000-4000-8000-000000000012";
    await service.create({
      id,
      displayName: "Primary",
      email: "owner@example.test",
      enabled: true,
      providerType: "imap_smtp",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "owner",
        password: "secret",
      },
      smtp: {
        host: "smtp.example.test",
        port: 587,
        security: "starttls",
        useImapCredentials: true,
      },
    });
    const report = await service.testExisting(id);
    expect(report.imap.success).toBe(true);
    expect(report.smtp.success).toBe(false);
    expect((await service.get(id)).connectionStatus).toBe("error");
    await service.delete(id);
    await expect(service.get(id)).rejects.toThrow("Mail account not found");
  });

  it("requires an authenticated owner and valid origin for deletion mutations", async () => {
    await initializeOwner(db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    const testAuth = createAuth(config, db);
    const unauthenticated = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { Origin: config.appOrigin },
      }),
      true,
    );
    expect(unauthenticated?.status).toBe(401);

    const login = await testAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.appOrigin,
        },
        body: JSON.stringify({
          username: "owner",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const wrongOrigin = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { cookie, Origin: "http://evil.test" },
      }),
      true,
    );
    expect(wrongOrigin?.status).toBe(403);
    const authorized = await checkOwnerApiAccess(
      testAuth,
      config,
      new Request("http://localhost:3000/api/accounts/id", {
        method: "DELETE",
        headers: { cookie, Origin: config.appOrigin },
      }),
      true,
    );
    expect(authorized).toBeNull();
  });
});
