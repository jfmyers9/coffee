import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function bag(request) {
  const response = await request.post('/api/bags', { data: { roaster: 'Dial in', name: randomUUID(), weightGrams: 340 } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function brew(request, bagId, extra = {}, result = {}) {
  const input = { id: randomUUID(), bagId, recipeId: 'v60-hot', dose: 20, temperatureF: 201, grindSetting: 'Setting 17', ...extra };
  expect((await request.post('/api/brews', { data: input })).status()).toBe(201);
  expect((await request.patch(`/api/brews/${input.id}`, { data: { status: 'completed', rating: 4, notes: 'Try slightly finer tomorrow.', ...result } })).status()).toBe(200);
  return input;
}

test('grinder overrides are isolated by bag and recipe with legacy fallback and clear-to-reset', async ({ page, request }) => {
  const a = await bag(request), b = await bag(request);
  await page.addInitScript(() => {
    if (!localStorage.getItem('morning-coffee-v1')) localStorage.setItem('morning-coffee-v1', JSON.stringify({
      brewer: 'v60', notes: { v60: 'Legacy 16' },
    }));
  });
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(b.id);
  await expect(page.locator('#grind')).toHaveText('Legacy 16');
  await page.getByText('Your grinder setting').click();
  await page.getByLabel('Save a dial setting').fill('Bag B 18');
  await page.getByLabel('On the counter').selectOption(a.id);
  await expect(page.locator('#grind')).toHaveText('Legacy 16');
  await page.getByLabel('Save a dial setting').fill('Bag A 14');
  await page.getByLabel('V60 recipe').selectOption('v60-japanese-iced');
  await expect(page.locator('#grind')).toHaveText('Encore · 13');
  await page.getByLabel('Save a dial setting').fill('A iced 12');
  await page.getByLabel('On the counter').selectOption(b.id);
  await expect(page.locator('#grind')).toHaveText('Encore · 13');
  await page.getByLabel('V60 recipe').selectOption('v60-hot');
  await expect(page.locator('#grind')).toHaveText('Bag B 18');
  await page.reload();
  await expect(page.locator('#grind')).toHaveText('Bag B 18');
  await page.getByLabel('On the counter').selectOption(a.id);
  await expect(page.locator('#grind')).toHaveText('Bag A 14');
  await page.getByText('Your grinder setting').click();
  await page.getByLabel('Save a dial setting').fill('');
  await expect(page.locator('#grind')).toHaveText('Legacy 16');
  await page.getByLabel('On the counter').selectOption('');
  await expect(page.locator('#last-brew')).toBeHidden();
  await page.getByLabel('Save a dial setting').fill('Recipe 15');
  await page.getByLabel('On the counter').selectOption(a.id);
  await expect(page.locator('#grind')).toHaveText('Recipe 15');
  await page.getByLabel('On the counter').selectOption(b.id);
  await expect(page.locator('#grind')).toHaveText('Bag B 18');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  expect((await (await request.get(`/api/brews/${id}`)).json()).grindSetting).toBe('Bag B 18');
  // Preference changes outside the session cannot change the recorded/displayed grind.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('morning-coffee-v1'));
    state.bagNotes = {};
    state.notes['v60-hot'] = 'Changed elsewhere';
    localStorage.setItem('morning-coffee-v1', JSON.stringify(state));
  });
  await page.reload();
  await expect(page.locator('#grind')).toHaveText('Bag B 18');
});

test('last completed brew shows feedback, repeats its settings, and updates after deletion', async ({ page, request }) => {
  const a = await bag(request);
  await brew(request, a.id, { startedAt: new Date(Date.now() - 120000).toISOString() }, { notes: 'Older brew' });
  const latest = await brew(request, a.id, { recipeId: 'chemex-hot', dose: 32, grindSetting: 'Custom 22' }, { notes: '<b>Sweet cup</b>\n' + 'x'.repeat(140), taste: 'balanced', rating: 5 });
  await brew(request, a.id, {}, { status: 'discarded', notes: 'Ignore discarded' });
  await page.goto('/');
  const preview = page.locator('#last-brew');
  await expect(preview).toContainText('Custom 22');
  await expect(preview).toContainText('32 g coffee · 201°F');
  await expect(preview).toContainText('Rating: 5/5');
  await expect(preview).toContainText('<b>Sweet cup</b>');
  await expect(preview.locator('b')).toHaveCount(0);
  await expect(preview).not.toContainText('Ignore discarded');
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Repeat this brew' }).click();
  await expect(page.getByRole('button', { name: /Chemex/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('32');
  await expect(page.getByLabel('Water temperature')).toHaveValue('201');
  await expect(page.locator('#grind')).toHaveText('Custom 22');
  // Loading settings is not itself a new brew or inventory debit.
  expect((await (await request.get(`/api/brews?bagId=${a.id}`)).json()).total).toBe(3);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.getByRole('button', { name: 'Repeat this brew' })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  expect((await request.delete(`/api/brews/${latest.id}`, { data: {} })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh last brew' }).click();
  await expect(preview).toContainText('Older brew');
});

test('preview handles empty bags and failures without blocking brewing', async ({ page, request }) => {
  const a = await bag(request);
  await page.goto('/');
  await expect(page.locator('#last-brew')).toContainText('No completed brews');
  await expect(page.getByRole('button', { name: 'Repeat this brew' })).toBeHidden();
  await page.route('**/api/brews?**', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.getByRole('button', { name: 'Refresh last brew' }).click();
  await expect(page.locator('#last-brew')).toContainText('Last brew is unavailable');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
  await page.unroute('**/api/brews?**');
  await brew(request, a.id);
  await page.getByRole('button', { name: 'Refresh last brew' }).click();
  await expect(page.locator('#last-brew')).toContainText('Try slightly finer tomorrow.');
});

test('slow preview responses cannot replace the newly selected bag', async ({ page, request }) => {
  const a = await bag(request), b = await bag(request);
  await brew(request, a.id, {}, { notes: 'Bag A result' });
  await brew(request, b.id, {}, { notes: 'Bag B result' });
  await page.goto('/');
  await expect(page.locator('#last-brew')).toContainText('Bag B result');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  await page.route('**/api/brews?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('bagId') !== a.id) return route.continue();
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  await page.getByLabel('On the counter').selectOption(a.id);
  await started;
  await page.getByLabel('On the counter').selectOption(b.id);
  await expect(page.locator('#last-brew')).toContainText('Bag B result');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#last-brew')).toContainText('Bag B result');
});

test('repeat refreshes stale feedback and refuses a deleted or unavailable recipe', async ({ page, request }) => {
  const a = await bag(request);
  const latest = await brew(request, a.id);
  await page.goto('/');
  await expect(page.locator('#last-brew')).toContainText('Setting 17');
  await request.delete(`/api/brews/${latest.id}`, { data: {} });
  await page.getByRole('button', { name: 'Repeat this brew' }).click();
  await expect(page.locator('#service-message')).toContainText('Could not repeat brew');
  await expect(page.locator('#last-brew')).toContainText('No completed brews');
  await brew(request, a.id, { recipeId: 'chemex-hot', dose: 30 });
  await page.route('**/api/recipes', async route => {
    const data = await (await route.fetch()).json();
    data.recipes = data.recipes.filter(item => item.id !== 'chemex-hot');
    await route.fulfill({ json: data });
  });
  await page.reload();
  await expect(page.locator('#last-brew')).toContainText('Chemex');
  await page.getByRole('button', { name: 'Repeat this brew' }).click();
  await expect(page.locator('#service-message')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
});

test('journal replay saves the grind for its own bag without overwriting another bag', async ({ page, request }) => {
  const a = await bag(request), b = await bag(request);
  await brew(request, a.id, {}, { notes: 'Replay bag A' });
  await page.goto('/');
  await expect(page.getByLabel('On the counter')).toHaveValue(b.id);
  await page.getByText('Your grinder setting').click();
  await page.getByLabel('Save a dial setting').fill('Bag B 19');
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await page.getByLabel('Coffee bag', { exact: true }).selectOption(a.id);
  await page.locator('.journal-card').filter({ hasText: 'Replay bag A' }).getByRole('button', { name: 'Brew again' }).click();
  await expect(page.getByLabel('On the counter')).toHaveValue(a.id);
  await expect(page.locator('#grind')).toHaveText('Setting 17');
  await page.getByLabel('On the counter').selectOption(b.id);
  await expect(page.locator('#grind')).toHaveText('Bag B 19');
  await page.reload();
  await page.getByLabel('On the counter').selectOption(a.id);
  await expect(page.locator('#grind')).toHaveText('Setting 17');
});
