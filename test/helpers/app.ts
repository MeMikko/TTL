import { pino } from 'pino';
import { createApp } from '../../src/api/app.js';
import type { AppDeps } from '../../src/api/context.js';
import { loadConfig, type Config } from '../../src/core/config.js';
import { createDatabase, type Database } from '../../src/core/db/index.js';
import type { SmartWalletVerifier } from '../../src/core/siwe.js';
import { TEST_DATABASE_URL } from './env.js';

export const silentLogger = pino({ level: 'silent' });

/** Fixed key for tests only. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ...overrides,
  });
}

export function testDatabase(): Database {
  return createDatabase(TEST_DATABASE_URL, 4);
}

export function buildApp(
  database: Database,
  opts: {
    now?: () => Date;
    config?: Config;
    smartWalletVerifier?: SmartWalletVerifier;
    dnsResolve?: AppDeps['dnsResolve'];
    telegram?: AppDeps['telegram'];
    payments?: AppDeps['payments'];
  } = {},
) {
  return createApp({
    config: opts.config ?? testConfig(),
    database,
    logger: silentLogger,
    now: opts.now,
    smartWalletVerifier: opts.smartWalletVerifier,
    dnsResolve: opts.dnsResolve,
    telegram: opts.telegram,
    payments: opts.payments,
  });
}
