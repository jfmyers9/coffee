import { test, expect } from '@playwright/test';

test('long bag options fit toolbar and editor fields and remain keyboard-focusable', async ({ page }) => {
  // Use the real stylesheet without the app or database contents influencing layout.
  await page.goto('/styles.css');
  const longName = `Long coffee name · ${'ExtraLongUnbrokenCoffeeName'.repeat(12)} (archived)`;
  const select = name => {
    const id = name.toLowerCase().replaceAll(' ', '-');
    return `<label class="form-field"><span id="${id}-label">${name}</span><select id="${id}" aria-labelledby="${id}-label"><option value="short">Short name</option><option value="long">${longName}</option></select></label>`;
  };
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main>
    <div class="service-toolbar">${select('Toolbar bag')}</div>
    <form class="service-form card brew-editor"><fieldset class="brew-edit-section"><legend>Coffee</legend><div class="form-grid">${select('Editor bag')}</div></fieldset></form>
    </main></body></html>`);
  await page.addStyleTag({ url: '/styles.css' });
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 720 });
    for (const name of ['Toolbar bag', 'Editor bag']) {
      const input = page.getByLabel(name, { exact: true });
      await input.selectOption('long');
      await expect(input).toHaveValue('long');
      await expect(input.locator('option:checked')).toHaveText(longName);
      const layout = await page.evaluate(() => ({
        viewport: innerWidth, page: document.documentElement.scrollWidth,
        fields: [...document.querySelectorAll('select')].map(element => ({ id: element.id, width: element.clientWidth, scrollWidth: element.scrollWidth })),
      }));
      expect(layout.page, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
      await input.focus();
      await expect(input).toBeFocused();
      await page.keyboard.press(name === 'Toolbar bag' ? 'Tab' : 'Shift+Tab');
      await expect(page.getByLabel(name === 'Toolbar bag' ? 'Editor bag' : 'Toolbar bag', { exact: true })).toBeFocused();
      await input.selectOption('short');
      await expect(input).toHaveValue('short');
    }
  }
});
