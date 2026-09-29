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
