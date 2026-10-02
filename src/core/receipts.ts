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
    mode: string;
    checkUrl: string | null;
    checkIntervalSeconds: number | null;
    lastProbeAt: Date | null;
    lastProbeOk: boolean | null;
    lastProbeDetail: string | null;
    checkExpectStatus: number | null;
    checkBodyContains: string | null;
  };
  lastEvent: { toStatus: string; reason: string; at: Date } | null;
  ownerAddress: string;
  network: string;
  service: string;
  /** Public base URL, used to build the receipt's self-describing replay URL. */
  base: string;
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

export interface AllowedAction {
  /** What may be done to the monitor from its current liveness. */
  action: 'heartbeat' | 'resume' | 'pause' | 'escalate';
  /**
   * Who is entitled to do it: `operator` (the account that owns it), `ping_holder` (anyone holding
   * the secret ping URL), or `automatic` (the service itself, no caller).
   */
  who: 'operator' | 'ping_holder' | 'automatic';
  /** The proof that entitles that actor — the custody rule, not just the fact of decay. */
  evidence: string;
}

/**
 * The custody half of the receipt: from the current liveness, who may act and what proof they need.
 * A receipt that only reports decay proves a monitor went quiet but not who is allowed to restart,
 * pause or escalate it. The distinctions are real, not cosmetic:
 *  - A `halted_by_operator` (paused) monitor can be restarted ONLY by the operator; a ping records
 *    the time but does not un-halt it (see recordPing). Possession of the ping URL is not enough.
 *  - A `missed_window` (dead) monitor re-arms on the next heartbeat — a ping to the secret URL, or,
 *    in active mode, a passing probe — no operator credential required.
 *  - Escalation is never a caller action: it fires automatically on a miss to the stopAction
 *    channels.
 */
function nextAllowedActionsOf(
  liveness: MonitorLiveness,
  mode: string,
  ownerAddress: string,
): AllowedAction[] {
  const operatorEvidence = `operator session token or API key bound to ${ownerAddress}`;
  // How the "I am alive" signal is produced, and who may produce it.
  const keepAlive: AllowedAction =
    mode === 'active'
      ? {
          action: 'heartbeat',
          who: 'automatic',
          evidence: 'the worker probes check.url each interval; no caller action and no credential',
        }
      : {
          action: 'heartbeat',
          who: 'ping_holder',
          evidence: 'possession of the secret ping URL (the monitor id); no API key',
        };

  switch (liveness) {
    case 'new':
      return [keepAlive, { action: 'pause', who: 'operator', evidence: operatorEvidence }];
    case 'alive':
      return [
        keepAlive,
        { action: 'pause', who: 'operator', evidence: operatorEvidence },
        {
          action: 'escalate',
          who: 'automatic',
          evidence: 'fires on a missed window to the stopAction.onMiss channels; no caller action',
        },
      ];
    case 'missed_window':
      return [
        // Re-arming after a miss uses the same alive signal — no operator credential needed.
        { ...keepAlive, action: 'resume' },
        {
          action: 'escalate',
          who: 'automatic',
          evidence: 'already fired on the missed window to the stopAction.onMiss channels',
        },
      ];
    case 'halted_by_operator':
      // The custody line: a paused monitor is restarted ONLY by the operator. A ping records the
      // time but does not reactivate it, so holding the ping URL is not enough to un-halt.
      return [{ action: 'resume', who: 'operator', evidence: operatorEvidence }];
  }
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
    // How liveness is observed. For 'active' the signal travels the real path: we probe the agent's
    // own URL from the outside, so a receipt cannot say alive while the front door is closed.
    mode: m.mode,
    check:
      m.mode === 'active' && m.checkUrl
        ? {
            url: m.checkUrl,
            intervalSeconds: m.checkIntervalSeconds,
            // The assertion that must pass for a probe to count — not just that the door opened.
            expect: {
              status: m.checkExpectStatus,
              bodyContains: m.checkBodyContains,
            },
            lastProbeAt: m.lastProbeAt ? m.lastProbeAt.toISOString() : null,
            lastProbeOk: m.lastProbeOk,
            lastProbeDetail: m.lastProbeDetail,
          }
        : null,
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
      // On-chain trigger() tx of the funded dead-man's switch, when this liveness is backed by one.
      // Heartbeat/active monitors stop via the off-chain alert channels above, so there is no tx.
      tx: null as string | null,
    },
    // A deliberate halt is an operator pause; a miss is not acknowledged. Lets an agent prove it
    // halted on purpose rather than having silently died, and names who acknowledged it.
    operatorAck: {
      acknowledged: liveness === 'halted_by_operator',
      by: liveness === 'halted_by_operator' ? input.ownerAddress : null,
      lastTransition: input.lastEvent
        ? {
            to: input.lastEvent.toStatus,
            reason: input.lastEvent.reason,
            at: input.lastEvent.at.toISOString(),
          }
        : null,
      deadSince: m.deadSince ? m.deadSince.toISOString() : null,
    },
    // Custody, not just decay: from this liveness, who may restart/pause/escalate and what proof they
    // need. Notably a halted (paused) monitor is the operator's to resume — a ping won't un-halt it.
    nextAllowedAction: nextAllowedActionsOf(liveness, m.mode, input.ownerAddress),
    // Self-describing: anyone can re-fetch a fresh receipt here and compare, so a stale "alive" can't
    // be passed off as current.
    replayUrl: `${input.base.replace(/\/$/, '')}/v1/monitors/${m.id}/receipt`,
  };
}
