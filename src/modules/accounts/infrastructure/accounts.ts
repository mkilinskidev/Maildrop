import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { getConfig } from "@/shared/infrastructure/config/config";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { PgBossMailboxDiscoveryScheduler } from "@/modules/mail/infrastructure/mailbox-discovery-jobs";
import { MessageService } from "@/modules/mail/application/message-service";
import { PgBossRecentSyncScheduler } from "@/modules/mail/infrastructure/recent-sync-jobs";

const config = getConfig();
const encryption = new AesGcmSecretEncryption(
  config.credentialsEncryption.activeKeyId,
  config.credentialsEncryption.keys,
);

export const accountsService = new AccountsService(
  db,
  encryption,
  new ImapSmtpMailProvider(),
  new PgBossMailboxDiscoveryScheduler(config),
);

export const mailboxService = new MailboxService(db);
export const messageService = new MessageService(
  db,
  undefined,
  undefined,
  undefined,
  new PgBossRecentSyncScheduler(config),
);
