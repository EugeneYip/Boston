import * as THREE from 'three';

/**
 * Procedural PBR texture generation for the whole city.
 *
 * There are no image assets in this project, so every surface is authored here:
 * a recipe paints into a `Surface` (albedo + height + roughness + metalness +
 * ambient-occlusion float buffers), then the surface is baked into three
 * DataTextures — albedo(sRGB), tangent-space normal (Sobel of the height field),
 * and a packed ORM map (R=AO, G=roughness, B=metalness, the glTF convention,
 * which lets one texture drive three material slots and cuts VRAM by 3x).
 *
 * Why a noise "bank": evaluating multi-octave noise per pixel per material costs
 * seconds at 1024^2. Instead we build a handful of seamless 512^2 float fields
 * once and every recipe samples them with integer tile scales (which preserves
 * seamlessness) plus cheap per-pixel hashing for the highest frequencies.
 */

/* ========================================================================== *
 * Hashing / RNG
 * ========================================================================== */

const BANK = 512;

/** 32-bit integer hash -> [0,1). Deterministic across machines. */
function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** mulberry32 — small, fast, seedable. */
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (n) => (f() * n) | 0;
  f.pick = (arr) => arr[(f() * arr.length) | 0];
  // Box-Muller, clamped — used for "most bricks near the mean, a few outliers".
  f.gauss = (mu = 0, sd = 1) => {
    const u = Math.max(1e-6, f()), v = f();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v);
  };
  return f;
}

/** '#rrggbb' -> [r,g,b] in 0..1, kept in sRGB because that is how you paint. */
export function hx(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = sat((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/* ========================================================================== *
 * Seamless noise fields
 * ========================================================================== */

/** Wrapped bilinear lookup tables for resampling a P-cell lattice to `res` px. */
function idxTable(res, P) {
  const i0 = new Int32Array(res), i1 = new Int32Array(res), f = new Float32Array(res);
  for (let i = 0; i < res; i++) {
    const t = ((i + 0.5) * P) / res;
    const a = Math.floor(t);
    i0[i] = ((a % P) + P) % P;
    i1[i] = (i0[i] + 1) % P;
    const fr = t - a;
    f[i] = fr * fr * (3 - 2 * fr);   // smoothstep interp => value noise, C1 continuous
  }
  return { i0, i1, f };
}

/** Periodic fractal value noise, normalised to roughly 0..1. */
function fbmField(res, baseP, octaves, gain, seed) {
  const out = new Float32Array(res * res);
  let amp = 1, norm = 0, P = baseP;
  for (let o = 0; o < octaves && P <= res; o++) {
    const g = new Float32Array(P * P);
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) g[j * P + i] = hash2i(i, j, seed + o * 7919);
    const T = idxTable(res, P);
    const { i0, i1, f } = T;
    for (let y = 0; y < res; y++) {
      const r0 = i0[y] * P, r1 = i1[y] * P, fy = f[y], row = y * res;
      for (let x = 0; x < res; x++) {
        const x0 = i0[x], x1 = i1[x], fx = f[x];
        const a = g[r0 + x0] + (g[r0 + x1] - g[r0 + x0]) * fx;
        const b = g[r1 + x0] + (g[r1 + x1] - g[r1 + x0]) * fx;
        out[row + x] += (a + (b - a) * fy) * amp;
      }
    }
    norm += amp; amp *= gain; P *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Periodic Worley/cellular noise. Returns three fields:
 *   f1   distance to the nearest feature point, in cell units (0..~1)
 *   edge second-nearest minus nearest — 0 exactly on a cell border
 *   id   a random constant per cell, for per-stone/per-crystal colour
 */
function worleyFields(res, C, seed) {
  const px = new Float32Array(C * C), py = new Float32Array(C * C), pv = new Float32Array(C * C);
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const k = j * C + i;
    px[k] = i + hash2i(i, j, seed);
    py[k] = j + hash2i(i, j, seed + 101);
    pv[k] = hash2i(i, j, seed + 202);
  }
  const f1 = new Float32Array(res * res), edge = new Float32Array(res * res), id = new Float32Array(res * res);
  const s = C / res;
  for (let y = 0; y < res; y++) {
    const cy = (y + 0.5) * s, jy = Math.floor(cy), row = y * res;
    for (let x = 0; x < res; x++) {
      const cx = (x + 0.5) * s, jx = Math.floor(cx);
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const j = ((jy + dj) % C + C) % C, oy = (jy + dj) - j;   // wrap offset in cell units
        for (let di = -1; di <= 1; di++) {
          const i = ((jx + di) % C + C) % C, ox = (jx + di) - i;
          const k = j * C + i;
          const ddx = px[k] + ox - cx, ddy = py[k] + oy - cy;
          const d = ddx * ddx + ddy * ddy;
          if (d < d1) { d2 = d1; d1 = d; best = k; }
          else if (d < d2) d2 = d;
        }
      }
      d1 = Math.sqrt(d1); d2 = Math.sqrt(d2);
      f1[row + x] = d1 > 1 ? 1 : d1;
      edge[row + x] = Math.min(1, d2 - d1);
      id[row + x] = pv[best];
    }
  }
  return { f1, edge, id };
}

/* ========================================================================== *
 * Surface — the float buffers a recipe paints into
 * ========================================================================== */

class Surface {
  constructor(w, h) {
    const n = w * h;
    this.w = w; this.h = h; this.n = n;
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.height = new Float32Array(n);
    this.rough = new Float32Array(n);
    this.metal = new Float32Array(n);
    this.ao = new Float32Array(n);
    this.alpha = new Float32Array(n);
  }

  reset(c = [0.5, 0.5, 0.5], rough = 0.9) {
    this.r.fill(c[0]); this.g.fill(c[1]); this.b.fill(c[2]);
    this.height.fill(0.5); this.rough.fill(rough);
    this.metal.fill(0); this.ao.fill(1); this.alpha.fill(1);
    return this;
  }

  set(i, c) { this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2]; }
  mix(i, c, t) {
    this.r[i] += (c[0] - this.r[i]) * t;
    this.g[i] += (c[1] - this.g[i]) * t;
    this.b[i] += (c[2] - this.b[i]) * t;
  }
  mul(i, k) { this.r[i] *= k; this.g[i] *= k; this.b[i] *= k; }
  add(i, k) { this.r[i] += k; this.g[i] += k; this.b[i] += k; }
}

/* ========================================================================== *
 * Baking float buffers -> GPU textures
 * ========================================================================== */

function finishTexture(t, { srgb = false, clampV = false, clampAll = false } = {}) {
  t.wrapS = clampAll ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.wrapT = (clampV || clampAll) ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.channel = 0;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Rows are painted top-down (recipe y=0 is the top of the wall, gravity is +y)
 * but a DataTexture's first row is v=0, so every bake flips vertically. That
 * keeps "down" meaning down for streaks, drips and spandrels.
 */
/**
 * @param {number} gain  sRGB multiplier used to hit a measured real-world
 *   reflectance without re-authoring every colour. Scaling all three channels
 *   equally preserves hue; linear reflectance moves as roughly gain^2.4.
 * @param {number} floor lifts the blacks a hair. Nothing outdoors is a perfect
 *   absorber, and a true 0 albedo turns into a hole in shadow.
 */
function bakeAlbedo(S, opaque, gain = 1, floor = 0.045, clampV = false) {
  const { w, h } = S;
  const c = new Uint8ClampedArray(w * h * 4);   // clamps + rounds in hardware
  const R = S.r, G = S.g, B = S.b, A = S.alpha;
  const k = gain * (1 - floor) * 255, f = floor * 255;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) {
      const s = src + x, o = (dst + x) * 4;
      c[o] = R[s] * k + f; c[o + 1] = G[s] * k + f; c[o + 2] = B[s] * k + f;
      c[o + 3] = opaque ? 255 : A[s] * 255;
    }
  }
  return finishTexture(new THREE.DataTexture(new Uint8Array(c.buffer), w, h, THREE.RGBAFormat), { srgb: true, clampV });
}

/**
 * Sobel the height field into a tangent-space normal map (OpenGL +Y up).
 * `k` is derived from real relief: metres of height range per metre of surface,
 * divided by the Sobel gain. Without that anchor, one texel of grain produces a
 * 70-degree normal and every rough surface turns into glitter.
 */
function bakeNormal(S, k, clampV = false) {
  const { w, h } = S, H = S.height;
  const c = new Uint8ClampedArray(w * h * 4);
  const xm = new Int32Array(w), xp = new Int32Array(w);
  for (let x = 0; x < w; x++) { xm[x] = (x - 1 + w) % w; xp[x] = (x + 1) % w; }
  for (let y = 0; y < h; y++) {
    const rm = ((y - 1 + h) % h) * w, r0 = y * w, rp = ((y + 1) % h) * w;
    const dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const a = xm[x], b = xp[x];
      const gx = (H[rm + b] + 2 * H[r0 + b] + H[rp + b]) - (H[rm + a] + 2 * H[r0 + a] + H[rp + a]);
      const gy = (H[rp + a] + 2 * H[rp + x] + H[rp + b]) - (H[rm + a] + 2 * H[rm + x] + H[rm + b]);
      // v runs opposite to the painted y, so the green channel takes +gy.
      const nx = -gx * k, ny = gy * k;
      const inv = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (dst + x) * 4;
      c[o] = nx * inv + 127.5; c[o + 1] = ny * inv + 127.5; c[o + 2] = inv + 127.5;
      c[o + 3] = 255;
    }
  }
  return finishTexture(new THREE.DataTexture(new Uint8Array(c.buffer), w, h, THREE.RGBAFormat));
}

/** R=AO, G=roughness/roughScalar, B=metalness/metalScalar (glTF ORM layout). */
/**
 * Packed ORM, box-filtered to half resolution. AO, roughness and metalness are
 * all low-frequency compared with albedo and normals, so half res is visually
 * free and saves a third of the library's VRAM.
 */
function bakeORM(S, roughScalar, metalScalar, clampV = false) {
  const sw = S.w, sh = S.h, w = sw >> 1, h = sh >> 1;
  const c = new Uint8ClampedArray(w * h * 4);
  const ir = 63.75 / (roughScalar || 1), im = metalScalar > 0 ? 63.75 / metalScalar : 0;
  const AO = S.ao, RG = S.rough, MT = S.metal;
  for (let y = 0; y < h; y++) {
    const r0 = (sh - 2 - y * 2) * sw, r1 = (sh - 1 - y * 2) * sw, dst = y * w;
    for (let x = 0; x < w; x++) {
      const a = r0 + x * 2, b = r1 + x * 2, o = (dst + x) * 4;
      c[o] = (AO[a] + AO[a + 1] + AO[b] + AO[b + 1]) * 63.75;
      c[o + 1] = (RG[a] + RG[a + 1] + RG[b] + RG[b + 1]) * ir;
      c[o + 2] = (MT[a] + MT[a + 1] + MT[b] + MT[b + 1]) * im;
      c[o + 3] = 255;
    }
  }
  return finishTexture(new THREE.DataTexture(new Uint8Array(c.buffer), w, h, THREE.RGBAFormat));
}

/* ========================================================================== *
 * TextureFactory
 * ========================================================================== */

export default class TextureFactory {
  /**
   * @param {object} o
   * @param {number} o.scale  resolution multiplier from the quality preset
   * @param {number} o.seed   master seed; the whole library is deterministic
   */
  constructor({ scale = 1, seed = 20240826 } = {}) {
    this.scale = scale;
    this.seed = seed;
    this._pools = new Map();     // size -> { arrays, cursor }
    this._canvases = new Map();  // "wxh" -> canvas
    this._grain = new Map();     // size -> white-noise field
    this._bank = null;
    this.stats = { bankMs: 0, texels: 0, textures: 0, timings: [] };
  }

  /* ---- noise bank ------------------------------------------------------- */

  bank() {
    if (this._bank) return this._bank;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const s = this.seed;
    const w16 = worleyFields(BANK, 16, s + 401);
    const w96 = worleyFields(BANK, 96, s + 507);
    const rough = fbmField(BANK, 8, 5, 0.55, s + 311);
    const ridged = new Float32Array(BANK * BANK);
    for (let i = 0; i < ridged.length; i++) ridged[i] = 1 - Math.abs(rough[i] * 2 - 1);
    this._bank = {
      A: fbmField(BANK, 4, 6, 0.5, s + 17),      // broad mottling
      B: rough,                                   // punchier mid detail
      E: ridged,                                  // veins / streak cores
      C: w16.f1, D: w16.edge, S: w16.id,          // coarse cells (stones, patches)
      c: w96.f1, d: w96.edge, s: w96.id,          // fine cells (aggregate, pits)
    };
    this.stats.bankMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return this._bank;
  }

  /* ---- scratch buffers -------------------------------------------------- */

  _pool() {
    const key = this.w * this.h;
    let p = this._pools.get(key);
    if (!p) { p = { arrays: [], cursor: 0 }; this._pools.set(key, p); }
    return p;
  }
  scratch() {
    const p = this._pool();
    if (p.cursor === p.arrays.length) p.arrays.push(new Float32Array(this.w * this.h));
    return p.arrays[p.cursor++];
  }

  /** Bind the factory to a working resolution and reset the scratch cursor. */
  begin(w, h, seed) {
    this.w = w; this.h = h;
    this.rand = rng(this.seed ^ Math.imul(seed | 0, 2654435761));
    this._pool().cursor = 0;
    return this;
  }

