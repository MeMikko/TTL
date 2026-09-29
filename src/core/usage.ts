import { sql } from 'drizzle-orm';
import type { Db } from './db/index.js';

/** Usage period key in UTC, e.g. "2026-09". */
export function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

type Executor = Pick<Db, 'execute'>;

/**
 * Atomically counts one run against the monthly quota. Returns false (and counts nothing) when
 * the account already used `limit` runs this period.
 */
export async function tryConsumeRun(
  db: Executor,
  accountId: string,
  limit: number,
  now: Date,
): Promise<boolean> {
  if (limit <= 0) return false;
  const result = await db.execute(sql`
    insert into usage_counters (account_id, period, runs) values (${accountId}, ${periodOf(now)}, 1)
    on conflict (account_id, period) do update set runs = usage_counters.runs + 1
      where usage_counters.runs < ${limit}
    returning runs`);
  return result.rows.length > 0;
}

export async function runsUsed(db: Executor, accountId: string, now: Date): Promise<number> {
  const result = await db.execute(
    sql`select runs from usage_counters where account_id = ${accountId} and period = ${periodOf(now)}`,
  );
  return (result.rows[0]?.runs as number | undefined) ?? 0;
}
