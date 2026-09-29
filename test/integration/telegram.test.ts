import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTelegramClient } from '../../src/core/telegram.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';
import { fakeTelegram } from '../helpers/fake-telegram.js';
import { startTargetServer } from '../helpers/target-server.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const SECRET = 'webhook-secret-0123456789';
const tgConfig = testConfig({
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_BOT_USERNAME: 'time2live_bot',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
});

let now = new Date('2026-09-29T12:00:00Z');
function setup() {
  const tg = fakeTelegram();
  const app = buildApp(database, { config: tgConfig, telegram: tg.client, now: () => now });
  const update = (text: string, chatId: number | string = 555, secret = SECRET) =>
    app.request('/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ update_id: 1, message: { text, chat: { id: chatId } } }),
    });
  return { app, tg, update };
}

const linked = async (app: ReturnType<typeof setup>['app'], key: string) =>
  (
    (await (await app.request('/v1/account', { headers: bearer(key) })).json()) as {
      telegram: { linked: boolean };
    }
  ).telegram.linked;

describe('Telegram linking', () => {
  it('links a chat through the bot deep link and unlinks with /stop', async () => {
    const { app, tg, update } = setup();
    const me = await signIn(app);
    const res = await app.request('/v1/account/telegram/link', json({}, bearer(me.apiKey.key)));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const token = new URL(url).searchParams.get('start')!;
    expect(url).toMatch(/^https:\/\/t\.me\/time2live_bot\?start=[0-9A-Za-z]{32}$/);

    expect(await linked(app, me.apiKey.key)).toBe(false);
    expect((await update(`/start ${token}`)).status).toBe(200);
    expect(await linked(app, me.apiKey.key)).toBe(true);
    expect(tg.sent.at(-1)).toMatchObject({
      chatId: '555',
      text: expect.stringContaining('Linked'),
    });

    // Tokens are single use.
    await update(`/start ${token}`, 999);
    expect(tg.sent.at(-1)!.text).toContain('invalid or expired');
    const { rows } = await database.pool.query('select telegram_chat_id from accounts');
    expect(rows[0].telegram_chat_id).toBe('555');

    await update('/stop');
    expect(await linked(app, me.apiKey.key)).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const { app, tg, update } = setup();
    const me = await signIn(app);
    const { url } = (await (
      await app.request('/v1/account/telegram/link', json({}, bearer(me.apiKey.key)))
    ).json()) as { url: string };
    now = new Date(now.getTime() + 16 * 60_000);
    await update(`/start ${new URL(url).searchParams.get('start')}`);
    expect(tg.sent.at(-1)!.text).toContain('invalid or expired');
    expect(await linked(app, me.apiKey.key)).toBe(false);
  });

  it('authenticates Telegram with the secret token', async () => {
    const { update, tg } = setup();
    expect((await update('/start x', 1, 'wrong-secret-wrong-secret')).status).toBe(401);
    expect((await update('/start x', 1, '')).status).toBe(401);
    expect(tg.sent).toHaveLength(0);
  });

  it('can unlink via the API', async () => {
    const { app, update } = setup();
    const me = await signIn(app);
    const { url } = (await (
      await app.request('/v1/account/telegram/link', json({}, bearer(me.apiKey.key)))
    ).json()) as { url: string };
    await update(`/start ${new URL(url).searchParams.get('start')}`);
    const res = await app.request('/v1/account/telegram', {
      method: 'DELETE',
      headers: bearer(me.apiKey.key),
    });
    expect(res.status).toBe(200);
    expect(await linked(app, me.apiKey.key)).toBe(false);
  });

  it('is unavailable when the bot is not configured', async () => {
    const app = buildApp(database);
    const me = await signIn(app);
    const res = await app.request('/v1/account/telegram/link', json({}, bearer(me.apiKey.key)));
    expect(res.status).toBe(501);
    expect((await app.request('/telegram/webhook', json({}))).status).toBe(404);
  });

  it('requires username and secret alongside the bot token', () => {
    expect(() => testConfig({ TELEGRAM_BOT_TOKEN: 'x' })).toThrow(/TELEGRAM_BOT_USERNAME/);
  });

  it('accepts the bot username with the "@" BotFather shows, and rejects junk', () => {
    const base = { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_WEBHOOK_SECRET: SECRET };
    expect(
      testConfig({ ...base, TELEGRAM_BOT_USERNAME: '@time2live_bot' }).TELEGRAM_BOT_USERNAME,
    ).toBe('time2live_bot');
    expect(
      testConfig({ ...base, TELEGRAM_BOT_USERNAME: ' time2live_bot ' }).TELEGRAM_BOT_USERNAME,
    ).toBe('time2live_bot');
    expect(() => testConfig({ ...base, TELEGRAM_BOT_USERNAME: 'https://t.me/x' })).toThrow(
      /TELEGRAM_BOT_USERNAME/,
    );
  });
});

describe('Telegram API client', () => {
  let api: Awaited<ReturnType<typeof startTargetServer>>;
  beforeAll(async () => {
    api = await startTargetServer();
  });
  afterAll(() => api.close());

  it('sends plain-text messages to /bot<token>/sendMessage', async () => {
    api.setHandler((_r, res) =>
      res.setHeader('content-type', 'application/json').end('{"ok":true}'),
    );
    const client = createTelegramClient({
      token: '123:abc',
      apiBase: api.url('').replace(/\/$/, ''),
    });
    const res = await client.sendMessage('42', 'hello <b>');
    expect(res).toEqual({ ok: true, status: 200 });
    const req = api.received.at(-1)!;
    expect(req.url).toBe('/bot123:abc/sendMessage');
    expect(JSON.parse(req.body)).toEqual({
      chat_id: '42',
      text: 'hello <b>',
      disable_web_page_preview: true,
    });
  });

  it('parses retry_after and never leaks the token in errors', async () => {
    api.setHandler((_r, res) =>
      res
        .writeHead(429, { 'content-type': 'application/json' })
        .end('{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":7}}'),
    );
    const client = createTelegramClient({
      token: 'SECRET:TOKEN',
      apiBase: api.url('').replace(/\/$/, ''),
    });
    expect(await client.sendMessage('1', 'x')).toEqual({
      ok: false,
      status: 429,
      retryAfterSeconds: 7,
      error: 'Too Many Requests',
    });
    const down = createTelegramClient({ token: 'SECRET:TOKEN', apiBase: 'http://127.0.0.1:1' });
    const err = await down.sendMessage('1', 'x');
    expect(err.ok).toBe(false);
    expect(JSON.stringify(err)).not.toContain('SECRET');
  });
});