  /**
   * Sample a bank channel, tiled `sx` x `sy` times across the surface.
   * Integer tile counts keep the result seamless. Keep sx,sy <= 2 at 1024 and
   * <= 1 at 512 for a 1:1 texel match; higher values deliberately alias into
   * fine grain, which is fine for dirt masks but not for structure.
   */
  noise(ch, sx = 1, sy = sx, jitter = true) {
    const src = this.bank()[ch];
    const { w, h } = this;
    const out = this.scratch();
    const ox = jitter ? this.rand.int(BANK) : 0;
    const oy = jitter ? this.rand.int(BANK) : 0;
    const tx = this._axis(w, sx, ox), ty = this._axis(h, sy, oy);
    for (let y = 0; y < h; y++) {
      const r0 = ty.i0[y] * BANK, r1 = ty.i1[y] * BANK, fy = ty.f[y], row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = tx.i0[x], x1 = tx.i1[x], fx = tx.f[x];
        const a = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
        const b = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
        out[row + x] = a + (b - a) * fy;
      }
    }
    return out;
  }

  _axis(res, tiles, offset) {
    const key = `${res}:${tiles}:${offset}`;
    let t = this._axisCache?.get(key);
    if (t) return t;
    const i0 = new Int32Array(res), i1 = new Int32Array(res), f = new Float32Array(res);
    for (let i = 0; i < res; i++) {
      const p = ((i + 0.5) * BANK * tiles) / res + offset;
      const a = Math.floor(p);
      i0[i] = ((a % BANK) + BANK) % BANK;
      i1[i] = (i0[i] + 1) % BANK;
      f[i] = p - a;
    }
    t = { i0, i1, f };
    if (!this._axisCache) this._axisCache = new Map();
    if (this._axisCache.size > 240) this._axisCache.clear();
    this._axisCache.set(key, t);
    return t;
  }

  /** Per-pixel white noise (fresh offset each call) — sub-texel grain. */
  grain() {
    const { w, h } = this, n = w * h;
    let g = this._grain.get(n);
    if (!g) {
      g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = hash2i(i & 8191, i >> 13, this.seed + 77);
      this._grain.set(n, g);
    }
    const out = this.scratch();
    const off = this.rand.int(n);
    for (let i = 0; i < n; i++) { const j = i + off; out[i] = g[j >= n ? j - n : j]; }
    return out;
  }

  /**
   * A random constant per cell of an nx x ny grid. Much cheaper than Worley and
   * the right tool for mineral speckle where cells are only a few texels wide.
   */
  cells(nx, ny, opts = {}) {
    const { w, h } = this;
    const out = this.scratch();
    const seed = this.rand.int(1e9);
    const round = opts.round || 0;      // 0 = flat cells, 1 = round blobs
    const cw = w / nx, chh = h / ny, icw = 1 / cw, ich = 1 / chh;
    // Per-cell tables: one hash per cell instead of one (or three) per pixel.
    const nC = nx * ny;
    const val = new Float32Array(nC);
    const jx = round > 0 ? new Float32Array(nC) : null;
    const jy = round > 0 ? new Float32Array(nC) : null;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      val[k] = hash2i(i, j, seed);
      if (round > 0) { jx[k] = hash2i(i, j, seed + 5) * 0.6 + 0.2; jy[k] = hash2i(i, j, seed + 9) * 0.6 + 0.2; }
    }
    // Column index table — the divide per pixel is the hot part otherwise.
    const cxi = new Int32Array(w), cxf = new Float32Array(w);
    for (let x = 0; x < w; x++) { const t = x * icw; const g = Math.min(nx - 1, t | 0); cxi[x] = g; cxf[x] = t - g; }
    for (let y = 0; y < h; y++) {
      const t = y * ich, gy = Math.min(ny - 1, t | 0), fy = t - gy, row = y * w, base = gy * nx;
      for (let x = 0; x < w; x++) {
        const k = base + cxi[x];
        let v = val[k];
        if (round > 0) {
          const dx = cxf[x] - jx[k], dy = fy - jy[k];
          const d2 = (dx * dx + dy * dy) * 5.76;      // (2.4 * d)^2, sqrt avoided
          if (d2 > 0.25) {
            let t = (d2 - 0.25) * 0.9070;             // 1 / (1.05^2 - 0.5^2)
            if (t > 1) t = 1;
            v *= 1 - round * t * t * (3 - 2 * t);
          }
        }
        out[row + x] = v;
      }
    }
    return out;
  }

  /* ---- canvas rasterisation (vector shapes: cracks, leaves, blades) ------ */

  /**
   * Cached 2D surface + context. The context is created once, with
   * willReadFrequently, because every mask does a getImageData readback and
   * Chrome only honours the hint on the call that creates the context.
   */
  _canvas(w, h) {
    const key = w + 'x' + h;
    let c = this._canvases.get(key);
    if (!c) {
      const el = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      c = { el, g: el.getContext('2d', { willReadFrequently: true, alpha: true }) };
      this._canvases.set(key, c);
    }
    return c;
  }

  /**
   * Rasterise vector art into a 0..1 coverage mask. `draw(g, wrap)` gets a 2D
   * context; `wrap(x, y, r, fn)` repeats a shape across the tile seam so the
   * result stays tileable.
   */
  /**
   * Rasterise vector art into a 0..1 coverage mask.
   *
   * Defaults to half resolution: cracks, patches and gum are low-frequency
   * shapes, and getImageData at 1024^2 allocates 4 MB and copies a million
   * pixels per call — at four or five masks per recipe that was the single
   * most expensive thing in the whole library. Half res is 4x cheaper and,
   * bilinearly upsampled, visually identical.
   */
  mask(draw, div = 2) {
    const w = (this.w / div) | 0, h = (this.h / div) | 0;
    const g = this._canvas(w, h).g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    const W = this.w, H = this.h;                  // wrap in unscaled coordinates
    const wrap = (x, y, r, fn) => {
      const xs = x < r ? [0, W] : x > W - r ? [0, -W] : [0];
      const ys = y < r ? [0, H] : y > H - r ? [0, -H] : [0];
      for (const dx of xs) for (const dy of ys) {
        if (dx || dy) { g.save(); g.translate(dx, dy); fn(g); g.restore(); } else fn(g);
      }
    };
    if (div !== 1) g.scale(1 / div, 1 / div);
    draw(g, wrap);
    const px = g.getImageData(0, 0, w, h).data;
    const out = this.scratch();
    if (div === 1) {
      for (let i = 0, p = 3; i < out.length; i++, p += 4) out[i] = px[p] * (1 / 255);
    } else {
      const W = this.w, H = this.h, k = 1 / (255 * div);
      // Bilinear upsample with wrapped edges, so the mask stays tileable.
      const xi = new Int32Array(W), xj = new Int32Array(W), xf = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const t = (x + 0.5) / div - 0.5, a = Math.floor(t);
        xi[x] = ((a % w) + w) % w; xj[x] = (xi[x] + 1) % w; xf[x] = t - a;
      }
      for (let y = 0; y < H; y++) {
        const t = (y + 0.5) / div - 0.5, a = Math.floor(t);
        const r0 = (((a % h) + h) % h) * w, r1 = ((((a % h) + h) % h + 1) % h) * w;
        const fy = t - a, dr = y * W;
        for (let x = 0; x < W; x++) {
          const i0 = xi[x], i1 = xj[x], fx = xf[x];
          const a0 = px[(r0 + i0) * 4 + 3], b0 = px[(r0 + i1) * 4 + 3];
          const a1 = px[(r1 + i0) * 4 + 3], b1 = px[(r1 + i1) * 4 + 3];
          const u = a0 + (b0 - a0) * fx, v = a1 + (b1 - a1) * fx;
          out[dr + x] = (u + (v - u) * fy) * (1 / 255);
        }
      }
      void k;
    }
    return out;
  }

  /**
   * Generate a meandering polyline — cracks, tar snakes, tree roots.
   * Returns the points rather than drawing them: a crack has to be stroked
   * once per wrap offset, and re-walking the RNG for each copy would make the
   * copies diverge, which quietly breaks tileability.
   */
  crackPts(x, y, len, step, wander, r) {
    const pts = [x, y];
    let a = r() * 6.283185307;
    for (let d = 0; d < len; d += step) {
      a += (r() - 0.5) * wander;
      x += Math.cos(a) * step; y += Math.sin(a) * step;
      pts.push(x, y);
    }
    return pts;
  }

  /** Stroke a point list produced by crackPts. */
  strokePts(g, pts) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
  }

  /* ---- shared weathering passes ----------------------------------------- */

  /**
   * Vertical grime running down from a per-column start height. Real facades
   * are streaked, never evenly dirty; this is what sells stone and concrete.
   */
  streaks(S, { amount = 0.5, color = [0.09, 0.085, 0.08], freq = 8, rough = 0.03, fade = 0.55 } = {}) {
    const { w, h } = this;
    const n = this.noise('E', freq, 1);
    const start = this.noise('A', freq >> 1 || 1, 1);
    for (let y = 0; y < h; y++) {
      const v = y / h, row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const s0 = start[i] * fade;
        const run = smoothstep(s0, s0 + 0.12, v) * (1 - smoothstep(s0 + 0.45, 1.25, v) * 0.55);
        const t = sat((n[i] - 0.45) * 2.6) * run * amount;
        if (t <= 0) continue;
        S.mix(i, color, t);
        S.rough[i] = sat(S.rough[i] + t * rough);
      }
    }
  }

  /** Darken and roughen the low points — dirt only ever collects in crevices. */
  cavityDirt(S, { amount = 0.5, color = [0.11, 0.10, 0.09], depth = 0.35, rough = 0.02 } = {}) {
    for (let i = 0; i < S.n; i++) {
      const c = smoothstep(depth, 0, S.height[i]) * amount;
      if (c <= 0) continue;
      S.mix(i, color, c);
      S.ao[i] *= 1 - c * 0.5;
      S.rough[i] = sat(S.rough[i] + c * rough);
    }
  }

  /** Ambient occlusion from the height field: a cheap blurred cavity term. */
  bakeAO(S, strength = 0.7, radius = 6) {
    const { w, h } = this, H = S.height;
    const tmp = this.scratch(), blur = this.scratch();
    const r = Math.max(1, Math.round(radius * (w / 1024)));
    const inv = 1 / (2 * r + 1);
    // Wrapped running-sum box blur. The index tables replace two modulos per
    // pixel per pass, which is most of the cost at 1024^2.
    const fx = new Int32Array(w), bx = new Int32Array(w);
    for (let x = 0; x < w; x++) { fx[x] = (x + r + 1) % w; bx[x] = (x - r + w) % w; }
    const fy = new Int32Array(h), by = new Int32Array(h);
    for (let y = 0; y < h; y++) { fy[y] = ((y + r + 1) % h) * w; by[y] = ((y - r + h) % h) * w; }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += H[row + ((k + w) % w)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        acc += H[row + fx[x]] - H[row + bx[x]];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(((k + h) % h)) * w + x];
      for (let y = 0; y < h; y++) {
        blur[y * w + x] = acc * inv;
        acc += tmp[fy[y] + x] - tmp[by[y] + x];
      }
    }
    for (let i = 0; i < S.n; i++) {
      const occ = sat((blur[i] - H[i]) * 2.2);
      S.ao[i] = sat(S.ao[i] * (1 - occ * strength));
    }
  }

  /* ---- surface allocation ----------------------------------------------- */

  surface(w, h) {
    const key = 's' + w + 'x' + h;
    let s = this._pools.get(key);
    if (!s) { s = new Surface(w, h); this._pools.set(key, s); }
    return s;
  }

  /**
   * Run a recipe and bake it. Returns { map, normalMap, ormMap, meta }.
   * Buffers are pooled and reused, so the CPU cost of 30+ materials stays flat.
   */
  build(name, recipe) {
    const t0 = performance.now();
    const q = Math.max(0.25, this.scale);
    const w = Math.max(128, Math.round((recipe.res || 512) * q / 4) * 4);
    const h = Math.max(128, Math.round((recipe.resY || recipe.res || 512) * q / 4) * 4);
    const S = this.surface(w, h);
    this.begin(w, h, hash2i(name.charCodeAt(0), name.length, this.seed) * 1e9);
    S.reset(recipe.base || [0.5, 0.5, 0.5], recipe.rough ?? 0.9);
    const meta = recipe.paint(S, this, recipe) || {};
    const rs = meta.roughScalar ?? recipe.roughScalar ?? 1;
    const ms = meta.metalScalar ?? recipe.metalScalar ?? 0;
    const out = {
      map: bakeAlbedo(S, recipe.opaque !== false, recipe.gain ?? 1, recipe.floor ?? 0.045, recipe.clampV),
      normalMap: recipe.normal === false ? null
        : bakeNormal(S, (recipe.relief ?? 0.015) * w /
            (8 * (recipe.tile || 1)) * (recipe.normalStrength ?? 1), recipe.clampV),
      ormMap: recipe.orm === false ? null : bakeORM(S, rs, ms, recipe.clampV),
      roughScalar: rs, metalScalar: ms, w, h,
    };
    this.stats.texels += w * h * (1 + (out.normalMap ? 1 : 0) + (out.ormMap ? 0.25 : 0));
    this.stats.textures += 1 + (out.normalMap ? 1 : 0) + (out.ormMap ? 1 : 0);
    this.stats.timings.push([name, performance.now() - t0]);
    this.lastSurface = S;
    this.lastRelief = (recipe.relief ?? 0.015) * w / (8 * (recipe.tile || 1)) * (recipe.normalStrength ?? 1);
    return out;
  }

  /** Allocate a square 2x2 atlas surface. */
  newAtlas(size) {
    const A = new Surface(size, size);
    A.reset([0.5, 0.5, 0.5], 0.9);
    return A;
  }

  /**
   * Copy a painted tile into an atlas at (ox, oy), rescaling its height so a
   * single Sobel pass over the atlas still produces the right slope for a tile
   * whose physical relief differs from the reference.
   */
  blitTile(A, S, ox, oy, heightRatio = 1) {
    for (let y = 0; y < S.h; y++) {
      const sr = y * S.w, dr = (oy + y) * A.w + ox;
      for (let x = 0; x < S.w; x++) {
        const i = sr + x, o = dr + x;
        A.r[o] = S.r[i]; A.g[o] = S.g[i]; A.b[o] = S.b[i];
        A.rough[o] = S.rough[i]; A.metal[o] = S.metal[i]; A.ao[o] = S.ao[i];
        A.height[o] = 0.5 + (S.height[i] - 0.5) * heightRatio;
      }
    }
  }

  /** Bake an assembled atlas: colour + normal only, clamped, no ORM. */
  bakeAtlas(A, k, gain = 1) {
    const prevW = this.w, prevH = this.h;
    this.w = A.w; this.h = A.h;
    const map = bakeAlbedo(A, true, gain, 0.045);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    const nrm = bakeNormal(A, k);
    nrm.wrapS = nrm.wrapT = THREE.ClampToEdgeWrapping;
    this.w = prevW; this.h = prevH;
    return { map, nrm };
  }

  /** Free CPU scratch memory once the library is built. */
  release() {
    this._pools.clear();
    this._grain.clear();
    this._axisCache?.clear();
    this._bank = null;
    for (const c of this._canvases.values()) { c.el.width = 1; c.el.height = 1; }
    this._canvases.clear();
  }
}

/* ========================================================================== *
 * Recipes
 * Each entry: { res, tile (metres), base, rough, paint(S, F, o) }
 * `tile` is documented for consumers: uv 1.0 spans `tile` metres.
 * ========================================================================== */

/* ---- masonry -------------------------------------------------------------*/

/**
 * Federal-period brickwork. Running bond, per-brick firing variation, lime
 * mortar, soot in the joints, efflorescence blooms and the occasional vitrified
 * (glazed) header you see all over the North End and Beacon Hill.
 */
