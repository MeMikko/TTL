import type { Config } from '../core/config.js';
import type { Database } from '../core/db/index.js';
import type { Logger } from '../core/logger.js';

/** Dependencies shared by all routes. Passed explicitly so tests can build isolated apps. */
export interface AppDeps {
  config: Config;
  database: Database;
  logger: Logger;
  now?: () => Date;
}

export interface AppEnv {
  Variables: {
    requestId: string;
  };
}
