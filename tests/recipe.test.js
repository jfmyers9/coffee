import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipe as compile, resolveRecipe, currentStep, recipeProgress, completeManualStep, formatTime } from '../public/recipe.js';
import { recipes } from '../server/recipes.js';
const createRecipe = (brewer, dose, variant = 'hot') => compile(resolveRecipe(recipes, { brewer, variant }), dose);
const BREWERS = Object.fromEntries(recipes.filter(item => item.legacyVariant === 'hot').map(item => [item.brewer, { ...item, finish: compile(item).duration }]));

for (const [brewer, config] of Object.entries(BREWERS)) {
  test(`${brewer}: every supported dose conserves water with contiguous positive steps`, () => {
    for (let tenths = config.min * 10; tenths <= config.max * 10; tenths++) {
      const dose = tenths / 10;
      const recipe = createRecipe(brewer, dose);
      assert.equal(recipe.dose, dose);
      assert.equal(recipe.water, Math.round(dose * 16));
      assert.equal(recipe.steps[0].target, Math.round(dose * 3));
      assert.equal(recipe.steps.at(-1).target, recipe.water);
      assert.equal(recipe.steps.reduce((sum, step) => sum + step.added, 0), recipe.water);
      let cursor = 0;
      let target = 0;
      for (const step of recipe.steps) {
        assert.equal(step.start, cursor);
        assert.ok(step.end > step.start);
        assert.ok(step.target >= target);
        assert.equal(step.rate, step.added / (step.end - step.start));
        cursor = step.end;
        target = step.target;
      }
      assert.equal(cursor, config.finish);
    }
  });
}

test('V60 recipe has clear cumulative targets and exact phase boundaries', () => {
  const recipe = createRecipe('v60', 20);
  assert.deepEqual(recipe.steps.filter(s => s.pouring).map(s => s.target), [60, 147, 233, 320]);
  assert.equal(currentStep(recipe, 0), 0);
  assert.equal(currentStep(recipe, 14.99), 0);
  assert.equal(currentStep(recipe, 15), 1);
  assert.equal(currentStep(recipe, 45), 2);
  assert.equal(currentStep(recipe, 210), -1);
});

test('invalid recipes are rejected rather than silently clamped', () => {
  for (const [brewer, dose] of [['v60', NaN], ['v60', 0], ['v60', 31], ['chemex', 19], ['chemex', 46], ['v60', 20.05], ['v60', '20'], ['aeropress', 20], ['constructor', 20]]) {
    assert.throws(() => createRecipe(brewer, dose), RangeError);
  }
});

test('clock formatting', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.8), '1:05');
  assert.equal(formatTime(270), '4:30');
});

test('recipe instructions format absolute and relative timers as minutes and seconds', () => {
  const recipe = createRecipe('chemex', 30);
  assert.match(recipe.steps.at(-1).instruction, /until 4:30 on the brew clock/);
  for (const step of recipe.steps) {
    assert.ok(!/\d+ seconds/.test(step.instruction));
  }
  const iced = createRecipe('v60', 15, 'japanese-iced');
  assert.match(iced.steps.at(-1).instruction, /for 1:10/);
});

test('Japanese iced separates ice from cumulative hot-water targets', () => {
  const recipe = createRecipe('v60', 15, 'japanese-iced');
  assert.equal(recipe.water, 150);
  assert.equal(recipe.ice, 75);
  assert.equal(recipe.totalWater, 225);
  assert.equal(recipe.ratio, 15);
  assert.equal(recipe.grind, 'Encore · 13');
  assert.equal(recipe.duration, 150);
  assert.equal(recipe.finish, recipe.duration);
  assert.equal(recipe.steps[2].end - recipe.steps[2].start, 20);
  assert.deepEqual(recipe.steps.filter(step => step.pouring).map(step => [step.start, step.end, step.target, step.rate]), [[0, 10, 30, 3], [30, 50, 90, 3], [60, 80, 150, 3]]);
  assert.equal(recipe.steps[currentStep(recipe, 30)].title, 'Pour 1');
  assert.equal(recipe.steps[currentStep(recipe, 60)].target, 150);
  assert.match(recipe.prep, /discard.*rinse water.*ice/i);
  assert.match(recipe.finishInstruction, /top with ice/);
});

test('iced doses scale water and ice without treating ice as poured water', () => {
  for (let tenths = 120; tenths <= 300; tenths++) {
    const recipe = createRecipe('v60', tenths / 10, 'japanese-iced');
    assert.equal(recipe.water, tenths);
    assert.equal(recipe.ice, Math.round(tenths / 2));
    assert.equal(recipe.totalWater, recipe.water + recipe.ice);
    assert.equal(recipe.steps.reduce((sum, step) => sum + step.added, 0), recipe.water);
    let end = 0;
    for (const step of recipe.steps) {
      assert.equal(step.start, end);
      assert.ok(step.end > step.start);
      end = step.end;
    }
  }
  assert.throws(() => createRecipe('chemex', 30, 'japanese-iced'), RangeError);
  assert.throws(() => createRecipe('v60', 15, 'unknown'), RangeError);
  assert.deepEqual(createRecipe('v60', 20), createRecipe('v60', 20, 'hot'));
});

