import * as THREE from 'three';

/**
 * BuildingKit — the low-level layer under every building in the city.
 *
 * Three things live here:
 *  1. A procedural material atlas built as WebGL2 **texture arrays**. Every opaque
 *     building surface in Boston therefore shares ONE material, so a whole chunk of
 *     the city is a single draw call. Texture arrays (rather than a packed 2D atlas)
 *     mean each layer tiles natively with REPEAT and gets its own mip chain — no
 *     `fract()` hacks, no bleeding across tile borders.
 *  2. `MeshBuf` / `GlassBuf`, tiny append-only vertex accumulators. All the facade
 *     grammar does is push triangles into one of these; the result is baked once into
 *     an indexed BufferGeometry.
 *  3. The two shaders: an array-atlas Standard material with large-scale macro
 *     variation (kills tiling repetition), and an interior-mapped glass material that
 *     parallaxes a real room behind every pane.
 *
 * Nothing in here allocates per frame.
 */

const SZ = 256;                 // texels per atlas layer
const ROOM_SZ = 128;            // texels per interior-room layer

/* -------------------------------------------------------------------------- */
/* Surface table                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every buildable surface. `size` is how many metres one texture repeat covers,
 * so UVs are always authored in metres and divided by it.
 * `rough`/`metal` are the base PBR response; the ORM layer modulates roughness.
 */
export const SURF = {
  brick_red:      { size: 1.224, rough: 0.88, metal: 0.0 },
  brick_dark:     { size: 1.224, rough: 0.90, metal: 0.0 },
  brick_brown:    { size: 1.224, rough: 0.87, metal: 0.0 },
  brick_painted:  { size: 1.224, rough: 0.80, metal: 0.0 },
  brownstone:     { size: 1.800, rough: 0.86, metal: 0.0 },
  brownstone_rus: { size: 1.800, rough: 0.88, metal: 0.0 },
  granite:        { size: 2.400, rough: 0.74, metal: 0.0 },
  limestone:      { size: 2.400, rough: 0.72, metal: 0.0 },
  terracotta:     { size: 1.200, rough: 0.52, metal: 0.0 },
  concrete:       { size: 2.000, rough: 0.84, metal: 0.0 },
  stucco:         { size: 2.000, rough: 0.90, metal: 0.0 },
  trim_stone:     { size: 1.000, rough: 0.66, metal: 0.0 },
  slate:          { size: 1.000, rough: 0.62, metal: 0.0 },
  roof_tar:       { size: 3.000, rough: 0.93, metal: 0.0 },
  roof_gravel:    { size: 2.000, rough: 0.96, metal: 0.0 },
  metal_panel:    { size: 1.500, rough: 0.42, metal: 0.85 },
  metal_dark:     { size: 1.000, rough: 0.48, metal: 0.80 },
  metal_rust:     { size: 1.000, rough: 0.78, metal: 0.55 },
  copper:         { size: 1.200, rough: 0.55, metal: 0.55 },
  gold:           { size: 1.000, rough: 0.16, metal: 1.00 },
  wood_white:     { size: 1.000, rough: 0.52, metal: 0.0 },
  wood_dark:      { size: 1.000, rough: 0.60, metal: 0.0 },
  spandrel:       { size: 1.500, rough: 0.22, metal: 0.30 },
  awning:         { size: 1.000, rough: 0.85, metal: 0.0 },
  sign:           { size: 1.000, rough: 0.55, metal: 0.0 },
  paint_green:    { size: 1.500, rough: 0.70, metal: 0.0 },
  // Baked whole-facade strips — one repeat = one storey. Distant LOD only.
  fac_brick:      { size: 3.200, rough: 0.88, metal: 0.0, vsize: 3.30 },
  fac_brownstone: { size: 3.400, rough: 0.86, metal: 0.0, vsize: 3.60 },
  fac_stone:      { size: 3.600, rough: 0.74, metal: 0.0, vsize: 3.90 },
  fac_glass:      { size: 3.000, rough: 0.14, metal: 0.55, vsize: 3.80 },
  fac_metal:      { size: 3.000, rough: 0.38, metal: 0.60, vsize: 3.40 },
};

export const LAYER = {};
{
  let i = 0;
  for (const k of Object.keys(SURF)) { SURF[k].layer = i; LAYER[k] = i; i++; }
}
const LAYER_COUNT = Object.keys(SURF).length;

/* -------------------------------------------------------------------------- */
/* Deterministic noise helpers                                                */
/* -------------------------------------------------------------------------- */

/** Small fast xorshift PRNG so every build is reproducible. */
export function rng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0;
    return ((s >>> 0) % 1e6) / 1e6;
  };
}

/** Deterministic hash 0..1 from two ints — used for per-building variation. */
export function hash2(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/* -------------------------------------------------------------------------- */
/* Procedural tile painting                                                   */
/* -------------------------------------------------------------------------- */

function newCanvas(size = SZ) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Speckle a rect with fine grain — the single biggest "this is not flat colour" win. */
function grain(g, x, y, w, h, amount, count, r) {
  for (let i = 0; i < count; i++) {
    const px = x + r() * w, py = y + r() * h;
    const s = 0.6 + r() * 1.9;
    const v = (r() - 0.5) * amount;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(px, py, s, s);
  }
}

/** Soft blotchy tonal drift, wrapped so the tile still repeats seamlessly. */
function blotch(g, size, count, radius, amount, r, tint = null) {
  for (let i = 0; i < count; i++) {
    const cx = r() * size, cy = r() * size;
    const rad = radius * (0.5 + r());
    const v = (r() - 0.5) * amount;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const gx = cx + ox * size, gy = cy + oy * size;
      if (gx < -rad || gx > size + rad || gy < -rad || gy > size + rad) continue;
      const grd = g.createRadialGradient(gx, gy, 0, gx, gy, rad);
      const c = tint || (v > 0 ? '255,255,255' : '0,0,0');
      grd.addColorStop(0, `rgba(${c},${Math.abs(v)})`);
      grd.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grd;
      g.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
    }
  }
}

/** Vertical dirt streaks — what actually makes brick read as 150 years old. */
function streaks(g, size, count, amount, r) {
  for (let i = 0; i < count; i++) {
    const x = r() * size;
    const w = 1 + r() * 7;
    const y0 = r() * size * 0.6;
    const len = size * (0.25 + r() * 0.8);
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    grd.addColorStop(0, `rgba(24,20,16,${amount * (0.4 + r() * 0.6)})`);
    grd.addColorStop(1, 'rgba(24,20,16,0)');
    g.fillStyle = grd;
    g.fillRect(x, y0, w, len);
    if (x + w > size) g.fillRect(x - size, y0, w, len);
  }
}

/**
 * Brick bond. Returns the height field too, since mortar joints are what give
 * brick its raking-light relief.
 */
function paintBrick(a, h, ro, base, mortarL, seedN, sooty) {
  const r = rng(seedN);
  const cols = 6, rows = 16;
  const bw = SZ / cols, bh = SZ / rows;
  a.fillStyle = mortarL; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#4a4a4a'; h.fillRect(0, 0, SZ, SZ);     // mortar sits back
  ro.fillStyle = '#e8e8e8'; ro.fillRect(0, 0, SZ, SZ);   // mortar is rough

  const [br, bg, bb] = base;
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) ? bw * 0.5 : 0;
    for (let col = -1; col < cols + 1; col++) {
      const x = col * bw + off + 0.9, y = row * bh + 0.9;
      const w = bw - 1.8, hh = bh - 1.8;
      const t = (r() - 0.5) * 0.30;
      const warm = (r() - 0.5) * 0.16;
      const cr = Math.min(255, Math.max(0, br * (1 + t + warm)));
      const cg = Math.min(255, Math.max(0, bg * (1 + t)));
      const cb = Math.min(255, Math.max(0, bb * (1 + t - warm * 0.7)));
      a.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      a.fillRect(x, y, w, hh);
      // a few over-fired / clinker bricks, and the odd replaced one
      if (r() < 0.05) { a.fillStyle = `rgba(30,24,26,0.55)`; a.fillRect(x, y, w, hh); }
      const face = 190 + (r() - 0.5) * 55;
      h.fillStyle = `rgb(${face | 0},${face | 0},${face | 0})`;
      h.fillRect(x, y, w, hh);
      const rr = 150 + r() * 70;
      ro.fillStyle = `rgb(${rr | 0},${rr | 0},${rr | 0})`;
      ro.fillRect(x, y, w, hh);
      grain(a, x, y, w, hh, 0.10, 22, r);
      if (r() < 0.14) { // spalled face
        a.fillStyle = 'rgba(255,250,240,0.10)';
        a.fillRect(x + r() * w * 0.5, y + r() * hh * 0.4, w * 0.4, hh * 0.5);
      }
    }
  }
  blotch(a, SZ, 12, 60, 0.20, r);
  if (sooty) { blotch(a, SZ, 10, 74, 0.30, r, '18,15,13'); streaks(a, SZ, 14, 0.36, r); }
  else streaks(a, SZ, 7, 0.18, r);
  grain(a, 0, 0, SZ, SZ, 0.06, 2600, r);
}

