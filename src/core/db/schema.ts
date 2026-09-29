import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Liveness beacon written by each worker process; read by GET /healthz?deep=1. */
export const workerTicks = pgTable('worker_ticks', {
  workerId: text('worker_id').primaryKey(),
  lastTickAt: ts('last_tick_at').notNull(),
  startedAt: ts('started_at').notNull(),
  version: text('version').notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    /** Lowercase 0x-prefixed EVM address; the only identity an account has. */
    walletAddress: text('wallet_address').notNull().unique(),
    status: text('status', { enum: ['active', 'frozen'] })
      .notNull()
      .default('active'),
    frozenReason: text('frozen_reason'),
    frozenAt: ts('frozen_at'),
    /** Set when the one-off free-tier activation payment settles (phase 4). */
    activatedAt: ts('activated_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('accounts_status_check', sql`${t.status} in ('active', 'frozen')`)],
);

/** Single-use SIWE challenges. The exact issued message is stored and must be signed verbatim. */
export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    address: text('address').notNull(),
    chainId: integer('chain_id').notNull(),
    message: text('message').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('auth_nonces_expires_at_idx').on(t.expiresAt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** First characters of the key, safe to display (e.g. "t2l_AbCd1234"). */
    prefix: text('prefix').notNull(),
    /** Hex SHA-256 of the full key. The key itself is never stored. */
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
    index('api_keys_account_active_idx')
      .on(t.accountId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** SHA-256 over method, path and body; a reused key with a different request is rejected. */
    requestHash: text('request_hash').notNull(),
    /** Null while the original request is still being processed. */
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.key] }),
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
