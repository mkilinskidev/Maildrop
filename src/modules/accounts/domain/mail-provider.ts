import type { TransportSecurity } from "./account";

export type ProviderConnection = Readonly<{
  host: string;
  port: number;
  security: TransportSecurity;
  username: string;
  password: string;
}>;

export type ProviderAccount = Readonly<{
  accountId: string;
  imap: ProviderConnection;
  smtp: ProviderConnection;
}>;

export type ConnectionFailureCategory =
  | "dns_or_host_unreachable"
  | "connection_timeout"
  | "tls_certificate_failure"
  | "authentication_rejected"
  | "starttls_unavailable"
  | "verification_failed"
  | "internal_error";

export type ProtocolConnectionResult =
  | Readonly<{ success: true }>
  | Readonly<{
      success: false;
      category: ConnectionFailureCategory;
      message: string;
    }>;

export type ConnectionReport = Readonly<{
  imap: ProtocolConnectionResult;
  smtp: ProtocolConnectionResult;
}>;

export interface MailProvider {
  testConnection(account: ProviderAccount): Promise<ConnectionReport>;
}
