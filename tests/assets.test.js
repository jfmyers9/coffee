import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.js';

test('home page declares and serves matching favicon assets', async t => {
  const server = createApp({ pool: {}, appOrigin: 'http://localhost' });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  assert.match(html, /<link rel="icon" href="\/favicon.ico"/);
  assert.match(html, /<link rel="icon" href="\/icon.svg"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(html, /<img src="\/icon.svg"/);

  for (const [file, type] of [
    ['icon.svg', 'image/svg+xml'],
    ['favicon.ico', 'image/vnd.microsoft.icon'],
    ['apple-touch-icon.png', 'image/png'],
  ]) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`../public/${file}`, import.meta.url)));
    const head = await fetch(`${base}/${file}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), type);
    assert.equal(await head.text(), '');
  }
});
