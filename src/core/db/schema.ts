import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Liveness beacon written by each worker process; read by GET /healthz?deep=1. */
export const workerTicks = pgTable('worker_ticks', {
  workerId: text('worker_id').primaryKey(),
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  version: text('version').notNull(),
});
