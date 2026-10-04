import { resolveRecipe, createRecipe, currentStep, formatTime } from './recipe.js';
import { elapsed, startTimer, pauseTimer, resumeTimer, validTimer } from './timer.js';
import { readState, saveState } from './storage.js';
import { api, newId } from './api.js';
import { initService } from './service.js';
import { queueBrew, flushBrews, watchSync, acceptServerVersions } from './sync.js';

const $ = id => document.getElementById(id);
const setText = (id, value) => {
  // Avoid repeatedly announcing the same phase to screen readers on every tick.
  if ($(id).textContent !== value) $(id).textContent = value;
};
async function main() {
  const { recipes } = await api('/api/recipes');
  if (!Array.isArray(recipes) || !recipes.length) throw new Error('No recipes available.');
  const saved = readState();
  const brewers = [...new Map(recipes.map(item => [item.brewer, item])).keys()];
  const selectedByBrewer = {};
  for (const brewer of brewers) {
    const choices = recipes.filter(item => item.brewer === brewer);
    selectedByBrewer[brewer] = choices.some(item => item.id === saved.selectedByBrewer?.[brewer])
      ? saved.selectedByBrewer[brewer] : choices[0].id;
  }
  // Migrate the previous brewer/variant preferences without changing their doses.
  if (!saved.recipeId) {
    for (const device of brewers) {
      try {
        const old = resolveRecipe(recipes, { brewer: device, variant: device === 'v60' ? saved.v60Variant ?? 'hot' : 'hot' });
        selectedByBrewer[device] = old.id;
      } catch { /* A removed recipe falls back to the first available choice. */ }
    }
  }
  let brewer = brewers.includes(saved.brewer) ? saved.brewer : brewers[0];
  let recipeId = selectedByBrewer[brewer];
  const preferenceKey = () => recipeId;
  const doses = {}, notes = {};
  for (const definition of recipes) {
    const key = definition.id;
    const oldKey = definition.legacyVariant === 'hot' ? definition.brewer : definition.legacyVariant ? `${definition.brewer}:${definition.legacyVariant}` : null;
    try { doses[key] = createRecipe(definition, saved.doses?.[key] ?? saved.doses?.[oldKey]).dose; }
    catch { doses[key] = definition.dose; }
    const note = saved.notes?.[key] ?? saved.notes?.[oldKey];
    notes[key] = typeof note === 'string' ? note.slice(0, 80) : '';
  }
  let definition = resolveRecipe(recipes, { recipeId });
  let recipe = createRecipe(definition, doses[recipeId]);
  let timer = null;
  // Store the definition with active sessions so an edited file cannot change a
  // running timeline on reload. Old sessions still resolve by brewer/variant.
  if (validTimer(saved.session?.timer)) {
    try {
      const restored = saved.session.definition || resolveRecipe(recipes, saved.session);
      const restoredRecipe = createRecipe(restored, saved.session.dose);
      definition = restored;
      recipe = restoredRecipe;
      brewer = recipe.brewer;
      recipeId = definition.id;
      doses[recipeId] = recipe.dose;
      notes[recipeId] ??= typeof saved.notes?.[recipeId] === 'string' ? saved.notes[recipeId].slice(0, 80) : '';
      selectedByBrewer[brewer] = recipeId;
      timer = saved.session.timer;
    } catch { /* Fall back to the saved preferences. */ }
  }
  const brewerButtons = brewers.map(id => {
    const config = recipes.find(item => item.brewer === id);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.brewer = id;
    const icon = document.createElement('span');
    icon.className = 'brewer-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = config.icon || '▽';
    const name = document.createElement('strong');
    name.textContent = config.brewerName;
    const description = document.createElement('small');
    description.textContent = config.description || 'Guided brewing';
    button.append(icon, name, description);
    return button;
  });
  $('brewer-options').replaceChildren(...brewerButtons);
  let wakeLock = null;
  let wakePending = false;
  let service;
  let terminalSave = Promise.resolve();
  let brewId = timer && typeof saved.session?.brewId === 'string' ? saved.session.brewId : null;
  let sessionBagId = timer ? saved.session?.bagId || null : null;
  let temperatureF = Number.isInteger(saved.temperatureF) && saved.temperatureF >= 140 && saved.temperatureF <= 212 ? saved.temperatureF : 203;
  $('temperature-f').value = temperatureF;

  function message(value) {
    setText('service-message', value);
    $('service-message').hidden = !value;
  }

  function refreshService(method) {
    // Each service panel renders its own actionable error state.
    if (service) void service[method]().catch(() => {});
  }

  function navigate(page) {
    const selected = ['brew', 'beans', 'journal'].includes(page) ? page : 'brew';
    for (const name of ['brew', 'beans', 'journal']) $(name + '-page').hidden = name !== selected;
    document.querySelectorAll('[data-page]').forEach(link => {
      if (link.dataset.page === selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (location.hash !== '#' + selected) history.replaceState(null, '', '#' + selected);
    if (selected === 'journal') { refreshService('refreshJournal'); void refreshSummary(); }
    if (selected === 'beans') refreshService('refreshBags');
  }

  function renderBagHint() {
    const bag = service?.getBag($('brew-bag').value);
    setText('brew-bag-hint', bag ? [bag.tastingNotes,
      bag.remainingGrams == null ? null : `${Math.round(bag.remainingGrams)} g remaining`,
      bag.caffeineType !== 'regular' ? bag.caffeineType : null].filter(Boolean).join(' · ')
      : 'No bag selected. Your brew will still be saved in the journal.');
  }

  let summaryRequest = 0;
  async function refreshSummary() {
    const request = ++summaryRequest;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    try {
      const summary = await api(`/api/summary?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      if (request !== summaryRequest) return;
      const container = $('daily-summary');
      container.replaceChildren();
      const heading = document.createElement('p');
      heading.textContent = `${summary.brewsCompleted} completed brew${summary.brewsCompleted === 1 ? '' : 's'} today · ${Number(summary.totalDose).toFixed(1)} g of beans`;
      container.append(heading);
      if (!summary.servings.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'Log who had a cup in a brew’s results to see the household’s day here.';
        container.append(empty);
      }
      for (const serving of summary.servings) {
        const row = document.createElement('p');
        row.className = 'serving-summary';
        const person = document.createElement('strong');
        person.textContent = serving.person;
        const details = document.createElement('span');
        details.textContent = `${serving.count} serving${serving.count === 1 ? '' : 's'} · ${serving.volumeMl} mL · ${serving.knownCaffeineMg} mg recorded caffeine${serving.unknownCaffeineCount ? ` + ${serving.unknownCaffeineCount} unknown` : ''}`;
        row.append(person, details);
        container.append(row);
      }
    } catch {
      if (request !== summaryRequest) return;
      $('daily-summary').textContent = 'Daily totals are unavailable. Check your connection and refresh.';
    }
  }

  function persist() {
    $('storage-warning').hidden = saveState({ brewer, recipeId, selectedByBrewer, doses, notes, temperatureF,
      session: timer ? { brewer, recipeId, definition, dose: recipe.dose, timer, brewId, bagId: sessionBagId } : null });
  }

  async function syncWakeLock() {
    const needed = timer?.status === 'running' && document.visibilityState === 'visible';
    if (!needed) {
      if (wakeLock) await wakeLock.release().catch(() => {});
      wakeLock = null;
      setText('wake-message', 'Keep this page open while brewing.');
      return;
    }
    if (wakeLock || wakePending) return;
    if (!navigator.wakeLock) {
      setText('wake-message', 'Keep your screen awake. Automatic screen wake needs HTTPS and browser support.');
      return;
    }
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (timer?.status !== 'running' || document.visibilityState !== 'visible') {
        await lock.release();
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) {
          wakeLock = null;
          setText('wake-message', 'Screen wake released. Keep your screen awake while brewing.');
        }
      });
      setText('wake-message', 'Screen stays awake while you brew.');
    } catch {
      setText('wake-message', 'Screen wake unavailable. Keep your screen awake while brewing.');
    } finally { wakePending = false; }
  }

  function renderRecipe(syncDose = true) {
    if (syncDose) $('dose').value = recipe.dose;
    $('dose').min = recipe.min;
    $('dose').max = recipe.max;
    $('grind-note').value = notes[preferenceKey()];
    const choices = recipes.filter(item => item.brewer === brewer);
    $('variant-field').hidden = choices.length < 2;
    $('recipe-label').textContent = `${recipe.name} recipe`;
    $('recipe-variant').replaceChildren(...choices.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      return option;
    }));
    $('recipe-variant').value = recipeId;
    document.querySelectorAll('[data-brewer]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.brewer === brewer));
    });
    setText('dose-hint', `${recipe.min}–${recipe.max} g · for ${recipe.name} ${recipe.size}`);
    setText('water', `${recipe.water} g`);
    setText('water-label', recipe.ice ? 'HOT WATER' : 'WATER');
    setText('ratio-label', recipe.ice ? 'COMBINED RATIO' : 'RATIO');
    setText('ratio', `1 : ${recipe.ratio}`);
    $('ice-guide').hidden = !recipe.ice;
    setText('ice-guide', `${recipe.ice} g brewing ice + ${recipe.water} g hot water = ${recipe.totalWater} g combined. Add ice after discarding rinse water, then tare before pouring. Extra topping ice is not included.`);
    setText('temperature', `${temperatureF}°F`);
    setText('grind', notes[preferenceKey()] || recipe.grind);
    setText('texture', recipe.texture);
    setText('prep', recipe.prep);
    setText('duration', `About ${formatTime(recipe.duration)}`);
    $('timeline').replaceChildren(...recipe.steps.map(step => {
      const item = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'step-time';
      time.textContent = formatTime(step.start);
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = step.title;
      const detail = document.createElement('small');
      detail.textContent = step.pouring
        ? `Add ${step.added} g in ${step.end - step.start}s · ${step.rate.toFixed(1)} g/s`
        : `${step.end - step.start}s · no pouring`;
      body.append(title, detail);
      const target = document.createElement('span');
      target.className = 'step-target';
      target.textContent = step.pouring ? `to ${step.target} g` : '—';
      item.append(time, body, target);
      return item;
    }));
    renderTimer();
  }

  function renderTimer() {
    const seconds = timer ? elapsed(timer) / 1000 : 0;
    const index = currentStep(recipe, seconds);
    const finished = timer?.status === 'finished';
    const active = timer && !finished;
    const step = recipe.steps[index] || recipe.steps.at(-1);
    document.body.classList.toggle('brewing', Boolean(active));
    $('settings').disabled = Boolean(timer);
    $('start').hidden = Boolean(timer);
    $('active-controls').hidden = !active;
    $('reset').hidden = !timer;
    $('rate-brew').hidden = !finished || !brewId;
    setText('reset', finished ? 'Make another cup' : 'Discard & start over');
    setText('pause', timer?.status === 'paused' ? 'Resume' : 'Pause');
    setText('status', finished ? 'ENJOY' : timer?.status === 'paused' ? 'PAUSED' : timer ? 'BREWING' : 'READY');
    setText('clock', formatTime(seconds));
    $('progress').value = Math.min(100, seconds / recipe.duration * 100);
    setText('phase-label', !timer ? 'A MOMENT TO SLOW DOWN' : finished ? 'YOUR COFFEE, YOUR MOMENT' : `${recipe.name} · ${recipe.label} · ${recipe.dose} G COFFEE · ${recipe.water} G ${recipe.ice ? 'HOT ' : ''}WATER`);
    setText('timing', !timer ? `About ${formatTime(recipe.duration)} from first pour to last drip`
      : finished ? `Brew ended at ${formatTime(seconds)}`
      : index < 0 ? 'Target time reached · finish when your coffee is ready'
      : `${formatTime(Math.ceil(step.end - seconds))} left in this step${timer.status === 'paused' ? ' · timer paused' : ''}`);
    setText('instruction-title', finished ? 'Enjoy your coffee.' : !timer ? 'Ready when you are.' : index < 0 ? 'Complete the final step.' : step.title);
    setText('instruction', finished ? `${recipe.finishInstruction} Log a serving for each person who shared the brew.`
      : !timer ? 'Follow the preparation instructions, then start the timer as you begin the first step.'
      : index < 0 ? 'No more water. The timer will keep running until you tap Finish brew.' : step.instruction);
    setText('target-label', !timer ? 'FIRST SCALE TARGET' : finished ? recipe.ice ? 'HOT WATER POURED' : 'RECIPE WATER' : step.pouring && index >= 0 ? 'POUR TO · SCALE TARGET' : 'WATER ADDED · TARGET');
    setText('target', `${finished ? recipe.water : step.target} g`);
    setText('rate-label', finished ? 'COFFEE' : 'POUR RATE');
    setText('rate', finished ? `${recipe.dose} g` : step.pouring && index >= 0 ? `${step.rate.toFixed(1)} g/s` : 'No pour');
    [...$('timeline').children].forEach((item, i) => {
      const isCurrent = Boolean(active && i === index);
      item.classList.toggle('current', isCurrent);
      item.classList.toggle('complete', Boolean(timer && seconds >= recipe.steps[i].end));
      if (isCurrent) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function updateDose() {
    if (timer) return;
    try {
      const temperature = $('temperature-f').valueAsNumber;
      if (!Number.isInteger(temperature) || temperature < 140 || temperature > 212) {
        throw new Error('Enter a water temperature from 140–212°F in whole degrees.');
      }
      definition = resolveRecipe(recipes, { recipeId });
      recipe = createRecipe(definition, $('dose').valueAsNumber);
      temperatureF = temperature;
      doses[preferenceKey()] = recipe.dose;
      $('dose-error').hidden = true;
      $('dose').setAttribute('aria-invalid', 'false');
      $('start').disabled = false;
      renderRecipe(false);
      persist();
    } catch (error) {
      setText('dose-error', error instanceof RangeError ? `Enter ${definition.min}–${definition.max} g in 0.1 g increments.` : error.message);
      $('dose-error').hidden = false;
      $('dose').setAttribute('aria-invalid', 'true');
      $('start').disabled = true;
    }
  }

  document.querySelectorAll('[data-brewer]').forEach(button => {
    button.addEventListener('click', () => {
      if (timer) return;
      brewer = button.dataset.brewer;
      recipeId = selectedByBrewer[brewer];
      $('dose').value = doses[preferenceKey()];
      updateDose();
    });
  });
  $('recipe-variant').addEventListener('change', () => {
    if (timer) return;
    recipeId = $('recipe-variant').value;
    selectedByBrewer[brewer] = recipeId;
    $('dose').value = doses[preferenceKey()];
    updateDose();
  });
  $('dose').addEventListener('input', updateDose);
  $('temperature-f').addEventListener('input', updateDose);
  $('brew-bag').addEventListener('change', renderBagHint);
  for (const [id, delta] of [['less', -1], ['more', 1]]) {
    $(id).addEventListener('click', () => {
      $('dose').value = Math.round(Math.max(recipe.min, Math.min(recipe.max, ($('dose').valueAsNumber || recipe.dose) + delta)) * 10) / 10;
      updateDose();
    });
  }
  $('grind-note').addEventListener('input', () => {
    notes[preferenceKey()] = $('grind-note').value.trim().slice(0, 80);
    setText('grind', notes[preferenceKey()] || recipe.grind);
    persist();
  });
  $('start').addEventListener('click', () => {
    if (timer || $('start').disabled) return;
    brewId = newId();
    sessionBagId = $('brew-bag').value || null;
    timer = startTimer();
    void queueBrew('/api/brews', 'POST', {
      id: brewId, bagId: sessionBagId, recipeId, recipeVersion: definition.version, dose: recipe.dose,
      temperatureF, grindSetting: notes[preferenceKey()] || recipe.grind,
      startedAt: new Date(timer.startedAt).toISOString(),
    });
    persist();
    renderTimer();
    void syncWakeLock();
    $('brew-heading').scrollIntoView({ block: 'start' });
    $('pause').focus({ preventScroll: true });
  });
  $('pause').addEventListener('click', () => {
    timer = timer.status === 'running' ? pauseTimer(timer) : resumeTimer(timer);
    persist();
    renderTimer();
    void syncWakeLock();
  });
  $('finish').addEventListener('click', () => {
    if (elapsed(timer) / 1000 < recipe.steps.at(-1).start && !confirm('Finish before all scheduled pours are complete?')) return;
    timer = { ...pauseTimer(timer), status: 'finished' };
    if (brewId) terminalSave = queueBrew(`/api/brews/${brewId}`, 'PATCH', {
      status: 'completed', elapsedSeconds: Math.min(86400, Math.round(elapsed(timer) / 1000)), finishedAt: new Date().toISOString(),
    });
    persist();
    renderTimer();
    void syncWakeLock();
    $('reset').focus();
  });
  function clearSession() {
    timer = null;
    brewId = null;
    sessionBagId = null;
    // Return to the current catalog after a snapshot-backed session ends.
    if (!recipes.some(item => item.id === recipeId)) recipeId = recipes[0].id;
    definition = resolveRecipe(recipes, { recipeId });
    brewer = definition.brewer;
    selectedByBrewer[brewer] = recipeId;
    recipe = createRecipe(definition, doses[recipeId] >= definition.min && doses[recipeId] <= definition.max ? doses[recipeId] : definition.dose);
    persist();
    renderRecipe();
    void syncWakeLock();
  }

  $('reset').addEventListener('click', () => {
    if (timer.status !== 'finished' && !confirm('Discard this timer and start over?')) return;
    if (timer.status !== 'finished' && brewId) void queueBrew(`/api/brews/${brewId}`, 'PATCH', {
      status: 'discarded', elapsedSeconds: Math.min(86400, Math.round(elapsed(timer) / 1000)), finishedAt: new Date().toISOString(),
    });
    clearSession();
    $('dose').focus();
    refreshService('refreshBags');
  });
  $('rate-brew').addEventListener('click', async () => {
    const targetId = brewId;
    $('rate-brew').disabled = true;
    try {
      await terminalSave;
      if (await flushBrews()) {
        if (service && targetId) { navigate('journal'); await service.showResults(targetId); }
      } else message('This brew is queued on this device. Reconnect and retry sync before adding results.');
    } catch (error) { message(`Could not open results: ${error.message}`); }
    finally { $('rate-brew').disabled = false; }
  });
  $('retry-sync').addEventListener('click', () => { void flushBrews(); });
  $('resolve-sync').addEventListener('click', async () => {
    if (!confirm('A brew was already closed in the journal, possibly on another device. Keep the server’s saved result and remove the conflicting local update?')) return;
    const accepted = await acceptServerVersions();
    if (accepted.some(conflict => conflict.brewId === brewId)) {
      clearSession();
    }
    message('Kept the saved journal record. Other brew updates can continue syncing.');
  });
  $('refresh-summary').addEventListener('click', () => { void refreshSummary(); });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  document.querySelectorAll('[data-page]').forEach(link => link.addEventListener('click', () => navigate(link.dataset.page)));
  let previousPending = 0;
  watchSync(({ pending, syncing, error, durable, conflicts }) => {
    setText('sync-text', pending ? `${pending} brew update${pending === 1 ? '' : 's'} ${syncing ? 'syncing…' : 'waiting to sync'}${error && !syncing ? ` · ${error}` : ''}${!durable ? ' · keep this page open; browser storage is unavailable' : ''}`
      : 'Brew journal · automatically saved as you brew');
    $('sync-notice').classList.toggle('pending', pending > 0);
    $('retry-sync').hidden = pending === 0 || syncing;
    $('resolve-sync').hidden = conflicts.length === 0 || syncing;
    if (previousPending > 0 && pending === 0) {
      refreshService('refreshAll');
      void refreshSummary();
      message('Brew saved to your journal.');
    }
    previousPending = pending;
  });
  document.addEventListener('visibilitychange', () => {
    renderTimer();
    void syncWakeLock();
  });
  $('start').disabled = false;
  renderRecipe();
  persist();
  if (timer && !brewId) message('This timer predates journal tracking. Finish or discard it; your next brew will be recorded automatically.');
  void syncWakeLock();
  setInterval(() => { if (timer?.status === 'running') renderTimer(); }, 200);
  navigate(location.hash.slice(1));
  service = await initService({
    recipes,
    getActiveBrewId: () => timer && timer.status !== 'finished' ? brewId : null,
    onNavigate: navigate,
    onBagsChanged: renderBagHint,
    onServiceChange: refreshSummary,
    onBrewAgain: brew => {
      if (timer) {
        message('Finish or discard the current timer, then choose Make another cup before repeating a brew.');
        navigate('brew');
        return;
      }
      let repeated;
      try { repeated = resolveRecipe(recipes, { ...brew, recipeId: brew.recipeId ?? brew.recipe?.id }); }
      catch { message('That recipe is no longer available. Choose another recipe to brew.'); navigate('brew'); return; }
      definition = repeated;
      brewer = definition.brewer;
      recipeId = definition.id;
      selectedByBrewer[brewer] = recipeId;
      doses[preferenceKey()] = brew.dose;
      notes[preferenceKey()] = brew.grindSetting;
      temperatureF = brew.temperatureF;
      $('temperature-f').value = temperatureF;
      recipe = createRecipe(definition);
      renderRecipe();
      $('dose').value = brew.dose;
      updateDose();
      const bag = service.getBag(brew.bagId);
      service.setSelectedBag(bag && !bag.archived ? brew.bagId : null);
      renderBagHint();
      message(bag?.archived ? 'Recipe loaded. That bag is archived; choose an active bag before brewing.' : 'Recipe loaded. Tare your scale when you’re ready.');
      navigate('brew');
    },
  });
  if (timer) service.setSelectedBag(sessionBagId);
  renderBagHint();
  void flushBrews();

}

main().catch(error => {
  $('settings').disabled = true;
  $('start').disabled = true;
  setText('service-message', `Could not load recipes: ${error.message} Reload to try again.`);
  $('service-message').hidden = false;
});
