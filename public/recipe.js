// Pure shared engine. Cooklang parsing and file discovery happen on the server.
export function resolveRecipe(recipes, { recipeId, brewer, variant = 'hot' } = {}) {
  const definition = recipeId
    ? recipes.find(item => item.id === recipeId)
    : recipes.find(item => item.brewer === brewer && item.legacyVariant === variant);
  if (!definition) throw new RangeError('Recipe is no longer available.');
  return definition;
}

export function createRecipe(definition, dose = definition?.dose) {
  if (!definition || typeof definition.id !== 'string' || !Number.isFinite(definition.min) || !Number.isFinite(definition.max) || !Number.isFinite(definition.dose) || definition.dose <= 0 || !Number.isFinite(dose) || dose < definition.min || dose > definition.max || Math.abs(dose * 10 - Math.round(dose * 10)) > 1e-8) {
    throw new RangeError('Choose a supported recipe and a dose in range (0.1 g increments).');
  }
  const factor = dose / definition.dose;
  const amount = item => item.amount * (item.fixed ? 1 : factor);
  const render = (items, duration, added) => items.map(item => {
    if (item.type === 'text') return item.text;
    if (item.type === 'cookware') return item.name;
    if (item.type === 'timer') return formatTime(item.mode === 'until' ? item.seconds : duration);
    const grams = item.name === 'water' && added != null ? added
      : item.name === 'ice' ? Math.round(amount(item) + 1e-9) : Math.round(amount(item) * 10) / 10;
    return `${grams} g ${item.name}`;
  }).join('');
  let cursor = 0, cumulative = 0, previous = 0;
  const steps = definition.steps.map(step => {
    const manual = step.timer == null;
    const seconds = manual ? 0 : step.timer.mode === 'scaled' ? Math.round(step.timer.seconds * factor + 1e-9) : step.timer.seconds;
    const duration = step.timer?.mode === 'until' ? seconds - cursor : seconds;
    cumulative += step.items.filter(item => item.type === 'ingredient' && item.name === 'water').reduce((sum, item) => sum + amount(item), 0);
    // Round cumulative totals, not individual pours, so rounding never loses water.
    const target = Math.round(cumulative + 1e-9);
    const added = target - previous;
    const pouring = step.items.some(item => item.type === 'ingredient' && item.name === 'water');
    if (!Number.isFinite(duration) || (!manual && duration < 1) || !Number.isFinite(target) || target < previous || (pouring && added < 1)) throw new RangeError(`Invalid timing or water target in "${step.title}" at ${dose} g.`);
    const result = { title: step.title, start: cursor, end: cursor + duration, target, added, pouring, manual,
      rate: manual ? null : added / duration, instruction: render(step.items, duration, added) };
    cursor += duration;
    previous = target;
    return result;
  });
  if (!steps.length || !previous || cursor > 86400) throw new RangeError('Recipe needs poured water and a timeline under 24 hours.');
  const unroundedIce = definition.prep.filter(item => item.type === 'ingredient' && item.name === 'ice').reduce((sum, item) => sum + amount(item), 0);
  const ice = Math.round(unroundedIce + 1e-9);
  return { id: definition.id, recipeId: definition.id, version: definition.version,
    brewer: definition.brewer, name: definition.brewerName, label: definition.label,
    variant: definition.legacyVariant ?? definition.id, size: definition.size,
    min: definition.min, max: definition.max, grind: definition.grind, texture: definition.texture,
    temperature: definition.temperature, temperatureF: definition.temperatureF ?? 203,
    ...(definition.author ? { author: definition.author } : {}),
    ...(definition.source ? { source: definition.source } : {}),
    dose, water: previous, ice, totalWater: previous + ice,
    ratio: Math.round((cumulative + unroundedIce) / dose * 100) / 100,
    prep: render(definition.prep), finishInstruction: render(definition.finish),
    steps, hasManualSteps: steps.some(step => step.manual), duration: cursor, finish: cursor };
}

// Manual completion times use active elapsed seconds, just like the brew clock.
// This derives the entire timeline without ticks or changing it during render.
export function recipeProgress(recipe, seconds, completions = []) {
  let offset = 0;
  for (const [index, step] of recipe.steps.entries()) {
    const start = step.start + offset;
    if (step.manual) {
      const completed = completions.find(item => item.index === index);
      if (completed && Number.isFinite(completed.seconds) && completed.seconds >= start && completed.seconds <= seconds) {
        offset = completed.seconds - step.end;
        continue;
      }
      return { index, start, end: null, progress: index / recipe.steps.length };
    }
    const end = step.end + offset;
    if (seconds < end) return { index, start, end, progress: recipe.hasManualSteps
      ? (index + Math.max(0, (seconds - start) / (end - start))) / recipe.steps.length
      : Math.max(0, seconds / recipe.duration) };
  }
  return { index: -1, start: recipe.duration + offset, end: null, progress: 1 };
}

export function completeManualStep(recipe, seconds, completions = []) {
  const { index } = recipeProgress(recipe, seconds, completions);
  return recipe.steps[index]?.manual ? [...completions, { index, seconds }] : completions;
}

export function currentStep(recipe, seconds, completions) {
  return recipeProgress(recipe, seconds, completions).index;
}

export function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
