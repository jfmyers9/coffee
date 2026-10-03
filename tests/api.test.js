import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('Postgres API integration', { skip: !databaseUrl && 'Set TEST_DATABASE_URL to run database integration tests' }, async t => {
  const { createApp } = await import('../server.js');
  const { createPool, migrate, transaction } = await import('../server/db.js');
  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(databaseUrl);
  let pool;
  let server;
  let created = false;
  t.after(async () => {
    if (server?.listening) {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
    if (pool) await pool.end();
    try {
      // Never truncate shared tables or drop a schema not created by this test.
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  pool = createPool(databaseUrl, { options: `-c search_path=${schema}` });
  assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  await migrate(pool);
  await migrate(pool); // Migration must be safe on every server startup.
  server = createApp({ pool, appOrigin: 'https://coffee.example' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function ok(path, method = 'GET', body, status = 200) {
    const result = await request(path, { method, body });
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  }
  const bagInput = extra => ({ roaster: 'Test roaster', name: 'Test coffee', ...extra });
  const brewInput = extra => ({ id: randomUUID(), bagId: null, brewer: 'v60', dose: 20, temperatureF: 200, grindSetting: 'Encore · 15', ...extra });
  const createBag = extra => ok('/api/bags', 'POST', bagInput(extra), 201);
  const createBrew = extra => ok('/api/brews', 'POST', brewInput(extra), 201);

  await t.test('bags become default, preserve optional fields, and archive safely', async () => {
    const first = await createBag({ weightGrams: 250, price: 0, caffeineType: 'decaf', roastedOn: '2024-02-29', notes: 'Bag notes' });
    assert.equal(first.caffeineType, 'decaf');
    assert.equal(first.weightGrams, 250);
    assert.equal(first.remainingGrams, 250);
    assert.equal(first.roastedOn, '2024-02-29');
    assert.equal(first.hasPhoto, false);
    assert.equal((await ok('/api/bags')).defaultBagId, first.id);
    const second = await createBag();
    assert.equal(second.caffeineType, 'regular');
    assert.equal(second.archived, false);
    assert.equal((await ok('/api/bags')).defaultBagId, second.id);
    assert.equal((await ok(`/api/bags/${first.id}/default`, 'POST', {})).defaultBagId, first.id);
    assert.equal((await ok(`/api/bags/${first.id}`, 'PATCH', { archived: true })).archived, true);
    assert.equal((await ok('/api/bags')).defaultBagId, null);
    const archivedDefault = await request(`/api/bags/${first.id}/default`, { method: 'POST', body: {} });
    assert.ok([400, 409].includes(archivedDefault.status));
    await ok(`/api/bags/${first.id}`, 'PATCH', { archived: false, name: 'Renamed' });
    assert.equal((await ok(`/api/bags/${first.id}/default`, 'POST', {})).defaultBagId, first.id);
  });

  await t.test('brew creation is idempotent, snapshots are immutable, inventory counts discarded brews', async () => {
    const bag = await createBag({ weightGrams: 100, caffeineType: 'half-caf' });
    const input = brewInput({ bagId: bag.id });
    const brew = await ok('/api/brews', 'POST', input, 201);
    assert.equal(brew.status, 'brewing');
    assert.equal(brew.elapsedSeconds, 0);
    assert.equal(brew.water, 320);
    assert.equal(brew.rating, null);
    assert.deepEqual(brew.servings, []);
    assert.equal(brew.bagSnapshot.name, bag.name);
    assert.equal(brew.bagSnapshot.caffeineType, 'half-caf');
    assert.ok(brew.recipe);
    const repeated = await ok('/api/brews', 'POST', input);
    assert.equal(repeated.id, brew.id);
    assert.deepEqual(repeated.recipe, brew.recipe);
    const conflict = await request('/api/brews', { method: 'POST', body: { ...input, dose: 21 } });
    assert.equal(conflict.status, 409);
    await ok(`/api/bags/${bag.id}`, 'PATCH', { name: 'Different coffee', caffeineType: 'decaf' });
    const saved = await ok(`/api/brews/${brew.id}`);
    assert.deepEqual(saved.bagSnapshot, brew.bagSnapshot);
    assert.deepEqual(saved.recipe, brew.recipe);
    await ok(`/api/brews/${brew.id}`, 'PATCH', { status: 'discarded' });
    const bags = await ok('/api/bags');
    assert.equal(bags.bags.find(item => item.id === bag.id).remainingGrams, 80);
    const filtered = await ok(`/api/brews?bagId=${bag.id}&status=discarded&brewer=v60&limit=1&offset=0`);
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.brews.map(item => item.id), [brew.id]);
    const exported = await ok('/api/export');
    assert.ok(exported.bags.some(item => item.id === bag.id));
    assert.ok(exported.brews.some(item => item.id === brew.id));
    assert.equal(exported.defaultBagId, bag.id);
  });

  await t.test('concurrent duplicate brew requests consume inventory exactly once', async () => {
    const bag = await createBag({ weightGrams: 200 });
    const input = brewInput({ bagId: bag.id });
    const results = await Promise.all([request('/api/brews', { method: 'POST', body: input }), request('/api/brews', { method: 'POST', body: input })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
    assert.equal((await ok(`/api/brews?bagId=${bag.id}`)).total, 1);
    assert.equal((await ok('/api/bags')).bags.find(item => item.id === bag.id).remainingGrams, 180);
  });

  await t.test('terminal brews allow result edits but cannot restart or change start fields', async () => {
    const brew = await createBrew();
    for (const patch of [{ dose: 21 }, { brewer: 'chemex' }, { bagId: randomUUID() }, { temperatureF: 190 }, { grindSetting: 'Encore 20' }]) {
      assert.equal((await request(`/api/brews/${brew.id}`, { method: 'PATCH', body: patch })).status, 400);
    }
    const servings = [{ person: 'Alex', volumeMl: 150, milk: 'oat', caffeineMg: 80 }];
    const completed = await ok(`/api/brews/${brew.id}`, 'PATCH', { status: 'completed', elapsedSeconds: 180, rating: 5, taste: 'balanced', notes: 'Sweet', waterActual: 315, servings });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.rating, 5);
    assert.deepEqual(completed.servings, servings);
    for (const status of ['brewing', 'discarded']) {
      assert.equal((await request(`/api/brews/${brew.id}`, { method: 'PATCH', body: { status } })).status, 409);
    }
    const edited = await ok(`/api/brews/${brew.id}`, 'PATCH', { rating: null, taste: null, notes: 'Updated', servings: [] });
    assert.equal(edited.status, 'completed');
    assert.equal(edited.rating, null);
    assert.equal(edited.notes, 'Updated');
    assert.deepEqual(edited.servings, []);
  });

  await t.test('photo upload validates format and signatures, serves bytes, and deletes', async () => {
    const bag = await createBag();
    const path = `/api/bags/${bag.id}/photo`;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const uploaded = await ok(path, 'PUT', { dataUrl: `data:image/png;base64,${png}` });
    assert.equal(uploaded.hasPhoto, true);
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
    for (const dataUrl of ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,aGVsbG8=', `data:image/jpeg;base64,${png}`, 'https://example.com/photo.png', 'data:image/png;base64,%%%']) {
      assert.equal((await request(path, { method: 'PUT', body: { dataUrl } })).status, 400);
    }
    const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1);
    Buffer.from(png, 'base64').copy(tooLarge);
    const largeResult = await request(path, { method: 'PUT', body: { dataUrl: `data:image/png;base64,${tooLarge.toString('base64')}` } });
    assert.ok([400, 413].includes(largeResult.status));
    assert.equal((await ok(path, 'DELETE')).hasPhoto, false);
    assert.equal((await request(path)).status, 404);
  });

  await t.test('strict dates, numeric types, enums, and bounds reject invalid input', async () => {
    for (const fields of [{ roastedOn: '2025-02-29' }, { purchasedOn: '2026-04-31' }, { openedOn: '2026-01-01T00:00:00Z' }, { weightGrams: '250' }, { weightGrams: -1 }, { price: -1 }, { archived: 'false' }, { caffeineType: 'unknown' }, { roaster: '' }]) {
      assert.equal((await request('/api/bags', { method: 'POST', body: bagInput(fields) })).status, 400, JSON.stringify(fields));
    }
    for (const fields of [{ id: 'not-a-uuid' }, { dose: '20' }, { dose: 20.01 }, { dose: 31 }, { brewer: 'chemex', dose: 19 }, { temperatureF: 213 }, { grindSetting: -1 }, { startedAt: 'not-a-date' }, { brewer: 'espresso' }]) {
      assert.equal((await request('/api/brews', { method: 'POST', body: brewInput(fields) })).status, 400, JSON.stringify(fields));
    }
    const brew = await createBrew();
    for (const patch of [{ rating: 2.5 }, { rating: '5' }, { taste: 'excellent' }, { elapsedSeconds: -1 }, { waterActual: 2001 }, { servings: [{ person: 'Alex', volumeMl: 0, milk: 'none' }] }, { servings: [{ person: 'Alex', volumeMl: 100, milk: 'invalid' }] }, { servings: [{ person: '', volumeMl: 100, milk: 'none' }] }]) {
      assert.equal((await request(`/api/brews/${brew.id}`, { method: 'PATCH', body: patch })).status, 400, JSON.stringify(patch));
    }
    assert.equal((await request(`/api/brews/${randomUUID()}`)).status, 404);
  });

  await t.test('cross-site writes and non-JSON mutations are blocked without side effects', async () => {
    const before = (await ok('/api/bags')).bags.length;
    for (const headers of [
      { Origin: 'https://attacker.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      // A pinned APP_ORIGIN must override Host, even when Origin matches Host.
      { Origin: base },
      { Origin: 'https://attacker.example', Host: 'attacker.example' },
      { Origin: 'https://attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' },
      { Origin: 'https://coffee.example', 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      assert.equal((await request('/api/bags', { method: 'POST', body: bagInput(), headers })).status, 403);
    }
    assert.equal((await request('/api/bags', { method: 'POST', body: bagInput(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await ok('/api/bags')).bags.length, before);
    assert.equal((await request('/api/bags', { method: 'POST', body: bagInput(), headers: { Origin: 'https://coffee.example' } })).status, 201);
  });

  await t.test('daily summary includes all records beyond one page and keeps unknown caffeine separate', async () => {
    const from = '2025-06-01T07:00:00.000Z';
    const to = '2025-06-02T07:00:00.000Z';
    const path = `/api/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const person = 'Summary person';
    const unknownPerson = 'Unknown only';
    const bag = await createBag();
    for (let index = 0; index < 53; index++) {
      // Started outside the summary day: aggregation must use finishedAt instead.
      const brew = await createBrew({ bagId: bag.id, startedAt: '2025-05-31T23:00:00.000Z' });
      const servings = [{ person, volumeMl: 100, milk: 'none', caffeineMg: index === 50 ? null : 10 }];
      if (index === 50) servings.push({ person: unknownPerson, volumeMl: 50, milk: 'dairy', caffeineMg: null });
      await ok(`/api/brews/${brew.id}`, 'PATCH', { status: 'completed', servings });
      // Arrange historical completion timestamps without changing the server clock.
      const finishedAt = index === 51 ? to : index === 52 ? '2025-06-01T06:59:59.999Z' : from;
      await pool.query("UPDATE brews SET data=jsonb_set(data,'{finishedAt}',$2::jsonb) WHERE id=$1", [brew.id, JSON.stringify(finishedAt)]);
    }
    const discarded = await createBrew({ bagId: bag.id });
    await ok(`/api/brews/${discarded.id}`, 'PATCH', { status: 'discarded', servings: [{ person, volumeMl: 1000, milk: 'none', caffeineMg: 1000 }] });
    await pool.query("UPDATE brews SET data=jsonb_set(data,'{finishedAt}',$2::jsonb) WHERE id=$1", [discarded.id, JSON.stringify(from)]);
    const brewing = await createBrew({ bagId: bag.id });
    await ok(`/api/brews/${brewing.id}`, 'PATCH', { servings: [{ person, volumeMl: 1000, milk: 'none', caffeineMg: 1000 }] });
    assert.equal((await ok(`/api/brews?bagId=${bag.id}`)).brews.length, 50);
    const summary = await ok(path);
    assert.equal(summary.brewsCompleted, 51);
    assert.equal(summary.totalDose, 1020);
    assert.deepEqual(summary.servings, [
      { person, count: 51, volumeMl: 5100, knownCaffeineMg: 500, unknownCaffeineCount: 1 },
      { person: unknownPerson, count: 1, volumeMl: 50, knownCaffeineMg: 0, unknownCaffeineCount: 1 },
    ]);
    for (const query of ['', `?from=${from}&to=${from}`, `?from=${to}&to=${from}`, `?from=${from}&to=2025-06-04T07:00:00Z`, '?from=bad&to=bad']) {
      assert.equal((await request(`/api/summary${query}`)).status, 400);
    }
    assert.deepEqual(await ok('/api/summary?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z'), { brewsCompleted: 0, totalDose: 0, servings: [] });
  });

  await t.test('offline completion preserves the actual finish day and rejects invalid or changed timestamps', async () => {
    const startedAt = '2023-08-14T23:55:00.000Z';
    const finishedAt = '2023-08-15T00:02:00.000Z';
    const brew = await createBrew({ startedAt });
    const path = `/api/brews/${brew.id}`;
    assert.equal((await request(path, { method: 'PATCH', body: { finishedAt } })).status, 400);
    assert.equal((await request(path, { method: 'PATCH', body: { status: 'brewing', finishedAt } })).status, 400);
    for (const invalidFinish of ['2023-08-14T23:54:59.999Z', new Date(Date.now() + 60 * 60 * 1000).toISOString(), 'not-a-date', '2023-02-30T00:00:00Z']) {
      const response = await request(path, { method: 'PATCH', body: { status: 'completed', finishedAt: invalidFinish } });
      assert.equal(response.status, 400, invalidFinish);
      const unchanged = await ok(path);
      assert.equal(unchanged.status, 'brewing');
      assert.equal(unchanged.finishedAt, null);
    }
    const completion = { status: 'completed', finishedAt, elapsedSeconds: 420, servings: [{ person: 'Offline person', volumeMl: 200, milk: 'none', caffeineMg: null }] };
    const completed = await ok(path, 'PATCH', completion);
    assert.equal(completed.finishedAt, finishedAt);
    assert.equal(completed.startedAt, startedAt);
    assert.equal((await ok(path, 'PATCH', completion)).finishedAt, finishedAt);
    assert.equal((await ok(path, 'PATCH', { notes: 'Edited after synchronization' })).finishedAt, finishedAt);
    const changed = await request(path, { method: 'PATCH', body: { finishedAt: '2023-08-15T00:03:00.000Z' } });
    assert.equal(changed.status, 409);
    assert.equal((await ok(path)).finishedAt, finishedAt);
    const previousDay = await ok('/api/summary?from=2023-08-14T00:00:00Z&to=2023-08-15T00:00:00Z');
    assert.equal(previousDay.brewsCompleted, 0);
    const finishDay = await ok('/api/summary?from=2023-08-15T00:00:00Z&to=2023-08-16T00:00:00Z');
    assert.equal(finishDay.brewsCompleted, 1);
    assert.equal(finishDay.totalDose, 20);
    assert.deepEqual(finishDay.servings, [{ person: 'Offline person', count: 1, volumeMl: 200, knownCaffeineMg: 0, unknownCaffeineCount: 1 }]);
  });

  await t.test('data, photos, defaults, and idempotency survive a new server and pool plus migrations', async () => {
    const bag = await createBag({ weightGrams: 250 });
    const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    await ok(`/api/bags/${bag.id}/photo`, 'PUT', { dataUrl: `data:image/png;base64,${photo}` });
    const input = brewInput({ bagId: bag.id });
    const brew = await ok('/api/brews', 'POST', input, 201);
    await ok(`/api/brews/${brew.id}`, 'PATCH', { status: 'completed', rating: 4, notes: 'Keep through restart' });
    const before = await ok('/api/export');
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    await pool.end();
    pool = null;
    pool = createPool(databaseUrl, { options: `-c search_path=${schema}` });
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    await migrate(pool);
    server = createApp({ pool, appOrigin: 'https://coffee.example' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await ok('/api/export'), before);
    const response = await fetch(`${base}/api/bags/${bag.id}/photo`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(photo, 'base64'));
    const repeated = await ok('/api/brews', 'POST', input);
    assert.equal(repeated.status, 'completed');
    assert.equal(repeated.notes, 'Keep through restart');
    assert.equal((await ok('/api/bags')).bags.find(item => item.id === bag.id).remainingGrams, 230);
  });

  await t.test('failed rollback discards the connection and cannot leak writes into another transaction', async () => {
    await pool.query('CREATE TABLE rollback_probe (id integer PRIMARY KEY)');
    const shortPool = createPool(databaseUrl, { max: 1, query_timeout: 100, options: `-c search_path=${schema}` });
    const blocker = await admin.connect();
    const lockName = `${schema}:rollback-probe`;
    try {
      // Keep the server-side query blocked until explicitly unlocked: both the
      // active statement and queued ROLLBACK must hit their client-side timeout.
      await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
      const originalPid = (await shortPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await assert.rejects(transaction(shortPool, async client => {
        await client.query('INSERT INTO rollback_probe VALUES (1)');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockName]);
      }), /Query read timeout/);
      assert.equal(shortPool.totalCount, 0, 'an unconfirmed rollback must destroy its connection');
      await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      await transaction(shortPool, async client => {
        assert.notEqual((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, originalPid);
        await client.query('INSERT INTO rollback_probe VALUES (2)');
      });
      assert.deepEqual((await pool.query('SELECT id FROM rollback_probe ORDER BY id')).rows, [{ id: 2 }]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      blocker.release();
      await shortPool.end();
    }
  });

  await t.test('database failures return generic errors, not database details', async () => {
    const broken = createApp({ pool: {
      query: async () => { throw new Error('postgres://secret-password@private-host/private_table'); },
      connect: async () => { throw new Error('postgres://secret-password@private-host/private_table'); },
    } });
    broken.listen(0, '127.0.0.1');
    await once(broken, 'listening');
    try {
      for (const path of ['/health', '/api/bags', '/api/brews', '/api/export']) {
        const response = await fetch(`http://127.0.0.1:${broken.address().port}${path}`);
        assert.equal(response.status, 503);
        assert.doesNotMatch(await response.text(), /secret-password|private-host|private_table|stack|postgres:\/\//i);
      }
    } finally {
      const closed = new Promise(resolve => broken.close(resolve));
      broken.closeAllConnections();
      await closed;
    }
  });
});
