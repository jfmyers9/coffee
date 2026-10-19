import { bagStockWarning } from './service.js';

export const NOTIFICATIONS_KEY = 'morning-coffee-stock-notifications-v1';

export function createBagNotifications({ platform = globalThis, onChange = () => {} } = {}) {
  let memory = { enabled: false, notified: [] };
  let bags = null, queue = Promise.resolve(), registrationPromise = null, error = '';
  const supported = Boolean(platform.isSecureContext && platform.Notification
    && typeof platform.Notification.requestPermission === 'function' && platform.navigator?.serviceWorker?.register);
  function read() {
    try {
      const saved = JSON.parse(platform.localStorage.getItem(NOTIFICATIONS_KEY));
      if (saved && typeof saved === 'object') return {
        enabled: saved.enabled === true,
        notified: Array.isArray(saved.notified) ? saved.notified.filter(id => typeof id === 'string') : [],
      };
    } catch { /* Keep the preference and deduplication in memory if storage is blocked. */ }
    return memory;
  }
  function write(state) {
    memory = state;
    try { platform.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(state)); }
    catch { /* The in-app warning and this session's notifications still work. */ }
  }
  async function registration() {
    if (!registrationPromise) {
      registrationPromise = (async () => {
        await platform.navigator.serviceWorker.register('/notifications-worker.js');
        const ready = await platform.navigator.serviceWorker.ready;
        if (typeof ready.showNotification !== 'function') throw new Error('Notifications unavailable');
        return ready;
      })().catch(cause => { registrationPromise = null; throw cause; });
    }
    return registrationPromise;
  }
  async function notify() {
    const lowIds = new Set(bags.filter(bag => bagStockWarning(bag)).map(bag => bag.id));
    const state = read();
    // A fresh high/unknown/archived/deleted bag ends its low-stock episode.
    const notified = state.notified.filter(id => lowIds.has(id));
    if (notified.length !== state.notified.length) write({ ...state, notified });
    if (!state.enabled || notifier.permission !== 'granted') { onChange(); return; }
    if (!bags.some(bag => lowIds.has(bag.id) && !notified.includes(bag.id))) return;
    const worker = await registration();
    // Inventory or the preference may have changed while the worker activated.
    for (const { id } of bags) {
      const bag = bags.find(item => item.id === id);
      const current = read();
      const body = bagStockWarning(bag);
      if (!current.enabled || notifier.permission !== 'granted') break;
      if (!body || current.notified.includes(bag.id)) continue;
      await worker.showNotification(bag.remainingGrams <= 0 ? 'Coffee bag empty' : 'Time to restock coffee', {
        body, tag: `low-coffee-${bag.id}`, icon: '/icon.svg',
      });
      const latest = read();
      write({ ...latest, notified: [...new Set([...latest.notified, bag.id])] });
    }
    error = '';
    onChange();
  }
  const notifier = {
    supported,
    get enabled() { return read().enabled; },
    get permission() { return supported ? platform.Notification.permission : 'unavailable'; },
    get error() { return error; },
    // Permission must be requested directly from a click, before worker activation.
    async enable() {
      if (!supported || notifier.permission === 'denied') return false;
      error = '';
      try {
        const permission = notifier.permission === 'granted' ? 'granted' : await platform.Notification.requestPermission();
        if (permission !== 'granted') { onChange(); return false; }
        await registration();
        write({ ...read(), enabled: true });
        onChange();
        await notifier.update();
        return true;
      } catch {
        error = 'Could not enable system notifications. Try again; in-app warnings still work.';
        onChange();
        return false;
      }
    },
    disable() { write({ ...read(), enabled: false }); error = ''; onChange(); },
    update(latestBags) {
      if (Array.isArray(latestBags)) bags = latestBags;
      if (!bags) return Promise.resolve();
      // Match outbox locking: serialize read/send/write across tabs where supported.
      const run = () => platform.navigator?.locks
        ? platform.navigator.locks.request(NOTIFICATIONS_KEY, notify) : notify();
      queue = queue.catch(() => {}).then(run).catch(() => {
        error = 'System notification could not be shown. In-app warnings still work; refresh bags to retry.';
        onChange();
      });
      return queue;
    },
  };
  return notifier;
}