function paintBrick(S, F, o) {
  const { w, h } = F;
  const cols = o.cols, rows = o.rows;
  const bw = w / cols, bh = h / rows;
  const halfJoint = (o.joint / o.tile) * w * 0.5;
  const R = F.rand;

  const mottle = F.noise('A', 2, 2);
  const fine = F.noise('B', 2, 2);
  const gr = F.grain();
  const pore = F.cells(w >> 1, h >> 1, {});

  // Per-brick constants, resolved once.
  const nB = cols * rows;
  const bTone = new Float32Array(nB), bPal = new Uint8Array(nB), bGlaze = new Uint8Array(nB);
  const bChip = new Float32Array(nB * 3), bH = new Float32Array(nB);
  for (let k = 0; k < nB; k++) {
    bTone[k] = sat(0.5 + R.gauss(0, 0.31));
    const p = R();
    bPal[k] = p < 0.10 ? 3 : p < 0.32 ? 2 : p < 0.74 ? 1 : 0;
    bGlaze[k] = (R() < o.glazed) ? 1 : 0;
    bH[k] = R.range(-0.035, 0.035);
    if (R() < 0.10) { bChip[k * 3] = R(); bChip[k * 3 + 1] = R() < 0.5 ? 0 : 1; bChip[k * 3 + 2] = R.range(0.10, 0.26); }
    else bChip[k * 3 + 2] = 0;
  }

  const pal = o.palette, mortar = o.mortar, mortar2 = o.mortar2;
  const glaze = hx('#2c2530');
  const chipCol = o.chip;

  for (let y = 0; y < h; y++) {
    const vv = (y + 0.5) / h, row = y * w;
    const jr = Math.floor(vv * rows);
    const fy = vv * rows - jr;
    const off = (jr & 1) * 0.5;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const uu = (x + 0.5) / w;
      const t = uu * cols + off;
      let ic = Math.floor(t);
      const fx = t - ic;
      ic = ((ic % cols) + cols) % cols;
      const k = jr * cols + ic;

      const dx = Math.min(fx, 1 - fx) * bw, dy = Math.min(fy, 1 - fy) * bh;
      const dEdge = Math.min(dx, dy) - halfJoint;
      const isBrick = smoothstep(-0.6, 0.8, dEdge);

      // --- mortar -------------------------------------------------------
      const mv = mottle[i] * 0.5 + fine[i] * 0.5;
      let cr = lerp(mortar[0], mortar2[0], mv), cg = lerp(mortar[1], mortar2[1], mv), cb = lerp(mortar[2], mortar2[2], mv);
      const sandy = (gr[i] - 0.5) * 0.09;
      cr += sandy; cg += sandy; cb += sandy;
      let rough = 0.96, height = 0.34 + mv * 0.05 + (gr[i] - 0.5) * 0.03;

      if (isBrick > 0) {
        const p = pal[bPal[k]];
        const tone = bTone[k] * 0.62 + 0.70;
        // Firing blush varies mostly *within* a brick, not smoothly across the
        // wall — a low-frequency blob spanning several bricks reads as fake.
        const im = mottle[i] * 0.22 + fine[i] * 0.78;
        let br = p[0] * tone, bg2 = p[1] * tone, bb = p[2] * tone;
        const blush = (im - 0.5) * 0.26;
        br += blush * 1.25; bg2 += blush * 0.62; bb += blush * 0.40;
        const pk = (pore[i] - 0.5) * 0.10 + (gr[i] - 0.5) * 0.06;
        br += pk; bg2 += pk; bb += pk;
        let bRough = 0.90 + (im - 0.5) * 0.06;
        let bHt = 0.80 + bH[k] + (im - 0.5) * 0.045 + (gr[i] - 0.5) * 0.02;

        if (bGlaze[k]) {                                   // vitrified header
          br = lerp(br, glaze[0], 0.72); bg2 = lerp(bg2, glaze[1], 0.72); bb = lerp(bb, glaze[2], 0.72);
          bRough = 0.30 + (im - 0.5) * 0.08;
        }
        // Chipped corner: fresher, lighter clay and a bite out of the height.
        const cs = bChip[k * 3 + 2];
        if (cs > 0) {
          const cx = bChip[k * 3] < 0.5 ? 0 : 1, cy = bChip[k * 3 + 1];
          const ddx = (fx - cx) * bw / bh, ddy = fy - cy;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          const c = smoothstep(cs, cs * 0.45, d) * (0.6 + mottle[i] * 0.6);
          if (c > 0) {
            br = lerp(br, chipCol[0], c); bg2 = lerp(bg2, chipCol[1], c); bb = lerp(bb, chipCol[2], c);
            bHt -= c * 0.16; bRough = lerp(bRough, 0.97, c);
          }
        }
        // Rounded arris where the brick meets the joint.
        const arris = smoothstep(0, 2.2, dEdge);
        bHt = lerp(0.52, bHt, arris * 0.75 + 0.25);

        cr = lerp(cr, br, isBrick); cg = lerp(cg, bg2, isBrick); cb = lerp(cb, bb, isBrick);
        rough = lerp(rough, bRough, isBrick);
        height = lerp(height, bHt, isBrick);
      }

      S.r[i] = cr; S.g[i] = cg; S.b[i] = cb;
      S.rough[i] = rough; S.height[i] = height;
    }
  }

  // Soot: heavier in the joints, streaking downward. Boston brick is filthy.
  const soot = F.noise('E', 6, 1);
  const sootBroad = F.noise('A', 1, 1);
  const sc = o.soot;
  for (let i = 0; i < S.n; i++) {
    const cavity = 1 - smoothstep(0.4, 0.8, S.height[i]);
    const t = sat((soot[i] - 0.34) * 2.1) * (0.30 + sootBroad[i] * 1.15) * o.sootAmt * (0.40 + cavity * 1.05);
    if (t <= 0) continue;
    S.mix(i, sc, t);
    S.rough[i] = sat(S.rough[i] + t * 0.05);
  }

  // Efflorescence — salt bloom leaching through the mortar.
  const eff = F.noise('B', 1, 1);
  const eff2 = F.noise('A', 3, 3);
  const white = hx('#e8e6dd');
  for (let i = 0; i < S.n; i++) {
    const t = smoothstep(0.60, 0.86, eff[i] * 0.65 + eff2[i] * 0.35) * o.efflor
      * (1 - smoothstep(0.55, 0.85, S.height[i]) * 0.45);
    if (t <= 0) continue;
    S.mix(i, white, t * 0.75);
    S.rough[i] = sat(S.rough[i] + t * 0.06);
  }

  F.bakeAO(S, 0.85, 7);
  return { roughScalar: 0.97 };
}

const BRICK_RED = {
  res: 512, tile: 2.03, cols: 10, rows: 30, joint: 0.011, normalStrength: 1.15, relief: 0.016, gain: 1.48,
  base: hx('#6b3327'), rough: 0.92, glazed: 0.06, sootAmt: 0.72, efflor: 0.30,
  // North End / Beacon Hill oxblood, with over-fired near-black outliers.
  palette: [hx('#8a4834'), hx('#743425'), hx('#57271f'), hx('#3b1d19')],
  mortar: hx('#a29a89'), mortar2: hx('#77705f'), chip: hx('#a8654c'), soot: hx('#1b1917'),
  paint: paintBrick,
};

const BRICK_BROWN = {
  ...BRICK_RED, res: 512, tile: 2.03, gain: 1.39,
  base: hx('#5e4433'), glazed: 0.03, sootAmt: 0.85, efflor: 0.20,
  palette: [hx('#7d5c42'), hx('#674a34'), hx('#4f3a2a'), hx('#372721')],
  mortar: hx('#7d7568'), mortar2: hx('#5b5750'), chip: hx('#9a7451'), soot: hx('#191715'),
};

/** Beacon Hill / Acorn Street setts: rounded, irregular, polished by traffic. */
const COBBLESTONE = {
  res: 512, tile: 2.4, base: hx('#5c5a58'), rough: 0.9, normalStrength: 1.6, relief: 0.050,
  paint(S, F) {
    const { w, h } = F;
    const stone = F.noise('C', 1, 1, false);
    const edge = F.noise('D', 1, 1, false);
    const id = F.noise('S', 1, 1, false);
    const mott = F.noise('A', 2, 2);
    const fine = F.noise('B', 4, 4);
    const gr = F.grain();
    const polish = F.noise('A', 1, 1);   // seamless broad wheel-wear
    const wet = F.noise('B', 1, 1);
    const grit = F.cells(w >> 1, h >> 1, {});

    const pal = [
      hx('#8b877e'), hx('#726f6a'), hx('#9a9186'), hx('#5c5a5b'),
      hx('#7c6d5e'), hx('#69626e'), hx('#948b7c'), hx('#635e5d'),
    ];
    const joint = hx('#484540'), jointLo = hx('#2b2926'), moss = hx('#47552f');

    for (let i = 0; i < S.n; i++) {
      const e = edge[i];
      const cap = smoothstep(0.020, 0.075, e);           // 0 in the joint, 1 on the stone
      const dome = Math.pow(sat(e / 0.30), 0.55);
      const c = pal[(id[i] * pal.length) | 0];
      const tone = 0.82 + id[i] * 0.36 + (mott[i] - 0.5) * 0.22;
      let r = c[0] * tone, g = c[1] * tone, b = c[2] * tone;

      // Granite grain on the sett face.
      const sp = (grit[i] - 0.5) * 0.16 + (gr[i] - 0.5) * 0.10 + (fine[i] - 0.5) * 0.10;
      r += sp; g += sp; b += sp;

      let rough = 0.88 + (fine[i] - 0.5) * 0.07;
      // Wheel-path polish: smoother, greyer, slightly darker.
      const pol = smoothstep(0.52, 0.86, polish[i]) * (0.35 + dome * 0.9);
      rough = lerp(rough, 0.34, pol * 0.85);
      r = lerp(r, r * 0.86 + 0.06, pol * 0.5); g = lerp(g, g * 0.86 + 0.06, pol * 0.5); b = lerp(b, b * 0.88 + 0.07, pol * 0.5);

      let height = 0.30 + dome * 0.62 + (fine[i] - 0.5) * 0.03 * cap;

      // Joint: sand, grit, moss and standing water.
      if (cap < 1) {
        const jd = 1 - cap;
        const jr = lerp(joint[0], jointLo[0], sat(1 - e * 14)), jg = lerp(joint[1], jointLo[1], sat(1 - e * 14)), jb = lerp(joint[2], jointLo[2], sat(1 - e * 14));
        const gsp = (grit[i] - 0.5) * 0.22;
        r = lerp(r, jr + gsp, jd); g = lerp(g, jg + gsp, jd); b = lerp(b, jb + gsp, jd);
        const puddle = smoothstep(0.58, 0.9, wet[i]) * jd;
        rough = lerp(lerp(rough, 0.95, jd), 0.10, puddle);
        const mo = smoothstep(0.62, 0.92, mott[i]) * jd * 0.7;
        r = lerp(r, moss[0], mo); g = lerp(g, moss[1], mo); b = lerp(b, moss[2], mo);
        height -= jd * 0.06;
      }

      S.r[i] = r; S.g[i] = g; S.b[i] = b;
      S.rough[i] = rough; S.height[i] = height; S.metal[i] = 0;
    }
    F.bakeAO(S, 1.0, 9);
    return { roughScalar: 0.96 };
  },
};

/** Back Bay brownstone: warm chocolate sandstone, bedded and spalling. */
const BROWNSTONE = {
  res: 512, tile: 2.4, base: hx('#5c3b2a'), rough: 0.85, normalStrength: 1.0, relief: 0.022, gain: 1.14,
  paint(S, F) {
    const { w, h } = F;
    const cols = 2, rows = 4;
    const bw = w / cols, bh = h / rows, halfJoint = (0.008 / 2.4) * w * 0.5;
    const R = F.rand;
    const bed = F.noise('B', 1, 20);          // horizontal bedding laminations
    const mott = F.noise('A', 2, 2);
    const fine = F.noise('B', 3, 3);
    const spall = F.noise('C', 2, 2);
    const gr = F.grain();
    const sandGrain = F.cells(w, h, {});

    const pal = [hx('#6b4530'), hx('#5a3827'), hx('#7a5238'), hx('#4c2e21')];
    const jointC = hx('#3b2d24');
    const weathered = hx('#8a6d55');

    const nB = cols * rows;
    const bTone = new Float32Array(nB), bPal = new Uint8Array(nB), bRub = new Uint8Array(nB);
    for (let k = 0; k < nB; k++) { bTone[k] = R.range(0.86, 1.14); bPal[k] = R.int(4); bRub[k] = R() < 0.35 ? 1 : 0; }

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const jr = Math.floor(vv * rows), fy = vv * rows - jr;
      const off = (jr & 1) * 0.5;
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const t = uu * cols + off;
        let ic = Math.floor(t); const fx = t - ic;
        ic = ((ic % cols) + cols) % cols;
        const k = jr * cols + ic;
        const dEdge = Math.min(Math.min(fx, 1 - fx) * bw, Math.min(fy, 1 - fy) * bh) - halfJoint;
        const face = smoothstep(-0.5, 1.0, dEdge);

        const p = pal[bPal[k]], tone = bTone[k];
        let r = p[0] * tone, g = p[1] * tone, b = p[2] * tone;
        // Bedding planes: thin darker/lighter laminations, the giveaway of sandstone.
        const lam = (bed[i] - 0.5) * 0.16;
        r += lam * 1.0; g += lam * 0.82; b += lam * 0.66;
        const sg = (sandGrain[i] - 0.5) * 0.075 + (gr[i] - 0.5) * 0.05 + (fine[i] - 0.5) * 0.06;
        r += sg; g += sg; b += sg;

        let rough = (bRub[k] ? 0.70 : 0.86) + (fine[i] - 0.5) * 0.07;
        let height = 0.78 + (bed[i] - 0.5) * 0.05 + (gr[i] - 0.5) * 0.02;

        // Delamination: the outer skin has flaked away in sharp-edged patches.
        const sp = smoothstep(0.46, 0.30, spall[i]) * smoothstep(0.35, 0.55, mott[i]);
        if (sp > 0) {
          r = lerp(r, weathered[0] * 0.92, sp * 0.85);
          g = lerp(g, weathered[1] * 0.92, sp * 0.85);
          b = lerp(b, weathered[2] * 0.92, sp * 0.85);
          rough = lerp(rough, 0.95, sp);
          height -= sp * 0.10;
        }

        if (face < 1) {
          const jd = 1 - face;
          r = lerp(r, jointC[0], jd); g = lerp(g, jointC[1], jd); b = lerp(b, jointC[2], jd);
          rough = lerp(rough, 0.94, jd);
          height = lerp(height, 0.40, jd);
        }
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.streaks(S, { amount: 0.42, color: hx('#1e1712'), freq: 8, rough: 0.03, fade: 0.5 });
    F.bakeAO(S, 0.8, 6);
    return { roughScalar: 0.96 };
  },
};

/** New England grey granite — Quincy/Barre. Quartz, feldspar, biotite. */
const GRANITE = {
  res: 512, tile: 2.4, base: hx('#8b8a86'), rough: 0.78, normalStrength: 0.75, relief: 0.012,
  paint(S, F) {
    const { w, h } = F;
    const cols = 2, rows = 4;
    const bw = w / cols, bh = h / rows, halfJoint = (0.006 / 2.4) * w * 0.5;
    const R = F.rand;

    // Three mineral populations at different crystal sizes.
    const cA = F.cells(Math.round(w / 2.5), Math.round(h / 2.5), { round: 0.55 });
    const cB = F.cells(Math.round(w / 5), Math.round(h / 5), { round: 0.7 });
    const cC = F.cells(Math.round(w / 11), Math.round(h / 11), { round: 0.85 });
    const gr = F.grain();
    const mott = F.noise('A', 2, 2);
    const lich = F.noise('C', 3, 3);

    const matrix = hx('#adaca6'), quartz = hx('#d2d1ca'), feld = hx('#e0d7c4');
    const biotite = hx('#3a3a3f'), horn = hx('#636365'), jointC = hx('#66655f');
    const lichen = hx('#a8b09a');

    const nB = cols * rows;
    const bTone = new Float32Array(nB);
    for (let k = 0; k < nB; k++) bTone[k] = R.range(0.93, 1.07);

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const jr = Math.floor(vv * rows), fy = vv * rows - jr;
      const off = (jr & 1) * 0.5;
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const t = uu * cols + off;
        let ic = Math.floor(t); const fx = t - ic;
        ic = ((ic % cols) + cols) % cols;
        const dEdge = Math.min(Math.min(fx, 1 - fx) * bw, Math.min(fy, 1 - fy) * bh) - halfJoint;
        const face = smoothstep(-0.5, 1.0, dEdge);
        const tone = bTone[jr * cols + ic] * (0.96 + mott[i] * 0.08);

        let r = matrix[0], g = matrix[1], b = matrix[2];
        let rough = 0.80, height = 0.74;

        const a = cA[i], bb2 = cB[i], cc = cC[i];
        if (a > 0.86) { r = quartz[0]; g = quartz[1]; b = quartz[2]; height += 0.05; }
        else if (a < 0.13) { r = biotite[0]; g = biotite[1]; b = biotite[2]; rough = 0.62; height -= 0.05; }
        if (bb2 > 0.90) { r = lerp(r, feld[0], 0.85); g = lerp(g, feld[1], 0.85); b = lerp(b, feld[2], 0.85); height += 0.04; }
        else if (bb2 < 0.08) { r = lerp(r, horn[0], 0.8); g = lerp(g, horn[1], 0.8); b = lerp(b, horn[2], 0.8); }
        if (cc > 0.945) { r = lerp(r, feld[0], 0.7); g = lerp(g, feld[1], 0.7); b = lerp(b, feld[2], 0.7); height += 0.05; }

        // Flamed finish: pitted micro-relief.
        const pit = (gr[i] - 0.5);
        r += pit * 0.055; g += pit * 0.055; b += pit * 0.055;
        height += pit * 0.05;
        r *= tone; g *= tone; b *= tone;
        rough += (gr[i] - 0.5) * 0.08;

        // Lichen colonies on old civic stone.
        const lc = smoothstep(0.80, 0.94, lich[i]) * 0.55;
        if (lc > 0) { r = lerp(r, lichen[0], lc); g = lerp(g, lichen[1], lc); b = lerp(b, lichen[2], lc); rough = lerp(rough, 0.95, lc); }

        if (face < 1) {
          const jd = 1 - face;
          r = lerp(r, jointC[0], jd); g = lerp(g, jointC[1], jd); b = lerp(b, jointC[2], jd);
          rough = lerp(rough, 0.92, jd); height = lerp(height, 0.42, jd);
        }
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.streaks(S, { amount: 0.26, color: hx('#26241f'), freq: 10, rough: 0.02, fade: 0.4 });
    F.bakeAO(S, 0.7, 5);
    return { roughScalar: 0.95 };
  },
};

