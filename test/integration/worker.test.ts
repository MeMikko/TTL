import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '../../src/core/db/index.js';
import { createWorker } from '../../src/worker/index.js';
import { silentLogger, testConfig, testDatabase } from '../helpers/app.js';

const database = testDatabase();

afterAll(() => database.close());
beforeEach(async () => {
  await database.db.delete(schema.workerTicks);
});

describe('worker', () => {
  it('records a tick on start and on each loop iteration', async () => {
    const worker = createWorker({
      config: testConfig({ WORKER_TICK_INTERVAL_MS: '1000' }),
      database,
      logger: silentLogger,
      workerId: 'test-worker',
    });
    await worker.start();
    const [first] = await database.db
      .select()
      .from(schema.workerTicks)
      .where(eq(schema.workerTicks.workerId, 'test-worker'));
    expect(first).toBeDefined();

    await new Promise((r) => setTimeout(r, 1200));
    await worker.stop();

    const [second] = await database.db
      .select()
      .from(schema.workerTicks)
      .where(eq(schema.workerTicks.workerId, 'test-worker'));
    expect(second!.lastTickAt.getTime()).toBeGreaterThan(first!.lastTickAt.getTime());
  });
});

describe('worker self heartbeat', () => {
  it('pings SELF_HEARTBEAT_URL on every tick and survives failures', async () => {
    const { startTargetServer } = await import('../helpers/target-server.js');
    const target = await startTargetServer();
    try {
      const worker = createWorker({
        config: testConfig({ SELF_HEARTBEAT_URL: target.url('/v1/heartbeat/mon_x') }),
        database,
        logger: silentLogger,
        workerId: 'self-hb',
      });
      await worker.tick();
      expect(target.received.map((r) => `${r.method} ${r.url}`)).toEqual([
        'POST /v1/heartbeat/mon_x',
      ]);
      target.setHandler((_r, res) => res.writeHead(500).end());
      await expect(worker.tick()).resolves.toBeUndefined();
      await worker.stop();
    } finally {
      await target.close();
    }
  });
});
