/**
 * Phase 15: every sound of the game, synthesised into sample arrays ONCE when audio unlocks (no asset to fetch or
 * decode, nothing rendered on a frame). Pure and deterministic: a sound is a function of the sample rate only (the
 * noise is a fixed-seed xorshift), so tests can pin a sound by its hash and the game never sounds different twice.
 *
 * Short cues are small envelopes over sines, squares and noise in a friendly major-pentatonic palette; the beds
 * (crowd murmur, ride machinery, rain, crickets at night) and the music are seamless loops (their length is a whole
 * number of cycles of every component, and the noise beds are cross-faded at the seam).
 */

export type SynthSoundId =
  | 'coin' | 'spend' | 'build' | 'chime' | 'clank' | 'ratchet' | 'happy' | 'unhappy' | 'sale'
  | 'fanfare' | 'research' | 'fail' | 'click' | 'splash' | 'notify' | 'error' | 'whoosh' | 'brake' | 'bell';
/** Cues that exist only as recorded files (public/sfx/): without the file they are not heard. */
export type RecordedSoundId =
  | 'launch' | 'boost' | 'scream' | 'crash' | 'puff' | 'flush' | 'splash-big' | 'splash-small' | 'thunder-near' | 'thunder-far';
export type SoundId = SynthSoundId | RecordedSoundId;
export type LoopId = 'music' | 'crowd' | 'machinery' | 'rain' | 'night';

export const SOUND_IDS: readonly SynthSoundId[] = [
  'coin', 'spend', 'build', 'chime', 'clank', 'ratchet', 'happy', 'unhappy', 'sale', 'fanfare', 'research', 'fail', 'click',
  'splash', 'notify', 'error', 'whoosh', 'brake', 'bell',
];
export const LOOP_IDS: readonly LoopId[] = ['music', 'crowd', 'machinery', 'rain', 'night'];

const TAU = Math.PI * 2;

/** A fixed-seed noise source in [-1, 1). */
const noiseSource = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x8000_0000 - 1;
  };
};

/** Attack / decay envelope: linear rise over `attack` seconds, exponential fall with time constant `decay`. */
const envelope = (t: number, attack: number, decay: number): number => (
  t < attack ? t / attack : Math.exp(-(t - attack) / decay)
);

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);

interface Tone {
  readonly at: number;
  readonly note: number;
  readonly length: number;
  readonly wave?: 'sine' | 'square' | 'triangle';
  readonly gain?: number;
  readonly decay?: number;
  /** Pitch glide in semitones over the tone. */
  readonly glide?: number;
}

const wave = (kind: Tone['wave'], phase: number): number => {
  const p = phase - Math.floor(phase);
  if (kind === 'square') return p < 0.5 ? 0.6 : -0.6;
  if (kind === 'triangle') return 4 * Math.abs(p - 0.5) - 1;
  return Math.sin(TAU * p);
};

/** Renders a list of tones into a buffer of `seconds`. */
const tones = (rate: number, seconds: number, list: readonly Tone[], master = 0.5): Float32Array => {
  const out = new Float32Array(Math.ceil(rate * seconds));
  for (const tone of list) {
    const start = Math.floor(tone.at * rate);
    const count = Math.min(out.length - start, Math.ceil(tone.length * rate));
    let phase = 0;
    for (let i = 0; i < count; i += 1) {
      const t = i / rate;
      const glide = tone.glide ? tone.glide * (t / tone.length) : 0;
      phase += midi(tone.note + glide) / rate;
      out[start + i] += wave(tone.wave, phase) * envelope(t, 0.004, tone.decay ?? tone.length / 3) * (tone.gain ?? 1) * master;
    }
  }
  return out;
};

/** Filtered noise burst (one-pole low-pass at `cutoff` Hz). */
const noiseBurst = (rate: number, seconds: number, cutoff: number, decay: number, gain: number, seed: number): Float32Array => {
  const out = new Float32Array(Math.ceil(rate * seconds));
  const next = noiseSource(seed);
  const alpha = 1 - Math.exp((-TAU * cutoff) / rate);
  let low = 0;
  for (let i = 0; i < out.length; i += 1) {
    low += alpha * (next() - low);
    out[i] = low * envelope(i / rate, 0.002, decay) * gain;
  }
  return out;
};

