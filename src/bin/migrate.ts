import 'dotenv/config';
import { loadConfig } from '../core/config.js';
import { createDatabase } from '../core/db/index.js';
import { runMigrations, migrationsFolder } from '../core/db/migrate.js';
import { createLogger } from '../core/logger.js';

const config = loadConfig();
const logger = createLogger(config, 'migrate');
const database = createDatabase(config.DATABASE_URL, 1);

try {
  logger.info({ migrationsFolder }, 'applying migrations');
  await runMigrations(database.db);
  logger.info('migrations applied');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
