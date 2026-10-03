// Persist timestamps, not ticks: background tab throttling must not slow a brew.
export function elapsed(timer, now = Date.now()) {
  return timer.accumulated + (timer.status === 'running' ? Math.max(0, now - timer.startedAt) : 0);
}

export function startTimer(now = Date.now()) {
  return { status: 'running', accumulated: 0, startedAt: now };
}

export function pauseTimer(timer, now = Date.now()) {
  return { status: 'paused', accumulated: elapsed(timer, now), startedAt: null };
}

export function resumeTimer(timer, now = Date.now()) {
  return { ...timer, status: 'running', startedAt: now };
}

export function validTimer(timer) {
  return timer && ['running', 'paused', 'finished'].includes(timer.status)
    && Number.isFinite(timer.accumulated) && timer.accumulated >= 0
    && (timer.status !== 'running' || (Number.isFinite(timer.startedAt) && timer.startedAt > 0));
}
