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
const nullableNumber = input => input.value.trim() === '' ? null : Number(input.value);
const bagName = bag => [bag?.roaster, bag?.name].filter(Boolean).join(' · ') || 'Unlinked coffee';
const caffeineWarning = 'Caffeine varies by bean and brew. Decaf is not caffeine-free; unknown is not zero. Enter caffeine only when known—no estimate is inferred from grams. When breastfeeding, seek clinician guidance and count other caffeine sources.';

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

export async function initService({ onBrewAgain = () => {}, onBagsChanged = () => {}, onServiceChange = () => {}, onNavigate = () => {}, getActiveBrewId = () => null } = {}) {
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
  const resultEditor = node('div');
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
  const filterBrewer = field(filters, 'Brewer', 'brewer', '', 'text', [['', 'All brewers'], ['v60', 'V60'], ['chemex', 'Chemex']]);
  const filterStatus = field(filters, 'Status', 'status', '', 'text', [['', 'All statuses'], ['completed', 'Completed'], ['brewing', 'Brewing'], ['discarded', 'Discarded']]);
  const exportLink = node('a', 'Export all data', 'secondary');
  exportLink.href = '/api/export';
  exportLink.setAttribute('download', 'coffee-export.json');
  filters.append(button('Refresh journal', () => refreshJournal().catch(() => {})), exportLink);
  const stats = node('p', '', 'muted');
  const more = button('Load more', () => refreshJournal(true).catch(() => {}));
  journalRoot.append(filters, journalMessage, resultEditor, node('p', caffeineWarning, 'notice'), stats, journalList, more);
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
      const iced = (brew.variant ?? brew.recipe?.variant) === 'japanese-iced';
      card.append(node('p', `${brew.brewer === 'v60' ? 'V60' : brew.brewer === 'chemex' ? 'Chemex' : brew.brewer} · ${iced ? 'Japanese Iced' : 'Hot'} · ${brew.dose} g coffee · ${brew.water} g ${iced ? 'hot ' : ''}water${brew.temperatureF != null ? ` · ${brew.temperatureF}°F` : ''}${brew.grindSetting != null ? ` · grind ${brew.grindSetting}` : ''}`));
      if (iced) card.append(node('p', `${brew.ice ?? brew.recipe.ice} g brewing ice · ${brew.totalWater ?? brew.recipe.totalWater} g combined water + ice, before topping ice`, 'muted'));
      if (snapshot?.caffeineType) card.append(node('p', snapshot.caffeineType, 'tag'));
      if (brew.elapsedSeconds != null) card.append(node('p', `${Math.floor(brew.elapsedSeconds / 60)}:${String(Math.floor(brew.elapsedSeconds % 60)).padStart(2, '0')} elapsed`, 'muted'));
      if (brew.rating || brew.taste) card.append(node('p', [brew.rating ? `${brew.rating}/5` : '', brew.taste].filter(Boolean).join(' · ')));
      if (brew.waterActual != null) card.append(node('p', `Actual ${iced ? 'hot ' : ''}water added: ${brew.waterActual} g`));
      if (brew.notes) card.append(node('p', brew.notes));
      for (const serving of brew.servings || []) card.append(node('p', `${serving.person}: ${serving.volumeMl ?? 'unknown'} ml · milk: ${serving.milk || 'none'} · caffeine: ${serving.caffeineMg == null ? 'unknown' : `${serving.caffeineMg} mg (entered)`}`, 'muted'));
      const row = node('div', null, 'button-row');
      const repeat = button('Brew again', () => action(repeat, journalMessage, () => onBrewAgain(brew)));
      row.append(repeat);
      if (brew.status === 'completed') row.append(button('Edit result', () => showResults(brew.id).catch(() => {})));
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
      card.append(row);
      journalList.append(card);
    }
  }

  async function showResults(brewId) {
    try {
      onNavigate('journal');
      const brew = await api(`/api/brews/${encodeURIComponent(brewId)}`);
      if (brew.status !== 'completed') throw new Error('Only completed brews can have a result edited.');
      resultEditor.replaceChildren();
      const form = node('form', null, 'service-form card');
      const heading = node('h3', 'How was your coffee?');
      heading.tabIndex = -1;
      form.append(heading);
      const grid = node('div', null, 'form-grid');
      const rating = field(grid, 'Rating (optional)', 'rating', brew.rating, 'text', [['', 'Not rated'], ...[1, 2, 3, 4, 5].map(value => [String(value), `${value}/5`])]);
      const taste = field(grid, 'Taste (optional)', 'taste', brew.taste, 'text', [['', 'Not recorded'], ...['balanced', 'sour', 'bitter', 'weak', 'strong'].map(value => [value, value])]);
      const water = field(grid, brew.variant === 'japanese-iced' ? 'Actual hot water added (g, excludes ice, optional)' : 'Actual water added (g, optional)', 'waterActual', brew.waterActual, 'number');
      water.max = '2000';
      const notes = field(grid, 'Brew notes', 'notes', brew.notes, 'textarea');
      notes.maxLength = 5000;
      const servings = node('div', null, 'servings');
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
      const message = notice();
      const row = node('div', null, 'button-row');
      const save = node('button', 'Save result', 'primary');
      save.type = 'submit';
      row.append(save, button('Cancel', () => resultEditor.replaceChildren()));
      form.append(grid, node('h3', 'Household cups'), node('p', 'Add your cup and optionally a partner’s cup. Leave unknown caffeine blank.', 'muted'), servings, button('Add serving', () => addServing()), node('p', caffeineWarning, 'notice'), message, row);
      form.addEventListener('submit', event => {
        event.preventDefault();
        action(save, message, async () => {
          await mutate(`/api/brews/${encodeURIComponent(brew.id)}`, { method: 'PATCH', body: {
            rating: nullableNumber(rating), taste: taste.value || null, waterActual: nullableNumber(water), notes: notes.value.trim(),
            servings: servingRows.map(record => ({ person: record.person.value.trim(), volumeMl: nullableNumber(record.volume), milk: record.milk.value, caffeineMg: nullableNumber(record.caffeine) })),
          } });
          resultEditor.replaceChildren();
          try { await refreshJournal(); }
          catch (error) { journalMessage.textContent = `Result saved, but journal refresh failed: ${error.message}`; return; }
          journalMessage.textContent = 'Brew result saved.';
        });
      });
      resultEditor.append(form);
      heading.focus();
      form.scrollIntoView({ block: 'nearest' });
    } catch (error) { journalMessage.textContent = `Could not open result: ${error.message}`; throw error; }
  }
  async function refreshAll() {
    const results = await Promise.allSettled([refreshBags(), refreshJournal()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  // Render useful retryable UI even when the service is initially unavailable.
  await refreshAll().catch(() => {});
  return { refreshBags, refreshJournal, showResults, get selectedBag() { return brewSelect.value || null; }, setSelectedBag, getBag: (id = selectedBagId) => bags.find(bag => bag.id === id) || null, refreshAll };
}
