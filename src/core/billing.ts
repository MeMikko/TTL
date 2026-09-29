import { eq, isNull, and, sql } from 'drizzle-orm';
import { addCredits } from './credits.js';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Account } from './db/schema.js';
import { newId } from './ids.js';
import { PRICES, productLabel, productPriceMicro, type Product } from './plans.js';
import type { SettledPayment } from './x402.js';

/**
 * Thrown when an action needs a payment (free allowance used up and not enough credits).
 * The API turns it into an x402 `402 Payment Required` offering `offers`.
 */
export class PaymentRequiredError extends Error {
  override name = 'PaymentRequiredError';

  constructor(
    readonly offers: Product[],
    message: string,
    readonly reason = 'payment_required',
  ) {
    super(message);
  }
}

/** What to offer an account that ran out of free allowance and credits. */
export function offersFor(account: Pick<Account, 'activatedAt'>): Product[] {
  const credits: Product = { kind: 'credits', pack: PRICES.packs[0] };
  // Cheapest first: x402 clients pick the first acceptable option by default.
  return account.activatedAt ? [credits] : [{ kind: 'activation' }, credits];
}

/** Every product a PAYMENT-SIGNATURE may pay for (activation only while not yet activated). */
export function acceptedProducts(account: Pick<Account, 'activatedAt'>): Product[] {
  const packs: Product[] = PRICES.packs.map((pack) => ({ kind: 'credits', pack }));
  return account.activatedAt ? packs : [{ kind: 'activation' }, ...packs];
}

export interface AppliedPayment {
  paymentId: string;
  /** False when this settlement had already been recorded (replayed header): nothing re-applied. */
  applied: boolean;
}

/**
 * Records a settled payment and applies its effect in one transaction. Any payment activates
 * the free tier; credit packs also add their value to the prepaid balance. The unique
 * (network, transaction) index makes this idempotent.
 */
export async function applyPayment(
  db: Db,
  accountId: string,
  payment: SettledPayment,
): Promise<AppliedPayment> {
  const micro = productPriceMicro(payment.product);
  return db.transaction(async (tx) => {
    const id = newId('pay');
    const inserted = await tx
      .insert(schema.payments)
      .values({
        id,
        accountId,
        product: productLabel(payment.product),
        amountMicro: micro,
        network: payment.settlement.network,
        asset: payment.requirements.asset,
        payer: payment.payer ?? null,
        transaction: payment.settlement.transaction,
      })
      .onConflictDoNothing()
      .returning({ id: schema.payments.id });
    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.network, payment.settlement.network),
            eq(schema.payments.transaction, payment.settlement.transaction),
          ),
        );
      return { paymentId: existing?.id ?? id, applied: false };
    }
    await tx
      .update(schema.accounts)
      .set({ activatedAt: sql`now()` })
      .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.activatedAt)));
    if (payment.product.kind === 'credits') await addCredits(tx, accountId, micro, id);
    return { paymentId: id, applied: true };
  });
}
