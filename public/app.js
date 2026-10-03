import { BREWERS, createRecipe, currentStep, formatTime } from './recipe.js';
import { elapsed, startTimer, pauseTimer, resumeTimer, validTimer } from './timer.js';
import { readState, saveState } from './storage.js';

const $ = id => document.getElementById(id);
const setText = (id, value) => {
  // Avoid repeatedly announcing the same phase to screen readers on every tick.
  if ($(id).textContent !== value) $(id).textContent = value;
};
const saved = readState();
let brewer = Object.hasOwn(BREWERS, saved.brewer) ? saved.brewer : 'v60';
const doses = {};
const notes = {};
for (const key of Object.keys(BREWERS)) {
  try { doses[key] = createRecipe(key, saved.doses?.[key]).dose; }
  catch { doses[key] = BREWERS[key].dose; }
  notes[key] = typeof saved.notes?.[key] === 'string' ? saved.notes[key].slice(0, 80) : '';
}
let recipe = createRecipe(brewer, doses[brewer]);
let timer = null;
// Restore only a complete, valid recipe/timer pair, never a partial session.
if (validTimer(saved.session?.timer)) {
  try {
    recipe = createRecipe(saved.session.brewer, saved.session.dose);
    brewer = recipe.brewer;
    doses[brewer] = recipe.dose;
    timer = saved.session.timer;
  } catch { /* Fall back to the saved preferences. */ }
}
let wakeLock = null;
let wakePending = false;

function persist() {
  $('storage-warning').hidden = saveState({ brewer, doses, notes,
    session: timer ? { brewer, dose: recipe.dose, timer } : null });
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
  $('grind-note').value = notes[brewer];
  document.querySelectorAll('[data-brewer]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.brewer === brewer));
  });
  setText('dose-hint', `${recipe.min}–${recipe.max} g · for ${recipe.name} ${recipe.size}`);
  setText('water', `${recipe.water} g`);
  setText('temperature', recipe.temperature);
  setText('grind', notes[brewer] || recipe.grind);
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
    target.textContent = step.pouring ? `to ${step.target} g` : 'Rest';
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
  setText('reset', finished ? 'Make another cup' : 'Discard & start over');
  setText('pause', timer?.status === 'paused' ? 'Resume' : 'Pause');
  setText('status', finished ? 'ENJOY' : timer?.status === 'paused' ? 'PAUSED' : timer ? 'BREWING' : 'READY');
  setText('clock', formatTime(seconds));
  $('progress').value = Math.min(100, seconds / recipe.duration * 100);
  setText('phase-label', !timer ? 'A MOMENT TO SLOW DOWN' : finished ? 'YOUR COFFEE, YOUR MOMENT' : `${recipe.name} · ${recipe.dose} G COFFEE · ${recipe.water} G WATER`);
  setText('timing', !timer ? `About ${formatTime(recipe.duration)} from first pour to last drip`
    : finished ? `Brew ended at ${formatTime(seconds)}`
    : index < 0 ? 'Target time reached · finish when the bed has drained'
    : `${formatTime(Math.ceil(step.end - seconds))} left in this step${timer.status === 'paused' ? ' · timer paused' : ''}`);
  setText('instruction-title', finished ? 'Enjoy your coffee.' : !timer ? 'Ready when you are.' : index < 0 ? 'Let the last drops fall.' : step.title);
  setText('instruction', finished ? 'Swirl your coffee, pour a cup, and take a moment.'
    : !timer ? 'Tare your scale. Start the timer as you begin the bloom pour.'
    : index < 0 ? 'No more water. The timer will keep running until you tap Finish brew.' : step.instruction);
  setText('target-label', !timer ? 'FIRST SCALE TARGET' : finished ? 'RECIPE WATER' : step.pouring && index >= 0 ? 'POUR TO · SCALE TARGET' : 'WATER ADDED · TARGET');
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
    recipe = createRecipe(brewer, $('dose').valueAsNumber);
    doses[brewer] = recipe.dose;
    $('dose-error').hidden = true;
    $('dose').setAttribute('aria-invalid', 'false');
    $('start').disabled = false;
    renderRecipe(false);
    persist();
  } catch {
    setText('dose-error', `Enter ${BREWERS[brewer].min}–${BREWERS[brewer].max} g in 0.1 g increments.`);
    $('dose-error').hidden = false;
    $('dose').setAttribute('aria-invalid', 'true');
    $('start').disabled = true;
  }
}

document.querySelectorAll('[data-brewer]').forEach(button => {
  button.addEventListener('click', () => {
    if (timer) return;
    brewer = button.dataset.brewer;
    $('dose').value = doses[brewer];
    updateDose();
  });
});
$('dose').addEventListener('input', updateDose);
for (const [id, delta] of [['less', -1], ['more', 1]]) {
  $(id).addEventListener('click', () => {
    $('dose').value = Math.round(Math.max(recipe.min, Math.min(recipe.max, ($('dose').valueAsNumber || recipe.dose) + delta)) * 10) / 10;
    updateDose();
  });
}
$('grind-note').addEventListener('input', () => {
  notes[brewer] = $('grind-note').value.trim().slice(0, 80);
  setText('grind', notes[brewer] || recipe.grind);
  persist();
});
$('start').addEventListener('click', () => {
  if (timer || $('start').disabled) return;
  timer = startTimer();
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
  persist();
  renderTimer();
  void syncWakeLock();
  $('reset').focus();
});
$('reset').addEventListener('click', () => {
  if (timer.status !== 'finished' && !confirm('Discard this timer and start over?')) return;
  timer = null;
  persist();
  renderTimer();
  void syncWakeLock();
  $('dose').focus();
});
document.addEventListener('visibilitychange', () => {
  renderTimer();
  void syncWakeLock();
});
renderRecipe();
persist();
void syncWakeLock();
setInterval(() => { if (timer?.status === 'running') renderTimer(); }, 200);
