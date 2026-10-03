export const BREWERS = {
  v60: {
    name: 'V60', size: '02', min: 12, max: 30, dose: 20, ratio: 16,
    grind: 'Encore · 15', texture: 'Start medium-fine, a little finer than table salt. Original Encore, not ESP. Adjust to taste; calibration varies.',
    temperature: '94–96°C', bloomEnd: 45, pourSeconds: 25, restSeconds: 20,
    finish: 210,
    prep: 'Rinse the filter, warm the brewer, then discard the rinse water. Add grounds and make a small well in the center.',
  },
  chemex: {
    name: 'Chemex', size: '6–8 cup', min: 20, max: 45, dose: 30, ratio: 16,
    grind: 'Encore · 20', texture: 'Start medium-coarse, like coarse sand. Original Encore, not ESP. Adjust to taste; calibration varies.',
    temperature: '94–96°C', bloomEnd: 45, pourSeconds: 35, restSeconds: 20,
    finish: 270,
    prep: 'Place the three-layer side of the filter against the spout. Rinse, discard the rinse water, and add your grounds.',
  },
};

export function createRecipe(brewer, dose) {
  const config = Object.hasOwn(BREWERS, brewer) ? BREWERS[brewer] : null;
  if (!config || !Number.isFinite(dose) || dose < config.min || dose > config.max || Math.abs(dose * 10 - Math.round(dose * 10)) > 1e-8) {
    throw new RangeError('Choose a supported brewer and a dose in range (0.1 g increments).');
  }
  const water = Math.round(dose * config.ratio);
  const bloom = Math.round(dose * 3);
  const steps = [];
  let cursor = 0;
  let previous = 0;
  function add(title, duration, target, instruction, pouring = false) {
    steps.push({ title, start: cursor, end: cursor + duration, target,
      added: pouring ? target - previous : 0,
      rate: pouring ? (target - previous) / duration : 0, instruction, pouring });
    cursor += duration;
    previous = target;
  }
  add('Bloom', 15, bloom, 'Wet all the grounds, then give the brewer a gentle swirl.', true);
  add('Let it bloom', config.bloomEnd - cursor, bloom, 'Let the coffee release its gas. No water needed.');
  for (let i = 1; i <= 3; i++) {
    const target = Math.round(bloom + (water - bloom) * i / 3);
    add(`Pour ${i}`, config.pourSeconds, target, 'Pour slow circles, from the center outward. Avoid the filter walls.', true);
    if (i < 3) add('Let it settle', config.restSeconds, target, 'Give the water time to drain through the bed.');
  }
  add('Draw down', config.finish - cursor, water, 'Gently swirl to level the bed. Let the remaining water drain.');
  return { ...config, brewer, dose, water, steps, duration: cursor };
}

export function currentStep(recipe, seconds) {
  return recipe.steps.findIndex(step => seconds < step.end);
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
