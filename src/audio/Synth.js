/**
 * Synth.js — the procedural DSP toolkit every other audio module builds on.
 *
 * There are no audio files in BOSTON. Every sample you hear is generated at runtime,
 * either as a band-limited oscillator bank, as filtered noise, or as a short buffer
 * that is rendered once into a Float32Array and then reused forever.
 *
 * Everything here takes a `BaseAudioContext`, never a global, so the exact same graph
 * builders can be rendered into an `OfflineAudioContext` for the analytical self-tests
 * in AudioEngine.selfTest(). That is deliberate: it is the only way to prove a synth
 * is correct without ears.
 */

export const SPEED_OF_SOUND = 343;  // m/s, dry air at 20 C

/* ------------------------------------------------------------------ math ---- */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-7));

/** Frame-rate independent exponential approach. `rate` is "per second". */
export const approach = (cur, target, rate, dt) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Deterministic 32-bit PRNG (mulberry32). Seeded so buffers are reproducible. */
export function makePRNG(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------- param helpers ---- */
// AudioParam methods throw on non-finite values and kill the whole audio thread
// for the rest of the session, so every write goes through a guard.

/** Smooth exponential approach on an AudioParam. `tc` is the time constant in s. */
export function setT(p, v, now, tc = 0.05) {
  if (!p || !Number.isFinite(v)) return;
  p.setTargetAtTime(v, now, tc <= 0 ? 0.001 : tc);
}
/** Linear ramp from wherever we are to `v` over `dur`. */
export function ramp(p, v, now, dur = 0.05) {
  if (!p || !Number.isFinite(v)) return;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(v, now + Math.max(dur, 0.001));
}
/** Hard set at a scheduled time. */
export function at(p, v, t) {
  if (!p || !Number.isFinite(v)) return;
  p.setValueAtTime(v, t);
}

/* ---------------------------------------------------------------- noise ---- */

/**
 * @param {BaseAudioContext} actx
 * @param {number} seconds buffer length (looped, so keep it long enough that the
 *   loop period is not audible as a pattern — 6 s is comfortably beyond that)
 * @param {'white'|'pink'|'brown'} kind
 */
export function noiseBuffer(actx, seconds = 6, kind = 'white', seed = 1) {
  const sr = actx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = actx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const rng = makePRNG(seed);
  if (kind === 'white') {
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellett's economical pink filter: -3 dB/oct to within 0.05 dB.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // Brown / red: leaky integrator, -6 dB/oct. The leak stops DC wander.
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + (rng() * 2 - 1) * 0.02) * 0.998;
      d[i] = last * 8;
    }
  }
  // Normalise so downstream gain staging is predictable regardless of kind.
  let peak = 1e-6;
  for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  const s = 0.85 / peak;
  for (let i = 0; i < n; i++) d[i] *= s;
  return buf;
}

/* -------------------------------------------------------- periodic waves ---- */

/**
 * Build a band-limited engine wave from an *engine order* table.
 *
 * A 4-stroke engine fires every two crank revolutions, so the useful frequency grid
 * is half-orders of crank speed. If we drive the oscillator at f = rpm/120 Hz (the
 * 0.5th order), then harmonic index k of the PeriodicWave lands exactly on order k/2.
 * That means the entire harmonic stack of an engine — all 30-odd partials — costs a
 * single OscillatorNode and is anti-aliased by the browser for free.
 *
 * @param {BaseAudioContext} actx
 * @param {Array<[number, number]>} orders [engineOrder, amplitude] pairs
 * @param {{seed?:number, tilt?:number}} opt tilt > 0 boosts high orders (load/harshness)
 */
