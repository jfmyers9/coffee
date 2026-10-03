import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const bagFields = () => ({ roaster: `Roaster ${randomUUID().slice(0, 8)}`, name: 'Morning blend', weightGrams: 340 });
async function waitForRecord(page, request) {
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  return id;
}
async function finishEarly(page) {
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
}

test('bean photo, automatic brew capture, shared cups, daily totals and repeat', async ({ page, request }) => {
  const bag = bagFields();
  await page.goto('/#beans');
  await page.getByRole('button', { name: 'Add coffee bag', exact: true }).click();
  await page.getByLabel('Roaster', { exact: true }).fill(bag.roaster);
  await page.getByLabel('Coffee name', { exact: true }).fill(bag.name);
  await page.getByLabel('Origin', { exact: true }).fill('Colombia');
  await page.getByLabel('Tasting notes', { exact: true }).fill('Cocoa, orange, a little caramel');
  await page.getByLabel('Original bag weight').fill('340');
  await page.getByLabel('Roasted on').fill('2026-09-20');
  await page.getByLabel('Bag photo').setInputFiles({ name: 'bag.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1EAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Save bag', exact: true }).click();
  const card = page.locator('.bean-card').filter({ hasText: bag.roaster });
  await expect(card).toContainText('Default');
  await expect(card.locator('img')).toBeVisible();
  await expect.poll(() => card.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const bags = await (await request.get('/api/bags')).json();
  const bagId = bags.bags.find(value => value.roaster === bag.roaster).id;
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(page.getByLabel('On the counter')).toHaveValue(bagId);
  await page.getByRole('button', { name: /Chemex/ }).click();
  await page.getByLabel('Water temperature').fill('202');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const brewId = await waitForRecord(page, request);
  const initial = await (await request.get(`/api/brews/${brewId}`)).json();
  expect(initial).toMatchObject({ bagId, brewer: 'chemex', dose: 30, temperatureF: 202, grindSetting: 'Encore · 20', status: 'brewing' });
  expect((await (await request.get(`/api/bags/${bagId}`)).json()).remainingGrams).toBe(310);
  await finishEarly(page);
  await page.getByRole('button', { name: 'Rate this cup & log servings' }).click();
  await page.getByLabel('Rating (optional)', { exact: true }).selectOption('5');
  await page.getByLabel('Taste (optional)', { exact: true }).selectOption('balanced');
  await page.getByLabel('Brew notes').fill('Sweet and rounded. Keep this grind.');
  await page.getByRole('button', { name: 'Add serving', exact: true }).click();
  await page.getByLabel('Cup volume (ml)', { exact: true }).fill('200');
  await page.getByLabel('Known caffeine').fill('90');
  await page.getByRole('button', { name: 'Add serving', exact: true }).click();
  await page.getByLabel('Person', { exact: true }).nth(1).fill('Partner');
  await page.getByLabel('Cup volume (ml)', { exact: true }).nth(1).fill('150');
  await page.getByLabel('Milk', { exact: true }).nth(1).selectOption('oat');
  await page.getByRole('button', { name: 'Save result', exact: true }).click();
  const resultCard = page.locator('.journal-card').filter({ hasText: bag.roaster });
  await expect(resultCard).toContainText('5/5');
  await expect(resultCard).toContainText('Partner: 150 ml · milk: oat · caffeine: unknown');
  await expect(page.locator('#daily-summary')).toContainText('unknown');
  const result = await (await request.get(`/api/brews/${brewId}`)).json();
  expect(result.servings[1].caffeineMg).toBeNull();
  expect(result.rating).toBe(5);
  await request.patch(`/api/bags/${bagId}`, { data: { name: 'A different label' } });
  await page.reload();
  await expect(page.locator('.journal-card').filter({ hasText: bag.roaster })).toContainText('Morning blend');
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await resultCard.getByRole('button', { name: 'Brew again' }).click();
  await expect(page.getByLabel('Coffee beans')).toHaveValue('30');
  await expect(page.getByLabel('Water temperature')).toHaveValue('202');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeVisible();
});

test('lost create response and offline finish survive reload without duplicate brews', async ({ page, request }) => {
  const bag = await (await request.post('/api/bags', { data: bagFields() })).json();
  let first = true;
  await page.route('**/api/brews**', async route => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      await route.fetch(); // Server committed, but the client never sees the response.
      await route.abort();
    } else if (['POST', 'PATCH'].includes(route.request().method())) await route.abort();
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(bag.id);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await waitForRecord(page, request);
  await expect(page.locator('#retry-sync')).toBeVisible();
  await finishEarly(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-outbox-v1')).length)).toBe(2);
  await page.reload();
  await expect(page.locator('#instruction-title')).toHaveText('Enjoy your coffee.');
  await page.unroute('**/api/brews**');
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('completed');
  await expect(page.locator('#retry-sync')).toBeHidden();
  const entries = await (await request.get(`/api/brews?bagId=${bag.id}`)).json();
  expect(entries.total).toBe(1);
  expect((await (await request.get(`/api/bags/${bag.id}`)).json()).remainingGrams).toBe(320);
});

test('active brew cannot be closed from journal; remote conflict is recoverable', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await waitForRecord(page, request);
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await page.locator('.journal-card').first().getByRole('button', { name: 'Close unfinished brew' }).click();
  await expect(page.locator('#journal-content')).toContainText('This timer is active on this device');
  await request.patch(`/api/brews/${id}`, { data: { status: 'discarded' } });
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await finishEarly(page);
  await expect(page.getByRole('button', { name: 'Use saved journal version' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Use saved journal version' }).click();
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeVisible();
  await expect(page.locator('#retry-sync')).toBeHidden();
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const nextId = await waitForRecord(page, request);
  expect(nextId).not.toBe(id);
});

test('archived bags leave the default picker and mobile service pages fit', async ({ page, request }) => {
  const bag = await (await request.post('/api/bags', { data: bagFields() })).json();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/#beans');
  const card = page.locator('.bean-card').filter({ hasText: bag.roaster });
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(page.getByLabel('On the counter')).toHaveValue('');
  for (const name of ['Bean shelf', 'Journal']) {
    await page.getByRole('link', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Add coffee bag', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a conflicting old brew cannot block a new brew from being recorded', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const firstId = await waitForRecord(page, request);
  await request.patch(`/api/brews/${firstId}`, { data: { status: 'discarded' } });
  await finishEarly(page);
  await expect(page.getByRole('button', { name: 'Use saved journal version' })).toBeVisible();
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const secondId = await waitForRecord(page, request);
  expect(secondId).not.toBe(firstId);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Use saved journal version' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Bloom');
});

test('concurrent tabs preserve distinct queued records and retry them once', async ({ page, context, request }) => {
  const bag = await (await request.post('/api/bags', { data: bagFields() })).json();
  await context.route('**/api/brews', route => route.request().method() === 'POST' ? route.abort() : route.continue());
  const second = await context.newPage();
  await Promise.all([page.goto('/'), second.goto('/')]);
  const ids = [randomUUID(), randomUUID()];
  await Promise.all([page, second].map((tab, index) => tab.evaluate(async ({ id, bagId }) => {
    const { queueBrew } = await import('/sync.js');
    await queueBrew('/api/brews', 'POST', { id, bagId, brewer: 'v60', dose: 20, temperatureF: 203, grindSetting: 'Encore · 15', startedAt: new Date().toISOString() });
  }, { id: ids[index], bagId: bag.id })));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-outbox-v1')).length)).toBe(2);
  await context.unroute('**/api/brews');
  await Promise.all([page, second].map(tab => tab.evaluate(async () => (await import('/sync.js')).flushBrews())));
  const entries = await (await request.get(`/api/brews?bagId=${bag.id}`)).json();
  expect(entries.total).toBe(2);
  expect((await (await request.get(`/api/bags/${bag.id}`)).json()).remainingGrams).toBe(300);
  await second.close();
});