/** Indiana limestone cladding: cream, fine, black grime in the shadow lines. */
const LIMESTONE = {
  res: 512, tile: 2.4, base: hx('#c6bda8'), rough: 0.82, normalStrength: 0.8, relief: 0.011, gain: 1.06,
  paint(S, F) {
    const { w, h } = F;
    const cols = 2, rows = 4;
    const bw = w / cols, bh = h / rows, halfJoint = (0.006 / 2.4) * w * 0.5;
    const R = F.rand;
    const bed = F.noise('B', 1, 12);
    const mott = F.noise('A', 2, 2);
    const fine = F.noise('B', 3, 3);
    const gr = F.grain();
    const fossil = F.cells(Math.round(w / 4), Math.round(h / 7), { round: 0.9 });
    const jointC = hx('#5f5849');
    const pal = [hx('#cfc7b1'), hx('#c3b9a2'), hx('#d5cdb9'), hx('#b8ae98')];
    const nB = cols * rows; const bTone = new Float32Array(nB), bPal = new Uint8Array(nB);
    for (let k = 0; k < nB; k++) { bTone[k] = R.range(0.94, 1.06); bPal[k] = R.int(4); }

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const jr = Math.floor(vv * rows), fy = vv * rows - jr;
      const off = (jr & 1) * 0.5;
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const t = uu * cols + off;
        let ic = Math.floor(t); const fx = t - ic;
        ic = ((ic % cols) + cols) % cols;
        const dEdge = Math.min(Math.min(fx, 1 - fx) * bw, Math.min(fy, 1 - fy) * bh) - halfJoint;
        const face = smoothstep(-0.5, 1.0, dEdge);
        const p = pal[bPal[jr * cols + ic]], tone = bTone[jr * cols + ic];
        let r = p[0] * tone, g = p[1] * tone, b = p[2] * tone;
        const lam = (bed[i] - 0.5) * 0.06 + (mott[i] - 0.5) * 0.07;
        r += lam; g += lam * 0.97; b += lam * 0.92;
        const sg = (gr[i] - 0.5) * 0.045 + (fine[i] - 0.5) * 0.05;
        r += sg; g += sg; b += sg;
        let rough = 0.84 + (fine[i] - 0.5) * 0.06;
        let height = 0.76 + (bed[i] - 0.5) * 0.03 + (gr[i] - 0.5) * 0.02;
        const fo = smoothstep(0.93, 0.99, fossil[i]);
        if (fo > 0) { r = lerp(r, 0.93, fo); g = lerp(g, 0.91, fo); b = lerp(b, 0.86, fo); height += fo * 0.03; }
        if (face < 1) {
          const jd = 1 - face;
          r = lerp(r, jointC[0], jd); g = lerp(g, jointC[1], jd); b = lerp(b, jointC[2], jd);
          rough = lerp(rough, 0.93, jd); height = lerp(height, 0.44, jd);
        }
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.streaks(S, { amount: 0.62, color: hx('#20201c'), freq: 9, rough: 0.03, fade: 0.45 });
    F.bakeAO(S, 0.75, 5);
    return { roughScalar: 0.96 };
  },
};

/* ---- roads ---------------------------------------------------------------*/

/**
 * Per-motif ablation switches for the asphalt tile, 0..1 each.
 *
 * The carriageway's albedo has two independent halves — the procedural terms in
 * the `Roads.js` shader, and the pixels painted here — and until now only the
 * shader half had switches. That is how a motif painted into THIS function
 * survived `setDetail(0)` and `setCrack(0)` unchanged and got misattributed to a
 * shader term for three critic passes running.
 *
 * These gate APPLICATION, never generation: every mask is still built and every
 * `R()` call still happens, so flipping one leaves the rest of the tile
 * bit-identical instead of reshuffling the whole RNG stream downstream. Drive
 * them through `Materials.rebuildRoadAtlas()`, which repaints and re-uploads.
 */
export const ASPHALT_ABLATE = {
  aggregate: 1, patch: 1, patchEdge: 1, crack: 1, oil: 1, ghost: 1,
};

/**
 * Hot-mix asphalt. Exposed aggregate where the binder has ravelled, utility-cut
 * patches with cold joints, hairline cracking and oil dripped where traffic
 * idles.
 *
 * Everything here is at or below a couple of centimetres, deliberately: the
 * tile spans 2.4 m and is the surface of every road in the city, so any motif
 * approaching that size becomes wallpaper. Metre-scale features (the crack
 * network, sealant, cold-patch staining, wheel polish) live in the world-space
 * shader in `Roads.js` where they can be sparse and never repeat.
 */
function paintAsphalt(S, F, o) {
  const ABL = ASPHALT_ABLATE;
  const { w, h } = F;
  const R = F.rand;
  const stone = F.noise('c', 2, 2, false);
  const sid = F.noise('s', 2, 2, false);
  const macro = F.noise('A', 1, 1);
  const mid = F.noise('B', 2, 2);
  const gr = F.grain();
  const grit = F.cells(w >> 1, h >> 1, {});

  // Aggregate is basalt and traprock — dark. Only the polished faces catch
  // light, so the visible stones stay well below mid grey.
  const binder = o.binder, aggLight = hx('#8e8b82'), aggDark = hx('#5f5f61'), aggTan = hx('#7e7462');

  for (let i = 0; i < S.n; i++) {
    const wear = sat(o.wear + (macro[i] - 0.5) * 0.55 + (mid[i] - 0.5) * 0.30);
    let r = binder[0], g = binder[1], b = binder[2];
    // Binder tone spread. Raised from 0.115/0.055 because the road is viewed at
    // a grazing angle, where the mip chain averages several texels per pixel and
    // eats most of the fine contrast before it reaches the frame — the near
    // carriageway measured a mean absolute deviation of 1.7/255 against a brick
    // wall's 48 in the same shot. Hot-mix genuinely varies this much between a
    // ravelled patch and a sound one; it is the *filtering* that was flattening
    // it, not the paint.
    const bv = (macro[i] - 0.5) * 0.185 + (mid[i] - 0.5) * 0.090 + (gr[i] - 0.5) * 0.030;
    r += bv; g += bv; b += bv;
    let rough = 0.93 + (gr[i] - 0.5) * 0.04;
    let height = 0.55 + (grit[i] - 0.5) * 0.04 + (gr[i] - 0.5) * 0.03;

    // Aggregate poking through the ravelled binder. ~9 mm stones, partial cover.
    const st = smoothstep(0.40, 0.20, stone[i]) * smoothstep(0.10, 0.58, wear) * ABL.aggregate;
    if (st > 0) {
      const s = sid[i];
      const a = s > 0.78 ? aggLight : s > 0.42 ? aggDark : aggTan;
      const k = st * (0.42 + s * 0.42);
      r = lerp(r, a[0] * (0.78 + s * 0.34), k);
      g = lerp(g, a[1] * (0.78 + s * 0.34), k);
      b = lerp(b, a[2] * (0.78 + s * 0.34), k);
      rough = lerp(rough, 0.87, st);
      height += st * 0.16;
    }
    S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
  }

  // --- utility-cut patches: different mix, visible cold joint --------------
  // The fill and the joint outline must come from the same rectangles.
  const rects = [];
  for (let n = 0; n < o.patches; n++) {
    rects.push([R() * w, R() * h, R.range(0.14, 0.42) * w, R.range(0.10, 0.30) * h, R.range(-0.06, 0.06)]);
  }
  const drawRects = (stroke) => (g, wrap) => {
    g.lineWidth = Math.max(1.5, w / 340); g.lineJoin = 'miter';
    for (const [px, py, pw, ph, rot] of rects) {
      wrap(px, py, Math.max(pw, ph), (c) => {
        c.save(); c.translate(px, py); c.rotate(rot);
        stroke ? c.strokeRect(-pw / 2, -ph / 2, pw, ph) : c.fillRect(-pw / 2, -ph / 2, pw, ph);
        c.restore();
      });
    }
  };
  const patch = F.mask(drawRects(false));
  const patchEdge = F.mask(drawRects(true));
  const patchTone = F.noise('A', 2, 2);
  for (let i = 0; i < S.n; i++) {
    const p = patch[i] * ABL.patch;
    if (p > 0.01) {
      const fresh = patchTone[i] > 0.5;
      const c = fresh ? o.patchFresh : o.patchOld;
      S.mix(i, c, p * 0.42);
      S.rough[i] = lerp(S.rough[i], fresh ? 0.90 : 0.95, p * 0.7);
      S.height[i] += p * 0.03;
    }
    const e = patchEdge[i] * ABL.patchEdge;
    if (e > 0.01) {   // cold joint, later sealed with tar
      S.mix(i, [0.055, 0.052, 0.058], e * 0.85);
      S.height[i] += e * 0.06;
      S.rough[i] = lerp(S.rough[i], 0.5, e * 0.7);
    }
  }

  // --- hairline cracks -----------------------------------------------------
  // Sub-texel and full-res (div = 1): at 4.7 mm/texel these are 4-10 mm lines,
  // which is the scale a 2.4 m tile can legitimately carry. Anything longer
  // than a few centimetres does not belong in here — see the note below.
  const cracks = F.mask((g, wrap) => {
    g.lineCap = 'round';
    for (let n = 0; n < o.cracks; n++) {
      const x = R() * w, y = R() * h;
      g.lineWidth = R.range(0.8, 2.2) * (w / 1024);
      const pts = F.crackPts(x, y, R.range(0.2, 0.8) * w, w / 90, 0.9, R);
      wrap(x, y, w * 0.5, (c) => F.strokePts(c, pts));
    }
  }, 1);
  for (let i = 0; i < S.n; i++) {
    const c = cracks[i] * ABL.crack;
    if (c > 0.01) { S.mix(i, [0.075, 0.072, 0.082], c * 0.9); S.height[i] -= c * 0.085; S.rough[i] = lerp(S.rough[i], 0.95, c); }
  }
  // --- the tar snakes are GONE FROM HERE, and this is why -----------------
  // "Soft grey marker scribbles on the carriageway" survived four critic
  // passes, `setCrack(0)` and `setDetail(0)`, and was blamed on three
  // different shader terms. It was this function. The motif was:
  //
  //   g.lineCap = 'round'; g.lineJoin = 'round';
  //   g.lineWidth = R.range(0.013, 0.030) * w;              // 3.1 - 7.2 cm
  //   F.crackPts(x, y, R.range(0.3, 0.95) * w, w / 60, 0.75, R);
  //
  // Four things were wrong with it and only one of them was amplitude:
  //
  //   IT REPEATED.  A 512 tile spans 2.4 m, so a 0.7-2.3 m stroke is a feature
  //     most of a tile-period long, and the tile is the whole city's road. The
  //     same three strokes therefore recurred every 2.4 m down every street in
  //     Boston. No amount of re-authoring fixes that: a sparse metre-scale
  //     motif cannot live in a metre-scale tile. It has to be world-space, so
  //     it now is — see `seal` in Roads.js, which rides the crack network's own
  //     distance field and never repeats.
  //   IT WANDERED.  crackPts random-walks the heading by +/-0.375 rad every
  //     4 cm, so over 1.5 m it is a smooth meander that never runs straight and
  //     never meets anything at an angle. That is exactly the pathology the
  //     bCell comment in Roads.js diagnoses for cracks — sealant follows a
  //     crack, so it inherits the crack's straightness or it is not sealant.
  //   IT HAD ROUND CAPS at 15 texels wide, which is the "fat rounded terminus"
  //     the critic kept describing.
  //   IT IGNORED ITS OWN MASK.  `S.set(i, tar)` ran at full strength for every
  //     texel with s > 0.01, so the entire antialiased skirt was as black as
  //     the core and then lightened back toward grey by `(1 - s) * 0.6`. With
  //     the mask built at half res (div 2, 9.4 mm per drawn pixel) and bilinear
  //     upsampled, that turned a soft edge into a hard stair-stepped grey rim —
  //     the "visible stair-stepping" reported at setDetail(0).
  //
  // MEASURED before removal, st_southend near carriageway, 5370 8x8 block
  // means, drift-cancelled, A/A floor 0.15% / 0.083:
  //
  //   ablation             %blocks   mean    max    d(local contrast)
  //   snakes off             7.13    1.554   73.4      -0.504
  //   whole atlas albedo    95.34    7.505   76.9      -0.849
  //   patches + joints       7.43    0.711   26.9      -0.072
  //   shader cracks          4.02    0.302   30.7      -0.048
  //   shader `dab`          13.22    1.230   24.7      -0.022
  //
  // 59% of every painted contrast on the road came from this one motif, at 7%
  // coverage. It was never the cracks and it was never `dab`.

  // --- oil and rubber ------------------------------------------------------
  const oil = F.noise('A', 1, 1);
  const oil2 = F.noise('B', 2, 2);
  for (let i = 0; i < S.n; i++) {
    const t = smoothstep(0.50, 0.86, oil[i] * 0.7 + oil2[i] * 0.3) * o.oil * ABL.oil;
    if (t <= 0) continue;
    S.mul(i, 1 - t * 0.62);
    S.rough[i] = lerp(S.rough[i], 0.44, t * 0.9);
  }
  if (o.paintGhost) {
    const gh = F.mask((g, wrap) => {
      for (let n = 0; n < 3; n++) {
        const x = R() * w, y = R() * h, l = R.range(0.2, 0.5) * w;
        g.lineWidth = 0.055 * w; g.lineCap = 'butt';
        wrap(x, y, w * 0.5, (c) => { c.beginPath(); c.moveTo(x, y); c.lineTo(x + l, y + (R() - 0.5) * 20); c.stroke(); });
      }
    });
    const spot = F.noise('B', 3, 3);
    for (let i = 0; i < S.n; i++) {
      const t = gh[i] * smoothstep(0.35, 0.75, spot[i]) * 0.5 * ABL.ghost;
      if (t > 0) { S.mix(i, [0.62, 0.61, 0.57], t); S.rough[i] = lerp(S.rough[i], 0.7, t); }
    }
  }
  F.bakeAO(S, 0.55, 5);
  return { roughScalar: 0.97 };
}

const ASPHALT = {
  res: 512, tile: 2.4, base: hx('#57575d'), rough: 0.93, normalStrength: 0.9, relief: 0.019,
  binder: hx('#57575d'), wear: 0.34, patches: 2, cracks: 5, oil: 0.5,
  patchFresh: hx('#3a3a41'), patchOld: hx('#66666c'), paintGhost: false, paint: paintAsphalt,
};

const ASPHALT_WORN = {
  ...ASPHALT, res: 512, base: hx('#66666b'),
  binder: hx('#66666b'), wear: 0.66, patches: 4, cracks: 14, oil: 0.6,
  patchFresh: hx('#3d3d44'), patchOld: hx('#727278'), paintGhost: true,
};

