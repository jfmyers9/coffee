import { test, expect } from '@playwright/test';

test('temperature defaults and deliberate overrides are independent per recipe', async ({ page }) => {
  await page.goto('/');
  const temperature = page.getByLabel('Water temperature');
  await expect(temperature).toHaveValue('203');
  await temperature.fill('200');
  await page.getByRole('button', { name: /French Press/ }).click();
  await expect(temperature).toHaveValue('212');
  await expect(page.locator('#temperature-hint')).toContainText('Boiling water');
  await temperature.fill('205');
  await page.getByRole('button', { name: /V60/ }).click();
  await expect(temperature).toHaveValue('200');
  await page.getByLabel('V60 recipe').selectOption('v60-japanese-iced');
  await expect(temperature).toHaveValue('203');
  await temperature.fill('198');
  await page.reload();
  await expect(temperature).toHaveValue('198');
  await page.getByLabel('V60 recipe').selectOption('v60-hot');
  await expect(temperature).toHaveValue('200');
  await page.getByRole('button', { name: /French Press/ }).click();
  await expect(temperature).toHaveValue('205');
  await temperature.fill('203');
  await page.reload();
  await expect(temperature).toHaveValue('203');
  await temperature.fill('213');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeDisabled();
  await page.getByRole('button', { name: /Chemex/ }).click();
  await expect(temperature).toHaveValue('203');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
});

for (const legacy of [203, 199]) {
  test(`legacy global ${legacy}°F migrates without overriding other recipes`, async ({ page }) => {
    await page.addInitScript(value => {
      if (!localStorage.getItem('morning-coffee-v1')) localStorage.setItem('morning-coffee-v1', JSON.stringify({
        brewer: 'french-press', recipeId: 'french-press-hoffmann', temperatureF: value,
      }));
    }, legacy);
    await page.goto('/');
    await expect(page.getByLabel('Water temperature')).toHaveValue(legacy === 203 ? '212' : '199');
    await page.getByRole('button', { name: /V60/ }).click();
    await expect(page.getByLabel('Water temperature')).toHaveValue('203');
    await page.getByRole('button', { name: /French Press/ }).click();
    await page.reload();
    await expect(page.getByLabel('Water temperature')).toHaveValue(legacy === 203 ? '212' : '199');
  });
}

test('old snapshot-backed French press timers retain timed steps and temperature', async ({ page, request }) => {
  const { recipes } = await (await request.get('/api/recipes')).json();
  const definition = recipes.find(recipe => recipe.id === 'french-press-hoffmann');
  delete definition.temperatureF;
  // Reconstruct the previous all-timed definition; it must not pick up manual
  // steps or the new boiling-water default in the middle of an existing brew.
  for (const step of definition.steps) if (!step.timer) step.timer = { mode: 'fixed', seconds: 30 };
  await page.addInitScript(definition => {
    if (!localStorage.getItem('morning-coffee-v1')) localStorage.setItem('morning-coffee-v1', JSON.stringify({
      brewer: 'french-press', recipeId: definition.id, temperatureF: 203,
      session: { definition, dose: 30, timer: { status: 'paused', accumulated: 280000, startedAt: null } },
    }));
  }, definition);
  await page.goto('/');
  await expect(page.getByLabel('Water temperature')).toHaveValue('203');
  await expect(page.locator('#instruction-title')).toHaveText('Let the grounds settle');
  await expect(page.locator('#timing')).toContainText('4:50 left');
  await expect(page.getByRole('button', { name: 'Done → Continue' })).toBeHidden();
  await page.reload();
  await expect(page.locator('#clock')).toHaveText('4:40');
  await expect(page.getByLabel('Water temperature')).toHaveValue('203');
});

test('all-manual recipes render untimed water additions without invalid rates or progress', async ({ page }) => {
  await page.route('**/api/recipes', async route => {
    const data = await (await route.fetch()).json();
    const recipe = data.recipes.find(recipe => recipe.id === 'french-press-hoffmann');
    recipe.steps = recipe.steps.slice(0, 1).map(step => ({
      ...step, timer: null, items: step.items.filter(item => item.type !== 'timer'),
    }));
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /French Press/ }).click();
  await expect(page.locator('#rate')).toHaveText('At your pace');
  await expect(page.locator('#timeline')).toContainText('At your pace · add 500 g');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.locator('#progress')).toHaveAttribute('value', '0');
  await page.getByRole('button', { name: 'Done → Continue' }).click();
  await expect(page.locator('#progress')).toHaveAttribute('value', '100');
});

test('catalog changes preserve saved overrides but update untouched defaults', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /French Press/ }).click();
  await page.getByLabel('Water temperature').fill('203');
  await page.getByRole('button', { name: /V60/ }).click();
  await page.getByLabel('Coffee beans').fill('21');
  await page.route('**/api/recipes', async route => {
    const data = await (await route.fetch()).json();
    for (const recipe of data.recipes) recipe.temperatureF = 208;
    await route.fulfill({ json: data });
  });
  await page.reload();
  await expect(page.getByLabel('Water temperature')).toHaveValue('208');
  await page.getByRole('button', { name: /French Press/ }).click();
  await expect(page.getByLabel('Water temperature')).toHaveValue('203');
});
