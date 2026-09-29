import { hostname } from 'node:os';
import { targetPolicyFromConfig, type Config } from '../core/config.js';
import { parseEncryptionKey } from '../core/crypto.js';
import type { Database } from '../core/db/index.js';
import type { Logger } from '../core/logger.js';
import { RateLimiter } from '../core/rate-limit.js';
import { sweepExpiredMonitors } from '../core/monitors.js';
import { createTelegramClient, type TelegramClient } from '../core/telegram.js';
import { claimAlerts, processAlert, type AlertDeps } from './alerts.js';
import { cleanupExpired } from './cleanup.js';
import { claimRuns, processRun, type DeliveryDeps } from './delivery.js';
import { createHttpClient, type HttpClient } from './http-client.js';
import { scheduleDueJobs } from './scheduler.js';
import { recordTick } from './ticker.js';

const CLEANUP_INTERVAL_MS = 10 * 60_000;

export interface WorkerDeps {
  config: Config;
  database: Database;
  logger: Logger;
  workerId?: string;
  /** Override the outbound client (tests). */
  httpClient?: HttpClient;
  telegram?: TelegramClient;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One liveness tick + cleanup (exposed for tests). */
  tick(): Promise<void>;
  /** One scheduler, monitor and delivery pass, awaiting all deliveries (exposed for tests). */
  runOnce(): Promise<void>;
}

/** Runs `fn` repeatedly with `intervalMs` between the end of one call and the next. */
function loop(name: string, intervalMs: number, fn: () => Promise<unknown>, logger: Logger) {
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<unknown> | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = fn()
        .catch((err: unknown) => logger.error({ err, loop: name }, 'worker loop failed'))
        .finally(() => {
          current = undefined;
          schedule();
        });
    }, intervalMs);
  };
  return {
    start: schedule,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}

export function createWorker(deps: WorkerDeps): Worker {
  const { config, logger } = deps;
  const db = deps.database.db;
  const workerId = deps.workerId ?? `${hostname()}:${process.pid}`;
  const startedAt = new Date();
  const client = deps.httpClient ?? createHttpClient(targetPolicyFromConfig(config));
  const deliveryDeps: DeliveryDeps = {
    db,
    client,
    encryptionKey: parseEncryptionKey(config.ENCRYPTION_KEY),
    hostLimiter: RateLimiter.perMinute(config.TARGET_HOST_RATE_PER_MIN),
    logger,
  };
  const telegram =
    deps.telegram ??
    (config.TELEGRAM_BOT_TOKEN
      ? createTelegramClient({
          token: config.TELEGRAM_BOT_TOKEN,
          apiBase: config.TELEGRAM_API_BASE,
        })
      : undefined);
  const alertDeps: AlertDeps = { ...deliveryDeps, telegram };
  const inFlight = new Set<Promise<unknown>>();
  let lastCleanup = 0;

  async function selfHeartbeat() {
    if (!config.SELF_HEARTBEAT_URL) return;
    try {
      const res = await fetch(config.SELF_HEARTBEAT_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'self heartbeat rejected');
    } catch (err) {
      logger.warn({ err }, 'self heartbeat failed');
    }
  }

  async function tick() {
    await recordTick(db, workerId, startedAt);
    await selfHeartbeat();
    if (Date.now() - lastCleanup >= CLEANUP_INTERVAL_MS) {
      lastCleanup = Date.now();
      const removed = await cleanupExpired(db);
      if (Object.values(removed).some((n) => n > 0)) logger.info(removed, 'expired rows removed');
    }
  }

  async function schedulePass() {
    // Drain in batches so a large backlog is not limited to one batch per poll.
    for (let i = 0; i < 10; i++) {
      const r = await scheduleDueJobs(db, new Date(), logger);
      if (r.queued || r.skipped) logger.debug(r, 'runs scheduled');
      if (r.queued + r.skipped < 100) break;
    }
  }

  async function monitorPass() {
    for (let i = 0; i < 10; i++) {
      const r = await sweepExpiredMonitors(db, new Date());
      if (r.died) logger.info(r, 'monitors marked dead');
      if (r.died < 100) break;
    }
  }

  function track(p: Promise<unknown>, what: string, id: string) {
    const tracked = p
      .catch((err: unknown) => logger.error({ err, id }, `${what} failed`))
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  }

  async function deliveryPass() {
    // Alerts first: a dead-agent notification is more urgent than a routine job run.
    const alerts = await claimAlerts(db, config.DELIVERY_CONCURRENCY - inFlight.size, new Date());
    for (const a of alerts) track(processAlert(alertDeps, a), 'alert delivery', a.id);
    const runs = await claimRuns(db, config.DELIVERY_CONCURRENCY - inFlight.size, new Date());
    for (const run of runs) track(processRun(deliveryDeps, run), 'job delivery', run.id);
  }

  const loops = [
    loop('tick', config.WORKER_TICK_INTERVAL_MS, tick, logger),
    loop('scheduler', config.SCHEDULER_POLL_MS, schedulePass, logger),
    loop('monitors', config.SCHEDULER_POLL_MS, monitorPass, logger),
    loop('delivery', config.SCHEDULER_POLL_MS, deliveryPass, logger),
  ];

  return {
    tick,
    async runOnce() {
      await schedulePass();
      await monitorPass();
      await deliveryPass();
      await Promise.all(inFlight);
    },
    async start() {
      logger.info({ workerId }, 'worker starting');
      await tick();
      for (const l of loops) l.start();
    },
    async stop() {
      await Promise.all(loops.map((l) => l.stop()));
      await Promise.all(inFlight); // let running deliveries finish and record their outcome
      if (!deps.httpClient) await client.close();
      logger.info({ workerId }, 'worker stopped');
    },
  };
}