/** Thermoplastic lane marking with glass beads, scuffing and chipped-out wear. */
function paintRoadLine(S, F, o) {
  const { w, h } = F;
  const grime = F.noise('A', 2, 2);
  const wear = F.noise('B', 2, 2);
  const fine = F.noise('B', 4, 4);
  const gr = F.grain();
  const beads = F.cells(Math.round(w / 3), Math.round(h / 3), { round: 0.8 });
  const scuff = F.noise('E', 6, 1);
  const c = o.color;

  for (let y = 0; y < h; y++) {
    const vv = (y + 0.5) / h, row = y * w;
    // Ragged paint edge across the stripe.
    const edge = Math.min(vv, 1 - vv);
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const ragged = smoothstep(0.0, 0.055, edge + (fine[i] - 0.5) * 0.06);
      let r = c[0], g = c[1], b = c[2];
      const v = (grime[i] - 0.5) * 0.10;
      r += v; g += v; b += v;
      let rough = 0.58 + (fine[i] - 0.5) * 0.10;
      // Retro-reflective glass beads catch the light.
      const bd = smoothstep(0.90, 0.99, beads[i]);
      if (bd > 0) { r = lerp(r, 0.96, bd * 0.7); g = lerp(g, 0.96, bd * 0.7); b = lerp(b, 0.97, bd * 0.7); rough = lerp(rough, 0.16, bd); }
      // Tyre scuffing — grey smears where traffic crosses the line.
      const sc = sat((scuff[i] - 0.62) * 2.4) * 0.42;
      r = lerp(r, 0.34, sc); g = lerp(g, 0.34, sc); b = lerp(b, 0.35, sc);
      rough = lerp(rough, 0.8, sc * 0.6);
      // Wear-through to the road. Thermoplastic is thick: only the worst
      // patches actually expose asphalt, so keep this rare.
      const wt = smoothstep(0.24, 0.11, wear[i] + (gr[i] - 0.5) * 0.14) * o.wear;
      const a = ragged * (1 - wt);
      S.r[i] = r; S.g[i] = g; S.b[i] = b;
      S.rough[i] = rough; S.alpha[i] = a;
      S.height[i] = 0.35 + a * 0.5 + (gr[i] - 0.5) * 0.03;
    }
  }
  F.bakeAO(S, 0.35, 4);
  return { roughScalar: 0.9 };
}

/**
 * Lane markings. UV convention: u tiles ALONG the line (1.0 = 1 m), v spans the
 * line width exactly once — hence clampV, so a consumer that accidentally tiles
 * v cannot turn a solid line into a ladder.
 */
const ROAD_LINE_WHITE = {
  res: 512, resY: 256, tile: 1.0, base: hx('#e9e7dd'), rough: 0.6, opaque: false,
  normalStrength: 0.6, relief: 0.006, gain: 1.07, clampV: true, wear: 0.85,
  color: hx('#e6e4d8'), paint: paintRoadLine,
};
const ROAD_LINE_YELLOW = { ...ROAD_LINE_WHITE, base: hx('#d3a622'), color: hx('#cfa227') };

/* ---- sidewalks -----------------------------------------------------------*/

/** Poured concrete walk: 1.2 m slabs, tooled joints, broom finish, gum. */
const SIDEWALK = {
  res: 512, tile: 2.4, base: hx('#918d85'), rough: 0.9, normalStrength: 1.0, relief: 0.013,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const cols = 2, rows = 2, bw = w / cols, bh = h / rows;
    const halfJoint = (0.012 / 2.4) * w * 0.5;
    const broom = F.noise('B', 40, 2);       // fine directional tooling
    const mott = F.noise('A', 2, 2);
    const fine = F.noise('B', 3, 3);
    const gr = F.grain();
    const pits = F.cells(Math.round(w / 4), Math.round(h / 4), { round: 0.9 });
    const agg = F.noise('c', 2, 2, false);
    const jointC = hx('#59564f');

    const slabTone = [R.range(0.9, 1.1), R.range(0.9, 1.1), R.range(0.9, 1.1), R.range(0.9, 1.1)];
    const slabWarm = [R.range(-0.02, 0.03), R.range(-0.02, 0.03), R.range(-0.02, 0.03), R.range(-0.02, 0.03)];

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const jr = Math.floor(vv * rows), fy = vv * rows - jr;
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const ic = Math.floor(uu * cols), fx = uu * cols - ic;
        const k = jr * cols + ic;
        const dEdge = Math.min(Math.min(fx, 1 - fx) * bw, Math.min(fy, 1 - fy) * bh) - halfJoint;
        const face = smoothstep(-0.8, 1.6, dEdge);

        let r = 0.575 * slabTone[k] + slabWarm[k], g = 0.560 * slabTone[k] + slabWarm[k] * 0.7, b = 0.525 * slabTone[k];
        const m = (mott[i] - 0.5) * 0.085 + (fine[i] - 0.5) * 0.05;
        r += m; g += m; b += m;
        // Broom finish micro-grooves.
        const br = (broom[i] - 0.5);
        r += br * 0.030; g += br * 0.030; b += br * 0.030;
        let height = 0.74 + br * 0.045 + (gr[i] - 0.5) * 0.025;
        let rough = 0.90 + (fine[i] - 0.5) * 0.05;
        // Fine aggregate and air pits.
        const ag = smoothstep(0.32, 0.18, agg[i]) * 0.35;
        r += ag * 0.09; g += ag * 0.085; b += ag * 0.075;
        const pit = smoothstep(0.955, 0.995, pits[i]);
        if (pit > 0) { height -= pit * 0.16; r -= pit * 0.1; g -= pit * 0.1; b -= pit * 0.09; rough = lerp(rough, 0.96, pit); }

        if (face < 1) {
          const jd = 1 - face;
          r = lerp(r, jointC[0], jd); g = lerp(g, jointC[1], jd); b = lerp(b, jointC[2], jd);
          rough = lerp(rough, 0.95, jd); height = lerp(height, 0.40, jd);
        }
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }

    // Cracks + trodden gum, the two things every real sidewalk has.
    const cracks = F.mask((g, wrap) => {
      g.lineCap = 'round';
      for (let n = 0; n < 6; n++) {
        const x = R() * w, y = R() * h;
        g.lineWidth = R.range(0.7, 1.8) * (w / 1024);
        const pts = F.crackPts(x, y, R.range(0.1, 0.5) * w, w / 80, 1.0, R);
        wrap(x, y, w * 0.5, (c) => F.strokePts(c, pts));
      }
    }, 1);
    const gum = F.mask((g, wrap) => {
      for (let n = 0; n < 22; n++) {
        const x = R() * w, y = R() * h, rr = R.range(0.006, 0.016) * w;
        wrap(x, y, rr * 2, (c) => {
          c.save(); c.translate(x, y); c.scale(1, R.range(0.7, 1.1)); c.beginPath();
          c.arc(0, 0, rr, 0, 6.283185307); c.fill(); c.restore();
        });
      }
    });
    const gumTone = F.noise('A', 3, 3);
    for (let i = 0; i < S.n; i++) {
      const c = cracks[i];
      if (c > 0.01) { S.mix(i, [0.24, 0.23, 0.21], c * 0.85); S.height[i] -= c * 0.18; }
      const gm = gum[i];
      if (gm > 0.01) {
        const dark = gumTone[i] > 0.5;
        S.mix(i, dark ? [0.13, 0.12, 0.12] : [0.42, 0.40, 0.38], gm * 0.9);
        S.rough[i] = lerp(S.rough[i], 0.7, gm); S.height[i] += gm * 0.03;
      }
    }
    F.streaks(S, { amount: 0.22, color: hx('#3a382f'), freq: 6, rough: 0.02, fade: 0.6 });
    F.bakeAO(S, 0.8, 6);
    return { roughScalar: 0.97 };
  },
};

/**
 * Red brick herringbone sidewalk. The 90-degree herringbone is generated
 * analytically: index the unit squares and let (i+j) mod 4 decide whether the
 * square is the left/right half of a horizontal paver or the top/bottom half of
 * a vertical one. That tiles exactly every 4 squares, so the texture is seamless.
 */
const SIDEWALK_BRICK = {
  res: 512, tile: 1.6, base: hx('#8a4a37'), rough: 0.9, normalStrength: 1.35, relief: 0.020,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const N = 16;                      // unit squares across the tile (multiple of 4)
    const sq = w / N;
    const halfJoint = (0.004 / 1.6) * w * 0.5;
    const mott = F.noise('A', 2, 2);
    const fine = F.noise('B', 3, 3);
    const heave = F.noise('A', 1, 1);  // frost heave / tree roots lift whole pavers
    const gr = F.grain();
    const grit = F.cells(w >> 1, h >> 1, {});
    const mossN = F.noise('C', 2, 2);

    const pal = [hx('#9c5236'), hx('#8a452f'), hx('#743a2b'), hx('#a76245'), hx('#5f3026'), hx('#8d5a44')];
    const sand = hx('#8c8375'), moss = hx('#4a5334');

    const seed = R.int(1e9);
    for (let y = 0; y < h; y++) {
      const row = y * w, gy = Math.floor(y / sq), fyr = y / sq - gy;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const gx = Math.floor(x / sq), fxr = x / sq - gx;
        const m = (gx + gy) & 3;
        // (i+j) mod 4: 0/1 are the left/right half of a horizontal paver,
        // 2/3 the top/bottom half of a vertical one. Exact 4-square period.
        let bwN, bhN, lx, ly, bid;
        if (m === 0) { bwN = 2; bhN = 1; lx = fxr; ly = fyr; bid = hash2i(gx, gy, seed); }
        else if (m === 1) { bwN = 2; bhN = 1; lx = 1 + fxr; ly = fyr; bid = hash2i(gx - 1, gy, seed); }
        else if (m === 2) { bwN = 1; bhN = 2; lx = fxr; ly = fyr; bid = hash2i(gx, gy, seed); }
        else { bwN = 1; bhN = 2; lx = fxr; ly = 1 + fyr; bid = hash2i(gx, gy - 1, seed); }

        const dEdge = Math.min(Math.min(lx, bwN - lx), Math.min(ly, bhN - ly)) * sq - halfJoint;
        const face = smoothstep(-0.5, 1.4, dEdge);

        const p = pal[(bid * pal.length) | 0];
        const tone = 0.82 + hash2i((bid * 9137) | 0, 3, seed + 5) * 0.42;
        let r = p[0] * tone, g = p[1] * tone, b = p[2] * tone;
        const im = (mott[i] - 0.5) * 0.16 + (fine[i] - 0.5) * 0.09;
        r += im * 1.05; g += im * 0.75; b += im * 0.6;
        const sp = (grit[i] - 0.5) * 0.07 + (gr[i] - 0.5) * 0.05;
        r += sp; g += sp; b += sp;

        // Whole pavers tilt and lift.
        const lift = (heave[i] - 0.5) * 0.22 + (hash2i((bid * 7919) | 0, 11, seed) - 0.5) * 0.10;
        let height = 0.72 + lift;
        // Worn, rounded, polished tops.
        const polish = smoothstep(0.45, 0.85, mott[i]);
        let rough = lerp(0.90, 0.60, polish * 0.7) + (fine[i] - 0.5) * 0.06;
        const arris = smoothstep(0, 2.6, dEdge);
        height = lerp(height - 0.10, height, arris);

        if (face < 1) {
          const jd = 1 - face;
          const sg = (grit[i] - 0.5) * 0.22;
          r = lerp(r, sand[0] + sg, jd); g = lerp(g, sand[1] + sg, jd); b = lerp(b, sand[2] + sg, jd);
          rough = lerp(rough, 0.96, jd);
          height = lerp(height, 0.42, jd);
          const mo = smoothstep(0.66, 0.95, mossN[i]) * jd * 0.8;
          r = lerp(r, moss[0], mo); g = lerp(g, moss[1], mo); b = lerp(b, moss[2], mo);
        }
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.bakeAO(S, 0.95, 7);
    return { roughScalar: 0.97 };
  },
};

/* ---- concrete ------------------------------------------------------------*/

function paintConcrete(S, F, o) {
  const { w, h } = F;
  const R = F.rand;
  const macro = F.noise('A', 1, 1);
  const mid = F.noise('B', 2, 2);
  const fine = F.noise('B', 4, 4);
  const gr = F.grain();
  const pits = F.cells(Math.round(w / 3), Math.round(h / 3), { round: 0.9 });
  const agg = F.noise('c', 1, 1, false);

  const base = o.base;
  for (let i = 0; i < S.n; i++) {
    const m = (macro[i] - 0.5) * 0.12 + (mid[i] - 0.5) * 0.07 + (fine[i] - 0.5) * 0.045;
    let r = base[0] + m, g = base[1] + m * 0.98, b = base[2] + m * 0.94;
    const grn = (gr[i] - 0.5) * 0.05;
    r += grn; g += grn; b += grn;
    let rough = 0.88 + (fine[i] - 0.5) * 0.06;
    let height = 0.72 + (mid[i] - 0.5) * 0.05 + (gr[i] - 0.5) * 0.03;
    const ag = smoothstep(0.30, 0.16, agg[i]) * 0.3;
    r += ag * 0.07; g += ag * 0.065; b += ag * 0.06;
    const pit = smoothstep(0.95, 0.995, pits[i]);          // entrained air voids
    if (pit > 0) { height -= pit * 0.22; r -= pit * 0.12; g -= pit * 0.12; b -= pit * 0.11; rough = lerp(rough, 0.97, pit); }
    S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
  }

  // Form-tie plugs on precast panels.
  const ties = F.mask((g, wrap) => {
    for (let n = 0; n < o.ties; n++) {
      const x = R() * w, y = R() * h, rr = 0.011 * w;
      wrap(x, y, rr * 2, (c) => { c.beginPath(); c.arc(x, y, rr, 0, 6.283185307); c.fill(); });
    }
  });
  const cracks = F.mask((g, wrap) => {
    g.lineCap = 'round';
    for (let n = 0; n < o.cracks; n++) {
      const x = R() * w, y = R() * h;
      g.lineWidth = R.range(0.6, 1.6) * (w / 512);
      const pts = F.crackPts(x, y, R.range(0.15, 0.7) * w, w / 60, 1.1, R);
      wrap(x, y, w * 0.5, (c) => F.strokePts(c, pts));
    }
  }, 1);
  const rust = hx('#7a4426');
  for (let i = 0; i < S.n; i++) {
    const t = ties[i];
    if (t > 0.01) { S.mix(i, [0.52, 0.51, 0.48], t * 0.7); S.height[i] -= t * 0.06; }
    const c = cracks[i];
    if (c > 0.01) {
      S.mix(i, [0.26, 0.25, 0.23], c * 0.8);
      S.height[i] -= c * 0.18;
      if (o.rustBleed > 0 && macro[i] > 0.55) S.mix(i, rust, c * o.rustBleed);
    }
  }
  if (o.mildew > 0) {
    const md = F.noise('C', 2, 2);
    const mdc = hx('#2e3328');
    for (let i = 0; i < S.n; i++) {
      const t = smoothstep(0.55, 0.2, md[i]) * o.mildew * (0.4 + macro[i] * 0.8);
      if (t > 0) { S.mix(i, mdc, t * 0.6); S.rough[i] = sat(S.rough[i] + t * 0.05); }
    }
  }
  F.streaks(S, { amount: o.streak, color: hx('#28261f'), freq: 8, rough: 0.03, fade: 0.5 });
  F.bakeAO(S, 0.6, 5);
  return { roughScalar: 0.97 };
}

