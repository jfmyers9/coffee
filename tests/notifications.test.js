import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createBagNotifications, NOTIFICATIONS_KEY } from '../public/notifications.js';

const bag = (id = 'low', remainingGrams = 75, extra = {}) => ({ id, roaster: 'Roaster', name: id, remainingGrams, archived: false, ...extra });
function fixture() {
  const stored = new Map(), sent = [];
  const calls = { permission: 0, register: 0, locks: 0 };
  let lock = Promise.resolve();
  const worker = { async showNotification(title, options) {
    if (calls.failShow) throw new Error('OS rejected notification');
    sent.push({ title, ...options });
  } };
  const platform = {
    isSecureContext: true,
    Notification: { permission: 'default', async requestPermission() {
      calls.permission++;
      this.permission = calls.result ?? 'granted';
      return this.permission;
    } },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    navigator: {
      serviceWorker: { async register(path) {
        calls.register++;
        assert.equal(path, '/notifications-worker.js');
        if (calls.failRegister) throw new Error('Worker failed');
        return worker;
      }, ready: Promise.resolve(worker) },
      locks: { request(_name, run) { calls.locks++; const result = lock.then(run); lock = result.catch(() => {}); return result; } },
    },
  };
  return { platform, stored, sent, calls, create: () => createBagNotifications({ platform }) };
}

test('notifications require explicit opt-in and only notify known, active low bags', async () => {
  const f = fixture(), notifications = f.create();
  await notifications.update([bag(), bag('empty', 0), bag('high', 80.1), bag('unknown', null), bag('old', 70, { archived: true })]);
  assert.equal(f.calls.permission, 0);
  assert.equal(f.calls.register, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(await notifications.enable(), true);
  assert.equal(f.calls.permission, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].tag, 'low-coffee-low');
  assert.match(f.sent[0].body, /75 g.*Roaster · low/);
  assert.equal(f.sent[1].title, 'Coffee bag empty');
  assert.equal(JSON.parse(f.stored.get(NOTIFICATIONS_KEY)).enabled, true);
  notifications.disable();
  await notifications.update([bag('other')]);
  assert.equal(f.sent.length, 2);
});

test('refreshes, reloads, and concurrent tabs suppress duplicates; stock recovery re-arms alerts', async () => {
  const f = fixture(), first = f.create();
  await first.update([bag()]);
  await first.enable();
  await Promise.all([first.update([bag()]), first.update([bag()])]);
  const second = f.create();
  await second.update(); // No catalog yet: do not clear persisted delivery history.
  await second.update([bag()]);
  assert.equal(f.sent.length, 1);
  await Promise.all([first.update([bag(), bag('new')]), second.update([bag(), bag('new')])]);
  assert.equal(f.sent.length, 2);
  await first.update([bag('low', 81)]);
  await second.update([bag('low', 80)]);
  assert.equal(f.sent.length, 3);
  await first.update([bag('low', 0)]);
  assert.equal(f.sent.length, 3); // Empty is the same low-stock episode.
  for (const extra of [{ archived: true }, { remainingGrams: null }]) {
    await first.update([bag('low', 75, extra)]);
    await first.update([bag()]);
  }
  assert.equal(f.sent.length, 5);
});

test('denied, dismissed, unsupported, and insecure notifications never interrupt inventory updates', async () => {
  for (const result of ['denied', 'default']) {
    const f = fixture(), notifications = f.create();
    f.calls.result = result;
    await notifications.update([bag()]);
    assert.equal(await notifications.enable(), false);
    await notifications.update([bag()]);
    assert.equal(f.sent.length, 0);
    assert.equal(f.calls.register, 0);
    assert.equal(notifications.enabled, false);
  }
  for (const override of [{ isSecureContext: false }, { Notification: undefined }, { navigator: {} }]) {
    const f = fixture();
    const notifications = createBagNotifications({ platform: { ...f.platform, ...override } });
    assert.equal(notifications.supported, false);
    assert.equal(await notifications.enable(), false);
    await notifications.update([bag()]);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture(), notifications = f.create();
  await notifications.enable();
  f.platform.Notification.permission = 'denied';
  await notifications.update([bag()]);
  assert.equal(f.sent.length, 0);
});

test('worker and delivery failures can retry without marking an unsent alert as delivered', async () => {
  const f = fixture(), notifications = f.create();
  f.calls.failRegister = true;
  assert.equal(await notifications.enable(), false);
  assert.match(notifications.error, /Could not enable/);
  f.calls.failRegister = false;
  await notifications.enable();
  f.calls.failShow = true;
  await notifications.update([bag()]);
  assert.match(notifications.error, /could not be shown/);
  assert.deepEqual(JSON.parse(f.stored.get(NOTIFICATIONS_KEY)).notified, []);
  f.calls.failShow = false;
  await notifications.update([bag()]);
  assert.equal(f.sent.length, 1);
  assert.equal(notifications.error, '');
});

test('blocked storage still deduplicates within the session and malformed history is safe', async () => {
  const f = fixture();
  f.stored.set(NOTIFICATIONS_KEY, '{"enabled":true,"notified":[null,7]}');
  const notifications = f.create();
  f.platform.Notification.permission = 'granted';
  await notifications.update([bag()]);
  assert.equal(f.sent.length, 1);
  f.platform.localStorage = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } };
  await notifications.update([bag()]);
  assert.equal(f.sent.length, 1);
});

test('stale stock is not sent when inventory or opt-in changes during worker activation', async () => {
  const f = fixture();
  let ready;
  f.platform.navigator.serviceWorker.ready = new Promise(resolve => { ready = resolve; });
  f.stored.set(NOTIFICATIONS_KEY, JSON.stringify({ enabled: true, notified: [] }));
  f.platform.Notification.permission = 'granted';
  const notifications = f.create();
  const first = notifications.update([bag()]);
  await new Promise(resolve => setImmediate(resolve));
  const second = notifications.update([bag('low', 100)]);
  ready({ async showNotification() { assert.fail('Stale warning'); } });
  await Promise.all([first, second]);
  assert.equal(f.sent.length, 0);
});

test('notification clicks focus an existing app window or open the bean shelf', async () => {
  const source = await readFile(new URL('../public/notifications-worker.js', import.meta.url), 'utf8');
  for (const existing of [true, false]) {
    let handler, pending, closed = false, destination, focused = false;
    const client = { url: 'https://coffee.test/#brew', async navigate(url) { destination = url; }, async focus() { focused = true; } };
    const self = { location: { origin: 'https://coffee.test' },
      addEventListener(type, listener) { assert.equal(type, 'notificationclick'); handler = listener; },
      clients: { async matchAll() { return existing ? [client] : []; }, async openWindow(url) { destination = url; } },
    };
    runInNewContext(source, { self, URL });
    handler({ notification: { close() { closed = true; } }, waitUntil(promise) { pending = promise; } });
    await pending;
    assert.equal(closed, true);
    assert.equal(destination, 'https://coffee.test/#beans');
    assert.equal(focused, existing);
  }
});