/** Coursed ashlar stone. `courses` blocks tall, deep or fine joints. */
function paintAshlar(a, h, ro, base, courses, perRow, seedN, deepJoint, speckle) {
  const r = rng(seedN);
  const bh = SZ / courses, bw = SZ / perRow;
  const j = deepJoint ? 3.2 : 1.4;
  const [br, bg, bb] = base;
  a.fillStyle = `rgb(${(br * 0.62) | 0},${(bg * 0.62) | 0},${(bb * 0.62) | 0})`;
  a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = deepJoint ? '#2a2a2a' : '#5c5c5c'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#d8d8d8'; ro.fillRect(0, 0, SZ, SZ);

  for (let row = 0; row < courses; row++) {
    const off = (row % 2) ? bw * 0.5 : 0;
    for (let col = -1; col < perRow + 1; col++) {
      const x = col * bw + off + j, y = row * bh + j;
      const w = bw - j * 2, hh = bh - j * 2;
      const t = (r() - 0.5) * 0.13;
      a.fillStyle = `rgb(${(br * (1 + t)) | 0},${(bg * (1 + t)) | 0},${(bb * (1 + t)) | 0})`;
      a.fillRect(x, y, w, hh);
      const face = deepJoint ? 168 + r() * 40 : 200 + r() * 30;
      h.fillStyle = `rgb(${face | 0},${face | 0},${face | 0})`;
      h.fillRect(x, y, w, hh);
      if (deepJoint) { // chamfered rustication highlight
        h.fillStyle = 'rgba(255,255,255,0.35)';
        h.fillRect(x, y, w, 2);
      }
      const rr = 130 + r() * 90;
      ro.fillStyle = `rgb(${rr | 0},${rr | 0},${rr | 0})`;
      ro.fillRect(x, y, w, hh);
      grain(a, x, y, w, hh, speckle, 240, r);
    }
  }
  blotch(a, SZ, 10, 66, 0.16, r);
  streaks(a, SZ, 6, 0.20, r);
  grain(a, 0, 0, SZ, SZ, 0.05, 2200, r);
}

function paintFlat(a, h, ro, col, roughV, seedN, opts = {}) {
  const r = rng(seedN);
  a.fillStyle = col; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#808080'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = `rgb(${roughV},${roughV},${roughV})`; ro.fillRect(0, 0, SZ, SZ);
  blotch(a, SZ, opts.blotch ?? 12, 52, opts.blotchAmt ?? 0.14, r);
  if (opts.streak) streaks(a, SZ, opts.streak, 0.22, r);
  grain(a, 0, 0, SZ, SZ, opts.grain ?? 0.09, 3600, r);
  if (opts.hgrain) grain(h, 0, 0, SZ, SZ, opts.hgrain, 5200, r);
  grain(ro, 0, 0, SZ, SZ, 0.20, 2600, r);
}

/* -- individual specials --------------------------------------------------- */

function paintSlate(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#2c3238'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#3a3a3a'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#9a9a9a'; ro.fillRect(0, 0, SZ, SZ);
  const rows = 8, cols = 6;
  const bh = SZ / rows, bw = SZ / cols;
  for (let row = rows - 1; row >= 0; row--) {
    const off = (row % 2) ? bw * 0.5 : 0;
    for (let col = -1; col < cols + 1; col++) {
      const x = col * bw + off, y = row * bh;
      const t = (r() - 0.5) * 0.30;
      const c = 52 * (1 + t);
      a.fillStyle = `rgb(${(c * 0.86) | 0},${(c * 0.96) | 0},${(c * 1.06) | 0})`;
      a.beginPath();
      a.moveTo(x + 1, y); a.lineTo(x + bw - 1, y);
      a.lineTo(x + bw - 1, y + bh * 1.5); a.lineTo(x + 1, y + bh * 1.5);
      a.closePath(); a.fill();
      h.fillStyle = `rgb(${(150 + r() * 60) | 0},0,0)`;
      h.fillRect(x + 1, y, bw - 2, bh * 1.5);
      h.fillStyle = 'rgba(0,0,0,0.55)';
      h.fillRect(x + 1, y + bh * 1.5 - 2, bw - 2, 2);
      const rr = 110 + r() * 90;
      ro.fillStyle = `rgb(${rr | 0},${rr | 0},${rr | 0})`;
      ro.fillRect(x + 1, y, bw - 2, bh * 1.5);
    }
  }
  blotch(a, SZ, 8, 50, 0.20, r);
  grain(a, 0, 0, SZ, SZ, 0.08, 2400, r);
}

function paintRoofTar(a, h, ro, seedN, gravel) {
  const r = rng(seedN);
  a.fillStyle = gravel ? '#5a5750' : '#33322f'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#7a7a7a'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#f0f0f0'; ro.fillRect(0, 0, SZ, SZ);
  if (gravel) {
    for (let i = 0; i < 9000; i++) {
      const x = r() * SZ, y = r() * SZ, s = 1 + r() * 2.4;
      const v = 70 + r() * 110;
      a.fillStyle = `rgb(${v | 0},${(v * 0.97) | 0},${(v * 0.9) | 0})`;
      a.fillRect(x, y, s, s);
      h.fillStyle = `rgba(255,255,255,${r() * 0.5})`;
      h.fillRect(x, y, s, s);
    }
  } else {
    // rolled-felt seams and patch repairs
    for (let i = 0; i < 4; i++) {
      const y = (i + 0.5) * SZ / 4 + (r() - 0.5) * 6;
      a.fillStyle = 'rgba(20,19,18,0.75)'; a.fillRect(0, y, SZ, 3);
      h.fillStyle = 'rgba(255,255,255,0.6)'; h.fillRect(0, y - 1, SZ, 5);
    }
    for (let i = 0; i < 7; i++) {
      const x = r() * SZ, y = r() * SZ, w = 30 + r() * 70, hh = 20 + r() * 50;
      a.fillStyle = `rgba(${(30 + r() * 40) | 0},${(28 + r() * 36) | 0},${(26 + r() * 30) | 0},0.8)`;
      a.fillRect(x, y, w, hh);
      ro.fillStyle = `rgba(${(160 + r() * 70) | 0},0,0,0.7)`; ro.fillRect(x, y, w, hh);
    }
    blotch(a, SZ, 14, 46, 0.30, r);
  }
  streaks(a, SZ, 5, 0.16, r);
  grain(a, 0, 0, SZ, SZ, 0.14, 5200, r);
}

function paintMetalPanel(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#8d939a'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#c0c0c0'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#6a6a6a'; ro.fillRect(0, 0, SZ, SZ);
  const n = 2;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = i * SZ / n, y = j * SZ / n, s = SZ / n;
    const t = (r() - 0.5) * 0.10;
    a.fillStyle = `rgb(${(141 * (1 + t)) | 0},${(147 * (1 + t)) | 0},${(154 * (1 + t)) | 0})`;
    a.fillRect(x + 2, y + 2, s - 4, s - 4);
    h.fillStyle = '#2a2a2a'; h.fillRect(x, y, s, 2); h.fillRect(x, y, 2, s);
    grain(a, x, y, s, s, 0.04, 500, r);
  }
  blotch(a, SZ, 8, 60, 0.08, r);
  streaks(a, SZ, 3, 0.10, r);
}

