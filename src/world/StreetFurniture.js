import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// Read-only: parked cars reuse the vehicle body loft rather than duplicating it.
// VehicleModels imports nothing but three, so there is no cycle.
import { getVehicleGeometry, VEHICLE_SPECS } from './VehicleModels.js';

/**
 * Street furniture: the procedural geometry library for everything bolted to a
 * Boston sidewalk, plus the low-level prop utilities shared by Props.js,
 * Vegetation.js and Decals.js.
 *
 * Why the utilities live here and not in their own file: this agent owns exactly
 * four files, and a shared "utils" file is not one of them. StreetFurniture.js is
 * the leaf of the props dependency graph (nothing here imports the others), so it
 * is the only safe place to put them without creating an import cycle.
 *
 * Everything is built once at init, merged into a single BufferGeometry per prop
 * type, and drawn with InstancedMesh. A prop that mixes materials (a stop sign is
 * a galvanised post plus a retroreflective face) becomes one geometry with one
 * group per material slot, so it is still one instanced object.
 *
 * All dimensions are real. A US stop sign blade is 750mm across and its centre
 * sits 2.1m off the sidewalk; a traffic cone is 710mm tall; a fire hydrant is
 * 780mm to the top of the bonnet. Scale is the cheapest realism there is.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG. Every placement decision is seeded so a rebuild after the
// city graph lands reproduces the same street, and so nothing pops between runs.
// ---------------------------------------------------------------------------

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = 1) { this._f = mulberry32((seed | 0) || 1); }
  f() { return this._f(); }
  range(a, b) { return a + this._f() * (b - a); }
  int(n) { return Math.min(n - 1, (this._f() * n) | 0); }
  pick(arr) { return arr[Math.min(arr.length - 1, (this._f() * arr.length) | 0)]; }
  chance(p) { return this._f() < p; }
  sign() { return this._f() < 0.5 ? -1 : 1; }
  /** Gaussian-ish, cheap. */
  bell() { return (this._f() + this._f() + this._f()) / 3; }
}

// ---------------------------------------------------------------------------
// Procedural texture helpers
// ---------------------------------------------------------------------------

export function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