const mix = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(Math.max(...parts.map((part) => part.length)));
  for (const part of parts) for (let i = 0; i < part.length; i += 1) out[i] += part[i];
  return out;
};

/** Soft-clips into [-1, 1] so a stacked cue can never wrap. */
const finish = (samples: Float32Array): Float32Array => {
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.tanh(samples[i]);
  return samples;
};

/** One short cue, rendered at `rate` samples a second. */
export const renderSound = (id: SynthSoundId, rate: number): Float32Array => {
  switch (id) {
    case 'coin': return finish(tones(rate, 0.35, [{ at: 0, note: 88, length: 0.08, wave: 'square', gain: 0.5 }, { at: 0.07, note: 93, length: 0.26, wave: 'square', gain: 0.5 }], 0.35));
    case 'sale': return finish(tones(rate, 0.25, [{ at: 0, note: 84, length: 0.2, wave: 'triangle', decay: 0.06 }], 0.35));
    case 'spend': return finish(mix(tones(rate, 0.3, [{ at: 0, note: 60, length: 0.25, wave: 'triangle', glide: -5, decay: 0.08 }], 0.5), noiseBurst(rate, 0.12, 1800, 0.03, 0.25, 7)));
    case 'build': return finish(mix(noiseBurst(rate, 0.45, 600, 0.09, 0.9, 11), tones(rate, 0.3, [{ at: 0, note: 43, length: 0.25, decay: 0.07 }], 0.6), noiseBurst(rate, 0.3, 3500, 0.04, 0.2, 13)));
    case 'chime': return finish(tones(rate, 0.9, [{ at: 0, note: 79, length: 0.8, decay: 0.25 }, { at: 0.09, note: 84, length: 0.7, decay: 0.25 }, { at: 0.18, note: 88, length: 0.6, decay: 0.25 }], 0.25));
    case 'clank': return finish(mix(noiseBurst(rate, 0.5, 2500, 0.06, 0.7, 17), tones(rate, 0.5, [{ at: 0, note: 70, length: 0.45, wave: 'square', decay: 0.05, gain: 0.5 }, { at: 0.12, note: 63, length: 0.35, wave: 'square', decay: 0.05, gain: 0.5 }], 0.4)));
    case 'ratchet': {
      const parts: Float32Array[] = [];
      for (let click = 0; click < 4; click += 1) {
        const burst = noiseBurst(rate, 0.08, 4000, 0.01, 0.6, 19 + click);
        const shifted = new Float32Array(Math.ceil(rate * 0.4));
        shifted.set(burst.subarray(0, Math.min(burst.length, shifted.length - Math.floor(click * 0.07 * rate))), Math.floor(click * 0.07 * rate));
        parts.push(shifted);
      }
      return finish(mix(...parts, tones(rate, 0.4, [{ at: 0.28, note: 76, length: 0.1, decay: 0.04 }], 0.3)));
    }
    case 'happy': return finish(tones(rate, 0.3, [{ at: 0, note: 72, length: 0.25, wave: 'sine', glide: 7, decay: 0.08 }], 0.35));
    case 'unhappy': return finish(tones(rate, 0.35, [{ at: 0, note: 67, length: 0.3, wave: 'triangle', glide: -4, decay: 0.1 }], 0.35));
    case 'fanfare': return finish(tones(rate, 1.4, [
      { at: 0, note: 72, length: 0.18, wave: 'square', gain: 0.45 }, { at: 0.16, note: 76, length: 0.18, wave: 'square', gain: 0.45 },
      { at: 0.32, note: 79, length: 0.18, wave: 'square', gain: 0.45 }, { at: 0.48, note: 84, length: 0.9, wave: 'square', gain: 0.45, decay: 0.4 },
      { at: 0.48, note: 72, length: 0.9, wave: 'triangle', decay: 0.4 },
    ], 0.3));
    case 'research': return finish(tones(rate, 0.9, [
      { at: 0, note: 76, length: 0.3, decay: 0.12 }, { at: 0.1, note: 81, length: 0.3, decay: 0.12 }, { at: 0.2, note: 88, length: 0.6, decay: 0.25 },
    ], 0.3));
    case 'fail': return finish(tones(rate, 1.1, [
      { at: 0, note: 67, length: 0.3, wave: 'triangle' }, { at: 0.25, note: 63, length: 0.3, wave: 'triangle' }, { at: 0.5, note: 60, length: 0.6, wave: 'triangle', decay: 0.3 },
    ], 0.35));
    case 'click': return finish(noiseBurst(rate, 0.03, 5000, 0.006, 0.5, 23));
    case 'splash': return finish(mix(noiseBurst(rate, 0.5, 1200, 0.12, 0.8, 37), tones(rate, 0.3, [{ at: 0.02, note: 72, length: 0.2, glide: 12, decay: 0.05 }], 0.25)));
    case 'notify': return finish(tones(rate, 0.6, [{ at: 0, note: 81, length: 0.3, decay: 0.1 }, { at: 0.12, note: 88, length: 0.45, decay: 0.18 }], 0.3));
    case 'error': return finish(tones(rate, 0.35, [{ at: 0, note: 50, length: 0.12, wave: 'square', gain: 0.5 }, { at: 0.14, note: 50, length: 0.18, wave: 'square', gain: 0.5 }], 0.35));
    case 'whoosh': return finish(sweptNoise(rate, 1.1, 41));
    case 'brake': return finish(mix(
      noiseBurst(rate, 0.8, 7000, 0.3, 0.5, 43),
      negate(noiseBurst(rate, 0.8, 900, 0.3, 0.5, 43)),
      tones(rate, 0.8, [{ at: 0.02, note: 96, length: 0.6, glide: -2, decay: 0.2, gain: 0.25 }], 0.3),
    ));
    case 'bell': return finish(tones(rate, 0.9, [
      { at: 0, note: 88, length: 0.4, decay: 0.12 }, { at: 0, note: 95, length: 0.3, decay: 0.08, gain: 0.4 },
      { at: 0.2, note: 88, length: 0.7, decay: 0.2 }, { at: 0.2, note: 95, length: 0.5, decay: 0.1, gain: 0.4 },
    ], 0.3));
  }
};

