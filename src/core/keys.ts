import { generateApiKey } from './api-keys.js';
import { countActiveKeys } from './accounts.js';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { ApiKey } from './db/schema.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';

/** Issues a new API key for an account, enforcing the per-account cap. */
export async function issueApiKey(
  db: Db,
  accountId: string,
  name: string,
  maxKeys: number,
): Promise<{ record: ApiKey; key: string }> {
  if ((await countActiveKeys(db, accountId)) >= maxKeys) {
    throw new ApiError(
      409,
      'too_many_keys',
      `An account can have at most ${maxKeys} active API keys; revoke one first`,
    );
  }
  const generated = generateApiKey();
  const [record] = await db
    .insert(schema.apiKeys)
    .values({
      id: newId('key'),
      accountId,
      prefix: generated.prefix,
      keyHash: generated.hash,
      name,
    })
    .returning();
  if (!record) throw new Error('failed to insert api key');
  return { record, key: generated.key };
}
