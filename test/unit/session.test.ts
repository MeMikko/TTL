import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_TTL_MS,
  issueOperatorSession,
  SESSION_PREFIX,
  verifyOperatorSession,
} from '../../src/core/session.js';

const secret = Buffer.alloc(32, 9);
const now = new Date('2026-09-30T12:00:00Z');

describe('operator session token', () => {
  it('round-trips a valid token', () => {
    const { token, expiresAt } = issueOperatorSession(secret, 'acc_123', now);
    expect(token.startsWith(SESSION_PREFIX)).toBe(true);
    expect(expiresAt.getTime()).toBe(now.getTime() + DEFAULT_SESSION_TTL_MS);
    expect(verifyOperatorSession(secret, token, now)).toBe('acc_123');
  });

  it('rejects an expired token', () => {
    const { token } = issueOperatorSession(secret, 'acc_123', now, 60_000);
    expect(verifyOperatorSession(secret, token, new Date(now.getTime() + 61_000))).toBeNull();
  });

  it('rejects a tampered payload or signature, and a wrong secret', () => {
    const { token } = issueOperatorSession(secret, 'acc_123', now);
    expect(verifyOperatorSession(Buffer.alloc(32, 8), token, now)).toBeNull();
    expect(verifyOperatorSession(secret, token + 'x', now)).toBeNull();
    // Swap the account id in the payload but keep the old signature.
    const forgedPayload = Buffer.from('acc_evil.9999999999').toString('base64url');
    const sig = token.slice(token.lastIndexOf('.') + 1);
    expect(
      verifyOperatorSession(secret, `${SESSION_PREFIX}${forgedPayload}.${sig}`, now),
    ).toBeNull();
  });

  it('rejects non-session tokens', () => {
    expect(verifyOperatorSession(secret, 't2l_notasession', now)).toBeNull();
    expect(verifyOperatorSession(secret, 'garbage', now)).toBeNull();
  });
});
