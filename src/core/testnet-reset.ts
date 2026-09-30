import { and, eq, gt, isNotNull, notInArray, or, isNull, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { NETWORKS, type NetworkId } from './network.js';

export interface TestnetResetSummary {
  /** Accounts whose prepaid balance is zeroed (with a `testnet_reset` ledger entry each). */
  accountsWithCredits: number;
  creditMicro: number;
  /** Accounts whose free-tier activation is cleared. */
  activatedAccounts: number;
  /** Paid monitors whose current period ends now (renewal from credits then decides). */
  paidMonitors: number;
}

const TESTNETS = (Object.keys(NETWORKS) as NetworkId[]).filter((n) => NETWORKS[n].testnet);

/**
 * Before switching x402 to mainnet: undoes everything bought with testnet money, so test USDC
 * does not turn into real service. Zeroes prepaid credits (recorded in the ledger), clears
 * activations and ends paid monitor periods now — the worker then tries to renew each from
 * credits and, as when a balance runs out, pauses it with a `monitor.unpaid` alert. Accounts,
 * keys, monitors, jobs and the payment history stay.
 *
 * Refuses once any mainnet payment is recorded: from then on balances are real money.
 * With `apply: false` it only reports what it would change.
 */
export async function resetTestnetBilling(
  db: Db,
  now: Date,
  apply: boolean,
): Promise<TestnetResetSummary> {
  return db.transaction(async (tx) => {
    // A payment counts as "real money" unless its network is a known testnet. `network` is NOT NULL
    // today, so the `IS NULL` arm never matches; it is defensive belt-and-suspenders so that, if the
    // column ever became nullable, an unlabelled payment would make us refuse rather than wipe money.
    const [real] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.payments)
      .where(or(notInArray(schema.payments.network, TESTNETS), isNull(schema.payments.network)));
    if (real!.n > 0) {
      throw new Error(
        `Refusing: ${real!.n} payment(s) on a non-testnet network are recorded, so balances are real money`,
      );
    }
    // Hold every account row so no top-up or charge interleaves with the reset.
    await tx.select({ id: schema.accounts.id }).from(schema.accounts).for('update');

    const a = schema.accounts;
    const m = schema.monitors;
    const [credits] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        micro: sql<number>`coalesce(sum(${a.creditMicro}), 0)::bigint`,
      })
      .from(a)
      .where(gt(a.creditMicro, 0));
    const [activated] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(a)
      .where(isNotNull(a.activatedAt));
    const paidOpen = and(eq(m.billing, 'paid'), or(isNull(m.paidUntil), gt(m.paidUntil, now)));
    const [paid] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(m)
      .where(paidOpen);

    if (apply) {
      await tx.execute(sql`
        insert into ${schema.creditsLedger} (account_id, delta_micro, reason, ref)
        select ${a.id}, -${a.creditMicro}, 'testnet_reset', null from ${a}
        where ${a.creditMicro} > 0`);
      await tx.update(a).set({ creditMicro: 0 }).where(gt(a.creditMicro, 0));
      await tx.update(a).set({ activatedAt: null }).where(isNotNull(a.activatedAt));
      await tx.update(m).set({ paidUntil: now, updatedAt: now }).where(paidOpen);
    }
    return {
      accountsWithCredits: credits!.n,
      creditMicro: Number(credits!.micro),
      activatedAccounts: activated!.n,
      paidMonitors: paid!.n,
    };
  });
}
