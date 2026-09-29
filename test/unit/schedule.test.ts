import { describe, expect, it } from 'vitest';
import { ScheduleError, assertCron, assertTimezone, nextCronRun } from '../../src/core/schedule.js';

describe('assertCron', () => {
  it.each([
    '* * * * *',
    '*/15 * * * *',
    '0 9 * * 1-5',
    '30 2 1 * *',
    '@hourly',
    '@daily',
    '@WEEKLY',
  ])('accepts %s', (expr) => expect(() => assertCron(expr)).not.toThrow());

  it.each([
    ['*/5 * * * * *', /5 fields/], // seconds field => sub-minute schedules
    ['* * * *', /5 fields/],
    ['61 * * * *', /invalid cron/],
    ['hello world a b c', /invalid cron/],
    ['@reboot', /unsupported macro/],
    ['', /5 fields/],
  ])('rejects %s', (expr, msg) => {
    expect(() => assertCron(expr)).toThrow(msg);
  });

  it('validates the timezone', () => {
    expect(() => assertTimezone('Europe/Helsinki')).not.toThrow();
    expect(() => assertCron('* * * * *', 'Mars/Olympus')).toThrow(ScheduleError);
  });
});

describe('nextCronRun', () => {
  it('returns the first occurrence strictly after the given time', () => {
    const at = new Date('2026-01-01T00:05:00Z');
    expect(nextCronRun('*/5 * * * *', 'UTC', at).toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('honours the timezone, including DST changes', () => {
    // 09:00 Helsinki = 07:00Z in winter (UTC+2), 06:00Z in summer (UTC+3).
    expect(
      nextCronRun('0 9 * * *', 'Europe/Helsinki', new Date('2026-01-10T12:00:00Z')).toISOString(),
    ).toBe('2026-01-11T07:00:00.000Z');
    expect(
      nextCronRun('0 9 * * *', 'Europe/Helsinki', new Date('2026-07-10T12:00:00Z')).toISOString(),
    ).toBe('2026-07-11T06:00:00.000Z');
  });
});