export function periodicWaveFromOrders(actx, orders, opt = {}) {
  const { seed = 7, tilt = 0 } = opt;
  let maxK = 2;
  for (const [o] of orders) maxK = Math.max(maxK, Math.round(o * 2));
  maxK = Math.min(maxK, 96);
  const real = new Float32Array(maxK + 1);
  const imag = new Float32Array(maxK + 1);
  const rng = makePRNG(seed);
  for (const [o, a0] of orders) {
    const k = Math.round(o * 2);
    if (k < 1 || k > maxK) continue;
    // Randomised phase keeps the crest factor low. All-in-phase harmonics make a
    // pulse train that clips the moment you add anything else to the bus.
    const phi = rng() * Math.PI * 2;
    const a = a0 * (1 + tilt * Math.min(o, 16) / 8);
    real[k] += a * Math.cos(phi);
    imag[k] += a * Math.sin(phi);
  }
  return actx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Narrow unipolar pulse train (Dirichlet kernel). Used as an audio-rate amplitude
 * modulator: one spike per cylinder firing gives exhaust chuff and diesel clatter.
 * @param {number} harmonics more harmonics = narrower spike
 */
export function pulseWave(actx, harmonics = 12) {
  const n = Math.min(harmonics, 64);
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) real[k] = 1 / n;   // cosines -> peak at t=0
  return actx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/* ---------------------------------------------------------- shaper curves ---- */

/** tanh soft clip, normalised so unity in -> unity out. */
export function softClipCurve(drive = 2, n = 1024) {
  const c = new Float32Array(n);
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / k;
  }
  return c;
}

/**
 * Sparse-event curve. Feed it slow low-passed noise and it outputs mostly zero with
 * occasional short bursts — that is exactly what an overrun exhaust pop sounds like,
 * and it costs no per-frame JavaScript at all.
 */
export function popCurve(threshold = 0.42, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a < threshold ? 0 : Math.min(1, (a - threshold) * 5.5);
  }
  return c;
}

/* ------------------------------------------------------- rendered buffers ---- */

/**
 * Glass shatter: a dense sprinkle of high, short, exponentially decaying sine grains
 * with a randomised onset distribution that clusters early (the initial break) and
 * thins out (fragments settling).
 */
export function glassBuffer(actx, seed = 21) {
  const sr = actx.sampleRate, n = Math.floor(1.9 * sr);
  const buf = actx.createBuffer(2, n, sr);
  const rng = makePRNG(seed);
  const grains = 420;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let g = 0; g < grains; g++) {
      const u = rng();
      const onset = Math.floor(u * u * u * n * 0.92);       // cubic -> front-loaded
      const f = 1400 + rng() * 6800;
      const dec = 0.008 + rng() * 0.10;
      const amp = (0.05 + rng() * 0.5) * (1 - onset / n) * 0.5;
      const len = Math.min(Math.floor(dec * 5 * sr), n - onset);
      const w = 2 * Math.PI * f / sr;
      const dk = Math.exp(-1 / (dec * sr));
      let e = amp;
      for (let i = 0; i < len; i++) {
        d[onset + i] += Math.sin(w * i) * e;
        e *= dk;
      }
    }
  }
  return normalize(buf, 0.92);
}

/** Gravel / debris scatter — broadband clicks, used for scrape and pothole grit. */
export function gravelBuffer(actx, seed = 33) {
  const sr = actx.sampleRate, n = Math.floor(1.1 * sr);
  const buf = actx.createBuffer(2, n, sr);
  const rng = makePRNG(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let g = 0; g < 260; g++) {
      const onset = Math.floor(rng() * n * 0.9);
      const len = Math.min(Math.floor((0.002 + rng() * 0.02) * sr), n - onset);
      const amp = 0.1 + rng() * 0.9;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, 2.5);
        lp += ((rng() * 2 - 1) - lp) * 0.55;
        d[onset + i] += lp * env * amp * 0.35;
      }
    }
  }
  return normalize(buf, 0.8);
}

/**
 * Rain droplet layer. A convincing rain bed is *not* just filtered noise: the ear
 * locks onto the individual droplet transients. We render a few seconds of randomly
 * placed, band-limited impacts and loop it under the noise bed.
 * @param {number} density drops per second
 */
