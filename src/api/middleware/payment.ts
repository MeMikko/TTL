import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import {
  acceptedProducts,
  applyPayment,
  offersFor,
  PaymentRequiredError,
} from '../../core/billing.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import { productLabel } from '../../core/plans.js';
import {
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentGateway,
} from '../../core/x402.js';
import type { AppDeps, AppEnv } from '../context.js';

/**
 * Accepts an x402 payment on routes that may require one (runs after requireAuth).
 *
 * With a PAYMENT-SIGNATURE header the payment is verified and settled through the facilitator,
 * recorded, and its effect applied (activation / credits) *before* the handler runs, so the same
 * request that was answered with 402 succeeds when retried with payment. The settlement receipt
 * is returned in PAYMENT-RESPONSE. Without the header this is a no-op.
 */
export function acceptPayment(deps: AppDeps, gateway: PaymentGateway | undefined) {
  const { db } = deps.database;
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header(PAYMENT_SIGNATURE_HEADER);
    if (!header) return next();
    if (!gateway) {
      throw new ApiError(400, 'payments_disabled', 'x402 payments are not enabled on this server');
    }
    const account = c.get('account');
    const result = await gateway.collect(header, acceptedProducts(account));
    if (!result.ok) {
      throw new PaymentRequiredError(offersFor(account), result.message, result.reason);
    }
    const applied = await applyPayment(db, account.id, result.payment);
    const [fresh] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id));
    if (fresh) c.set('account', fresh);
    c.set('payment', {
      paymentId: applied.paymentId,
      product: result.payment.product,
      applied: applied.applied,
    });
    c.header(PAYMENT_RESPONSE_HEADER, gateway.encodeSettlement(result.payment.settlement));
    deps.logger.info(
      {
        accountId: account.id,
        paymentId: applied.paymentId,
        product: productLabel(result.payment.product),
        transaction: result.payment.settlement.transaction,
        applied: applied.applied,
      },
      'x402 payment settled',
    );
    await next();
  });
}
