import { ApiError } from './errors.js';
import {
  assertResolvesToPublic,
  BlockedTargetError,
  validateTargetUrl,
  type TargetPolicy,
} from './ssrf.js';

export type Resolve = Parameters<typeof assertResolvesToPublic>[2];

/**
 * Validates a user-supplied webhook URL at write time and returns its normalised form.
 * This is early feedback only; the authoritative check happens at connect time on every delivery.
 */
export async function assertWebhookUrl(
  policy: TargetPolicy,
  raw: string,
  resolve?: Resolve,
): Promise<string> {
  try {
    const url = validateTargetUrl(raw, policy);
    await assertResolvesToPublic(url.hostname, policy, resolve);
    return url.toString();
  } catch (err) {
    if (err instanceof BlockedTargetError) throw new ApiError(400, 'invalid_target', err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') {
      throw new ApiError(400, 'invalid_target', `target host does not resolve (${code})`);
    }
    throw err;
  }
}
