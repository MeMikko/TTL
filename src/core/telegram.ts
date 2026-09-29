/**
 * Minimal Telegram Bot API client. The host is fixed (not user-controlled), so it does not go
 * through the SSRF-guarded webhook client.
 */
export interface TelegramResult {
  ok: boolean;
  status?: number;
  retryAfterSeconds?: number;
  error?: string;
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<TelegramResult>;
  setWebhook(url: string, secretToken: string): Promise<TelegramResult>;
}

export interface TelegramOptions {
  token: string;
  apiBase: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createTelegramClient(opts: TelegramOptions): TelegramClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call(method: string, payload: Record<string, unknown>): Promise<TelegramResult> {
    try {
      const res = await doFetch(`${opts.apiBase}/bot${opts.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (res.ok && body.ok) return { ok: true, status: res.status };
      return {
        ok: false,
        status: res.status,
        retryAfterSeconds: body.parameters?.retry_after,
        error: body.description ?? `HTTP ${res.status}`,
      };
    } catch (err) {
      // Never surface the URL: it contains the bot token.
      return {
        ok: false,
        error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network error',
      };
    }
  }

  return {
    // Plain text (no parse_mode) so user-supplied monitor names cannot inject markup.
    sendMessage: (chatId, text) =>
      call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),
    setWebhook: (url, secretToken) =>
      call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'] }),
  };
}
