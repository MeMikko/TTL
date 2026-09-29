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
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    /** Shared secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on webhook calls. */
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 chars of A-Z a-z 0-9 _ -')
      .optional(),
    TELEGRAM_API_BASE: z.url().default('https://api.telegram.org'),

    /** Dogfooding: the worker pings this heartbeat URL on every tick (see docs/OPERATIONS.md). */
    SELF_HEARTBEAT_URL: z.url().optional(),
  })
  .superRefine((cfg, ctx) => {
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
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
