import { and, eq, isNull, sql } from 'drizzle-orm';
import { isAddress } from 'viem';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Account } from './db/schema.js';
import { newId } from './ids.js';

export function normalizeAddress(address: string): string {
  if (!isAddress(address, { strict: false })) throw new Error(`invalid address: ${address}`);
  return address.toLowerCase();
}

/** Returns the account for a wallet, creating it on first sign-in. Race-safe via upsert. */
export async function findOrCreateAccount(
  db: Db,
  address: string,
): Promise<{ account: Account; created: boolean }> {
  const walletAddress = normalizeAddress(address);
  const [inserted] = await db
    .insert(schema.accounts)
    .values({ id: newId('acc'), walletAddress })
    .onConflictDoNothing({ target: schema.accounts.walletAddress })
    .returning();
  if (inserted) return { account: inserted, created: true };
  const [existing] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.walletAddress, walletAddress));
  if (!existing) throw new Error('account vanished during upsert');
  return { account: existing, created: false };
}

/** Looks an account up by id ("acc_…") or wallet address. */
export async function findAccount(db: Db, idOrAddress: string): Promise<Account | undefined> {
  const where = idOrAddress.startsWith('acc_')
    ? eq(schema.accounts.id, idOrAddress)
    : eq(schema.accounts.walletAddress, normalizeAddress(idOrAddress));
  const [row] = await db.select().from(schema.accounts).where(where);
  return row;
}

export async function freezeAccount(db: Db, accountId: string, reason: string): Promise<Account> {
  const [row] = await db
    .update(schema.accounts)
    .set({ status: 'frozen', frozenReason: reason, frozenAt: sql`now()` })
    .where(eq(schema.accounts.id, accountId))
    .returning();
  if (!row) throw new Error(`account not found: ${accountId}`);
  return row;
}

export async function unfreezeAccount(db: Db, accountId: string): Promise<Account> {
  const [row] = await db
    .update(schema.accounts)
    .set({ status: 'active', frozenReason: null, frozenAt: null })
    .where(eq(schema.accounts.id, accountId))
    .returning();
  if (!row) throw new Error(`account not found: ${accountId}`);
  return row;
}

export async function countActiveKeys(db: Db, accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.accountId, accountId), isNull(schema.apiKeys.revokedAt)));
  return row?.n ?? 0;
}
