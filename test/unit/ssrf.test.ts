import { describe, expect, it } from 'vitest';
import {
  BlockedTargetError,
  STRICT_POLICY,
  assertResolvesToPublic,
  checkIp,
  validateTargetUrl,
  type TargetPolicy,
} from '../../src/core/ssrf.js';

const blocked = [
  '127.0.0.1',
  '127.1.2.3',
  '10.0.0.1',
  '172.16.5.4',
  '192.168.1.1',
  '169.254.169.254', // Hetzner / cloud metadata
  '100.64.0.1', // CGNAT
  '0.0.0.0',
  '0.1.2.3',
  '224.0.0.1',
  '255.255.255.255',
  '192.0.0.8',
  '198.18.0.1',
  '::1',
  '::',
  'fe80::1',
  'fc00::1',
  'fd00:ec2::254',
  '::ffff:127.0.0.1',
  '::ffff:169.254.169.254',
  '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
  '2002:a9fe:a9fe::1', // 6to4
  '2001::1', // Teredo
  'ff02::1',
];
const allowed = ['8.8.8.8', '1.1.1.1', '95.216.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];

describe('checkIp', () => {
  it.each(blocked)('blocks %s', (ip) => {
    expect(() => checkIp(ip, STRICT_POLICY)).toThrow(BlockedTargetError);
  });

  it.each(allowed)('allows %s', (ip) => {
    expect(() => checkIp(ip, STRICT_POLICY)).not.toThrow();
  });

  it("blocks the server's own public IP and extra CIDRs", () => {
    const policy: TargetPolicy = {
      ...STRICT_POLICY,
      blockedCidrs: ['95.216.1.1', '2a01:4f9::/32'],
    };
    expect(() => checkIp('95.216.1.1', policy)).toThrow(/blocked/);
    expect(() => checkIp('2a01:4f9:1::5', policy)).toThrow(/blocked/);
    expect(() => checkIp('95.216.1.2', policy)).not.toThrow();
  });

  it('dev policy allows private ranges but still honours blockedCidrs', () => {
    const dev: TargetPolicy = { ...STRICT_POLICY, allowPrivate: true, blockedCidrs: ['10.9.9.9'] };
    expect(() => checkIp('127.0.0.1', dev)).not.toThrow();
    expect(() => checkIp('10.9.9.9', dev)).toThrow();
  });
});

describe('validateTargetUrl', () => {
  const ok = (u: string) => validateTargetUrl(u, STRICT_POLICY).toString();
  const bad = (u: string) =>
    expect(() => validateTargetUrl(u, STRICT_POLICY)).toThrow(BlockedTargetError);

  it('accepts https on 443/8443 and strips fragments', () => {
    expect(ok('https://example.com/hook?a=1#frag')).toBe('https://example.com/hook?a=1');
    expect(ok('https://example.com:8443/x')).toBe('https://example.com:8443/x');
  });

  it('rejects http, other ports, credentials and junk', () => {
    bad('http://example.com/');
    bad('https://example.com:8080/');
    bad('https://example.com:22/');
    bad('https://user:pass@example.com/');
    bad('ftp://example.com/');
    bad('not a url');
    bad('file:///etc/passwd');
  });

  it('rejects local hostnames and literal private IPs in any notation', () => {
    bad('https://localhost/');
    bad('https://foo.localhost/');
    bad('https://metadata.internal/');
    bad('https://printer.local/');
    bad('https://postgres/'); // single-label (e.g. docker service names)
    bad('https://127.0.0.1/');
    bad('https://[::1]/');
    bad('https://[::ffff:7f00:1]/');
    bad('https://169.254.169.254/latest/meta-data');
    bad('https://2130706433/'); // decimal 127.0.0.1 (WHATWG URL normalises it)
    bad('https://0x7f.1/');
    bad('https://017700000001/');
  });

  it('dev policy allows http on any port to localhost', () => {
    const dev: TargetPolicy = {
      allowHttp: true,
      allowedPorts: null,
      allowPrivate: true,
      blockedCidrs: [],
    };
    expect(validateTargetUrl('http://localhost:3000/x', dev).port).toBe('3000');
  });
});

describe('assertResolvesToPublic (DNS)', () => {
  const fakeDns =
    (map: Record<string, string[]>) =>
    (
      host: string,
      _o: unknown,
      cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void,
    ) => {
      const addrs = map[host];
      if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      cb(
        null,
        addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    };

  it('rejects a public-looking name that resolves to a private address', async () => {
    const resolve = fakeDns({ 'rebind.example.com': ['169.254.169.254'] });
    await expect(
      assertResolvesToPublic('rebind.example.com', STRICT_POLICY, resolve),
    ).rejects.toThrow(BlockedTargetError);
  });

  it('rejects when ANY resolved address is private', async () => {
    const resolve = fakeDns({ 'mixed.example.com': ['8.8.8.8', '10.0.0.5'] });
    await expect(
      assertResolvesToPublic('mixed.example.com', STRICT_POLICY, resolve),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('accepts public addresses and surfaces resolution errors', async () => {
    const resolve = fakeDns({ 'ok.example.com': ['8.8.8.8', '2606:4700::1'] });
    await expect(
      assertResolvesToPublic('ok.example.com', STRICT_POLICY, resolve),
    ).resolves.toBeUndefined();
    await expect(assertResolvesToPublic('nx.example.com', STRICT_POLICY, resolve)).rejects.toThrow(
      /ENOTFOUND/,
    );
  });
});
