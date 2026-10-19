import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecipe, resolveRecipe, validRatio } from '../public/recipe.js';
import { recipes, parseRecipe } from '../server/recipes.js';

test('hot recipes default to 1:16 and preserve bloom while scaling subsequent water and pour times', () => {
  const definition = resolveRecipe(recipes, { recipeId: 'chemex-hot' });
  const normal = createRecipe(definition, 54);
  const stronger = createRecipe(definition, 54, 15);
  assert.equal(normal.water, 864);
  assert.equal(stronger.water, 810);
  assert.equal(stronger.ratio, 15);
  assert.deepEqual(stronger.steps[0], normal.steps[0]);
  assert.deepEqual(stronger.steps.filter(step => step.pouring).map(step => step.target), [162, 378, 594, 810]);
  assert.equal(stronger.steps[2].end - stronger.steps[2].start, 43);
  assert.equal(stronger.duration, 321);
  assert.match(stronger.steps[2].instruction, /216 g water over about 0:43/);
  assert.equal(stronger.steps[1].end, 45);
  assert.equal(stronger.steps.at(-1).end - stronger.steps.at(-1).start, 107);
});

for (const id of ['v60-hot', 'chemex-hot']) {
  test(`${id}: ratios and doses conserve water, maintain contiguous steps, and leave drawdown time`, () => {
    const definition = resolveRecipe(recipes, { recipeId: id });
    for (let tenths = definition.min * 10; tenths <= definition.max * 10; tenths++) {
      for (const ratio of [10, 12, 14.5, 15, 15.1, 16, 17.5, 20, 25]) {
        const dose = tenths / 10;
        const recipe = createRecipe(definition, dose, ratio);
        assert.equal(recipe.water, Math.round(dose * ratio + 1e-9));
        assert.equal(recipe.ratio, ratio);
        assert.equal(recipe.steps[0].target, Math.round(dose * 3 + 1e-9));
        assert.equal(recipe.steps[1].end, 45);
        assert.equal(recipe.steps.at(-1).end - recipe.steps.at(-1).start, id === 'v60-hot' ? 74 : 107);
        let cursor = 0, total = 0;
        for (const step of recipe.steps) {
          assert.equal(step.start, cursor);
          assert.ok(step.end > step.start);
          if (step.pouring) assert.ok(Math.abs(step.rate - 5) < 1, `${id} ${dose} g 1:${ratio}: ${step.rate} g/s`);
          cursor = step.end;
          total += step.added;
        }
        assert.equal(total, recipe.water);
      }
    }
  });
}

test('invalid ratios and overrides on specialized recipes are rejected', () => {
  const definition = resolveRecipe(recipes, { recipeId: 'v60-hot' });
  for (const ratio of [null, NaN, Infinity, 0, 9.9, 25.1, 15.01, '15']) {
    assert.equal(validRatio(ratio), false);
    assert.throws(() => createRecipe(definition, 20, ratio), RangeError);
  }
  for (const id of ['v60-japanese-iced', 'french-press-hoffmann']) {
    const specialized = resolveRecipe(recipes, { recipeId: id });
    assert.throws(() => createRecipe(specialized, specialized.dose, 16), RangeError);
    assert.equal(createRecipe(specialized).water, id === 'v60-japanese-iced' ? 150 : 500);
  }
});

test('old snapshots without ratio metadata keep original timing and do not acquire an adjustable ratio', () => {
  const { ratio, ...legacy } = resolveRecipe(recipes, { recipeId: 'v60-hot' });
  legacy.steps = legacy.steps.map(step => step.title === 'Draw down'
    ? { ...step, timer: { mode: 'until', seconds: 210 }, items: [{ type: 'text', text: 'Drain until ' }, { type: 'timer', mode: 'until', seconds: 210 }] }
    : step);
  assert.equal(createRecipe(legacy, 30).duration, 210);
  assert.equal(createRecipe(legacy, 30).ratio, 16);
  assert.throws(() => createRecipe(legacy, 30, 15), RangeError);
});

test('Cooklang ratio metadata is explicit, numeric, and compatible with its bloom and water', async () => {
  const source = await readFile(new URL('../recipes/v60-hot.cook', import.meta.url), 'utf8');
  assert.equal(parseRecipe(source).ratio, 16);
  for (const value of ['"16"', 'true', 'null', '9', '26', '16.01', '15']) {
    assert.throws(() => parseRecipe(source.replace('ratio: 16', `ratio: ${value}`)), /ratio/i);
  }
  assert.throws(() => parseRecipe(source.replace('~scaled{17%seconds}', '~{17%seconds}')), /scaled timers/);
  assert.throws(() => parseRecipe(source.replace('@water{60%g}', '@water{=60%g}')), /scalable bloom/);
});
