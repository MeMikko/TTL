/**
 * Minimal transactional-email client (Resend-compatible HTTP API). Used for the independent
 * alert channel: it runs on the provider's own infrastructure, so a customer webhook endpoint or
 * the Telegram API being down cannot silence a dead-agent alert. The host is fixed by config
 * (not user-controlled), so it does not go through the SSRF-guarded webhook client.
 */
export interface EmailResult {
  ok: boolean;
  status?: number;
  retryAfterSeconds?: number;
  error?: string;
}

export interface EmailClient {
  send(to: string, subject: string, text: string): Promise<EmailResult>;
}

export interface EmailOptions {
  apiKey: string;
  from: string;
  apiBase: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createEmailClient(opts: EmailOptions): EmailClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(to, subject, text) {
      try {
        const res = await doFetch(`${opts.apiBase.replace(/\/$/, '')}/emails`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ from: opts.from, to, subject, text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return { ok: true, status: res.status };
        const retryAfter = Number(res.headers.get('retry-after'));
        const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
        return {
          ok: false,
          status: res.status,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          error: body.message ?? body.name ?? `HTTP ${res.status}`,
        };
      } catch (err) {
        // Never surface the URL or key.
        return {
          ok: false,
          error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network error',
        };
      }
    },
  };
}
