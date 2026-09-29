import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { migrationsFolder } from '../src/core/db/migrate.js';
import { TEST_DATABASE_URL } from './helpers/env.js';

/** Recreates the test database schema from migrations once per test run. */
export default async function setup() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
    await pool.query('CREATE SCHEMA public;');
    await migrate(drizzle(pool), { migrationsFolder });
  } catch (err) {
    throw new Error(
      `Test database setup failed (${TEST_DATABASE_URL}). Is Postgres running? ` +
        `Try: docker compose up -d postgres`,
      { cause: err },
    );
  } finally {
    await pool.end();
  }
}
