import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsed, startTimer, pauseTimer, resumeTimer, validTimer } from '../public/timer.js';

test('timer accounts for background time without ticks', () => {
  const timer = startTimer(1000);
  assert.equal(elapsed(timer, 76000), 75000);
  assert.equal(elapsed(JSON.parse(JSON.stringify(timer)), 101000), 100000);
});

test('pause freezes elapsed and resume excludes paused time', () => {
  const paused = pauseTimer(startTimer(1000), 16000);
  assert.equal(elapsed(paused, 99000), 15000);
  const resumed = resumeTimer(paused, 99000);
  assert.equal(elapsed(resumed, 104000), 20000);
});

test('malformed timers cannot restore', () => {
  for (const value of [null, {}, { status: 'running', accumulated: 0 }, { status: 'paused', accumulated: -1 }, { status: 'running', accumulated: 0, startedAt: 'yesterday' }]) {
    assert.ok(!validTimer(value));
  }
  assert.ok(validTimer(startTimer(1000)));
  assert.ok(validTimer(pauseTimer(startTimer(1000), 2000)));
});
