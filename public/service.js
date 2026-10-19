import { api } from './api.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const notice = () => {
  const element = node('p', '', 'notice');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  return element;
};
const button = (label, action, className = 'secondary') => {
  const element = node('button', label, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
};
const option = (value, label) => {
  const element = node('option', label);
  element.value = value;
  return element;
};
let nextField = 0;
function field(parent, label, name, value = '', type = 'text', choices) {
  const wrap = node('label', null, 'form-field');
  const labelText = node('span', label);
  labelText.id = `coffee-field-label-${++nextField}`;
  wrap.append(labelText);
  const input = node(choices ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  input.setAttribute('aria-labelledby', labelText.id);
  input.name = name;
  if (choices) choices.forEach(([key, text]) => input.append(option(key, text)));
  else if (type !== 'textarea') input.type = type;
  input.value = value ?? '';
  if (type === 'number') { input.min = '0'; input.step = 'any'; }
  wrap.append(input);
  parent.append(wrap);
  return input;
}
function starRating(parent, value) {
  const group = node('fieldset', null, 'star-rating');
  group.append(node('legend', 'Rating (optional)'));
  const stars = node('div', null, 'rating-stars');
  const summary = node('span', '', 'muted');
  const clear = button('Clear rating', () => {
    stars.querySelectorAll('input').forEach(input => { input.checked = false; });
    update();
    stars.querySelector('input').focus();
  });
  function update() {
    const selected = Number(stars.querySelector('input:checked')?.value) || 0;
    stars.querySelectorAll('label').forEach((label, index) => {
      const filled = index < selected;
      label.classList.toggle('is-filled', filled);
      label.querySelector('span').textContent = filled ? '★' : '☆';
    });
    summary.textContent = selected ? `${selected}/5` : 'Not rated';
    clear.disabled = !selected;
  }
  for (let score = 1; score <= 5; score++) {
    const label = node('label', null, 'rating-star');
    const input = node('input');
    input.type = 'radio';
    input.name = 'rating';
    input.value = String(score);
    input.checked = score === value;
    input.setAttribute('aria-label', `${score} ${score === 1 ? 'star' : 'stars'}`);
    input.addEventListener('change', update);
    const icon = node('span');
    icon.setAttribute('aria-hidden', 'true');
    label.append(input, icon);
    stars.append(label);
  }
  const row = node('div', null, 'rating-summary');
  row.append(summary, clear);
  group.append(stars, row);
  parent.append(group);
  update();
  return group;
}
const nullableNumber = input => input.value.trim() === '' ? null : Number(input.value);
const durationText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const localDateTime = iso => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const bagName = bag => [bag?.roaster, bag?.name].filter(Boolean).join(' · ') || 'Unlinked coffee';
const caffeineWarning = 'Caffeine varies by bean and brew. Decaf is not caffeine-free; unknown is not zero. Enter caffeine only when known—no estimate is inferred from grams. When breastfeeding, seek clinician guidance and count other caffeine sources.';

// Use the shared inventory estimate; unknown weights must not look like empty bags.
export function bagStockWarning(bag) {
  if (!bag || bag.archived || !Number.isFinite(bag.remainingGrams) || bag.remainingGrams > 80) return '';
  if (bag.remainingGrams <= 0) return `Bag empty: ${bagName(bag)} has no recorded coffee left. Open a replacement or check the recorded weight.`;
  const remaining = bag.remainingGrams < 1 ? 'less than 1 g' : `about ${Math.round(bag.remainingGrams * 10) / 10} g`;
  return `Running low: ${remaining} left in ${bagName(bag)}. Time to get a new bag.`;
}

async function resizePhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 30 * 1024 * 1024) throw new Error('Choose a photo smaller than 30 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('This image could not be read. Try JPEG or PNG.'));
      image.src = url;
    });
    const ratio = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo processing is unavailable in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Encoding a new canvas image strips the original metadata, including EXIF location.
    for (const quality of [0.85, 0.7, 0.5]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length * 0.75 <= 2 * 1024 * 1024) return dataUrl;
    }
    throw new Error('Photo is too large after resizing. Choose a smaller image.');
  } finally { URL.revokeObjectURL(url); }
}

