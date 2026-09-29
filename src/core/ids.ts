import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform random base62 string (rejection sampling avoids modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 248 = 62 * 4: bytes >= 248 would bias the distribution.
      if (byte < 248) out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export type IdPrefix = 'acc' | 'key';

/** Prefixed public identifier, e.g. "acc_3kT9…" (22 base62 chars ≈ 131 bits). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBase62(22)}`;
}
