import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
});

export type Config = z.infer<typeof envSchema>;

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
