import { hostname } from 'node:os';
import type { Config } from '../core/config.js';
import type { Database } from '../core/db/index.js';
import type { Logger } from '../core/logger.js';
import { recordTick } from './ticker.js';

export interface WorkerDeps {
  config: Config;
  database: Database;
  logger: Logger;
  workerId?: string;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Runs one iteration of the periodic loop (exposed for tests). */
  tick(): Promise<void>;
}

export function createWorker(deps: WorkerDeps): Worker {
  const workerId = deps.workerId ?? `${hostname()}:${process.pid}`;
  const startedAt = new Date();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  async function tick() {
    await recordTick(deps.database.db, workerId, startedAt);
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick()
        .catch((err: unknown) => deps.logger.error({ err }, 'worker tick failed'))
        .finally(() => {
          running = undefined;
          schedule();
        });
    }, deps.config.WORKER_TICK_INTERVAL_MS);
  }

  return {
    tick,
    async start() {
      deps.logger.info({ workerId }, 'worker starting');
      await tick();
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      deps.logger.info({ workerId }, 'worker stopped');
    },
  };
}
