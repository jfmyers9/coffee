import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const ratio = page => page.getByLabel('Water-to-coffee ratio');
async function chemex(page) {
  await page.getByRole('button', { name: /Chemex/ }).click();
  await page.getByLabel('Coffee beans').fill('54');
}

test('hot ratios default to 16, preview water/timing, and persist independently without changing specialized recipes', async ({ page }) => {
  await page.goto('/');
  await expect(ratio(page)).toHaveValue('16');
  await chemex(page);
  await ratio(page).fill('15');
  await expect(page.locator('#water')).toHaveText('810 g');
  await expect(page.locator('#ratio')).toHaveText('1 : 15');
  await expect(page.locator('#timeline small').first()).toHaveText('Add 162 g in 0:32 · 5.1 g/s');
  await expect(page.locator('#timeline small').nth(2)).toHaveText('Add 216 g in 0:43 · 5.0 g/s');
  await expect(page.locator('#duration')).toHaveText('About 5:21');
  await page.getByRole('button', { name: /V60/ }).click();
  await expect(ratio(page)).toHaveValue('16');
  await ratio(page).fill('17.5');
  await expect(page.locator('#water')).toHaveText('350 g');
  await page.getByLabel('V60 recipe').selectOption('v60-japanese-iced');
  await expect(ratio(page)).toBeHidden();
  await expect(page.locator('#water')).toHaveText('150 g');
  await page.getByLabel('V60 recipe').selectOption('v60-hot');
  await expect(ratio(page)).toHaveValue('17.5');
  await page.getByRole('button', { name: /French Press/ }).click();
  await expect(ratio(page)).toBeHidden();
  await expect(page.locator('#water')).toHaveText('500 g');
  await page.getByRole('button', { name: /Chemex/ }).click();
  await expect(ratio(page)).toHaveValue('15');
  await page.reload();
  await expect(ratio(page)).toHaveValue('15');
  await expect(page.locator('#water')).toHaveText('810 g');
  await page.getByRole('button', { name: /V60/ }).click();
  await expect(ratio(page)).toHaveValue('17.5');
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid ratio typing disables brewing without replacing the last saved preference', async ({ page }) => {
  await page.goto('/');
  await ratio(page).fill('15');
  for (const value of ['', '9.9', '25.1', '15.01']) {
    await ratio(page).fill(value);
    await expect(page.locator('#ratio-error')).toBeVisible();
    await expect(ratio(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Start brewing' })).toBeDisabled();
  }
  await page.reload();
  await expect(ratio(page)).toHaveValue('15');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
  await ratio(page).fill('15.1');
  await expect(page.locator('#ratio-error')).toBeHidden();
  await expect(page.locator('#water')).toHaveText('302 g');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
});

test('active timers, journal records, and replay retain the chosen ratio instead of a later preference', async ({ page, request }) => {
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  const bag = await (await request.post('/api/bags', { data: { roaster: 'Ratio test', name: randomUUID(), weightGrams: 340 } })).json();
  await page.goto('/');
  await page.getByLabel('On the counter').selectOption(bag.id);
  await chemex(page);
  await ratio(page).fill('15');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(ratio(page)).toBeDisabled();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  expect(await (await request.get(`/api/brews/${id}`)).json()).toMatchObject({ ratio: 15, water: 810, recipe: { ratio: 15, duration: 321 } });
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('morning-coffee-v1'));
    state.ratios['chemex-hot'] = 20;
    localStorage.setItem('morning-coffee-v1', JSON.stringify(state));
  });
  await page.reload();
  await expect(ratio(page)).toHaveValue('15');
  await expect(page.locator('#water')).toHaveText('810 g');
  await page.clock.fastForward(321000);
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('completed');
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await expect(ratio(page)).toHaveValue('15');
  await ratio(page).fill('19');
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await page.getByLabel('Coffee bag', { exact: true }).selectOption(bag.id);
  const own = page.locator('.journal-card').filter({ hasText: bag.name });
  await expect(own).toContainText('Recipe ratio 1:15');
  await own.getByRole('button', { name: 'Brew again', exact: true }).click();
  await expect(ratio(page)).toHaveValue('15');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('54');
  await expect(page.locator('#water')).toHaveText('810 g');
});

test('old snapshot-backed sessions stay fixed and become adjustable only after the timer is cleared', async ({ page, request }) => {
  const catalog = await (await request.get('/api/recipes')).json();
  const definition = catalog.recipes.find(item => item.id === 'v60-hot');
  delete definition.ratio;
  definition.steps.at(-1).timer = { mode: 'until', seconds: 210 };
  definition.steps.at(-1).items = [{ type: 'text', text: 'Drain until ' }, { type: 'timer', mode: 'until', seconds: 210 }];
  await page.addInitScript(definition => {
    localStorage.setItem('morning-coffee-v1', JSON.stringify({
      brewer: 'v60', recipeId: 'v60-hot', ratios: { 'v60-hot': 20 },
      session: { recipeId: 'v60-hot', definition, dose: 30, temperatureF: 203,
        timer: { status: 'paused', accumulated: 100000, startedAt: null } },
    }));
  }, definition);
  await page.goto('/');
  await expect(ratio(page)).toBeHidden();
  await expect(page.locator('#water')).toHaveText('480 g');
  await expect(page.locator('#duration')).toHaveText('About 3:30');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await expect(ratio(page)).toHaveValue('20');
  await expect(page.locator('#water')).toHaveText('600 g');
});

test('offline starts and finishes preserve the ratio when the outbox later syncs', async ({ page, request }) => {
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.route('**/api/brews**', route => ['POST', 'PATCH'].includes(route.request().method()) ? route.abort() : route.continue());
  await page.goto('/');
  await page.getByLabel('On the counter').selectOption('');
  await chemex(page);
  await ratio(page).fill('15');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  const queued = () => page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-outbox-v1') || '[]'));
  await expect.poll(async () => (await queued()).length).toBe(1);
  expect((await queued())[0].body.ratio).toBe(15);
  await expect(page.locator('#sync-text')).toContainText('1 brew update waiting to sync ·');
  await page.reload();
  await expect(ratio(page)).toHaveValue('15');
  await expect(page.locator('#water')).toHaveText('810 g');
  await expect(page.locator('#sync-text')).toContainText('1 brew update waiting to sync ·');
  await page.clock.fastForward(321000);
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await expect.poll(async () => (await queued()).length).toBe(2);
  await expect(page.locator('#sync-text')).toContainText('2 brew updates waiting to sync ·');
  await page.unroute('**/api/brews**');
  await page.getByRole('button', { name: 'Retry sync', exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get(`/api/brews/${id}`);
    return response.status() === 200 ? (await response.json()).status : null;
  }).toBe('completed');
  expect(await (await request.get(`/api/brews/${id}`)).json()).toMatchObject({ ratio: 15, water: 810, recipe: { ratio: 15 } });
});
