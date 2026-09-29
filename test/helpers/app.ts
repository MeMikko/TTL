import { pino } from 'pino';
import { createApp } from '../../src/api/app.js';
import { loadConfig, type Config } from '../../src/core/config.js';
import { createDatabase, type Database } from '../../src/core/db/index.js';
import type { SmartWalletVerifier } from '../../src/core/siwe.js';
import { TEST_DATABASE_URL } from './env.js';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, ...overrides });
}

export function testDatabase(): Database {
  return createDatabase(TEST_DATABASE_URL, 4);
}

export function buildApp(
  database: Database,
  opts: { now?: () => Date; config?: Config; smartWalletVerifier?: SmartWalletVerifier } = {},
) {
  return createApp({
    config: opts.config ?? testConfig(),
    database,
    logger: silentLogger,
    now: opts.now,
    smartWalletVerifier: opts.smartWalletVerifier,
  });
}
