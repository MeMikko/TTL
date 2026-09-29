import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findAccount,
  findOrCreateAccount,
  freezeAccount,
  unfreezeAccount,
} from '../../src/core/accounts.js';
import { cleanupExpired } from '../../src/worker/cleanup.js';
import { testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';

const database = testDatabase();
const db = database.db;
afterAll(() => database.close());
beforeEach(() => resetDb(database));

describe('accounts', () => {
  it('creates once per wallet, even under concurrency', async () => {
    const address = newWallet().address;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => findOrCreateAccount(db, address)),
    );
    expect(new Set(results.map((r) => r.account.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('finds by id or by address in any case', async () => {
    const wallet = newWallet();
    const { account } = await findOrCreateAccount(db, wallet.address);
    expect((await findAccount(db, account.id))?.id).toBe(account.id);
    expect((await findAccount(db, wallet.address.toUpperCase().replace('0X', '0x')))?.id).toBe(
      account.id,
    );
    expect(await findAccount(db, newWallet().address)).toBeUndefined();
  });

  it('freezes with a reason and unfreezes', async () => {
    const { account } = await findOrCreateAccount(db, newWallet().address);
    const frozen = await freezeAccount(db, account.id, 'spam');
    expect(frozen).toMatchObject({ status: 'frozen', frozenReason: 'spam' });
    expect(frozen.frozenAt).toBeInstanceOf(Date);
    const active = await unfreezeAccount(db, account.id);
    expect(active).toMatchObject({ status: 'active', frozenReason: null, frozenAt: null });
  });

  it('enforces the status check constraint', async () => {
    const { account } = await findOrCreateAccount(db, newWallet().address);
    await expect(
      database.pool.query(`update accounts set status = 'deleted' where id = $1`, [account.id]),
    ).rejects.toThrow(/accounts_status_check/);
  });
});

describe('cleanupExpired', () => {
  it('removes old nonces and idempotency keys only', async () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const { account } = await findOrCreateAccount(db, newWallet().address);
    const q = (sql: string, params: unknown[]) => database.pool.query(sql, params);
    const nonce = (n: string, expires: Date) =>
      q(
        `insert into auth_nonces (nonce, address, chain_id, message, expires_at) values ($1, '0x', 8453, 'm', $2)`,
        [n, expires],
      );
    await nonce('old', new Date(now.getTime() - 2 * 3600_000));
    await nonce('fresh', new Date(now.getTime() - 60_000));
    const idem = (k: string, created: Date) =>
      q(
        `insert into idempotency_keys (account_id, key, request_hash, created_at) values ($1, $2, 'h', $3)`,
        [account.id, k, created],
      );
    await idem('old', new Date(now.getTime() - 25 * 3600_000));
    await idem('fresh', new Date(now.getTime() - 3600_000));

    expect(await cleanupExpired(db, now)).toMatchObject({
      nonces: 1,
      idempotencyKeys: 1,
      jobRuns: 0,
    });
    const left = await q(
      `select (select array_agg(nonce) from auth_nonces) n, (select array_agg(key) from idempotency_keys) k`,
      [],
    );
    expect(left.rows[0]).toEqual({ n: ['fresh'], k: ['fresh'] });
  });
});
