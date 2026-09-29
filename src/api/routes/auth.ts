import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { parseSiweMessage } from 'viem/siwe';
import { findOrCreateAccount, normalizeAddress } from '../../core/accounts.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import { issueApiKey } from '../../core/keys.js';
import { buildChallenge, verifySignature } from '../../core/siwe.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';
import {
  AddressSchema,
  HexSchema,
  KeyNameSchema,
  NewApiKeySchema,
  errorResponses,
} from '../schemas.js';
import { serializeApiKey } from '../serializers.js';

const challengeRoute = createRoute({
  method: 'post',
  path: '/v1/auth/challenge',
  tags: ['auth'],
  summary: 'Request a Sign-In with Ethereum (EIP-4361) message to sign',
  description:
    'Step 1 of wallet registration/login. Sign the returned `message` verbatim with the wallet ' +
    '(EIP-191 personal_sign) and submit it to /v1/auth/verify before `expiresAt`.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            address: AddressSchema,
            chainId: z.number().int().positive().default(8453).openapi({ example: 8453 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Challenge issued',
      content: {
        'application/json': {
          schema: z.object({
            nonce: z.string(),
            message: z.string(),
            expiresAt: z.iso.datetime(),
          }),
        },
      },
    },
    ...errorResponses(400, 429),
  },
});

const verifyRoute = createRoute({
  method: 'post',
  path: '/v1/auth/verify',
  tags: ['auth'],
  summary: 'Submit the signed challenge and receive an API key',
  description:
    'Step 2. Creates the account on first sign-in and issues a new API key. The key is ' +
    'returned only once.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            message: z.string().min(1).max(4000),
            signature: HexSchema,
            keyName: KeyNameSchema.default('default'),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Authenticated; API key issued',
      content: {
        'application/json': {
          schema: z.object({
            accountId: z.string(),
            address: z.string(),
            created: z.boolean().openapi({ description: 'True when the account was just created' }),
            apiKey: NewApiKeySchema,
          }),
        },
      },
    },
    ...errorResponses(400, 401, 403, 409, 429),
  },
});

export function authRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const app = createRouter();

  app.openapi(challengeRoute, async (c) => {
    const { address, chainId } = c.req.valid('json');
    if (!deps.config.SIWE_CHAIN_IDS.includes(chainId)) {
      throw new ApiError(
        400,
        'unsupported_chain',
        `chainId must be one of ${deps.config.SIWE_CHAIN_IDS.join(', ')}`,
      );
    }
    const challenge = buildChallenge({
      address,
      chainId,
      publicBaseUrl: deps.config.PUBLIC_BASE_URL,
      now: now(),
      ttlSeconds: deps.config.SIWE_NONCE_TTL_SECONDS,
    });
    await db.insert(schema.authNonces).values({
      nonce: challenge.nonce,
      address: normalizeAddress(address),
      chainId,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      createdAt: now(),
    });
    return c.json(
      {
        nonce: challenge.nonce,
        message: challenge.message,
        expiresAt: challenge.expiresAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(verifyRoute, async (c) => {
    const { message, signature, keyName } = c.req.valid('json');

    let nonce: string | undefined;
    try {
      nonce = parseSiweMessage(message).nonce;
    } catch {
      nonce = undefined;
    }
    if (!nonce)
      throw new ApiError(401, 'invalid_message', 'Not a SIWE message issued by this service');

    // Consume the nonce atomically first: a challenge can be attempted exactly once.
    const t = schema.authNonces;
    const [challenge] = await db
      .update(t)
      .set({ usedAt: now() })
      .where(and(eq(t.nonce, nonce), isNull(t.usedAt), gt(t.expiresAt, now())))
      .returning();
    if (!challenge) {
      throw new ApiError(
        401,
        'invalid_nonce',
        'Challenge is unknown, expired or already used; request a new one',
      );
    }
    if (challenge.message !== message) {
      throw new ApiError(401, 'invalid_message', 'Message does not match the issued challenge');
    }

    const valid = await verifySignature({
      address: challenge.address,
      message,
      signature: signature as `0x${string}`,
      chainId: challenge.chainId,
      smartWalletVerifier: deps.smartWalletVerifier,
    });
    if (!valid)
      throw new ApiError(401, 'invalid_signature', 'Signature does not match the address');

    const { account, created } = await findOrCreateAccount(db, challenge.address);
    if (account.status === 'frozen') {
      throw new ApiError(403, 'account_frozen', 'This account is frozen. Contact support.');
    }
    const { record, key } = await issueApiKey(
      db,
      account.id,
      keyName,
      deps.config.MAX_API_KEYS_PER_ACCOUNT,
    );
    deps.logger.info(
      { accountId: account.id, keyId: record.id },
      'api key issued via wallet sign-in',
    );

    return c.json(
      {
        accountId: account.id,
        address: account.walletAddress,
        created,
        apiKey: { ...serializeApiKey(record), key },
      },
      201,
    );
  });

  return app;
}
