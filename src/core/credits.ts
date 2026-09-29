import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/**
 * Deducts `micro` from the prepaid balance if (and only if) it is sufficient. Atomic: the
 * conditional UPDATE cannot drive the balance negative even under concurrency.
 */
export async function chargeCredits(
  db: Executor,
  accountId: string,
  micro: number,
  reason: 'run' | 'monitor_month',
  ref: string,
): Promise<boolean> {
  const t = schema.accounts;
  const rows = await db
    .update(t)
    .set({ creditMicro: sql`${t.creditMicro} - ${micro}` })
    .where(and(eq(t.id, accountId), gte(t.creditMicro, micro)))
    .returning({ id: t.id });
  if (rows.length === 0) return false;
  await db.insert(schema.creditsLedger).values({ accountId, deltaMicro: -micro, reason, ref });
  return true;
}

export async function addCredits(
  db: Executor,
  accountId: string,
  micro: number,
  ref: string,
): Promise<void> {
  const t = schema.accounts;
  await db
    .update(t)
    .set({ creditMicro: sql`${t.creditMicro} + ${micro}` })
    .where(eq(t.id, accountId));
  await db
    .insert(schema.creditsLedger)
    .values({ accountId, deltaMicro: micro, reason: 'topup', ref });
}
