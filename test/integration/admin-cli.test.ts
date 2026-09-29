import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findAccount, findOrCreateAccount } from '../../src/core/accounts.js';
import { testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';
import { TEST_DATABASE_URL } from '../helpers/env.js';

const run = promisify(execFile);
const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const admin = (...args: string[]) =>
  run('npx', ['tsx', 'src/bin/admin.ts', ...args], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
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