function paintAwning(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#8d2028'; a.fillRect(0, 0, SZ, SZ);
  const stripe = SZ / 6;
  for (let i = 0; i < 6; i += 2) {
    a.fillStyle = '#f2ece0'; a.fillRect(i * stripe, 0, stripe, SZ);
  }
  h.fillStyle = '#808080'; h.fillRect(0, 0, SZ, SZ);
  for (let i = 0; i < 6; i++) { // scalloped rib relief
    h.fillStyle = 'rgba(255,255,255,0.45)';
    h.fillRect(i * stripe, 0, 3, SZ);
  }
  ro.fillStyle = '#dcdcdc'; ro.fillRect(0, 0, SZ, SZ);
  blotch(a, SZ, 10, 40, 0.18, r);
  streaks(a, SZ, 6, 0.24, r);
  grain(a, 0, 0, SZ, SZ, 0.08, 3000, r);
}

function paintSign(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#12161c'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#808080'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#7a7a7a'; ro.fillRect(0, 0, SZ, SZ);
  // Abstract lettering: shop fascias read as light shapes on a dark board at
  // any distance you can actually resolve them from in-game.
  const words = 2 + ((r() * 2) | 0);
  let x = 18;
  const cy = SZ * 0.5;
  const cols = ['#f6e7c4', '#e8f2ff', '#ffd9a0', '#e0ffe8'];
  const col = cols[(r() * cols.length) | 0];
  for (let w = 0; w < words; w++) {
    const letters = 3 + ((r() * 5) | 0);
    for (let l = 0; l < letters; l++) {
      const lw = 9 + r() * 8, lh = 34 + r() * 16;
      a.fillStyle = col;
      a.fillRect(x, cy - lh / 2, lw, lh);
      a.fillStyle = 'rgba(0,0,0,0.55)';
      a.fillRect(x + 2, cy - lh / 2 + lh * 0.34, lw - 4, lh * 0.16);
      h.fillStyle = '#e0e0e0'; h.fillRect(x, cy - lh / 2, lw, lh);
      x += lw + 5;
      if (x > SZ - 20) break;
    }
    x += 12;
    if (x > SZ - 30) break;
  }
  grain(a, 0, 0, SZ, SZ, 0.06, 1500, r);
}

function paintGold(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#d9a326'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#909090'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#2a2a2a'; ro.fillRect(0, 0, SZ, SZ);
  // gold leaf is laid in overlapping squares; the seams catch the light
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const t = (r() - 0.5) * 0.10;
    a.fillStyle = `rgb(${(217 * (1 + t)) | 0},${(163 * (1 + t)) | 0},${(38 * (1 + t * 1.4)) | 0})`;
    a.fillRect(i * 32, j * 32, 32, 32);
    h.fillStyle = 'rgba(255,255,255,0.30)'; h.fillRect(i * 32, j * 32, 32, 1.5);
    ro.fillStyle = `rgba(${(28 + r() * 40) | 0},0,0,0.6)`; ro.fillRect(i * 32, j * 32, 32, 32);
  }
  grain(a, 0, 0, SZ, SZ, 0.05, 1800, r);
}

function paintCopper(a, h, ro, seedN) {
  const r = rng(seedN);
  a.fillStyle = '#4e8c76'; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#808080'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = '#8a8a8a'; ro.fillRect(0, 0, SZ, SZ);
  blotch(a, SZ, 26, 46, 0.34, r, '38,92,74');
  blotch(a, SZ, 14, 30, 0.28, r, '120,72,40');
  for (let i = 0; i < 5; i++) { // standing seams
    const x = i * SZ / 5;
    a.fillStyle = 'rgba(24,60,50,0.55)'; a.fillRect(x, 0, 4, SZ);
    h.fillStyle = 'rgba(255,255,255,0.6)'; h.fillRect(x, 0, 4, SZ);
  }
  grain(a, 0, 0, SZ, SZ, 0.10, 3000, r);
}

/**
 * Baked facade strip for the distant LOD. One vertical repeat is exactly one
 * storey, so the far skyline still has correct-scale window rows for ~2 triangles.
 * Alpha channel carries the window mask that lights up at night.
 */
function paintFacadeStrip(a, h, ro, kind, seedN) {
  const r = rng(seedN);
  const wallCols = {
    fac_brick: ['#8e4a38', '#6f3a2c'],
    fac_brownstone: ['#7a5a41', '#5e4531'],
    fac_stone: ['#b9b2a4', '#948d81'],
    fac_glass: ['#2b3d4c', '#1d2b36'],
    fac_metal: ['#8d939a', '#5f666d'],
  }[kind];
  a.fillStyle = wallCols[0]; a.fillRect(0, 0, SZ, SZ);
  h.fillStyle = '#a0a0a0'; h.fillRect(0, 0, SZ, SZ);
  ro.fillStyle = kind === 'fac_glass' ? '#3a3a3a' : '#d0d0d0';
  ro.fillRect(0, 0, SZ, SZ);
  // the tile is opaque wall by default -> alpha 1 everywhere, window mask via alpha 0
  const img = a.getImageData(0, 0, SZ, SZ);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
  a.putImageData(img, 0, 0);

  if (kind === 'fac_glass' || kind === 'fac_metal') {
    const bays = kind === 'fac_glass' ? 4 : 3;
    const bw = SZ / bays;
    // spandrel band at the floor line
    a.fillStyle = wallCols[1]; a.fillRect(0, SZ * 0.72, SZ, SZ * 0.28);
    for (let i = 0; i < bays; i++) {
      a.fillStyle = 'rgba(255,255,255,1)';    // alpha 255 = lit at night
      a.globalAlpha = 1;
      const gx = i * bw + 3, gw = bw - 6;
      const grd = a.createLinearGradient(gx, 0, gx, SZ * 0.72);
      grd.addColorStop(0, 'rgba(120,150,175,1)');
      grd.addColorStop(0.55, 'rgba(46,66,84,1)');
      grd.addColorStop(1, 'rgba(30,44,58,1)');
      a.fillStyle = grd;
      a.fillRect(gx, SZ * 0.06, gw, SZ * 0.62);
      // mullion
      a.fillStyle = 'rgba(38,42,46,1)'; a.fillRect(i * bw, 0, 3, SZ);
      h.fillStyle = '#f0f0f0'; h.fillRect(i * bw, 0, 3, SZ);
    }
  } else {
    const bays = 3;
    const bw = SZ / bays;
    for (let i = 0; i < bays; i++) {
      const gx = i * bw + bw * 0.28, gw = bw * 0.44;
      const gy = SZ * 0.16, gh = SZ * 0.50;
      a.fillStyle = 'rgba(22,24,28,1)';
      a.fillRect(gx - 3, gy - 3, gw + 6, gh + 6);   // reveal shadow
      const grd = a.createLinearGradient(gx, gy, gx, gy + gh);
      grd.addColorStop(0, 'rgba(58,70,84,1)');
      grd.addColorStop(1, 'rgba(26,32,40,1)');
      a.fillStyle = grd; a.fillRect(gx, gy, gw, gh);
      h.fillStyle = '#202020'; h.fillRect(gx - 3, gy - 3, gw + 6, gh + 6);
      // sill + lintel
      a.fillStyle = kind === 'fac_stone' ? '#c9c2b2' : '#cfc7b6';
      a.globalAlpha = 1;
      a.fillRect(gx - 6, gy + gh, gw + 12, 5);
      a.fillRect(gx - 6, gy - 8, gw + 12, 5);
      h.fillStyle = '#ffffff'; h.fillRect(gx - 6, gy + gh, gw + 12, 5);
    }
    // cornice / floor band at the top of the storey
    a.fillStyle = 'rgba(0,0,0,0.30)'; a.fillRect(0, SZ * 0.92, SZ, SZ * 0.08);
    h.fillStyle = '#d8d8d8'; h.fillRect(0, SZ * 0.92, SZ, SZ * 0.08);
    blotch(a, SZ, 8, 44, 0.14, r);
    streaks(a, SZ, 5, 0.18, r);
  }
  grain(a, 0, 0, SZ, SZ, 0.07, 2200, r);
}

/* -------------------------------------------------------------------------- */
/* Atlas assembly                                                             */
/* -------------------------------------------------------------------------- */

