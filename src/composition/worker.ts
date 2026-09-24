import { JobRuntime } from "../modules/jobs/infrastructure/job-runtime.js";
import { getConfig } from "../shared/infrastructure/config/config.js";
import { createLogger } from "../shared/infrastructure/logging/logger.js";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker.js";
import { AesGcmSecretEncryption } from "../shared/infrastructure/crypto/aes-gcm-secret-encryption.js";
import { AccountsService } from "../modules/accounts/application/accounts-service.js";
import { ImapSmtpMailProvider } from "../modules/accounts/infrastructure/imap-smtp-mail-provider.js";
import { MailboxService } from "../modules/mail/application/mailbox-service.js";
import { MailboxDiscoveryService } from "../modules/mail/application/mailbox-discovery-service.js";

export function createWorkerComposition() {
  const config = getConfig();
  const logger = createLogger(config);
  const database = createWorkerDatabase(config);
  const provider = new ImapSmtpMailProvider();
  const encryption = new AesGcmSecretEncryption(
    config.credentialsEncryption.activeKeyId,
    config.credentialsEncryption.keys,
  );
  const accounts = new AccountsService(database.db, encryption, provider);
  const mailboxes = new MailboxService(database.db);
  return {
    config,
    logger,
    database,
    jobs: new JobRuntime(config, logger),
    mailboxDiscovery: new MailboxDiscoveryService(
      database.db,
      accounts,
      provider,
      mailboxes,
    ),
  };
}
