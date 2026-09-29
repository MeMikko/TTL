import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Client IP for rate limiting. Behind Caddy (TRUST_PROXY=true) the right-most X-Forwarded-For
 * entry is the address Caddy saw; Caddy drops client-supplied forwarding headers from untrusted
 * peers, so the value cannot be spoofed. Never trust the header when exposed directly.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // e.g. app.request() in tests, where there is no socket
  }
}