export async function initService({ recipes = [], onBrewAgain = () => {}, onBrewDeleted = () => {}, onBagsChanged = () => {}, onServiceChange = () => {}, onNavigate = () => {}, getActiveBrewId = () => null } = {}) {
  const beansRoot = document.getElementById('beans-content');
  const journalRoot = document.getElementById('journal-content');
  const brewSelect = document.getElementById('brew-bag');
  let bags = [];
  let defaultBagId = null;
  let selectedBagId = brewSelect.value || null;
  let selectionInitialized = false;
  let bagRequest = 0;
  let journalRequest = 0;
  let brews = [];
  let total = 0;
  const beansMessage = notice();
  const journalMessage = notice();
  const beanEditor = node('div');
  const brewEditor = node('div');
  let editorBrewId = null;
  let editorRequest = 0;
  let editorState = null;
  function closeEditor(force = false) {
    if (!force && editorState?.saving) { journalMessage.textContent = 'Saving this brew. Please wait.'; return false; }
    if (!force && editorState?.dirty() && !window.confirm('Discard unsaved changes to this brew?')) return false;
    ++editorRequest;
    editorState = null;
    editorBrewId = null;
    brewEditor.replaceChildren();
    return true;
  }
  window.addEventListener('beforeunload', event => {
    if (editorState && (editorState.saving || editorState.dirty())) { event.preventDefault(); event.returnValue = ''; }
  });
  journalMessage.tabIndex = -1;
  const bagList = node('div', null, 'service-grid');
  const journalList = node('div', null, 'service-grid');
  const toolbar = node('div', null, 'service-toolbar');
  const archiveFilter = field(toolbar, 'Show bags', 'archiveFilter', 'active', 'text', [['active', 'Active'], ['archived', 'Archived'], ['all', 'All bags']]);
  toolbar.append(button('Add coffee bag', () => editBag(), 'primary'), button('Refresh bags', () => refreshBags().catch(() => {})));
  beansRoot.append(toolbar, beansMessage, beanEditor, bagList);
  archiveFilter.addEventListener('change', renderBags);
  brewSelect.addEventListener('change', () => { selectedBagId = brewSelect.value || null; selectionInitialized = true; notifyBags(); });

  async function mutate(path, options) {
    const result = await api(path, options);
    // Dashboard refresh must not make a committed write look like a failed save.
    Promise.resolve().then(() => onServiceChange()).catch(error => {
      const message = document.getElementById('service-message');
      if (message) message.textContent = `Saved, but summary refresh failed: ${error.message}`;
    });
    return result;
  }
  function notifyBags() { onBagsChanged({ bags: [...bags], defaultBagId, selectedBagId }); }
  function setSelectedBag(id) {
    selectedBagId = id || null;
    selectionInitialized = true;
    updateBrewSelect();
    notifyBags();
  }
  function updateBrewSelect() {
    brewSelect.replaceChildren(option('', 'No bag selected'));
    for (const bag of bags.filter(item => !item.archived || item.id === selectedBagId)) {
      brewSelect.append(option(bag.id, `${bagName(bag)}${bag.id === defaultBagId ? ' (default)' : ''}${bag.archived ? ' (archived)' : ''}`));
    }
    // Keep the current brew's selection even when its bag is missing from a refreshed library.
    if (selectedBagId && !bags.some(bag => bag.id === selectedBagId)) brewSelect.append(option(selectedBagId, 'Previously selected bag'));
    brewSelect.value = selectedBagId || '';
  }
  async function refreshBags({ preferDefault = false } = {}) {
    const request = ++bagRequest;
    try {
      const data = await api('/api/bags');
      if (request !== bagRequest) return;
      beansMessage.textContent = '';
      bags = data.bags;
      defaultBagId = data.defaultBagId;
      if (!brewSelect.matches(':disabled') && bags.some(bag => bag.id === selectedBagId && bag.archived)) selectedBagId = defaultBagId || null;
      if ((!selectionInitialized || preferDefault) && !brewSelect.matches(':disabled')) { selectedBagId = defaultBagId || null; selectionInitialized = true; }
      updateBrewSelect();
      updateJournalBagFilter();
      renderBags();
      notifyBags();
    } catch (error) { beansMessage.textContent = `Could not load bags: ${error.message}`; throw error; }
  }
  async function action(control, message, run) {
    if (control.disabled) return;
    control.disabled = true;
    message.textContent = '';
    try { await run(); }
    catch (error) { message.textContent = error.message; }
    finally { control.disabled = false; }
  }
  function renderBags() {
    bagList.replaceChildren();
    const visible = bags.filter(bag => archiveFilter.value === 'all' || Boolean(bag.archived) === (archiveFilter.value === 'archived'));
    if (!visible.length) bagList.append(node('p', 'No bags here yet. Add a bag to track your coffee.', 'empty-state'));
    for (const bag of visible) {
      const card = node('article', null, 'bean-card card');
      if (bag.hasPhoto || bag.photoUrl || bag.photo) {
        const image = node('img');
        image.src = `/api/bags/${encodeURIComponent(bag.id)}/photo?v=${encodeURIComponent(bag.updatedAt || '')}`;
        image.alt = `${bagName(bag)} coffee bag`;
        image.className = 'bean-photo';
        image.loading = 'lazy';
        card.append(image);
      }
      card.append(node('h3', bagName(bag)));
      if (bag.id === defaultBagId) card.append(node('span', 'Default', 'badge'));
      if (bag.archived) card.append(node('span', 'Archived', 'tag'));
      card.append(node('p', [bag.origin, bag.roastLevel, bag.process, bag.caffeineType].filter(Boolean).join(' · '), 'muted'));
      if (bag.tastingNotes) card.append(node('p', Array.isArray(bag.tastingNotes) ? bag.tastingNotes.join(', ') : bag.tastingNotes));
      card.append(node('p', `Roasted: ${bag.roastedOn || 'not recorded'} · Purchased: ${bag.purchasedOn || 'not recorded'}`, 'muted'));
      card.append(node('p', bag.remainingGrams == null ? 'Remaining weight unknown' : `${bag.remainingGrams} g remaining`));
      const stockWarning = bagStockWarning(bag);
      if (stockWarning) card.append(node('p', stockWarning, 'notice low-bag-warning'));
      if (bag.notes) card.append(node('p', bag.notes));
      const row = node('div', null, 'button-row');
      row.append(button('Edit bag', () => editBag(bag)));
      if (!bag.archived && bag.id !== defaultBagId) {
        const control = button('Make default', () => action(control, beansMessage, async () => {
          await mutate(`/api/bags/${encodeURIComponent(bag.id)}/default`, { method: 'POST', body: {} });
          await refreshBags({ preferDefault: true });
          beansMessage.textContent = 'Default bag updated.';
        }));
        row.append(control);
      }
      const archive = button(bag.archived ? 'Unarchive' : 'Archive', () => {
        if (!window.confirm(`${bag.archived ? 'Unarchive' : 'Archive'} ${bagName(bag)}? Existing journal entries are kept.`)) return;
        action(archive, beansMessage, async () => {
          await mutate(`/api/bags/${encodeURIComponent(bag.id)}`, { method: 'PATCH', body: { archived: !bag.archived } });
          await refreshBags();
        });
      });
      row.append(archive);
      card.append(row);
      bagList.append(card);
    }
  }
  function editBag(bag = null) {
    beanEditor.replaceChildren();
    const form = node('form', null, 'service-form card');
    form.append(node('h3', bag ? 'Edit coffee bag' : 'Add coffee bag'));
    const grid = node('div', null, 'form-grid');
    const inputs = {};
    for (const [key, label] of [['roaster', 'Roaster'], ['name', 'Coffee name'], ['origin', 'Origin'], ['process', 'Process'], ['variety', 'Variety'], ['roastLevel', 'Roast level'], ['tastingNotes', 'Tasting notes']]) {
      inputs[key] = field(grid, label, key, Array.isArray(bag?.[key]) ? bag[key].join(', ') : bag?.[key]);
      inputs[key].maxLength = key === 'tastingNotes' ? 5000 : 120;
    }
    inputs.roaster.required = true;
    inputs.name.required = true;
    inputs.caffeineType = field(grid, 'Caffeine type', 'caffeineType', bag?.caffeineType || 'regular', 'text', [['regular', 'Regular'], ['decaf', 'Decaf'], ['half-caf', 'Half-caf']]);
    for (const [key, label] of [['purchasedOn', 'Purchased on'], ['roastedOn', 'Roasted on'], ['openedOn', 'Opened on']]) inputs[key] = field(grid, label, key, bag?.[key], 'date');
    inputs.weightGrams = field(grid, 'Original bag weight (g, optional)', 'weightGrams', bag?.weightGrams, 'number');
    inputs.weightGrams.min = '0.01';
    inputs.weightGrams.max = '10000';
    inputs.price = field(grid, 'Price (optional)', 'price', bag?.price, 'number');
    inputs.price.max = '1000000';
    inputs.notes = field(grid, 'Notes', 'notes', bag?.notes, 'textarea');
    inputs.notes.maxLength = 5000;
    const photo = field(grid, 'Bag photo (optional; resized and metadata removed)', 'photo', '', 'file');
    photo.accept = 'image/*';
    const message = notice();
    const row = node('div', null, 'button-row');
    const save = node('button', 'Save bag', 'primary');
    save.type = 'submit';
    row.append(save, button('Cancel', () => beanEditor.replaceChildren()));
    if (bag?.hasPhoto || bag?.photoUrl || bag?.photo) {
      const remove = button('Remove photo', () => action(remove, message, async () => {
        if (!window.confirm('Remove this bag photo?')) return;
        await mutate(`/api/bags/${encodeURIComponent(bag.id)}/photo`, { method: 'DELETE', body: {} });
        remove.remove();
        message.textContent = 'Photo removed.';
        await refreshBags();
      }));
      row.append(remove);
    }
    form.append(grid, message, row);
    let savedBag = bag;
    form.addEventListener('submit', event => {
      event.preventDefault();
      action(save, message, async () => {
        const body = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
        body.weightGrams = nullableNumber(inputs.weightGrams);
        body.price = nullableNumber(inputs.price);
        for (const key of ['purchasedOn', 'roastedOn', 'openedOn']) body[key] ||= null;
        const saved = await mutate(savedBag ? `/api/bags/${encodeURIComponent(savedBag.id)}` : '/api/bags', { method: savedBag ? 'PATCH' : 'POST', body });
        const isNew = !savedBag;
        savedBag = saved;
        if (isNew && !brewSelect.matches(':disabled')) { selectedBagId = saved.id; selectionInitialized = true; }
        let photoError = null;
        if (photo.files[0]) {
          try { await mutate(`/api/bags/${encodeURIComponent(saved.id)}/photo`, { method: 'PUT', body: { dataUrl: await resizePhoto(photo.files[0]) } }); }
          catch (error) { photoError = error; }
        }
        try { await refreshBags({ preferDefault: isNew }); }
        catch (error) { message.textContent = `Bag saved, but the library could not refresh: ${error.message}`; return; }
        if (photoError) { message.textContent = `Bag saved, but photo upload failed: ${photoError.message}. You can retry Save bag without creating another bag.`; return; }
        beanEditor.replaceChildren();
        beansMessage.textContent = 'Bag saved.';
      });
    });
    beanEditor.append(form);
    inputs.roaster.focus();
  }

  const filters = node('div', null, 'service-toolbar');
  const filterBag = field(filters, 'Coffee bag', 'bagId', '', 'text', [['', 'All bags']]);
  const filterBrewer = field(filters, 'Brewer', 'brewer', '', 'text', [['', 'All brewers'], ...new Map(recipes.map(item => [item.brewer, item.brewerName])).entries()]);
  const filterStatus = field(filters, 'Status', 'status', '', 'text', [['', 'All statuses'], ['completed', 'Completed'], ['brewing', 'Brewing'], ['discarded', 'Discarded']]);
  const exportLink = node('a', 'Export all data', 'secondary');
  exportLink.href = '/api/export';
  exportLink.setAttribute('download', 'coffee-export.json');
  filters.append(button('Refresh journal', () => refreshJournal().catch(() => {})), exportLink);
  const stats = node('p', '', 'muted');
  const more = button('Load more', () => refreshJournal(true).catch(() => {}));
  journalRoot.append(filters, journalMessage, brewEditor, node('p', caffeineWarning, 'notice'), stats, journalList, more);
  for (const filter of [filterBag, filterBrewer, filterStatus]) filter.addEventListener('change', () => refreshJournal().catch(() => {}));
  function updateJournalBagFilter() {
    const current = filterBag.value;
    filterBag.replaceChildren(option('', 'All bags'));
    bags.forEach(bag => filterBag.append(option(bag.id, bagName(bag))));
    filterBag.value = current;
  }
  async function refreshJournal(append = false) {
    const request = ++journalRequest;
    more.disabled = true;
    journalMessage.textContent = '';
    try {
      const query = new URLSearchParams({ limit: '20', offset: String(append ? brews.length : 0) });
      for (const filter of [filterBag, filterBrewer, filterStatus]) if (filter.value) query.set(filter.name, filter.value);
      const data = await api(`/api/brews?${query}`);
      if (request !== journalRequest) return;
      brews = append ? [...brews, ...data.brews] : data.brews;
      total = data.total;
      renderJournal();
    } catch (error) {
      if (request === journalRequest) journalMessage.textContent = `Could not load journal: ${error.message}`;
      throw error;
    } finally { if (request === journalRequest) more.disabled = false; }
  }
  function renderJournal() {
    journalList.replaceChildren();
    const completed = brews.filter(brew => brew.status === 'completed');
    const rated = completed.filter(brew => brew.rating != null);
    stats.textContent = `Showing ${brews.length} of ${total} matching entries · ${completed.length} completed in shown entries${rated.length ? ` · average rating ${(rated.reduce((sum, brew) => sum + brew.rating, 0) / rated.length).toFixed(1)}/5 (${rated.length} rated)` : ''}. These are not daily or all-time totals.`;
    more.hidden = brews.length >= total;
    if (!brews.length) journalList.append(node('p', 'No brews match these filters.', 'empty-state'));
    for (const brew of brews) {
      const card = node('article', null, 'journal-card card');
      const snapshot = brew.bagSnapshot || brew.bag;
      card.append(node('h3', bagName(snapshot)), node('span', brew.status, 'badge'));
      const date = new Date(brew.startedAt || brew.createdAt);
      card.append(node('p', Number.isNaN(date.getTime()) ? 'Date not recorded' : date.toLocaleString(), 'muted'));
      const iced = (brew.ice ?? brew.recipe?.ice ?? 0) > 0;
      card.append(node('p', `${brew.recipe?.name ?? brew.brewer} · ${brew.recipe?.label ?? (iced ? 'Japanese Iced' : 'Hot')} · ${brew.dose} g coffee · ${brew.water} g ${iced ? 'hot ' : ''}water${brew.temperatureF != null ? ` · ${brew.temperatureF}°F` : ''}${brew.grindSetting != null ? ` · grind ${brew.grindSetting}` : ''}`));
      if (Number.isFinite(brew.ratio ?? brew.recipe?.ratio)) card.append(node('p', `Recipe ratio 1:${brew.ratio ?? brew.recipe.ratio}`, 'muted'));
      if (iced) card.append(node('p', `${brew.ice ?? brew.recipe.ice} g brewing ice · ${brew.totalWater ?? brew.recipe.totalWater} g combined water + ice, before topping ice`, 'muted'));
      if (snapshot?.caffeineType) card.append(node('p', snapshot.caffeineType, 'tag'));
      if (brew.elapsedSeconds != null) card.append(node('p', `${Math.floor(brew.elapsedSeconds / 60)}:${String(Math.floor(brew.elapsedSeconds % 60)).padStart(2, '0')} elapsed`, 'muted'));
      if (brew.rating || brew.taste) card.append(node('p', [brew.rating ? `${brew.rating}/5` : '', brew.taste].filter(Boolean).join(' · ')));
      if (brew.waterActual != null) card.append(node('p', `Actual ${iced ? 'hot ' : ''}water added: ${brew.waterActual} g`));
      if (brew.notes) card.append(node('p', brew.notes));
      for (const serving of brew.servings || []) card.append(node('p', `${serving.person}: ${serving.volumeMl ?? 'unknown'} ml · milk: ${serving.milk || 'none'} · caffeine: ${serving.caffeineMg == null ? 'unknown' : `${serving.caffeineMg} mg (entered)`}`, 'muted'));
      const row = node('div', null, 'button-row');
      const repeat = button('Brew again', () => action(repeat, journalMessage, () => onBrewAgain(brew)));
      if (['completed', 'discarded'].includes(brew.status)) row.append(button('Edit brew', () => editBrew(brew.id).catch(() => {}), 'primary'));
      row.append(repeat);
      if (brew.status === 'brewing') {
        const close = button('Close unfinished brew', () => {
          if (getActiveBrewId() === brew.id) {
            journalMessage.textContent = 'This timer is active on this device. Finish or discard it on the Brew tab.';
            return;
          }
          if (!window.confirm('Close this unfinished brew as discarded? This does not erase its record.')) return;
          action(close, journalMessage, async () => {
            await mutate(`/api/brews/${encodeURIComponent(brew.id)}`, { method: 'PATCH', body: { status: 'discarded' } });
            await Promise.all([refreshJournal(), refreshBags()]);
          });
        });
        row.append(close);
      }
      if (['completed', 'discarded'].includes(brew.status)) {
        const remove = button('Delete brew', () => {
          if (getActiveBrewId() === brew.id) {
            journalMessage.textContent = 'This timer is active on this device. Finish or discard it on the Brew tab.';
            return;
          }
          const inventory = brew.bagId ? ` Its ${brew.dose} g dose will be returned to the bag's inventory.` : '';
          if (!window.confirm(`Permanently delete this brew, its results, and its servings?${inventory} This cannot be undone. If you actually used the coffee, keep the discarded record instead.`)) return;
          action(remove, journalMessage, async () => {
            await mutate(`/api/brews/${encodeURIComponent(brew.id)}`, { method: 'DELETE', body: {} });
            ++journalRequest; // Ignore list responses started before the deletion.
            brews = brews.filter(item => item.id !== brew.id);
            total = Math.max(0, total - 1);
            if (editorBrewId === brew.id) closeEditor(true);
            renderJournal();
            await onBrewDeleted(brew.id);
            const results = await Promise.allSettled([refreshJournal(), refreshBags()]);
            journalMessage.textContent = results.some(result => result.status === 'rejected')
              ? 'Brew deleted, but some views could not refresh. Reload to see updated totals.'
              : 'Brew deleted. Its dose no longer counts toward bag usage or daily totals.';
            journalMessage.focus();
          });
        });
        row.append(remove);
      }
      card.append(row);
      journalList.append(card);
    }
  }

  async function editBrew(brewId) {
    if (getActiveBrewId() === brewId) {
      journalMessage.textContent = 'This timer is active on this device. Finish or discard it on the Brew tab.';
      return;
    }
    if (!closeEditor()) return;
    const request = ++editorRequest;
    editorBrewId = brewId;
    try {
      onNavigate('journal');
      journalMessage.textContent = 'Loading brew…';
      const [brew, library] = await Promise.all([api(`/api/brews/${encodeURIComponent(brewId)}`), api('/api/bags')]);
      if (request !== editorRequest) return;
      if (!['completed', 'discarded'].includes(brew.status)) throw new Error('Finish or discard this brew before editing it.');
      journalMessage.textContent = '';
      const form = node('form', null, 'service-form card brew-editor');
      const heading = node('h3', 'Edit brew');
      heading.tabIndex = -1;
      form.append(heading, node('p', `${bagName(brew.bagSnapshot)} · ${new Date(brew.startedAt).toLocaleString()} · ${brew.status}`, 'muted'));
      function section(title) {
        const group = node('fieldset', null, 'brew-edit-section');
        group.append(node('legend', title));
        const grid = node('div', null, 'form-grid');
        group.append(grid);
        form.append(group);
        return grid;
      }
      const coffee = section('Coffee');
      const bag = field(coffee, 'Coffee used', 'bagId', brew.bagId, 'text', [
        ['', 'No bag / unlinked coffee'],
        ...library.bags.map(item => [item.id, `${bagName(item)}${item.archived ? ' (archived)' : ''}`]),
      ]);
      const dose = field(coffee, 'Coffee dose (g)', 'dose', brew.dose, 'number');
      dose.min = String(brew.recipe?.min ?? 0.1);
      dose.max = String(brew.recipe?.max ?? 100);
      dose.step = '0.1';
      dose.required = true;
      coffee.append(node('p', 'Bag and dose corrections update inventory. Archived bags are available; no bag leaves usage unassigned. The default bag and entered caffeine amounts do not change.', 'hint wide'));
      const details = section('Brew details');
      details.append(node('p', `Recipe guide: ${brew.recipe?.name ?? brew.brewer} · ${brew.recipe?.label ?? 'Recipe'}. Corrections below do not rewrite its original water targets or step timings.`, 'hint wide'));
      const started = field(details, 'Started at (local time)', 'startedAt', localDateTime(brew.startedAt), 'datetime-local');
      const finished = field(details, 'Finished at (local time)', 'finishedAt', localDateTime(brew.finishedAt), 'datetime-local');
      for (const input of [started, finished]) { input.required = true; input.step = '1'; }
      const duration = field(details, 'Brew duration (minutes:seconds)', 'duration', durationText(brew.elapsedSeconds));
      duration.required = true;
      duration.pattern = '[0-9]{1,4}:[0-5][0-9]';
      duration.placeholder = '3:30';
      duration.title = 'Minutes and two-digit seconds, for example 3:30 (up to 24 hours)';
      details.append(node('p', 'Times use your device’s time zone. Duration excludes pauses; correcting it does not automatically change the start or finish time.', 'hint wide'));
      const temperature = field(details, 'Recorded temperature (°F)', 'temperatureF', brew.temperatureF, 'number');
      temperature.min = '140';
      temperature.max = '212';
      temperature.required = true;
      const grind = field(details, 'Recorded grind setting', 'grindSetting', brew.grindSetting);
      grind.required = true;
      grind.maxLength = 80;
      const water = field(details, (brew.ice ?? brew.recipe?.ice ?? 0) > 0 ? 'Actual hot water added (g, excludes ice, optional)' : 'Actual water added (g, optional)', 'waterActual', brew.waterActual, 'number');
      water.max = '2000';
      const results = section('Results');
      const rating = starRating(results, brew.rating);
      const taste = field(results, 'Taste (optional)', 'taste', brew.taste, 'text', [['', 'Not recorded'], ...['balanced', 'sour', 'bitter', 'weak', 'strong'].map(value => [value, value])]);
      const notes = field(results, 'Brew notes', 'notes', brew.notes, 'textarea');
      notes.maxLength = 10000;
      notes.parentElement.classList.add('wide');
      const cups = section('Servings');
      cups.append(node('p', 'Add your cup and optionally a partner’s cup. Leave unknown caffeine blank.', 'muted wide'));
      const servings = node('div', null, 'servings wide');
      const servingRows = [];
      function addServing(value = {}) {
        if (servingRows.length >= 10) return;
        const row = node('fieldset', null, 'serving-row form-grid');
        row.append(node('legend', 'Cup / serving'));
        const person = field(row, 'Person', 'person', value.person || (servingRows.length ? 'Partner' : 'You'));
        person.required = true;
        person.maxLength = 60;
        const volume = field(row, 'Cup volume (ml)', 'volumeMl', value.volumeMl, 'number');
        volume.required = true;
        volume.min = '0.01';
        volume.max = '2000';
        const milk = field(row, 'Milk', 'milk', value.milk || 'none', 'text', ['none', 'dairy', 'oat', 'other'].map(value => [value, value]));
        const caffeine = field(row, 'Known caffeine (mg, optional)', 'caffeineMg', value.caffeineMg, 'number');
        caffeine.max = '1000';
        const record = { row, person, volume, milk, caffeine };
        row.append(button('Remove serving', () => { servingRows.splice(servingRows.indexOf(record), 1); row.remove(); }));
        servingRows.push(record);
        servings.append(row);
      }
      for (const serving of brew.servings || []) addServing(serving);
      cups.append(servings, button('Add serving', () => addServing()), node('p', caffeineWarning, 'notice wide'));
      const message = notice();
      const row = node('div', null, 'button-row');
      const save = node('button', 'Save changes', 'primary');
      save.type = 'submit';
      const reload = button('Reload saved brew', () => editBrew(brewId).catch(() => {}));
      reload.hidden = true;
      row.append(save, button('Cancel', () => {
        if (closeEditor()) { journalMessage.textContent = 'Editor closed.'; journalMessage.focus(); }
      }), reload);
      form.append(message, row);
      function values() {
        const match = /^(\d{1,4}):([0-5]\d)$/.exec(duration.value);
        const seconds = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
        if (!Number.isFinite(seconds) || seconds > 86400) throw new Error('Enter duration as minutes:seconds, up to 1440:00.');
        return {
          bagId: bag.value || null, dose: nullableNumber(dose),
          startedAt: new Date(started.value).toISOString(), finishedAt: new Date(finished.value).toISOString(),
          elapsedSeconds: seconds, temperatureF: nullableNumber(temperature), grindSetting: grind.value.trim(),
          waterActual: nullableNumber(water), rating: Number(rating.querySelector('input:checked')?.value) || null,
          taste: taste.value || null, notes: notes.value.trim(),
          servings: servingRows.map(record => ({ person: record.person.value.trim(), volumeMl: nullableNumber(record.volume), milk: record.milk.value, caffeineMg: nullableNumber(record.caffeine) })),
        };
      }
      // Compare normalized initial values so untouched timestamps keep their milliseconds.
      const initial = values();
      const snapshot = () => JSON.stringify([...new FormData(form)]);
      const initialSnapshot = snapshot();
      const state = { saving: false, dirty: () => snapshot() !== initialSnapshot };
      editorState = state;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (state.saving) return;
        message.textContent = '';
        try {
          if (getActiveBrewId() === brewId) throw new Error('Finish or discard the active timer before editing this brew.');
          const current = values();
          const patch = Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(initial[key])));
          if (!Object.keys(patch).length) { closeEditor(true); return; }
          state.saving = true;
          const controls = [...form.elements].map(input => [input, input.disabled]);
          controls.forEach(([input]) => { input.disabled = true; });
          try {
            await mutate(`/api/brews/${encodeURIComponent(brewId)}/edit`, { method: 'PATCH', body: { expectedRevision: brew.revision ?? 0, ...patch } });
          } finally {
            controls.forEach(([input, disabled]) => { input.disabled = disabled; });
            state.saving = false;
          }
          if (editorState === state) closeEditor(true);
          const refreshed = await Promise.allSettled([refreshJournal(), refreshBags()]);
          journalMessage.textContent = refreshed.some(result => result.status === 'rejected')
            ? 'Brew saved, but some views could not refresh. Reload to see updated history and inventory.'
            : 'Brew changes saved. History, inventory, and totals are updated.';
          journalMessage.focus();
        } catch (error) {
          message.textContent = error.message;
          reload.hidden = error.status !== 409;
        }
      });
      brewEditor.append(form);
      heading.focus();
      form.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (request === editorRequest) journalMessage.textContent = `Could not open brew: ${error.message}`;
      throw error;
    }
  }
  async function refreshAll() {
    const results = await Promise.allSettled([refreshBags(), refreshJournal()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  // Render useful retryable UI even when the service is initially unavailable.
  await refreshAll().catch(() => {});
  return { refreshBags, refreshJournal, editBrew, get selectedBag() { return brewSelect.value || null; }, setSelectedBag, getBag: (id = selectedBagId) => bags.find(bag => bag.id === id) || null, refreshAll };
}
