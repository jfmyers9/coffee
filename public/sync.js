import { api, newId } from './api.js';

const KEY = 'morning-coffee-outbox-v1';
let memory = [];
let running = null;
let listener = () => {};
let lastError = '';
let durable = true;
let conflicts = [];

function readQueue() {
  if (!durable) return memory;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) return saved.filter(op => op && typeof op.id === 'string'
      && ['POST', 'PATCH'].includes(op.method) && /^\/api\/brews(?:\/[a-f0-9-]+)?$/.test(op.path)
      && op.body && typeof op.body === 'object');
  } catch { /* Storage may be disabled or damaged; keep the in-memory queue. */ }
  return memory;
}

function writeQueue(queue) {
  memory = queue;
  try { localStorage.setItem(KEY, JSON.stringify(queue)); durable = true; }
  catch { durable = false; }
}

function notify(event = {}) {
  listener({ ...event, pending: readQueue().length, syncing: Boolean(running), error: lastError, durable, conflicts: [...conflicts] });
}

function withQueueLock(operation) {
  // Serialize localStorage read-modify-write across tabs when Web Locks is available.
  return navigator.locks ? navigator.locks.request('morning-coffee-outbox', operation) : Promise.resolve().then(operation);
}

const brewIdFor = operation => operation.body.id || operation.path.split('/').at(-1);

// Only call after the server confirms deletion (DELETE success or HTTP 410).
// Drop all operations for this UUID, not just the first failed retry.
export async function forgetDeletedBrew(brewId) {
  await withQueueLock(() => writeQueue(readQueue().filter(operation => brewIdFor(operation) !== brewId)));
  conflicts = conflicts.filter(conflict => conflict.brewId !== brewId);
  notify({ deletedBrewId: brewId });
}

export function watchSync(callback) { listener = callback; notify(); }

export async function queueBrew(path, method, body) {
  await withQueueLock(() => {
    const queue = readQueue();
    queue.push({ id: newId(), path, method, body });
    writeQueue(queue);
  });
  notify();
  return flushBrews();
}

export function flushBrews() {
  if (running) return running;
  running = (async () => {
    const blocked = new Set();
    const attempted = new Set();
    conflicts = [];
    lastError = '';
    while (true) {
      const operation = readQueue().find(item => !attempted.has(item.id) && !blocked.has(brewIdFor(item)));
      if (!operation) break;
      const brew = brewIdFor(operation);
      attempted.add(operation.id);
      try {
        // Creates have a stable brew UUID. Replaying after a lost response is safe.
        await api(operation.path, { method: operation.method, body: operation.body });
        await withQueueLock(() => writeQueue(readQueue().filter(item => item.id !== operation.id)));
        notify();
      } catch (error) {
        if (error.status === 410) {
          await forgetDeletedBrew(brew);
          continue;
        }
        // A confirmed deletion may have removed an in-flight operation already.
        if (!readQueue().some(item => item.id === operation.id)) continue;
        lastError = error.message;
        blocked.add(brew);
        if (error.status === 409 && operation.method === 'PATCH' && operation.body.status) {
          try {
            const remote = await api(operation.path);
            if (['completed', 'discarded'].includes(remote.status)) conflicts.push({ operationId: operation.id, brewId: brew, status: remote.status });
          } catch { /* Keep the queued update; a retry can resolve the conflict. */ }
        }
      }
    }
    return readQueue().length === 0;
  })().finally(() => { running = null; notify(); });
  notify();
  return running;
}

export async function acceptServerVersions() {
  const accepted = [...conflicts];
  await withQueueLock(() => writeQueue(readQueue().filter(item => !accepted.some(conflict => conflict.operationId === item.id))));
  conflicts = [];
  lastError = '';
  notify();
  void flushBrews();
  return accepted;
}

window.addEventListener('online', () => { void flushBrews(); });
window.addEventListener('storage', event => { if (event.key === KEY) notify(); });
setInterval(() => { if (readQueue().length) void flushBrews(); }, 15000);