test('Hoffmann French press keeps the four-minute steep, settling rest, and no-plunge finish', () => {
  const definition = resolveRecipe(recipes, { recipeId: 'french-press-hoffmann' });
  const recipe = compile(definition);
  assert.equal(recipe.brewer, 'french-press');
  assert.equal(recipe.label, 'James Hoffmann');
  assert.equal(recipe.dose, 30);
  assert.equal(recipe.water, 500);
  assert.equal(recipe.ice, 0);
  assert.equal(recipe.grind, 'Medium');
  assert.deepEqual(recipe.steps.map(step => [step.start, step.end, step.pouring]), [
    [0, 30, true], [30, 240, false], [240, 240, false], [240, 540, false], [540, 540, false],
  ]);
  assert.equal(recipe.steps[currentStep(recipe, 240)].title, 'Break the crust and skim');
  assert.match(recipe.steps[3].instruction, /five to eight minutes/);
  assert.match(recipe.steps[4].instruction, /Do not push it down/);
  assert.match(recipe.finishInstruction, /do not plunge/i);
  assert.equal(recipe.temperatureF, 212);
  assert.equal(recipe.author, 'James Hoffmann');
  assert.match(recipe.source, /^https:\/\/www.youtube.com\//);
  assert.equal(recipe.hasManualSteps, true);

  for (let tenths = definition.min * 10; tenths <= definition.max * 10; tenths++) {
    const scaled = compile(definition, tenths / 10);
    assert.equal(scaled.water, Math.round(tenths / 10 * 500 / 30));
    assert.equal(scaled.steps.filter(step => step.pouring).length, 1);
    assert.ok(scaled.steps.every(step => step.target === scaled.water));
    assert.equal(scaled.steps[1].end, 240);
    assert.equal(scaled.steps[3].end - scaled.steps[3].start, 300);
    assert.equal(scaled.duration, 540);
  }
});

test('manual work gates advancement and starts the next timed rest upon confirmation', () => {
  const recipe = compile(resolveRecipe(recipes, { recipeId: 'french-press-hoffmann' }));
  assert.equal(currentStep(recipe, 239.99), 1);
  assert.equal(currentStep(recipe, 240), 2);
  assert.equal(currentStep(recipe, 3600), 2);
  assert.deepEqual(recipeProgress(recipe, 3600), { index: 2, start: 240, end: null, progress: 2 / 5 });
  let completed = completeManualStep(recipe, 3600);
  assert.deepEqual(completed, [{ index: 2, seconds: 3600 }]);
  assert.equal(currentStep(recipe, 3600, completed), 3);
  assert.equal(recipeProgress(recipe, 3600, completed).end, 3900);
  assert.equal(currentStep(recipe, 3899.99, completed), 3);
  assert.equal(currentStep(recipe, 3900, completed), 4);
  assert.equal(currentStep(recipe, 9000, completed), 4);
  assert.equal(completeManualStep(recipe, 3700, completed), completed);
  completed = completeManualStep(recipe, 9000, completed);
  assert.equal(currentStep(recipe, 9000, completed), -1);
  assert.equal(recipeProgress(recipe, 9000, completed).progress, 1);
  assert.equal(completeManualStep(recipe, 9000, completed), completed);
  for (const invalid of [[{ index: 2, seconds: 239 }], [{ index: 2, seconds: 5000 }], [{ index: 4, seconds: 400 }]]) {
    assert.equal(currentStep(recipe, 400, invalid), 2);
  }
});

test('all-manual recipes retain water targets without invented durations or rates', () => {
  const original = resolveRecipe(recipes, { recipeId: 'french-press-hoffmann' });
  const recipe = compile({ ...original, steps: original.steps.map(step => ({
    ...step, timer: null, items: step.items.filter(item => item.type !== 'timer'),
  })) });
  assert.equal(recipe.duration, 0);
  assert.equal(recipe.steps[0].target, 500);
  assert.equal(recipe.steps[0].rate, null);
  let completions = [];
  for (let index = 0; index < recipe.steps.length; index++) {
    assert.equal(currentStep(recipe, 1000, completions), index);
    assert.equal(recipeProgress(recipe, 1000, completions).progress, index / recipe.steps.length);
    completions = completeManualStep(recipe, 1000, completions);
  }
  assert.equal(currentStep(recipe, 1000, completions), -1);
});

test('legacy definitions keep their timed behavior and fallback temperature', () => {
  const { temperatureF, author, source, ...legacy } = resolveRecipe(recipes, { recipeId: 'v60-hot' });
  const recipe = compile(legacy);
  assert.equal(recipe.temperatureF, 203);
  assert.equal(recipe.hasManualSteps, false);
  assert.equal(currentStep(recipe, 45), 2);
  assert.equal(recipeProgress(recipe, 105).progress, 0.5);
  assert.equal(recipeProgress(recipe, 300).progress, 1);
});
