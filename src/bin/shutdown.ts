import type { Logger } from '../core/logger.js';

/** Runs `cleanup` once on SIGINT/SIGTERM, then exits. A second signal forces exit. */
export function onShutdown(logger: Logger, cleanup: () => Promise<void>) {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    cleanup()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
