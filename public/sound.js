// Synthesized locally: no audio download or notification permission is needed.
export function createPhaseSound({
  enabled = true,
  AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  onChange = () => {},
} = {}) {
  let context = null, output = null;
  let failed = false;
  const supported = typeof AudioContext === 'function';
  const sound = {
    get supported() { return supported; },
    get enabled() { return enabled; },
    get ready() { return Boolean(enabled && !failed && output && context?.state === 'running'); },
    setEnabled(value) {
      enabled = Boolean(value);
      try {
        if (output) output.gain.setValueAtTime(enabled ? 0.18 : 0, context.currentTime);
      } catch { failed = true; }
      onChange();
    },
    // Call from a click, not a timer tick: browsers require a user gesture.
    async unlock() {
      if (!enabled || !supported) return false;
      try {
        if (!context || !output || context.state === 'closed') {
          context = new AudioContext();
          const gain = context.createGain();
          gain.gain.value = enabled ? 0.18 : 0;
          gain.connect(context.destination);
          output = gain;
          context.addEventListener('statechange', onChange);
        }
        if (context.state !== 'running') await context.resume();
        failed = false;
      } catch {
        // Sound must never prevent starting or resuming a brew.
        failed = true;
      }
      onChange();
      return sound.ready;
    },
    play() {
      if (!sound.ready || !output) {
        if (enabled) onChange();
        return false;
      }
      try {
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(660, now);
        oscillator.frequency.setValueAtTime(880, now + 0.16);
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(1, now + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
        envelope.gain.setValueAtTime(0, now + 0.15);
        envelope.gain.linearRampToValueAtTime(1, now + 0.17);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
        oscillator.connect(envelope);
        envelope.connect(output);
        oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(now);
        oscillator.stop(now + 0.32);
        return true;
      } catch {
        failed = true;
        onChange();
        return false;
      }
    },
  };
  return sound;
}
