import { and, eq, isNull } from 'drizzle-orm';
import { decrypt, encrypt } from './crypto.js';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { generateWebhookSecret } from './hmac.js';

const aad = (accountId: string) => `webhook-secret:${accountId}`;

/** Returns the account's signing secret, creating it on first use (race-safe). */
export async function getOrCreateWebhookSecret(
  db: Db,
  key: Buffer,
  accountId: string,
): Promise<string> {
  const t = schema.accounts;
  await db
    .update(t)
    .set({ webhookSecretEnc: encrypt(key, generateWebhookSecret(), aad(accountId)) })
    .where(and(eq(t.id, accountId), isNull(t.webhookSecretEnc)));
  const [row] = await db.select({ enc: t.webhookSecretEnc }).from(t).where(eq(t.id, accountId));
  if (!row?.enc) throw new Error(`account not found: ${accountId}`);
  return decrypt(key, row.enc, aad(accountId));
}

/** Replaces the secret immediately; deliveries after this are signed with the new one. */
export async function rotateWebhookSecret(db: Db, key: Buffer, accountId: string): Promise<string> {
  const secret = generateWebhookSecret();
  await db
    .update(schema.accounts)
    .set({ webhookSecretEnc: encrypt(key, secret, aad(accountId)) })
    .where(eq(schema.accounts.id, accountId));
  return secret;
}