const negate = (samples: Float32Array): Float32Array => samples.map((value) => -value);

/** A rush of air: noise whose low-pass opens and closes over `seconds`, swelling to the middle (a train over a crest). */
const sweptNoise = (rate: number, seconds: number, seed: number): Float32Array => {
  const out = new Float32Array(Math.ceil(rate * seconds));
  const next = noiseSource(seed);
  let low = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / out.length;
    const swell = Math.sin(Math.PI * t) ** 2;
    const alpha = 1 - Math.exp((-TAU * (300 + 2_400 * swell)) / rate);
    low += alpha * (next() - low);
    out[i] = low * swell * 1.6;
  }
  return out;
};

/** Cross-fades the last `fade` samples into the first, so a looped noise bed has no seam. */
const seamless = (samples: Float32Array, fade: number): Float32Array => {
  const out = samples.slice(0, samples.length - fade);
  for (let i = 0; i < fade; i += 1) {
    const w = i / fade;
    out[i] = out[i] * w + samples[samples.length - fade + i] * (1 - w);
  }
  return out;
};

/** One loop, rendered at `rate`. */
export const renderLoop = (id: LoopId, rate: number): Float32Array => {
  if (id === 'crowd') {
    // A murmur: band-limited noise with a slow, uneven swell (two incommensurate wobbles).
    const seconds = 6;
    const raw = new Float32Array(Math.ceil(rate * seconds) + Math.floor(rate * 0.5));
    const next = noiseSource(29);
    const lowA = 1 - Math.exp((-TAU * 900) / rate);
    const lowB = 1 - Math.exp((-TAU * 250) / rate);
    let a = 0;
    let b = 0;
    for (let i = 0; i < raw.length; i += 1) {
      a += lowA * (next() - a);
      b += lowB * (a - b);
      const t = i / rate;
      raw[i] = (a - b) * 0.9 * (0.75 + 0.15 * Math.sin(TAU * t / 2.7) + 0.1 * Math.sin(TAU * t / 1.3));
    }
    return seamless(raw, Math.floor(rate * 0.5));
  }
  if (id === 'rain') {
    // Rain: a hiss of high noise (the low part taken out) with a sprinkle of drops (4 s, cross-faded at the seam).
    const raw = new Float32Array(Math.ceil(rate * 4) + Math.floor(rate * 0.5));
    const next = noiseSource(47);
    const highA = 1 - Math.exp((-TAU * 6_000) / rate);
    const lowB = 1 - Math.exp((-TAU * 500) / rate);
    let a = 0;
    let b = 0;
    let drop = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const n = next();
      a += highA * (n - a);
      b += lowB * (a - b);
      if (n > 0.9993) drop = 0.5;
      drop *= 0.995;
      raw[i] = (a - b) * 0.8 + drop * Math.sin(TAU * 2_200 * (i / rate));
    }
    return finish(seamless(raw, Math.floor(rate * 0.5)));
  }
  if (id === 'night') {
    // Crickets: two of them chirping three quick pulses of a high sine, out of step (4 s, whole cycles of each).
    const seconds = 4;
    const out = new Float32Array(Math.round(rate * seconds));
    const crickets = [{ note: 4_400, every: 0.8, offset: 0, gain: 0.18 }, { note: 4_000, every: 1, offset: 0.37, gain: 0.12 }];
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      for (const cricket of crickets) {
        const into = (t - cricket.offset + seconds) % cricket.every;
        const pulse = Math.floor(into / 0.045);
        if (pulse > 2) continue;
        const within = (into - pulse * 0.045) / 0.03;
        if (within > 1) continue;
        out[i] += Math.sin(TAU * cricket.note * t) * Math.sin(Math.PI * within) * cricket.gain;
      }
    }
    return out;
  }
  if (id === 'machinery') {
    // A low, regular hum with a soft clatter every half second (2 s, whole cycles of 55 Hz and 110 Hz).
    const seconds = 2;
    const out = new Float32Array(Math.round(rate * seconds));
    const clatter = noiseBurst(rate, 0.12, 1400, 0.03, 0.25, 31);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      out[i] = 0.22 * Math.sin(TAU * 55 * t) + 0.1 * Math.sin(TAU * 110 * t) * (0.7 + 0.3 * Math.sin(TAU * t * 2));
    }
    for (let beat = 0; beat < 4; beat += 1) {
      const start = Math.floor(beat * 0.5 * rate);
      for (let i = 0; i < clatter.length && start + i < out.length; i += 1) out[start + i] += clatter[i];
    }
    return finish(out);
  }
  // Music: a calm 16-bar loop at 96 bpm in C major pentatonic, a soft triangle melody over sine pads (40 s).
  const beat = 60 / 96;
  const bars = 16;
  const seconds = bars * 4 * beat;
  const chords = [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]];
  const melody = [76, 74, 72, 74, 76, 79, 76, 74, 72, 69, 72, 74, 72, 69, 67, 69];
  const list: Tone[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const chord = chords[bar % chords.length];
    for (const note of chord) list.push({ at: bar * 4 * beat, note, length: 4 * beat, wave: 'sine', gain: 0.22, decay: 3 * beat });
    for (let step = 0; step < 4; step += 1) {
      if ((bar + step) % 3 === 2) continue;
      const note = melody[(bar * 4 + step) % melody.length];
      list.push({ at: (bar * 4 + step) * beat, note, length: beat * 0.9, wave: 'triangle', gain: 0.3, decay: beat * 0.5 });
    }
  }
  return finish(tones(rate, seconds, list, 0.5));
};
