import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createPool, migrate } from '../server/db.js';

// Browser tests get their own schema, never reset or mutate a shared app schema.
const url = process.env.BROWSER_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set BROWSER_DATABASE_URL or TEST_DATABASE_URL to a disposable test database.');
const schema = `browser_test_${randomUUID().replaceAll('-', '')}`;
const admin = createPool(url);
let pool;
let server;
let created = false;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (server?.listening) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (pool) await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  pool = createPool(url, { options: `-c search_path=${schema}` });
  await migrate(pool);
  server = createApp({ pool, appOrigin: '' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.PORT || 8087), '127.0.0.1', resolve);
  });
  console.log('Isolated browser test server ready');
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch (error) {
  await stop();
  throw error;
}
