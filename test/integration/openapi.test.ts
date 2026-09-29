import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, testDatabase } from '../helpers/app.js';

const database = testDatabase();
afterAll(() => database.close());

describe('GET /openapi.json', () => {
  it('documents the auth, key and account routes', async () => {
    const res = await buildApp(database).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/auth/challenge',
        '/v1/auth/verify',
        '/v1/keys',
        '/v1/keys/{id}',
        '/v1/account',
      ]),
    );
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
  });
});
