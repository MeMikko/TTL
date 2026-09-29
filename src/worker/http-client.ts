import { Agent, request, type Dispatcher } from 'undici';
import {
  BlockedTargetError,
  createGuardedLookup,
  validateTargetUrl,
  type TargetPolicy,
} from '../core/ssrf.js';

export interface OutboundRequest {
  url: string;
  method: string;
  /** Caller-controlled headers; dropped on cross-origin redirects. */
  userHeaders: Record<string, string>;
  /** Our own headers (signature etc.); always sent. */
  systemHeaders: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

export type FailureKind =
  'blocked_target' | 'timeout' | 'network' | 'too_many_redirects' | 'invalid_redirect';

export interface OutboundResult {
  /** HTTP status of the final response, if one was received. */
  status?: number;
  durationMs: number;
  responseSnippet?: string;
  /** Seconds from a Retry-After header on the final response, if present and numeric. */
  retryAfterSeconds?: number;
  failure?: { kind: FailureKind; message: string };
  finalUrl: string;
  redirects: number;
}

export interface HttpClientOptions {
  maxRedirects?: number;
  snippetBytes?: number;
  userAgent?: string;
  /** Override DNS resolution (tests). */
  resolve?: Parameters<typeof createGuardedLookup>[1];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hop-by-hop or security-relevant headers callers may not set. */
export const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
]);

export interface HttpClient {
  send(req: OutboundRequest): Promise<OutboundResult>;
  close(): Promise<void>;
}

export function createHttpClient(policy: TargetPolicy, opts: HttpClientOptions = {}): HttpClient {
  const maxRedirects = opts.maxRedirects ?? 3;
  const snippetBytes = opts.snippetBytes ?? 4096;
  const userAgent = opts.userAgent ?? 'time2live-webhooks/1.0 (+https://time2live.xyz)';
  const agent = new Agent({
    connect: { lookup: createGuardedLookup(policy, opts.resolve), timeout: 10_000 },
    keepAliveTimeout: 10_000,
    connections: 32,
  });

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    // One deadline for the whole exchange (all hops). Cleared when done so a late abort never
    // fires into an already finished request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      return await exchange(req, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function exchange(req: OutboundRequest, signal: AbortSignal): Promise<OutboundResult> {
    const started = performance.now();
    let url: URL;
    try {
      url = validateTargetUrl(req.url, policy);
    } catch (err) {
      return fail(req.url, 0, 'blocked_target', (err as Error).message);
    }
    const originalOrigin = url.origin;
    let method = req.method.toUpperCase();
    let body = req.body;
    let redirects = 0;

    function fail(finalUrl: string, n: number, kind: FailureKind, message: string): OutboundResult {
      return {
        durationMs: Math.round(performance.now() - started),
        failure: { kind, message },
        finalUrl,
        redirects: n,
      };
    }

    for (;;) {
      const sameOrigin = url.origin === originalOrigin;
      const headers: Record<string, string> = {
        ...(sameOrigin ? req.userHeaders : {}),
        ...req.systemHeaders,
        'user-agent': userAgent,
      };
      if (body !== null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }

      let res: Dispatcher.ResponseData;
      try {
        res = await request(url, {
          dispatcher: agent,
          method: method as Dispatcher.HttpMethod,
          headers,
          body: body ?? undefined,
          signal,
          headersTimeout: req.timeoutMs,
          bodyTimeout: req.timeoutMs,
        });
      } catch (err) {
        return fail(url.toString(), redirects, classify(err, signal), describe(err));
      }

      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(res.statusCode) && typeof location === 'string') {
        await discard(res.body);
        if (redirects >= maxRedirects) {
          return fail(
            url.toString(),
            redirects,
            'too_many_redirects',
            `more than ${maxRedirects} redirects`,
          );
        }
        let next: URL;
        try {
          next = validateTargetUrl(new URL(location, url), policy);
        } catch (err) {
          const kind = err instanceof BlockedTargetError ? 'blocked_target' : 'invalid_redirect';
          return fail(
            location,
            redirects + 1,
            kind,
            `redirect rejected: ${(err as Error).message}`,
          );
        }
        redirects++;
        if (
          res.statusCode === 303 ||
          ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = null;
        }
        url = next;
        continue;
      }

      let snippet: string;
      try {
        snippet = await readSnippet(res.body, snippetBytes);
      } catch (err) {
        return {
          ...fail(url.toString(), redirects, classify(err, signal), describe(err)),
          status: res.statusCode,
        };
      }
      const retryAfter = Number(res.headers['retry-after']);
      return {
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        responseSnippet: snippet,
        ...(Number.isFinite(retryAfter) && retryAfter >= 0
          ? { retryAfterSeconds: retryAfter }
          : {}),
        finalUrl: url.toString(),
        redirects,
      };
    }
  }

  return { send, close: () => agent.close() };
}

async function readSnippet(body: Dispatcher.ResponseData['body'], limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
    size += buf.length;
    if (size >= limit) break; // we never need more than the snippet
  }
  await discard(body);
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

/** Releases a response body without reading it; never throws. */
async function discard(body: Dispatcher.ResponseData['body']): Promise<void> {
  body.on('error', () => {});
  try {
    await body.dump({ limit: 0 });
  } catch {
    body.destroy();
  }
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  while (e && out.length < 5) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

function classify(err: unknown, signal: AbortSignal): FailureKind {
  const chain = causeChain(err);
  if (chain.some((e) => e instanceof BlockedTargetError)) return 'blocked_target';
  if (signal.aborted) return 'timeout';
  if (
    chain.some((e) =>
      ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(
        (e as { code?: string }).code ?? '',
      ),
    )
  ) {
    return 'timeout';
  }
  return 'network';
}

function describe(err: unknown): string {
  const chain = causeChain(err);
  const blocked = chain.find((e) => e instanceof BlockedTargetError) as Error | undefined;
  if (blocked) return blocked.message;
  const e = chain[chain.length - 1] as { code?: string; message?: string } | undefined;
  return [e?.code, e?.message].filter(Boolean).join(': ').slice(0, 500) || 'request failed';
}
