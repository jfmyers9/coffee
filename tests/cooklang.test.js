import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { recipes, loadRecipes, parseRecipe } from '../server/recipes.js';
import { createRecipe } from '../public/recipe.js';
import { createApp } from '../server.js';

const fixture = await readFile(new URL('./fixtures/recipes/aeropress-steep.cook', import.meta.url), 'utf8');

test('adding only a .cook file discovers another recipe and exposes it over HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-recipes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const recipe of recipes) await copyFile(new URL(`../recipes/${recipe.id}.cook`, import.meta.url), join(directory, `${recipe.id}.cook`));
  await writeFile(join(directory, 'additional.cook'), fixture);
  await writeFile(join(directory, 'ignored.txt'), 'not a recipe');
  const catalog = await loadRecipes(directory);
  assert.equal(catalog.length, recipes.length + 1);
  const added = catalog.find(recipe => recipe.id === 'aeropress-steep');
  const brew = createRecipe(added, 18);
  assert.equal(brew.water, 270);
  assert.equal(brew.ice, 0);
  assert.equal(brew.duration, 144);
  assert.deepEqual(brew.steps.map(step => [step.title, step.start, step.end, step.target]), [
    ['Fill', 0, 24, 270], ['Steep', 24, 114, 270], ['Press', 114, 144, 270],
  ]);
  assert.match(brew.prep, /18 g coffee/);
  assert.match(brew.steps[0].instruction, /270 g water over 24 seconds/);
  const server = createApp({ pool: {}, recipes: catalog });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recipes`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).recipes, catalog);
});

test('catalog rejects duplicate IDs, empty directories, and invalid recipes with filenames', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(loadRecipes(directory), /No .cook recipes/);
  await writeFile(join(directory, 'a.cook'), fixture);
  await writeFile(join(directory, 'b.cook'), fixture);
  await assert.rejects(loadRecipes(directory), /duplicate recipe ID/);
  await writeFile(join(directory, 'b.cook'), 'Not a brewing recipe');
  await assert.rejects(loadRecipes(directory), /b.cook: Missing coffee metadata/);
});

test('unsupported or ambiguous authoring fails rather than silently losing instructions', () => {
  for (const [from, to, expected] of [
    ['dose: 15', 'dose: 0', /coffee.dose/],
    ['max: 20', 'max: 10', /within min\/max/],
    ['grind: Medium-fine', 'grnid: Medium-fine', /Unknown coffee metadata/],
    ['@coffee{15%g}', '@coffee{16%g}', /matching coffee.dose/],
    ['@water{225%g}', '@water{225%ml}', /quantity in g/],
    ['@water{225%g}', '@?water{225%g}', /modifiers are not supported/],
    ['@water{225%g}', '@milk{225%g}', /plain coffee, water, or ice/],
    ['~scaled{20%seconds}', '~scaled{0%seconds}', /positive numbers/],
    ['~scaled{20%seconds}', '~mystery{20%seconds}', /Timer name/],
    ['~scaled{20%seconds}', '~{20%seconds} ~{10%seconds}', /at most one timer/],
    ['= Prep =', '= Preparation =', /First and last/],
    ['Stir gently and steep', 'Stir gently.\n\nSteep', /exactly one instruction paragraph/],
    ['~{90%seconds}', '~until{25%seconds}', /at 18.4 g/],
  ]) assert.throws(() => parseRecipe(fixture.replace(from, to), 'bad.cook'), expected, from);
});

test('Cooklang comments, fractions, and minute timers use the official parser', () => {
  const source = fixture.replace('@water{225%g}', '@water{225 1/2%g}')
    .replace('~{90%seconds}', '~{1 1/2%minutes}')
    .replace('= Fill =', '-- an author comment\n= Fill =');
  const recipe = createRecipe(parseRecipe(source));
  assert.equal(recipe.water, 226);
  assert.equal(recipe.steps[1].end - recipe.steps[1].start, 90);
  assert.doesNotMatch(recipe.steps[0].instruction, /author comment/);
});

test('file revisions change version without changing recipe identity', () => {
  const before = parseRecipe(fixture);
  const after = parseRecipe(fixture.replace('Stir gently', 'Stir once'));
  assert.equal(before.id, after.id);
  assert.notEqual(before.version, after.version);
});

test('temperature defaults are numeric, bounded, and backwards compatible', () => {
  assert.equal(parseRecipe(fixture).temperatureF, 203);
  for (const value of [140, 203, 212]) {
    assert.equal(parseRecipe(fixture.replace('coffee:', `coffee:\n  temperatureF: ${value}`)).temperatureF, value);
  }
  for (const value of ['139', '213', '203.5', '"203"', 'null', 'true']) {
    assert.throws(() => parseRecipe(fixture.replace('coffee:', `coffee:\n  temperatureF: ${value}`)), /coffee.temperatureF/);
  }
  assert.equal(recipes.find(recipe => recipe.id === 'french-press-hoffmann').temperatureF, 212);
});

test('top-level attribution is optional, trimmed, and restricted to safe source links', () => {
  const plain = parseRecipe(fixture);
  assert.equal(plain.author, undefined);
  assert.equal(plain.source, undefined);
  const withMetadata = fields => fixture.replace('coffee:', `${fields}\ncoffee:`);
  const credited = parseRecipe(withMetadata('author: "  Test Author  "\nsource: https://example.com/recipe'));
  assert.equal(credited.author, 'Test Author');
  assert.equal(credited.source, 'https://example.com/recipe');
  assert.equal(parseRecipe(withMetadata('source: http://example.com/recipe')).source, 'http://example.com/recipe');
  for (const source of ['javascript:alert(1)', 'data:text/html,test', '//example.com', '/relative', 'https://user:password@example.com', 'not a URL']) {
    assert.throws(() => parseRecipe(withMetadata(`source: ${JSON.stringify(source)}`)), /source/);
  }
  for (const field of ['author', 'source']) {
    for (const value of ['42', 'null', '[]', '" "', '"hello\\nworld"']) {
      assert.throws(() => parseRecipe(withMetadata(`${field}: ${value}`)), new RegExp(field));
    }
  }
  const frenchPress = recipes.find(recipe => recipe.id === 'french-press-hoffmann');
  assert.equal(frenchPress.author, 'James Hoffmann');
  assert.match(frenchPress.source, /^https:\/\/www.youtube.com\//);
});

test('untimed interior sections become manual steps; absolute timers after them are rejected', () => {
  const source = fixture.replace('~{90%seconds}', 'as long as desired');
  const definition = parseRecipe(source);
  assert.equal(definition.steps[1].timer, null);
  assert.equal(definition.steps[2].timer.seconds, 30);
  const brew = createRecipe(definition);
  assert.equal(brew.steps[1].manual, true);
  assert.equal(brew.steps[1].end - brew.steps[1].start, 0);
  assert.equal(brew.duration, 50);
  assert.throws(() => parseRecipe(source.replace('~{30%seconds}', '~until{5%minutes}')), /until timer cannot follow a manual step/);
  const frenchPress = recipes.find(recipe => recipe.id === 'french-press-hoffmann');
  assert.deepEqual(frenchPress.steps.map(step => step.timer?.seconds ?? null), [30, 240, null, 300, null]);
  assert.equal(createRecipe(frenchPress).duration, 540);
});

test('fixed Cooklang quantities stay fixed while ordinary quantities scale with dose', () => {
  const definition = parseRecipe(fixture.replace('@water{225%g}', '@water{=225%g}'));
  const recipe = createRecipe(definition, 18);
  assert.equal(recipe.water, 225);
  assert.match(recipe.prep, /18 g coffee/);
  assert.equal(recipe.ratio, 12.5);
  assert.throws(() => parseRecipe(fixture.replace('@coffee{15%g}', '@coffee{=15%g}')), /scalable coffee quantity/);
});
