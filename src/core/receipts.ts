import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as edSign,
} from 'node:crypto';

/**
 * Signed liveness receipts: a portable, server-signed attestation of a monitor's state that a third
 * party can verify offline, without trusting time2live's UI. Signed with an Ed25519 key derived
 * deterministically from ENCRYPTION_KEY (so it is stable across restarts and needs no extra secret);
 * the public key is published at /.well-known/time2live-receipts.json.
 */

// PKCS#8 prefix for an Ed25519 private key; the 32-byte seed is appended to form the DER.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ReceiptSignature {
  alg: 'Ed25519';
  keyId: string;
  publicKey: string; // base64, raw 32-byte Ed25519 public key
  value: string; // base64 signature over canonicalize(payload)
}

export interface ReceiptSigner {
  keyId: string;
  publicKeyB64: string;
  sign(payload: unknown): ReceiptSignature;
}

/**
 * Deterministic JSON for signing/verification: object keys sorted recursively, no insignificant
 * whitespace. A verifier reproduces this exact string before checking the signature.
 */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function createReceiptSigner(encryptionKeyB64: string): ReceiptSigner {
  const ikm = Buffer.from(encryptionKeyB64, 'base64');
  const seed = Buffer.from(
    hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from('time2live.receipt.ed25519.v1'), 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKeyB64 = Buffer.from(jwk.x!, 'base64url').toString('base64');
  const keyId = createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);

  return {
    keyId,
    publicKeyB64,
    sign(payload) {
      const value = edSign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString(
        'base64',
      );
      return { alg: 'Ed25519', keyId, publicKey: publicKeyB64, value };
    },
  };
}

export type MonitorLiveness = 'new' | 'alive' | 'missed_window' | 'halted_by_operator';

export interface MonitorReceiptInput {
  monitor: {
    id: string;
    name: string;
    status: string;
    ttlSeconds: number;
    graceSeconds: number;
    lastPingAt: Date | null;
    expiresAt: Date | null;
    deadSince: Date | null;
    alertWebhookUrl: string | null;
    alertWebhookUrl2: string | null;
    alertTelegram: boolean;
    alertEmail: string | null;
  };
  lastEvent: { toStatus: string; reason: string; at: Date } | null;
  ownerAddress: string;
  network: string;
  service: string;
  now: Date;
}

/** Maps the stored status to the liveness the receipt attests, distinguishing a deliberate operator
 * halt (paused) from a silent miss (dead) — the whole point of the receipt. */
function livenessOf(status: string): MonitorLiveness {
  if (status === 'alive') return 'alive';
  if (status === 'paused') return 'halted_by_operator';
  if (status === 'dead') return 'missed_window';
  return 'new';
}

/** Builds the receipt body (the object that gets signed). */
export function buildMonitorReceipt(input: MonitorReceiptInput) {
  const m = input.monitor;
  const liveness = livenessOf(m.status);
  const lastPingAt = m.lastPingAt ? m.lastPingAt.toISOString() : null;
  const lastSuccessHash = lastPingAt
    ? `sha256:${createHash('sha256').update(`${m.id}.${lastPingAt}`).digest('hex')}`
    : null;
  const channels = [
    m.alertWebhookUrl ? 'webhook' : null,
    m.alertWebhookUrl2 ? 'webhook2' : null,
    m.alertTelegram ? 'telegram' : null,
    m.alertEmail ? 'email' : null,
  ].filter((x): x is string => x !== null);

  return {
    version: 1,
    type: 'monitor.liveness',
    service: input.service,
    network: input.network,
    issuedAt: input.now.toISOString(),
    scheduleId: m.id,
    name: m.name,
    operator: input.ownerAddress,
    liveness,
    heartbeat: {
      lastPingAt,
      lastSuccessHash,
      expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
    },
    missedWindow: {
      ttlSeconds: m.ttlSeconds,
      graceSeconds: m.graceSeconds,
      rule: `dead if no ping within ttlSeconds + graceSeconds (${m.ttlSeconds + m.graceSeconds}s)`,
    },
    target: {
      webhook: m.alertWebhookUrl,
      webhook2: m.alertWebhookUrl2,
      telegram: m.alertTelegram,
      email: m.alertEmail,
    },
    stopAction: {
      // Where a missed window fires; empty means the miss is recorded but no channel is configured.
      onMiss: channels,
      alerts: ['monitor.down', 'monitor.up'],
    },
    // A deliberate halt is an operator pause; a miss is not acknowledged. Lets an agent prove it
    // halted on purpose rather than having silently died.
    operatorAck: {
      acknowledged: liveness === 'halted_by_operator',
      lastTransition: input.lastEvent
        ? {
            to: input.lastEvent.toStatus,
            reason: input.lastEvent.reason,
            at: input.lastEvent.at.toISOString(),
          }
        : null,
      deadSince: m.deadSince ? m.deadSince.toISOString() : null,
    },
  };
}