/** Sobel the height canvas into a tangent-space normal, wrapping at the edges. */
function heightToNormal(src, out, off, strength) {
  const w = SZ, h = SZ;
  const d = src.data;
  const at = (x, y) => {
    const xx = ((x % w) + w) % w, yy = ((y % h) + h) % h;
    return d[(yy * w + xx) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1;               // +Y in UV space is up the wall
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = off + (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
}

/** Cheap cavity AO straight from the height field. */
function heightToAO(src) {
  const w = SZ, d = src.data;
  const ao = new Float32Array(w * w);
  const at = (x, y) => {
    const xx = ((x % w) + w) % w, yy = ((y % w) + w) % w;
    return d[(yy * w + xx) * 4] / 255;
  };
  const R = 5;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const c = at(x, y);
    let sum = 0, n = 0;
    for (let oy = -R; oy <= R; oy += 2) for (let ox = -R; ox <= R; ox += 2) {
      sum += at(x + ox, y + oy); n++;
    }
    const avg = sum / n;
    ao[y * w + x] = Math.min(1, Math.max(0, 0.55 + (c - avg) * 2.2 + 0.45));
  }
  return ao;
}

/**
 * Build the three texture arrays. ~30 layers of 256px is roughly 3 MB of canvas
 * work; it runs once at init and costs a couple of hundred ms.
 */
export function buildAtlas() {
  const albedo = new Uint8Array(SZ * SZ * 4 * LAYER_COUNT);
  const normal = new Uint8Array(SZ * SZ * 4 * LAYER_COUNT);
  const orm = new Uint8Array(SZ * SZ * 4 * LAYER_COUNT);

  const ca = newCanvas(), ch = newCanvas(), cr = newCanvas();
  const a = ca.getContext('2d', { willReadFrequently: true });
  const h = ch.getContext('2d', { willReadFrequently: true });
  const ro = cr.getContext('2d', { willReadFrequently: true });

  let seed = 1337;
  for (const [name, def] of Object.entries(SURF)) {
    a.setTransform(1, 0, 0, 1, 0, 0); h.setTransform(1, 0, 0, 1, 0, 0);
    ro.setTransform(1, 0, 0, 1, 0, 0);
    a.globalAlpha = 1; a.clearRect(0, 0, SZ, SZ);
    h.globalAlpha = 1; ro.globalAlpha = 1;
    seed += 7919;
    let bump = 2.6;

    switch (name) {
      case 'brick_red':     paintBrick(a, h, ro, [151, 78, 60], '#b0a496', seed, false); break;
      case 'brick_dark':    paintBrick(a, h, ro, [116, 60, 48], '#7d7266', seed, true); break;
      case 'brick_brown':   paintBrick(a, h, ro, [140, 108, 82], '#a89c8c', seed, false); break;
      case 'brick_painted': paintBrick(a, h, ro, [196, 190, 176], '#c8c2b4', seed, true); bump = 1.6; break;
      case 'brownstone':    paintAshlar(a, h, ro, [128, 92, 66], 4, 2, seed, false, 0.10); break;
      case 'brownstone_rus':paintAshlar(a, h, ro, [116, 84, 60], 4, 2, seed, true, 0.13); bump = 4.0; break;
      case 'granite':       paintAshlar(a, h, ro, [156, 152, 145], 3, 2, seed, false, 0.26); break;
      case 'limestone':     paintAshlar(a, h, ro, [196, 189, 173], 3, 2, seed, false, 0.10); break;
      case 'terracotta':    paintAshlar(a, h, ro, [206, 190, 162], 5, 3, seed, false, 0.06); bump = 1.8; break;
      case 'concrete':      paintFlat(a, h, ro, '#9a968f', 208, seed, { streak: 8, grain: 0.11, hgrain: 0.10 });
        { const r = rng(seed + 3); for (let i = 0; i < 8; i++) {   // board-form lines
            const y = i * SZ / 8; h.fillStyle = 'rgba(0,0,0,0.45)'; h.fillRect(0, y, SZ, 2.5);
            a.fillStyle = 'rgba(0,0,0,0.10)'; a.fillRect(0, y, SZ, 2.5);
            for (let k = 0; k < 3; k++) {   // tie-rod holes
              const x = r() * SZ; h.fillStyle = 'rgba(0,0,0,0.7)';
              h.beginPath(); h.arc(x, y + SZ / 16, 3, 0, 6.283); h.fill();
              a.fillStyle = 'rgba(0,0,0,0.22)';
              a.beginPath(); a.arc(x, y + SZ / 16, 3, 0, 6.283); a.fill();
            } } }
        bump = 2.0; break;
      case 'stucco':        paintFlat(a, h, ro, '#c8bfae', 230, seed, { streak: 7, grain: 0.13, hgrain: 0.22 }); break;
      case 'trim_stone':    paintFlat(a, h, ro, '#cdc6b6', 176, seed, { blotch: 8, grain: 0.06, hgrain: 0.05 }); bump = 1.2; break;
      case 'slate':         paintSlate(a, h, ro, seed); bump = 3.4; break;
      case 'roof_tar':      paintRoofTar(a, h, ro, seed, false); bump = 2.2; break;
      case 'roof_gravel':   paintRoofTar(a, h, ro, seed, true); bump = 2.8; break;
      case 'metal_panel':   paintMetalPanel(a, h, ro, seed); bump = 2.2; break;
      case 'metal_dark':    paintFlat(a, h, ro, '#33383d', 130, seed, { blotch: 10, grain: 0.07, hgrain: 0.08 }); break;
      case 'metal_rust':    paintFlat(a, h, ro, '#6d4a33', 210, seed, { blotch: 22, blotchAmt: 0.42, streak: 9, grain: 0.16, hgrain: 0.30 }); break;
      case 'copper':        paintCopper(a, h, ro, seed); bump = 2.4; break;
      case 'gold':          paintGold(a, h, ro, seed); bump = 1.0; break;
      case 'wood_white':    paintFlat(a, h, ro, '#e8e5dc', 148, seed, { streak: 5, grain: 0.06, hgrain: 0.12 });
        { for (let i = 0; i < 4; i++) { const x = i * SZ / 4;   // board joints
            h.fillStyle = 'rgba(0,0,0,0.5)'; h.fillRect(x, 0, SZ / 64, SZ);
            a.fillStyle = 'rgba(0,0,0,0.14)'; a.fillRect(x, 0, SZ / 64, SZ); } }
        break;
      case 'wood_dark':     paintFlat(a, h, ro, '#3a2a1e', 168, seed, { streak: 4, grain: 0.10, hgrain: 0.16 }); break;
      case 'spandrel':      paintFlat(a, h, ro, '#242a31', 68, seed, { blotch: 6, blotchAmt: 0.07, grain: 0.03 }); bump = 1.0; break;
      case 'awning':        paintAwning(a, h, ro, seed); bump = 2.0; break;
      case 'sign':          paintSign(a, h, ro, seed); bump = 1.4; break;
      case 'paint_green':   paintFlat(a, h, ro, '#1d4b32', 190, seed, { blotch: 14, blotchAmt: 0.20, streak: 6, grain: 0.08, hgrain: 0.06 }); break;
      default:
        if (name.startsWith('fac_')) { paintFacadeStrip(a, h, ro, name, seed); bump = 2.0; }
        else paintFlat(a, h, ro, '#808080', 200, seed, {});
    }

    const li = def.layer;
    const off = SZ * SZ * 4 * li;
    const ia = a.getImageData(0, 0, SZ, SZ);
    albedo.set(ia.data, off);
    const ih = h.getImageData(0, 0, SZ, SZ);
    heightToNormal(ih, normal, off, bump * 8);
    const ir = ro.getImageData(0, 0, SZ, SZ);
    const ao = heightToAO(ih);
    for (let i = 0; i < SZ * SZ; i++) {
      orm[off + i * 4] = Math.min(255, ao[i] * 255) | 0;
      orm[off + i * 4 + 1] = ir.data[i * 4];
      orm[off + i * 4 + 2] = (def.metal * 255) | 0;
      orm[off + i * 4 + 3] = 255;
    }
  }

  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, SZ, SZ, LAYER_COUNT);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(albedo, true), normal: mk(normal, false), orm: mk(orm, false) };
}

/* -------------------------------------------------------------------------- */
/* Interior room atlas (what you see through the glass)                       */
/* -------------------------------------------------------------------------- */

