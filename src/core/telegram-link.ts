import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { randomBase62 } from './ids.js';

export const LINK_TOKEN_TTL_MS = 15 * 60_000;

/** Creates a one-time token for https://t.me/<bot>?start=<token> (Telegram allows [A-Za-z0-9_-]{1,64}). */
export async function createLinkToken(db: Db, accountId: string, now: Date) {
  const token = randomBase62(32);
  const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);
  await db.insert(schema.telegramLinkTokens).values({ token, accountId, expiresAt });
  return { token, expiresAt };
}

/** Consumes a token and links the chat. Returns the account id, or null if the token is invalid. */
export async function consumeLinkToken(
  db: Db,
  token: string,
  chatId: string,
  now: Date,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const t = schema.telegramLinkTokens;
    const [row] = await tx
      .update(t)
      .set({ usedAt: now })
      .where(and(eq(t.token, token), isNull(t.usedAt), gt(t.expiresAt, now)))
      .returning({ accountId: t.accountId });
    if (!row) return null;
    await tx
      .update(schema.accounts)
      .set({ telegramChatId: chatId })
      .where(eq(schema.accounts.id, row.accountId));
    return row.accountId;
  });
}

/** Unlinks a chat from every account it is linked to (the /stop command). */
export async function unlinkChat(db: Db, chatId: string): Promise<number> {
  const rows = await db
    .update(schema.accounts)
    .set({ telegramChatId: null })
    .where(eq(schema.accounts.telegramChatId, chatId))
    .returning({ id: schema.accounts.id });
  return rows.length;
}
