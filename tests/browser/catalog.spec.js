import { test, expect } from '@playwright/test';

test('a fourth file on a new brewer supports timing, persistence, journal, and replay', async ({ page, request }) => {
  await page.clock.install({ time: new Date(Date.now() - 10 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: /AeroPress/ }).click();
  await page.getByLabel('Coffee beans').fill('18');
  await expect(page.locator('#water')).toHaveText('270 g');
  await expect(page.locator('#prep')).toContainText('18 g coffee');
  await page.getByText('Your grinder setting').click();
  await page.getByLabel('Save a dial setting').fill('Custom 14');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('morning-coffee-v1')).session.brewId);
  await expect.poll(async () => (await request.get(`/api/brews/${id}`)).status()).toBe(200);
  await expect(page.locator('#instruction-title')).toHaveText('Fill');
  await expect(page.locator('#instruction')).toContainText('270 g water over 0:24');
  await page.clock.fastForward(24000);
  await expect(page.locator('#instruction-title')).toHaveText('Steep');
  await page.reload();
  await expect(page.locator('#instruction-title')).toHaveText('Steep');
  await page.clock.fastForward(90000);
  await expect(page.locator('#instruction-title')).toHaveText('Press');
  await page.clock.fastForward(30000);
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/brews/${id}`)).json()).status).toBe('completed');
  const brew = await (await request.get(`/api/brews/${id}`)).json();
  expect(brew.recipeId).toBe('aeropress-steep');
  expect(brew.recipe.steps.map(step => step.title)).toEqual(['Fill', 'Steep', 'Press']);
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await page.getByRole('button', { name: /V60/ }).click();
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await page.getByLabel('Brewer', { exact: true }).selectOption('aeropress');
  const card = page.locator('.journal-card').filter({ hasText: 'Custom 14' }).first();
  await expect(card).toContainText('AeroPress · Steep & Press');
  await card.getByRole('button', { name: 'Brew again' }).click();
  await expect(page.getByRole('button', { name: /AeroPress/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('18');
  await expect(page.locator('#grind')).toHaveText('Custom 14');
});

test('old preferences migrate independently, including an unselected iced recipe', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('morning-coffee-v1')) localStorage.setItem('morning-coffee-v1', JSON.stringify({
      brewer: 'chemex', v60Variant: 'japanese-iced',
      doses: { v60: 22, chemex: 35, 'v60:japanese-iced': 17 },
      notes: { v60: 'Hot 16', chemex: 'Chemex 22', 'v60:japanese-iced': 'Iced 12' },
    }));
  });
  await page.goto('/');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('35');
  await page.getByRole('button', { name: /V60/ }).click();
  await expect(page.getByLabel('V60 recipe')).toHaveValue('v60-japanese-iced');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('17');
  await expect(page.locator('#grind')).toHaveText('Iced 12');
  await page.getByLabel('V60 recipe').selectOption('v60-hot');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('22');
  await expect(page.locator('#grind')).toHaveText('Hot 16');
  await page.reload();
  await expect(page.getByLabel('Coffee beans')).toHaveValue('22');
});

test('active sessions retain their definition when the catalog changes', async ({ page }) => {
  await page.clock.install({ time: new Date(Date.now() - 10 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(16000);
  await page.route('**/api/recipes', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const changed = data.recipes.find(recipe => recipe.id === 'v60-hot');
    changed.steps[0].timer.seconds = 60;
    changed.steps[1].timer.seconds = 90;
    await route.fulfill({ json: data });
  });
  await page.reload();
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  await expect(page.locator('#clock')).toHaveText('0:16');
});

test('catalog fetch failure disables brewing and explains recovery', async ({ page }) => {
  await page.route('**/api/recipes', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeDisabled();
  await expect(page.locator('#service-message')).toContainText('Reload to try again');
});

test('legacy active timers restore through brewer and variant IDs', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('morning-coffee-v1')) localStorage.setItem('morning-coffee-v1', JSON.stringify({
      brewer: 'v60', v60Variant: 'hot',
      session: { brewer: 'v60', variant: 'japanese-iced', dose: 15,
        timer: { status: 'paused', accumulated: 35000, startedAt: null } },
    }));
  });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('PAUSED');
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  await expect(page.locator('#target')).toHaveText('90 g');
  await expect(page.getByLabel('V60 recipe')).toHaveValue('v60-japanese-iced');
  await page.reload();
  await expect(page.locator('#clock')).toHaveText('0:35');
});
