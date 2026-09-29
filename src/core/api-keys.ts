import { createHash } from 'node:crypto';
import { randomBase62 } from './ids.js';

export const API_KEY_PREFIX = 't2l_';
const KEY_BODY_LENGTH = 43; // ≈ 256 bits of entropy
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
const KEY_FORMAT = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${KEY_BODY_LENGTH}}$`);

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

/**
 * High-entropy keys make an unsalted fast hash sufficient: brute-forcing a 256-bit secret is
 * infeasible regardless of hash speed, and a deterministic hash allows an indexed lookup.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(KEY_BODY_LENGTH);
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

export function looksLikeApiKey(value: string): boolean {
  return KEY_FORMAT.test(value);
}
