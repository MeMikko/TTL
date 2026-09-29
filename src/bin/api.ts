import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from '../api/app.js';
import { loadConfig } from '../core/config.js';
import { createDatabase } from '../core/db/index.js';
import { createLogger } from '../core/logger.js';
import { VERSION } from '../core/version.js';
import { onShutdown } from './shutdown.js';

const config = loadConfig();
const logger = createLogger(config, 'api');
const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const app = createApp({ config, database, logger });

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, version: VERSION }, 'api listening');
});

onShutdown(logger, async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
});
