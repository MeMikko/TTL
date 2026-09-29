import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findAccount, findOrCreateAccount } from '../../src/core/accounts.js';
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
