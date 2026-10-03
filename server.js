import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPool, migrate } from './server/db.js';
import { api } from './server/api.js';
import { HttpError } from './server/validation.js';

// Explicit assets prevent accidental exposure of source, environment, or database files.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app', 'recipe', 'timer', 'storage', 'service', 'api', 'sync'].map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
function checkWrite(req, appOrigin) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site writes are not allowed');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let valid = false;
    try {
      const parsed = new URL(origin);
      valid = ['http:', 'https:'].includes(parsed.protocol) && origin === parsed.origin && (appOrigin ? parsed.origin === appOrigin : parsed.host === req.headers.host);
    } catch { /* Invalid Origin is rejected, never trusted through forwarded headers. */ }
    if (!valid) throw new HttpError(403, 'Origin is not allowed');
  }
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
}
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
function json(res, status, data, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : JSON.stringify(data));
}
export function createApp({ pool, appOrigin = process.env.APP_ORIGIN } = {}) {
  if (!pool) throw new Error('A database pool is required');
  if (appOrigin) {
    const parsed = new URL(appOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== appOrigin) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a trailing slash');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { throw new HttpError(400, 'Bad request'); }
      const read = ['GET', 'HEAD'].includes(req.method);
      if (url.pathname === '/health' && read) {
        await pool.query('SELECT 1');
        return json(res, 200, { status: 'ok' }, req.method === 'HEAD');
      }
      if (url.pathname.startsWith('/api/')) {
        let body;
        if (!read) {
          checkWrite(req, appOrigin);
          body = await readBody(req, /^\/api\/bags\/[^/]+\/photo$/.test(url.pathname) ? 3 * 1024 * 1024 : 64 * 1024);
        }
        const result = await api({ pool, method: req.method === 'HEAD' ? 'GET' : req.method, url, body });
        if (result.download) res.setHeader('Content-Disposition', 'attachment; filename="coffee-export.json"');
        if (result.bytes) {
          res.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'no-store' });
          return res.end(req.method === 'HEAD' ? undefined : result.bytes);
        }
        return json(res, result.status || 200, result.data, req.method === 'HEAD');
      }
      if (!read) { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'Method not allowed'); }
      const asset = assets.get(url.pathname);
      if (!asset) throw new HttpError(404, 'Not found');
      let bytes;
      try { bytes = await readFile(new URL(`./public/${asset[0]}`, import.meta.url)); }
      catch { throw new HttpError(404, 'Asset not found'); }
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : 'Database temporarily unavailable' }, req.method === 'HEAD');
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

export async function start() {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    const server = createApp({ pool });
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 8080);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    console.log(`Coffee is ready at http://${host}:${port}`);
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const deadline = setTimeout(() => process.exit(1), 15000);
      deadline.unref();
      server.close(async () => { await pool.end(); clearTimeout(deadline); });
      server.closeIdleConnections();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return { server, pool };
  } catch (error) { await pool.end(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { console.error('Unable to start Coffee. Check DATABASE_URL, APP_ORIGIN, and database availability.'); process.exitCode = 1; });
}
