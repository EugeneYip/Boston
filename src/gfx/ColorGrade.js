/**
 * Colour-grade look library.
 *
 * A "look" is a complete set of grading parameters — the same set a colourist would
 * touch in a DI suite: exposure, white balance, black/white points, contrast, printer
 * lights (lift/gamma/gain), per-channel region curves, split-toning and saturation.
 *
 * Rather than shipping baked .cube LUTs (which cannot be blended smoothly and would
 * have to be downloaded), the looks are authored numerically and blended continuously
 * by time of day and weather. The result is a single parameter set that the shader
 * applies in one pass — cheaper than a 3D texture lookup and pop-free when the world
 * clock moves. `bakeLUT()` can still flatten the current look into a LookupTexture for
 * anyone who wants a .cube out of it.
 *
 * All values are authored in *display* space (post tone-map, gamma ~2.2) except
 * `exposureEV`, `temperature` and `tint`, which are scene-referred and applied by
 * ExposureEffect before the tone mapper.
 */

/** Neutral look. Every authored look is a sparse override of this. */
export const NEUTRAL = {
  // --- scene-referred (pre tone-map) ---
  exposureEV: 0.0,        // EV bias folded into the sensor exposure
  temperature: 0.0,       // -1 cool (blue) .. +1 warm (amber)
  tint: 0.0,              // -1 green .. +1 magenta
  // --- display-referred (post tone-map) ---
  blackPoint: [0.0, 0.0, 0.0],
  whitePoint: [1.0, 1.0, 1.0],
  contrast: 1.0,
  pivot: 0.435,           // ~18% grey in gamma space
  lift: [0.0, 0.0, 0.0],
  gamma: [1.0, 1.0, 1.0],
  gain: [1.0, 1.0, 1.0],
  curveR: [0.0, 0.0, 0.0],   // (shadows, midtones, highlights) offsets, per channel
  curveG: [0.0, 0.0, 0.0],
  curveB: [0.0, 0.0, 0.0],
  shadowTint: [1.0, 1.0, 1.0],
  midTint: [1.0, 1.0, 1.0],
  highTint: [1.0, 1.0, 1.0],
  saturation: 1.0,
  vibrance: 0.0,          // pushes low-saturation pixels only, protects skin/skies
  shadowSat: 1.0,         // saturation multiplier in the toe — film loses colour there
  // --- lens response ---
  bloomTint: [1.0, 1.0, 1.0],
  bloomScale: 1.0,        // multiplies the look-independent bloom intensity
  streakTint: [0.55, 0.72, 1.0],
  streakScale: 1.0,
  vignette: 1.0,          // multiplier on the base vignette
  grain: 1.0,             // multiplier on the ISO-derived grain
};

const L = (o) => Object.assign({}, NEUTRAL, o);

/**
 * Time-of-day keyframes. Hours are cyclic; `evaluate` interpolates between the two
 * bracketing keys with a smoothstep so nothing pops as the world clock advances.
 */
