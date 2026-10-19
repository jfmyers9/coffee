import { test, expect } from '@playwright/test';

async function mockAudio(page, unsupported = false) {
  await page.addInitScript(({ unsupported }) => {
    window.testAudio = { created: 0, resumed: 0, chimes: 0, reject: false };
    class AudioContext extends EventTarget {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      constructor() { super(); window.testAudio.created++; }
      async resume() {
        window.testAudio.resumed++;
        if (window.testAudio.reject) throw new Error('Autoplay denied');
        this.state = 'running';
        this.dispatchEvent(new Event('statechange'));
      }
      createGain() {
        return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
      }
      createOscillator() {
        return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
          start() { window.testAudio.chimes++; }, stop() {} };
      }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: unsupported ? undefined : AudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  }, { unsupported });
}
const count = page => page.evaluate(() => window.testAudio.chimes);

test('phase changes chime once; pause, resume, ticks, completion and reset do not repeat cues', async ({ page }) => {
  await mockAudio(page);
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.goto('/');
  await expect(page.locator('#phase-sound')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.testAudio.created)).toBe(0);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.locator('#sound-hint')).toContainText('Chime ready');
  expect(await count(page)).toBe(0);
  await page.clock.fastForward(12000);
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  expect(await count(page)).toBe(1);
  await page.clock.fastForward(1000);
  expect(await count(page)).toBe(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.fastForward(60000);
  expect(await count(page)).toBe(1);
  await page.getByRole('button', { name: 'Resume' }).click();
  expect(await count(page)).toBe(1);
  await page.clock.fastForward(32000);
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  expect(await count(page)).toBe(2);
  // Simulate a throttled tab: only the phase now on screen gets a cue.
  await page.clock.fastForward(165000);
  await expect(page.locator('#instruction-title')).toHaveText('Complete the final step.');
  expect(await count(page)).toBe(3);
  await page.clock.fastForward(10000);
  expect(await count(page)).toBe(3);
  await page.getByRole('button', { name: 'Finish brew', exact: true }).click();
  await page.getByRole('button', { name: 'Make another cup' }).click();
  expect(await count(page)).toBe(3);
  await page.getByRole('button', { name: 'Start brewing' }).click();
  expect(await count(page)).toBe(3);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard & start over' }).click();
  expect(await count(page)).toBe(3);
});

test('mute persists, remains available while brewing, and never replays muted phases', async ({ page }) => {
  await mockAudio(page);
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Phase sound: on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test sound', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.locator('#phase-sound')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(12000);
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  expect(await count(page)).toBe(0);
  expect(await page.evaluate(() => window.testAudio.created)).toBe(0);
  await page.getByRole('button', { name: 'Phase sound: off', exact: true }).click();
  await expect(page.locator('#sound-hint')).toContainText('Chime ready');
  await page.clock.fastForward(1000);
  expect(await count(page)).toBe(0);
  await page.clock.fastForward(32000);
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  expect(await count(page)).toBe(1);
  await page.getByRole('button', { name: 'Phase sound: on', exact: true }).click();
  await page.clock.fastForward(17000);
  await expect(page.locator('#instruction-title')).toHaveText('Let it settle');
  expect(await count(page)).toBe(1);
});

test('reload is silent and Test sound re-arms audio without changing the timer', async ({ page }) => {
  await mockAudio(page);
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(12000);
  await page.reload();
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  expect(await count(page)).toBe(0);
  expect(await page.evaluate(() => window.testAudio.created)).toBe(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const frozen = await page.locator('#clock').textContent();
  await page.getByRole('button', { name: 'Test sound', exact: true }).click();
  await expect.poll(() => count(page)).toBe(1);
  await expect(page.locator('#clock')).toHaveText(frozen);
  await page.getByRole('button', { name: 'Resume' }).click();
  expect(await count(page)).toBe(1);
  await page.clock.fastForward(33000);
  await expect(page.locator('#instruction-title')).toHaveText('Pour 1');
  expect(await count(page)).toBe(2);
});

test('manual steps chime on entry and confirmation, not while waiting for the user', async ({ page }) => {
  await mockAudio(page);
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.goto('/');
  await page.getByRole('button', { name: /French Press/ }).click();
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(240000);
  await expect(page.locator('#instruction-title')).toHaveText('Break the crust and skim');
  expect(await count(page)).toBe(1);
  await page.clock.fastForward(60000);
  expect(await count(page)).toBe(1);
  await page.getByRole('button', { name: 'Done → Continue' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Let the grounds settle');
  expect(await count(page)).toBe(2);
  await page.clock.fastForward(300000);
  await expect(page.locator('#instruction-title')).toHaveText('Serve gently, do not plunge');
  expect(await count(page)).toBe(3);
  await page.getByRole('button', { name: 'Done → Continue' }).click();
  expect(await count(page)).toBe(4);
});

test('blocked audio can be retried and never prevents brewing', async ({ page }) => {
  await mockAudio(page);
  await page.clock.install({ time: new Date(Date.now() - 60 * 60 * 1000) });
  await page.goto('/');
  await page.evaluate(() => { window.testAudio.reject = true; });
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await page.clock.fastForward(12000);
  await expect(page.locator('#instruction-title')).toHaveText('Let it bloom');
  await expect(page.locator('#sound-hint')).toContainText('tap Test sound');
  expect(await count(page)).toBe(0);
  await page.evaluate(() => { window.testAudio.reject = false; });
  await page.getByRole('button', { name: 'Test sound', exact: true }).click();
  await expect.poll(() => count(page)).toBe(1);
  await expect(page.locator('#sound-hint')).toContainText('Chime ready');
});

test('unsupported audio leaves the visual timer usable', async ({ page }) => {
  await mockAudio(page, true);
  await page.goto('/');
  await expect(page.locator('#phase-sound')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test sound', exact: true })).toBeDisabled();
  await expect(page.locator('#sound-hint')).toContainText('unavailable in this browser');
  await page.getByRole('button', { name: 'Start brewing' }).click();
  await expect(page.locator('#instruction-title')).toHaveText('Bloom');
});

test('native Web Audio can unlock and synthesize the test chime', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Test sound', exact: true }).click();
  await expect(page.locator('#sound-hint')).toContainText('Chime ready');
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
});
