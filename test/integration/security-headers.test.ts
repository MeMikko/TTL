import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const app = buildApp(database, {
  config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz' }),
});

describe('security headers', () => {
  it('sets a locked-down CSP and Permissions-Policy', async () => {
    const res = await app.request('/healthz');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('img-src');
    const pp = res.headers.get('permissions-policy') ?? '';
    expect(pp).toContain('camera=()');
    expect(pp).toContain('geolocation=()');
  });
});

describe('CORS', () => {
  it('answers an API preflight without requiring auth', async () => {
    const res = await app.request('/v1/account/overview', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect([200, 204]).toContain(res.status); // not 401
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'authorization',
    );
  });

  it('answers an MCP preflight', async () => {
    const res = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('adds CORS + exposes rate-limit headers on a real API response', async () => {
    const me = await signIn(app);
    const res = await app.request('/v1/account/overview', {
      headers: { ...bearer(me.apiKey.key), origin: 'https://agent.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const expose = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(expose).toContain('ratelimit-remaining');
  });
});
