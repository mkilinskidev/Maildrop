import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { ImapSmtpMailProvider } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { getConfig } from "@/shared/infrastructure/config/config";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { db } from "@/shared/infrastructure/database/runtime-database";

const config = getConfig();
const encryption = new AesGcmSecretEncryption(
  config.credentialsEncryption.activeKeyId,
  config.credentialsEncryption.keys,
);

export const accountsService = new AccountsService(
  db,
  encryption,
  new ImapSmtpMailProvider(),
);
