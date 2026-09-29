import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TargetPolicy } from '../../src/core/ssrf.js';
import { createHttpClient, type OutboundRequest } from '../../src/worker/http-client.js';
import { startTargetServer } from '../helpers/target-server.js';

let target: Awaited<ReturnType<typeof startTargetServer>>;
beforeAll(async () => {
  target = await startTargetServer();
});
afterAll(() => target.close());

/** Strict ranges, but the local test server's loopback IP is exempt. */
const policy: TargetPolicy = {
  allowHttp: true,
  allowedPorts: null,
  allowPrivate: false,
  blockedCidrs: [],
  testAllowIps: ['127.0.0.1'],
};

const fakeDns: Record<string, string[]> = {
  'target.test.example': ['127.0.0.1'],
  'metadata.test.example': ['169.254.169.254'],
};
const client = createHttpClient(policy, {
  resolve: (host, _o, cb) => {
    const a = fakeDns[host];
    if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(
      null,
      a.map((address) => ({ address, family: 4 })),
    );
  },
});
afterAll(() => client.close());

const base = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({
  url: target.url('/hook'),
  method: 'POST',
  userHeaders: { 'x-custom': 'yes', authorization: 'Bearer user-secret' },
  systemHeaders: { 't2l-delivery-id': 'run_1' },
  body: '{"a":1}',
  timeoutMs: 2000,
  ...over,
});

describe('http client', () => {
  it('delivers method, headers and body and returns a snippet', async () => {
    target.setHandler((_r, res) => {
      res.statusCode = 202;
      res.end('accepted!');
    });
    const before = target.received.length;
    const result = await client.send(base());
    expect(result).toMatchObject({ status: 202, responseSnippet: 'accepted!', redirects: 0 });
    const got = target.received[before]!;
    expect(got.method).toBe('POST');
    expect(got.body).toBe('{"a":1}');
    expect(got.headers['x-custom']).toBe('yes');
    expect(got.headers['t2l-delivery-id']).toBe('run_1');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['user-agent']).toMatch(/^time2live-webhooks/);
  });

  it('resolves hostnames through the guarded lookup', async () => {
    target.setHandler((_r, res) => res.end('ok'));
    const url = `http://target.test.example:${target.port}/x`;
    expect((await client.send(base({ url }))).status).toBe(200);
  });

  it('blocks a hostname that resolves to the metadata address (DNS rebinding)', async () => {
    const url = `http://metadata.test.example:${target.port}/latest/meta-data`;
    const result = await client.send(base({ url }));
    expect(result.status).toBeUndefined();
    expect(result.failure).toMatchObject({ kind: 'blocked_target' });
    expect(result.failure?.message).toContain('169.254.169.254');
  });

  it('blocks literal private IPs before connecting', async () => {
    const result = await client.send(base({ url: 'http://10.1.2.3/x' }));
    expect(result.failure?.kind).toBe('blocked_target');
  });

  it('follows same-origin redirects and keeps user headers', async () => {
    target.setHandler((r, res) => {
      if (r.url === '/hook') {
        res.writeHead(307, { location: '/final' }).end();
      } else res.end('final');
    });
    const before = target.received.length;
    const result = await client.send(base());
    expect(result).toMatchObject({ status: 200, redirects: 1, responseSnippet: 'final' });
    const final = target.received[before + 1]!;
    expect(final.method).toBe('POST'); // 307 preserves method and body
    expect(final.body).toBe('{"a":1}');
    expect(final.headers['authorization']).toBe('Bearer user-secret');
  });

  it('switches to GET without body on 303', async () => {
    target.setHandler((r, res) => {
      if (r.url === '/hook') res.writeHead(303, { location: '/see' }).end();
      else res.end('seen');
    });
    const before = target.received.length;
    await client.send(base());
    expect(target.received[before + 1]).toMatchObject({ method: 'GET', body: '' });
  });

  it('drops user headers on cross-origin redirects', async () => {
    target.setHandler((r, res) => {
      if (r.url === '/hook') {
        res.writeHead(302, { location: `http://target.test.example:${target.port}/other` }).end();
      } else res.end('other');
    });
    const before = target.received.length;
    const result = await client.send(base({ method: 'PUT' }));
    expect(result.status).toBe(200);
    const hop = target.received[before + 1]!;
    expect(hop.headers['authorization']).toBeUndefined();
    expect(hop.headers['x-custom']).toBeUndefined();
    expect(hop.headers['t2l-delivery-id']).toBe('run_1');
  });

  it('re-validates every redirect hop', async () => {
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      `http://metadata.test.example:${target.port}/`,
      'http://[::1]/',
      'file:///etc/passwd',
    ]) {
      target.setHandler((_r, res) => res.writeHead(302, { location }).end());
      const result = await client.send(base());
      expect(result.failure?.kind, location).toBe('blocked_target');
    }
  });

  it('stops after too many redirects', async () => {
    target.setHandler((_r, res) => res.writeHead(302, { location: '/again' }).end());
    const result = await client.send(base());
    expect(result.failure?.kind).toBe('too_many_redirects');
    expect(result.redirects).toBe(3);
  });

  it('times out slow targets', async () => {
    target.setHandler(async (_r, res) => {
      await new Promise((r) => setTimeout(r, 1500));
      res.end('late');
    });
    const result = await client.send(base({ timeoutMs: 300 }));
    expect(result.failure?.kind).toBe('timeout');
    expect(result.durationMs).toBeLessThan(1400);
  });

  it('truncates large responses to the snippet size', async () => {
    target.setHandler((_r, res) => res.end('x'.repeat(200_000)));
    const result = await client.send(base());
    expect(result.status).toBe(200);
    expect(result.responseSnippet).toHaveLength(4096);
  });

  it('reports Retry-After and connection errors', async () => {
    target.setHandler((_r, res) => res.writeHead(429, { 'retry-after': '42' }).end());
    expect(await client.send(base())).toMatchObject({ status: 429, retryAfterSeconds: 42 });

    const closed = await client.send(base({ url: 'http://127.0.0.1:1/' }));
    expect(closed.failure?.kind).toBe('network');
    expect(closed.failure?.message).toMatch(/ECONNREFUSED/);
  });
});
