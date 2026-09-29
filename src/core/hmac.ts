import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomBase62 } from './ids.js';

export const SIGNATURE_HEADER = 'T2L-Signature';
/** Default tolerance for receivers verifying the timestamp. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBase62(40)}`;
}

function digest(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Header value: "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>". */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${digest(secret, timestampSeconds, body)}`;
}

/**
 * Reference verifier (same logic as the README snippet for receivers). Accepts several v1
 * values so secrets can be rotated without downtime.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    if (k === 'v1' && v) sigs.push(v);
  }
  if (t === undefined || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(digest(secret, t, body), 'hex');
  return sigs.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
