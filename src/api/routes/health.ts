import { Hono } from 'hono';
import { sql, desc } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context.js';
import { schema } from '../../core/db/index.js';
import { VERSION } from '../../core/version.js';

/**
 * GET /healthz        — process liveness (no dependencies), for container health checks.
 * GET /healthz?deep=1 — also checks Postgres and that a worker ticked recently; returns 503
 *                       otherwise. External uptime monitoring should poll this variant.
 */
export function healthRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  app.get('/healthz', async (c) => {
    const deep = ['1', 'true'].includes(c.req.query('deep') ?? '');
    if (!deep) return c.json({ status: 'ok', version: VERSION });

    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await deps.database.db.execute(sql`select 1`);
      checks.database = { ok: true };
    } catch (err) {
      deps.logger.error({ err }, 'health: database check failed');
      checks.database = { ok: false, detail: 'unreachable' };
    }

    if (checks.database.ok) {
      const [latest] = await deps.database.db
        .select()
        .from(schema.workerTicks)
        .orderBy(desc(schema.workerTicks.lastTickAt))
        .limit(1);
      if (!latest) {
        checks.worker = { ok: false, detail: 'no worker has ticked yet' };
      } else {
        const ageMs = now().getTime() - latest.lastTickAt.getTime();
        const ok = ageMs <= deps.config.HEALTH_MAX_TICK_AGE_MS;
        checks.worker = { ok, detail: `last tick ${Math.round(ageMs / 1000)}s ago` };
      }
    } else {
      checks.worker = { ok: false, detail: 'database unavailable' };
    }

    const healthy = Object.values(checks).every((ch) => ch.ok);
    return c.json(
      { status: healthy ? 'ok' : 'degraded', version: VERSION, checks },
      healthy ? 200 : 503,
    );
  });

  return app;
}
