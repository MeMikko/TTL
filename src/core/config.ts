import { STRICT_POLICY, type TargetPolicy } from './ssrf.js';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
    WORKER_TICK_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
    HEALTH_MAX_TICK_AGE_MS: z.coerce.number().int().min(1000).default(120_000),

    /** Honour X-Forwarded-For (only when running behind our own reverse proxy, i.e. Caddy). */
    TRUST_PROXY: z.stringbool().default(false),

    SIWE_CHAIN_IDS: z
      .string()
      .default('8453,84532')
      .transform((s, ctx) => {
        const ids = s.split(',').map((x) => Number(x.trim()));
        if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
          ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of chain ids' });
          return z.NEVER;
        }
        return ids;
      }),
    SIWE_NONCE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** Optional RPCs used to verify smart-wallet (ERC-1271/6492) signatures. */
    BASE_RPC_URL: z.url().optional(),
    BASE_SEPOLIA_RPC_URL: z.url().optional(),

    MAX_API_KEYS_PER_ACCOUNT: z.coerce.number().int().min(1).default(20),

    /**
     * Real-time analytics dashboard (GET /analytics page, GET /v1/analytics data): global service
     * statistics, gated to this single operator wallet (compared lowercased). Empty disables it
     * entirely (the data endpoint 404s and the page says so).
     */
    ANALYTICS_ADDRESS: z
      .string()
      .default('0x8520B3693a2Cf3c2bEa3a505Af3A9c1b093954c7')
      .transform((s) => s.trim().toLowerCase())
      .refine((s) => s === '' || /^0x[0-9a-f]{40}$/.test(s), {
        message: 'must be empty or a 0x-prefixed EVM address',
      }),

    /** Requests per minute (token bucket capacity; refills continuously). */
    RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_AUTH_IP_PER_MIN: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_KEY_PER_MIN: z.coerce.number().int().min(1).default(300),

    /** base64 32-byte key for AES-256-GCM (openssl rand -base64 32). */
    ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, 'base64').length === 32, {
      message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
    }),

    /** Our own public IPs/CIDRs; webhook targets may never point back at us. */
    SERVER_PUBLIC_IPS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    /** Development only: allow http, any port and private/loopback webhook targets. */
    WEBHOOK_DEV_ALLOW_LOCAL: z.stringbool().default(false),
    /** Global limit per target host across all accounts (protects third parties). */
    TARGET_HOST_RATE_PER_MIN: z.coerce.number().int().min(1).default(60),
    DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(20),
    SCHEDULER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    MAX_JOBS_PER_ACCOUNT: z.coerce.number().int().min(1).default(100),

    /** Pings per monitor per minute (pings are unauthenticated; the id is the capability). */
    RATE_LIMIT_PING_PER_MIN: z.coerce.number().int().min(1).default(60),

    /** Telegram alerts are enabled when the bot token is set. */
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    /** Bot username; BotFather shows it as "@name", the leading "@" is accepted and removed. */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .trim()
      .transform((s) => s.replace(/^@/, ''))
      .pipe(
        z
          .string()
          .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username, e.g. time2live_bot'),
      )
      .optional(),
    /** Shared secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on webhook calls. */
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 chars of A-Z a-z 0-9 _ -')
      .optional(),
    TELEGRAM_API_BASE: z.url().default('https://api.telegram.org'),

    /**
     * Email alerts via an external transactional-email provider (Resend-compatible HTTP API).
     * Independent transport and infrastructure from Telegram and customer webhooks: a downstream
     * channel being down no longer silences a dead-agent alert. Requires ALERT_EMAIL_FROM.
     */
    RESEND_API_KEY: z.string().min(1).optional(),
    /** From address for alert emails, e.g. "time2live <alerts@time2live.xyz>". */
    ALERT_EMAIL_FROM: z.string().min(1).optional(),
    EMAIL_API_BASE: z.url().default('https://api.resend.com'),

    /** x402 payments. Disabled: quotas still apply, over-quota calls get a plain 402. */
    X402_ENABLED: z.stringbool().default(false),
    /** CAIP-2 network: eip155:84532 (Base Sepolia, testnet) or eip155:8453 (Base mainnet). */
    X402_NETWORK: z.enum(['eip155:84532', 'eip155:8453']).default('eip155:84532'),
    /** Address receiving USDC payments. */
    X402_PAY_TO: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed EVM address')
      .optional(),
    /** The public x402.org facilitator supports testnets only; mainnet needs another one. */
    X402_FACILITATOR_URL: z.url().default('https://x402.org/facilitator'),
    /** Optional static "Authorization" header value for facilitators that accept one. */
    X402_FACILITATOR_AUTHORIZATION: z.string().min(1).optional(),
    /**
     * Coinbase CDP Secret API key for the CDP facilitator
     * (X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402). CDP takes no static
     * header: every verify/settle/supported call is sent with a fresh JWT signed with this key.
     */
    CDP_API_KEY_ID: z.string().min(1).optional(),
    /** Ed25519 (base64) or EC (PEM) secret; `\n` escapes are accepted for a one-line PEM. */
    CDP_API_KEY_SECRET: z
      .string()
      .min(1)
      .transform((s) => s.replaceAll('\\n', '\n'))
      .optional(),

    /**
     * Keeper for the on-chain DeadMansSwitch: the worker discovers switches from the factory's
     * SwitchCreated events and calls trigger() on expired ones from a low-balance hot wallet.
     */
    KEEPER_ENABLED: z.stringbool().default(false),
    KEEPER_RPC_URL: z.url().optional(),
    KEEPER_CHAIN_ID: z.coerce
      .number()
      .int()
      .pipe(z.union([z.literal(84532), z.literal(8453), z.literal(31337)]))
      .default(84532),
    KEEPER_FACTORY_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed EVM address')
      .optional(),
    /** First block to scan for SwitchCreated (the factory's deployment block). */
    KEEPER_FROM_BLOCK: z.coerce.number().int().min(0).default(0),
    /** Hot wallet paying for trigger() gas. Keep only a few dollars of ETH on it. */
    KEEPER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key')
      .optional(),
    KEEPER_POLL_MS: z.coerce.number().int().min(1000).default(60_000),
    /** Blocks per eth_getLogs request (public RPCs cap the range). */
    KEEPER_LOG_CHUNK: z.coerce.number().int().min(1).max(100_000).default(2_000),
    /** Blocks to wait before trusting SwitchCreated logs (reorg safety). */
    KEEPER_CONFIRMATIONS: z.coerce.number().int().min(0).max(1_000).default(5),
    /** Refuse to send when the network's max fee is above this (protects the hot wallet). */
    KEEPER_MAX_FEE_GWEI: z.coerce.number().positive().default(1),
    /**
     * Gas limit cap for one trigger(); switches that would need more are skipped (a 20-token
     * switch needs ~0.9M). With KEEPER_MAX_FEE_GWEI it bounds the cost of any single trigger.
     */
    KEEPER_MAX_GAS: z.coerce.number().int().min(200_000).max(30_000_000).default(1_500_000),
    /** Warn in the logs below this keeper balance (ETH). */
    KEEPER_MIN_BALANCE_ETH: z.coerce.number().nonnegative().default(0.002),

    /** Dogfooding: the worker pings this heartbeat URL on every tick (see docs/OPERATIONS.md). */
    SELF_HEARTBEAT_URL: z.url().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.X402_ENABLED && !cfg.X402_PAY_TO) {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_PAY_TO'],
        message: 'required when X402_ENABLED',
      });
    }
    if (Boolean(cfg.CDP_API_KEY_ID) !== Boolean(cfg.CDP_API_KEY_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: [cfg.CDP_API_KEY_ID ? 'CDP_API_KEY_SECRET' : 'CDP_API_KEY_ID'],
        message: 'CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together',
      });
    }
    if (cfg.CDP_API_KEY_ID && cfg.X402_FACILITATOR_AUTHORIZATION) {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_FACILITATOR_AUTHORIZATION'],
        message: 'set either the CDP API key or a static authorization header, not both',
      });
    }
    const facilitatorHost = new URL(cfg.X402_FACILITATOR_URL).hostname;
    if (cfg.CDP_API_KEY_ID && facilitatorHost === 'x402.org') {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_FACILITATOR_URL'],
        message: 'CDP API key set: use https://api.cdp.coinbase.com/platform/v2/x402',
      });
    }
    if (cfg.X402_ENABLED && cfg.X402_NETWORK === 'eip155:8453' && facilitatorHost === 'x402.org') {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_FACILITATOR_URL'],
        message: 'the x402.org facilitator serves testnets only; Base mainnet needs e.g. CDP',
      });
    }
    if (cfg.KEEPER_ENABLED) {
      for (const key of [
        'KEEPER_RPC_URL',
        'KEEPER_FACTORY_ADDRESS',
        'KEEPER_PRIVATE_KEY',
      ] as const) {
        if (!cfg[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'required when KEEPER_ENABLED' });
        }
      }
    }
    // Guardrail against an incoherent half-testnet/half-mainnet deployment: if both x402 and the
    // keeper are on, they must be on the same real network (the local chain 31337 is exempt).
    if (cfg.X402_ENABLED && cfg.KEEPER_ENABLED && cfg.KEEPER_CHAIN_ID !== 31337) {
      const x402ChainId = Number(cfg.X402_NETWORK.split(':')[1]);
      if (x402ChainId !== cfg.KEEPER_CHAIN_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['KEEPER_CHAIN_ID'],
          message: `must match X402_NETWORK chain ${x402ChainId} (no mixed testnet/mainnet deploys)`,
        });
      }
    }
    if (cfg.RESEND_API_KEY && !cfg.ALERT_EMAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALERT_EMAIL_FROM'],
        message: 'required when RESEND_API_KEY is set',
      });
    }
    if (cfg.TELEGRAM_BOT_TOKEN && (!cfg.TELEGRAM_BOT_USERNAME || !cfg.TELEGRAM_WEBHOOK_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET are required with a bot token',
      });
    }
    if (cfg.NODE_ENV === 'production' && cfg.WEBHOOK_DEV_ALLOW_LOCAL) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_DEV_ALLOW_LOCAL'],
        message: 'must not be enabled in production',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

/** Outbound webhook policy derived from configuration. */
export function targetPolicyFromConfig(config: Config): TargetPolicy {
  return {
    ...STRICT_POLICY,
    ...(config.WEBHOOK_DEV_ALLOW_LOCAL
      ? { allowHttp: true, allowedPorts: null, allowPrivate: true }
      : {}),
    blockedCidrs: config.SERVER_PUBLIC_IPS,
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parse and validate configuration from an env-like object. Throws ConfigError on invalid input. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Stray whitespace or a Windows line ending (\r) in .env would otherwise fail validation
  // or, worse, end up inside secrets and URLs.
  const trimmed = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v?.trim()]));
  const result = envSchema.safeParse(trimmed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