/** Tileable value-noise field in 0..1. */
export function noiseField(size, cells, seed) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  const step = cells / size;
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = y * step, y0 = Math.floor(fy), ty = sm(fy - y0);
    const y0i = ((y0 % cells) + cells) % cells, y1i = (y0i + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = x * step, x0 = Math.floor(fx), tx = sm(fx - x0);
      const x0i = ((x0 % cells) + cells) % cells, x1i = (x0i + 1) % cells;
      const a = g[y0i * cells + x0i], b = g[y0i * cells + x1i];
      const c = g[y1i * cells + x0i], d = g[y1i * cells + x1i];
      out[y * size + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/** Tileable fBm in 0..1. */
export function fbm(size, seed, octaves = 5, base = 4, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, sum = 0, cells = base;
  for (let o = 0; o < octaves; o++) {
    const n = noiseField(size, cells, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    sum += amp; amp *= gain; cells = Math.min(size, cells * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Sobel a heightfield into a tangent-space normal map canvas. */
export function normalFromHeight(height, size, strength = 2.0) {
  const { canvas, ctx } = canvas2d(size, size);
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function texFromCanvas(canvas, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// ---------------------------------------------------------------------------
// Geometry assembly
// ---------------------------------------------------------------------------

const _mat4 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const KEEP_ATTRS = ['position', 'normal', 'uv', 'color', 'aSurf'];

/**
 * Box-project UVs from object space so the shared grunge detail map tiles at a
 * constant world period across every face of a merged prop. Without this each
 * BoxGeometry face would stretch the detail map to its own 0..1 and the wear
 * would read at wildly different scales on a bollard vs a bus shelter.
 */
export function boxProjectUV(geo, scale = 0.7) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  if (!p || !n || !uv) return;
  const inv = 1 / scale;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv.setXY(i, u * inv, v * inv);
  }
  uv.needsUpdate = true;
}

/**
 * Surface parameters per authoring slot: [roughness, metalness]. These are baked
 * into a per-vertex `aSurf` attribute and read by a two-line patch on the shared
 * material, which is what lets a bollard's painted steel, its galvanised base and
 * its concrete pad live in ONE draw call instead of three. Draw calls are the
 * binding constraint on a prop system, not triangles.
 */
const SURF = {
  paint: [0.46, 0.18],
  metal: [0.40, 0.88],
  rough: [0.88, 0.00],
  chrome: [0.16, 1.00],
  rusty: [0.93, 0.30],
  sign: [0.34, 0.05],
  glass: [0.05, 0.00],
  lamp: [0.32, 0.00],
  lampRed: [0.28, 0.00],
  lampGreen: [0.28, 0.00],
};
/** Authoring slot -> the material bucket it actually renders in. */
const SLOT_MAT = {
  paint: 'surf', metal: 'surf', rough: 'surf', chrome: 'surf', rusty: 'surf',
  sign: 'sign', glass: 'glass',
  lamp: 'emitNight',            // dusk-to-dawn: luminaires, shelter strips
  lampRed: 'emit', lampGreen: 'emit',   // always on: signal lenses, LEDs
};
/** Material bucket order, so groups are deterministic across LOD levels. */
const MAT_ORDER = ['surf', 'sign', 'glass', 'emit', 'emitNight'];

/** Accumulates transformed, vertex-coloured parts bucketed by material. */
export class GeoSet {
  constructor() { this.slots = new Map(); }

  /**
   * @param {string} slot   authoring slot ('paint','metal','rough','sign','lamp',...)
   * @param {THREE.BufferGeometry} geo  source primitive (not retained)
   * @param {string} hex    sRGB albedo baked to vertex colour
   * @param {{p?:number[],r?:number[],s?:number[]}} [o] local transform
   */
  add(slot, geo, hex, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _p.fromArray(o.p || [0, 0, 0]);
    _q.setFromEuler(_e.fromArray(o.r || [0, 0, 0]));
    _s.fromArray(o.s || [1, 1, 1]);
    _mat4.compose(_p, _q, _s);
    g.applyMatrix4(_mat4);

    const n = g.attributes.position.count;
    _col.setStyle(hex);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const sp = SURF[slot] || [0.7, 0.0];
    const surf = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { surf[i * 2] = sp[0]; surf[i * 2 + 1] = sp[1]; }
    g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 2));

    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    for (const k of Object.keys(g.attributes)) if (!KEEP_ATTRS.includes(k)) g.deleteAttribute(k);

    const bucket = SLOT_MAT[slot] || 'surf';
    let arr = this.slots.get(bucket);
    if (!arr) this.slots.set(bucket, arr = []);
    arr.push(g);
    return this;
  }

  /** @returns {{geometry:THREE.BufferGeometry, slots:string[]}|null} */
  build(uvScale = 0.7) {
    const names = [], geos = [];
    for (const nm of MAT_ORDER) {
      const parts = this.slots.get(nm);
      if (!parts || !parts.length) continue;
      const g = parts.length === 1 ? parts[0].clone() : mergeGeometries(parts, false);
      if (!g) continue;
      if (nm !== 'sign') boxProjectUV(g, uvScale);
      names.push(nm); geos.push(g);
    }
    for (const parts of this.slots.values()) for (const p of parts) p.dispose();
    this.slots.clear();
    if (!geos.length) return null;
    let merged;
    if (geos.length === 1) {
      merged = geos[0];
      merged.clearGroups();
      merged.addGroup(0, merged.attributes.position.count, 0);
    } else {
      merged = mergeGeometries(geos, true);
      for (const g of geos) g.dispose();
    }
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return { geometry: merged, slots: names };
  }
}

// Primitive shorthands. Cached where the same primitive recurs a lot.
const _geoCache = new Map();
function cached(key, fn) {
  let g = _geoCache.get(key);
  if (!g) _geoCache.set(key, g = fn());
  return g;
}
export const box = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export const cyl = (rt, rb, h, seg = 10, open = false) =>
  cached(`c${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
export const sph = (r, w = 10, h = 7) => cached(`s${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h));
export const plane = (w, h) => cached(`p${w},${h}`, () => new THREE.PlaneGeometry(w, h));

/** Lathe a 2D profile (array of [r,y]) into a solid of revolution. */
export function lathe(profile, seg = 12) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y));
  return new THREE.LatheGeometry(pts, seg);
}

/** A closed regular polygon plate of `n` sides, radius r, in the XY plane. */
export function polyPlate(n, r, rot = 0) {
  const shape = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

// ---------------------------------------------------------------------------
// Sign atlas. One 1024x1024 sheet carries every sign face in the city, so all
// signage is a single material and a single texture upload.
// ---------------------------------------------------------------------------

/** Pixel rects into the sign atlas, keyed by sign name. */
export const SIGN = {
  stop: [0, 0, 512, 512],
  doNotEnter: [512, 0, 256, 256],
  pedXing: [768, 0, 256, 256],
  roadWork: [512, 256, 256, 256],
  detour: [768, 256, 256, 256],
  noParking: [0, 512, 170, 256],
  resident: [170, 512, 170, 256],
  towZone: [340, 512, 170, 256],
  handicap: [510, 512, 170, 256],
  fireLane: [680, 512, 170, 256],
  speed25: [850, 512, 170, 256],
  oneWayL: [0, 768, 384, 128],
  oneWayR: [384, 768, 384, 128],
  busStop: [768, 768, 128, 128],
  metalBack: [896, 768, 128, 128],
  blade0: [0, 896, 256, 128],
  blade1: [256, 896, 256, 128],
  blade2: [512, 896, 256, 128],
  blade3: [768, 896, 256, 128],
};
const ATLAS = 1024;

/** UV rect (u0,v0,u1,v1) for a sign, with a 1px inset to kill bleed. */
export function signUV(name) {
  const [x, y, w, h] = SIGN[name];
  const i = 1;
  return [(x + i) / ATLAS, 1 - (y + h - i) / ATLAS, (x + w - i) / ATLAS, 1 - (y + i) / ATLAS];
}

function fitText(c, text, maxW, weight, family, startPx) {
  let px = startPx;
  c.font = `${weight} ${px}px ${family}`;
  while (c.measureText(text).width > maxW && px > 6) {
    px -= 1;
    c.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

function grime(c, x, y, w, h, seed, amount = 0.16) {
  const r = new RNG(seed);
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  for (let i = 0; i < 48; i++) {
    const gx = x + r.f() * w, gy = y + r.f() * h;
    const rad = r.range(2, w * 0.16);
    const g = c.createRadialGradient(gx, gy, 0, gx, gy, rad);
    const dark = r.chance(0.7);
    g.addColorStop(0, dark ? `rgba(40,36,30,${amount * r.range(0.4, 1)})`
                           : `rgba(210,206,196,${amount * r.range(0.3, 0.8)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(gx, gy, rad, 0, 6.2832); c.fill();
  }
  // Vertical rain streaks — every outdoor sign has them.
  for (let i = 0; i < 14; i++) {
    const gx = x + r.f() * w;
    c.fillStyle = `rgba(30,28,24,${amount * r.range(0.15, 0.5)})`;
    c.fillRect(gx, y + r.f() * h * 0.4, r.range(0.7, 2.4), h * r.range(0.3, 0.8));
  }
  c.restore();
}

function drawStop(c, x, y, s) {
  const cx = x + s / 2, cy = y + s / 2, r = s * 0.5;
  c.save(); c.translate(cx, cy);
  const oct = (rad) => {
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i / 8) * Math.PI * 2;
      const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
      i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.closePath();
  };
  c.fillStyle = '#b8101c'; oct(r * 0.995); c.fill();
  c.strokeStyle = '#f2f2f0'; c.lineWidth = s * 0.035; oct(r * 0.87); c.stroke();
  c.fillStyle = '#f5f4f0';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  fitText(c, 'STOP', s * 0.72, 'bold', 'Arial Narrow, Arial, sans-serif', s * 0.34);
  c.fillText('STOP', 0, s * 0.02);
  c.restore();
  grime(c, x, y, s, s, 11, 0.2);
}

function drawDoNotEnter(c, x, y, s) {
  c.fillStyle = '#b8101c';
  c.beginPath(); c.arc(x + s / 2, y + s / 2, s * 0.49, 0, 6.2832); c.fill();
  c.strokeStyle = '#f2f2f0'; c.lineWidth = s * 0.035;
  c.beginPath(); c.arc(x + s / 2, y + s / 2, s * 0.43, 0, 6.2832); c.stroke();
  c.fillStyle = '#f5f4f0';
  c.fillRect(x + s * 0.16, y + s * 0.42, s * 0.68, s * 0.16);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#f5f4f0';
  fitText(c, 'DO NOT', s * 0.6, 'bold', 'Arial, sans-serif', s * 0.13);
  c.fillText('DO NOT', x + s / 2, y + s * 0.30);
  c.fillText('ENTER', x + s / 2, y + s * 0.70);
  grime(c, x, y, s, s, 22, 0.18);
}

function drawDiamond(c, x, y, s, fill, drawInner) {
  c.save(); c.translate(x + s / 2, y + s / 2); c.rotate(Math.PI / 4);
  const h = s * 0.355;
  c.fillStyle = fill; c.fillRect(-h, -h, h * 2, h * 2);
  c.strokeStyle = 'rgba(20,20,20,0.85)'; c.lineWidth = s * 0.018;
  c.strokeRect(-h * 0.92, -h * 0.92, h * 1.84, h * 1.84);
  c.restore();
  if (drawInner) drawInner(c, x + s / 2, y + s / 2, s);
}

function drawPedXing(c, x, y, s) {
  drawDiamond(c, x, y, s, '#c8e832', (cc, cx, cy, ss) => {
    // Walking figure + crosswalk bars, black on fluorescent yellow-green.
    cc.fillStyle = '#111';
    cc.beginPath(); cc.arc(cx - ss * 0.02, cy - ss * 0.16, ss * 0.035, 0, 6.2832); cc.fill();
    cc.save(); cc.translate(cx, cy);
    cc.lineWidth = ss * 0.036; cc.strokeStyle = '#111'; cc.lineCap = 'round';
    cc.beginPath(); cc.moveTo(-ss * 0.02, -ss * 0.12); cc.lineTo(ss * 0.01, ss * 0.02); cc.stroke();
    cc.beginPath(); cc.moveTo(ss * 0.01, ss * 0.02); cc.lineTo(-ss * 0.06, ss * 0.12); cc.stroke();
    cc.beginPath(); cc.moveTo(ss * 0.01, ss * 0.02); cc.lineTo(ss * 0.07, ss * 0.11); cc.stroke();
    cc.beginPath(); cc.moveTo(-ss * 0.02, -ss * 0.09); cc.lineTo(-ss * 0.09, ss * 0.0); cc.stroke();
    cc.beginPath(); cc.moveTo(-ss * 0.02, -ss * 0.09); cc.lineTo(ss * 0.06, ss * 0.0); cc.stroke();
    cc.restore();
    for (let i = 0; i < 3; i++) cc.fillRect(cx - ss * 0.13 + i * ss * 0.1, cy + ss * 0.15, ss * 0.055, ss * 0.05);
  });
  grime(c, x, y, s, s, 33, 0.14);
}

function drawRoadWork(c, x, y, s) {
  drawDiamond(c, x, y, s, '#f07a10', (cc, cx, cy, ss) => {
    cc.fillStyle = '#111';
    // Worker with shovel — the classic W21-1.
    cc.beginPath(); cc.arc(cx, cy - ss * 0.15, ss * 0.04, 0, 6.2832); cc.fill();
    cc.fillRect(cx - ss * 0.06, cy - ss * 0.19, ss * 0.12, ss * 0.022);
    cc.lineWidth = ss * 0.035; cc.strokeStyle = '#111'; cc.lineCap = 'round';
    cc.beginPath(); cc.moveTo(cx, cy - ss * 0.11); cc.lineTo(cx - ss * 0.02, cy + ss * 0.02); cc.stroke();
    cc.beginPath(); cc.moveTo(cx - ss * 0.02, cy + ss * 0.02); cc.lineTo(cx - ss * 0.09, cy + ss * 0.13); cc.stroke();
    cc.beginPath(); cc.moveTo(cx - ss * 0.02, cy + ss * 0.02); cc.lineTo(cx + ss * 0.06, cy + ss * 0.13); cc.stroke();
    cc.beginPath(); cc.moveTo(cx + ss * 0.02, cy - ss * 0.09); cc.lineTo(cx + ss * 0.14, cy + ss * 0.06); cc.stroke();
    cc.beginPath(); cc.moveTo(cx + ss * 0.12, cy + ss * 0.04); cc.lineTo(cx + ss * 0.2, cy + ss * 0.14); cc.stroke();
  });
  grime(c, x, y, s, s, 44, 0.2);
}

function drawDetour(c, x, y, w, h) {
  c.fillStyle = '#f07a10'; c.fillRect(x + w * 0.06, y + h * 0.22, w * 0.88, h * 0.56);
  c.strokeStyle = '#111'; c.lineWidth = w * 0.02;
  c.strokeRect(x + w * 0.09, y + h * 0.25, w * 0.82, h * 0.5);
  c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
  fitText(c, 'DETOUR', w * 0.62, 'bold', 'Arial Narrow, Arial, sans-serif', h * 0.2);
  c.fillText('DETOUR', x + w * 0.44, y + h * 0.44);
  // Arrow
  c.beginPath();
  c.moveTo(x + w * 0.22, y + h * 0.64); c.lineTo(x + w * 0.62, y + h * 0.64);
  c.lineTo(x + w * 0.62, y + h * 0.6); c.lineTo(x + w * 0.74, y + h * 0.665);
  c.lineTo(x + w * 0.62, y + h * 0.73); c.lineTo(x + w * 0.62, y + h * 0.69);
  c.lineTo(x + w * 0.22, y + h * 0.69); c.closePath(); c.fill();
  grime(c, x, y, w, h, 55, 0.22);
}

/** Vertical regulatory plate: white ground, coloured legend rows. */
function drawPlate(c, x, y, w, h, rows, seed, ground = '#f3f2ee', border = '#1b1b1b') {
  c.fillStyle = ground; c.fillRect(x, y, w, h);
  c.strokeStyle = border; c.lineWidth = w * 0.035;
  c.strokeRect(x + w * 0.035, y + h * 0.023, w * 0.93, h * 0.954);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  let cy = y + h * 0.1;
  for (const row of rows) {
    if (row.gap) { cy += h * row.gap; continue; }
    if (row.circleSlash) {
      const r = w * 0.24;
      c.strokeStyle = '#b8101c'; c.lineWidth = w * 0.075;
      c.beginPath(); c.arc(x + w / 2, cy + r, r, 0, 6.2832); c.stroke();
      c.beginPath();
      c.moveTo(x + w / 2 - r * 0.72, cy + r + r * 0.72);
      c.lineTo(x + w / 2 + r * 0.72, cy + r - r * 0.72); c.stroke();
      c.fillStyle = '#1b1b1b';
      fitText(c, row.circleSlash, w * 0.3, 'bold', 'Arial, sans-serif', r * 0.6);
      c.fillText(row.circleSlash, x + w / 2, cy + r);
      cy += r * 2 + h * 0.03;
      continue;
    }
    c.fillStyle = row.color || '#1b1b1b';
    const px = fitText(c, row.t, w * 0.82, row.bold === false ? '' : 'bold', 'Arial Narrow, Arial, sans-serif',
      h * (row.size || 0.085));
    c.fillText(row.t, x + w / 2, cy + px * 0.55);
    cy += px * 1.12;
  }
  grime(c, x, y, w, h, seed, 0.2);
}

function drawOneWay(c, x, y, w, h, dir) {
  c.fillStyle = '#141414'; c.fillRect(x, y, w, h);
  c.strokeStyle = '#f0efe9'; c.lineWidth = h * 0.055;
  c.strokeRect(x + h * 0.07, y + h * 0.07, w - h * 0.14, h - h * 0.14);
  c.save();
  c.translate(x + w / 2, y + h / 2);
  if (dir < 0) c.scale(-1, 1);
  c.fillStyle = '#f0efe9';
  // Shaft + head
  c.fillRect(-w * 0.40, -h * 0.075, w * 0.62, h * 0.15);
  c.beginPath();
  c.moveTo(w * 0.42, 0); c.lineTo(w * 0.20, -h * 0.26); c.lineTo(w * 0.20, h * 0.26);
  c.closePath(); c.fill();
  if (dir < 0) c.scale(-1, 1);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  fitText(c, 'ONE WAY', w * 0.34, 'bold', 'Arial Narrow, Arial, sans-serif', h * 0.3);
  c.fillStyle = '#f0efe9';
  c.fillText('ONE WAY', dir < 0 ? w * 0.20 : -w * 0.20, 0);
  c.restore();
  grime(c, x, y, w, h, 66 + dir, 0.18);
}

function drawBlade(c, x, y, w, h, name, num) {
  c.fillStyle = '#0f6b3c'; c.fillRect(x, y, w, h);
  c.strokeStyle = '#f0efe9'; c.lineWidth = h * 0.055;
  c.strokeRect(x + h * 0.09, y + h * 0.09, w - h * 0.18, h - h * 0.18);
  c.fillStyle = '#f4f3ee'; c.textAlign = 'left'; c.textBaseline = 'middle';
  fitText(c, num, w * 0.16, 'bold', 'Arial, sans-serif', h * 0.32);
  c.fillText(num, x + h * 0.22, y + h * 0.5);
  c.textAlign = 'center';
  fitText(c, name, w * 0.66, 'bold', 'Arial Narrow, Arial, sans-serif', h * 0.46);
  c.fillText(name, x + w * 0.56, y + h * 0.5 + h * 0.01);
  grime(c, x, y, w, h, name.length * 13, 0.22);
}

function drawSpeed(c, x, y, w, h) {
  drawPlate(c, x, y, w, h, [
    { t: 'SPEED', size: 0.11 },
    { t: 'LIMIT', size: 0.11 },
    { gap: 0.02 },
    { t: '25', size: 0.34 },
  ], 77);
}

function drawBusStop(c, x, y, s) {
  c.fillStyle = '#f2f1ec'; c.fillRect(x, y, s, s);
  c.strokeStyle = '#1b1b1b'; c.lineWidth = s * 0.05;
  c.strokeRect(x + s * 0.05, y + s * 0.05, s * 0.9, s * 0.9);
  // MBTA "T" roundel.
  c.fillStyle = '#151515';
  c.beginPath(); c.arc(x + s / 2, y + s * 0.4, s * 0.24, 0, 6.2832); c.fill();
  c.fillStyle = '#f2f1ec';
  c.fillRect(x + s * 0.32, y + s * 0.28, s * 0.36, s * 0.09);
  c.fillRect(x + s * 0.455, y + s * 0.28, s * 0.09, s * 0.26);
  c.fillStyle = '#151515'; c.textAlign = 'center'; c.textBaseline = 'middle';
  fitText(c, 'BUS STOP', s * 0.8, 'bold', 'Arial Narrow, Arial, sans-serif', s * 0.16);
  c.fillText('BUS STOP', x + s / 2, y + s * 0.78);
  grime(c, x, y, s, s, 88, 0.2);
}

function drawMetalBack(c, x, y, s) {
  c.fillStyle = '#9a9c9e'; c.fillRect(x, y, s, s);
  const r = new RNG(99);
  for (let i = 0; i < 120; i++) {
    c.fillStyle = `rgba(${120 + r.int(60)},${120 + r.int(60)},${118 + r.int(60)},0.35)`;
    c.fillRect(x + r.f() * s, y + r.f() * s, r.range(1, 12), r.range(1, 3));
  }
  grime(c, x, y, s, s, 100, 0.3);
}

export const BLADE_NAMES = [
  ['BEACON ST', '100'], ['TREMONT ST', '250'],
  ['BOYLSTON ST', '400'], ['CHARLES ST', '75'],
];

/** Build the 1024^2 sign sheet. */
export function makeSignAtlas() {
  const { canvas, ctx: c } = canvas2d(ATLAS, ATLAS);
  c.fillStyle = '#8f9193'; c.fillRect(0, 0, ATLAS, ATLAS);

  drawStop(c, ...SIGN.stop.slice(0, 2), SIGN.stop[2]);
  drawDoNotEnter(c, SIGN.doNotEnter[0], SIGN.doNotEnter[1], SIGN.doNotEnter[2]);
  drawPedXing(c, SIGN.pedXing[0], SIGN.pedXing[1], SIGN.pedXing[2]);
  drawRoadWork(c, SIGN.roadWork[0], SIGN.roadWork[1], SIGN.roadWork[2]);
  drawDetour(c, SIGN.detour[0], SIGN.detour[1], SIGN.detour[2], SIGN.detour[3]);

  drawPlate(c, ...SIGN.noParking, [
    { circleSlash: 'P' },
    { t: 'NO PARKING', size: 0.075 },
    { t: 'ANY TIME', size: 0.075 },
    { gap: 0.02 },
    { t: 'TOW ZONE', size: 0.06, color: '#b8101c' },
  ], 111);
  drawPlate(c, ...SIGN.resident, [
    { t: 'RESIDENT', size: 0.075, color: '#0f6b3c' },
    { t: 'PERMIT', size: 0.075, color: '#0f6b3c' },
    { t: 'PARKING', size: 0.075, color: '#0f6b3c' },
    { gap: 0.03 },
    { t: 'ONLY', size: 0.09 },
    { gap: 0.02 },
    { t: 'AREA 7', size: 0.07 },
    { t: 'BOSTON', size: 0.05, bold: false },
  ], 122);
  drawPlate(c, ...SIGN.towZone, [
    { t: 'TOW', size: 0.13, color: '#b8101c' },
    { t: 'ZONE', size: 0.13, color: '#b8101c' },
    { gap: 0.03 },
    { t: 'NO STOPPING', size: 0.062 },
    { t: 'STREET', size: 0.062 },
    { t: 'CLEANING', size: 0.062 },
    { t: '8AM-12PM', size: 0.055 },
  ], 133);
  drawPlate(c, ...SIGN.handicap, [
    { t: 'HANDICAP', size: 0.072, color: '#14509e' },
    { t: 'PARKING', size: 0.072, color: '#14509e' },
    { gap: 0.30 },
    { t: 'PERMIT ONLY', size: 0.055 },
    { t: '$300 FINE', size: 0.055, color: '#b8101c' },
  ], 144);
  // Wheelchair pictogram over the gap left above.
  {
    const [x, y, w, h] = SIGN.handicap;
    c.fillStyle = '#14509e';
    c.fillRect(x + w * 0.22, y + h * 0.38, w * 0.56, h * 0.24);
    c.fillStyle = '#f3f2ee';
    c.beginPath(); c.arc(x + w * 0.5, y + h * 0.5, h * 0.075, 0, 6.2832); c.fill();
    c.strokeStyle = '#f3f2ee'; c.lineWidth = w * 0.035;
    c.beginPath(); c.arc(x + w * 0.52, y + h * 0.53, h * 0.052, 0, 6.2832); c.stroke();
  }
  drawPlate(c, ...SIGN.fireLane, [
    { t: 'FIRE LANE', size: 0.09, color: '#b8101c' },
    { gap: 0.02 },
    { t: 'NO', size: 0.09 },
    { t: 'PARKING', size: 0.09 },
    { gap: 0.02 },
    { t: 'VEHICLES', size: 0.05, bold: false },
    { t: 'WILL BE TOWED', size: 0.045, bold: false },
  ], 155);
  drawSpeed(c, ...SIGN.speed25);

  drawOneWay(c, ...SIGN.oneWayL, -1);
  drawOneWay(c, ...SIGN.oneWayR, 1);
  drawBusStop(c, SIGN.busStop[0], SIGN.busStop[1], SIGN.busStop[2]);
  drawMetalBack(c, SIGN.metalBack[0], SIGN.metalBack[1], SIGN.metalBack[2]);

  for (let i = 0; i < 4; i++) {
    const r = SIGN['blade' + i];
    drawBlade(c, r[0], r[1], r[2], r[3], BLADE_NAMES[i][0], BLADE_NAMES[i][1]);
  }
  return canvas;
}

/**
 * A double-sided sign blade: front face UV-mapped to `name`, back face mapped to
 * the plain metal cell. Built in the XY plane, +Z is the face normal.
 */
export function signBlade(w, h, name, thick = 0.014) {
  const [u0, v0, u1, v1] = signUV(name);
  const [b0, c0, b1, c1] = signUV('metalBack');
  const pos = [], nor = [], uv = [];
  const quad = (a, b, cq, d, n, uvs) => {
    const tri = (p1, p2, p3, t1, t2, t3) => {
      pos.push(...p1, ...p2, ...p3);
      nor.push(...n, ...n, ...n);
      uv.push(...t1, ...t2, ...t3);
    };
    tri(a, b, cq, uvs[0], uvs[1], uvs[2]);
    tri(a, cq, d, uvs[0], uvs[2], uvs[3]);
  };
  const x = w / 2, y = h / 2, z = thick / 2;
  quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1],
    [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1],
    [[b0, c0], [b1, c0], [b1, c1], [b0, c1]]);
  // Edge band so the blade has thickness in silhouette.
  const eu = [(b0 + b1) / 2, (c0 + c1) / 2];
  quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0], [eu, eu, eu, eu]);
  quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0], [eu, eu, eu, eu]);
  quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0], [eu, eu, eu, eu]);
  quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0], [eu, eu, eu, eu]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Regular-polygon sign blade (octagon for STOP, diamond for warnings). */
export function signPoly(sides, r, rot, name, thick = 0.014) {
  const [u0, v0, u1, v1] = signUV(name);
  const [b0, c0, b1, c1] = signUV('metalBack');
  const pos = [], nor = [], uv = [];
  const z = thick / 2;
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const mapF = (p) => [u0 + (p[0] / r * 0.5 + 0.5) * (u1 - u0), v0 + (p[1] / r * 0.5 + 0.5) * (v1 - v0)];
  const mapB = (p) => [b0 + (p[0] / r * 0.5 + 0.5) * (b1 - b0), c0 + (p[1] / r * 0.5 + 0.5) * (c1 - c0)];
  for (let i = 1; i < sides - 1; i++) {
    pos.push(pts[0][0], pts[0][1], z, pts[i][0], pts[i][1], z, pts[i + 1][0], pts[i + 1][1], z);
    nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    uv.push(...mapF(pts[0]), ...mapF(pts[i]), ...mapF(pts[i + 1]));
    pos.push(pts[0][0], pts[0][1], -z, pts[i + 1][0], pts[i + 1][1], -z, pts[i][0], pts[i][1], -z);
    nor.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
    uv.push(...mapB(pts[0]), ...mapB(pts[i + 1]), ...mapB(pts[i]));
  }
  const eu = [(b0 + b1) / 2, (c0 + c1) / 2];
  for (let i = 0; i < sides; i++) {
    const a = pts[i], b = pts[(i + 1) % sides];
    const nx = (a[0] + b[0]) / 2, ny = (a[1] + b[1]) / 2;
    const l = Math.hypot(nx, ny) || 1;
    const n = [nx / l, ny / l, 0];
    pos.push(a[0], a[1], z, a[0], a[1], -z, b[0], b[1], -z);
    pos.push(a[0], a[1], z, b[0], b[1], -z, b[0], b[1], z);
    for (let k = 0; k < 6; k++) { nor.push(...n); uv.push(...eu); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// ---------------------------------------------------------------------------
// Shared prop materials
// ---------------------------------------------------------------------------

/**
 * Build (once) the small set of materials every prop shares. Keeping this to a
 * handful of materials means the whole prop system is a handful of shader
 * programs, and `assets.setWetness()` can retune all of it at once.
 */
export function getPropMaterials(ctx) {
  const A = ctx.assets;
  const anis = A._anis || 8;

  const grimeTex = A.texture('prop_grime', () => {
    const S = 512;
    const n = fbm(S, 4321, 5, 3, 0.55);
    const n2 = fbm(S, 91, 4, 12, 0.5);
    const { canvas, ctx: c } = canvas2d(S, S);
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      // Mostly light so vertex colours survive; dirt collects in the noise lows.
      const v = 0.80 + n[i] * 0.26 - Math.pow(1 - n2[i], 6) * 0.34;
      const g = Math.max(0, Math.min(1, v));
      img.data[i * 4] = g * 255 * 1.0;
      img.data[i * 4 + 1] = g * 255 * 0.985;
      img.data[i * 4 + 2] = g * 255 * 0.96;
      img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const t = texFromCanvas(canvas, true);
    t.anisotropy = anis;
    return t;
  });

  const roughTex = A.texture('prop_rough', () => {
    const S = 512;
    const n = fbm(S, 777, 5, 6, 0.55);
    const { canvas, ctx: c } = canvas2d(S, S);
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const g = Math.max(0, Math.min(1, 0.55 + (n[i] - 0.5) * 0.9)) * 255;
      img.data[i * 4] = g; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const t = texFromCanvas(canvas, false);
    t.anisotropy = anis;
    return t;
  });

  const normTex = A.texture('prop_norm', () => {
    const S = 512;
    const h = fbm(S, 2468, 5, 8, 0.5);
    const t = texFromCanvas(normalFromHeight(h, S, 1.4), false);
    t.anisotropy = anis;
    return t;
  });

  const signTex = A.texture('sign_atlas', () => {
    const t = texFromCanvas(makeSignAtlas(), true, false);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = anis;
    return t;
  });

  const wet = (m) => {
    m.userData.wetnessRough = m.roughness;
    m.userData.wetnessColor = m.color.clone();
    return m;
  };

  /**
   * Read the per-vertex `aSurf` attribute as (roughness, metalness). Two lines of
   * GLSL replace what would otherwise be three separate materials — and therefore
   * three draw calls — on almost every prop in the city.
   */
  const patchSurf = (m) => {
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aSurf;\nvarying vec2 vSurf;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSurf = aSurf;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\troughnessFactor *= vSurf.x;')
        .replace('#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\n\tmetalnessFactor = vSurf.y;');
    };
    m.customProgramCacheKey = () => 'propSurf';
    return m;
  };

  /** Emissive tinted by vertex colour, so one material lights red, green and sodium. */
  const patchEmit = (m, key) => {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor;');
    };
    m.customProgramCacheKey = () => key;
    return m;
  };

  const M = {
    // The workhorse: every opaque prop surface. Albedo from vertex colour,
    // roughness/metalness from aSurf, grain from the shared detail maps.
    surf: A.material('prop_surf', () => patchSurf(wet(new THREE.MeshStandardMaterial({
      map: grimeTex, roughnessMap: roughTex, normalMap: normTex,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: 1.0, metalness: 1.0, vertexColors: true,
    })))),
    // Retroreflective sign faces off the shared atlas.
    sign: A.material('prop_sign', () => wet(new THREE.MeshStandardMaterial({
      map: signTex, roughnessMap: roughTex, roughness: 0.42, metalness: 0.04,
      vertexColors: true, side: THREE.FrontSide,
    }))),
    glass: A.material('prop_glass', () => new THREE.MeshStandardMaterial({
      color: 0xa9bcc6, roughness: 0.05, metalness: 0.0, transparent: true,
      opacity: 0.20, depthWrite: false, side: THREE.DoubleSide, vertexColors: true,
    })),
    // Always-on: traffic signal lenses, meter LEDs, dock indicators.
    emit: A.material('prop_emit', () => patchEmit(new THREE.MeshStandardMaterial({
      color: 0x14181a, emissive: 0xffffff, emissiveIntensity: 2.4,
      roughness: 0.28, metalness: 0.0, vertexColors: true,
    }), 'propEmit')),
    // Dusk-to-dawn: luminaires, shelter strips, shopfront fascias.
    emitNight: A.material('prop_emit_night', () => patchEmit(new THREE.MeshStandardMaterial({
      color: 0xb8b4a8, emissive: 0xffffff, emissiveIntensity: 0.0,
      roughness: 0.32, metalness: 0.0, vertexColors: true,
    }), 'propEmitNight')),
  };
  M.glass.userData.wetnessRough = M.glass.roughness;
  return M;
}

// ---------------------------------------------------------------------------
// Prop builders. Each returns { d0, d1?, slots } via GeoSet.build().
// `d1` is the low-detail level used past ~70m; omit it for props that are
// culled entirely at range.
// ---------------------------------------------------------------------------

const C = {
  poleGreen: '#1d2a22', poleBlack: '#16181a', poleGrey: '#54585c',
  galv: '#9ea3a6', steel: '#7e8386', alu: '#b4b8ba',
  rust: '#6b3f26', rustLight: '#8a5533',
  concrete: '#9b9791', concreteDark: '#6f6c68', concreteWet: '#84817d',
  wood: '#7a6449', ply: '#b09468', woodPole: '#5f5347',
  black: '#141416', darkGrey: '#2b2d30', midGrey: '#4a4d50',
  uspsBlue: '#1d3f77', hydrantRed: '#a5161d', hydrantYellow: '#c9a017',
  boltGreen: '#14432a', signalYellow: '#c9b23a',
  orange: '#d4560f', white: '#d8d5cc', offWhite: '#c9c6bd',
  blue: '#1b4f86', tealBike: '#1f6f8b',
  glassDark: '#3b4448', fabricRed: '#7c2225', fabricGreen: '#1f4a35',
  leafGreen: '#3d5a2a', tarBlack: '#1b1b1c',
};

/** Cast-iron acorn "Boston Light" — Beacon Hill, the Common, Back Bay. */
function buildLampAcorn() {
  const g = new GeoSet();
  // Fluted base
  g.add('paint', lathe([[0.20, 0], [0.21, 0.06], [0.17, 0.10], [0.175, 0.42],
    [0.145, 0.50], [0.115, 0.56], [0.105, 0.62]], 12), C.poleGreen);
  g.add('paint', cyl(0.070, 0.100, 2.85, 10), C.poleGreen, { p: [0, 0.62 + 1.425, 0] });
  // Collar + ladder rest
  g.add('paint', cyl(0.105, 0.105, 0.07, 10), C.poleGreen, { p: [0, 3.50, 0] });
  g.add('metal', cyl(0.012, 0.012, 0.30, 5), C.poleBlack, { p: [0, 3.42, 0.13], r: [0.35, 0, 0] });
  // Acorn globe: pinched neck, fat body, blunt point
  g.add('lamp', lathe([[0.055, 0], [0.10, 0.05], [0.175, 0.14], [0.205, 0.26],
    [0.19, 0.38], [0.13, 0.47], [0.05, 0.52], [0.0, 0.53]], 14), '#efe9dc',
    { p: [0, 3.55, 0] });
  // Finial
  g.add('paint', sph(0.035, 8, 6), C.poleGreen, { p: [0, 4.10, 0] });
  g.add('paint', cyl(0.008, 0.02, 0.10, 6), C.poleGreen, { p: [0, 4.16, 0] });
  const d0 = g.build(0.5);

  const l = new GeoSet();
  l.add('paint', cyl(0.075, 0.16, 3.55, 6), C.poleGreen, { p: [0, 1.78, 0] });
  l.add('lamp', sph(0.19, 6, 4), '#efe9dc', { p: [0, 3.78, 0] });
  return { d0, d1: l.build(0.5), near: 85, far: 340, cast: true };
}

/** Twin-globe park lamp, taller, used along Common paths. */
function buildLampTwin() {
  const g = new GeoSet();
  g.add('paint', lathe([[0.24, 0], [0.25, 0.07], [0.20, 0.12], [0.205, 0.5],
    [0.16, 0.60], [0.12, 0.70]], 12), C.poleGreen);
  g.add('paint', cyl(0.075, 0.11, 3.4, 10), C.poleGreen, { p: [0, 0.70 + 1.7, 0] });
  for (const sx of [-1, 1]) {
    g.add('paint', cyl(0.045, 0.045, 0.75, 8), C.poleGreen, { p: [sx * 0.375, 4.10, 0], r: [0, 0, Math.PI / 2] });
    g.add('paint', cyl(0.05, 0.06, 0.10, 8), C.poleGreen, { p: [sx * 0.72, 4.16, 0] });
    g.add('lamp', lathe([[0.05, 0], [0.10, 0.05], [0.17, 0.14], [0.195, 0.25],
      [0.175, 0.36], [0.11, 0.45], [0.0, 0.50]], 12), '#efe9dc', { p: [sx * 0.72, 4.21, 0] });
  }
  g.add('lamp', lathe([[0.05, 0], [0.10, 0.05], [0.17, 0.14], [0.195, 0.25],
    [0.175, 0.36], [0.11, 0.45], [0.0, 0.50]], 12), '#efe9dc', { p: [0, 4.28, 0] });
  g.add('paint', cyl(0.05, 0.06, 0.10, 8), C.poleGreen, { p: [0, 4.23, 0] });
  const d0 = g.build(0.5);
  const l = new GeoSet();
  l.add('paint', cyl(0.08, 0.2, 4.2, 6), C.poleGreen, { p: [0, 2.1, 0] });
  l.add('lamp', sph(0.18, 6, 4), '#efe9dc', { p: [0, 4.5, 0] });
  for (const sx of [-1, 1]) l.add('lamp', sph(0.16, 6, 4), '#efe9dc', { p: [sx * 0.72, 4.4, 0] });
  return { d0, d1: l.build(0.5), near: 90, far: 380, cast: true };
}

/** Modern cobra-head on a davit arm — arterials, Storrow, the Pike frontage. */
function buildLampCobra() {
  const g = new GeoSet();
  g.add('metal', cyl(0.085, 0.135, 8.6, 10), C.poleGrey, { p: [0, 4.3, 0] });
  g.add('metal', cyl(0.16, 0.19, 0.55, 10), C.poleGrey, { p: [0, 0.28, 0] });
  // Davit arm: three short segments approximating the curve.
  g.add('metal', cyl(0.055, 0.07, 1.05, 8), C.poleGrey, { p: [0.19, 8.95, 0], r: [0, 0, -0.62] });
  g.add('metal', cyl(0.05, 0.055, 1.15, 8), C.poleGrey, { p: [0.86, 9.32, 0], r: [0, 0, -1.16] });
  g.add('metal', cyl(0.045, 0.05, 1.30, 8), C.poleGrey, { p: [1.94, 9.45, 0], r: [0, 0, -1.53] });
  // Luminaire
  g.add('paint', box(0.78, 0.13, 0.30), C.alu, { p: [2.86, 9.42, 0], r: [0, 0, -0.06] });
  g.add('paint', lathe([[0.14, 0], [0.16, 0.05], [0.10, 0.16], [0.0, 0.19]], 10), C.alu,
    { p: [2.60, 9.44, 0], r: [0, 0, Math.PI / 2] });
  g.add('lamp', box(0.60, 0.035, 0.24), '#efe9dc', { p: [2.88, 9.34, 0], r: [0, 0, -0.06] });
  const d0 = g.build(0.6);
  const l = new GeoSet();
  l.add('metal', cyl(0.09, 0.15, 9.0, 5), C.poleGrey, { p: [0, 4.5, 0] });
  l.add('metal', cyl(0.05, 0.05, 2.9, 4), C.poleGrey, { p: [1.45, 9.4, 0], r: [0, 0, Math.PI / 2] });
  l.add('lamp', box(0.7, 0.14, 0.28), '#cfcabd', { p: [2.86, 9.4, 0] });
  return { d0, d1: l.build(0.6), near: 110, far: 520, cast: true };
}

/** One signal head: housing, visors, three lenses, yellow backplate. */
function signalHead(g, x, y, z, showGreen) {
  g.add('paint', box(0.50, 1.22, 0.03), C.signalYellow, { p: [x, y, z - 0.10] });
  g.add('paint', box(0.44, 1.16, 0.03), C.black, { p: [x, y, z - 0.085] });
  g.add('paint', box(0.34, 1.05, 0.20), C.boltGreen, { p: [x, y, z] });
  for (let i = 0; i < 3; i++) {
    const ly = y + 0.33 - i * 0.33;
    g.add('paint', cyl(0.15, 0.15, 0.055, 10, true), C.boltGreen, { p: [x, ly + 0.055, z + 0.135], r: [Math.PI / 2, 0, 0] });
    // Visor: a half-cone hood over each lens.
    g.add('paint', cyl(0.155, 0.145, 0.20, 10, true), C.boltGreen,
      { p: [x, ly + 0.055, z + 0.20], r: [Math.PI / 2 - 0.16, 0, 0] });
    const lit = (i === 0 && !showGreen) || (i === 2 && showGreen);
    const slot = lit ? (showGreen ? 'lampGreen' : 'lampRed') : 'paint';
    const col = lit ? (showGreen ? '#2fe86e' : '#ff3418')
      : (i === 0 ? '#3a1414' : i === 1 ? '#3a2f12' : '#12301c');
    g.add(slot, cyl(0.125, 0.125, 0.02, 12), col, { p: [x, ly, z + 0.15], r: [Math.PI / 2, 0, 0] });
  }
}

/** US mast-arm signal assembly — Boston runs dark-green poles with yellow backplates. */
function buildTrafficMast(showGreen) {
  const g = new GeoSet();
  g.add('rough', cyl(0.34, 0.40, 0.30, 12), C.concreteDark, { p: [0, 0.09, 0] });
  g.add('paint', cyl(0.115, 0.165, 7.2, 12), C.poleGreen, { p: [0, 3.6, 0] });
  g.add('paint', cyl(0.20, 0.22, 0.14, 12), C.poleGreen, { p: [0, 0.30, 0] });
  // Mast arm reaches out along -X, tapering over 8m with a slight rise. The arm
  // must sit on the far-right corner of an approach and lean left across the
  // roadway; with a Y-only placement rotation that only works if it runs -X.
  g.add('paint', cyl(0.075, 0.125, 8.0, 10), C.poleGreen, { p: [-4.0, 6.62, 0], r: [0, 0, Math.PI / 2 + 0.035] });
  g.add('paint', box(0.5, 0.22, 0.10), C.poleGreen, { p: [-0.28, 6.30, 0], r: [0, 0, -0.5] });
  // Three heads hung from the arm.
  signalHead(g, -2.6, 5.85, 0.0, showGreen);
  signalHead(g, -4.9, 5.92, 0.0, showGreen);
  signalHead(g, -7.0, 5.99, 0.0, showGreen);
  for (const hx of [-2.6, -4.9, -7.0]) {
    g.add('paint', box(0.06, 0.30, 0.06), C.poleGreen, { p: [hx, 6.55, 0] });
  }
  // Street blade hung off the mast — very Boston.
  g.add('sign', signBlade(1.35, 0.32, 'blade1'), '#ffffff', { p: [-5.6, 6.95, 0], r: [0, Math.PI / 2, 0] });
  g.add('metal', box(0.03, 0.16, 0.03), C.galv, { p: [-5.05, 7.06, 0] });
  g.add('metal', box(0.03, 0.16, 0.03), C.galv, { p: [-6.15, 7.06, 0] });
  // Controller cabinet at the base.
  g.add('paint', box(0.55, 1.25, 0.42), '#8b8f8c', { p: [0, 0.63, -0.62] });
  g.add('paint', box(0.60, 0.05, 0.47), '#7d817e', { p: [0, 1.27, -0.62] });
  const d0 = g.build(0.6);

  const l = new GeoSet();
  l.add('paint', cyl(0.12, 0.17, 7.2, 6), C.poleGreen, { p: [0, 3.6, 0] });
  l.add('paint', cyl(0.09, 0.12, 8.0, 5), C.poleGreen, { p: [-4.0, 6.62, 0], r: [0, 0, Math.PI / 2] });
  for (const hx of [-2.6, -4.9, -7.0]) {
    l.add('paint', box(0.44, 1.16, 0.14), C.signalYellow, { p: [hx, 5.9, 0] });
    l.add(showGreen ? 'lampGreen' : 'lampRed', box(0.22, 0.22, 0.03),
      showGreen ? '#2fe86e' : '#ff3418', { p: [hx, showGreen ? 5.57 : 6.23, 0.09] });
  }
  l.add('paint', box(0.55, 1.25, 0.42), '#8b8f8c', { p: [0, 0.63, -0.62] });
  return { d0, d1: l.build(0.6), near: 130, far: 620, cast: true };
}

/** Pedestrian signal head + push button on a short post. */
function buildPedSignal() {
  const g = new GeoSet();
  g.add('paint', cyl(0.055, 0.075, 3.1, 8), C.poleGreen, { p: [0, 1.55, 0] });
  g.add('rough', cyl(0.16, 0.19, 0.16, 10), C.concreteDark, { p: [0, 0.05, 0] });
  g.add('paint', box(0.42, 0.44, 0.24), C.boltGreen, { p: [0, 2.85, 0.16] });
  g.add('paint', box(0.48, 0.50, 0.02), C.black, { p: [0, 2.85, 0.03] });
  g.add('paint', box(0.40, 0.12, 0.16), C.boltGreen, { p: [0, 3.12, 0.22], r: [-0.22, 0, 0] });
  g.add('lampRed', box(0.33, 0.34, 0.02), '#e8590c', { p: [0, 2.85, 0.29] });
  // Push button + sign
  g.add('paint', box(0.11, 0.16, 0.09), '#4c5150', { p: [0.0, 1.15, 0.10] });
  g.add('lampRed', cyl(0.028, 0.028, 0.02, 8), '#ffd166', { p: [0.0, 1.17, 0.155], r: [Math.PI / 2, 0, 0] });
  g.add('sign', signBlade(0.24, 0.30, 'pedXing'), '#ffffff', { p: [0, 1.52, 0.09] });
  const d0 = g.build(0.5);
  const l = new GeoSet();
  l.add('paint', cyl(0.06, 0.08, 3.1, 5), C.poleGreen, { p: [0, 1.55, 0] });
  l.add('paint', box(0.42, 0.44, 0.2), C.boltGreen, { p: [0, 2.85, 0.14] });
  return { d0, d1: l.build(0.5), near: 70, far: 230, cast: true };
}

/** U-channel post carrying one or two plates. */
function postSign(plates, height = 2.55) {
  const g = new GeoSet();
  g.add('metal', box(0.05, height, 0.035), C.galv, { p: [0, height / 2, 0] });
  g.add('metal', box(0.09, 0.05, 0.05), C.galv, { p: [0, 0.06, 0] });
  for (const pl of plates) g.add('sign', pl.geo, '#ffffff', { p: pl.p, r: pl.r || [0, 0, 0] });
  return g;
}

function buildStopSign() {
  const g = postSign([{ geo: signPoly(8, 0.375, Math.PI / 8, 'stop'), p: [0, 2.10, 0.03] }], 2.50);
  const d0 = g.build(0.5);
  const l = new GeoSet();
  l.add('metal', box(0.05, 2.5, 0.035), C.galv, { p: [0, 1.25, 0] });
  l.add('sign', signPoly(8, 0.375, Math.PI / 8, 'stop'), '#ffffff', { p: [0, 2.10, 0.03] });
  return { d0, d1: l.build(0.5), near: 60, far: 260, cast: true };
}

function buildPlateSign(name, w, h, y, second) {
  const plates = [{ geo: signBlade(w, h, name), p: [0, y, 0.028] }];
  if (second) plates.push({ geo: signBlade(second.w, second.h, second.name), p: [0, second.y, 0.028] });
  const g = postSign(plates, y + h / 2 + 0.12);
  return { d0: g.build(0.5), near: 55, far: 210, cast: true };
}

function buildOneWay(dir) {
  const g = postSign([{ geo: signBlade(0.90, 0.30, dir > 0 ? 'oneWayR' : 'oneWayL'), p: [0, 2.20, 0.028] }], 2.45);
  return { d0: g.build(0.5), near: 55, far: 240, cast: true };
}

/** Two street-name blades crossed at the top of a slender post. */
function buildStreetBlades(i, j) {
  const g = new GeoSet();
  g.add('metal', cyl(0.035, 0.045, 3.15, 8), C.poleGrey, { p: [0, 1.575, 0] });
  g.add('metal', cyl(0.07, 0.08, 0.10, 8), C.poleGrey, { p: [0, 0.05, 0] });
  g.add('sign', signBlade(1.05, 0.26, 'blade' + i), '#ffffff', { p: [0, 3.05, 0] });
  g.add('sign', signBlade(1.05, 0.26, 'blade' + j), '#ffffff', { p: [0, 2.74, 0], r: [0, Math.PI / 2, 0] });
  g.add('metal', box(0.05, 0.62, 0.05), C.poleGrey, { p: [0, 2.9, 0] });
  return { d0: g.build(0.5), near: 70, far: 280, cast: true };
}

/** Single-space parking meter (Boston still has thousands of them). */
function buildParkingMeter() {
  const g = new GeoSet();
  g.add('metal', cyl(0.032, 0.042, 1.05, 8), C.poleGrey, { p: [0, 0.525, 0] });
  g.add('metal', cyl(0.06, 0.07, 0.07, 8), C.poleGrey, { p: [0, 0.035, 0] });
  g.add('paint', box(0.155, 0.34, 0.115), '#3d4a4e', { p: [0, 1.22, 0] });
  g.add('paint', lathe([[0.078, 0], [0.078, 0.02], [0.05, 0.055], [0, 0.065]], 8), '#3d4a4e', { p: [0, 1.39, 0] });
  g.add('glass', box(0.10, 0.10, 0.012), '#7fa9bb', { p: [0, 1.30, 0.062] });
  g.add('lamp', box(0.075, 0.032, 0.004), '#9fe3b0', { p: [0, 1.30, 0.069] });
  g.add('metal', cyl(0.016, 0.016, 0.03, 8), C.galv, { p: [0.052, 1.14, 0.058], r: [Math.PI / 2, 0, 0] });
  const d0 = g.build(0.35);
  const l = new GeoSet();
  l.add('metal', cyl(0.04, 0.045, 1.05, 4), C.poleGrey, { p: [0, 0.525, 0] });
  l.add('paint', box(0.155, 0.36, 0.115), '#3d4a4e', { p: [0, 1.23, 0] });
  return { d0, d1: l.build(0.35), near: 45, far: 140, cast: true };
}

/** Multi-space pay station. */
function buildPayStation() {
  const g = new GeoSet();
  g.add('metal', box(0.30, 1.30, 0.22), '#2f3639', { p: [0, 0.65, 0] });
  g.add('metal', box(0.34, 0.06, 0.26), '#2f3639', { p: [0, 1.33, 0] });
  g.add('paint', box(0.30, 0.36, 0.10), '#3f4a4e', { p: [0, 1.20, 0.14], r: [0.42, 0, 0] });
  g.add('glass', box(0.20, 0.24, 0.01), '#5f8ea3', { p: [0, 1.215, 0.19], r: [0.42, 0, 0] });
  g.add('lamp', box(0.17, 0.20, 0.004), '#8fd7c0', { p: [0, 1.213, 0.196], r: [0.42, 0, 0] });
  g.add('paint', box(0.26, 0.16, 0.02), '#1c2225', { p: [0, 0.86, 0.115] });
  g.add('sign', signBlade(0.24, 0.30, 'resident'), '#ffffff', { p: [0, 0.55, 0.115] });
  g.add('rough', box(0.36, 0.05, 0.28), C.concreteDark, { p: [0, 0.025, 0] });
  return { d0: g.build(0.4), near: 55, far: 150, cast: true };
}

/** US pillar hydrant. Boston: red barrel, bonnet colour-coded by flow rate. */
function buildHydrant(bonnetHex) {
  const g = new GeoSet();
  g.add('paint', lathe([[0.20, 0], [0.21, 0.03], [0.185, 0.07], [0.145, 0.10],
    [0.125, 0.14], [0.125, 0.50], [0.145, 0.53], [0.155, 0.57], [0.12, 0.60]], 12), C.hydrantRed);
  g.add('paint', lathe([[0.125, 0], [0.155, 0.02], [0.15, 0.07], [0.115, 0.115],
    [0.06, 0.145], [0.0, 0.15]], 12), bonnetHex, { p: [0, 0.60, 0] });
  g.add('metal', box(0.045, 0.045, 0.06), C.galv, { p: [0, 0.765, 0] });
  // Steamer + two hose nozzles with caps and chains.
  g.add('paint', cyl(0.075, 0.085, 0.13, 10), bonnetHex, { p: [0, 0.40, 0.145], r: [Math.PI / 2, 0, 0] });
  g.add('paint', cyl(0.082, 0.082, 0.035, 10), bonnetHex, { p: [0, 0.40, 0.215], r: [Math.PI / 2, 0, 0] });
  for (const sx of [-1, 1]) {
    g.add('paint', cyl(0.052, 0.06, 0.115, 8), bonnetHex, { p: [sx * 0.135, 0.36, -0.065], r: [0, 0, Math.PI / 2] });
    g.add('paint', cyl(0.058, 0.058, 0.03, 8), bonnetHex, { p: [sx * 0.195, 0.36, -0.065], r: [0, 0, Math.PI / 2] });
    g.add('metal', cyl(0.006, 0.006, 0.16, 4), '#3a3d40', { p: [sx * 0.10, 0.47, 0.02], r: [0.5, 0, sx * 0.3] });
  }
  const d0 = g.build(0.3);
  const l = new GeoSet();
  l.add('paint', cyl(0.13, 0.19, 0.62, 6), C.hydrantRed, { p: [0, 0.31, 0] });
  l.add('paint', sph(0.13, 6, 4), bonnetHex, { p: [0, 0.66, 0] });
  return { d0, d1: l.build(0.3), near: 45, far: 150, cast: true };
}

/** USPS blue collection box. */
function buildMailbox() {
  const g = new GeoSet();
  g.add('paint', box(0.50, 0.78, 0.60), C.uspsBlue, { p: [0, 0.66, 0] });
  g.add('paint', lathe([[0.30, 0], [0.30, 0.02], [0.26, 0.14], [0.16, 0.22], [0, 0.245]], 12), C.uspsBlue,
    { p: [0, 1.05, 0], s: [1, 1, 1] });
  g.add('paint', box(0.50, 0.30, 0.62), C.uspsBlue, { p: [0, 1.10, 0.0], s: [1, 1, 0.97] });
  g.add('paint', box(0.36, 0.20, 0.13), '#16305c', { p: [0, 1.15, 0.30], r: [-0.5, 0, 0] });
  g.add('metal', box(0.34, 0.03, 0.04), C.galv, { p: [0, 1.25, 0.315] });
  for (const sx of [-1, 1]) g.add('metal', box(0.06, 0.26, 0.28), '#33373a', { p: [sx * 0.20, 0.14, 0] });
  g.add('sign', signBlade(0.30, 0.10, 'metalBack'), '#e8e6df', { p: [0, 0.86, 0.302] });
  const d0 = g.build(0.4);
  const l = new GeoSet();
  l.add('paint', box(0.50, 1.10, 0.60), C.uspsBlue, { p: [0, 0.72, 0] });
  return { d0, d1: l.build(0.4), near: 50, far: 150, cast: true };
}

/** Newspaper vending box. */
function buildNewsBox(hex) {
  const g = new GeoSet();
  g.add('paint', box(0.42, 0.72, 0.36), hex, { p: [0, 0.68, 0] });
  g.add('paint', box(0.44, 0.14, 0.38), '#2a2c2e', { p: [0, 1.10, 0] });
  g.add('glass', box(0.30, 0.34, 0.012), '#8fb0bd', { p: [0, 0.80, 0.185] });
  g.add('paint', box(0.34, 0.40, 0.02), '#cbc7ba', { p: [0, 0.80, 0.172] });
  g.add('metal', box(0.05, 0.32, 0.05), '#3c4043', { p: [-0.16, 0.16, 0.14] });
  g.add('metal', box(0.05, 0.32, 0.05), '#3c4043', { p: [0.16, 0.16, 0.14] });
  g.add('metal', box(0.05, 0.32, 0.05), '#3c4043', { p: [-0.16, 0.16, -0.14] });
  g.add('metal', box(0.05, 0.32, 0.05), '#3c4043', { p: [0.16, 0.16, -0.14] });
  const d0 = g.build(0.35);
  const l = new GeoSet();
  l.add('paint', box(0.42, 0.92, 0.36), hex, { p: [0, 0.6, 0] });
  return { d0, d1: l.build(0.35), near: 40, far: 120, cast: true };
}

/** Big Belly solar compactor — the Boston bin. */
function buildBigBelly() {
  const g = new GeoSet();
  g.add('paint', box(0.62, 1.20, 0.62), '#1f4a35', { p: [0, 0.62, 0] });
  g.add('paint', box(0.66, 0.09, 0.66), '#163526', { p: [0, 1.22, 0] });
  g.add('paint', box(0.66, 0.07, 0.66), '#163526', { p: [0, 0.05, 0] });
  g.add('paint', box(0.44, 0.30, 0.10), '#123021', { p: [0, 0.92, 0.32], r: [-0.1, 0, 0] });
  g.add('metal', box(0.30, 0.045, 0.05), C.galv, { p: [0, 1.06, 0.36] });
  g.add('glass', box(0.40, 0.02, 0.30), '#22303a', { p: [0, 1.27, -0.10], r: [-0.16, 0, 0] });
  g.add('sign', signBlade(0.36, 0.20, 'metalBack'), '#d9d6cd', { p: [0, 0.52, 0.313] });
  const d0 = g.build(0.4);
  const l = new GeoSet();
  l.add('paint', box(0.64, 1.30, 0.64), '#1f4a35', { p: [0, 0.65, 0] });
  return { d0, d1: l.build(0.4), near: 55, far: 170, cast: true };
}

/** Wire-mesh litter basket, the older Boston bin. */
function buildWireBin() {
  const g = new GeoSet();
  const R = 0.28;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.add('metal', box(0.022, 0.78, 0.022), '#3d4144', { p: [Math.cos(a) * R, 0.40, Math.sin(a) * R] });
  }
  for (const y of [0.10, 0.42, 0.74]) {
    g.add('metal', new THREE.TorusGeometry(R, 0.014, 4, 16), '#3d4144', { p: [0, y, 0], r: [Math.PI / 2, 0, 0] });
  }
  g.add('metal', cyl(R + 0.03, R + 0.03, 0.05, 14), '#33373a', { p: [0, 0.80, 0] });
  g.add('rough', cyl(R - 0.02, R - 0.02, 0.02, 12), C.tarBlack, { p: [0, 0.06, 0] });
  // Half-full bin bag poking above the rim.
  g.add('rough', sph(0.24, 8, 6), '#232628', { p: [0, 0.72, 0], s: [1.05, 0.55, 1.05] });
  const d0 = g.build(0.3);
  const l = new GeoSet();
  l.add('metal', cyl(R, R, 0.8, 8, true), '#3d4144', { p: [0, 0.4, 0] });
  return { d0, d1: l.build(0.3), near: 45, far: 130, cast: true };
}

/** Slatted bench with cast-iron ends. */
function buildBench(park) {
  const g = new GeoSet();
  const L = 1.83, slat = 0.075, gap = 0.028;
  const woodHex = park ? '#5c4a33' : '#6b563c';
  for (let i = 0; i < 5; i++) {
    g.add('rough', box(L, 0.032, slat), woodHex, { p: [0, 0.44, -0.22 + i * (slat + gap)] });
  }
  for (let i = 0; i < 4; i++) {
    g.add('rough', box(L, slat, 0.032), woodHex, { p: [0, 0.58 + i * (slat + gap), -0.27], r: [-0.16, 0, 0] });
  }
  for (const sx of [-1, 1]) {
    const x = sx * (L / 2 - 0.055);
    g.add('paint', box(0.05, 0.42, 0.06), C.poleGreen, { p: [x, 0.21, -0.20] });
    g.add('paint', box(0.05, 0.42, 0.06), C.poleGreen, { p: [x, 0.21, 0.16] });
    g.add('paint', box(0.05, 0.05, 0.52), C.poleGreen, { p: [x, 0.42, -0.02] });
    g.add('paint', box(0.05, 0.46, 0.05), C.poleGreen, { p: [x, 0.66, -0.27], r: [-0.16, 0, 0] });
    g.add('paint', box(0.05, 0.10, 0.30), C.poleGreen, { p: [x, 0.42, -0.34], r: [0.6, 0, 0] });
    g.add('paint', box(0.09, 0.035, 0.55), C.poleGreen, { p: [x, 0.018, -0.02] });
  }
  const d0 = g.build(0.4);
  const l = new GeoSet();
  l.add('rough', box(L, 0.05, 0.52), woodHex, { p: [0, 0.44, -0.02] });
  l.add('rough', box(L, 0.42, 0.05), woodHex, { p: [0, 0.70, -0.28], r: [-0.16, 0, 0] });
  for (const sx of [-1, 1]) l.add('paint', box(0.05, 0.44, 0.5), C.poleGreen, { p: [sx * (L / 2 - 0.05), 0.22, -0.02] });
  return { d0, d1: l.build(0.4), near: 60, far: 180, cast: true };
}

/** Inverted-U bike hoop. */
function buildBikeRack() {
  const g = new GeoSet();
  const t = new THREE.TorusGeometry(0.33, 0.026, 5, 12, Math.PI);
  g.add('metal', t, C.steel, { p: [0, 0.60, 0] });
  for (const sx of [-1, 1]) g.add('metal', cyl(0.026, 0.026, 0.62, 6), C.steel, { p: [sx * 0.33, 0.30, 0] });
  g.add('rough', box(0.14, 0.03, 0.14), C.concreteDark, { p: [-0.33, 0.015, 0] });
  g.add('rough', box(0.14, 0.03, 0.14), C.concreteDark, { p: [0.33, 0.015, 0] });
  return { d0: g.build(0.3), near: 45, far: 120, cast: true };
}

/** Bluebikes dock: kiosk plus a rail of docking points and two parked bikes. */
function buildBluebikes() {
  const g = new GeoSet();
  // Kiosk
  g.add('paint', box(0.42, 1.55, 0.24), '#20486b', { p: [0, 0.78, 0] });
  g.add('paint', box(0.46, 0.07, 0.28), '#173653', { p: [0, 1.57, 0] });
  g.add('glass', box(0.28, 0.30, 0.012), '#6f9ab0', { p: [0, 1.20, 0.128] });
  g.add('lamp', box(0.24, 0.26, 0.004), '#9fd8e8', { p: [0, 1.20, 0.135] });
  g.add('sign', signBlade(0.34, 0.28, 'metalBack'), '#dbe6ec', { p: [0, 0.70, 0.126] });
  // Dock rail
  for (let i = 0; i < 6; i++) {
    const z = 0.9 + i * 0.85;
    g.add('metal', box(0.30, 0.16, 0.62), '#4d5457', { p: [0, 0.09, z] });
    g.add('paint', box(0.10, 0.62, 0.09), '#20486b', { p: [0, 0.42, z - 0.24] });
    g.add('lamp', box(0.045, 0.045, 0.01), '#7ce39a', { p: [0, 0.62, z - 0.19] });
  }
  g.add('rough', box(0.60, 0.04, 5.6), C.concreteDark, { p: [0, 0.02, 3.0] });
  // Two bikes in the dock
  for (const i of [1, 4]) {
    const z = 0.9 + i * 0.85;
    g.add('paint', new THREE.TorusGeometry(0.33, 0.028, 4, 12), '#2b2f31', { p: [0, 0.36, z + 0.42] });
    g.add('paint', new THREE.TorusGeometry(0.33, 0.028, 4, 12), '#2b2f31', { p: [0, 0.36, z - 0.55] });
    g.add('paint', box(0.06, 0.06, 0.98), '#3f7fb5', { p: [0, 0.52, z - 0.06], r: [0.1, 0, 0] });
    g.add('paint', box(0.05, 0.42, 0.05), '#3f7fb5', { p: [0, 0.55, z + 0.34], r: [-0.35, 0, 0] });
    g.add('rough', box(0.34, 0.05, 0.09), '#1c1f21', { p: [0, 0.98, z - 0.44] });
    g.add('rough', box(0.10, 0.06, 0.24), '#1c1f21', { p: [0, 0.78, z + 0.2] });
  }
  return { d0: g.build(0.5), near: 90, far: 250, cast: true };
}

/** Steel pipe bollard with a domed cap. */
function buildBollard() {
  const g = new GeoSet();
  g.add('paint', cyl(0.055, 0.06, 0.86, 10), '#2e3336', { p: [0, 0.43, 0] });
  g.add('paint', lathe([[0.06, 0], [0.055, 0.02], [0.035, 0.04], [0, 0.05]], 10), '#2e3336', { p: [0, 0.86, 0] });
  g.add('paint', cyl(0.075, 0.085, 0.06, 10), '#23282b', { p: [0, 0.03, 0] });
  g.add('sign', signBlade(0.09, 0.045, 'metalBack'), '#ddd9cf', { p: [0, 0.70, 0.061] });
  const d0 = g.build(0.25);
  const l = new GeoSet();
  l.add('paint', cyl(0.06, 0.07, 0.9, 5), '#2e3336', { p: [0, 0.45, 0] });
  return { d0, d1: l.build(0.25), near: 40, far: 130, cast: true };
}

/** Sidewalk utility cabinet / traffic controller / phone box. */
function buildUtilityBox(hex) {
  const g = new GeoSet();
  g.add('paint', box(0.72, 1.05, 0.44), hex, { p: [0, 0.60, 0] });
  g.add('paint', box(0.78, 0.05, 0.50), hex, { p: [0, 1.15, 0] });
  g.add('rough', box(0.80, 0.10, 0.52), C.concreteDark, { p: [0, 0.05, 0] });
  g.add('metal', box(0.03, 0.86, 0.03), '#5c6265', { p: [0, 0.60, 0.225] });
  g.add('metal', box(0.07, 0.10, 0.04), '#5c6265', { p: [0.18, 0.72, 0.23] });
  for (let i = 0; i < 4; i++) g.add('paint', box(0.5, 0.012, 0.02), '#242628', { p: [0, 0.9 - i * 0.07, 0.222] });
  const d0 = g.build(0.45);
  const l = new GeoSet();
  l.add('paint', box(0.72, 1.15, 0.44), hex, { p: [0, 0.58, 0] });
  return { d0, d1: l.build(0.45), near: 55, far: 170, cast: true };
}

/** Cast-iron manhole cover, sitting 15mm proud of the asphalt like a real one. */
function buildManhole() {
  const g = new GeoSet();
  g.add('metal', lathe([[0.36, 0], [0.36, 0.014], [0.335, 0.022], [0.0, 0.024]], 16), '#3f423f');
  // Pick-hole bosses and a raised rim ring. Two 4x18 tori were 288 of this
  // prop's 472 triangles for two beads 12 mm thick on something lying flat on
  // the road — a ring of segments reads identically and costs a tenth.
  g.add('metal', new THREE.RingGeometry(0.265, 0.295, 16, 1), '#4a4d4a',
    { p: [0, 0.026, 0], r: [-Math.PI / 2, 0, 0] });
  g.add('metal', new THREE.RingGeometry(0.150, 0.172, 12, 1), '#4a4d4a',
    { p: [0, 0.026, 0], r: [-Math.PI / 2, 0, 0] });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add('metal', box(0.10, 0.008, 0.03), '#494c49', { p: [Math.cos(a) * 0.22, 0.028, Math.sin(a) * 0.22], r: [0, -a, 0] });
  }
  return { d0: g.build(0.25), near: 62, far: 150, cast: false, receive: true };
}

/** Kerb-inlet storm drain: the throat under the kerb plus a grate in the gutter. */
function buildStormDrain() {
  const g = new GeoSet();
  g.add('rough', box(1.12, 0.15, 0.10), '#33352f', { p: [0, 0.075, 0.10] });
  g.add('rough', box(1.24, 0.06, 0.30), C.concreteDark, { p: [0, 0.03, -0.10] });
  for (let i = 0; i < 7; i++) {
    g.add('metal', box(0.085, 0.03, 0.30), '#3d403c', { p: [-0.45 + i * 0.15, 0.05, -0.10] });
  }
  g.add('metal', box(1.24, 0.035, 0.05), '#3d403c', { p: [0, 0.05, -0.26] });
  g.add('metal', box(1.24, 0.035, 0.05), '#3d403c', { p: [0, 0.05, 0.05] });
  return { d0: g.build(0.3), near: 55, far: 130, cast: false, receive: true };
}

/** Traffic cone, 28in, with two reflective collars and a scuffed base. */
function buildCone() {
  const g = new GeoSet();
  g.add('rough', lathe([[0.18, 0], [0.18, 0.03], [0.135, 0.05], [0.10, 0.16],
    [0.062, 0.44], [0.043, 0.64], [0.036, 0.71]], 12), C.orange);
  g.add('rough', box(0.36, 0.028, 0.36), '#c04d0d', { p: [0, 0.014, 0] });
  g.add('rough', cyl(0.083, 0.089, 0.10, 12), '#d9d5c8', { p: [0, 0.36, 0] });
  g.add('rough', cyl(0.055, 0.059, 0.065, 12), '#d9d5c8', { p: [0, 0.53, 0] });
  const d0 = g.build(0.25);
  const l = new GeoSet();
  l.add('rough', cyl(0.036, 0.16, 0.71, 5), C.orange, { p: [0, 0.355, 0] });
  return { d0, d1: l.build(0.25), near: 45, far: 140, cast: true };
}

/** Channelizer drum. */
function buildBarrel() {
  const g = new GeoSet();
  g.add('rough', cyl(0.28, 0.29, 1.06, 14), C.orange, { p: [0, 0.53, 0] });
  for (const y of [0.20, 0.44, 0.68, 0.92]) {
    g.add('rough', cyl(0.292, 0.292, 0.11, 14), y % 0.48 < 0.24 ? '#d9d5c8' : C.orange, { p: [0, y, 0] });
  }
  g.add('rough', cyl(0.30, 0.30, 0.04, 14), '#b8480c', { p: [0, 1.06, 0] });
  g.add('rough', box(0.80, 0.05, 0.80), '#2a2c2d', { p: [0, 0.025, 0] });
  const d0 = g.build(0.35);
  const l = new GeoSet();
  l.add('rough', cyl(0.29, 0.29, 1.06, 6), C.orange, { p: [0, 0.53, 0] });
  return { d0, d1: l.build(0.35), near: 50, far: 170, cast: true };
}

/** Jersey barrier, 10ft precast, with a lift hook and a scuffed base. */
function buildJersey() {
  const g = new GeoSet();
  const prof = new THREE.Shape();
  prof.moveTo(-0.305, 0); prof.lineTo(0.305, 0); prof.lineTo(0.24, 0.075);
  prof.lineTo(0.115, 0.33); prof.lineTo(0.09, 0.81); prof.lineTo(-0.09, 0.81);
  prof.lineTo(-0.115, 0.33); prof.lineTo(-0.24, 0.075); prof.closePath();
  const ex = new THREE.ExtrudeGeometry(prof, { depth: 3.05, bevelEnabled: false, curveSegments: 1 });
  ex.translate(0, 0, -1.525);
  g.add('rough', ex, C.concrete);
  g.add('metal', new THREE.TorusGeometry(0.05, 0.011, 4, 8, Math.PI), C.rust, { p: [0, 0.80, -0.7] });
  g.add('metal', new THREE.TorusGeometry(0.05, 0.011, 4, 8, Math.PI), C.rust, { p: [0, 0.80, 0.7] });
  const d0 = g.build(0.6);
  const l = new GeoSet();
  l.add('rough', box(0.44, 0.81, 3.05), C.concrete, { p: [0, 0.405, 0] });
  return { d0, d1: l.build(0.6), near: 80, far: 300, cast: true };
}

/** Tube-and-clamp scaffold bay, three lifts, plank deck, debris netting. */
function buildScaffold() {
  const g = new GeoSet();
  const W = 2.10, D = 1.45, LIFT = 2.0, LIFTS = 3;
  const H = LIFT * LIFTS;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add('metal', cyl(0.024, 0.024, H, 6), C.galv, { p: [sx * W / 2, H / 2, sz * D / 2] });
    g.add('rough', box(0.16, 0.02, 0.16), '#4b4e50', { p: [sx * W / 2, 0.01, sz * D / 2] });
  }
  for (let i = 1; i <= LIFTS; i++) {
    const y = i * LIFT;
    for (const sz of [-1, 1]) {
      g.add('metal', cyl(0.022, 0.022, W, 6), C.galv, { p: [0, y, sz * D / 2], r: [0, 0, Math.PI / 2] });
      g.add('metal', cyl(0.022, 0.022, W, 6), C.galv, { p: [0, y - 0.95, sz * D / 2], r: [0, 0, Math.PI / 2] });
    }
    for (const sx of [-1, 1]) g.add('metal', cyl(0.022, 0.022, D, 6), C.galv, { p: [sx * W / 2, y, 0], r: [Math.PI / 2, 0, 0] });
    // Diagonal brace + plank deck
    g.add('metal', cyl(0.02, 0.02, Math.hypot(W, LIFT), 5), C.galv,
      { p: [0, y - LIFT / 2, D / 2], r: [0, 0, Math.atan2(W, LIFT)] });
    for (let k = 0; k < 3; k++) {
      g.add('rough', box(W - 0.1, 0.035, 0.30), '#9c8259', { p: [0, y + 0.02, -0.45 + k * 0.45] });
    }
  }
  // Debris netting on the street face
  g.add('rough', box(W, H, 0.01), '#2f5d43', { p: [0, H / 2, D / 2 + 0.03] });
  return { d0: g.build(0.55), near: 140, far: 420, cast: true };
}

/** 20-yard construction dumpster. */
function buildSkip() {
  const g = new GeoSet();
  g.add('paint', box(1.85, 1.35, 3.70), '#7d5a1e', { p: [0, 0.72, 0] });
  g.add('paint', box(1.92, 0.10, 3.78), '#6a4c19', { p: [0, 1.36, 0] });
  g.add('paint', box(1.75, 1.10, 3.55), '#3b3226', { p: [0, 0.85, 0] });
  for (const sz of [-1, 1]) g.add('metal', box(1.95, 0.09, 0.09), '#5d4315', { p: [0, 0.95, sz * 1.86] });
  g.add('metal', box(0.09, 1.30, 0.09), '#5d4315', { p: [0.93, 0.72, -1.2] });
  g.add('metal', box(0.09, 1.30, 0.09), '#5d4315', { p: [-0.93, 0.72, -1.2] });
  g.add('metal', box(0.09, 1.30, 0.09), '#5d4315', { p: [0.93, 0.72, 1.2] });
  g.add('metal', box(0.09, 1.30, 0.09), '#5d4315', { p: [-0.93, 0.72, 1.2] });
  // Spoil heaped above the rim.
  g.add('rough', sph(0.9, 8, 5), '#6a625a', { p: [0, 1.30, -0.5], s: [0.95, 0.32, 1.5] });
  g.add('rough', box(1.2, 0.05, 0.7), '#8d7454', { p: [0.2, 1.48, 0.9], r: [0.14, 0.5, 0.1] });
  g.add('rough', box(0.9, 0.05, 0.6), '#7d6749', { p: [-0.3, 1.44, 1.3], r: [-0.1, -0.3, 0.06] });
  const d0 = g.build(0.6);
  const l = new GeoSet();
  l.add('paint', box(1.85, 1.45, 3.70), '#7d5a1e', { p: [0, 0.72, 0] });
  return { d0, d1: l.build(0.6), near: 90, far: 320, cast: true };
}

/** Plywood hoarding panel, 8ft, with a rail frame and flyposting. */
function buildHoarding() {
  const g = new GeoSet();
  g.add('rough', box(2.44, 2.44, 0.02), C.ply, { p: [0, 1.22, 0] });
  g.add('rough', box(2.44, 0.09, 0.09), '#6d5a3f', { p: [0, 2.40, -0.05] });
  g.add('rough', box(2.44, 0.09, 0.09), '#6d5a3f', { p: [0, 1.20, -0.05] });
  g.add('rough', box(0.09, 2.44, 0.09), '#6d5a3f', { p: [-1.18, 1.22, -0.05] });
  g.add('rough', box(0.09, 2.44, 0.09), '#6d5a3f', { p: [1.18, 1.22, -0.05] });
  g.add('rough', box(0.09, 0.09, 0.9), '#6d5a3f', { p: [-1.18, 0.06, -0.45] });
  g.add('rough', box(0.09, 0.09, 0.9), '#6d5a3f', { p: [1.18, 0.06, -0.45] });
  return { d0: g.build(0.6), near: 110, far: 235, cast: true };
}

/** Orange A-frame temporary sign. */
function buildTempSign(name) {
  const g = new GeoSet();
  for (const sx of [-1, 1]) {
    g.add('rough', box(0.06, 1.05, 0.05), C.orange, { p: [sx * 0.30, 0.52, 0], r: [sx * 0.12, 0, 0] });
    g.add('rough', box(0.06, 1.05, 0.05), C.orange, { p: [sx * 0.30, 0.52, 0.22], r: [-sx * 0.12, 0, 0] });
  }
  g.add('rough', box(0.72, 0.05, 0.30), C.orange, { p: [0, 0.06, 0.11] });
  g.add('sign', name === 'roadWork'
    ? signPoly(4, 0.52, Math.PI / 4, 'roadWork')
    : signBlade(0.75, 0.55, 'detour'), '#ffffff', { p: [0, 1.10, 0.02], r: [-0.10, 0, 0] });
  return { d0: g.build(0.4), near: 60, far: 200, cast: true };
}

/** Bus shelter: glazed, 4m, with a route map, an ad panel and a perch bench. */
function buildBusShelter() {
  const g = new GeoSet();
  const W = 4.0, D = 1.55, H = 2.42;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add('metal', box(0.075, H, 0.075), '#3b4144', { p: [sx * (W / 2 - 0.05), H / 2, sz * (D / 2 - 0.05)] });
  }
  g.add('metal', box(W, 0.09, D), '#3b4144', { p: [0, H - 0.045, 0] });
  g.add('metal', box(W + 0.24, 0.05, D + 0.30), '#4a5154', { p: [0, H + 0.03, 0.06], r: [-0.045, 0, 0] });
  g.add('metal', box(W, 0.08, 0.08), '#3b4144', { p: [0, 0.9, -D / 2 + 0.05] });
  // Back glass + side glass
  g.add('glass', box(W - 0.2, H - 0.30, 0.012), '#9db4bf', { p: [0, H / 2 + 0.05, -D / 2 + 0.05] });
  g.add('glass', box(0.012, H - 0.30, D - 0.2), '#9db4bf', { p: [-W / 2 + 0.05, H / 2 + 0.05, 0] });
  g.add('glass', box(1.10, H - 0.30, 0.012), '#9db4bf', { p: [W / 2 - 0.62, H / 2 + 0.05, D / 2 - 0.05] });
  // Ad panel / route map on the right-hand end
  g.add('metal', box(0.10, 1.90, 1.20), '#31373a', { p: [W / 2 - 0.05, 1.16, 0] });
  g.add('sign', signBlade(1.05, 1.55, 'busStop'), '#eae7de', { p: [W / 2 - 0.11, 1.24, 0], r: [0, -Math.PI / 2, 0] });
  g.add('lamp', box(0.01, 1.55, 1.05), '#e8e4d6', { p: [W / 2 - 0.115, 1.24, 0] });
  // Perch bench
  g.add('metal', box(2.4, 0.05, 0.34), '#4d5457', { p: [-0.5, 0.60, -D / 2 + 0.22], r: [0.12, 0, 0] });
  for (const x of [-1.6, 0.6]) g.add('metal', box(0.06, 0.58, 0.30), '#4d5457', { p: [x, 0.30, -D / 2 + 0.22] });
  // Underside strip light
  g.add('lamp', box(W - 0.6, 0.03, 0.14), '#efeadc', { p: [0, H - 0.11, 0.2] });
  // Bus-stop flag on a post at the kerb end
  g.add('metal', cyl(0.045, 0.05, 3.0, 8), '#3b4144', { p: [-W / 2 - 0.55, 1.5, D / 2 - 0.2] });
  g.add('sign', signBlade(0.36, 0.36, 'busStop'), '#ffffff', { p: [-W / 2 - 0.55, 2.75, D / 2 - 0.17] });
  const d0 = g.build(0.6);
  const l = new GeoSet();
  l.add('metal', box(W + 0.24, 0.10, D + 0.3), '#4a5154', { p: [0, H, 0] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    l.add('metal', box(0.08, H, 0.08), '#3b4144', { p: [sx * (W / 2 - 0.05), H / 2, sz * (D / 2 - 0.05)] });
  }
  l.add('glass', box(W - 0.2, H - 0.3, 0.02), '#9db4bf', { p: [0, H / 2, -D / 2 + 0.05] });
  return { d0, d1: l.build(0.6), near: 130, far: 400, cast: true };
}

/** Wood utility pole with crossarm, insulators, transformer and a riser conduit. */
function buildUtilityPole(withTransformer) {
  const g = new GeoSet();
  const H = 11.0;
  g.add('rough', cyl(0.115, 0.17, H, 9), C.woodPole, { p: [0, H / 2 - 0.4, 0] });
  // Crossarms
  for (const [y, len] of [[9.45, 2.45], [8.55, 2.10]]) {
    g.add('rough', box(len, 0.09, 0.11), '#6d6152', { p: [0, y, 0] });
    g.add('metal', box(0.03, 0.36, 0.03), '#4a4d4f', { p: [0, y - 0.2, 0.09], r: [0.35, 0, 0] });
    const n = len > 2.3 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * (len / n);
      g.add('rough', lathe([[0.045, 0], [0.06, 0.03], [0.04, 0.06], [0.055, 0.09], [0.02, 0.13]], 7),
        '#3b4f43', { p: [x, y + 0.045, 0] });
    }
  }
  if (withTransformer) {
    g.add('metal', cyl(0.29, 0.29, 0.86, 12), '#7e8285', { p: [0.42, 7.4, 0] });
    g.add('metal', cyl(0.30, 0.30, 0.05, 12), '#6d7174', { p: [0.42, 7.86, 0] });
    g.add('metal', box(0.12, 0.9, 0.08), '#5f6366', { p: [0.13, 7.4, 0] });
    g.add('rough', lathe([[0.05, 0], [0.07, 0.04], [0.04, 0.08], [0.06, 0.12], [0.02, 0.17]], 7),
      '#3b4f43', { p: [0.42, 7.92, 0] });
  }
  // Riser conduit and pole hardware
  g.add('metal', cyl(0.035, 0.035, 6.2, 6), '#54585b', { p: [-0.16, 2.7, 0] });
  g.add('metal', box(0.10, 0.28, 0.03), '#4a4d4f', { p: [0, 1.6, 0.17] });
  for (let i = 0; i < 5; i++) {
    g.add('metal', box(0.03, 0.03, 0.22), '#3f4245', { p: [0.15, 1.2 + i * 0.42, 0], r: [0, 0, 0] });
  }
  const d0 = g.build(0.5);
  const l = new GeoSet();
  l.add('rough', cyl(0.12, 0.18, H, 5), C.woodPole, { p: [0, H / 2 - 0.4, 0] });
  l.add('rough', box(2.45, 0.10, 0.12), '#6d6152', { p: [0, 9.45, 0] });
  l.add('rough', box(2.10, 0.10, 0.12), '#6d6152', { p: [0, 8.55, 0] });
  if (withTransformer) l.add('metal', cyl(0.29, 0.29, 0.86, 6), '#7e8285', { p: [0.42, 7.4, 0] });
  return { d0, d1: l.build(0.5), near: 200, far: 900, cast: true };
}

/** Cast-iron tree-pit grate, two halves with a slot for the trunk. */
function buildTreeGrate() {
  const g = new GeoSet();
  const R = 0.78;
  // 6,295 of these lie flat on the pavement, so they are the most numerous prop
  // in the city and are seen almost edge-on. The 4x24 torus rim alone was 192 of
  // the original 440 triangles; a flat ring rim is indistinguishable from any
  // angle you actually see a tree pit from.
  g.add('metal', new THREE.RingGeometry(0.20, R, 16, 1), '#3a3d3a', { p: [0, 0.03, 0], r: [-Math.PI / 2, 0, 0] });
  g.add('metal', new THREE.RingGeometry(R - 0.03, R + 0.02, 16, 1), '#43463f',
    { p: [0, 0.034, 0], r: [-Math.PI / 2, 0, 0] });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add('rough', box(0.02, 0.012, R - 0.22), '#22241f',
      { p: [Math.cos(a) * (R + 0.20) / 2, 0.037, Math.sin(a) * (R + 0.20) / 2], r: [0, -a, 0] });
  }
  g.add('rough', cyl(0.20, 0.20, 0.06, 10), '#33302a', { p: [0, 0.0, 0] });
  return { d0: g.build(0.3), near: 58, far: 130, cast: false, receive: true };
}

/** Concrete planter with a shrub. */
function buildPlanter() {
  const g = new GeoSet();
  g.add('rough', lathe([[0.46, 0], [0.48, 0.06], [0.44, 0.10], [0.40, 0.62],
    [0.44, 0.70], [0.42, 0.74], [0.38, 0.72]], 14), C.concrete);
  g.add('rough', cyl(0.37, 0.37, 0.06, 12), '#3a3126', { p: [0, 0.66, 0] });
  // Planting. One squashed sphere reads as a green ball on a pot from three
  // metres away — the critic called this out by name — so the mass is built
  // from eight small overlapping lobes at four tones with a few bare stems
  // showing through. Same triangle order, completely different silhouette.
  {
    const r = new RNG(5150);
    const tone = ['#33501f', '#436828', '#2a4419', '#4d7530'];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r.range(-0.4, 0.4);
      const rr = r.range(0.10, 0.30);
      const s = r.range(0.13, 0.23);
      g.add('rough', sph(s, 6, 4), tone[i & 3], {
        p: [Math.cos(a) * rr, 0.72 + r.range(0.02, 0.30), Math.sin(a) * rr],
        s: [r.range(0.9, 1.5), r.range(0.7, 1.1), r.range(0.9, 1.4)],
      });
    }
    for (let i = 0; i < 3; i++) {
      const a = r.range(0, 6.28);
      g.add('rough', box(0.014, 0.30, 0.014), '#4a4230',
        { p: [Math.cos(a) * 0.14, 0.80, Math.sin(a) * 0.14], r: [r.range(-0.2, 0.2), a, r.range(-0.25, 0.25)] });
    }
  }
  const d0 = g.build(0.4);
  const l = new GeoSet();
  l.add('rough', cyl(0.40, 0.46, 0.72, 7), C.concrete, { p: [0, 0.36, 0] });
  l.add('rough', sph(0.40, 5, 4), '#3f5c30', { p: [0, 0.85, 0], s: [1, 0.7, 1] });
  return { d0, d1: l.build(0.4), near: 60, far: 180, cast: true };
}

/** Steel fire escape bay — balcony, guard, drop ladder. Mounted on a wall. */
function buildFireEscape() {
  const g = new GeoSet();
  const W = 2.6, D = 1.05;
  for (const y of [0, 3.4]) {
    g.add('metal', box(W, 0.05, D), C.rust, { p: [0, y, D / 2] });
    for (let i = 0; i < 9; i++) g.add('metal', box(W, 0.012, 0.03), '#4d4038', { p: [0, y + 0.03, 0.1 + i * 0.11] });
    g.add('metal', box(W, 0.035, 0.035), C.rust, { p: [0, y + 0.95, D] });
    g.add('metal', box(W, 0.03, 0.03), C.rust, { p: [0, y + 0.50, D] });
    for (let i = 0; i < 10; i++) {
      g.add('metal', box(0.018, 0.95, 0.018), C.rust, { p: [-W / 2 + 0.06 + i * (W - 0.12) / 9, y + 0.48, D] });
    }
    for (const sx of [-1, 1]) {
      g.add('metal', box(0.03, 0.95, D), C.rust, { p: [sx * W / 2, y + 0.48, D / 2], s: [1, 1, 0.04] });
      g.add('metal', box(0.03, 0.95, 0.03), C.rust, { p: [sx * W / 2, y + 0.48, D] });
    }
    // Diagonal support struts back to the wall
    g.add('metal', box(1.15, 0.04, 0.04), C.rust, { p: [-W / 2 + 0.2, y - 0.4, D * 0.75], r: [0, 0, 0.72] });
    g.add('metal', box(1.15, 0.04, 0.04), C.rust, { p: [W / 2 - 0.2, y - 0.4, D * 0.75], r: [0, 0, 0.72] });
  }
  // Stair flight between the two balconies
  for (let i = 0; i < 12; i++) {
    g.add('metal', box(0.72, 0.02, 0.20), '#4d4038', { p: [-0.75, 0.30 + i * 0.26, 0.22 + i * 0.062] });
  }
  for (const sx of [-1, 1]) {
    g.add('metal', box(0.05, 0.05, 3.55), C.rust, { p: [-0.75 + sx * 0.37, 1.85, 0.62], r: [-1.24, 0, 0] });
    g.add('metal', box(0.035, 0.035, 3.55), C.rust, { p: [-0.75 + sx * 0.37, 2.75, 0.62], r: [-1.24, 0, 0] });
  }
  // Drop ladder hanging off the lower balcony
  for (const sx of [-1, 1]) g.add('metal', box(0.028, 2.3, 0.028), C.rust, { p: [0.85 + sx * 0.21, -1.15, 0.85] });
  for (let i = 0; i < 8; i++) g.add('metal', box(0.44, 0.02, 0.02), '#4d4038', { p: [0.85, -0.2 - i * 0.28, 0.85] });

  // At 984 triangles this was the most expensive prop in the library, and with
  // no second level it drew every one of them out to 215 m, where the whole bay
  // is a few pixels of rusty lattice. LOD1 keeps the two decks, the guard line
  // and the stair diagonal — the only parts that read at that range — for 8% of
  // the cost.
  const l = new GeoSet();
  for (const y of [0, 3.4]) {
    l.add('metal', box(W, 0.06, D), C.rust, { p: [0, y, D / 2] });
    l.add('metal', box(W, 0.95, 0.05), C.rust, { p: [0, y + 0.48, D] });
  }
  l.add('metal', box(0.78, 0.06, 3.5), '#4d4038', { p: [-0.75, 1.85, 0.62], r: [-1.24, 0, 0] });
  l.add('metal', box(0.48, 2.3, 0.05), C.rust, { p: [0.85, -1.15, 0.85] });
  return { d0: g.build(0.4), d1: l.build(0.4), near: 78, far: 215, cast: true };
}

/** Fabric awning over a storefront. */
function buildAwning(hex) {
  const g = new GeoSet();
  const W = 3.0, P = 1.30;
  g.add('rough', box(W, 0.06, P), hex, { p: [0, 0.42, P / 2], r: [-0.34, 0, 0] });
  g.add('rough', box(W, 0.30, 0.05), hex, { p: [0, 0.02, P - 0.06], r: [0.06, 0, 0] });
  for (let i = 0; i < 7; i++) {
    g.add('rough', box(0.05, 0.06, P), i % 2 ? '#e8e3d6' : hex,
      { p: [-W / 2 + 0.2 + i * (W - 0.4) / 6, 0.425, P / 2], r: [-0.34, 0, 0] });
  }
  g.add('metal', box(W, 0.05, 0.05), '#3d4144', { p: [0, 0.66, 0.02] });
  for (const sx of [-1, 1]) g.add('metal', box(0.035, 0.035, P), '#3d4144', { p: [sx * (W / 2 - 0.1), 0.42, P / 2], r: [-0.34, 0, 0] });
  return { d0: g.build(0.5), near: 110, far: 215, cast: true };
}

/** Window A/C unit. */
function buildACUnit() {
  const g = new GeoSet();
  g.add('paint', box(0.62, 0.38, 0.44), '#8f9296', { p: [0, 0, 0.18] });
  g.add('paint', box(0.58, 0.32, 0.02), '#4c5054', { p: [0, 0, 0.40] });
  for (let i = 0; i < 6; i++) g.add('paint', box(0.54, 0.02, 0.02), '#6d7276', { p: [0, -0.13 + i * 0.05, 0.41] });
  g.add('metal', box(0.66, 0.03, 0.06), '#5c6165', { p: [0, -0.20, 0.05] });
  g.add('rough', box(0.06, 0.05, 0.30), '#3c3f42', { p: [0.24, -0.20, 0.20] });
  return { d0: g.build(0.35), near: 70, far: 190, cast: true };
}

/** Satellite dish on a wall bracket. */
function buildSatDish() {
  const g = new GeoSet();
  g.add('metal', box(0.06, 0.34, 0.06), '#6f7376', { p: [0, 0, 0.06] });
  g.add('metal', cyl(0.02, 0.02, 0.42, 6), '#6f7376', { p: [0, 0.08, 0.25], r: [1.0, 0, 0] });
  const dish = new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, 0.55);
  g.add('paint', dish, '#c8c6bf', { p: [0, 0.30, 0.42], r: [2.05, 0, 0] });
  g.add('metal', cyl(0.016, 0.016, 0.30, 5), '#5c6165', { p: [0, 0.14, 0.50], r: [-0.5, 0, 0] });
  g.add('paint', box(0.07, 0.09, 0.09), '#3f4245', { p: [0, 0.06, 0.62] });
  return { d0: g.build(0.3), near: 70, far: 200, cast: true };
}

/** Siamese standpipe connection on a building face. */
function buildStandpipe() {
  const g = new GeoSet();
  g.add('metal', box(0.44, 0.30, 0.10), '#6c5a2c', { p: [0, 0, 0.05] });
  for (const sx of [-1, 1]) {
    g.add('metal', cyl(0.065, 0.07, 0.16, 10), '#8a6f2e', { p: [sx * 0.12, 0, 0.16], r: [Math.PI / 2, 0, 0] });
    g.add('metal', cyl(0.072, 0.072, 0.03, 10), '#7a6228', { p: [sx * 0.12, 0, 0.25], r: [Math.PI / 2, 0, 0] });
  }
  g.add('sign', signBlade(0.22, 0.14, 'metalBack'), '#c9302c', { p: [0, 0.30, 0.03] });
  return { d0: g.build(0.25), near: 55, far: 140, cast: true };
}

/** Flag on an angled staff — US, Massachusetts, and the odd Irish tricolour. */
function buildFlag(hex1, hex2, hex3) {
  const g = new GeoSet();
  g.add('metal', cyl(0.028, 0.032, 2.4, 8), '#b9a06a', { p: [0.9, 0.62, 0], r: [0, 0, -0.9] });
  g.add('metal', sph(0.05, 8, 6), '#c9b071', { p: [1.88, 1.38, 0] });
  g.add('metal', box(0.16, 0.10, 0.10), '#5c5f62', { p: [0.06, 0.02, 0] });
  // Cloth: a shallow S so it reads as hanging, not a plane.
  const seg = 7, W = 1.5, H = 0.95;
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const bend = Math.sin(t * 3.3) * 0.11;
    const hex = t < 0.34 ? hex1 : t < 0.67 ? hex2 : hex3;
    g.add('rough', box(W / seg + 0.005, H, 0.012), hex,
      { p: [0.52 + t * 1.28 + W / seg / 2, 0.98 - t * 0.30, bend], r: [0, -bend * 0.9, -0.22] });
  }
  return { d0: g.build(0.45), near: 90, far: 240, cast: true };
}

/** Refuse sacks piled at the kerb. */
function buildBinBags() {
  const g = new GeoSet();
  const r = new RNG(4242);
  for (let i = 0; i < 5; i++) {
    const s = r.range(0.26, 0.40);
    g.add('rough', sph(s, 7, 5), r.chance(0.7) ? '#1c1e20' : '#2c3033',
      { p: [r.range(-0.5, 0.5), s * 0.78, r.range(-0.3, 0.3)], s: [1, r.range(0.72, 0.95), r.range(0.85, 1.1)] });
  }
  g.add('rough', box(0.44, 0.36, 0.30), '#9c8258', { p: [0.62, 0.18, 0.16], r: [0, 0.5, 0.1] });
  g.add('rough', box(0.52, 0.03, 0.42), '#a68c62', { p: [-0.62, 0.02, -0.2], r: [0, -0.3, 0] });
  const d0 = g.build(0.35);
  const l = new GeoSet();
  l.add('rough', sph(0.46, 5, 4), '#1c1e20', { p: [0, 0.34, 0], s: [1.5, 0.8, 1.1] });
  return { d0, d1: l.build(0.35), near: 45, far: 120, cast: true };
}

/**
 * Snow bank ploughed up against the kerb. Winter/snow only — see
 * `Props._applySnow`, which is the thing that must actually keep these off a
 * clear August street.
 *
 * Ploughed snow in a city is never white. It is grit-grey within a day and
 * black at the road edge where the plough dragged it through the gutter, so the
 * bank is authored as a dirty gradient: soiled at the base, only the crown near
 * white.
 */
function buildSnowBank() {
  const g = new GeoSet();
  const r = new RNG(8181);
  for (let i = 0; i < 7; i++) {
    const s = r.range(0.34, 0.62);
    const y = s * 0.40;
    // Lower lumps are road-grimed; only the top of the bank keeps any white.
    const hex = y < 0.16 ? '#7d7c78' : y < 0.24 ? '#a3a49f' : '#c6c8c4';
    g.add('rough', sph(s, 6, 4), hex,
      { p: [r.range(-1.5, 1.5), y, r.range(-0.16, 0.16)], s: [r.range(1.1, 1.7), r.range(0.42, 0.66), 0.9] });
  }
  return { d0: g.build(0.6), near: 90, far: 90, cast: true, receive: true };
}

// ---------------------------------------------------------------------------
// Parked cars
//
// A real city street is mostly parked cars; without them no amount of signage
// or litter makes a street read as inhabited. These are STATIC SHELLS, not
// vehicles: no physics body, no simulation, no wheels that turn. They exist to
// line the kerb, so the budget goes on silhouette and proportion and nothing
// else. LOD0 is ~380 triangles and LOD1 ~90, both instanced, so a fully parked
// street costs a few tens of thousands of triangles rather than millions.
//
// Real overall dimensions, because scale is what sells a vehicle at 3 m:
// a Camry is 4.88 x 1.84 x 1.45, a RAV4 4.60 x 1.86 x 1.69, a Civic hatch
// 4.52 x 1.80 x 1.41, an F-150 5.89 x 2.03 x 1.95, a Transit 5.53 x 2.06 x 2.10.
// ---------------------------------------------------------------------------

/**
 * Slot for each material bucket VehicleModels hands back, so a real car body
 * drops straight into the prop pipeline's shared surface/sign/glass materials.
 */
const CAR_SLOT = {
  paint: 'paint', glass: 'glass', glassDark: 'glass', chrome: 'chrome',
  trimDark: 'rough', trim: 'rough', under: 'rough', tire: 'rough',
  interior: 'rough', lensRed: 'paint', lensClear: 'chrome', gap: 'rough',
};
/** Non-body colours. The body colour comes from the vehicle's own palette. */
const CAR_COL = {
  glass: '#20272b', glassDark: '#161b1e', chrome: '#b9bdc0', trimDark: '#1d1f21',
  trim: '#26292b', under: '#141517', tire: '#17181a', interior: '#101113',
  lensRed: '#7a1a18', lensClear: '#c9ccce', gap: '#131416',
};

/**
 * A parked car, built from the *real* vehicle body loft.
 *
 * The first version of this was a hand-rolled stack of boxes: 424 triangles,
 * no wheel arches, no glazing worth the name. That was invisible as a problem
 * while there were zero parked cars in the game; the moment the kerbs filled
 * up it became the closest object to the camera on every street shot, and the
 * critic called it "the dominant foreground liability" at 3.7 m.
 *
 * The fix is not to model another car. `VehicleModels.getVehicleGeometry`
 * already lofts a proper body with wheel arches, fascias, a greenhouse and
 * baked wheels at three levels of detail, and it caches per type — so a parked
 * car and a moving car now share one geometry build. We take **LOD1** (the
 * mid tier: arch lips, fascias, real glass, wheels baked in, five material
 * buckets) for close range and **LOD2** (the two-bucket coarse shell traffic
 * already instances) for distance, and feed both through `GeoSet` so they come
 * out as one merged geometry per level on the shared prop materials.
 *
 * Nothing in VehicleModels is modified or duplicated, and because `GeoSet.add`
 * copies through `toNonIndexed()`, `disposeSharedGeometry()` staying under
 * VehicleFactory's control is safe.
 */
function buildCarFromVehicle(type, bodyHex) {
  const src = getVehicleGeometry(type);
  const level = (lod) => {
    const set = new GeoSet();
    let any = false;
    for (const [key, geom] of src.lods[lod].geos) {
      if (!geom) continue;
      set.add(CAR_SLOT[key] || 'rough', geom, key === 'paint' ? bodyHex : (CAR_COL[key] || '#26292b'));
      any = true;
    }
    return any ? set.build(0.55) : null;
  };
  const d0 = level(1);
  const d1 = level(2);
  if (!d0) return null;
  // LOD ranges are measured, not guessed. The mid tier is ~3.5k triangles and
  // the shell ~430, and `PropBatch` selects per 96 m chunk, so the near band is
  // coarse: at `near` 95 a North End street had 133 cars at full detail and
  // 349 shells — 622k triangles of parked car in one frustum, which is more
  // than every other prop in the game put together. Swept on a live scene:
  //
  //   near/far   car triangles   full-detail / shell
  //    95 / 260      622k             133 / 349
  //    42 / 260      369k              53 / 429
  //    30 / 180      267k              44 / 264
  //    30 / 165      ~230k             44 / ~200
  //    22 / 150      176k              28 / 182
  //
  // 30/165 keeps ~44 cars at full detail around the camera — which is the range
  // the critic was looking at when it called the old box "the dominant
  // foreground liability" at 3.7 m — and spends the saving on the long tail.
  return { d0, d1, near: 38, far: 155, cast: true, receive: true };
}

/**
 * The parked fleet. Body colours come from each vehicle type's own palette in
 * VehicleModels, so the parked cars and the moving cars are drawn from the same
 * paints instead of drifting apart.
 */
function buildParkedCars() {
  const pal = (type, i) => {
    const c = VEHICLE_SPECS[type]?.def?.colors;
    return (c && c.length) ? c[i % c.length] : '#9a9da0';
  };
  const want = [
    ['carSedanA', 'sedan', 0], ['carSedanB', 'sedan', 2], ['carSedanC', 'sedan', 4],
    ['carSuvA', 'suv', 0], ['carSuvB', 'suv', 1], ['carSuvC', 'suv', 3],
    ['carVanA', 'van', 0], ['carPickupA', 'pickup', 0], ['carSportsA', 'sports', 0],
  ];
  const out = [];
  for (const [name, type, ci] of want) {
    const def = buildCarFromVehicle(type, pal(type, ci));
    if (def) out.push([name, def]);
  }
  return out;
}

/** Hanging shop sign on a scrolled bracket. */
function buildShopSign(hex) {
  const g = new GeoSet();
  g.add('metal', box(0.05, 0.05, 0.90), '#26292b', { p: [0, 0.28, 0.45] });
  g.add('metal', box(0.04, 0.36, 0.04), '#26292b', { p: [0, 0.10, 0.84] });
  g.add('metal', box(0.035, 0.035, 0.40), '#26292b', { p: [0, 0.08, 0.26], r: [0.62, 0, 0] });
  g.add('rough', box(0.045, 0.62, 0.86), hex, { p: [0, -0.20, 0.84] });
  g.add('metal', box(0.055, 0.05, 0.90), '#1d2022', { p: [0, 0.10, 0.84] });
  g.add('metal', box(0.055, 0.05, 0.90), '#1d2022', { p: [0, -0.50, 0.84] });
  g.add('lamp', box(0.005, 0.44, 0.68), '#e6dcc0', { p: [0.026, -0.20, 0.84] });
  return { d0: g.build(0.35), near: 80, far: 210, cast: true };
}

/** Storefront fascia sign, lit at night. */
function buildStoreFascia(hex) {
  const g = new GeoSet();
  g.add('rough', box(4.2, 0.66, 0.22), hex, { p: [0, 0, 0.11] });
  g.add('metal', box(4.3, 0.06, 0.28), '#2c2f31', { p: [0, 0.36, 0.13] });
  g.add('metal', box(4.3, 0.06, 0.28), '#2c2f31', { p: [0, -0.36, 0.13] });
  g.add('lamp', box(3.4, 0.30, 0.02), '#f2e6c8', { p: [0, 0.02, 0.23] });
  // Gooseneck lamps over the fascia
  for (const sx of [-1, 1]) {
    g.add('metal', cyl(0.018, 0.018, 0.40, 5), '#26292b', { p: [sx * 1.3, 0.52, 0.12], r: [-0.9, 0, 0] });
    g.add('paint', lathe([[0.11, 0], [0.115, 0.03], [0.06, 0.10], [0.03, 0.12]], 8), '#1f2224',
      { p: [sx * 1.3, 0.60, 0.34], r: [Math.PI, 0, 0] });
    g.add('lamp', cyl(0.09, 0.09, 0.01, 8), '#f4e9cf', { p: [sx * 1.3, 0.52, 0.34] });
  }
  return { d0: g.build(0.5), near: 120, far: 245, cast: true };
}

// ---------------------------------------------------------------------------

/**
 * Build every furniture type once.
 * @returns {Map<string, {d0, d1?, near, far, cast, receive}>}
 */
export function buildFurnitureLibrary() {
  const L = new Map();
  const put = (k, v) => L.set(k, v);

  put('lampAcorn', buildLampAcorn());
  put('lampTwin', buildLampTwin());
  put('lampCobra', buildLampCobra());
  put('trafficMastR', buildTrafficMast(false));
  put('trafficMastG', buildTrafficMast(true));
  put('pedSignal', buildPedSignal());
  put('signStop', buildStopSign());
  put('signOneWayL', buildOneWay(-1));
  put('signOneWayR', buildOneWay(1));
  put('signNoParking', buildPlateSign('noParking', 0.31, 0.46, 2.20,
    { name: 'resident', w: 0.31, h: 0.46, y: 1.70 }));
  put('signTowZone', buildPlateSign('towZone', 0.31, 0.46, 2.20));
  put('signHandicap', buildPlateSign('handicap', 0.31, 0.46, 2.20));
  put('signFireLane', buildPlateSign('fireLane', 0.31, 0.46, 2.15));
  put('signSpeed', buildPlateSign('speed25', 0.61, 0.76, 2.35));
  put('signDoNotEnter', buildPlateSign('doNotEnter', 0.60, 0.60, 2.25));
  put('signBlades02', buildStreetBlades(0, 2));
  put('signBlades13', buildStreetBlades(1, 3));
  put('parkingMeter', buildParkingMeter());
  put('payStation', buildPayStation());
  put('hydrantY', buildHydrant(C.hydrantYellow));
  put('hydrantR', buildHydrant('#8e1218'));
  put('mailbox', buildMailbox());
  put('newsBoxA', buildNewsBox('#8d2b2b'));
  put('newsBoxB', buildNewsBox('#1f5a7c'));
  put('bigBelly', buildBigBelly());
  put('wireBin', buildWireBin());
  put('bench', buildBench(false));
  put('benchPark', buildBench(true));
  put('bikeRack', buildBikeRack());
  put('bluebikes', buildBluebikes());
  put('bollard', buildBollard());
  put('utilityBoxA', buildUtilityBox('#8d918e'));
  put('utilityBoxB', buildUtilityBox('#4c5a52'));
  put('manhole', buildManhole());
  put('stormDrain', buildStormDrain());
  put('cone', buildCone());
  put('barrel', buildBarrel());
  put('jersey', buildJersey());
  put('scaffold', buildScaffold());
  put('skip', buildSkip());
  put('hoarding', buildHoarding());
  put('tempSignWork', buildTempSign('roadWork'));
  put('tempSignDetour', buildTempSign('detour'));
  put('busShelter', buildBusShelter());
  put('utilityPole', buildUtilityPole(false));
  put('utilityPoleTx', buildUtilityPole(true));
  put('treeGrate', buildTreeGrate());
  put('planter', buildPlanter());
  put('fireEscape', buildFireEscape());
  put('awningRed', buildAwning(C.fabricRed));
  put('awningGreen', buildAwning(C.fabricGreen));
  put('acUnit', buildACUnit());
  put('satDish', buildSatDish());
  put('standpipe', buildStandpipe());
  put('flagUS', buildFlag('#b22234', '#f0eee6', '#3c3b6e'));
  put('flagMA', buildFlag('#f0eee6', '#f0eee6', '#1a3a6b'));
  put('binBags', buildBinBags());
  put('snowBank', buildSnowBank());
  put('shopSignA', buildShopSign('#1e3a2e'));
  put('shopSignB', buildShopSign('#5c1f22'));
  put('storeFasciaA', buildStoreFascia('#26302c'));
  put('storeFasciaB', buildStoreFascia('#3a2622'));
  for (const [k, v] of buildParkedCars()) put(k, v);
  return L;
}


/**
 * Parked-car shells as [batchName, bodyLength], repeated in rough US fleet
 * proportion so a straight pick gives a believable mix. The length is read from
 * the vehicle's own spec rather than restated here, because the placer steps the
 * kerb by it and a wrong number either overlaps cars or leaves gaps.
 */
const PARKED_MIX = [
  ['carSedanA', 'sedan'], ['carSuvA', 'suv'], ['carSedanB', 'sedan'], ['carSuvB', 'suv'],
  ['carSedanC', 'sedan'], ['carSuvC', 'suv'], ['carSedanA', 'sedan'], ['carVanA', 'van'],
  ['carSedanB', 'sedan'], ['carSuvA', 'suv'], ['carPickupA', 'pickup'], ['carSedanC', 'sedan'],
  ['carSuvB', 'suv'], ['carSportsA', 'sports'], ['carSedanA', 'sedan'], ['carSuvC', 'suv'],
];
export const PARKED_CARS = PARKED_MIX.map(([n, t]) => [n, VEHICLE_SPECS[t]?.def?.L ?? 4.8]);

export { C as PROP_COLOURS };

/** Drop cached primitives once the library is built — they are all merged by then. */
export function clearGeoCache() {
  for (const g of _geoCache.values()) g.dispose();
  _geoCache.clear();
}
