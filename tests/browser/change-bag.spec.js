import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function createBag(request, extra = {}) {
  const response = await request.post('/api/bags', { data: { roaster: 'Bag correction', name: randomUUID(), weightGrams: 250, ...extra } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function createBrew(request, bag, status = 'completed', dose = 20) {
  const input = { id: randomUUID(), bagId: bag.id, recipeId: 'v60-hot', dose, temperatureF: 201, grindSetting: 'Setting 17' };
  expect((await request.post('/api/brews', { data: input })).status()).toBe(201);
  const response = await request.patch(`/api/brews/${input.id}`, { data: { status, rating: 4, notes: `Cup ${input.id}`,
    servings: [{ person: 'You', volumeMl: 200, milk: 'oat', caffeineMg: 75 }] } });
  expect(response.status()).toBe(200);
  return response.json();
}
const cardFor = (page, brew) => page.locator('.journal-card').filter({ hasText: brew.notes });
const editor = page => page.locator('.service-form').filter({ has: page.getByRole('heading', { name: 'Correct coffee bag', exact: true }) });
async function remaining(request, bag) {
  return (await (await request.get(`/api/bags/${bag.id}`)).json()).remainingGrams;
}

test('two wrong-bag brews can be corrected to an archived bag without losing results', async ({ page, request }) => {
  const wrong = await createBag(request, { weightGrams: 100 });
  const correct = await createBag(request, { caffeineType: 'decaf' });
  expect((await request.patch(`/api/bags/${correct.id}`, { data: { archived: true } })).status()).toBe(200);
  expect((await request.post(`/api/bags/${wrong.id}/default`, { data: {} })).status()).toBe(200);
  const brews = [await createBrew(request, wrong), await createBrew(request, wrong, 'discarded', 15)];
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/#journal');
  await page.getByLabel('Coffee bag', { exact: true }).selectOption(wrong.id);
  await cardFor(page, brews[0]).getByRole('button', { name: 'Change coffee bag' }).click();
  await page.getByLabel('Coffee used', { exact: true }).selectOption(correct.id);
  await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await remaining(request, wrong)).toBe(65);
  expect(await remaining(request, correct)).toBe(250);
  for (const brew of brews) {
    const card = cardFor(page, brew);
    await card.getByRole('button', { name: 'Change coffee bag' }).click();
    await expect(page.getByLabel('Coffee used', { exact: true })).toHaveValue(wrong.id);
    await expect(page.getByLabel('Coffee used').locator('option', { hasText: correct.name })).toContainText('(archived)');
    await page.getByLabel('Coffee used').selectOption(correct.id);
    const layout = await page.evaluate(() => ({
      fits: document.documentElement.scrollWidth <= innerWidth,
      overflowing: [...document.querySelectorAll('body *')].filter(element => element.scrollWidth > element.clientWidth)
        .map(element => `${element.tagName}.${element.className}`),
    }));
    expect(layout.fits, JSON.stringify(layout.overflowing)).toBe(true);
    await page.getByRole('button', { name: 'Save bag change' }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.locator('#journal-content')).toContainText('Coffee bag corrected. History and bag usage are updated.');
    await expect(card).toHaveCount(0); // It no longer matches the old-bag filter.
    const saved = await (await request.get(`/api/brews/${brew.id}`)).json();
    expect(saved).toEqual({ ...brew, bagId: correct.id, bagSnapshot: { roaster: correct.roaster, name: correct.name, caffeineType: 'decaf' } });
  }
  expect(await remaining(request, wrong)).toBe(100);
  expect(await remaining(request, correct)).toBe(215);
  expect((await (await request.get('/api/bags')).json()).defaultBagId).toBe(wrong.id);
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await expect(page.locator('.bean-card').filter({ hasText: wrong.name })).toContainText('100 g');
  await page.getByLabel('Show bags', { exact: true }).selectOption('all');
  await expect(page.locator('.bean-card').filter({ hasText: correct.name })).toContainText('215 g');
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await page.reload();
  for (const brew of brews) {
    await expect(cardFor(page, brew)).toContainText(correct.name);
    await expect(cardFor(page, brew)).toContainText('4/5');
    await expect(cardFor(page, brew)).toContainText('caffeine: 75 mg (entered)');
  }
});

test('failed and lost correction responses preserve the selection and retry without double-counting', async ({ page, request }) => {
  const wrong = await createBag(request), correct = await createBag(request);
  const brew = await createBrew(request, wrong);
  const path = `/api/brews/${brew.id}`;
  await page.goto('/#journal');
  await cardFor(page, brew).getByRole('button', { name: 'Change coffee bag' }).click();
  await page.getByLabel('Coffee used').selectOption(correct.id);
  await page.route(`**${path}`, route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 503, json: { error: 'Try again later' } }) : route.continue());
  await page.getByRole('button', { name: 'Save bag change' }).click();
  await expect(editor(page)).toContainText('Try again later');
  await expect(page.getByLabel('Coffee used')).toHaveValue(correct.id);
  expect(await remaining(request, wrong)).toBe(230);
  expect(await remaining(request, correct)).toBe(250);
  await page.unroute(`**${path}`);
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'PATCH') {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save bag change' }).click();
  await expect(editor(page).getByRole('button', { name: 'Save bag change' })).toBeEnabled();
  await expect(page.getByLabel('Coffee used')).toHaveValue(correct.id);
  expect(await remaining(request, wrong)).toBe(250);
  expect(await remaining(request, correct)).toBe(230);
  await page.unroute(`**${path}`);
  // A successful save followed by a failed refresh must not be reported as a failed save.
  await page.route('**/api/bags', route => route.fulfill({ status: 503, json: { error: 'Bag refresh unavailable' } }));
  await page.getByRole('button', { name: 'Save bag change' }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('#journal-content')).toContainText('Coffee bag corrected, but some views could not refresh.');
  expect(await remaining(request, correct)).toBe(230);
  await page.unroute('**/api/bags');
  await cardFor(page, brew).getByRole('button', { name: 'Change coffee bag' }).click();
  await expect(page.getByLabel('Coffee used')).toHaveValue(correct.id);
  await page.getByLabel('Coffee used').selectOption('');
  await page.getByRole('button', { name: 'Save bag change' }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(cardFor(page, brew)).toContainText('Unlinked coffee');
  expect(await remaining(request, correct)).toBe(250);
});

test('active local timers cannot have their bag changed even after another device closes the brew', async ({ page, request }) => {
  const bag = await createBag(request);
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(bag.id);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  const card = page.locator('.journal-card').filter({ hasText: bag.name });
  await expect(card.getByRole('button', { name: 'Change coffee bag' })).toHaveCount(0);
  expect((await request.patch(`/api/brews/${id}`, { data: { status: 'discarded' } })).status()).toBe(200);
  await page.reload();
  await card.getByRole('button', { name: 'Change coffee bag' }).click();
  await expect(page.locator('#journal-content')).toContainText('This timer is active on this device');
  await expect(editor(page)).toHaveCount(0);
  expect((await (await request.get(`/api/brews/${id}`)).json()).bagId).toBe(bag.id);
});
