/** Free-tier limits and prices (docs/PLAN.md §4 and §11). Amounts are micro-USDC. */
export const TIERS = {
  /** Before the one-off activation payment. */
  unactivated: { monitors: 1, runsPerMonth: 50 },
  /** After activation (or any other payment). */
  free: { monitors: 3, runsPerMonth: 100 },
} as const;

export type TierName = keyof typeof TIERS;

export function tierFor(account: { activatedAt: Date | null }): TierName {
  return account.activatedAt ? 'free' : 'unactivated';
}

export const MICRO = 1_000_000;

export const PRICES = {
  activationMicro: 100_000, // $0.10
  runMicro: 500, // $0.0005 per run beyond the free runs ($1 = 2,000 runs)
  monitorMonthMicro: 250_000, // $0.25 per extra monitor per 30 days
  /**
   * Credit packs in USD. x402 client SDKs cap single payments at $1 by default
   * (spendControls.maxAmountPerPayment), so $1 is the default pack; larger packs need that
   * cap raised on the agent side.
   */
  packs: [1, 5, 20] as const,
} as const;

export const MONITOR_BILLING_PERIOD_MS = 30 * 24 * 3600_000;

export type Pack = (typeof PRICES.packs)[number];

export type Product = { kind: 'activation' } | { kind: 'credits'; pack: Pack };

export function productPriceMicro(p: Product): number {
  return p.kind === 'activation' ? PRICES.activationMicro : p.pack * MICRO;
}

export function productLabel(p: Product): string {
  return p.kind === 'activation' ? 'activation' : `credits-${p.pack}`;
}

/** "$0.10" style price string for x402 (USDC). */
export function usd(micro: number): string {
  return `$${(micro / MICRO).toFixed(micro % 10_000 === 0 ? 2 : 6)}`;
}
