import test from 'node:test';
import assert from 'node:assert/strict';
import { BREWERS, createRecipe, currentStep, formatTime } from '../public/recipe.js';

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

test('Japanese iced separates ice from cumulative hot-water targets', () => {
  const recipe = createRecipe('v60', 15, 'japanese-iced');
  assert.equal(recipe.water, 150);
  assert.equal(recipe.ice, 75);
  assert.equal(recipe.totalWater, 225);
  assert.equal(recipe.ratio, 15);
  assert.equal(recipe.grind, 'Encore · 13');
  assert.equal(recipe.duration, 150);
  assert.equal(recipe.finish, recipe.duration);
  assert.equal(recipe.pourSeconds, 20);
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
