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

test('adding only a .cook file discovers a fourth recipe and exposes it over HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coffee-recipes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const recipe of recipes) await copyFile(new URL(`../recipes/${recipe.id}.cook`, import.meta.url), join(directory, `${recipe.id}.cook`));
  await writeFile(join(directory, 'fourth.cook'), fixture);
  await writeFile(join(directory, 'ignored.txt'), 'not a recipe');
  const catalog = await loadRecipes(directory);
  assert.equal(catalog.length, 4);
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
    ['~scaled{20%seconds}', '~{20%seconds} ~{10%seconds}', /exactly one timer/],
    ['~scaled{20%seconds}', '20 seconds', /exactly one timer/],
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

test('fixed Cooklang quantities stay fixed while ordinary quantities scale with dose', () => {
  const definition = parseRecipe(fixture.replace('@water{225%g}', '@water{=225%g}'));
  const recipe = createRecipe(definition, 18);
  assert.equal(recipe.water, 225);
  assert.match(recipe.prep, /18 g coffee/);
  assert.equal(recipe.ratio, 12.5);
  assert.throws(() => parseRecipe(fixture.replace('@coffee{15%g}', '@coffee{=15%g}')), /scalable coffee quantity/);
});