export const TOD_LOOKS = [
  { hour: 0.0, look: L({
      // Deep night. Sodium/mercury street lighting against a cold sky, crushed but
      // never black — a real city at night still has a lot of ambient bounce.
      exposureEV: -0.50, temperature: -0.30, tint: 0.06,
      blackPoint: [0.010, 0.008, 0.000], whitePoint: [0.985, 0.985, 1.0],
      contrast: 1.14, lift: [0.004, 0.006, 0.020],
      gamma: [1.0, 1.01, 1.05], gain: [0.97, 0.98, 1.06],
      curveR: [-0.010, 0.006, 0.018], curveG: [-0.006, 0.004, 0.010], curveB: [0.012, 0.004, -0.008],
      shadowTint: [0.80, 0.92, 1.22], midTint: [0.97, 0.98, 1.10], highTint: [1.10, 1.02, 0.92],
      saturation: 0.90, vibrance: 0.20, shadowSat: 0.62,
      bloomTint: [1.0, 0.95, 0.86], bloomScale: 1.75, streakScale: 1.5,
      vignette: 1.20, grain: 1.35 }) },

  { hour: 4.7, look: L({
      // Blue hour before sunrise — the sky is up, the ground is not.
      exposureEV: -0.30, temperature: -0.42, tint: 0.10,
      blackPoint: [0.012, 0.010, 0.004], whitePoint: [0.98, 0.99, 1.0],
      contrast: 1.06, lift: [0.006, 0.010, 0.024],
      gamma: [1.02, 1.0, 0.97], gain: [0.94, 0.98, 1.10],
      curveB: [0.016, 0.008, 0.0], curveR: [-0.014, -0.004, 0.010],
      shadowTint: [0.78, 0.90, 1.26], midTint: [0.93, 0.97, 1.14], highTint: [1.06, 1.00, 1.00],
      saturation: 0.86, vibrance: 0.26, shadowSat: 0.70,
      bloomScale: 1.25, streakScale: 1.1, vignette: 1.10, grain: 1.25 }) },

  { hour: 6.4, look: L({
      // Sunrise. Warm rim on a still-cold world.
      exposureEV: 0.05, temperature: 0.20, tint: 0.05,
      blackPoint: [0.008, 0.007, 0.006], contrast: 1.08,
      lift: [0.008, 0.004, 0.010], gain: [1.06, 1.00, 0.98],
      curveR: [0.006, 0.014, 0.020], curveG: [0.0, 0.004, 0.008], curveB: [0.010, -0.004, -0.014],
      shadowTint: [0.88, 0.95, 1.16], midTint: [1.04, 1.00, 0.98], highTint: [1.10, 1.02, 0.90],
      saturation: 0.98, vibrance: 0.20, shadowSat: 0.82,
      bloomScale: 1.35, vignette: 1.05, grain: 0.9 }) },

  { hour: 8.2, look: L({
      // New England winter morning: cold blue-grey, low chroma, hard clean light.
      // This is the look that must read as "completely different" from summer dusk.
      exposureEV: -0.12, temperature: -0.34, tint: -0.05,
      blackPoint: [0.006, 0.006, 0.002], whitePoint: [0.98, 0.99, 1.0],
      contrast: 1.16, pivot: 0.44,
      lift: [0.0, 0.003, 0.012], gamma: [1.03, 1.01, 0.97], gain: [0.95, 0.99, 1.06],
      curveR: [-0.016, -0.008, 0.006], curveG: [-0.006, 0.0, 0.006], curveB: [0.014, 0.008, 0.0],
      shadowTint: [0.83, 0.93, 1.18], midTint: [0.96, 0.99, 1.07], highTint: [1.00, 1.01, 1.05],
      saturation: 0.84, vibrance: 0.16, shadowSat: 0.72,
      bloomScale: 0.8, streakScale: 0.6, vignette: 0.95, grain: 0.7 }) },

  { hour: 11.6, look: L({
      // Midday. Neutral and punchy: this is the reference the other looks depart from.
      exposureEV: -0.22, temperature: -0.06, tint: -0.02,
      blackPoint: [0.004, 0.004, 0.004], whitePoint: [0.995, 0.995, 1.0],
      contrast: 1.13, pivot: 0.435,
      gamma: [1.0, 1.0, 0.995], gain: [1.01, 1.0, 0.995],
      curveR: [-0.008, 0.004, 0.008], curveG: [-0.006, 0.002, 0.006], curveB: [0.004, 0.0, -0.004],
      shadowTint: [0.93, 0.97, 1.10], midTint: [1.0, 1.0, 1.0], highTint: [1.03, 1.01, 0.97],
      saturation: 0.96, vibrance: 0.22, shadowSat: 0.85,
      bloomScale: 0.75, streakScale: 0.6, vignette: 0.9, grain: 0.55 }) },

  { hour: 15.6, look: L({
      // Mid-afternoon, sun swinging west. Slightly warmer, a little more air.
      exposureEV: -0.18, temperature: 0.10, tint: 0.0,
      blackPoint: [0.005, 0.005, 0.005], contrast: 1.12,
      gain: [1.03, 1.0, 0.975],
      curveR: [-0.004, 0.008, 0.012], curveG: [-0.004, 0.002, 0.006], curveB: [0.006, -0.002, -0.008],
      shadowTint: [0.92, 0.97, 1.12], midTint: [1.02, 1.0, 0.98], highTint: [1.05, 1.01, 0.94],
      saturation: 0.98, vibrance: 0.24, shadowSat: 0.86,
      bloomScale: 0.9, vignette: 0.95, grain: 0.6 }) },

  { hour: 18.2, look: L({
      // Golden hour. Amber highlights over teal shadows — the classic blockbuster split.
      exposureEV: 0.02, temperature: 0.40, tint: 0.06,
      blackPoint: [0.006, 0.006, 0.008], whitePoint: [1.0, 0.995, 0.985],
      contrast: 1.12, pivot: 0.43,
      lift: [0.004, 0.002, 0.012], gamma: [0.99, 1.0, 1.03], gain: [1.07, 1.0, 0.93],
      curveR: [0.004, 0.018, 0.026], curveG: [0.0, 0.006, 0.010], curveB: [0.014, -0.006, -0.020],
      shadowTint: [0.84, 0.94, 1.20], midTint: [1.05, 1.00, 0.94], highTint: [1.14, 1.03, 0.84],
      saturation: 1.04, vibrance: 0.24, shadowSat: 0.80,
      bloomTint: [1.0, 0.92, 0.80], bloomScale: 1.6, streakScale: 1.35,
      vignette: 1.10, grain: 0.75 }) },

  { hour: 19.7, look: L({
      // Dusk / civil twilight. Violet sky, sodium windows starting to win.
      exposureEV: -0.26, temperature: 0.12, tint: 0.22,
      blackPoint: [0.010, 0.008, 0.004], whitePoint: [0.99, 0.99, 1.0],
      contrast: 1.15, lift: [0.008, 0.004, 0.018],
      gamma: [1.0, 1.02, 1.02], gain: [1.02, 0.97, 1.04],
      curveR: [0.006, 0.012, 0.020], curveG: [-0.006, -0.002, 0.004], curveB: [0.016, 0.006, -0.006],
      shadowTint: [0.86, 0.92, 1.26], midTint: [1.02, 0.96, 1.08], highTint: [1.14, 1.00, 0.92],
      saturation: 1.02, vibrance: 0.26, shadowSat: 0.72,
      bloomTint: [1.0, 0.93, 0.84], bloomScale: 1.7, streakScale: 1.45,
      vignette: 1.15, grain: 1.05 }) },

  { hour: 21.2, look: L({
      // Full night in the city.
      exposureEV: -0.50, temperature: -0.26, tint: 0.08,
      blackPoint: [0.010, 0.008, 0.0], contrast: 1.14,
      lift: [0.004, 0.006, 0.020], gain: [0.98, 0.98, 1.06],
      curveR: [-0.010, 0.006, 0.018], curveB: [0.012, 0.004, -0.008],
      shadowTint: [0.80, 0.92, 1.22], midTint: [0.97, 0.98, 1.10], highTint: [1.10, 1.02, 0.92],
      saturation: 0.90, vibrance: 0.20, shadowSat: 0.62,
      bloomTint: [1.0, 0.95, 0.86], bloomScale: 1.75, streakScale: 1.5,
      vignette: 1.20, grain: 1.35 }) },
];

