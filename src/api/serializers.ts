import type { ApiKey } from '../core/db/schema.js';

export function serializeApiKey(k: ApiKey) {
  return {
    id: k.id,
    prefix: k.prefix,
    name: k.name,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  };
}