export function dropletBuffer(actx, density = 900, seed = 5, seconds = 4) {
  const sr = actx.sampleRate, n = Math.floor(seconds * sr);
  const buf = actx.createBuffer(2, n, sr);
  const rng = makePRNG(seed);
  const count = Math.floor(density * seconds);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let g = 0; g < count; g++) {
      const onset = Math.floor(rng() * (n - 800));
      // Each drop is a short, resonant, downward-chirped tick.
      const f0 = 900 + rng() * 5200;
      const dec = 0.0016 + rng() * 0.010;
      const amp = Math.pow(rng(), 2.2) * 0.9 + 0.03;
      const len = Math.min(Math.floor(dec * 6 * sr), n - onset);
      const dk = Math.exp(-1 / (dec * sr));
      let e = amp, ph = 0;
      for (let i = 0; i < len; i++) {
        const f = f0 * (1 - 0.35 * (i / len));
        ph += 2 * Math.PI * f / sr;
        d[onset + i] += Math.sin(ph) * e;
        e *= dk;
      }
    }
  }
  return normalize(buf, 0.7);
}

/** Water splash / harbour lap: slow filtered-noise swells with bubble grains. */
export function splashBuffer(actx, seed = 91) {
  const sr = actx.sampleRate, n = Math.floor(5 * sr);
  const buf = actx.createBuffer(2, n, sr);
  const rng = makePRNG(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0, lp2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      lp += (w - lp) * 0.10;
      lp2 += (lp - lp2) * 0.10;
      d[i] = lp2 * 1.6;
    }
    // Bubbles: rising-pitch sine blips.
    for (let g = 0; g < 90; g++) {
      const onset = Math.floor(rng() * (n - 4000));
      const f0 = 300 + rng() * 900;
      const len = Math.floor((0.02 + rng() * 0.06) * sr);
      let ph = 0;
      for (let i = 0; i < len && onset + i < n; i++) {
        const f = f0 * (1 + 1.5 * (i / len));
        ph += 2 * Math.PI * f / sr;
        d[onset + i] += Math.sin(ph) * Math.pow(1 - i / len, 2) * 0.08;
      }
    }
  }
  return normalize(buf, 0.55);
}

function normalize(buf, target = 0.9) {
  let peak = 1e-6;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  const s = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= s;
  }
  return buf;
}

/* ------------------------------------------------------ impulse responses ---- */

/**
 * Procedural room impulse response. Three noise bands each with their own RT60 gives
 * the frequency-dependent decay real rooms have (bass rings on, treble dies first),
 * and explicit early-reflection taps give the space its size and character.
 *
 * @param {{seconds:number, rt60Low:number, rt60Mid:number, rt60High:number,
 *          predelay:number, er:Array<[number,number]>, seed:number, width:number}} o
 */
