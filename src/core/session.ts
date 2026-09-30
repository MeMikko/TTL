import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, stateless operator session token for the browser dashboard. Minted by signing a
 * SIWE challenge with the account's wallet (see POST /v1/auth/session), it authorises the same
 * account as an API key but is not stored: it cannot be listed or revoked, so it is deliberately
 * short-lived, and it survives `revoke-all` (the human keeps access while the agent's keys die).
 */
export const SESSION_PREFIX = 't2ls_';
export const DEFAULT_SESSION_TTL_MS = 60 * 60_000;

const b64url = (b: Buffer) => b.toString('base64url');

function sign(secret: Buffer, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export interface OperatorSession {
  token: string;
  expiresAt: Date;
}

export function issueOperatorSession(
  secret: Buffer,
  accountId: string,
  now: Date,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): OperatorSession {
  const expSec = Math.floor((now.getTime() + ttlMs) / 1000);
  const payload = `${accountId}.${expSec}`;
  const token = `${SESSION_PREFIX}${b64url(Buffer.from(payload))}.${sign(secret, payload)}`;
  return { token, expiresAt: new Date(expSec * 1000) };
}

export function looksLikeSessionToken(value: string): boolean {
  return value.startsWith(SESSION_PREFIX);
}

/** Returns the account id if the token is a valid, unexpired operator session, else null. */
export function verifyOperatorSession(secret: Buffer, token: string, now: Date): string | null {
  if (!looksLikeSessionToken(token)) return null;
  const rest = token.slice(SESSION_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = rest.slice(0, dot);
  const given = rest.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString();
  } catch {
    return null;
  }
  const expected = sign(secret, payload);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const sep = payload.lastIndexOf('.');
  const accountId = payload.slice(0, sep);
  const expSec = Number(payload.slice(sep + 1));
  if (!accountId || !Number.isFinite(expSec) || expSec * 1000 <= now.getTime()) return null;
  return accountId;
}
