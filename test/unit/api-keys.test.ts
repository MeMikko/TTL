import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey } from '../../src/core/api-keys.js';
import { newId, randomBase62 } from '../../src/core/ids.js';

describe('api keys', () => {
  it('generates well-formed, unique keys with matching hash and prefix', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.prefix).toMatch(/^t2l_[0-9A-Za-z]{8}$/);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed keys', () => {
    expect(looksLikeApiKey('t2l_short')).toBe(false);
    expect(looksLikeApiKey(`xxx_${'a'.repeat(43)}`)).toBe(false);
    expect(looksLikeApiKey(`t2l_${'a'.repeat(42)}!`)).toBe(false);
  });
});

describe('ids', () => {
  it('produces prefixed base62 ids', () => {
    expect(newId('acc')).toMatch(/^acc_[0-9A-Za-z]{22}$/);
  });

  it('uses the whole alphabet roughly uniformly', () => {
    const counts = new Map<string, number>();
    for (const ch of randomBase62(62_000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(62);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });
});