export function impulseResponse(actx, o = {}) {
  const sr = actx.sampleRate;
  const seconds = o.seconds ?? 1.6;
  const rtL = o.rt60Low ?? seconds, rtM = o.rt60Mid ?? seconds * 0.8;
  const rtH = o.rt60High ?? seconds * 0.45;
  const predelay = o.predelay ?? 0.008;
  const er = o.er ?? [];
  const width = o.width ?? 1;
  const n = Math.floor(seconds * sr);
  const buf = actx.createBuffer(2, n, sr);
  const pd = Math.floor(predelay * sr);

  const aLow = 1 - Math.exp(-2 * Math.PI * 220 / sr);
  const aMid = 1 - Math.exp(-2 * Math.PI * 2200 / sr);
  const dL = Math.exp(-6.907755 / (rtL * sr));
  const dM = Math.exp(-6.907755 / (rtM * sr));
  const dH = Math.exp(-6.907755 / (rtH * sr));

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = makePRNG((o.seed ?? 3) + ch * 977);
    let lp1 = 0, lp2 = 0, eL = 1, eM = 1, eH = 1;
    for (let i = pd; i < n; i++) {
      const w = rng() * 2 - 1;
      lp1 += (w - lp1) * aLow;
      lp2 += (w - lp2) * aMid;
      const low = lp1, mid = lp2 - lp1, high = w - lp2;
      d[i] = low * eL * 1.4 + mid * eM + high * eH * 0.8;
      eL *= dL; eM *= dM; eH *= dH;
    }
    // Early reflections: discrete, slightly decorrelated per channel.
    for (const [t, g] of er) {
      const jitter = (rng() * 2 - 1) * 0.0012 * width;
      const idx = Math.floor((t + predelay + (ch ? jitter : -jitter)) * sr);
      if (idx > 0 && idx < n) d[idx] += g * (rng() > 0.5 ? 1 : -1);
    }
    d[pd] += 0.35;   // direct-ish spike keeps transients from smearing to mush
  }

  // Normalise by energy, not peak: keeps the wet/dry balance consistent between IRs.
  let sum = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
  }
  const s = 0.55 / Math.sqrt(Math.max(sum / sr, 1e-9));
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] *= s;
  }
  return buf;
}

/** The five spaces the game switches between. */
export const IR_PRESETS = {
  open:   { seconds: 1.0, rt60Low: 0.9, rt60Mid: 0.6, rt60High: 0.30, predelay: 0.012,
            er: [[0.017, 0.16], [0.031, 0.10], [0.052, 0.07]], seed: 11 },
  street: { seconds: 1.8, rt60Low: 1.7, rt60Mid: 1.15, rt60High: 0.55, predelay: 0.010,
            er: [[0.009, 0.30], [0.018, 0.22], [0.029, 0.17], [0.044, 0.12],
                 [0.067, 0.08]], seed: 12 },
  alley:  { seconds: 1.5, rt60Low: 1.4, rt60Mid: 1.25, rt60High: 0.85, predelay: 0.004,
            er: [[0.004, 0.46], [0.009, 0.38], [0.014, 0.32], [0.019, 0.27],
                 [0.024, 0.22], [0.030, 0.18], [0.036, 0.14]], seed: 13, width: 0.4 },
  tunnel: { seconds: 3.4, rt60Low: 3.3, rt60Mid: 2.6, rt60High: 1.1, predelay: 0.006,
            er: [[0.011, 0.34], [0.023, 0.30], [0.035, 0.26], [0.047, 0.22],
                 [0.059, 0.19], [0.071, 0.16], [0.083, 0.13], [0.095, 0.11]], seed: 14 },
  indoor: { seconds: 0.8, rt60Low: 0.7, rt60Mid: 0.5, rt60High: 0.22, predelay: 0.005,
            er: [[0.006, 0.28], [0.013, 0.20], [0.021, 0.14]], seed: 15 },
};

/* ------------------------------------------------------------- shared kit ---- */

const KITS = new WeakMap();

/**
 * Per-context shared resources. Noise is the single biggest saving here: one looping
 * AudioBufferSourceNode can fan out to every voice in the game, so 200 noise-using
 * voices still cost 6 source nodes in total.
 */
export function kit(actx) {
  let k = KITS.get(actx);
  if (k) return k;

  const white = noiseBuffer(actx, 6, 'white', 1);
  const pink = noiseBuffer(actx, 6, 'pink', 2);
  const brown = noiseBuffer(actx, 6, 'brown', 3);

  const taps = [];
  const mk = (buf, offset) => {
    const s = actx.createBufferSource();
    s.buffer = buf; s.loop = true;
    // Different loop offsets decorrelate voices that share a tap group.
    try { s.start(0, offset); } catch { s.start(0); }
    taps.push(s);
    return s;
  };
  k = {
    actx,
    buffers: { white, pink, brown },
    // 4 white + 2 pink + 1 brown taps. Voices pick by index so neighbours differ.
    noise: [mk(white, 0), mk(white, 1.37), mk(white, 2.91), mk(white, 4.13),
            mk(pink, 0.51), mk(pink, 3.29), mk(brown, 1.11)],
    _taps: taps,
    curves: {
      softLight: softClipCurve(1.4),
      softHard: softClipCurve(4.5),
      pops: popCurve(0.40),
      popsRich: popCurve(0.24),
    },
    waves: new Map(),
    lazy: {},           // filled in by warmLazy()
    _disposed: false,
  };
  KITS.set(actx, k);
  return k;
}

