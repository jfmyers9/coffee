import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function bag(request, weightGrams) {
  const response = await request.post('/api/bags', { data: { roaster: 'Notification test', name: randomUUID(), weightGrams } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function mockNotifications(page, { permission = 'default', unsupported = false } = {}) {
  await page.addInitScript(({ permission, unsupported }) => {
    window.notificationTest = { requested: 0, registered: 0, sent: [], failShow: false };
    const Notification = {
      permission: sessionStorage.getItem('test-notification-permission') || permission,
      async requestPermission() {
        window.notificationTest.requested++;
        this.permission = 'granted';
        sessionStorage.setItem('test-notification-permission', this.permission);
        return this.permission;
      },
    };
    const registration = { async showNotification(title, options) {
      if (window.notificationTest.failShow) throw new Error('Delivery unavailable');
      window.notificationTest.sent.push({ title, options });
    } };
    Object.defineProperty(window, 'Notification', { configurable: true, value: unsupported ? undefined : Notification });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      async register(path) {
        if (path !== '/notifications-worker.js') throw new Error('Unexpected worker');
        window.notificationTest.registered++;
        return registration;
      },
      ready: Promise.resolve(registration),
    } });
  }, { permission, unsupported });
}
const sentFor = (page, id) => page.evaluate(id => window.notificationTest.sent.filter(item => item.options.tag === `low-coffee-${id}`).length, id);
const toggle = page => page.locator('#stock-notifications');
const hint = page => page.locator('#stock-notification-hint');

test('restock notifications are opt-in, cover unselected bags, and deduplicate refreshes and reloads', async ({ page, request }) => {
  const low = await bag(request, 80), high = await bag(request, 100);
  await mockNotifications(page);
  await page.goto('/#beans');
  await expect(toggle(page)).toBeEnabled();
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  expect(await page.evaluate(() => window.notificationTest.registered)).toBe(0);
  await page.getByRole('button', { name: 'Enable low-coffee notifications', exact: true }).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => sentFor(page, low.id)).toBe(1);
  expect(await sentFor(page, high.id)).toBe(0);
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(1);
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect(hint(page)).toContainText('On for this device');
  expect(await sentFor(page, low.id)).toBe(1);
  await page.reload();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.bean-card').filter({ hasText: low.name })).toBeVisible();
  expect(await sentFor(page, low.id)).toBe(0);
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  await page.getByRole('button', { name: 'Disable low-coffee notifications', exact: true }).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  expect((await request.patch(`/api/bags/${high.id}`, { data: { weightGrams: 80 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect(page.locator('.bean-card').filter({ hasText: high.name })).toContainText('Running low');
  expect(await sentFor(page, high.id)).toBe(0);
  await page.reload();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('syncing a brew notifies at the threshold and stock recovery re-arms the bag', async ({ page, request }) => {
  const coffee = await bag(request, 100);
  await mockNotifications(page);
  await page.goto('/#beans');
  await page.getByRole('button', { name: 'Enable low-coffee notifications', exact: true }).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(page.getByLabel('On the counter')).toHaveValue(coffee.id);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect.poll(() => sentFor(page, coffee.id)).toBe(1);
  await expect(page.locator('#low-bag-warning')).toContainText('about 80 g left');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  const card = page.locator('.bean-card').filter({ hasText: coffee.name });
  expect((await request.patch(`/api/bags/${coffee.id}`, { data: { weightGrams: 200 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect(card).toContainText('180 g remaining');
  expect((await request.patch(`/api/bags/${coffee.id}`, { data: { weightGrams: 100 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect.poll(() => sentFor(page, coffee.id)).toBe(2);
  expect((await request.patch(`/api/bags/${coffee.id}`, { data: { weightGrams: 20 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect(card).toContainText('Bag empty:');
  expect(await sentFor(page, coffee.id)).toBe(2);
});

for (const unavailable of ['denied', 'unsupported']) {
  test(`${unavailable} notifications preserve the in-app warning and brewing`, async ({ page, request }) => {
    const coffee = await bag(request, 75);
    await mockNotifications(page, { permission: unavailable === 'denied' ? 'denied' : 'default', unsupported: unavailable === 'unsupported' });
    await page.goto('/#beans');
    await expect(toggle(page)).toBeDisabled();
    await expect(hint(page)).toContainText(unavailable === 'denied' ? 'Notifications are blocked' : 'Home Screen');
    await expect(page.locator('.bean-card').filter({ hasText: coffee.name })).toContainText('Running low');
    expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
    await page.getByRole('link', { name: 'Brew', exact: true }).click();
    await expect(page.locator('#low-bag-warning')).toContainText(coffee.name);
    await page.getByRole('button', { name: 'Start brewing' }).click();
    await expect(page.locator('#instruction-title')).toHaveText('Bloom');
  });
}

test('notification delivery failures can retry without blocking the app', async ({ page, request }) => {
  const coffee = await bag(request, 75);
  await mockNotifications(page);
  await page.goto('/#beans');
  await page.evaluate(() => { window.notificationTest.failShow = true; });
  await page.getByRole('button', { name: 'Enable low-coffee notifications', exact: true }).click();
  await expect(hint(page)).toContainText('could not be shown');
  await expect(toggle(page)).toBeEnabled();
  expect(await sentFor(page, coffee.id)).toBe(0);
  await page.evaluate(() => { window.notificationTest.failShow = false; });
  await page.getByRole('button', { name: 'Refresh bags', exact: true }).click();
  await expect.poll(() => sentFor(page, coffee.id)).toBe(1);
  await expect(hint(page)).toContainText('On for this device');
});

test('install manifest and native notification worker are served and activate', async ({ page, request }) => {
  await page.goto('/#beans');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/manifest+json');
  expect(await response.json()).toMatchObject({ display: 'standalone', start_url: '/#brew', scope: '/' });
  const worker = await request.get('/notifications-worker.js');
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain('notificationclick');
  const state = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/notifications-worker.js');
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, hasDelivery: typeof ready.showNotification === 'function' };
  });
  expect(state.scope).toBe('http://127.0.0.1:8087/');
  expect(state.hasDelivery).toBe(true);
});
