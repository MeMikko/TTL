/**
 * Freshness assertion for active-check monitors: a `bodyContains` match passes forever on a cached
 * response that still says the right thing. To catch a stale-but-correct 200, an active check can
 * name a timestamp field (a minimal dotted JSON path) and a max age; the probe reads that field and
 * fails when it is older than `maxAgeSeconds` relative to the probe time.
 */

/** Minimal dotted JSON path: `a.b[0].c`. No wildcards or filters. Returns undefined if absent. */
export function getJsonPath(value: unknown, path: string): unknown {
  const parts: (string | number)[] = [];
  for (const seg of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return undefined;
    if (m[1]) parts.push(m[1]);
    for (const idx of (m[2] ?? '').match(/\d+/g) ?? []) parts.push(Number(idx));
  }
  let cur: unknown = value;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof p === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[p];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

/**
 * Parses a timestamp into epoch milliseconds. Accepts an ISO-8601 string, or a number / numeric
 * string in unix seconds or milliseconds (values below 1e12 are read as seconds). Returns null when
 * the value is not a recognisable timestamp.
 */
export function parseTimestampMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? toMs(v) : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return toMs(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function toMs(n: number): number {
  return n < 1e12 ? n * 1000 : n;
}

export interface FreshnessResult {
  ok: boolean;
  detail: string;
}

/**
 * Checks that the timestamp at `jsonPath` in a JSON body is within `maxAgeSeconds` of `now`. A body
 * that is not valid JSON, a missing or non-timestamp field, or a value older than the cutoff all
 * fail. A timestamp in the future is accepted (clock skew is not staleness).
 */
export function checkFreshness(
  body: string,
  jsonPath: string,
  maxAgeSeconds: number,
  now: Date,
): FreshnessResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: 'freshness: response is not valid JSON' };
  }
  const raw = getJsonPath(parsed, jsonPath);
  if (raw === undefined) return { ok: false, detail: `freshness: ${jsonPath} not found` };
  const tsMs = parseTimestampMs(raw);
  if (tsMs === null) return { ok: false, detail: `freshness: ${jsonPath} is not a timestamp` };
  const ageSeconds = Math.round((now.getTime() - tsMs) / 1000);
  if (ageSeconds > maxAgeSeconds) {
    return { ok: false, detail: `stale: ${jsonPath} ${ageSeconds}s old, max ${maxAgeSeconds}` };
  }
  return { ok: true, detail: `fresh: ${jsonPath} ${ageSeconds}s old` };
}
