import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, testDatabase } from '../helpers/app.js';

const database = testDatabase();
afterAll(() => database.close());

describe('GET /openapi.json', () => {
  it('documents the public API routes', async () => {
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
        '/v1/account/webhook-secret',
        '/v1/jobs',
        '/v1/jobs/{id}/trigger',
        '/v1/runs/{id}',
        '/v1/monitors',
        '/v1/monitors/{id}/events',
        '/v1/heartbeat/{id}',
        '/v1/account/telegram/link',
      ]),
    );
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    expect(Object.keys(doc.paths)).not.toContain('/telegram/webhook');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/billing', '/v1/billing/activate', '/v1/billing/credits']),
    );
  });

  it('tags every operation and documents the x402 challenge', async () => {
    const doc = (await (await buildApp(database).request('/openapi.json')).json()) as {
      tags: Array<{ name: string }>;
      paths: Record<
        string,
        Record<string, { tags: string[]; responses: Record<string, { headers?: object }> }>
      >;
    };
    const declared = new Set(doc.tags.map((t) => t.name));
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.tags, `${method} ${path}`).toHaveLength(1);
        expect(declared.has(op.tags[0]!), `${method} ${path}`).toBe(true);
      }
    }
    const create = doc.paths['/v1/monitors']!.post!;
    expect(create.responses['402']!.headers).toHaveProperty('PAYMENT-REQUIRED');
  });
});
