import type { Config } from '../core/config.js';
import type { Database } from '../core/db/index.js';
import type { Account, ApiKey } from '../core/db/schema.js';
import type { Logger } from '../core/logger.js';
import type { JobsDeps } from '../core/jobs.js';
import type { SmartWalletVerifier } from '../core/siwe.js';
import type { TelegramClient } from '../core/telegram.js';

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
}

export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by requireAuth. */
    account: Account;
    apiKey: ApiKey;
  };
}
