import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './context.js';

/** OpenAPIHono instance with the shared validation-error format. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'validation_error',
              message: 'Request validation failed',
              details: result.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
          },
          400,
        );
      }
    },
  });
}