/** White/pink tap chosen deterministically per voice so voices decorrelate. */
export function noiseTap(k, i, pink = false) {
  return pink ? k.noise[4 + (i % 2)] : k.noise[i % 4];
}

/**
 * Heavier buffers (glass, droplets, IRs) are rendered off the critical path so the
 * first user gesture never stalls the main thread. Safe to call more than once.
 */
export function warmLazy(k) {
  if (k.lazy.ready || k.lazy.pending) return;
  k.lazy.pending = true;
  const actx = k.actx;
  const jobs = [
    () => { k.lazy.glass = glassBuffer(actx); },
    () => { k.lazy.gravel = gravelBuffer(actx); },
    () => { k.lazy.dropLight = dropletBuffer(actx, 420, 5); },
    () => { k.lazy.dropMed = dropletBuffer(actx, 1500, 6); },
    () => { k.lazy.dropHeavy = dropletBuffer(actx, 4200, 7); },
    () => { k.lazy.water = splashBuffer(actx); },
    () => { k.lazy.ir = {};
            for (const n of ['open', 'street']) k.lazy.ir[n] = impulseResponse(actx, IR_PRESETS[n]); },
    () => { for (const n of ['alley', 'tunnel', 'indoor']) k.lazy.ir[n] = impulseResponse(actx, IR_PRESETS[n]);
            k.lazy.ready = true; k.lazy.pending = false; },
  ];
  let i = 0;
  // Must be bound: an unbound requestIdleCallback throws "Illegal invocation".
  const idle = window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : ((f) => setTimeout(f, 12));
  const run = () => {
    if (k._disposed) return;
    const t0 = performance.now();
    while (i < jobs.length && performance.now() - t0 < 6) jobs[i++]();
    if (i < jobs.length) idle(run);
  };
  idle(run);
}

/** Synchronous variant for offline rendering, where idle callbacks never fire. */
export function warmLazySync(k) {
  if (k.lazy.ready) return k.lazy;
  const actx = k.actx;
  k.lazy.glass = glassBuffer(actx);
  k.lazy.gravel = gravelBuffer(actx);
  k.lazy.dropLight = dropletBuffer(actx, 420, 5);
  k.lazy.dropMed = dropletBuffer(actx, 1500, 6);
  k.lazy.dropHeavy = dropletBuffer(actx, 4200, 7);
  k.lazy.water = splashBuffer(actx);
  k.lazy.ir = {};
  for (const n of Object.keys(IR_PRESETS)) k.lazy.ir[n] = impulseResponse(actx, IR_PRESETS[n]);
  k.lazy.ready = true;
  return k.lazy;
}

export function disposeKit(actx) {
  const k = KITS.get(actx);
  if (!k) return;
  k._disposed = true;
  for (const t of k._taps) { try { t.stop(); } catch { /* already stopped */ } t.disconnect(); }
  KITS.delete(actx);
}

/* ------------------------------------------------------------- Voice3D ---- */

/**
 * A spatialised output slot: gain -> panner -> (dry bus, reverb send).
 *
 * The Web Audio spec dropped PannerNode's Doppler support years ago, so pitch shift
 * for moving sources is computed here and applied by the owner to its oscillators.
 * That is actually better — we get to clamp it and to exclude layers (tyre roar
 * Dopplers, but a stereo-wide ambience bed must not).
 */