const ROOM_KINDS = 12;

/** Twelve little rooms, drawn as a back wall you look at through the pane. */
export function buildRoomAtlas() {
  const S = ROOM_SZ;
  const data = new Uint8Array(S * S * 4 * ROOM_KINDS);
  const c = newCanvas(S);
  const g = c.getContext('2d', { willReadFrequently: true });

  const palettes = [
    ['#5e5344', '#3b342b'], ['#6b6357', '#413b33'], ['#7a6f5e', '#4a4238'],
    ['#4a4f57', '#2f333a'], ['#6e5f52', '#463c33'], ['#585f66', '#363b41'],
    ['#7d7466', '#4e483e'], ['#4f463c', '#2e2822'], ['#67707a', '#3e454c'],
    ['#6d5a4a', '#42362c'], ['#555f5a', '#333a37'], ['#736656', '#453d33'],
  ];

  for (let k = 0; k < ROOM_KINDS; k++) {
    const r = rng(9000 + k * 131);
    const [wall, dark] = palettes[k];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = wall; g.fillRect(0, 0, S, S);
    // gradient: rooms are darker up near the ceiling, brighter at the floor line
    const grd = g.createLinearGradient(0, 0, 0, S);
    grd.addColorStop(0, 'rgba(0,0,0,0.42)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.05)');
    grd.addColorStop(1, 'rgba(0,0,0,0.30)');
    g.fillStyle = grd; g.fillRect(0, 0, S, S);

    const type = k % 4;
    if (type === 0) {          // office: partitions, monitors, ceiling grid
      g.fillStyle = dark;
      for (let i = 0; i < 3; i++) g.fillRect(r() * S, S * 0.55, 14 + r() * 26, S * 0.45);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = 'rgba(120,150,180,0.55)';
        g.fillRect(r() * S * 0.85, S * 0.42 + r() * 14, 12, 8);
      }
      g.fillStyle = 'rgba(255,255,255,0.10)';
      for (let i = 0; i < 4; i++) g.fillRect(0, i * S / 8, S, 2);
    } else if (type === 1) {   // living room: sofa, lamp, picture
      g.fillStyle = dark; g.fillRect(S * 0.1, S * 0.62, S * 0.55, S * 0.28);
      g.fillStyle = 'rgba(255,220,160,0.45)';
      g.beginPath(); g.arc(S * 0.78, S * 0.5, S * 0.09, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(S * 0.2, S * 0.18, S * 0.26, S * 0.20);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(S * 0.22, S * 0.20, S * 0.22, S * 0.16);
    } else if (type === 2) {   // shelves / bookcase
      g.fillStyle = dark; g.fillRect(S * 0.08, S * 0.22, S * 0.5, S * 0.66);
      for (let sh = 0; sh < 4; sh++) {
        const y = S * 0.28 + sh * S * 0.15;
        for (let b = 0; b < 9; b++) {
          const bw = 3 + r() * 5;
          g.fillStyle = `rgba(${(90 + r() * 130) | 0},${(70 + r() * 90) | 0},${(60 + r() * 80) | 0},0.85)`;
          g.fillRect(S * 0.10 + b * 6.4, y, bw, S * 0.12);
        }
      }
    } else {                   // curtains / blind, half drawn
      g.fillStyle = `rgba(${(190 + r() * 50) | 0},${(180 + r() * 50) | 0},${(165 + r() * 50) | 0},0.92)`;
      g.fillRect(0, 0, S, S * (0.35 + r() * 0.4));
      g.fillStyle = 'rgba(0,0,0,0.16)';
      for (let i = 0; i < 12; i++) g.fillRect(i * S / 12, 0, 2.5, S);
    }
    // ceiling light pool + grime
    g.fillStyle = 'rgba(255,238,205,0.10)';
    g.fillRect(0, 0, S, S * 0.12);
    blotch(g, S, 8, 26, 0.14, r);
    grain(g, 0, 0, S, S, 0.06, 900, r);

    const img = g.getImageData(0, 0, S, S);
    data.set(img.data, S * S * 4 * k);
  }

  const t = new THREE.DataArrayTexture(data, S, S, ROOM_KINDS);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Low-frequency tileable noise, multiplied in at ~40 m scale to hide repetition. */
export function buildMacroNoise() {
  const S = 128;
  const c = newCanvas(S), g = c.getContext('2d', { willReadFrequently: true });
  const r = rng(4242);
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  blotch(g, S, 26, 34, 0.55, r);
  blotch(g, S, 60, 14, 0.35, r);
  grain(g, 0, 0, S, S, 0.10, 3000, r);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

const OPAQUE_PARS_V = /* glsl */`
attribute vec2 aTex;          // x = array layer, y = emissive gain
varying float vLayer;
varying float vEmis;
varying vec3 vWPosB;
`;
const OPAQUE_MAIN_V = /* glsl */`
vLayer = aTex.x;
vEmis = aTex.y;
vWPosB = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const OPAQUE_PARS_F = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormalArr;
uniform sampler2DArray uOrm;
uniform sampler2D uMacro;
uniform float uNight;
uniform vec3 uLampColor;
varying float vLayer;
varying float vEmis;
varying vec3 vWPosB;

// Derivative tangent frame — the facades have proper UVs so this is stable.
mat3 bkTangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-8);
  return mat3(T * invmax, B * invmax, N);
}
`;

const OPAQUE_MAP_F = /* glsl */`
vec4 bkTex = texture(uAlbedo, vec3(vUv, vLayer));
diffuseColor.rgb *= bkTex.rgb;
// Large-scale tonal drift so a 1.2 m brick tile never reads as a grid.
float m1 = texture(uMacro, vWPosB.xz * 0.0186).r;
float m2 = texture(uMacro, vec2(vWPosB.x * 0.707 + vWPosB.z * 0.707, vWPosB.y) * 0.0393).r;
diffuseColor.rgb *= (0.80 + 0.40 * m1) * (0.88 + 0.24 * m2);
// Soot gathers at the bottom of every building in a coastal city.
diffuseColor.rgb *= mix(0.80, 1.0, clamp(vWPosB.y * 0.10, 0.0, 1.0));
`;

const OPAQUE_NORMAL_F = /* glsl */`
{
  vec3 mapN = texture(uNormalArr, vec3(vUv, vLayer)).xyz * 2.0 - 1.0;
  mapN.xy *= 1.15;
  mat3 tbn = bkTangentFrame(normal, -vViewPosition, vUv);
  normal = normalize(tbn * mapN);
}
`;

const OPAQUE_ORM_F = /* glsl */`
vec3 bkOrm = texture(uOrm, vec3(vUv, vLayer)).rgb;
float roughnessFactor = clamp(roughness * (0.55 + bkOrm.g * 0.90), 0.045, 1.0);
`;

const OPAQUE_METAL_F = /* glsl */`
float metalnessFactor = bkOrm.b;
`;

const OPAQUE_AO_F = /* glsl */`
float bkAO = mix(1.0, bkOrm.r, 0.85);
reflectedLight.indirectDiffuse *= bkAO;
#if defined( USE_CLEARCOAT )
  clearcoatSpecularIndirect *= bkAO;
#endif
#if defined( USE_SHEEN )
  sheenSpecularIndirect *= bkAO;
#endif
material.specularF90 *= mix(1.0, bkAO, 0.5);
// Shop signage and lit fascias. bkTex.a is the window mask on facade strips.
float lit = mix(0.10, 1.0, uNight);
totalEmissiveRadiance += diffuseColor.rgb * vEmis * lit * uLampColor;
totalEmissiveRadiance += bkTex.rgb * bkTex.a * uNight * uLampColor * 0.85;
`;


/**
 * Install a shader patch that survives another system reassigning
 * `material.onBeforeCompile`. In a multi-agent codebase somebody will eventually
 * walk the scene graph and hook every MeshStandardMaterial; without this our
 * atlas sampling silently disappears and every building turns flat white.
 * Anything assigned later is chained after ours instead of replacing it.
 */
function installPatch(m, mine) {
  let extra = null;
  Object.defineProperty(m, 'onBeforeCompile', {
    configurable: true,
    enumerable: true,
    get() {
      return function (sh, renderer) {
        mine(sh, renderer);
        if (extra) { try { extra.call(m, sh, renderer); } catch (e) { void e; } }
      };
    },
    set(fn) { extra = (typeof fn === 'function') ? fn : null; },
  });
}

/**
 * The one material every opaque building surface in the city uses.
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeOpaqueMaterial(tex, room, macro) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0,
    vertexColors: true, side: THREE.FrontSide, dithering: true,
  });
  m.defines = { USE_UV: '' };
  const u = {
    uAlbedo: { value: tex.albedo }, uNormalArr: { value: tex.normal },
    uOrm: { value: tex.orm }, uMacro: { value: macro },
    uNight: { value: 0 }, uLampColor: { value: new THREE.Color(1.0, 0.79, 0.52) },
  };
  m.userData.uniforms = u;
  m.userData.wetnessRough = 1.0;
  m.userData.wetnessColor = m.color.clone();
  installPatch(m, (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + OPAQUE_PARS_V)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + OPAQUE_MAIN_V);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + OPAQUE_PARS_F)
      .replace('#include <map_fragment>', OPAQUE_MAP_F)
      .replace('#include <normal_fragment_maps>', OPAQUE_NORMAL_F)
      .replace('#include <roughnessmap_fragment>', OPAQUE_ORM_F)
      .replace('#include <metalnessmap_fragment>', OPAQUE_METAL_F)
      .replace('#include <aomap_fragment>', OPAQUE_AO_F);
  });
  m.customProgramCacheKey = () => 'bkOpaque2';
  return m;
}

const GLASS_PARS_V = /* glsl */`
attribute vec3 aTan;
attribute vec4 aRoomA;    // width, height, depth, seed
attribute vec2 aRoomB;    // lit, kind
varying vec3 vTanW;
varying vec3 vNrmW;
varying vec3 vWPosG;
varying vec4 vRoomA;
varying vec2 vRoomB;
`;
const GLASS_MAIN_V = /* glsl */`
vTanW = normalize(mat3(modelMatrix) * aTan);
vNrmW = normalize(mat3(modelMatrix) * objectNormal);
vWPosG = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRoomA = aRoomA;
vRoomB = aRoomB;
`;

const GLASS_PARS_F = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uRooms;
uniform float uNight;
uniform float uDayInterior;
uniform vec3 uLampColor;
varying vec3 vTanW;
varying vec3 vNrmW;
varying vec3 vWPosG;
varying vec4 vRoomA;
varying vec2 vRoomB;

// Sash bars. Real windows are divided; a single sheet of glass is a dead giveaway.
float bkMuntin(vec2 uv, float kind) {
  float t = 0.0;
  float bw = 0.020;
  if (kind < 0.5) {                 // 6-over-6 Federal sash
    vec2 g = abs(fract(vec2(uv.x * 3.0, uv.y * 6.0)) - 0.5);
    t = max(step(0.5 - bw * 3.0, g.x), step(0.5 - bw * 6.0, g.y));
    t = max(t, step(abs(uv.y - 0.5), 0.012));
  } else if (kind < 1.5) {          // 2-over-2 Victorian
    t = step(abs(uv.x - 0.5), 0.014);
    t = max(t, step(abs(uv.y - 0.5), 0.016));
  } else if (kind < 2.5) {          // single-pane modern
    t = 0.0;
  } else if (kind < 3.5) {          // shopfront: transom bar + centre mullion
    t = step(abs(uv.y - 0.80), 0.020);
    t = max(t, step(abs(uv.x - 0.5), 0.012));
  } else {                          // curtain wall: horizontal spandrel joint only
    t = step(abs(uv.y - 0.5), 0.008);
  }
  // outer frame is always present
  float b = kind > 3.5 ? 0.022 : 0.030;
  float f = 1.0 - step(b, uv.x) * step(uv.x, 1.0 - b)
                * step(b * 0.9, uv.y) * step(uv.y, 1.0 - b * 0.9);
  return clamp(max(t, f), 0.0, 1.0);
}
`;

// Injected in place of <map_fragment>: builds the interior, then hands the
// standard model a near-black diffuse so only specular/env survives on the glass.
const GLASS_MAP_F = /* glsl */`
vec3 Nw = normalize(vNrmW);
vec3 Tw = normalize(vTanW - Nw * dot(Nw, vTanW));
vec3 Bw = cross(Nw, Tw);
vec3 vdW = normalize(vWPosG - cameraPosition);
vec3 vd = vec3(dot(vdW, Tw), dot(vdW, Bw), dot(vdW, Nw));

float rw = vRoomA.x, rh = vRoomA.y, rd = vRoomA.z, seed = vRoomA.w;
float kindRaw = vRoomB.y;
float purple = step(8.0, kindRaw);
float kind = mod(kindRaw, 8.0);
vec2 puv = vUv;
// Kind 5 subdivides a single quad into a full curtain-wall grid in the shader.
// A 240 m tower's glazing becomes four triangles instead of ten thousand, and
// each cell still gets its own room, its own seed and its own night light.
if (kind > 4.5) {
  float nx = max(1.0, floor(rw / 1.55));
  float ny = max(1.0, floor(rh / 3.85));
  vec2 gg = puv * vec2(nx, ny);
  vec2 cid = floor(gg);
  puv = fract(gg);
  seed = fract(seed + cid.x * 0.31731 + cid.y * 0.11437
               + fract(sin(cid.x * 12.9898 + cid.y * 78.233) * 43758.5453));
  rw /= nx; rh /= ny;
  kind = 4.0;
}
vec3 o = vec3(puv.x * rw, puv.y * rh, 0.0);
// The pane faces out, so any visible fragment has vd.z < 0 (going inwards).
float dz = min(vd.z, -1e-4);
float tz = (-rd) / dz;
float dx = abs(vd.x) < 1e-4 ? 1e-4 : vd.x;
float dy = abs(vd.y) < 1e-4 ? 1e-4 : vd.y;
float tx = ((dx > 0.0 ? rw : 0.0) - o.x) / dx;
float ty = ((dy > 0.0 ? rh : 0.0) - o.y) / dy;
float tHit = min(tz, min(tx, ty));
vec3 hp = o + vd * tHit;

float layer = floor(fract(seed * 17.317) * 12.0);
vec2 ruv; float faceTint;
if (tHit == tz) {                     // back wall
  ruv = vec2(hp.x / rw, hp.y / rh);
  faceTint = 1.0;
} else if (tHit == tx) {              // side wall
  ruv = vec2(clamp(-hp.z / rd, 0.0, 1.0), hp.y / rh);
  faceTint = 0.62;
} else {                              // floor or ceiling
  ruv = vec2(hp.x / rw, clamp(-hp.z / rd, 0.0, 1.0));
  faceTint = (dy > 0.0) ? 0.50 : 0.78;
}
vec3 roomCol = texture(uRooms, vec3(clamp(ruv, 0.002, 0.998), layer)).rgb * faceTint;
// Falls off with depth into the room.
roomCol *= mix(1.0, 0.35, clamp(-hp.z / max(rd, 0.001), 0.0, 1.0));

float bars = bkMuntin(puv, kind);

// A room is lit if its per-window roll beats the hour's occupancy.
float litRoll = fract(seed * 43.7581);
float on = step(litRoll, vRoomB.x) * uNight;
vec3 interior = roomCol * (uDayInterior + on * 2.6 * uLampColor);

// The historic Beacon Hill panes went lavender from manganese in the glass.
vec3 tint = mix(vec3(0.86, 0.93, 0.97), vec3(0.80, 0.68, 0.92), purple);
interior *= tint;

vec3 frameCol = vColor;
vBkDiffuse = mix(vec3(0.015, 0.017, 0.020), frameCol, bars);
vBkInterior = interior * (1.0 - bars);
vBkBars = bars;
`;
const GLASS_COLOR_F = /* glsl */`diffuseColor.rgb = vBkDiffuse;`;

const GLASS_ORM_F = /* glsl */`
float roughnessFactor = mix(0.045, 0.62, vBkBars);
`;
const GLASS_METAL_F = /* glsl */`
float metalnessFactor = mix(0.02, 0.0, vBkBars);
`;
const GLASS_EMIS_F = /* glsl */`
totalEmissiveRadiance += vBkInterior;
`;

/**
 * Interior-mapped glass. Every pane parallaxes a real box-shaped room behind it,
 * which is the single cheapest way to stop windows reading as painted-on rectangles.
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeGlassMaterial(room) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.06, metalness: 0.02,
    vertexColors: true, side: THREE.FrontSide, envMapIntensity: 1.9,
  });
  m.defines = { USE_UV: '' };
  const u = {
    uRooms: { value: room }, uNight: { value: 0 },
    uDayInterior: { value: 0.42 },
    uLampColor: { value: new THREE.Color(1.0, 0.76, 0.48) },
  };
  m.userData.uniforms = u;
  installPatch(m, (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLASS_PARS_V)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + GLASS_MAIN_V);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\n' + GLASS_PARS_F +
        '\nvec3 vBkInterior; vec3 vBkDiffuse; float vBkBars;')
      .replace('#include <map_fragment>', GLASS_MAP_F)
      .replace('#include <color_fragment>', GLASS_COLOR_F)
      .replace('#include <roughnessmap_fragment>', GLASS_ORM_F)
      .replace('#include <metalnessmap_fragment>', GLASS_METAL_F)
      .replace('#include <emissivemap_fragment>', GLASS_EMIS_F);
  });
  m.customProgramCacheKey = () => 'bkGlass2';
  return m;
}

/* -------------------------------------------------------------------------- */
/* Vertex accumulators                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Append-only opaque vertex buffer.
 *
 * Backed by growable typed arrays, not JS arrays: at city scale we push tens of
 * millions of floats, and `Array.prototype.push` costs ~2 us/vertex, which turns
 * a chunk build into a visible hitch. This is ~40x faster.
 */
export class MeshBuf {
  constructor(cap = 4096) {
    this._alloc(cap);
    this.v = 0; this.ni = 0;
  }
  _alloc(cap) {
    this.vcap = cap;
    this.p = new Float32Array(cap * 3);
    this.n = new Float32Array(cap * 3);
    this.u = new Float32Array(cap * 2);
    this.c = new Float32Array(cap * 3);
    this.t = new Float32Array(cap * 2);
    this.icap = cap * 2;
    this.idx = new Uint32Array(this.icap);
  }
  get empty() { return this.ni === 0; }

  _growV() {
    const old = { p: this.p, n: this.n, u: this.u, c: this.c, t: this.t, v: this.v };
    const icap = this.icap, idx = this.idx;
    this._alloc(this.vcap * 2);
    this.p.set(old.p); this.n.set(old.n); this.u.set(old.u);
    this.c.set(old.c); this.t.set(old.t);
    this.icap = icap; this.idx = idx;
  }
  _growI() {
    const next = new Uint32Array(this.icap * 2);
    next.set(this.idx);
    this.idx = next; this.icap *= 2;
  }

  vert(x, y, z, nx, ny, nz, u, vv, r, g, b, layer, emis) {
    if (this.v >= this.vcap) this._growV();
    const i = this.v, i3 = i * 3, i2 = i * 2;
    const p = this.p, n = this.n;
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z;
    n[i3] = nx; n[i3 + 1] = ny; n[i3 + 2] = nz;
    this.u[i2] = u; this.u[i2 + 1] = vv;
    const c = this.c;
    c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b;
    this.t[i2] = layer; this.t[i2 + 1] = emis;
    this.v = i + 1;
    return i;
  }

  tri(a, b, c) {
    if (this.ni + 3 > this.icap) this._growI();
    const d = this.idx, k = this.ni;
    d[k] = a; d[k + 1] = b; d[k + 2] = c;
    this.ni = k + 3;
  }

  /** Scalar-argument quad. Everything else funnels through here. */
  quadV(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz,
        nx, ny, nz, u0, v0, u1, v1, u2, v2, u3, v3, r, g, b, layer, emis) {
    const i0 = this.vert(ax, ay, az, nx, ny, nz, u0, v0, r, g, b, layer, emis);
    this.vert(bx, by, bz, nx, ny, nz, u1, v1, r, g, b, layer, emis);
    this.vert(cx, cy, cz, nx, ny, nz, u2, v2, r, g, b, layer, emis);
    this.vert(dx, dy, dz, nx, ny, nz, u3, v3, r, g, b, layer, emis);
    if (this.ni + 6 > this.icap) this._growI();
    const d = this.idx, k = this.ni;
    d[k] = i0; d[k + 1] = i0 + 1; d[k + 2] = i0 + 2;
    d[k + 3] = i0; d[k + 4] = i0 + 2; d[k + 5] = i0 + 3;
    this.ni = k + 6;
  }

  /**
   * One quad. `a..d` are [x,y,z] in CCW order seen from the front; `uv` is four
   * [u,v] pairs already divided by the surface tile size.
   */
  quad(a, b, c, d, nx, ny, nz, uv, col, layer, emis = 0) {
    this.quadV(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2],
      nx, ny, nz, uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], uv[6], uv[7],
      col[0], col[1], col[2], layer, emis);
  }

  /**
   * Quad whose normal is derived from its own winding, flipped if it disagrees
   * with `ref`. Reveals, soffits and jambs are much easier to author this way.
   */
  quadAuto(a, b, c, d, refX, refY, refZ, uv, col, surf, emis = 0) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const layer = SURF[surf].layer;
    if (nx * refX + ny * refY + nz * refZ < 0) {
      this.quadV(a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2], b[0], b[1], b[2],
        -nx, -ny, -nz, uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3],
        col[0], col[1], col[2], layer, emis);
    } else {
      this.quadV(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2],
        nx, ny, nz, uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], uv[6], uv[7],
        col[0], col[1], col[2], layer, emis);
    }
  }

  /**
   * Vertical wall panel from (x0,z0)→(x1,z1) spanning y0..y1. Outward normal is
   * the edge direction rotated -90° about +Y, which matches a CCW footprint.
   */
  wall(x0, z0, x1, z1, y0, y1, surf, col, uOff = 0, vOff = 0, emis = 0) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-5 || y1 - y0 < 1e-5) return;
    const s = SURF[surf], sz = s.size, vz = s.vsize || sz;
    const nx = dz / len, nz = -dx / len;
    const u0 = uOff / sz, u1 = (uOff + len) / sz;
    const v0 = (vOff + y0) / vz, v1 = (vOff + y1) / vz;
    this.quadV(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0,
      nx, 0, nz, u0, v0, u1, v0, u1, v1, u0, v1,
      col[0], col[1], col[2], s.layer, emis);
  }

  /** Wall panel with explicit v range (for baked facade strips: v = storey index). */
  wallV(x0, z0, x1, z1, y0, y1, surf, col, u0, u1, v0, v1, emis = 0) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-5) return;
    const s = SURF[surf];
    const nx = dz / len, nz = -dx / len;
    this.quadV(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0,
      nx, 0, nz, u0, v0, u1, v0, u1, v1, u0, v1,
      col[0], col[1], col[2], s.layer, emis);
  }

  /** Horizontal plate at height y. `up` flips the normal for soffits. */
  plate(x0, z0, x1, z1, y, surf, col, up = true, emis = 0) {
    const s = SURF[surf], sz = s.size;
    const u0 = x0 / sz, u1 = x1 / sz, v0 = z0 / sz, v1 = z1 / sz;
    if (up) {
      this.quadV(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, 0, 1, 0,
        u0, v1, u1, v1, u1, v0, u0, v0, col[0], col[1], col[2], s.layer, emis);
    } else {
      this.quadV(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, 0, -1, 0,
        u0, v0, u1, v0, u1, v1, u0, v1, col[0], col[1], col[2], s.layer, emis);
    }
  }

  /** Arbitrary horizontal polygon (fan-triangulated; footprints are convex-ish). */
  cap(poly, y, surf, col, up = true, emis = 0) {
    const s = SURF[surf], sz = s.size;
    const base = this.v;
    const ny = up ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const pt = poly[i];
      this.vert(pt.x, y, pt.z, 0, ny, 0, pt.x / sz, pt.z / sz,
        col[0], col[1], col[2], s.layer, emis);
    }
    for (let k = 1; k < poly.length - 1; k++) {
      if (up) this.tri(base, base + k + 1, base + k);
      else this.tri(base, base + k, base + k + 1);
    }
  }

  /**
   * Axis-aligned box, optionally rotated about Y. The workhorse for cornices,
   * sills, HVAC, railings, chimneys — everything that isn't a wall.
   * Written out longhand precisely because it runs millions of times.
   */
  box(cx, cy, cz, sx, sy, sz, rotY, surf, col, emis = 0, skipBottom = true) {
    const s = SURF[surf], ts = s.size, L = s.layer;
    const co = rotY ? Math.cos(rotY) : 1, si = rotY ? Math.sin(rotY) : 0;
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const r = col[0], g = col[1], b = col[2];
    // Local axes in world space
    const ex = co, ez = -si;            // +local x
    const fx = si, fz = co;             // +local z
    const X = (lx, lz) => cx + lx * ex + lz * fx;
    const Z = (lx, lz) => cz + lx * ez + lz * fz;
    const y0 = cy - hy, y1 = cy + hy;
    const ux = sx / ts, uz = sz / ts, uy = sy / ts;

    // +Z face
    let ax = X(-hx, hz), az = Z(-hx, hz), bx = X(hx, hz), bz = Z(hx, hz);
    this.quadV(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
      fx, 0, fz, 0, 0, ux, 0, ux, uy, 0, uy, r, g, b, L, emis);
    // -Z face
    ax = X(hx, -hz); az = Z(hx, -hz); bx = X(-hx, -hz); bz = Z(-hx, -hz);
    this.quadV(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
      -fx, 0, -fz, 0, 0, ux, 0, ux, uy, 0, uy, r, g, b, L, emis);
    // +X face
    ax = X(hx, hz); az = Z(hx, hz); bx = X(hx, -hz); bz = Z(hx, -hz);
    this.quadV(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
      ex, 0, ez, 0, 0, uz, 0, uz, uy, 0, uy, r, g, b, L, emis);
    // -X face
    ax = X(-hx, -hz); az = Z(-hx, -hz); bx = X(-hx, hz); bz = Z(-hx, hz);
    this.quadV(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
      -ex, 0, -ez, 0, 0, uz, 0, uz, uy, 0, uy, r, g, b, L, emis);
    // top
    this.quadV(X(-hx, hz), y1, Z(-hx, hz), X(hx, hz), y1, Z(hx, hz),
      X(hx, -hz), y1, Z(hx, -hz), X(-hx, -hz), y1, Z(-hx, -hz),
      0, 1, 0, 0, 0, ux, 0, ux, uz, 0, uz, r, g, b, L, emis);
    if (!skipBottom) {
      this.quadV(X(-hx, -hz), y0, Z(-hx, -hz), X(hx, -hz), y0, Z(hx, -hz),
        X(hx, hz), y0, Z(hx, hz), X(-hx, hz), y0, Z(-hx, hz),
        0, -1, 0, 0, 0, ux, 0, ux, uz, 0, uz, r, g, b, L, emis);
    }
  }

  /** Bake into an indexed BufferGeometry. Returns null when nothing was pushed. */
  build() {
    if (!this.ni) return null;
    const v = this.v;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.slice(0, v * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.u.slice(0, v * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.slice(0, v * 3), 3));
    g.setAttribute('aTex', new THREE.BufferAttribute(this.t.slice(0, v * 2), 2));
    const ix = this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(
      v > 65534 ? ix : Uint16Array.from(ix), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Append-only interior-mapped window buffer. Same typed-array strategy. */
export class GlassBuf {
  constructor(cap = 1024) {
    this._alloc(cap);
    this.v = 0; this.ni = 0;
  }
  _alloc(cap) {
    this.vcap = cap;
    this.p = new Float32Array(cap * 3);
    this.n = new Float32Array(cap * 3);
    this.u = new Float32Array(cap * 2);
    this.c = new Float32Array(cap * 3);
    this.tn = new Float32Array(cap * 3);
    this.ra = new Float32Array(cap * 4);
    this.rb = new Float32Array(cap * 2);
    this.icap = cap * 2;
    this.idx = new Uint32Array(this.icap);
  }
  get empty() { return this.ni === 0; }
  _growV() {
    const o = { p: this.p, n: this.n, u: this.u, c: this.c,
                tn: this.tn, ra: this.ra, rb: this.rb };
    const icap = this.icap, idx = this.idx;
    this._alloc(this.vcap * 2);
    this.p.set(o.p); this.n.set(o.n); this.u.set(o.u); this.c.set(o.c);
    this.tn.set(o.tn); this.ra.set(o.ra); this.rb.set(o.rb);
    this.icap = icap; this.idx = idx;
  }

  /**
   * One window pane. `a..d` CCW from outside, starting bottom-left; `tan` points
   * along the pane's +u so the interior shader can build a tangent frame.
   */
  pane(a, b, c, d, nrm, tan, w, h, depth, seed, lit, kind, frameCol) {
    if (this.v + 4 > this.vcap) this._growV();
    const i0 = this.v;
    const pts = [a, b, c, d];
    for (let k = 0; k < 4; k++) {
      const pt = pts[k], i = this.v, i3 = i * 3, i2 = i * 2, i4 = i * 4;
      this.p[i3] = pt[0]; this.p[i3 + 1] = pt[1]; this.p[i3 + 2] = pt[2];
      this.n[i3] = nrm[0]; this.n[i3 + 1] = nrm[1]; this.n[i3 + 2] = nrm[2];
      this.u[i2] = (k === 1 || k === 2) ? 1 : 0;
      this.u[i2 + 1] = (k >= 2) ? 1 : 0;
      this.c[i3] = frameCol[0]; this.c[i3 + 1] = frameCol[1]; this.c[i3 + 2] = frameCol[2];
      this.tn[i3] = tan[0]; this.tn[i3 + 1] = tan[1]; this.tn[i3 + 2] = tan[2];
      this.ra[i4] = w; this.ra[i4 + 1] = h; this.ra[i4 + 2] = depth; this.ra[i4 + 3] = seed;
      this.rb[i2] = lit; this.rb[i2 + 1] = kind;
      this.v = i + 1;
    }
    if (this.ni + 6 > this.icap) {
      const next = new Uint32Array(this.icap * 2);
      next.set(this.idx); this.idx = next; this.icap *= 2;
    }
    const x = this.idx, k = this.ni;
    x[k] = i0; x[k + 1] = i0 + 1; x[k + 2] = i0 + 2;
    x[k + 3] = i0; x[k + 4] = i0 + 2; x[k + 5] = i0 + 3;
    this.ni = k + 6;
  }

  build() {
    if (!this.ni) return null;
    const v = this.v;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.slice(0, v * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.u.slice(0, v * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.slice(0, v * 3), 3));
    g.setAttribute('aTan', new THREE.BufferAttribute(this.tn.slice(0, v * 3), 3));
    g.setAttribute('aRoomA', new THREE.BufferAttribute(this.ra.slice(0, v * 4), 4));
    g.setAttribute('aRoomB', new THREE.BufferAttribute(this.rb.slice(0, v * 2), 2));
    const ix = this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(
      v > 65534 ? ix : Uint16Array.from(ix), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}


/* -------------------------------------------------------------------------- */
/* Polygon utilities                                                          */
/* -------------------------------------------------------------------------- */

/** Signed area of a polygon in the XZ plane. */
export function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a * 0.5;
}

export function polyCentroid(poly) {
  let x = 0, z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length };
}

/** Force the winding that makes `MeshBuf.wall` normals point outward. */
export function orientOutward(poly) {
  if (poly.length < 3) return poly;
  const c = polyCentroid(poly);
  const p = poly[0], q = poly[1];
  const dx = q.x - p.x, dz = q.z - p.z;
  const nx = dz, nz = -dx;
  const mx = (p.x + q.x) * 0.5 - c.x, mz = (p.z + q.z) * 0.5 - c.z;
  return (nx * mx + nz * mz) < 0 ? poly.slice().reverse() : poly;
}

/** Naive inset — correct for the convex, near-rectangular parcels we generate. */
export function insetPoly(poly, d) {
  const c = polyCentroid(poly);
  const out = [];
  for (const p of poly) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const l = Math.hypot(dx, dz) || 1;
    const k = Math.max(0, l - d) / l;
    out.push({ x: c.x + dx * k, z: c.z + dz * k });
  }
  return out;
}

export function polyBounds(poly) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

export { LAYER_COUNT, ROOM_KINDS };