const CONCRETE = {
  res: 512, tile: 2.4, base: hx('#96938c'), rough: 0.88, normalStrength: 0.8, relief: 0.010,
  ties: 5, cracks: 4, rustBleed: 0.25, mildew: 0.0, streak: 0.28, paint: paintConcrete,
};
const CONCRETE_STAINED = {
  ...CONCRETE, base: hx('#7d7a73'), gain: 1.28,
  ties: 5, cracks: 9, rustBleed: 0.5, mildew: 0.55, streak: 0.72,
};

/* ---- glass ---------------------------------------------------------------*/

/**
 * Curtain wall. Panes are individually tinted and individually bowed — that
 * "oil canning" is why real reflective towers never look like a clean mirror.
 * 200 Clarendon's glass is a blue-green that goes almost silver at grazing angles.
 */
function paintCurtainWall(S, F, o) {
  const { w, h } = F;
  const R = F.rand;
  const cols = 2;                                  // panes across the tile
  const mullU = (0.055 / o.tile) * w;              // mullion half-widths, in px
  const mullV = (0.055 / o.tileY) * h;
  const spandrel = 0.26;                           // fraction of the floor that is spandrel
  const dirt = F.noise('E', 5, 1);
  const mott = F.noise('A', 2, 2);
  const gr = F.grain();

  const paneW = w / cols;
  const nP = cols;
  const tint = [], rgh = [], met = [], blind = [], bulge = [];
  for (let k = 0; k < nP; k++) {
    tint.push(R());
    rgh.push(R.range(o.roughLo, o.roughHi));
    met.push(R.range(o.metalLo, o.metalHi));
    blind.push(R() < o.blinds ? R.range(0.15, 0.75) : 0);
    bulge.push(R.range(-1, 1));
  }
  const glassA = o.glassA, glassB = o.glassB, spandC = o.spandrel, mullC = o.mullion;
  const blindC = hx('#b9b2a4');

  const transomY = (1 - spandrel) * h;
  for (let y = 0; y < h; y++) {
    const vv = (y + 0.5) / h, row = y * w;
    const inSpandrel = vv > 1 - spandrel;          // spandrel sits at the floor line
    const dv = Math.min(Math.min(y, h - y), Math.abs(y - transomY) * 1.4);
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const k = Math.min(nP - 1, Math.floor(x / paneW));
      const lx = x - k * paneW;
      const du = Math.min(lx, paneW - lx);
      const mull = 1 - smoothstep(mullU - 1, mullU + 1, du) * smoothstep(mullV - 1, mullV + 1, dv);
      const spEdge = smoothstep(1 - spandrel - 0.012, 1 - spandrel + 0.012, vv);

      // Vision glass.
      const t = tint[k] * 0.8 + mott[i] * 0.2;
      let r = lerp(glassA[0], glassB[0], t), g = lerp(glassA[1], glassB[1], t), b = lerp(glassA[2], glassB[2], t);
      let rough = rgh[k] + (mott[i] - 0.5) * 0.012;
      let metal = met[k];
      let height = 0.5;

      // Bowed pane ("oil canning") — the reason real curtain walls never read
      // as a flat mirror. A smooth dome per pane, sign randomised.
      const nu = (lx / paneW) * 2 - 1;
      const nv = vv * 2 - 1;
      height += bulge[k] * (1 - nu * nu) * (1 - nv * nv) * 0.35;

      // Interior blinds — random height per pane, seen through the glass.
      if (blind[k] > 0 && !inSpandrel) {
        const bt = smoothstep(blind[k] + 0.02, blind[k] - 0.02, vv);
        if (bt > 0) {
          const slat = 0.5 + 0.5 * Math.sin(vv * h * 0.55);
          const bc = 0.55 + slat * 0.45;
          r = lerp(r, blindC[0] * bc, bt * 0.62); g = lerp(g, blindC[1] * bc, bt * 0.62); b = lerp(b, blindC[2] * bc, bt * 0.62);
          metal = lerp(metal, metal * 0.55, bt);
          rough = lerp(rough, rough + 0.05, bt);
        }
      }

      if (spEdge > 0) {                             // opaque spandrel panel
        r = lerp(r, spandC[0], spEdge); g = lerp(g, spandC[1], spEdge); b = lerp(b, spandC[2], spEdge);
        rough = lerp(rough, 0.16, spEdge); metal = lerp(metal, 0.35, spEdge);
        height = lerp(height, 0.46, spEdge);
      }
      if (mull > 0) {                               // anodised aluminium frame
        const mv = (gr[i] - 0.5) * 0.03;
        r = lerp(r, mullC[0] + mv, mull); g = lerp(g, mullC[1] + mv, mull); b = lerp(b, mullC[2] + mv, mull);
        rough = lerp(rough, 0.38, mull); metal = lerp(metal, 0.85, mull);
        height = lerp(height, 0.86, mull);
      }
      // Rain dirt runs down the glass and pools against the transom.
      const dg = sat((dirt[i] - 0.5) * 2.0) * smoothstep(0.25, 1.0, vv) * o.dirt;
      r = lerp(r, r * 0.86 + 0.03, dg); g = lerp(g, g * 0.86 + 0.03, dg); b = lerp(b, b * 0.86 + 0.03, dg);
      rough = sat(rough + dg * 0.06);

      S.r[i] = r; S.g[i] = g; S.b[i] = b;
      S.rough[i] = rough; S.metal[i] = metal; S.height[i] = height;
    }
  }
  F.bakeAO(S, 0.35, 4);
  return { roughScalar: 0.45, metalScalar: 1.0 };
}

const GLASS_TOWER = {
  res: 512, resY: 512, tile: 2.8, tileY: 3.8, base: hx('#3d5f63'), rough: 0.05, normalStrength: 0.35, relief: 0.014, floor: 0.0,
  glassA: hx('#3c5f66'), glassB: hx('#4f7a72'), spandrel: hx('#1e3238'), mullion: hx('#31363a'),
  roughLo: 0.02, roughHi: 0.075, metalLo: 0.86, metalHi: 0.99, blinds: 0.34, dirt: 0.35,
  paint: paintCurtainWall,
};

const GLASS_DARK = {
  ...GLASS_TOWER, base: hx('#2b2d33'),
  glassA: hx('#26282e'), glassB: hx('#35383f'), spandrel: hx('#141619'), mullion: hx('#26292c'),
  roughLo: 0.03, roughHi: 0.10, metalLo: 0.72, metalHi: 0.92, blinds: 0.20, dirt: 0.5,
};

/** Lit office interiors seen through glass at night — drives the emissive map. */
const WINDOW_LIT = {
  res: 512, tile: 2.8, tileY: 3.8, base: hx('#0d1014'), rough: 0.08, normalStrength: 0.3, relief: 0.014, floor: 0.0,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const cols = 2, paneW = w / cols;
    const mullU = (0.055 / 2.8) * w, mullV = (0.055 / 3.8) * h;
    const spandrel = 0.26;
    const mott = F.noise('A', 2, 2);
    const gr = F.grain();
    const warm = hx('#ffe6bb'), cool = hx('#dceaff'), off = hx('#1a1f26');
    const mullC = hx('#2b2f33');

    const on = [], temp = [], lvl = [], blindH = [];
    for (let k = 0; k < cols; k++) {
      on.push(R() < 0.62 ? 1 : 0); temp.push(R()); lvl.push(R.range(0.55, 1.0));
      blindH.push(R() < 0.4 ? R.range(0.2, 0.7) : 0);
    }

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w, dv = Math.min(y, h - y);
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const k = Math.min(cols - 1, Math.floor(x / paneW));
        const lx = x - k * paneW, du = Math.min(lx, paneW - lx);
        const mull = 1 - smoothstep(mullU - 1, mullU + 1, du) * smoothstep(mullV - 1, mullV + 1, dv);
        const spEdge = smoothstep(1 - spandrel - 0.012, 1 - spandrel + 0.012, vv);

        let r, g, b;
        if (on[k]) {
          const c = temp[k] > 0.55 ? warm : cool;
          // Ceiling is brightest, floor falls off; a desk lamp or two nearer the glass.
          const grad = lerp(1.0, 0.42, smoothstep(0.0, 0.85, vv));
          const tiles = 0.86 + 0.14 * Math.sin(vv * 22.0);
          let k2 = lvl[k] * grad * tiles;
          if (blindH[k] > 0 && vv < blindH[k]) k2 *= 0.30 + 0.25 * (0.5 + 0.5 * Math.sin(vv * h * 0.5));
          // Silhouettes of partitions/furniture.
          const occ = smoothstep(0.55, 0.75, mott[i]) * smoothstep(0.35, 0.9, vv);
          k2 *= 1 - occ * 0.7;
          r = c[0] * k2; g = c[1] * k2; b = c[2] * k2;
        } else {
          r = off[0]; g = off[1]; b = off[2];
        }
        const gv = (gr[i] - 0.5) * 0.03;
        r += gv; g += gv; b += gv;
        if (spEdge > 0) { r = lerp(r, 0.045, spEdge); g = lerp(g, 0.05, spEdge); b = lerp(b, 0.055, spEdge); }
        if (mull > 0) { r = lerp(r, mullC[0], mull); g = lerp(g, mullC[1], mull); b = lerp(b, mullC[2], mull); }

        S.r[i] = r; S.g[i] = g; S.b[i] = b;
        S.rough[i] = mull > 0.5 ? 0.4 : 0.08;
        S.metal[i] = mull > 0.5 ? 0.8 : 0.2;
        S.height[i] = mull > 0.5 ? 0.85 : 0.5;
      }
    }
    return { roughScalar: 0.45, metalScalar: 1.0 };
  },
};

/* ---- metals --------------------------------------------------------------*/

const METAL_PAINTED = {
  res: 512, tile: 1.0, base: hx('#242b2c'), rough: 0.35, normalStrength: 0.55, relief: 0.004, gain: 1.26,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const peel = F.noise('A', 2, 2);
    const orange = F.cells(Math.round(w / 4), Math.round(h / 4), { round: 0.6 });
    const fine = F.noise('B', 4, 4);
    const gr = F.grain();
    const base = hx('#242b2c'), steel = hx('#6d7176'), rust = hx('#7a4222');

    for (let i = 0; i < S.n; i++) {
      const v = (peel[i] - 0.5) * 0.06 + (fine[i] - 0.5) * 0.03;
      let r = base[0] + v, g = base[1] + v, b = base[2] + v;
      // Orange peel: the tell-tale texture of sprayed paint.
      const op = (orange[i] - 0.5);
      let height = 0.66 + op * 0.10 + (gr[i] - 0.5) * 0.02;
      let rough = 0.35 + op * 0.05 + (fine[i] - 0.5) * 0.05;
      let metal = 0.9;
      // Sun-bleached upper surfaces.
      const fade = smoothstep(0.55, 0.9, peel[i]) * 0.35;
      r = lerp(r, r * 1.35 + 0.04, fade); g = lerp(g, g * 1.3 + 0.04, fade); b = lerp(b, b * 1.3 + 0.04, fade);
      rough = lerp(rough, 0.55, fade);
      S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.metal[i] = metal; S.height[i] = height;
    }

    const scratch = F.mask((g, wrap) => {
      g.lineCap = 'round';
      for (let n = 0; n < 26; n++) {
        const x = R() * w, y = R() * h, l = R.range(0.03, 0.30) * w, a = R() * 6.283;
        g.lineWidth = R.range(0.5, 1.6) * (w / 512);
        wrap(x, y, l, (c) => { c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    }, 1);
    const chips = F.mask((g, wrap) => {
      for (let n = 0; n < 30; n++) {
        const x = R() * w, y = R() * h, rr = R.range(0.004, 0.014) * w;
        wrap(x, y, rr * 2.5, (c) => {
          c.beginPath();
          for (let s = 0; s < 7; s++) {
            const a = (s / 7) * 6.283, rad = rr * R.range(0.6, 1.4);
            const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
            s ? c.lineTo(px, py) : c.moveTo(px, py);
          }
          c.closePath(); c.fill();
        });
      }
    });
    for (let i = 0; i < S.n; i++) {
      const s = scratch[i];
      if (s > 0.01) { S.mix(i, steel, s * 0.8); S.rough[i] = lerp(S.rough[i], 0.3, s); S.height[i] -= s * 0.04; }
      const c = chips[i];
      if (c > 0.01) {
        S.mix(i, steel, c * 0.6);
        S.mix(i, rust, c * 0.45 * smoothstep(0.4, 0.7, peel[i]));
        S.rough[i] = lerp(S.rough[i], 0.72, c); S.height[i] -= c * 0.10;
        S.metal[i] = lerp(S.metal[i], 0.55, c * 0.6);
      }
    }
    F.cavityDirt(S, { amount: 0.35, color: hx('#171713'), depth: 0.55, rough: 0.06 });
    F.bakeAO(S, 0.5, 4);
    return { roughScalar: 0.85, metalScalar: 0.95 };
  },
};

const METAL_RUSTY = {
  res: 512, tile: 1.2, base: hx('#6a3a1e'), rough: 0.9, normalStrength: 1.2, relief: 0.008, gain: 1.42,
  paint(S, F) {
    const { w, h } = F;
    const flake = F.noise('C', 2, 2, false);
    const flakeId = F.noise('S', 2, 2, false);
    const macro = F.noise('A', 1, 1);
    const mid = F.noise('B', 2, 2);
    const fine = F.noise('B', 5, 5);
    const gr = F.grain();
    const pit = F.cells(Math.round(w / 3), Math.round(h / 3), { round: 0.85 });

    const rustA = hx('#8f4d23'), rustB = hx('#6b3618'), rustC = hx('#472a1b'), rustD = hx('#2c211a');
    const steel = hx('#75797e'), paint = hx('#3f5a52');

    for (let i = 0; i < S.n; i++) {
      const t = sat(macro[i] * 0.6 + mid[i] * 0.4);
      let c0, c1, k;
      if (t < 0.33) { c0 = rustD; c1 = rustC; k = t / 0.33; }
      else if (t < 0.66) { c0 = rustC; c1 = rustB; k = (t - 0.33) / 0.33; }
      else { c0 = rustB; c1 = rustA; k = (t - 0.66) / 0.34; }
      let r = lerp(c0[0], c1[0], k), g = lerp(c0[1], c1[1], k), b = lerp(c0[2], c1[2], k);
      const grn = (gr[i] - 0.5) * 0.09 + (fine[i] - 0.5) * 0.08;
      r += grn; g += grn * 0.9; b += grn * 0.8;
      let rough = 0.92 + (fine[i] - 0.5) * 0.06;
      let metal = 0.12;
      // Scale flakes lift and shed.
      const fl = smoothstep(0.34, 0.12, flake[i]);
      let height = 0.55 + fl * 0.22 * (0.4 + flakeId[i]) + (gr[i] - 0.5) * 0.05;
      const pt = smoothstep(0.94, 0.995, pit[i]);
      height -= pt * 0.25; rough = lerp(rough, 0.98, pt);
      // Surviving paint film.
      const pf = smoothstep(0.62, 0.85, mid[i]) * smoothstep(0.35, 0.6, macro[i]);
      if (pf > 0) {
        r = lerp(r, paint[0], pf * 0.85); g = lerp(g, paint[1], pf * 0.85); b = lerp(b, paint[2], pf * 0.85);
        rough = lerp(rough, 0.5, pf); metal = lerp(metal, 0.55, pf); height += pf * 0.05;
      }
      // Bare metal at the high, rubbed points.
      const bm = smoothstep(0.90, 0.99, mid[i] * 0.5 + fine[i] * 0.5) * 0.7;
      if (bm > 0) { r = lerp(r, steel[0], bm); g = lerp(g, steel[1], bm); b = lerp(b, steel[2], bm); rough = lerp(rough, 0.42, bm); metal = lerp(metal, 1, bm); }
      S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.metal[i] = metal; S.height[i] = height;
    }
    F.streaks(S, { amount: 0.45, color: hx('#5a2f13'), freq: 10, rough: 0.02, fade: 0.35 });
    F.bakeAO(S, 0.85, 5);
    return { roughScalar: 0.98, metalScalar: 1.0 };
  },
};

const STEEL_BRUSHED = {
  res: 512, tile: 1.0, base: hx('#a8aab0'), rough: 0.3, normalStrength: 0.35, relief: 0.0016,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const brush = F.noise('B', 1, 96);      // fine grain running along u
    const brush2 = F.noise('E', 1, 40);
    const smudge = F.noise('A', 2, 2);
    const gr = F.grain();
    const base = hx('#adafb5');
    for (let i = 0; i < S.n; i++) {
      const bl = (brush[i] - 0.5) * 0.7 + (brush2[i] - 0.5) * 0.3;
      const v = bl * 0.075 + (gr[i] - 0.5) * 0.02;
      S.r[i] = base[0] + v; S.g[i] = base[1] + v; S.b[i] = base[2] + v * 1.05;
      S.rough[i] = sat(0.28 + bl * 0.16 + (smudge[i] - 0.5) * 0.10);
      S.metal[i] = 1;
      S.height[i] = 0.5 + bl * 0.5;
    }
    const dings = F.mask((g, wrap) => {
      g.lineCap = 'round';
      for (let n = 0; n < 12; n++) {
        const x = R() * w, y = R() * h, l = R.range(0.05, 0.4) * w;
        g.lineWidth = R.range(0.6, 1.4) * (w / 512);
        const dy = (R() - 0.5) * 6;
        wrap(x, y, l, (c) => { c.beginPath(); c.moveTo(x, y); c.lineTo(x + l, y + dy); c.stroke(); });
      }
    }, 1);
    for (let i = 0; i < S.n; i++) {
      const d = dings[i];
      if (d > 0.01) { S.mul(i, 1 - d * 0.12); S.rough[i] = sat(S.rough[i] + d * 0.18); S.height[i] -= d * 0.2; }
    }
    return { roughScalar: 0.55, metalScalar: 1.0 };
  },
};

const CHROME = {
  res: 256, tile: 0.5, base: hx('#c9ccd2'), rough: 0.06, normalStrength: 0.2, relief: 0.0010,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const smudge = F.noise('A', 2, 2);
    const gr = F.grain();
    const base = hx('#cbced4');
    for (let i = 0; i < S.n; i++) {
      const v = (gr[i] - 0.5) * 0.012;
      S.r[i] = base[0] + v; S.g[i] = base[1] + v; S.b[i] = base[2] + v;
      S.rough[i] = sat(0.045 + smoothstep(0.55, 0.9, smudge[i]) * 0.09);
      S.metal[i] = 1;
      S.height[i] = 0.5 + (gr[i] - 0.5) * 0.06;
    }
    const scr = F.mask((g, wrap) => {
      g.lineCap = 'round';
      for (let n = 0; n < 20; n++) {
        const x = R() * w, y = R() * h, l = R.range(0.03, 0.25) * w, a = R() * 6.283;
        g.lineWidth = 0.7;
        wrap(x, y, l, (c) => { c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); });
      }
    }, 1);
    for (let i = 0; i < S.n; i++) if (scr[i] > 0.01) { S.rough[i] = sat(S.rough[i] + scr[i] * 0.25); S.height[i] -= scr[i] * 0.1; }
    return { roughScalar: 0.35, metalScalar: 1.0 };
  },
};