export class Voice3D {
  constructor(actx, dry, send, o = {}) {
    this.actx = actx;
    this.input = actx.createGain();
    this.input.gain.value = o.gain ?? 1;
    this.panner = actx.createPanner();
    const p = this.panner;
    p.panningModel = o.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = o.distanceModel || 'inverse';
    p.refDistance = o.refDistance ?? 6;
    p.rolloffFactor = o.rolloff ?? 1.1;
    p.maxDistance = o.maxDistance ?? 500;
    p.coneInnerAngle = 360;
    this.input.connect(p);
    if (dry) p.connect(dry);
    this.send = null;
    if (send) {
      this.send = actx.createGain();
      this.send.gain.value = o.send ?? 0.25;
      p.connect(this.send);
      this.send.connect(send);
    }
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.doppler = 1;
    this._hrtf = !!o.hrtf;
  }

  /** Scalars, not vectors — this runs for every voice every frame. */
  setPosition(x, y, z, now) {
    this.x = x; this.y = y; this.z = z;
    const p = this.panner;
    if (p.positionX) {
      // Ramping rather than jumping avoids zipper noise on fast-moving sources.
      p.positionX.setTargetAtTime(x, now, 0.02);
      p.positionY.setTargetAtTime(y, now, 0.02);
      p.positionZ.setTargetAtTime(z, now, 0.02);
    } else {
      p.setPosition(x, y, z);
    }
  }
  setVelocity(vx, vy, vz) { this.vx = vx; this.vy = vy; this.vz = vz; }
  setGain(g, now, tc = 0.05) { setT(this.input.gain, g, now, tc); }
  setSend(g, now, tc = 0.2) { if (this.send) setT(this.send.gain, g, now, tc); }

  /** Promote/demote HRTF by distance — HRTF convolution is the expensive part. */
  setHRTF(on) {
    if (on === this._hrtf) return;
    this._hrtf = on;
    this.panner.panningModel = on ? 'HRTF' : 'equalpower';
  }

  dispose() {
    this.input.disconnect();
    this.panner.disconnect();
    this.send?.disconnect();
  }
}

/**
 * Doppler ratio for a source at (sx,sy,sz) moving at (svx..) heard by a listener at
 * (lx..) moving at (lvx..). f' = f (c + v_listener_toward) / (c + v_source_away).
 */
export function dopplerRatio(sx, sy, sz, svx, svy, svz, lx, ly, lz, lvx, lvy, lvz) {
  let dx = sx - lx, dy = sy - ly, dz = sz - lz;
  const d = Math.hypot(dx, dy, dz);
  if (d < 0.25) return 1;
  dx /= d; dy /= d; dz /= d;
  const vs = svx * dx + svy * dy + svz * dz;        // + = receding
  const vl = lvx * dx + lvy * dy + lvz * dz;        // + = chasing the source
  const r = (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND + vs);
  return clamp(Number.isFinite(r) ? r : 1, 0.72, 1.42);
}

/* --------------------------------------------------------- one-shot pool ---- */

/**
 * Fixed pool of spatialised one-shot slots. Panners (especially HRTF ones) are the
 * costly nodes, so those are allocated once and reused; the short-lived source and
 * filter chain per event is created on demand and torn down when the slot is
 * reclaimed. Reclaiming happens by scanning `freeAt` in the update loop rather than
 * via `onended` callbacks, which would allocate a closure per event.
 */
export class OneShotPool {
  constructor(actx, dry, send, size = 24, o = {}) {
    this.actx = actx;
    this.size = size;
    this.slots = new Array(size);
    for (let i = 0; i < size; i++) {
      this.slots[i] = {
        voice: new Voice3D(actx, dry, send, { hrtf: false, refDistance: o.refDistance ?? 4,
          rolloff: o.rolloff ?? 1.25, maxDistance: o.maxDistance ?? 600, send: 0.3 }),
        freeAt: -1, priority: 0, nodes: [], busy: false,
      };
    }
  }

