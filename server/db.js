import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';

export function createPool(connectionString, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000, ...options });
  // Idle connections can fail during a database restart. Requests report readiness/errors.
  pool.on('error', () => console.error('Database connection unavailable'));
  return pool;
}

export async function transaction(pool, operation) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) {
      // A client-side query timeout does not cancel PostgreSQL's active query.
      // Never return a connection with an unconfirmed rollback to the pool.
      releaseError = rollbackError;
    }
    throw error;
  } finally { client.release(releaseError); }
}

export async function migrate(pool) {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  await transaction(pool, async client => {
    // All instances serialize schema changes; transaction rollback leaves no partial version.
    await client.query('SELECT pg_advisory_xact_lock(1732050807)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
      if (existing.rowCount) continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
    }
  });
}