/** Verdigris copper — Boston roofs, cornices and cupolas. */
const COPPER_PATINA = {
  res: 512, tile: 1.2, base: hx('#4e8b74'), rough: 0.78, normalStrength: 0.7, relief: 0.006,
  paint(S, F) {
    const F1 = F;
    const macro = F1.noise('A', 1, 1);
    const mid = F1.noise('B', 2, 2);
    const fine = F1.noise('B', 5, 5);
    const gr = F1.grain();
    const green = hx('#57977c'), green2 = hx('#3f7d6a'), pale = hx('#8fbfa4');
    const brown = hx('#5a3a24'), dark = hx('#2b2f2b');
    for (let i = 0; i < S.n; i++) {
      const t = sat(macro[i] * 0.65 + mid[i] * 0.35);
      let r = lerp(green2[0], green[0], t), g = lerp(green2[1], green[1], t), b = lerp(green2[2], green[2], t);
      const pl = smoothstep(0.62, 0.9, mid[i]);
      r = lerp(r, pale[0], pl * 0.6); g = lerp(g, pale[1], pl * 0.6); b = lerp(b, pale[2], pl * 0.6);
      const un = smoothstep(0.24, 0.06, macro[i]);          // un-patinated copper still showing
      r = lerp(r, brown[0], un * 0.8); g = lerp(g, brown[1], un * 0.8); b = lerp(b, brown[2], un * 0.8);
      const v = (fine[i] - 0.5) * 0.07 + (gr[i] - 0.5) * 0.04;
      r += v; g += v; b += v;
      S.r[i] = r; S.g[i] = g; S.b[i] = b;
      S.rough[i] = lerp(0.82, 0.45, un) + (fine[i] - 0.5) * 0.06;
      S.metal[i] = lerp(0.15, 0.85, un);
      S.height[i] = 0.6 + (mid[i] - 0.5) * 0.14 + (gr[i] - 0.5) * 0.03;
    }
    F1.streaks(S, { amount: 0.35, color: dark, freq: 9, rough: 0.02, fade: 0.4 });
    F1.bakeAO(S, 0.6, 5);
    return { roughScalar: 0.9, metalScalar: 0.9 };
  },
};

/* ---- roofs ---------------------------------------------------------------*/

const ROOF_TAR = {
  res: 512, tile: 1.8, base: hx('#2a292d'), rough: 0.82, normalStrength: 0.9, relief: 0.012, gain: 1.38,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const macro = F.noise('A', 1, 1);
    const mid = F.noise('B', 3, 3);
    const gr = F.grain();
    const grit = F.cells(Math.round(w / 2), Math.round(h / 2), {});
    const base = hx('#2a292d'), pond = hx('#4a4842'), fresh = hx('#171619');
    const rolls = 2;
    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const seam = Math.abs(((vv * rolls) % 1) - 0.5);
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const v = (macro[i] - 0.5) * 0.07 + (mid[i] - 0.5) * 0.05 + (gr[i] - 0.5) * 0.05;
        let r = base[0] + v, g = base[1] + v, b = base[2] + v;
        let rough = 0.82 + (mid[i] - 0.5) * 0.10;
        let height = 0.6 + (grit[i] - 0.5) * 0.06 + (gr[i] - 0.5) * 0.03;
        // Lapped roll edge.
        const lap = smoothstep(0.5, 0.46, seam);
        height += lap * 0.14;
        rough = lerp(rough, 0.6, lap * 0.5);
        // Ponding leaves a chalky ring.
        const p = smoothstep(0.6, 0.85, macro[i]);
        r = lerp(r, pond[0], p * 0.5); g = lerp(g, pond[1], p * 0.5); b = lerp(b, pond[2], p * 0.5);
        rough = lerp(rough, 0.94, p * 0.6);
        // Fresh tar repairs stay glossy for years.
        const fr = smoothstep(0.78, 0.93, mid[i]);
        r = lerp(r, fresh[0], fr); g = lerp(g, fresh[1], fr); b = lerp(b, fresh[2], fr);
        rough = lerp(rough, 0.42, fr);
        height += fr * 0.06;
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    const blisters = F.mask((g, wrap) => {
      for (let n = 0; n < 14; n++) {
        const x = R() * w, y = R() * h, rr = R.range(0.01, 0.05) * w;
        wrap(x, y, rr * 2, (c) => { c.beginPath(); c.arc(x, y, rr, 0, 6.283185307); c.fill(); });
      }
    });
    for (let i = 0; i < S.n; i++) if (blisters[i] > 0.01) S.height[i] += blisters[i] * 0.16;
    F.bakeAO(S, 0.5, 5);
    return { roughScalar: 0.95 };
  },
};

const ROOF_GRAVEL = {
  res: 512, tile: 1.5, base: hx('#8b8579'), rough: 0.95, normalStrength: 1.5, relief: 0.026,
  paint(S, F) {
    const sid = F.noise('s', 1, 1, false);
    const edge = F.noise('d', 1, 1, false);
    const macro = F.noise('A', 2, 2);
    const gr = F.grain();
    const pal = [hx('#a49c8c'), hx('#8b8478'), hx('#c0b8a6'), hx('#6e6a62'), hx('#9a8b74')];
    const tar = hx('#2b2a2c');
    for (let i = 0; i < S.n; i++) {
      const cover = smoothstep(0.06, 0.22, edge[i]);
      const c = pal[(sid[i] * pal.length) | 0];
      const tone = 0.8 + sid[i] * 0.45 + (macro[i] - 0.5) * 0.15;
      let r = c[0] * tone, g = c[1] * tone, b = c[2] * tone;
      const v = (gr[i] - 0.5) * 0.09;
      r += v; g += v; b += v;
      let rough = 0.94 + (gr[i] - 0.5) * 0.05;
      let height = 0.35 + Math.pow(sat(edge[i] / 0.3), 0.6) * 0.55;
      r = lerp(tar[0], r, cover); g = lerp(tar[1], g, cover); b = lerp(tar[2], b, cover);
      rough = lerp(0.8, rough, cover);
      S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
    }
    F.bakeAO(S, 1.0, 6);
    return { roughScalar: 0.99 };
  },
};

/** New England slate shingles, in the purples and greens of Vermont quarries. */
const SLATE_ROOF = {
  res: 512, tile: 1.2, base: hx('#4a4c52'), rough: 0.62, normalStrength: 1.3, relief: 0.022, gain: 1.12,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const cols = 4, rows = 6;
    const bw = w / cols, bh = h / rows;
    const mott = F.noise('A', 2, 2);
    const lam = F.noise('B', 2, 14);
    const gr = F.grain();
    const mossN = F.noise('C', 3, 3);
    const pal = [hx('#4d5058'), hx('#585061'), hx('#464f4c'), hx('#3d3f45'), hx('#5c554c')];
    const moss = hx('#54603a');
    const nS = cols * rows;
    const sPal = new Uint8Array(nS), sTone = new Float32Array(nS), sChip = new Float32Array(nS);
    for (let k = 0; k < nS; k++) { sPal[k] = R.int(pal.length); sTone[k] = R.range(0.85, 1.15); sChip[k] = R() < 0.25 ? R.range(0.1, 0.3) : 0; }

    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const jr = Math.floor(vv * rows), fy = vv * rows - jr;
      const off = (jr & 1) * 0.5;
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const t = uu * cols + off;
        let ic = Math.floor(t); const fx = t - ic;
        ic = ((ic % cols) + cols) % cols;
        const k = jr * cols + ic;
        const p = pal[sPal[k]], tone = sTone[k];
        let r = p[0] * tone, g = p[1] * tone, b = p[2] * tone;
        const lv = (lam[i] - 0.5) * 0.10 + (mott[i] - 0.5) * 0.06 + (gr[i] - 0.5) * 0.04;
        r += lv; g += lv; b += lv;
        // Butt shadow: each course laps the one below.
        const butt = smoothstep(0.0, 0.10, fy);
        let height = 0.35 + butt * 0.5 + (lam[i] - 0.5) * 0.04;
        let rough = 0.6 + (lam[i] - 0.5) * 0.12;
        // Chipped butts, and vertical gaps between slates.
        const gap = smoothstep(0.0, 0.012, Math.min(fx, 1 - fx));
        height = lerp(0.25, height, gap);
        if (sChip[k] > 0 && fy > 0.82) {
          const c = smoothstep(0.82, 1.0, fy) * smoothstep(0.5 - sChip[k], 0.5 + sChip[k], fx) * smoothstep(0.5 + sChip[k] + 0.1, 0.5 + sChip[k], fx);
          height -= c * 0.3;
        }
        const mo = smoothstep(0.78, 0.95, mossN[i]) * (1 - butt * 0.4);
        r = lerp(r, moss[0], mo * 0.7); g = lerp(g, moss[1], mo * 0.7); b = lerp(b, moss[2], mo * 0.7);
        rough = lerp(rough, 0.95, mo);
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.bakeAO(S, 0.9, 6);
    return { roughScalar: 0.95 };
  },
};

/* ---- wood, ground, plants ------------------------------------------------*/

const WOOD_PAINTED = {
  res: 512, tile: 1.12, base: hx('#ddd6c6'), rough: 0.52, normalStrength: 0.85, relief: 0.014,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const laps = 8, lh = h / laps;
    const grain = F.noise('B', 2, 64);
    const grain2 = F.noise('E', 1, 30);
    const macro = F.noise('A', 2, 2);
    const gr = F.grain();
    const paint = hx('#e2dbca'), weather = hx('#8e8779'), bare = hx('#a98d68');

    for (let y = 0; y < h; y++) {
      const row = y * w, ly = (y % lh) / lh;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const gv = (grain[i] - 0.5) * 0.5 + (grain2[i] - 0.5) * 0.5;
        let r = paint[0], g = paint[1], b = paint[2];
        // Brush lay-off and grain telegraphing through the film.
        const v = gv * 0.045 + (macro[i] - 0.5) * 0.05;
        r += v; g += v; b += v * 0.95;
        let rough = 0.5 + gv * 0.10 + (macro[i] - 0.5) * 0.08;
        // Clapboard: a shadow line and a lifted butt at every lap.
        const lap = smoothstep(0.0, 0.09, ly);
        let height = 0.35 + lap * 0.5 + gv * 0.05;
        // Peeling: paint lets go and the weathered wood shows.
        const peel = smoothstep(0.66, 0.86, macro[i] * 0.7 + grain2[i] * 0.3);
        if (peel > 0) {
          r = lerp(r, weather[0], peel); g = lerp(g, weather[1], peel); b = lerp(b, weather[2], peel);
          const deep = smoothstep(0.86, 0.95, macro[i]);
          r = lerp(r, bare[0], deep); g = lerp(g, bare[1], deep); b = lerp(b, bare[2], deep);
          rough = lerp(rough, 0.9, peel);
          height -= peel * 0.06;
        }
        const grn = (gr[i] - 0.5) * 0.03;
        r += grn; g += grn; b += grn;
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    // Nail heads along each lap.
    const nails = F.mask((g, wrap) => {
      for (let l = 0; l < laps; l++) {
        for (let n = 0; n < 5; n++) {
          const x = (n / 5 + R() * 0.06) * w, y = (l + 0.22) * lh, rr = 0.0045 * w;
          wrap(x, y, rr * 2, (c) => { c.beginPath(); c.arc(x, y, rr, 0, 6.283185307); c.fill(); });
        }
      }
    });
    for (let i = 0; i < S.n; i++) if (nails[i] > 0.01) { S.mix(i, [0.55, 0.52, 0.47], nails[i] * 0.5); S.height[i] -= nails[i] * 0.08; }
    F.streaks(S, { amount: 0.2, color: hx('#3a3a30'), freq: 7, rough: 0.03, fade: 0.55 });
    F.bakeAO(S, 0.7, 5);
    return { roughScalar: 0.95 };
  },
};

