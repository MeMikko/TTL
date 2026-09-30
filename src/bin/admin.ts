import 'dotenv/config';
import { parseArgs } from 'node:util';
import {
  findAccount,
  findOrCreateAccount,
  freezeAccount,
  unfreezeAccount,
} from '../core/accounts.js';
import { loadConfig, type Config } from '../core/config.js';
import { createDatabase, schema, type Db } from '../core/db/index.js';
import { newId } from '../core/ids.js';
import { createLinkToken } from '../core/telegram-link.js';
import { createTelegramClient } from '../core/telegram.js';
import { resetTestnetBilling } from '../core/testnet-reset.js';

const USAGE = `Usage: admin <command> [options]

Commands:
  show     <accountId|address>                    Show account details
  freeze   <accountId|address> --reason "<text>"  Freeze an account (API 403, jobs stop, no alerts)
  unfreeze <accountId|address>                    Unfreeze an account
  telegram-webhook                                 Register <PUBLIC_BASE_URL>/telegram/webhook with Telegram
  telegram-link <accountId|address>                Print a one-time t.me link that connects a Telegram
                                                   chat to the account (no API key needed)
  create-monitor <address> --name <n> --ttl <s> [--grace <s>] [--telegram]
                                                   Operator monitor (bypasses tier limits; creates
                                                   the account if needed). Prints the ping URL.
  reset-testnet-billing [--confirm]                Before switching x402 to mainnet: zero all credits,
                                                   clear activations and end paid monitor periods
                                                   (bought with test USDC). Dry run without --confirm;
                                                   refuses once any mainnet payment exists.

Production: docker compose exec api node dist/bin/admin.js freeze acc_… --reason "abuse"
Local:      npm run admin -- freeze acc_… --reason "abuse"`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: 'string' },
    name: { type: 'string' },
    ttl: { type: 'string' },
    grace: { type: 'string', default: '60' },
    telegram: { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, target] = positionals;
const needsTarget = command !== 'telegram-webhook' && command !== 'reset-testnet-billing';

if (values.help || !command || (needsTarget && !target)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

async function registerTelegramWebhook(config: Config) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_API_BASE, PUBLIC_BASE_URL } =
    config;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set');
  }
  const url = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/telegram/webhook`;
  const res = await createTelegramClient({
    token: TELEGRAM_BOT_TOKEN,
    apiBase: TELEGRAM_API_BASE,
  }).setWebhook(url, TELEGRAM_WEBHOOK_SECRET);
  if (!res.ok) throw new Error(`setWebhook failed: ${res.error}`);
  console.log(`Telegram webhook set to ${url}`);
}

async function createOperatorMonitor(db: Db, config: Config, address: string) {
  const ttl = Number(values.ttl);
  const grace = Number(values.grace);
  if (!values.name || !Number.isInteger(ttl) || ttl < 60 || !Number.isInteger(grace) || grace < 0) {
    throw new Error('--name and --ttl (>= 60) are required; --grace must be >= 0');
  }
  const { account } = await findOrCreateAccount(db, address);
  const [monitor] = await db
    .insert(schema.monitors)
    .values({
      id: newId('mon'),
      accountId: account.id,
      name: values.name,
      ttlSeconds: ttl,
      graceSeconds: grace,
      alertTelegram: values.telegram,
    })
    .returning();
  console.log(`Monitor ${monitor!.id} for ${account.id}`);
  console.log(`Ping URL: ${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/heartbeat/${monitor!.id}`);
}

async function resetTestnet(db: Db) {
  const apply = values.confirm;
  const s = await resetTestnetBilling(db, new Date(), apply);
  const lines = [
    `${s.accountsWithCredits} account(s) with credits: $${(s.creditMicro / 1e6).toFixed(6)} total → $0`,
    `${s.activatedAccounts} activated account(s) → unactivated`,
    `${s.paidMonitors} paid monitor(s) → period ends now (renewed from credits or paused with an alert)`,
  ];
  console.log(apply ? 'Reset testnet billing:' : 'Dry run (nothing changed; add --confirm):');
  for (const line of lines) console.log(`  ${line}`);
}

async function accountCommand(db: Db, config: Config, cmd: string, idOrAddress: string) {
  const account = await findAccount(db, idOrAddress);
  if (!account) throw new Error(`No account found for ${idOrAddress}`);

  switch (cmd) {
    case 'show':
      console.log(JSON.stringify({ ...account, webhookSecretEnc: undefined }, null, 2));
      break;
    case 'freeze': {
      if (!values.reason?.trim()) throw new Error('--reason is required');
      const updated = await freezeAccount(db, account.id, values.reason.trim());
      console.log(`Frozen ${updated.id} (${updated.walletAddress}): ${updated.frozenReason}`);
      break;
    }
    case 'unfreeze': {
      const updated = await unfreezeAccount(db, account.id);
      console.log(`Unfrozen ${updated.id} (${updated.walletAddress})`);
      break;
    }
    case 'telegram-link': {
      if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_BOT_USERNAME) {
        throw new Error('Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME)');
      }
      const { token, expiresAt } = await createLinkToken(db, account.id, new Date());
      console.log(`Open within 15 minutes (until ${expiresAt.toISOString()}) and press Start:`);
      console.log(`https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL, 1);

try {
  if (command === 'telegram-webhook') await registerTelegramWebhook(config);
  else if (command === 'create-monitor') await createOperatorMonitor(database.db, config, target!);
  else if (command === 'reset-testnet-billing') await resetTestnet(database.db);
  else await accountCommand(database.db, config, command!, target!);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await database.close();
}
