import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Outbound target policy. Production is strict: https only, ports 443/8443, public unicast
 * addresses only. The relaxed flags exist for local development (WEBHOOK_DEV_ALLOW_LOCAL) and
 * are refused in production by config validation.
 */
export interface TargetPolicy {
  allowHttp: boolean;
  /** null = any port. */
  allowedPorts: number[] | null;
  /** Allow loopback/private/link-local etc. Development only. */
  allowPrivate: boolean;
  /** Additional blocked addresses or CIDRs, e.g. the server's own public IPs. */
  blockedCidrs: string[];
  /** Test seam: exact IPs exempt from the range check. Not configurable via env. */
  testAllowIps?: string[];
}

export const STRICT_POLICY: TargetPolicy = {
  allowHttp: false,
  allowedPorts: [443, 8443],
  allowPrivate: false,
  blockedCidrs: [],
};

export class BlockedTargetError extends Error {
  override name = 'BlockedTargetError';
  readonly code = 'blocked_target';
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|local|internal|home\.arpa|localdomain)$/i;

function parseCidrOrIp(value: string): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  if (value.includes('/')) return ipaddr.parseCIDR(value);
  const addr = ipaddr.parse(value);
  return [addr, addr.kind() === 'ipv4' ? 32 : 128];
}

/** Throws BlockedTargetError unless `ip` is a public unicast address permitted by the policy. */
export function checkIp(ip: string, policy: TargetPolicy): void {
  if (!ipaddr.isValid(ip)) throw new BlockedTargetError(`not an IP address: ${ip}`);
  let addr = ipaddr.parse(ip);
  // ::ffff:a.b.c.d must be judged as the IPv4 address it maps to.
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  const normalized = addr.toString();
  if (policy.testAllowIps?.includes(normalized)) return;

  for (const entry of policy.blockedCidrs) {
    const [range, bits] = parseCidrOrIp(entry);
    if (range.kind() === addr.kind() && addr.match(range, bits)) {
      throw new BlockedTargetError(`address ${normalized} is blocked`);
    }
  }
  if (policy.allowPrivate) return;
  // Everything that is not plain global unicast is refused: private, loopback, link-local
  // (incl. 169.254.169.254 metadata), CGNAT, multicast, reserved, ULA, NAT64, 6to4, Teredo, …
  const range = addr.range();
  if (range !== 'unicast') {
    throw new BlockedTargetError(`address ${normalized} is not public (${range})`);
  }
}

/**
 * Static validation of a webhook URL (at creation time and before every request/redirect hop).
 * DNS-based checks happen at connect time, see createGuardedLookup.
 */
export function validateTargetUrl(raw: string | URL, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError('invalid URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new BlockedTargetError(policy.allowHttp ? 'URL must be http(s)' : 'URL must use https');
  }
  if (url.username || url.password) {
    throw new BlockedTargetError('URL must not contain credentials; use headers instead');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (policy.allowedPorts && !policy.allowedPorts.includes(port)) {
    throw new BlockedTargetError(
      `port ${port} is not allowed (allowed: ${policy.allowedPorts.join(', ')})`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    checkIp(host, policy);
  } else {
    if (!policy.allowPrivate && (BLOCKED_HOSTNAMES.test(host) || !host.includes('.'))) {
      throw new BlockedTargetError(`host ${host} is not allowed`);
    }
  }
  url.hash = '';
  return url;
}

type LookupAddress = { address: string; family: number };
type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for net/tls/undici that resolves the hostname and validates EVERY resolved address
 * before a socket is opened. Checking at connect time (not only at creation time) defeats DNS
 * rebinding: the IP we validate is the IP we connect to.
 */
export function createGuardedLookup(
  policy: TargetPolicy,
  resolve: LookupAll = dns.lookup,
): net.LookupFunction {
  return function guardedLookup(hostname, options, callback) {
    const cb = callback as (...args: unknown[]) => void;
    const opts: dns.LookupOptions = typeof options === 'object' && options ? options : {};
    resolve(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      try {
        if (addresses.length === 0) throw new BlockedTargetError(`${hostname} did not resolve`);
        for (const a of addresses) checkIp(a.address, policy);
      } catch (e) {
        return cb(e);
      }
      if (opts.all) return cb(null, addresses);
      const first = addresses[0]!;
      cb(null, first.address, first.family);
    });
  };
}

/** Resolves and validates a hostname up front (used for early feedback when a job is created). */
export async function assertResolvesToPublic(
  hostname: string,
  policy: TargetPolicy,
  resolve: LookupAll = dns.lookup,
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return checkIp(host, policy);
  const lookup = createGuardedLookup(policy, resolve);
  await new Promise<void>((ok, fail) =>
    lookup(host, { all: true }, (err) => (err ? fail(err) : ok())),
  );
}
