import { sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { usd } from './plans.js';

export interface Analytics {
  generatedAt: string;
  windowHours: number;
  accounts: { total: number; active: number; frozen: number; activated: number; new: number };
  monitors: { total: number; byStatus: Record<string, number> };
  jobs: { total: number; byStatus: Record<string, number> };
  runs: { total: number; recent: number; succeeded: number; failed: number };
  payments: { count: number; revenueUsd: string; recentUsd: string };
  switches: { total: number; triggered: number; skipped: number; live: number };
}

const toInt = (v: unknown) => Number(v ?? 0);
const byStatus = (rows: Array<{ status: string; n: number }>) =>
  Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));

/**
 * Global, real-time service statistics for the operator analytics dashboard. Read-only aggregates
 * over every account's data (so it is gated to a single operator wallet by the route). "recent"
 * counts cover the last 24 hours.
 */
export async function getAnalytics(db: Db, now: Date): Promise<Analytics> {
  const windowHours = 24;
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const a = schema.accounts;
  const r = schema.jobRuns;
  const p = schema.payments;
  const s = schema.keeperSwitches;

  const [[acc], mon, job, [run], [pay], [sw]] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${a.status} = 'active')::int`,
        frozen: sql<number>`count(*) filter (where ${a.status} = 'frozen')::int`,
        activated: sql<number>`count(*) filter (where ${a.activatedAt} is not null)::int`,
        recent: sql<number>`count(*) filter (where ${a.createdAt} >= ${since})::int`,
      })
      .from(a),
    db
      .select({ status: schema.monitors.status, n: sql<number>`count(*)::int` })
      .from(schema.monitors)
      .groupBy(schema.monitors.status),
    db
      .select({ status: schema.jobs.status, n: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .groupBy(schema.jobs.status),
    db
      .select({
        total: sql<number>`count(*)::int`,
        recent: sql<number>`count(*) filter (where ${r.createdAt} >= ${since})::int`,
        succeeded: sql<number>`count(*) filter (where ${r.status} = 'succeeded' and ${r.createdAt} >= ${since})::int`,
        failed: sql<number>`count(*) filter (where ${r.status} = 'failed' and ${r.createdAt} >= ${since})::int`,
      })
      .from(r),
    db
      .select({
        count: sql<number>`count(*)::int`,
        revenueMicro: sql<string>`coalesce(sum(${p.amountMicro}), 0)::bigint`,
        recentMicro: sql<string>`coalesce(sum(${p.amountMicro}) filter (where ${p.createdAt} >= ${since}), 0)::bigint`,
      })
      .from(p),
    db
      .select({
        total: sql<number>`count(*)::int`,
        triggered: sql<number>`count(*) filter (where ${s.triggeredAt} is not null)::int`,
        skipped: sql<number>`count(*) filter (where ${s.skippedAt} is not null)::int`,
      })
      .from(s),
  ]);

  const monByStatus = byStatus(mon);
  const jobByStatus = byStatus(job);
  const triggered = toInt(sw?.triggered);
  const skipped = toInt(sw?.skipped);
  const switchTotal = toInt(sw?.total);

  return {
    generatedAt: now.toISOString(),
    windowHours,
    accounts: {
      total: toInt(acc?.total),
      active: toInt(acc?.active),
      frozen: toInt(acc?.frozen),
      activated: toInt(acc?.activated),
      new: toInt(acc?.recent),
    },
    monitors: {
      total: Object.values(monByStatus).reduce((x, y) => x + y, 0),
      byStatus: monByStatus,
    },
    jobs: {
      total: Object.values(jobByStatus).reduce((x, y) => x + y, 0),
      byStatus: jobByStatus,
    },
    runs: {
      total: toInt(run?.total),
      recent: toInt(run?.recent),
      succeeded: toInt(run?.succeeded),
      failed: toInt(run?.failed),
    },
    payments: {
      count: toInt(pay?.count),
      revenueUsd: usd(toInt(pay?.revenueMicro)),
      recentUsd: usd(toInt(pay?.recentMicro)),
    },
    switches: {
      total: switchTotal,
      triggered,
      skipped,
      live: Math.max(switchTotal - triggered - skipped, 0),
    },
  };
}
