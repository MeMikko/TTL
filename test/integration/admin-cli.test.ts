import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findAccount, findOrCreateAccount } from '../../src/core/accounts.js';
import { renewPaidMonitors } from '../../src/core/monitors.js';
import { TEST_ENCRYPTION_KEY, testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';
import { TEST_DATABASE_URL } from '../helpers/env.js';

const run = promisify(execFile);
const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const admin = (...args: string[]) =>
  run('npx', ['tsx', 'src/bin/admin.ts', ...args], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      PUBLIC_BASE_URL: 'http://localhost:3000',
    },
  });

describe('admin CLI', () => {
  it('freezes and unfreezes by address', async () => {
    const wallet = newWallet();
    const { account } = await findOrCreateAccount(database.db, wallet.address);

    const frozen = await admin('freeze', wallet.address, '--reason', 'abuse report #1');
    expect(frozen.stdout).toContain(`Frozen ${account.id}`);
    expect(await findAccount(database.db, account.id)).toMatchObject({
      status: 'frozen',
      frozenReason: 'abuse report #1',
    });

    await admin('unfreeze', account.id);
    expect((await findAccount(database.db, account.id))?.status).toBe('active');
  }, 30_000);

  it('requires a reason and fails for unknown accounts', async () => {
    const { account } = await findOrCreateAccount(database.db, newWallet().address);
    await expect(admin('freeze', account.id)).rejects.toMatchObject({
      stderr: expect.stringContaining('--reason is required'),
    });
    await expect(admin('show', 'acc_0000000000000000000000')).rejects.toMatchObject({
      stderr: expect.stringContaining('No account found'),
    });
  }, 30_000);
});

describe('admin create-monitor', () => {
  it('creates an operator monitor beyond the tier limit and prints the ping URL', async () => {
    const wallet = newWallet();
    for (const name of ['worker', 'backup']) {
      const out = await admin('create-monitor', wallet.address, '--name', name, '--ttl', '120');
      expect(out.stdout).toMatch(
        /Ping URL: http:\/\/localhost:3000\/v1\/heartbeat\/mon_[0-9A-Za-z]{22}/,
      );
    }
    const { rows } = await database.pool.query(
      'select name, ttl_seconds, grace_seconds from monitors order by name',
    );
    expect(rows).toEqual([
      { name: 'backup', ttl_seconds: 120, grace_seconds: 60 },
      { name: 'worker', ttl_seconds: 120, grace_seconds: 60 },
    ]);
    await expect(
      admin('create-monitor', wallet.address, '--name', 'x', '--ttl', '5'),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('--ttl'),
    });
  }, 60_000);
});

describe('admin telegram-link', () => {
  it('prints a one-time bot link for the account', async () => {
    const wallet = newWallet();
    await findOrCreateAccount(database.db, wallet.address);
    const out = await run('npx', ['tsx', 'src/bin/admin.ts', 'telegram-link', wallet.address], {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_BOT_USERNAME: 'time2live_bot',
        TELEGRAM_WEBHOOK_SECRET: 'secret-secret-secret',
      },
    });
    const token = /https:\/\/t\.me\/time2live_bot\?start=([0-9A-Za-z]{32})/.exec(out.stdout)?.[1];
    expect(token).toBeDefined();
    const { rows } = await database.pool.query(
      'select used_at from telegram_link_tokens where token = $1',
      [token],
    );
    expect(rows).toEqual([{ used_at: null }]);
  }, 60_000);

  it('fails clearly when Telegram is not configured', async () => {
    const wallet = newWallet();
    await findOrCreateAccount(database.db, wallet.address);
    await expect(admin('telegram-link', wallet.address)).rejects.toMatchObject({
      stderr: expect.stringContaining('Telegram is not configured'),
    });
  }, 60_000);
});

describe('admin reset-testnet-billing', () => {
  /** An account that paid with test USDC: activation, $1.75 credits and one paid monitor. */
  async function testnetCustomer() {
    const { account } = await findOrCreateAccount(database.db, newWallet().address);
    await database.pool.query(
      `update accounts set credit_micro = 1750000, activated_at = now() where id = $1`,
      [account.id],
    );
    await database.pool.query(
      `insert into payments (id, account_id, product, amount_micro, network, asset, transaction)
       values ($1, $2, 'credits-1', 1000000, 'eip155:84532', 'usdc', $3)`,
      ['pay_' + account.id, account.id, '0x' + account.id.padEnd(64, '0')],
    );
    await database.pool.query(
      `insert into monitors (id, account_id, name, ttl_seconds, grace_seconds, status, billing, paid_until)
       values ($1, $2, 'paid', 300, 60, 'alive', 'paid', now() + interval '20 days'),
              ($3, $2, 'free', 300, 60, 'alive', 'free', null)`,
      ['mon_p' + account.id.slice(4), account.id, 'mon_f' + account.id.slice(4)],
    );
    return account;
  }

  const stateOf = async (accountId: string) => {
    const { rows } = await database.pool.query(
      `select a.credit_micro, a.activated_at,
              (select paid_until from monitors where account_id = a.id and billing = 'paid') as paid_until,
              (select sum(delta_micro)::int from credits_ledger where account_id = a.id and reason = 'testnet_reset') as reset
       from accounts a where a.id = $1`,
      [accountId],
    );
    return rows[0] as {
      credit_micro: string;
      activated_at: Date | null;
      paid_until: Date;
      reset: number | null;
    };
  };

  it('reports without --confirm, then zeroes what test USDC bought', async () => {
    const account = await testnetCustomer();
    const before = await stateOf(account.id);

    const dry = await admin('reset-testnet-billing');
    expect(dry.stdout).toContain('Dry run');
    expect(dry.stdout).toContain('1 account(s) with credits: $1.750000 total');
    expect(dry.stdout).toContain('1 activated account(s)');
    expect(dry.stdout).toContain('1 paid monitor(s)');
    expect(await stateOf(account.id)).toEqual(before);

    const out = await admin('reset-testnet-billing', '--confirm');
    expect(out.stdout).toContain('Reset testnet billing');
    const after = await stateOf(account.id);
    expect(after).toMatchObject({ credit_micro: '0', activated_at: null, reset: -1_750_000 });
    expect(after.paid_until.getTime()).toBeLessThanOrEqual(Date.now());
    // The payment history and the account's monitors stay.
    const { rows } = await database.pool.query(
      'select (select count(*)::int from payments) as p, (select count(*)::int from monitors) as m',
    );
    expect(rows[0]).toEqual({ p: 1, m: 2 });

    // The worker cannot renew the paid monitor from the zeroed balance: it is paused.
    expect(await renewPaidMonitors(database.db, new Date())).toEqual({ renewed: 0, paused: 1 });

    // Idempotent: a second run has nothing left to do.
    const again = await admin('reset-testnet-billing', '--confirm');
    expect(again.stdout).toContain('0 account(s) with credits');
  }, 60_000);

  it('refuses once a mainnet payment exists', async () => {
    const account = await testnetCustomer();
    await database.pool.query(
      `insert into payments (id, account_id, product, amount_micro, network, asset, transaction)
       values ('pay_main', $1, 'activation', 100000, 'eip155:8453', 'usdc', '0xmain')`,
      [account.id],
    );
    await expect(admin('reset-testnet-billing', '--confirm')).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing'),
    });
    expect((await stateOf(account.id)).credit_micro).toBe('1750000');
  }, 30_000);
});
