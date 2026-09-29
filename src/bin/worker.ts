import 'dotenv/config';
import { loadConfig } from '../core/config.js';
import { createDatabase } from '../core/db/index.js';
import { createLogger } from '../core/logger.js';
import { createWorker } from '../worker/index.js';
import { onShutdown } from './shutdown.js';

const config = loadConfig();
const logger = createLogger(config, 'worker');
const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const worker = createWorker({ config, database, logger });

await worker.start();

onShutdown(logger, async () => {
  await worker.stop();
  await database.close();
});
