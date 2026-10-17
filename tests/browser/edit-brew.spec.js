import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function setup(request) {
  const bag = await (await request.post('/api/bags', { data: { roaster: 'Unified editor', name: randomUUID(), weightGrams: 100 } })).json();
  const input = { id: randomUUID(), bagId: bag.id, recipeId: 'v60-hot', dose: 20, temperatureF: 201, grindSetting: 'Setting 17' };
  expect((await request.post('/api/brews', { data: input })).status()).toBe(201);
  const response = await request.patch(`/api/brews/${input.id}`, { data: { status: 'completed', elapsedSeconds: 420, rating: 3, notes: bag.name,
    servings: [{ person: bag.name, volumeMl: 200, milk: 'oat', caffeineMg: 75 }] } });
  expect(response.status()).toBe(200);
  return { bag, brew: await response.json() };
}
const formFor = page => page.locator('.brew-editor');
const cardFor = (page, bag) => page.locator('.journal-card').filter({ has: page.getByRole('heading', { name: `Unified editor · ${bag.name}`, exact: true }) });
async function open(page, bag) {
  await cardFor(page, bag).getByRole('button', { name: 'Edit brew', exact: true }).click();
  await expect(formFor(page)).toBeVisible();
}

test('one editor saves coffee, timing, settings, results and servings together on a narrow screen', async ({ page, request }) => {
  const { bag, brew } = await setup(request);
  const correct = await (await request.post('/api/bags', { data: { roaster: 'Actual beans', name: randomUUID(), weightGrams: 200, archived: true, caffeineType: 'decaf' } })).json();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/#journal');
  await expect(cardFor(page, bag).getByRole('button', { name: 'Edit result', exact: true })).toHaveCount(0);
  await expect(cardFor(page, bag).getByRole('button', { name: 'Change coffee bag', exact: true })).toHaveCount(0);
  await expect(page.locator('#daily-summary')).toContainText(bag.name);
  await open(page, bag);
  const form = formFor(page);
  for (const name of ['Coffee', 'Brew details', 'Results', 'Servings']) await expect(form.getByRole('group', { name, exact: true })).toBeVisible();
  await expect(form).toContainText(bag.name);
  await form.getByLabel('Coffee used', { exact: true }).selectOption(correct.id);
  await form.getByLabel('Coffee dose (g)', { exact: true }).fill('22.5');
  await form.getByLabel('Started at (local time)', { exact: true }).fill('2020-02-02T08:00');
  await form.getByLabel('Finished at (local time)', { exact: true }).fill('2020-02-02T08:03');
  await form.getByLabel('Brew duration (minutes:seconds)', { exact: true }).fill('2:15');
  await form.getByLabel('Recorded temperature (°F)', { exact: true }).fill('195');
  await form.getByLabel('Recorded grind setting', { exact: true }).fill('Finer 14');
  await form.getByLabel('Actual water added (g, optional)', { exact: true }).fill('345');
  await form.getByRole('radio', { name: '5 stars', exact: true }).check();
  await form.getByLabel('Taste (optional)', { exact: true }).selectOption('balanced');
  await form.getByLabel('Brew notes', { exact: true }).fill('All details corrected together');
  await form.getByLabel('Cup volume (ml)', { exact: true }).fill('225');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = await (await request.get(`/api/brews/${brew.id}`)).json();
  const times = await page.evaluate(() => ({ startedAt: new Date('2020-02-02T08:00:00').toISOString(), finishedAt: new Date('2020-02-02T08:03:00').toISOString() }));
  expect(saved).toMatchObject({ ...times, bagId: correct.id, dose: 22.5, elapsedSeconds: 135, temperatureF: 195, grindSetting: 'Finer 14', waterActual: 345,
    rating: 5, taste: 'balanced', notes: 'All details corrected together', timingEdited: true, revision: brew.revision + 1,
    servings: [{ person: bag.name, volumeMl: 225, milk: 'oat', caffeineMg: 75 }] });
  expect(saved.recipe).toEqual(brew.recipe);
  expect(saved.water).toBe(brew.water);
  expect((await (await request.get(`/api/bags/${bag.id}`)).json()).remainingGrams).toBe(100);
  expect((await (await request.get(`/api/bags/${correct.id}`)).json()).remainingGrams).toBe(177.5);
  await expect(page.locator('#daily-summary')).not.toContainText(bag.name);
  await page.reload();
  // The corrected date moves this brew out of the journal's newest page.
  await page.getByLabel('Coffee bag', { exact: true }).selectOption(correct.id);
  const card = page.locator('.journal-card').filter({ has: page.getByRole('heading', { name: `Actual beans · ${correct.name}`, exact: true }) });
  await expect(card).toContainText('2:15 elapsed');
  await expect(card).toContainText('22.5 g coffee');
  await card.getByRole('button', { name: 'Edit brew' }).click();
  await expect(form.getByLabel('Started at (local time)')).toHaveValue('2020-02-02T08:00');
  await expect(form.getByLabel('Brew duration (minutes:seconds)')).toHaveValue('2:15');
  await expect(form.getByLabel('Recorded grind setting')).toHaveValue('Finer 14');
  await expect(form.getByRole('radio', { name: '5 stars' })).toBeChecked();
});

