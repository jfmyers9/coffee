import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function createBag(request, weightGrams) {
  const response = await request.post('/api/bags', { data: { roaster: 'Stock warning', name: randomUUID(), weightGrams } });
  expect(response.status()).toBe(201);
  return response.json();
}
const cardFor = (page, bag) => page.locator('.bean-card').filter({ hasText: bag.name });
const warning = page => page.locator('#low-bag-warning');

test('80 g warns on the Brew page and shelf; above-threshold, unknown, unselected and archived bags do not', async ({ page, request }) => {
  const low = await createBag(request, 80);
  const above = await createBag(request, 80.1);
  const unknown = await createBag(request, null);
  const archived = await createBag(request, 70);
  expect((await request.patch(`/api/bags/${archived.id}`, { data: { archived: true } })).status()).toBe(200);
  await page.goto('/');
  await page.getByLabel('On the counter').selectOption(low.id);
  await expect(warning(page)).toContainText('Running low: about 80 g left');
  await expect(warning(page)).toContainText(low.name);
  await expect(warning(page)).toHaveAttribute('role', 'status');
  await page.reload();
  await page.getByLabel('On the counter').selectOption(low.id);
  await expect(warning(page)).toBeVisible();
  for (const id of [above.id, unknown.id, '']) {
    await page.getByLabel('On the counter').selectOption(id);
    await expect(warning(page)).toBeHidden();
  }
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await expect(cardFor(page, low).locator('.low-bag-warning')).toContainText('get a new bag');
  await expect(cardFor(page, above).locator('.low-bag-warning')).toHaveCount(0);
  await expect(cardFor(page, unknown)).toContainText('Remaining weight unknown');
  await expect(cardFor(page, unknown).locator('.low-bag-warning')).toHaveCount(0);
  await page.getByLabel('Show bags', { exact: true }).selectOption('all');
  await expect(cardFor(page, archived)).toContainText('Archived');
  await expect(cardFor(page, archived).locator('.low-bag-warning')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('synced brewing crosses the threshold and deleting a mistaken brew clears the warning', async ({ page, request }) => {
  const bag = await createBag(request, 100);
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(bag.id);
  await expect(warning(page)).toBeHidden();
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  await expect(warning(page)).toContainText('about 80 g left');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('discarded');
  await expect(warning(page)).toBeVisible(); // Discarded brews still used beans.
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  const brewCard = page.locator('.journal-card').filter({ hasText: bag.name });
  page.once('dialog', dialog => dialog.accept());
  await brewCard.getByRole('button', { name: 'Delete brew' }).click();
  await expect(brewCard).toHaveCount(0);
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(warning(page)).toBeHidden();
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await expect(cardFor(page, bag)).toContainText('100 g remaining');
  await expect(cardFor(page, bag).locator('.low-bag-warning')).toHaveCount(0);
});

test('bag edits refresh reminders, including empty bags, and archiving clears them', async ({ page, request }) => {
  const bag = await createBag(request, 20);
  const id = randomUUID();
  expect((await request.post('/api/brews', { data: { id, bagId: bag.id, recipeId: 'v60-hot', dose: 20, temperatureF: 203, grindSetting: '15' } })).status()).toBe(201);
  expect((await request.patch(`/api/brews/${id}`, { data: { status: 'completed' } })).status()).toBe(200);
  await page.goto('/');
  await expect(warning(page)).toContainText('Bag empty:');
  await expect(warning(page)).toContainText('Open a replacement');
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  const card = cardFor(page, bag);
  await expect(card.locator('.low-bag-warning')).toContainText('Bag empty:');
  const editWeight = async value => {
    await card.getByRole('button', { name: 'Edit bag', exact: true }).click();
    await page.getByLabel('Original bag weight').fill(value);
    await page.getByRole('button', { name: 'Save bag', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save bag', exact: true })).toHaveCount(0);
  };
  await editWeight('200');
  await expect(card.locator('.low-bag-warning')).toHaveCount(0);
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(warning(page)).toBeHidden();
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await editWeight('95');
  await expect(card.locator('.low-bag-warning')).toContainText('about 75 g left');
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(warning(page)).toContainText('about 75 g left');
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByLabel('Show bags', { exact: true }).selectOption('all');
  await expect(card).toContainText('Archived');
  await expect(card.locator('.low-bag-warning')).toHaveCount(0);
  await page.getByRole('link', { name: 'Brew', exact: true }).click();
  await expect(warning(page)).toBeHidden();
});