  /**
   * @returns {{voice:Voice3D, nodes:Array}|null} a slot, stealing the lowest-priority
   *   busy one if the pool is full and this event outranks it.
   */
  acquire(now, duration, priority = 1) {
    let free = -1, worst = -1, worstP = priority;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (!s.busy || s.freeAt <= now) { free = i; break; }
      if (s.priority < worstP) { worstP = s.priority; worst = i; }
    }
    const idx = free >= 0 ? free : worst;
    if (idx < 0) return null;             // everything louder than us — drop it
    const s = this.slots[idx];
    this._clear(s);
    s.busy = true;
    s.priority = priority;
    s.freeAt = now + duration + 0.05;
    s.voice.input.gain.cancelScheduledValues(now);
    s.voice.input.gain.setValueAtTime(1, now);
    return s;
  }

  _clear(s) {
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i];
      try { n.stop?.(); } catch { /* not a source, or already stopped */ }
      n.disconnect();
    }
    s.nodes.length = 0;
  }

  /** Call once a frame. Zero allocation. */
  update(now) {
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s.busy && s.freeAt <= now) { this._clear(s); s.busy = false; s.priority = 0; }
    }
  }

  get activeCount() {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.slots[i].busy) n++;
    return n;
  }

  dispose() {
    for (const s of this.slots) { this._clear(s); s.voice.dispose(); }
    this.slots.length = 0;
  }
}

/* ------------------------------------------------------------ resonators ---- */

/**
 * Modal resonator bank. A struck object rings at a set of inharmonic modes with
 * per-mode decay; bandpasses with high Q, excited by a short noise burst, reproduce
 * that convincingly for a fraction of the cost of a physical model.
 *
 * @param {Array<number>} freqs mode frequencies (Hz)
 * @param {Array<number>} decays per-mode -60 dB time (s)
 * @param {Array<number>} gains per-mode amplitude
 */
export function modalBurst(actx, dest, now, exciter, {
  freqs, decays, gains, amp = 1, q = 34, exciteDur = 0.02, nodes = null,
}) {
  const src = actx.createBufferSource();
  src.buffer = exciter;
  src.playbackRate.value = 0.85 + Math.random() * 0.3;
  const eg = actx.createGain();
  eg.gain.setValueAtTime(0, now);
  eg.gain.linearRampToValueAtTime(amp, now + 0.0012);
  eg.gain.exponentialRampToValueAtTime(0.0008, now + exciteDur);
  src.connect(eg);
  nodes?.push(src, eg);

  let maxDecay = 0;
  for (let i = 0; i < freqs.length; i++) {
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freqs[i];
    bp.Q.value = q * (0.6 + 0.8 * (i / freqs.length));
    const g = actx.createGain();
    const dec = decays[i];
    maxDecay = Math.max(maxDecay, dec);
    g.gain.setValueAtTime(gains[i], now);
    g.gain.exponentialRampToValueAtTime(0.0004, now + dec);
    eg.connect(bp); bp.connect(g); g.connect(dest);
    nodes?.push(bp, g);
  }
  // Random offset into the noise buffer: without it every strike is bit-identical.
  const off = Math.random() * Math.max(exciter.duration - 0.25, 0);
  src.start(now, off);
  src.stop(now + Math.min(exciteDur * 3 + 0.05, 1));
  return maxDecay;
}

/** Church-bell partial set (hum, prime, tierce, quint, nominal + upper modes). */
export const BELL_PARTIALS = [
  [0.5, 1.00, 9.5], [1.0, 0.85, 8.0], [1.183, 0.55, 5.5], [1.506, 0.45, 4.2],
  [2.0, 0.62, 3.4], [2.505, 0.30, 2.3], [2.664, 0.22, 2.0], [3.011, 0.26, 1.7],
  [4.166, 0.16, 1.1], [5.433, 0.11, 0.8], [6.796, 0.07, 0.6],
];
