import type { Config } from '../core/config.js';
import type { Database } from '../core/db/index.js';
import type { Account, ApiKey } from '../core/db/schema.js';
import type { Logger } from '../core/logger.js';
import type { SmartWalletVerifier } from '../core/siwe.js';

/** Dependencies shared by all routes. Passed explicitly so tests can build isolated apps. */
export interface AppDeps {
  config: Config;
  database: Database;
  logger: Logger;
  now?: () => Date;
  smartWalletVerifier?: SmartWalletVerifier;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by requireAuth. */
    account: Account;
    apiKey: ApiKey;
  };
}
