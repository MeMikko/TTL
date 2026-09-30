import type { Config } from '../core/config.js';
import type { Database } from '../core/db/index.js';
import type { Account, ApiKey } from '../core/db/schema.js';
import type { Logger } from '../core/logger.js';
import type { JobsDeps } from '../core/jobs.js';
import type { SmartWalletVerifier } from '../core/siwe.js';
import type { Product } from '../core/plans.js';
import type { TelegramClient } from '../core/telegram.js';
import type { PaymentGateway } from '../core/x402.js';

/** Dependencies shared by all routes. Passed explicitly so tests can build isolated apps. */
export interface AppDeps {
  config: Config;
  database: Database;
  logger: Logger;
  now?: () => Date;
  smartWalletVerifier?: SmartWalletVerifier;
  /** DNS override used when validating webhook targets (tests). */
  dnsResolve?: JobsDeps['resolve'];
  /** Telegram client override (tests); otherwise built from config when a bot token is set. */
  telegram?: TelegramClient;
  /** x402 gateway override (tests); `null` forces payments off. Default: built from config. */
  payments?: PaymentGateway | null;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by requireAuth. */
    account: Account;
    /** The API key, when authenticated by one; absent for wallet operator sessions. */
    apiKey?: ApiKey;
    /** Set by acceptPayment when this request carried a settled x402 payment. */
    payment?: { paymentId: string; product: Product; applied: boolean };
  };
}
