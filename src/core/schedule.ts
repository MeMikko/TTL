import { CronExpressionParser } from 'cron-parser';

const MACROS = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly']);

export class ScheduleError extends Error {
  override name = 'ScheduleError';
}

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ScheduleError(`unknown timezone: ${tz}`);
  }
}

/** Trims whitespace and lower-cases macros (the parser only accepts lower-case "@daily"). */
export function normalizeCron(expr: string): string {
  const trimmed = expr.trim().replace(/\s+/g, ' ');
  return trimmed.startsWith('@') ? trimmed.toLowerCase() : trimmed;
}

/**
 * Accepts standard 5-field cron (minute resolution, i.e. at most once per minute) or one of the
 * @yearly/@monthly/@weekly/@daily/@hourly macros. Seconds fields are rejected.
 */
export function assertCron(expr: string, tz = 'UTC'): void {
  const trimmed = normalizeCron(expr);
  if (trimmed.startsWith('@')) {
    if (!MACROS.has(trimmed)) throw new ScheduleError(`unsupported macro: ${trimmed}`);
  } else if (trimmed.split(' ').length !== 5) {
    throw new ScheduleError(
      'cron expression must have exactly 5 fields (minute hour day month weekday)',
    );
  }
  assertTimezone(tz);
  try {
    CronExpressionParser.parse(trimmed, { tz, strict: false });
  } catch (err) {
    throw new ScheduleError(`invalid cron expression: ${(err as Error).message}`);
  }
}

/** First occurrence strictly after `after`. */
export function nextCronRun(expr: string, tz: string, after: Date): Date {
  return CronExpressionParser.parse(normalizeCron(expr), { currentDate: after, tz })
    .next()
    .toDate();
}
