import { timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import { consumeLinkToken, createLinkToken, unlinkChat } from '../../core/telegram-link.js';
import { createTelegramClient, type TelegramClient } from '../../core/telegram.js';
import type { AppDeps, AppEnv } from '../context.js';
import { createRouter } from '../router.js';
import { errorResponses } from '../schemas.js';

const security = [{ bearerAuth: [] }];

const linkRoute = createRoute({
  method: 'post',
  path: '/v1/account/telegram/link',
  tags: ['account'],
  summary: 'Start linking a Telegram chat for monitor alerts',
  description:
    'Open the returned URL in Telegram and press Start (valid 15 minutes). Then enable ' +
    '`alerts.telegram` on monitors. Send /stop to the bot to unlink.',
  security,
  responses: {
    200: {
      description: 'Deep link to the bot',
      content: {
        'application/json': {
          schema: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
        },
      },
    },
    ...errorResponses(401, 403, 429, 501),
  },
});

const unlinkRoute = createRoute({
  method: 'delete',
  path: '/v1/account/telegram',
  tags: ['account'],
  summary: 'Unlink the Telegram chat',
  security,
  responses: {
    200: {
      description: 'Unlinked',
      content: { 'application/json': { schema: z.object({ linked: z.literal(false) }) } },
    },
    ...errorResponses(401, 403, 429),
  },
});

interface TelegramUpdate {
  message?: { text?: string; chat?: { id?: number | string } };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function telegramClientFromDeps(deps: AppDeps): TelegramClient | undefined {
  if (deps.telegram) return deps.telegram;
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_API_BASE } = deps.config;
  return TELEGRAM_BOT_TOKEN
    ? createTelegramClient({ token: TELEGRAM_BOT_TOKEN, apiBase: TELEGRAM_API_BASE })
    : undefined;
}

/** Authenticated account routes (mounted under /v1/account/*). */
export function telegramAccountRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const app = createRouter();

  app.openapi(linkRoute, async (c) => {
    const bot = deps.config.TELEGRAM_BOT_USERNAME;
    if (!deps.config.TELEGRAM_BOT_TOKEN || !bot) {
      throw new ApiError(
        501,
        'telegram_unavailable',
        'Telegram alerts are not configured on this server',
      );
    }
    const { token, expiresAt } = await createLinkToken(db, c.get('account').id, now());
    return c.json(
      { url: `https://t.me/${bot}?start=${token}`, expiresAt: expiresAt.toISOString() },
      200,
    );
  });

  app.openapi(unlinkRoute, async (c) => {
    await db
      .update(schema.accounts)
      .set({ telegramChatId: null })
      .where(eq(schema.accounts.id, c.get('account').id));
    return c.json({ linked: false as const }, 200);
  });

  return app;
}

/**
 * Bot webhook (not part of the public API). Telegram authenticates itself with the secret token
 * registered via setWebhook. Always answers 200 so Telegram does not retry bad updates forever.
 */
export function telegramWebhookRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const client = telegramClientFromDeps(deps);
  const secret = deps.config.TELEGRAM_WEBHOOK_SECRET;
  const app = new Hono<AppEnv>();

  app.post('/telegram/webhook', async (c) => {
    if (!client || !secret)
      return c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404);
    const given = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(given, secret)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid secret token' } }, 401);
    }
    const update = (await c.req.json().catch(() => ({}))) as TelegramUpdate;
    const text = update.message?.text?.trim() ?? '';
    const chatId = update.message?.chat?.id;
    if (chatId === undefined) return c.json({ ok: true });
    const chat = String(chatId);

    let reply: string;
    const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(text);
    if (start?.[1]) {
      const accountId = await consumeLinkToken(db, start[1], chat, now());
      reply = accountId
        ? '✅ Linked. Monitors with Telegram alerts enabled will notify this chat. Send /stop to unlink.'
        : '⚠️ This link is invalid or expired. Request a new one with POST /v1/account/telegram/link.';
    } else if (/^\/stop(?:@\w+)?$/.test(text)) {
      const n = await unlinkChat(db, chat);
      reply = n
        ? '🔕 Unlinked. This chat will no longer receive alerts.'
        : 'This chat is not linked.';
    } else {
      reply = 'time2live.xyz alert bot. Link this chat via POST /v1/account/telegram/link.';
    }
    const res = await client.sendMessage(chat, reply);
    if (!res.ok) deps.logger.warn({ error: res.error }, 'telegram reply failed');
    return c.json({ ok: true });
  });

  return app;
}
