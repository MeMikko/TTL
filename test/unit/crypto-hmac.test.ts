import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, parseEncryptionKey } from '../../src/core/crypto.js';
import { generateWebhookSecret, signPayload, verifySignature } from '../../src/core/hmac.js';

describe('AES-GCM', () => {
  const key = randomBytes(32);

  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt(key, 'secret', 'job_1');
    const b = encrypt(key, 'secret', 'job_1');
    expect(a).not.toBe(b);
    expect(decrypt(key, a, 'job_1')).toBe('secret');
  });

  it('rejects a wrong key, wrong AAD and tampering', () => {
    const ct = encrypt(key, 'secret', 'job_1');
    expect(() => decrypt(randomBytes(32), ct, 'job_1')).toThrow();
    expect(() => decrypt(key, ct, 'job_2')).toThrow();
    const parts = ct.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(key, parts.join('.'), 'job_1')).toThrow();
  });

  it('validates key length', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow();
    expect(parseEncryptionKey(key.toString('base64')).equals(key)).toBe(true);
  });
});

describe('webhook HMAC', () => {
  const secret = generateWebhookSecret();
  const body = '{"hello":"world"}';
  const t = 1_790_000_000;

  it('signs in the documented format and verifies', () => {
    const header = signPayload(secret, body, t);
    expect(header).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, body, header, t + 10)).toBe(true);
  });

  it('rejects modified bodies, wrong secrets, stale timestamps and garbage', () => {
    const header = signPayload(secret, body, t);
    expect(verifySignature(secret, body + ' ', header, t)).toBe(false);
    expect(verifySignature(generateWebhookSecret(), body, header, t)).toBe(false);
    expect(verifySignature(secret, body, header, t + 301)).toBe(false);
    expect(verifySignature(secret, body, 'v1=abc', t)).toBe(false);
    expect(verifySignature(secret, body, `t=${t},v1=zz`, t)).toBe(false);
  });

  it('accepts any of several v1 signatures (secret rotation)', () => {
    const good = signPayload(secret, body, t).split(',')[1];
    expect(verifySignature(secret, body, `t=${t},v1=${'0'.repeat(64)},${good}`, t)).toBe(true);
  });
});
