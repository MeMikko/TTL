import { getAnalytics } from '../../core/analytics.js';
import { ApiError } from '../../core/errors.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';

/**
 * GET /v1/analytics — global, real-time service statistics for the operator dashboard.
 *
 * Auth is applied at the app level (operator session or API key). This endpoint additionally gates
 * to a single wallet: only `ANALYTICS_ADDRESS` may read the fleet-wide numbers. Disabled (404) when
 * no address is configured.
 */
export function analyticsRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const gate = deps.config.ANALYTICS_ADDRESS;
  const app = createRouter();

  app.get('/v1/analytics', async (c) => {
    if (!gate) throw new ApiError(404, 'not_found', 'Analytics is not enabled on this instance');
    if (c.get('account').walletAddress !== gate) {
      throw new ApiError(403, 'forbidden', 'This wallet is not allowed to view analytics');
    }
    c.header('cache-control', 'no-store');
    return c.json(await getAnalytics(db, now()));
  });

  return app;
}
