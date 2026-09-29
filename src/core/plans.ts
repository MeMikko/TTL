/** Free-tier limits (docs/PLAN.md §4 and §11). Paid usage arrives with billing in phase 4. */
export const TIERS = {
  /** Before the one-off $0.10 activation payment. */
  unactivated: { monitors: 1, runsPerMonth: 50 },
  /** After activation. */
  free: { monitors: 3, runsPerMonth: 100 },
} as const;

export type TierName = keyof typeof TIERS;

export function tierFor(account: { activatedAt: Date | null }): TierName {
  return account.activatedAt ? 'free' : 'unactivated';
}
