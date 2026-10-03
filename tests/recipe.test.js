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