/** Boston Common turf: mixed grasses, clover, thin worn patches. */
const GRASS = {
  res: 512, tile: 2.0, base: hx('#3f5c2c'), rough: 0.85, normalStrength: 1.1, relief: 0.045, gain: 1.26,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const macro = F.noise('A', 1, 1);
    const clump = F.noise('B', 3, 3);
    const dryN = F.noise('A', 2, 2);
    const gr = F.grain();
    const greens = ['#4c7331', '#3f6329', '#5a8038', '#35521f', '#68884a', '#7d8c3e'];
    const dry = hx('#8a8447'), soil = hx('#3d3125');

    // Blades, drawn as thousands of short strokes; this is what stops turf
    // looking like green felt.
    const blades = F.mask((g, wrap) => {
      g.lineCap = 'round';
      const n = Math.round(3200 * (w / 512) * (h / 512));
      for (let k = 0; k < n; k++) {
        const x = R() * w, y = R() * h;
        const len = R.range(0.012, 0.036) * w, a = -1.5708 + (R() - 0.5) * 1.5;
        g.lineWidth = R.range(0.7, 1.7) * (w / 512);
        g.globalAlpha = R.range(0.35, 1);
        const bow = (R() - 0.5) * 4;      // resolved outside wrap: the wrapped
        wrap(x, y, len, (c) => {          // copies must be the same blade
          c.beginPath(); c.moveTo(x, y);
          c.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + bow, y + Math.sin(a) * len * 0.5,
            x + Math.cos(a) * len, y + Math.sin(a) * len);
          c.stroke();
        });
      }
      g.globalAlpha = 1;
    }, 1);
    const bladeTone = F.grain();

    for (let i = 0; i < S.n; i++) {
      const worn = smoothstep(0.30, 0.10, macro[i]);        // desire paths
      const dryness = smoothstep(0.55, 0.85, dryN[i]);
      const c = hx(greens[(bladeTone[i] * greens.length) | 0]);
      let r = c[0], g = c[1], b = c[2];
      const shade = 0.62 + clump[i] * 0.55;
      r *= shade; g *= shade; b *= shade;
      r = lerp(r, dry[0], dryness * 0.7); g = lerp(g, dry[1], dryness * 0.7); b = lerp(b, dry[2], dryness * 0.7);
      const bl = blades[i];
      // Between the blades you see soil and thatch.
      r = lerp(r * 0.55, r, sat(bl * 1.4 + 0.25));
      g = lerp(g * 0.5, g, sat(bl * 1.4 + 0.25));
      b = lerp(b * 0.5, b, sat(bl * 1.4 + 0.25));
      r = lerp(r, soil[0], worn * 0.75); g = lerp(g, soil[1], worn * 0.75); b = lerp(b, soil[2], worn * 0.75);
      const grn = (gr[i] - 0.5) * 0.05;
      S.r[i] = r + grn; S.g[i] = g + grn; S.b[i] = b + grn;
      S.rough[i] = lerp(0.72, 0.95, sat(1 - bl + worn));    // blades are waxy, soil is not
      S.height[i] = 0.35 + bl * 0.4 + clump[i] * 0.25 - worn * 0.15;
    }
    F.bakeAO(S, 0.8, 5);
    return { roughScalar: 0.96 };
  },
};

const DIRT = {
  res: 512, tile: 2.0, base: hx('#4a3b2c'), rough: 0.95, normalStrength: 1.2, relief: 0.040, gain: 1.18,
  paint(S, F) {
    const { w, h } = F;
    const macro = F.noise('A', 1, 1);
    const mid = F.noise('B', 2, 2);
    const fine = F.noise('B', 5, 5);
    const gr = F.grain();
    const peb = F.noise('c', 1, 1, false);
    const pebId = F.noise('s', 1, 1, false);
    const crack = F.noise('d', 2, 2, false);
    const soilA = hx('#54432f'), soilB = hx('#3b2e21'), soilC = hx('#6b5740');
    const pebble = hx('#8d8676'), organic = hx('#2c2118');

    for (let i = 0; i < S.n; i++) {
      const t = sat(macro[i] * 0.6 + mid[i] * 0.4);
      let r = lerp(soilB[0], soilA[0], t), g = lerp(soilB[1], soilA[1], t), b = lerp(soilB[2], soilA[2], t);
      const dryTop = smoothstep(0.6, 0.9, macro[i]);
      r = lerp(r, soilC[0], dryTop * 0.6); g = lerp(g, soilC[1], dryTop * 0.6); b = lerp(b, soilC[2], dryTop * 0.6);
      const v = (fine[i] - 0.5) * 0.09 + (gr[i] - 0.5) * 0.07;
      r += v; g += v; b += v;
      let rough = 0.95 + (gr[i] - 0.5) * 0.04;
      let height = 0.5 + (mid[i] - 0.5) * 0.2 + (gr[i] - 0.5) * 0.05;
      const pb = smoothstep(0.30, 0.16, peb[i]);
      if (pb > 0) {
        const tone = 0.7 + pebId[i] * 0.6;
        r = lerp(r, pebble[0] * tone, pb); g = lerp(g, pebble[1] * tone, pb); b = lerp(b, pebble[2] * tone, pb);
        rough = lerp(rough, 0.85, pb); height += pb * 0.16;
      }
      const ck = smoothstep(0.10, 0.0, crack[i]) * dryTop;   // shrinkage cracks
      if (ck > 0) { r = lerp(r, organic[0], ck * 0.8); g = lerp(g, organic[1], ck * 0.8); b = lerp(b, organic[2], ck * 0.8); height -= ck * 0.25; }
      const og = smoothstep(0.86, 0.97, fine[i]);
      if (og > 0) { r = lerp(r, organic[0], og * 0.7); g = lerp(g, organic[1], og * 0.7); b = lerp(b, organic[2], og * 0.7); }
      S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
    }
    F.bakeAO(S, 0.85, 6);
    return { roughScalar: 0.99 };
  },
};

/** Leaf-cluster card for tree canopies. Alpha lives in the albedo map. */
const FOLIAGE = {
  res: 512, tile: 1.0, base: hx('#3d5c2a'), rough: 0.68, opaque: false, normalStrength: 0.8, relief: 0.028,
  paint(S, F) {
    const { w, h } = F;
    const R = F.rand;
    const greens = ['#4e7a33', '#3f6a2c', '#5c8c3d', '#355a25', '#6b9245', '#2e4d20', '#7a9a3f'];

    // One leaf list drives shape, depth and veins so all three stay registered.
    const leaves = [];
    for (let k = 0; k < 170; k++) {
      leaves.push([
        w * 0.5 + (R() - 0.5) * w * 0.98,
        h * 0.5 + (R() - 0.5) * h * 0.98,
        R.range(0.048, 0.115) * w,
        R() * 6.283185307,
      ]);
    }
    const forEachLeaf = (fn) => (g, wrap) => {
      for (const [cx, cy, s, a] of leaves) {
        wrap(cx, cy, s * 2, (c) => {
          c.save(); c.translate(cx, cy); c.rotate(a); fn(c, s); c.restore();
        });
      }
    };
    const leafPath = (c, s) => {
      c.beginPath();
      c.moveTo(0, -s);
      c.bezierCurveTo(s * 0.75, -s * 0.45, s * 0.62, s * 0.45, 0, s);
      c.bezierCurveTo(-s * 0.62, s * 0.45, -s * 0.75, -s * 0.45, 0, -s);
    };

    const shape = F.mask(forEachLeaf((c, s) => { leafPath(c, s); c.fill(); }));
    // Stacking count: alpha accumulates where leaves overlap, giving free AO.
    const depth = F.mask((g, wrap) => {
      g.globalAlpha = 0.17;
      forEachLeaf((c, s) => { leafPath(c, s); c.fill(); })(g, wrap);
      g.globalAlpha = 1;
    });
    const veins = F.mask((g, wrap) => {
      g.lineWidth = Math.max(1, w / 420); g.lineCap = 'round';
      forEachLeaf((c, s) => {
        c.beginPath(); c.moveTo(0, -s * 0.92); c.lineTo(0, s * 0.92); c.stroke();
        for (let v = -3; v <= 3; v++) {
          const yy = v * s * 0.24;
          c.beginPath(); c.moveTo(0, yy); c.lineTo(s * 0.46, yy + s * 0.22); c.stroke();
          c.beginPath(); c.moveTo(0, yy); c.lineTo(-s * 0.46, yy + s * 0.22); c.stroke();
        }
      })(g, wrap);
    });

    const tone = F.noise('B', 2, 2);
    const tone2 = F.noise('A', 1, 1);
    for (let i = 0; i < S.n; i++) {
      const a = shape[i];
      const c = hx(greens[Math.min(greens.length - 1, ((tone[i] * 0.6 + tone2[i] * 0.4) * greens.length) | 0)]);
      const d = sat(depth[i] * 1.6);
      const shade = lerp(1.18, 0.42, d);                   // interior of the cluster
      let r = c[0] * shade, g = c[1] * shade, b = c[2] * shade;
      const vn = veins[i];
      r = lerp(r, r * 1.25 + 0.05, vn * 0.55); g = lerp(g, g * 1.2 + 0.06, vn * 0.55); b = lerp(b, b * 1.1 + 0.03, vn * 0.55);
      S.r[i] = r; S.g[i] = g; S.b[i] = b;
      S.alpha[i] = smoothstep(0.35, 0.62, a);
      S.rough[i] = lerp(0.62, 0.80, tone[i]);
      S.ao[i] = lerp(1, 0.55, d);
      S.height[i] = 0.4 + a * 0.35 + vn * 0.1 - d * 0.2;
    }
    return { roughScalar: 0.85 };
  },
};

/* ---- water, rubber, car ---------------------------------------------------*/

const WATER = {
  res: 512, tile: 12.0, base: hx('#1a2c33'), rough: 0.06, orm: false, normalStrength: 0.55, relief: 0.30, floor: 0.0,
  paint(S, F) {
    // Only the normal map matters; chop at three scales, stretched into swell.
    const a = F.noise('B', 1, 2);
    const b = F.noise('A', 3, 2);
    const c = F.noise('B', 6, 5);
    const d = F.noise('E', 11, 9);
    for (let i = 0; i < S.n; i++) {
      S.height[i] = a[i] * 0.42 + b[i] * 0.3 + c[i] * 0.19 + d[i] * 0.09;
      S.r[i] = 0.10; S.g[i] = 0.17; S.b[i] = 0.19;
      S.rough[i] = 0.06; S.metal[i] = 0.02; S.ao[i] = 1;
    }
    return { roughScalar: 0.1 };
  },
};

const TIRE = {
  res: 512, tile: 0.4, base: hx('#161619'), rough: 0.9, normalStrength: 1.0, relief: 0.010, gain: 1.65,
  paint(S, F) {
    const { w, h } = F;
    const blocks = 24;                    // tread blocks around the circumference (u)
    const mould = F.cells(Math.round(w / 3), Math.round(h / 3), {});
    const fine = F.noise('B', 4, 4);
    const gr = F.grain();
    const dust = F.noise('A', 2, 2);
    const rub = hx('#17171a'), dusty = hx('#4a4234');
    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h, row = y * w;
      const shoulder = smoothstep(0.06, 0.16, Math.min(vv, 1 - vv));
      for (let x = 0; x < w; x++) {
        const i = row + x, uu = (x + 0.5) / w;
        const t = (uu * blocks) % 1;
        const groove = smoothstep(0.10, 0.20, Math.min(t, 1 - t));
        const v = (gr[i] - 0.5) * 0.035 + (fine[i] - 0.5) * 0.03 + (mould[i] - 0.5) * 0.04;
        let r = rub[0] + v, g = rub[1] + v, b = rub[2] + v;
        let rough = 0.90 + (mould[i] - 0.5) * 0.09;
        let height = 0.35 + groove * 0.5 * shoulder + shoulder * 0.12;
        // Circumferential rib in the middle.
        const rib = smoothstep(0.03, 0.08, Math.abs(vv - 0.5));
        height = lerp(height + 0.12, height, rib);
        const dt = smoothstep(0.55, 0.9, dust[i]) * (1 - shoulder * 0.7);
        r = lerp(r, dusty[0], dt * 0.35); g = lerp(g, dusty[1], dt * 0.35); b = lerp(b, dusty[2], dt * 0.35);
        rough = lerp(rough, 0.97, dt);
        S.r[i] = r; S.g[i] = g; S.b[i] = b; S.rough[i] = rough; S.height[i] = height;
      }
    }
    F.bakeAO(S, 0.8, 5);
    return { roughScalar: 0.98 };
  },
};

const GLASS_CAR = {
  res: 256, tile: 1.0, base: hx('#0b1013'), rough: 0.05, normalStrength: 0.25, relief: 0.0020, gain: 1.40, floor: 0.0,
  paint(S, F) {
    const smear = F.noise('E', 4, 1);
    const dust = F.noise('A', 2, 2);
    const gr = F.grain();
    for (let i = 0; i < S.n; i++) {
      const d = sat((smear[i] - 0.55) * 2) * 0.6 + smoothstep(0.7, 0.95, dust[i]) * 0.4;
      S.r[i] = 0.055 + d * 0.10; S.g[i] = 0.065 + d * 0.10; S.b[i] = 0.075 + d * 0.10;
      S.rough[i] = sat(0.035 + d * 0.16);
      S.metal[i] = 0;
      S.height[i] = 0.5 + (dust[i] - 0.5) * 0.35 + (gr[i] - 0.5) * 0.02;
    }
    return { roughScalar: 0.25 };
  },
};

/** Metallic flake + clearcoat orange peel, shared by every car colour. */
const CAR_FLAKE = {
  res: 512, tile: 0.35, base: hx('#808080'), rough: 0.3, normalStrength: 0.35, relief: 0.0006,
  paint(S, F) {
    const { w, h } = F;
    const flake = F.cells(Math.round(w / 2), Math.round(h / 2), { round: 0.5 });
    const gr = F.grain();
    for (let i = 0; i < S.n; i++) {
      S.r[i] = 0.5; S.g[i] = 0.5; S.b[i] = 0.5;
      S.rough[i] = 0.28 + (flake[i] - 0.5) * 0.10;
      S.metal[i] = 1;
      S.height[i] = 0.5 + (flake[i] - 0.5) * 0.9 + (gr[i] - 0.5) * 0.2;
    }
    return { roughScalar: 0.4, metalScalar: 1.0 };
  },
};

const CAR_CLEARCOAT = {
  res: 256, tile: 1.2, base: hx('#808080'), rough: 0.05, orm: false, normalStrength: 0.14, relief: 0.0022,
  paint(S, F) {
    const a = F.noise('A', 2, 2);
    const b = F.noise('B', 5, 5);
    for (let i = 0; i < S.n; i++) {
      S.height[i] = a[i] * 0.6 + b[i] * 0.4;      // gentle orange peel
      S.r[i] = 0.5; S.g[i] = 0.5; S.b[i] = 0.5;
    }
    return {};
  },
};

export const RECIPES = {
  asphalt: ASPHALT,
  asphalt_worn: ASPHALT_WORN,
  concrete: CONCRETE,
  concrete_stained: CONCRETE_STAINED,
  sidewalk: SIDEWALK,
  sidewalk_brick: SIDEWALK_BRICK,
  cobblestone: COBBLESTONE,
  brick_red: BRICK_RED,
  brick_brown: BRICK_BROWN,
  brownstone: BROWNSTONE,
  granite: GRANITE,
  limestone: LIMESTONE,
  glass_tower: GLASS_TOWER,
  glass_dark: GLASS_DARK,
  window_lit: WINDOW_LIT,
  metal_painted: METAL_PAINTED,
  metal_rusty: METAL_RUSTY,
  steel_brushed: STEEL_BRUSHED,
  copper_patina: COPPER_PATINA,
  roof_tar: ROOF_TAR,
  roof_gravel: ROOF_GRAVEL,
  slate_roof: SLATE_ROOF,
  wood_painted: WOOD_PAINTED,
  grass: GRASS,
  dirt: DIRT,
  foliage: FOLIAGE,
  water: WATER,
  road_line_white: ROAD_LINE_WHITE,
  road_line_yellow: ROAD_LINE_YELLOW,
  chrome: CHROME,
  tire: TIRE,
  glass_car: GLASS_CAR,
  _car_flake: CAR_FLAKE,
  _car_clearcoat: CAR_CLEARCOAT,
};
