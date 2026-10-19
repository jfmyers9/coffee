import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhaseSound } from '../public/sound.js';

function mockAudio() {
  const calls = { created: 0, resumed: 0, started: [], stopped: [], gains: [], nodes: [] };
  class AudioContext extends EventTarget {
    state = 'suspended';
    currentTime = 10;
    destination = {};
    constructor() { super(); calls.created++; calls.context = this; }
    async resume() {
      calls.resumed++;
      if (calls.reject) throw new Error('Autoplay denied');
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
    }
    createGain() {
      const gain = { value: 1, events: [],
        setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); },
        linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); },
        exponentialRampToValueAtTime(value, time) { this.events.push(['exponential', value, time]); },
      };
      const node = { gain, connect() {}, disconnect() { this.disconnected = true; } };
      calls.gains.push(gain);
      calls.nodes.push(node);
      return node;
    }
    createOscillator() {
      const node = { frequency: { setValueAtTime() {} }, connect() {},
        disconnect() { this.disconnected = true; },
        start(time) { calls.started.push(time); }, stop(time) { calls.stopped.push(time); },
      };
      calls.oscillator = node;
      return node;
    }
  }
  return { calls, AudioContext };
}

test('audio is lazy, unlocked by a gesture, and plays a bounded chime with cleanup', async () => {
  const { calls, AudioContext } = mockAudio();
  const sound = createPhaseSound({ AudioContext });
  assert.equal(sound.supported, true);
  assert.equal(sound.ready, false);
  assert.equal(sound.play(), false);
  assert.equal(calls.created, 0);
  assert.equal(await sound.unlock(), true);
  assert.equal(calls.created, 1);
  assert.equal(calls.resumed, 1);
  assert.equal(sound.play(), true);
  assert.deepEqual(calls.started, [10]);
  assert.deepEqual(calls.stopped, [10.32]);
  assert.equal(calls.gains[0].value, 0.18);
  assert.ok(calls.gains[1].events.some(([type]) => type === 'exponential'));
  calls.oscillator.onended();
  assert.equal(calls.oscillator.disconnected, true);
  assert.equal(calls.nodes[1].disconnected, true);
  await sound.unlock();
  assert.equal(calls.created, 1);
  assert.equal(calls.resumed, 1);
});

test('muting silences the output immediately and never initializes disabled audio', async () => {
  const { calls, AudioContext } = mockAudio();
  const sound = createPhaseSound({ AudioContext, enabled: false });
  assert.equal(await sound.unlock(), false);
  assert.equal(sound.play(), false);
  assert.equal(calls.created, 0);
  sound.setEnabled(true);
  await sound.unlock();
  sound.play();
  sound.setEnabled(false);
  assert.equal(sound.ready, false);
  assert.equal(calls.gains[0].value, 0);
  assert.equal(sound.play(), false);
  assert.equal(calls.started.length, 1);
  sound.setEnabled(true);
  assert.equal(calls.gains[0].value, 0.18);
});

test('unsupported or blocked audio fails safely and can be retried from a gesture', async () => {
  const unsupported = createPhaseSound({ AudioContext: null });
  assert.equal(unsupported.supported, false);
  assert.equal(await unsupported.unlock(), false);
  assert.equal(unsupported.play(), false);
  const { calls, AudioContext } = mockAudio();
  let changes = 0;
  const sound = createPhaseSound({ AudioContext, onChange: () => { changes++; } });
  calls.reject = true;
  assert.equal(await sound.unlock(), false);
  assert.equal(sound.play(), false);
  calls.reject = false;
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.play(), true);
  assert.ok(changes > 0);
  calls.context.state = 'suspended';
  assert.equal(sound.play(), false);
  assert.equal(calls.resumed, 2); // Timer ticks must not resume suspended audio.
  assert.equal(await sound.unlock(), true);
  calls.context.state = 'closed';
  assert.equal(await sound.unlock(), true);
  assert.equal(calls.created, 2);
});

test('audio construction and playback errors cannot break the visual timer', async () => {
  const unavailable = createPhaseSound({ AudioContext: class { constructor() { throw new Error('Unavailable'); } } });
  assert.equal(await unavailable.unlock(), false);
  assert.equal(unavailable.play(), false);
  const { calls, AudioContext } = mockAudio();
  const sound = createPhaseSound({ AudioContext });
  await sound.unlock();
  calls.context.createOscillator = () => { throw new Error('Audio unavailable'); };
  assert.equal(sound.play(), false);
  assert.equal(sound.ready, false);
  calls.gains[0].setValueAtTime = () => { throw new Error('Context closed'); };
  assert.doesNotThrow(() => sound.setEnabled(false));
});
