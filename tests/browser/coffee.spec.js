import { test, expect } from '@playwright/test';

test('recipes, grinder overrides and doses persist independently', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#water')).toHaveText('320 g');
  await expect(page.locator('#grind')).toHaveText('Encore · 15');
  await page.getByLabel('Coffee beans').fill('22.5');
  await expect(page.locator('#water')).toHaveText('360 g');
  await page.getByText('Your grinder setting').click();
  await page.getByLabel('Save a dial setting').fill('Encore 16');
  await page.getByRole('button', { name: /Chemex/ }).click();
  await expect(page.locator('#water')).toHaveText('480 g');
  await expect(page.locator('#grind')).toHaveText('Encore · 20');
  await page.getByLabel('Save a dial setting').fill('Encore 22');
  await page.reload();
  await expect(page.locator('#grind')).toHaveText('Encore 22');
  await page.getByRole('button', { name: /V60/ }).click();
  await expect(page.getByLabel('Coffee beans')).toHaveValue('22.5');
  await expect(page.locator('#grind')).toHaveText('Encore 16');
});

test('invalid doses cannot start and decimal typing works', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Coffee beans').fill('99');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeDisabled();
  await expect(page.locator('#dose-error')).toBeVisible();
  await page.getByLabel('Coffee beans').fill('');
  await page.getByLabel('Coffee beans').pressSequentially('20.5');
  await expect(page.getByLabel('Coffee beans')).toHaveValue('20.5');
  await expect(page.locator('#water')).toHaveText('328 g');
  await expect(page.getByRole('button', { name: 'Start brewing' })).toBeEnabled();
});

test('guided brew transitions, pauses, restores and finishes', async ({ page }) => {
  await page.clock.install({ time: new Date(Date.now() - 10 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Bloom');
  await expect(page.getByLabel('Coffee beans')).toBeDisabled();
  await page.clock.fastForward(16000);
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  await expect(page.locator('#rate')).toHaveText('No pour');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const frozen = await page.locator('#clock').textContent();
  await page.clock.fastForward(60000);
  await expect(page.locator('#clock')).toHaveText(frozen);
  await page.reload();
  await expect(page.locator('#clock')).toHaveText(frozen);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.clock.fastForward(30000);
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  await expect(page.locator('#target')).toHaveText('147 g');
  await page.reload();
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  await page.clock.fastForward(200000);
  await expect(page.locator('#instruction-title')).toHaveText('Complete the final step.');
  await page.getByRole('button', { name: 'Finish brew' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Enjoy your coffee.');
  await page.getByRole('button', { name: 'Make another cup' }).click();
  await expect(page.getByLabel('Coffee beans')).toBeEnabled();
  await expect(page.locator('#clock')).toHaveText('0:00');
});

test('step durations and countdown use minutes and seconds', async ({ page }) => {
  await page.clock.install({ time: new Date(Date.now() - 10 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: /Chemex/ }).click();
  await expect(page.locator('#timeline small').first()).toContainText('in 0:15');
  await expect(page.locator('#timeline small').last()).toHaveText('1:20 · no pouring');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(190000);
  await expect(page.locator('#instruction')).toContainText('until 4:30 on the brew clock');
  await expect(page.locator('#timing')).toHaveText('1:20 left in this step');
  await page.clock.fastForward(21000);
  await expect(page.locator('#timing')).toHaveText('0:59 left in this step');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#timing')).toHaveText('0:59 left in this step · timer paused');
});

test('discard requires confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  await expect(page.locator('#status')).toHaveText('BREWING');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  await expect(page.locator('#status')).toHaveText('READY');
});

test('corrupt and unavailable storage do not prevent brewing', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('morning-coffee-v1', '{broken');
    Storage.prototype.setItem = () => { throw new Error('Blocked'); };
  });
  await page.goto('/');
  await expect(page.locator('#storage-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Bloom');
});

test('small screens have no horizontal overflow or browser errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('server exposes only app assets', async ({ request }) => {
  expect((await request.get('/health')).status()).toBe(200);
  expect((await request.get('/package.json')).status()).toBe(404);
  expect((await request.get('/.git/config')).status()).toBe(404);
  expect((await request.post('/')).status()).toBe(405);
  const response = await request.get('/');
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
});
