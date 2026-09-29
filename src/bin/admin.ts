import 'dotenv/config';
import { parseArgs } from 'node:util';
import { findAccount, freezeAccount, unfreezeAccount } from '../core/accounts.js';
import { loadConfig } from '../core/config.js';
import { createDatabase } from '../core/db/index.js';

const USAGE = `Usage: admin <command> [options]

Commands:
  show     <accountId|address>                    Show account details
  freeze   <accountId|address> --reason "<text>"  Freeze an account (API 403, jobs stop, no alerts)
  unfreeze <accountId|address>                    Unfreeze an account

Production: docker compose exec api node dist/bin/admin.js freeze acc_… --reason "abuse"
Local:      npm run admin -- freeze acc_… --reason "abuse"`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reason: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
const [command, target] = positionals;

if (values.help || !command || !target) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, 1);

try {
  const account = await findAccount(database.db, target);
  if (!account) throw new Error(`No account found for ${target}`);

  switch (command) {
    case 'show':
      console.log(JSON.stringify(account, null, 2));
      break;
    case 'freeze': {
      if (!values.reason?.trim()) throw new Error('--reason is required');
      const updated = await freezeAccount(database.db, account.id, values.reason.trim());
      console.log(`Frozen ${updated.id} (${updated.walletAddress}): ${updated.frozenReason}`);
      break;
    }
    case 'unfreeze': {
      const updated = await unfreezeAccount(database.db, account.id);
      console.log(`Unfrozen ${updated.id} (${updated.walletAddress})`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await database.close();
}