/**
 * Weather modifiers. These are *deltas* applied on top of the time-of-day look so we
 * get a full ToD x weather matrix without authoring 50 combinations by hand.
 * `w` is the blend amount (0..1) chosen by the caller.
 */
export const WEATHER_MODS = {
  clear:    null,
  overcast: { exposureEV: -0.10, temperature: -0.16, tint: -0.03,
              contrast: 0.92, saturation: 0.80, vibrance: 0.10, shadowSat: 0.80,
              blackPoint: [0.012, 0.013, 0.016], whitePoint: [0.97, 0.975, 0.985],
              lift: [0.010, 0.012, 0.016],
              shadowTint: [0.94, 0.97, 1.08], highTint: [0.99, 1.0, 1.03],
              bloomScale: 0.85, streakScale: 0.4, vignette: 1.05, grain: 1.1 },
  rain:     { exposureEV: -0.16, temperature: -0.22, tint: -0.06,
              contrast: 1.02, saturation: 0.76, vibrance: 0.26, shadowSat: 0.66,
              blackPoint: [0.014, 0.016, 0.018], whitePoint: [0.96, 0.97, 0.985],
              lift: [0.008, 0.014, 0.020], gain: [0.96, 1.0, 1.03],
              curveG: [0.006, 0.004, 0.0], curveB: [0.010, 0.004, -0.004],
              shadowTint: [0.86, 0.98, 1.14], midTint: [0.95, 1.0, 1.05],
              highTint: [1.0, 1.02, 1.04],
              bloomScale: 1.35, streakScale: 1.25, vignette: 1.18, grain: 1.35 },
  storm:    { exposureEV: -0.42, temperature: -0.30, tint: -0.08,
              contrast: 1.10, saturation: 0.66, vibrance: 0.30, shadowSat: 0.55,
              blackPoint: [0.016, 0.018, 0.022], whitePoint: [0.94, 0.95, 0.97],
              lift: [0.010, 0.016, 0.024], gain: [0.93, 0.99, 1.05],
              shadowTint: [0.82, 0.96, 1.18], highTint: [0.98, 1.02, 1.08],
              bloomScale: 1.5, streakScale: 1.3, vignette: 1.28, grain: 1.35 },
  fog:      { exposureEV: -0.05, temperature: -0.12, tint: 0.0,
              contrast: 0.80, saturation: 0.62, vibrance: 0.14, shadowSat: 0.85,
              blackPoint: [0.030, 0.032, 0.036], whitePoint: [0.94, 0.945, 0.955],
              lift: [0.030, 0.032, 0.038], gamma: [1.02, 1.02, 1.02],
              shadowTint: [0.98, 1.0, 1.04], midTint: [1.0, 1.0, 1.02],
              bloomScale: 1.45, streakScale: 0.5, vignette: 0.85, grain: 1.0 },
  snow:     { exposureEV: 0.18, temperature: -0.30, tint: 0.04,
              contrast: 0.94, saturation: 0.70, vibrance: 0.12, shadowSat: 0.80,
              blackPoint: [0.012, 0.014, 0.018], whitePoint: [0.98, 0.99, 1.0],
              lift: [0.014, 0.018, 0.026], gain: [0.97, 0.99, 1.05],
              curveB: [0.014, 0.008, 0.002],
              shadowTint: [0.88, 0.95, 1.16], highTint: [1.0, 1.01, 1.05],
              bloomScale: 1.15, streakScale: 0.6, vignette: 0.9, grain: 0.85 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function lerpInto(out, a, b, t) {
  for (const k in NEUTRAL) {
    const va = a[k], vb = b[k];
    if (Array.isArray(va)) {
      const o = out[k];
      o[0] = lerp(va[0], vb[0], t); o[1] = lerp(va[1], vb[1], t); o[2] = lerp(va[2], vb[2], t);
    } else {
      out[k] = lerp(va, vb, t);
    }
  }
  return out;
}

/** Apply a sparse modifier with weight w. Arrays and scalars both blend toward the mod. */
function applyMod(out, mod, w) {
  if (!mod || w <= 0) return out;
  for (const k in mod) {
    const vm = mod[k];
    if (Array.isArray(vm)) {
      const o = out[k];
      o[0] = lerp(o[0], vm[0], w); o[1] = lerp(o[1], vm[1], w); o[2] = lerp(o[2], vm[2], w);
    } else {
      out[k] = lerp(out[k], vm, w);
    }
  }
  return out;
}

/** Deep copy of a look so callers can mutate the scratch result freely. */
export function cloneLook(src = NEUTRAL) {
  const o = {};
  for (const k in NEUTRAL) o[k] = Array.isArray(src[k]) ? src[k].slice() : src[k];
  return o;
}

/**
 * Correlated-colour-temperature style white balance, expressed as per-channel gains.
 * `temperature` -1..1 maps to roughly 4200K..9500K around a 6500K neutral; `tint`
 * trades green against magenta. Gains are normalised so overall luminance is preserved,
 * which keeps auto-exposure and white balance from fighting each other.
 *
 * @param {number} temperature -1 (cool) .. +1 (warm)
 * @param {number} tint -1 (green) .. +1 (magenta)
 * @param {number[]} out - 3-element array to write into
 */
export function whiteBalanceGains(temperature, tint, out = [1, 1, 1]) {
  const t = Math.max(-1, Math.min(1, temperature));
  const g = Math.max(-1, Math.min(1, tint));
  // Planckian-ish: warming raises R and drops B, cooling does the reverse.
  let r = 1 + t * 0.26 + t * t * (t > 0 ? 0.05 : -0.03);
  let gr = 1 + t * 0.03 - Math.abs(t) * 0.015 - g * 0.11;
  let b = 1 - t * 0.30 + t * t * (t > 0 ? -0.04 : 0.06) + g * 0.055;
  r += g * 0.045;
  const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  const inv = 1 / Math.max(lum, 1e-4);
  out[0] = r * inv; out[1] = gr * inv; out[2] = b * inv;
  return out;
}

/** Weight of a weather state, 0 (none) .. 1 (full). Unknown states read as clear. */
export function weatherAmount(weather) {
  switch (weather) {
    case 'overcast': return 0.85;
    case 'rain':     return 0.90;
    case 'storm':    return 1.00;
    case 'fog':      return 0.92;
    case 'snow':     return 0.90;
    default:         return 0.0;
  }
}

export default class ColorGrade {
  constructor() {
    this.result = cloneLook();
    this._a = cloneLook();
    this.wbGains = [1, 1, 1];
    this.enabled = true;
    /** Global look strength — 0 bypasses grading entirely, for A/B comparisons. */
    this.intensity = 1.0;
    this._userMod = null;
  }

  /**
   * Blend the look for a given world state.
   *
   * @param {number} hour - 0..24
   * @param {string} weather - clear | overcast | rain | storm | fog | snow
   * @param {number} [wetness=0] - extra 0..1 that pushes the rain modifier further
   * @return {object} the blended look (owned by this instance, do not retain)
   */
  evaluate(hour, weather, wetness = 0) {
    const keys = TOD_LOOKS;
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].hour <= h) i++;
    const a = keys[i];
    const b = keys[(i + 1) % keys.length];
    const span = (b.hour - a.hour + 24) % 24 || 24;
    const t = smooth(Math.min(1, Math.max(0, ((h - a.hour + 24) % 24) / span)));
    const out = lerpInto(this.result, a.look, b.look, t);

    const w = weatherAmount(weather);
    if (w > 0) applyMod(out, WEATHER_MODS[weather], w);
    // Standing water keeps the rain grade alive briefly after the rain stops.
    if (wetness > 0 && weather !== 'rain' && weather !== 'storm') {
      applyMod(out, WEATHER_MODS.rain, wetness * 0.35);
    }
    if (this._userMod) applyMod(out, this._userMod, 1);

    if (this.intensity < 1) {
      const k = Math.max(0, this.intensity);
      for (const key in NEUTRAL) {
        const vn = NEUTRAL[key], vo = out[key];
        if (Array.isArray(vn)) {
          vo[0] = lerp(vn[0], vo[0], k); vo[1] = lerp(vn[1], vo[1], k); vo[2] = lerp(vn[2], vo[2], k);
        } else {
          out[key] = lerp(vn, vo, k);
        }
      }
    }

    whiteBalanceGains(out.temperature, out.tint, this.wbGains);
    return out;
  }

  /** Push a persistent user override on top of everything (dev tuning hook). */
  setOverride(mod) { this._userMod = mod || null; }

  /**
   * Flatten the current look into a 3D lookup texture. Not used by the runtime path
   * (the parametric grade is cheaper and blends continuously) but handy for exporting
   * a .cube or for a fixed-function fallback.
   *
   * @param {Function} LookupTextureCtor - postprocessing's LookupTexture class
   * @param {number} [size=32]
   */
  bakeLUT(LookupTextureCtor, size = 32) {
    const data = new Float32Array(size * size * size * 4);
    const look = this.result;
    const c = [0, 0, 0];
    let p = 0;
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          c[0] = r / (size - 1); c[1] = g / (size - 1); c[2] = b / (size - 1);
          gradeCPU(c, look);
          data[p++] = c[0]; data[p++] = c[1]; data[p++] = c[2]; data[p++] = 1;
        }
      }
    }
    return LookupTextureCtor ? new LookupTextureCtor(data, size) : data;
  }
}

/** Reference CPU implementation of the shader grade — keep in sync with GradeEffect. */
function gradeCPU(c, k) {
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const ws = (x) => { const s = clamp01(1 - x / 0.5); return s * s; };
  const wh = (x) => { const s = clamp01((x - 0.5) / 0.5); return s * s; };
  for (let i = 0; i < 3; i++) {
    let v = (c[i] - k.blackPoint[i]) / Math.max(k.whitePoint[i] - k.blackPoint[i], 1e-3);
    v = (v - k.pivot) * k.contrast + k.pivot;
    v = v * k.gain[i] + k.lift[i];
    v = Math.sign(v) * Math.pow(Math.abs(v), 1 / k.gamma[i]);
    const cv = [k.curveR, k.curveG, k.curveB][i];
    const s = ws(v), hgh = wh(v), m = Math.max(0, 1 - s - hgh);
    v += cv[0] * s + cv[1] * m + cv[2] * hgh;
    v *= k.shadowTint[i] * s + k.midTint[i] * m + k.highTint[i] * hgh;
    c[i] = clamp01(v);
  }
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (let i = 0; i < 3; i++) c[i] = clamp01(lum + (c[i] - lum) * k.saturation);
}
