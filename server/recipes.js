import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parser } from './cooklang.js';
import { createRecipe } from '../public/recipe.js';

function fail(message) { throw new Error(message); }
function numeric(quantity, units) {
  if (!quantity || !units.includes(quantity.unit) || quantity.value?.type !== 'number') fail(`Expected a numeric quantity in ${units.join('/')}`);
  const value = quantity.value.value;
  const n = value.type === 'regular' ? value.value : value.type === 'fraction'
    ? value.value.whole + value.value.num / value.value.den : NaN;
  if (!Number.isFinite(n) || n <= 0) fail('Quantities must be positive numbers');
  return n;
}

export function parseRecipe(source, filename = '<recipe>') {
  try {
    const parsed = parser.parse(source);
    if (parsed.report?.trim()) {
      // Cooklang warns that a scaling lock is unnecessary without servings.
      // Our dose-based engine does use that lock; all other diagnostics fail.
      const diagnostics = [...parsed.report.matchAll(/(Warning|Error):<\/span> ([^\n]+)/g)];
      if (!diagnostics.length || diagnostics.some(([, level, message]) => level !== 'Warning' || message !== 'Unnecessary scaling lock modifier')) {
        fail(parsed.report.replace(/<[^>]+>/g, ''));
      }
    }
    // The high-level WASM result omits optional/hidden ingredient flags.
    // Inspect the official AST too, so these cannot silently become required pours.
    // This parser version cannot serialize YAML frontmatter in its AST API;
    // metadata has already been parsed above, so inspect only the body here.
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const syntax = parser.parse_ast(body, true);
    try {
      const blocks = JSON.parse(syntax.value).blocks;
      for (const block of blocks) for (const item of block.Step?.items ?? []) {
        if (item.Ingredient?.inner.modifiers?.inner || item.Cookware?.inner.modifiers?.inner) fail('Ingredient and cookware modifiers are not supported');
      }
    } finally { syntax.free(); }
    const raw = parsed.recipe;
    const metadata = raw?.raw_metadata?.map;
    const meta = metadata?.coffee;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('Missing coffee metadata');
    const allowed = ['id', 'brewer', 'brewerName', 'label', 'size', 'min', 'max', 'dose', 'grind', 'texture', 'temperature', 'temperatureF', 'order', 'icon', 'description', 'legacyVariant'];
    if (Object.keys(meta).some(key => !allowed.includes(key))) fail('Unknown coffee metadata field');
    for (const key of ['id', 'brewer', 'brewerName', 'label', 'size', 'grind', 'texture', 'temperature']) {
      if (typeof meta[key] !== 'string' || !meta[key].trim() || meta[key].length > 1000) fail(`Invalid coffee.${key}`);
    }
    if (meta.grind.length > 80) fail('coffee.grind must fit the 80-character journal setting');
    for (const key of ['id', 'brewer']) if (!/^[a-z][a-z0-9-]{0,79}$/.test(meta[key])) fail(`Invalid coffee.${key} slug`);
    for (const key of ['min', 'max', 'dose']) {
      if (!Number.isFinite(meta[key]) || meta[key] < 0.1 || meta[key] > 100 || Math.abs(meta[key] * 10 - Math.round(meta[key] * 10)) > 1e-8) fail(`Invalid coffee.${key}: use 0.1–100 g in 0.1 g increments`);
    }
    if (meta.min > meta.dose || meta.dose > meta.max) fail('Default dose must be within min/max');
    if (meta.order !== undefined && !Number.isFinite(meta.order)) fail('Invalid coffee.order');
    if (meta.temperatureF !== undefined && (!Number.isInteger(meta.temperatureF) || meta.temperatureF < 140 || meta.temperatureF > 212)) fail('Invalid coffee.temperatureF: use an integer from 140–212');
    const attribution = {};
    for (const key of ['author', 'source']) {
      if (metadata[key] === undefined) continue;
      if (typeof metadata[key] !== 'string' || !metadata[key].trim() || metadata[key].length > 2000 || /[\u0000-\u001f\u007f]/.test(metadata[key])) fail(`Invalid ${key} metadata`);
      attribution[key] = metadata[key].trim();
    }
    if (attribution.source) {
      let url;
      try { url = new URL(attribution.source); } catch { fail('Invalid source metadata: use an absolute http(s) URL'); }
      if (!/^https?:\/\//i.test(attribution.source) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Invalid source metadata: use an absolute http(s) URL without credentials');
    }
    for (const key of ['icon', 'description', 'legacyVariant']) if (meta[key] !== undefined && (typeof meta[key] !== 'string' || !meta[key].trim())) fail(`Invalid coffee.${key}`);

    const convert = item => {
      if (item.type === 'text') return { type: 'text', text: item.value };
      if (item.type === 'ingredient') {
        const ingredient = raw.ingredients[item.index];
        if (!['coffee', 'water', 'ice'].includes(ingredient.name) || ingredient.reference || ingredient.alias || ingredient.note) fail('Use plain coffee, water, or ice ingredients without references, aliases, or notes');
        return { type: 'ingredient', name: ingredient.name, amount: numeric(ingredient.quantity, ['g']), fixed: ingredient.quantity.scalable === false };
      }
      if (item.type === 'cookware') {
        const equipment = raw.cookware[item.index];
        if (equipment.quantity || equipment.note || equipment.alias) fail('Use unquantified cookware without aliases or notes');
        return { type: 'cookware', name: equipment.name };
      }
      if (item.type === 'timer') {
        const timer = raw.timers[item.index];
        const mode = timer.name || 'fixed';
        if (!['fixed', 'scaled', 'until'].includes(mode)) fail('Timer name must be fixed, scaled, or until');
        const seconds = numeric(timer.quantity, ['seconds', 'minutes']) * (timer.quantity.unit === 'minutes' ? 60 : 1);
        if (!Number.isInteger(seconds)) fail('Timers must resolve to whole seconds');
        return { type: 'timer', mode, seconds };
      }
      fail(`Unsupported Cooklang item: ${item.type}`);
    };
    const sections = raw.sections.map(section => {
      if (!section.name || section.content.length !== 1 || section.content[0].type !== 'step') fail('Each named section must contain exactly one instruction paragraph');
      return { title: section.name, items: section.content[0].value.items.map(convert) };
    });
    if (sections[0]?.title !== 'Prep' || sections.at(-1)?.title !== 'Finish') fail('First and last sections must be Prep and Finish');
    const prep = sections.shift().items, finish = sections.pop().items;
    if ([...prep, ...finish].some(item => item.type === 'timer') || finish.some(item => item.type === 'ingredient')) fail('Prep/Finish must be untimed; Finish must not add ingredients');
    if (prep.some(item => item.name === 'water')) fail('Put brewing water only in brewing steps; describe rinse water as plain text');
    if (prep.filter(item => item.type === 'ingredient' && item.name === 'ice').length > 1) fail('Combine brewing ice into one Prep quantity');
    const coffee = prep.filter(item => item.type === 'ingredient' && item.name === 'coffee');
    if (coffee.length !== 1 || coffee[0].amount !== meta.dose || coffee[0].fixed) fail('Prep must contain one scalable coffee quantity matching coffee.dose');
    let hasManualStep = false;
    const steps = sections.map(section => {
      const timers = section.items.filter(item => item.type === 'timer');
      if (timers.length > 1) fail(`"${section.title}" must have at most one timer`);
      if (!timers.length) hasManualStep = true;
      if (hasManualStep && timers[0]?.mode === 'until') fail('An until timer cannot follow a manual step; use a fixed or scaled duration');
      const ingredients = section.items.filter(item => item.type === 'ingredient');
      if (ingredients.some(item => item.name !== 'water') || ingredients.length > 1) fail('Brewing steps may contain at most one water quantity; put coffee and ice in Prep');
      return { ...section, timer: timers[0] ?? null };
    });
    const definition = { ...meta, ...attribution, temperatureF: meta.temperatureF ?? 203, order: meta.order ?? 100, prep, finish, steps,
      version: createHash('sha256').update(source).digest('hex') };
    // Validate every selectable dose, not just the default: scaled pours can
    // otherwise overrun an absolute timer mark at the edge of the dose range.
    for (let dose = Math.round(meta.min * 10); dose <= Math.round(meta.max * 10); dose++) createRecipe(definition, dose / 10);
    return definition;
  } catch (error) { throw new Error(`${filename}: ${error.message ?? error}`, { cause: error }); }
}

export async function loadRecipes(directory = new URL('../recipes/', import.meta.url)) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && file.name.endsWith('.cook'));
  const result = [];
  for (const file of files) {
    const path = directory instanceof URL ? new URL(file.name, directory) : join(directory, file.name);
    const definition = parseRecipe(await readFile(path, 'utf8'), file.name);
    if (result.some(item => item.id === definition.id)) fail(`${file.name}: duplicate recipe ID ${definition.id}`);
    if (definition.legacyVariant && result.some(item => item.brewer === definition.brewer && item.legacyVariant === definition.legacyVariant)) fail(`${file.name}: duplicate legacy brewer/variant`);
    if (result.some(item => item.brewer === definition.brewer && item.brewerName !== definition.brewerName)) fail(`${file.name}: inconsistent brewerName`);
    result.push(definition);
  }
  if (!result.length) fail('No .cook recipes found');
  return result.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export const recipes = await loadRecipes();
