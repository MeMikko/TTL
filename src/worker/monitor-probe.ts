import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import { checkFreshness } from '../core/freshness.js';
import { recordPing } from '../core/monitors.js';
import type { HttpClient } from './http-client.js';

/** How long we wait for an active-check probe before counting it a failure. */
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeResult {
  probed: number;
  up: number;
  down: number;
}

/**
 * Active-check monitors: probe the agent's own URL from the outside. A 2xx response counts as a
 * ping (→ alive, via the same `recordPing` path a pushed heartbeat uses), so the check travels the
 * same route a real request does — it cannot report healthy from inside while the front door is
 * closed. A failure (non-2xx, timeout, blocked, unreachable) simply does not ping, so the monitor's
 * expiry lapses and the normal `sweepExpiredMonitors` pass marks it dead and alerts.
 */
export async function probeActiveMonitors(
  db: Db,
  client: HttpClient,
  now: Date,
  batchSize = 50,
): Promise<ProbeResult> {
  const t = schema.monitors;
  const due = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.mode, 'active'),
        ne(t.status, 'paused'),
        or(
          isNull(t.lastProbeAt),
          sql`${t.lastProbeAt} + (${t.checkIntervalSeconds} * interval '1 second') <= ${now}`,
        ),
      ),
    )
    .orderBy(sql`${t.lastProbeAt} asc nulls first`)
    .limit(batchSize);

  let probed = 0;
  let up = 0;
  let down = 0;
  for (const m of due) {
    if (!m.checkUrl) continue;
    const res = await client.send({
      url: m.checkUrl,
      method: 'GET',
      userHeaders: {},
      systemHeaders: {},
      body: null,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const statusOk =
      !res.failure &&
      typeof res.status === 'number' &&
      (m.checkExpectStatus != null
        ? res.status === m.checkExpectStatus
        : res.status >= 200 && res.status < 300);
    // Body assertion defeats a hollow 2xx from a front door that routes but does no real work.
    const bodyOk =
      !m.checkBodyContains || (res.responseSnippet ?? '').includes(m.checkBodyContains);
    // Freshness assertion defeats a stale-but-correct 200 (e.g. a cached response): the timestamp at
    // checkJsonPath must be within checkMaxAgeSeconds of the probe.
    const fresh =
      m.checkJsonPath && m.checkMaxAgeSeconds != null
        ? checkFreshness(res.responseSnippet ?? '', m.checkJsonPath, m.checkMaxAgeSeconds, now)
        : null;
    const freshOk = !fresh || fresh.ok;
    const ok = statusOk && bodyOk && freshOk;
    const detail = res.failure
      ? `${res.failure.kind}`
      : !statusOk
        ? `HTTP ${res.status}`
        : !bodyOk
          ? `HTTP ${res.status} but body assertion failed`
          : !freshOk
            ? `HTTP ${res.status} but ${fresh!.detail}`
            : `HTTP ${res.status}`;
    // A successful probe is the ping; a failure is left to expire via the normal sweep.
    if (ok) up++;
    else down++;
    if (ok) await recordPing(db, m.id, now);
    await db
      .update(t)
      .set({ lastProbeAt: now, lastProbeOk: ok, lastProbeDetail: detail, updatedAt: now })
      .where(eq(t.id, m.id));
    probed++;
  }
  return { probed, up, down };
}
