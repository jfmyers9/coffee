import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function createBag(request) {
  return (await request.post('/api/bags', { data: { roaster: 'Delete test', name: randomUUID(), weightGrams: 340 } })).json();
}
async function startBrew(page, request, bag) {
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(bag.id);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  return id;
}
const cardFor = (page, bag) => page.locator('.journal-card').filter({ hasText: bag.name });
async function remaining(request, bag) {
  return (await (await request.get(`/api/bags/${bag.id}`)).json()).remainingGrams;
}

test('discarded test brew can be deleted after confirmation and restores inventory', async ({ page, request }) => {
  const bag = await createBag(request);
  const id = await startBrew(page, request, bag);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('discarded');
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  const card = cardFor(page, bag);
  await expect(card).toContainText('discarded');
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('20 g dose will be returned');
    await dialog.dismiss();
  });
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(card).toBeVisible();
  expect(await remaining(request, bag)).toBe(320);
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('#journal-content')).toContainText('Brew deleted.');
  expect((await request.get(`/api/brews/${id}`)).status()).toBe(410);
  expect(await remaining(request, bag)).toBe(340);
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await expect(page.locator('.bean-card').filter({ hasText: bag.name })).toContainText('340 g');
  await page.reload();
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('deleting a completed brew clears its open editor, finished timer, and daily serving totals', async ({ page, request }) => {
  const bag = await createBag(request);
  const id = await startBrew(page, request, bag);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('completed');
  const person = randomUUID();
  await request.patch(`/api/brews/${id}`, { data: { servings: [{ person, volumeMl: 200, milk: 'none', caffeineMg: 70 }] } });
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await expect(page.locator('#daily-summary')).toContainText(person);
  const card = cardFor(page, bag);
  await card.getByRole('button', { name: 'Edit result' }).click();
  await expect(page.getByLabel('Brew notes')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel('Brew notes')).toHaveCount(0);
  await expect(page.locator('#daily-summary')).not.toContainText(person);
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rate this cup & log servings' })).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session)).toBeNull();
});

test('delete failures retain the record, and a lost success response can be retried safely', async ({ page, request }) => {
  const bag = await createBag(request);
  const input = { id: randomUUID(), bagId: bag.id, brewer: 'v60', dose: 20, temperatureF: 203, grindSetting: '15' };
  await request.post('/api/brews', { data: input });
  const path = `/api/brews/${input.id}`;
  await request.patch(path, { data: { status: 'discarded' } });
  await page.goto('/#journal');
  const card = cardFor(page, bag);
  await page.route(`**${path}`, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 503, json: { error: 'Try again later' } }) : route.continue());
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(page.locator('#journal-content')).toContainText('Try again later');
  await expect(card).toBeVisible();
  expect(await remaining(request, bag)).toBe(320);
  await page.unroute(`**${path}`);
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'DELETE') {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(card.getByRole('button', { name: 'Delete brew' })).toBeEnabled();
  expect((await request.get(path)).status()).toBe(410);
  await page.unroute(`**${path}`);
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(card).toHaveCount(0);
  expect(await remaining(request, bag)).toBe(340);
});

test('active timers cannot be deleted even if another device closes the server record', async ({ page, request }) => {
  const bag = await createBag(request);
  const id = await startBrew(page, request, bag);
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  const card = cardFor(page, bag);
  await expect(card).toContainText('brewing');
  await expect(card.getByRole('button', { name: 'Delete brew' })).toHaveCount(0);
  await request.patch(`/api/brews/${id}`, { data: { status: 'discarded' } });
  await page.reload();
  await card.getByRole('button', { name: 'Delete brew' }).click();
  await expect(page.locator('#journal-content')).toContainText('This timer is active on this device');
  expect((await request.get(`/api/brews/${id}`)).status()).toBe(200);
});

test('offline retries drop deleted brews without resurrecting them or losing other queued brews', async ({ page, request }) => {
  const bag = await createBag(request);
  let first = true;
  await page.route('**/api/brews**', async route => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      await route.fetch();
      await route.abort();
    } else if (['POST', 'PATCH'].includes(route.request().method())) await route.abort();
    else await route.continue();
  });
  const id = await startBrew(page, request, bag);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-outbox-v1')).length)).toBe(2);
  const otherId = randomUUID();
  await page.evaluate(async ({ id, bagId }) => {
    const { queueBrew } = await import('/sync.js');
    await queueBrew('/api/brews', 'POST', { id, bagId, brewer: 'v60', dose: 20, temperatureF: 203, grindSetting: '15' });
  }, { id: otherId, bagId: bag.id });
  await request.patch(`/api/brews/${id}`, { data: { status: 'discarded' } });
  expect((await request.delete(`/api/brews/${id}`, { data: {} })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry sync' })).toBeVisible();
  await page.unroute('**/api/brews**');
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-outbox-v1')).length)).toBe(0);
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeVisible();
  expect((await request.get(`/api/brews/${id}`)).status()).toBe(410);
  expect((await request.get(`/api/brews/${otherId}`)).status()).toBe(200);
  expect((await (await request.get(`/api/brews?bagId=${bag.id}`)).json()).total).toBe(1);
  expect(await remaining(request, bag)).toBe(320);
});
