import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';

const database = testDatabase();
afterAll(() => database.close());

const app = buildApp(database, {
  config: testConfig({
    PUBLIC_BASE_URL: 'https://time2live.xyz',
    X402_ENABLED: 'true',
    X402_PAY_TO: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
    X402_NETWORK: 'eip155:84532',
    KEEPER_FACTORY_ADDRESS: '0x3D7cE7C30b712bC070Ba1ea2918Bd2211AD4349A',
    KEEPER_CHAIN_ID: '84532',
  }),
});

const text = async (p: string, headers: Record<string, string> = {}) => {
  const r = await app.request(p, { headers });
  return { status: r.status, ct: r.headers.get('content-type'), body: await r.text() };
};

describe('discovery & trust surfaces', () => {
  it('serves GET /health as an alias of /healthz', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
    // deep variant works on the alias too
    const deep = await app.request('/health?deep=1');
    expect([200, 503]).toContain(deep.status);
  });

  it('serves robots.txt with a sitemap and disallows operator pages', async () => {
    const { status, ct, body } = await text('/robots.txt');
    expect(status).toBe(200);
    expect(ct).toMatch(/text\/plain/);
    expect(body).toContain('Sitemap: https://time2live.xyz/sitemap.xml');
    expect(body).toContain('Disallow: /dashboard');
  });

  it('serves a sitemap listing the public pages', async () => {
    const { status, ct, body } = await text('/sitemap.xml');
    expect(status).toBe(200);
    expect(ct).toMatch(/xml/);
    expect(body).toContain('<loc>https://time2live.xyz/terms</loc>');
  });

  it('serves security.txt with a future Expires', async () => {
    const { status, body } = await text('/.well-known/security.txt');
    expect(status).toBe(200);
    expect(body).toContain('Contact: mailto:security@time2live.xyz');
    const exp = body.match(/Expires: (.+)/)?.[1];
    expect(exp && new Date(exp).getTime() > Date.now()).toBe(true);
  });

  it('serves a machine-readable x402 descriptor', async () => {
    const res = await app.request('/.well-known/x402');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const b = (await res.json()) as {
      x402Version: number;
      enabled: boolean;
      pricing: { packs: string[] };
    };
    expect(b.x402Version).toBe(2);
    expect(b.enabled).toBe(true);
    expect(Array.isArray(b.pricing.packs)).toBe(true);
  });

  it('serves terms and privacy pages', async () => {
    const terms = await text('/terms');
    expect(terms.status).toBe(200);
    expect(terms.ct).toMatch(/text\/html/);
    expect(terms.body).toContain('Terms of Service');
    expect(terms.body).toContain('unaudited');
    const privacy = await text('/privacy');
    expect(privacy.status).toBe(200);
    expect(privacy.body).toContain('Privacy Policy');
  });

  it('serves a status page that checks healthz', async () => {
    const { status, body } = await text('/status');
    expect(status).toBe(200);
    expect(body).toContain('/healthz?deep=1');
  });

  it('landing page has favicon, OG tags and an unaudited label', async () => {
    const { body } = await text('/', { accept: 'text/html' });
    expect(body).toContain('rel="icon"');
    expect(body).toContain('property="og:title"');
    expect(body).toContain('Unaudited');
  });

  it('JSON summary exposes the new trust links', async () => {
    const res = await app.request('/', { headers: { accept: 'application/json' } });
    const b = (await res.json()) as { links: Record<string, string> };
    expect(b.links.terms).toBe('https://time2live.xyz/terms');
    expect(b.links.security).toBe('https://time2live.xyz/.well-known/security.txt');
    expect(b.links.x402).toBe('https://time2live.xyz/.well-known/x402');
  });
});
