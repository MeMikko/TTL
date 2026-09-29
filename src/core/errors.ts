import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Error with a stable machine-readable code, rendered as {"error": {code, message, details}}. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