test('unsaved edits survive tab changes and require confirmation before cancellation or switching brews', async ({ page, request }) => {
  const first = await setup(request), second = await setup(request);
  await page.goto('/#journal');
  await open(page, first.bag);
  const notes = formFor(page).getByLabel('Brew notes', { exact: true });
  await notes.fill('Unsaved draft');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  page.once('dialog', dialog => dialog.dismiss());
  await formFor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(notes).toHaveValue('Unsaved draft');
  await page.getByRole('link', { name: 'Bean shelf', exact: true }).click();
  await page.getByRole('link', { name: 'Journal', exact: true }).click();
  await expect(notes).toHaveValue('Unsaved draft');
  page.once('dialog', dialog => dialog.dismiss());
  await cardFor(page, second.bag).getByRole('button', { name: 'Edit brew' }).click();
  await expect(notes).toHaveValue('Unsaved draft');
  expect((await (await request.get(`/api/brews/${first.brew.id}`)).json()).notes).toBe(first.brew.notes);
  page.once('dialog', dialog => dialog.accept());
  await open(page, second.bag);
  await expect(notes).toHaveValue(second.brew.notes);
  await notes.fill('Another draft');
  page.once('dialog', dialog => dialog.accept());
  await formFor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(formFor(page)).toHaveCount(0);
  expect((await (await request.get(`/api/brews/${second.brew.id}`)).json()).notes).toBe(second.brew.notes);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
});

test('stale editors retain drafts and offer an explicit reload rather than overwriting another edit', async ({ page, request }) => {
  const { bag, brew } = await setup(request);
  await page.goto('/#journal');
  await open(page, bag);
  await formFor(page).getByLabel('Brew notes').fill('Local draft');
  expect((await request.patch(`/api/brews/${brew.id}/edit`, { data: { expectedRevision: brew.revision, notes: 'Saved on another device' } })).status()).toBe(200);
  await formFor(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(formFor(page)).toContainText('This brew changed since you opened it.');
  await expect(formFor(page).getByLabel('Brew notes')).toHaveValue('Local draft');
  page.once('dialog', dialog => dialog.accept());
  await formFor(page).getByRole('button', { name: 'Reload saved brew' }).click();
  await expect(formFor(page).getByLabel('Brew notes')).toHaveValue('Saved on another device');
  await formFor(page).getByLabel('Brew duration (minutes:seconds)').fill('1:30');
  await formFor(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(formFor(page)).toHaveCount(0);
  const saved = await (await request.get(`/api/brews/${brew.id}`)).json();
  expect(saved.notes).toBe('Saved on another device');
  expect(saved.elapsedSeconds).toBe(90);
});

test('invalid durations and date ordering leave all changes unsaved and can be corrected in place', async ({ page, request }) => {
  const { bag, brew } = await setup(request);
  await page.goto('/#journal');
  await open(page, bag);
  const form = formFor(page);
  const duration = form.getByLabel('Brew duration (minutes:seconds)');
  await duration.fill('1500:00');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toContainText('Enter duration as minutes:seconds, up to 1440:00.');
  await duration.fill('2:00');
  await form.getByLabel('Finished at (local time)').fill('2000-01-01T08:00');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toContainText('Finish time must follow the start');
  expect(await (await request.get(`/api/brews/${brew.id}`)).json()).toEqual(brew);
  await form.getByLabel('Started at (local time)').fill('2000-01-01T07:55');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toHaveCount(0);
  const saved = await (await request.get(`/api/brews/${brew.id}`)).json();
  expect(saved.elapsedSeconds).toBe(120);
  expect(saved.notes).toBe(brew.notes);
});
