export const BREWERS = {
  v60: {
    name: 'V60', size: '02', min: 12, max: 30, dose: 20, ratio: 16,
    grind: 'Encore · 15', texture: 'Start medium-fine, a little finer than table salt. Original Encore, not ESP. Adjust to taste; calibration varies.',
    temperature: '201–205°F', bloomEnd: 45, pourSeconds: 25, restSeconds: 20,
    finish: 210,
    prep: 'Rinse the filter, warm the brewer, then discard the rinse water. Add grounds and make a small well in the center.',
  },
  chemex: {
    name: 'Chemex', size: '6–8 cup', min: 20, max: 45, dose: 30, ratio: 16,
    grind: 'Encore · 20', texture: 'Start medium-coarse, like coarse sand. Original Encore, not ESP. Adjust to taste; calibration varies.',
    temperature: '201–205°F', bloomEnd: 45, pourSeconds: 35, restSeconds: 20,
    finish: 270,
    prep: 'Place the three-layer side of the filter against the spout. Rinse, discard the rinse water, and add your grounds.',
  },
};

export function recipeConfig(brewer, variant = 'hot') {
  if (!Object.hasOwn(BREWERS, brewer) || !['hot', 'japanese-iced'].includes(variant) || (variant !== 'hot' && brewer !== 'v60')) throw new RangeError('Unsupported recipe variant.');
  if (variant === 'hot') return BREWERS[brewer];
  return { ...BREWERS.v60, dose: 15, ratio: 15, grind: 'Encore · 13',
    texture: 'A starting point, two clicks finer than the hot V60 suggestion. Adjust to your beans and grinder calibration.',
    bloomEnd: 30, restSeconds: 10,
    prep: 'Rinse the filter and discard the rinse water before adding ice. Add the brewing ice to the carafe, assemble the brewer with grounds, then tare the scale. Pour targets exclude the ice.',
  };
}

export function createRecipe(brewer, dose, variant = 'hot') {
  const config = recipeConfig(brewer, variant);
  if (!config || !Number.isFinite(dose) || dose < config.min || dose > config.max || Math.abs(dose * 10 - Math.round(dose * 10)) > 1e-8) {
    throw new RangeError('Choose a supported brewer and a dose in range (0.1 g increments).');
  }
  const iced = variant === 'japanese-iced';
  const water = Math.round(dose * (iced ? 10 : config.ratio));
  const ice = iced ? Math.round(dose * 5) : 0;
  const bloom = Math.round(dose * (iced ? 2 : 3));
  const pourCount = iced ? 2 : 3;
  const pourSeconds = iced ? Math.round(20 * dose / 15) : config.pourSeconds;
  const finish = iced ? config.bloomEnd + 2 * pourSeconds + config.restSeconds + 70 : config.finish;
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
  add('Bloom', iced ? Math.round(10 * dose / 15) : 15, bloom, 'Wet all the grounds, then give the brewer a gentle swirl.', true);
  add('Let it bloom', config.bloomEnd - cursor, bloom, 'Let the coffee release its gas. No water needed.');
  for (let i = 1; i <= pourCount; i++) {
    const target = Math.round(bloom + (water - bloom) * i / pourCount);
    add(`Pour ${i}`, pourSeconds, target, 'Pour slow circles, from the center outward. Avoid the filter walls.', true);
    if (i < pourCount) add('Let it settle', config.restSeconds, target, 'Give the water time to drain through the bed.');
  }
  add('Draw down', finish - cursor, water, 'Gently swirl to level the bed. Let the remaining water drain.');
  return { ...config, brewer, variant, dose, water, ice, finish, pourSeconds, totalWater: water + ice,
    finishInstruction: iced ? 'Remove the brewer, swirl to chill, then top with ice to taste. Extra serving ice is not included in the recipe ratio.' : 'Swirl, sip, and tell your journal how it went.',
    steps, duration: cursor };
}

export function currentStep(recipe, seconds) {
  return recipe.steps.findIndex(step => seconds < step.end);
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
