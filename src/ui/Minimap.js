import { uiRoot, el, DISTRICT_NAMES } from './HUD.js';
import { yieldToPaint } from '../core/Yield.js';

/**
 * BOSTON minimap.
 *
 * The map is *rendered*, not a texture: road centrelines, water, parks and
 * building footprints are pulled out of the `city` contract into a flat,
 * spatially-indexed model (MapData) and drawn with Canvas2D.
 *
 * Per-frame cost is deliberately tiny. The expensive part — rasterising the
 * vector map — happens into an off-screen "patch" that covers ~1.45x the
 * visible radius, and is only re-baked when the player leaves that margin or
 * the zoom step changes. Every other frame is: one rotated drawImage, one
 * route polyline, a handful of blips and the ring.
 *
 * Everything degrades: with no `city` at all it synthesises the block lattice
 * the placeholder world actually contains, so the HUD is never blocked.
 */

const TAU = Math.PI * 2;

/* Map palette. Dark cartographic so it stays readable against a noon sky and
   doesn't glow in a night street. */
const C_LAND   = '#12161d';
const C_WATER  = '#0c1b2c';
const C_SHORE  = 'rgba(96,150,200,.30)';
const C_PARK   = '#16261b';
const C_BLOCK  = '#1e232c';
const C_BLOCK_E = 'rgba(0,0,0,.45)';
const C_CASE   = '#0a0d12';
const ROAD_FILL = ['#e8b552', '#5c6878', '#414a57', '#2f3742'];  // highway, arterial, street, alley
const ROAD_W    = [3.4, 2.6, 1.9, 1.3];                          // min px per class
const ROAD_HIDE = [99, 99, 4.4, 2.1];                            // hide class above this m/px
const CLS = { highway: 0, arterial: 1, street: 2, alley: 3 };

const C_ROUTE = '#3ea0ff';
const C_WAYPT = '#ff4fa3';

/* ------------------------------------------------------------------ utils --- */

function polyFrom(a) {
  if (!Array.isArray(a) || a.length < 3) return null;
  const f = new Float32Array(a.length * 2);
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    let x, z;
    if (Array.isArray(p)) { x = p[0]; z = p.length > 2 ? p[2] : p[1]; }
    else if (p && typeof p === 'object') { x = p.x; z = p.z != null ? p.z : p.y; }
    else return null;
    if (!isFinite(x) || !isFinite(z)) return null;
    f[i * 2] = x; f[i * 2 + 1] = z;
  }
  return f;
}

function collectPolys(src, out, depth = 0) {
  if (!src || depth > 2) return out;
  if (!Array.isArray(src)) {
    for (const k of ['polygons', 'polys', 'shapes', 'areas', 'outlines']) {
      if (src[k]) return collectPolys(src[k], out, depth + 1);
    }
    return out;
  }
  for (const item of src) {
    const p = polyFrom(item?.polygon || item?.points || item?.poly || item?.outline || item);
    if (p && p.length >= 6) out.push(wrap(p));
  }
  return out;
}

/** Wrap a point buffer with its bbox so the spatial index can use it. */
function wrap(pts, extra) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i]; if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < z0) z0 = pts[i + 1]; if (pts[i + 1] > z1) z1 = pts[i + 1];
  }
  const o = extra || {};
  o.pts = pts; o.x0 = x0; o.z0 = z0; o.x1 = x1; o.z1 = z1;
  return o;
}

/** Uniform-grid index over anything carrying a bbox. Query allocates nothing. */
class Layer {
  constructor(items, cell = 260) {
    this.items = items; this.cell = cell;
    this.map = new Map();
    this.stamp = new Int32Array(items.length);
    this.q = 0; this.out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const cx0 = Math.floor(it.x0 / cell), cx1 = Math.floor(it.x1 / cell);
      const cz0 = Math.floor(it.z0 / cell), cz1 = Math.floor(it.z1 / cell);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cx * 16384 + cz;
          let a = this.map.get(k);
          if (!a) this.map.set(k, a = []);
          a.push(i);
        }
      }
    }
  }
  query(x0, z0, x1, z1) {
    const out = this.out; out.length = 0;
    if (!this.items.length) return out;
    const q = ++this.q, c = this.cell;
    const cx0 = Math.floor(x0 / c), cx1 = Math.floor(x1 / c);
    const cz0 = Math.floor(z0 / c), cz1 = Math.floor(z1 / c);
    // A pathological zoom-out would sweep the whole grid; just take everything.
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 4096) return this.items;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const a = this.map.get(cx * 16384 + cz);
        if (!a) continue;
        for (let j = 0; j < a.length; j++) {
          const i = a[j];
          if (this.stamp[i] === q) continue;
          this.stamp[i] = q; out.push(this.items[i]);
        }
      }
    }
    return out;
  }
}

/** Minimal binary heap for A*. */
class Heap {
  constructor() { this.a = []; this.f = []; }
  push(v, f) {
    const a = this.a, k = this.f;
    a.push(v); k.push(f);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]]; [k[p], k[i]] = [k[i], k[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, k = this.f;
    const top = a[0];
    const lv = a.pop(), lk = k.pop();
    if (a.length) {
      a[0] = lv; k[0] = lk;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [k[m], k[i]] = [k[i], k[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/* ---------------------------------------------------------------- MapData --- */

export class MapData {
  constructor() {
    this.roads = [];
    this.water = [];
    this.parks = [];
    this.blocks = [];
    this.bounds = { x0: -3000, z0: -3000, x1: 3000, z1: 3000 };
    this.districts = [];        // { id, name, x, z } label anchors
    this.synthetic = true;
    this.ready = false;
    this.clsW = [22, 16, 11, 6];  // metres, per road class
    this.rWater = null;           // fallback rasters when no polygons exist
    this.rPark = null;
    this._edgeById = new Map();
    this._adj = null;
    this._nodes = null;
    this._scan = { x0: 0, z0: 0, x1: 0, z1: 0 };
  }

  /**
   * Build the model from the `city` contract. Cheap parts run synchronously;
   * the district raster fallback continues in the background.
   * @param {object|null} city
   */
  build(city) {
    try { this._fromCity(city); }
    catch (e) { console.warn('[minimap] city parse failed, using lattice fallback:', e?.message || e); }
    if (!this.roads.length) this._lattice();
    this.roadLayer = new Layer(this.roads, 260);
    this.blockLayer = new Layer(this.blocks, 260);
    // One stable width per road class (median of the real data) so strokes
    // don't shimmer as different edges scroll in and out of view.
    for (let c = 0; c < 4; c++) {
      const ws = [];
      for (const r of this.roads) if (r.cls === c && r.w > 0) ws.push(r.w);
      if (ws.length) { ws.sort((a, b) => a - b); this.clsW[c] = ws[ws.length >> 1]; }
    }
    this.ready = true;
    return this;
  }

  /** @param {string} id @returns {string} the street name for a road edge id. */
  edgeName(id) { return this._edgeById.get(id)?.name || ''; }

  _fromCity(city) {
    if (!city) return;
    if (city.bounds) Object.assign(this.bounds, city.bounds);

    const roads = city.roads;
    if (roads?.edges?.length && roads?.nodes?.length) {
      this.synthetic = false;
      const nodes = new Map();
      for (const n of roads.nodes) nodes.set(n.id, n);
      this._nodes = nodes;
      const canSample = typeof roads.sample === 'function';
      for (const e of roads.edges) {
        const a = nodes.get(e.a), b = nodes.get(e.b);
        if (!a || !b) continue;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        let pts = null;
        if (canSample && len > 24) {
          const k = Math.min(14, Math.max(2, Math.round(len / 30)));
          const buf = new Float32Array((k + 1) * 2);
          let ok = true;
          for (let i = 0; i <= k; i++) {
            const s = roads.sample(e.id, i / k);
            if (!s || !isFinite(s.x) || !isFinite(s.z)) { ok = false; break; }
            buf[i * 2] = s.x; buf[i * 2 + 1] = s.z;
          }
          if (ok) pts = buf;
        }
        if (!pts) pts = new Float32Array([a.x, a.z, b.x, b.z]);
        const item = wrap(pts, {
          cls: CLS[e.type] != null ? CLS[e.type] : 2,
          w: e.width || (e.lanes || 2) * 3.5,
          name: e.name || '', id: e.id, oneway: !!e.oneway, a: e.a, b: e.b,
        });
        this.roads.push(item);
        this._edgeById.set(e.id, item);
      }
    }

    // Building footprints + park plots.
    if (Array.isArray(city.plots)) {
      for (const p of city.plots) {
        const pts = polyFrom(p.polygon || p.points);
        if (!pts || pts.length < 6) continue;
        const isPark = p.zoning === 'park' || p.district === 'park' || p.zoning === 'green';
        (isPark ? this.parks : this.blocks).push(wrap(pts));
      }
    }

    collectPolys(city.water, this.water);
    collectPolys(city.waterPolys || city.waterPolygons, this.water);
    collectPolys(city.parks || city.parkPolys, this.parks);

    // District label anchors from plot centroids.
    if (Array.isArray(city.plots) && city.plots.length) {
      const acc = new Map();
      for (const p of city.plots) {
        if (!p.district || p.district === 'water') continue;
        const pts = polyFrom(p.polygon || p.points);
        if (!pts) continue;
        let cx = 0, cz = 0;
        for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; }
        const n = pts.length / 2;
        let a = acc.get(p.district);
        if (!a) acc.set(p.district, a = { x: 0, z: 0, n: 0 });
        a.x += cx / n; a.z += cz / n; a.n++;
      }
      for (const [id, a] of acc) {
        this.districts.push({ id, name: DISTRICT_NAMES[id] || id, x: a.x / a.n, z: a.z / a.n });
      }
    }
  }

  /**
   * Fallback for a city that exposes districtAt() but no water/park polygons:
   * probe the district function on a 15 m grid and keep the result as two
   * pre-tinted masks. Runs in slices with a yield between them so boot never
   * hitches, and doubles as the source of district label anchors.
   * @param {object} city
   */
  async bakeRaster(city) {
    if (this.water.length || this.parks.length) return;
    if (typeof city?.districtAt !== 'function') return;
    const N = 396;
    const b = this.bounds;
    const spanX = b.x1 - b.x0, spanZ = b.z1 - b.z0;
    const wImg = new ImageData(N, N), pImg = new ImageData(N, N);
    const acc = new Map();
    for (let row = 0; row < N; row += 12) {
      const end = Math.min(N, row + 12);
      for (let j = row; j < end; j++) {
        const z = b.z0 + (j + 0.5) / N * spanZ;
        for (let i = 0; i < N; i++) {
          const x = b.x0 + (i + 0.5) / N * spanX;
          let d;
          try { d = city.districtAt(x, z); } catch { d = null; }
          const o = (j * N + i) * 4;
          if (d === 'water') { wImg.data[o] = 12; wImg.data[o + 1] = 27; wImg.data[o + 2] = 44; wImg.data[o + 3] = 255; }
          else if (d === 'park') { pImg.data[o] = 22; pImg.data[o + 1] = 38; pImg.data[o + 2] = 27; pImg.data[o + 3] = 255; }
          if (d && d !== 'water') {
            let a = acc.get(d);
            if (!a) acc.set(d, a = { x: 0, z: 0, n: 0 });
            a.x += x; a.z += z; a.n++;
          }
        }
      }
      // Not `setTimeout`: 396/12 = 33 yields, and a hidden tab clamps timers to
      // >=1/s, so the background bake took over half a minute of wall clock and
      // woke the tab 33 times. See `src/core/Yield.js`.
      await yieldToPaint();
    }
    this.rWater = toCanvas(wImg);
    this.rPark = toCanvas(pImg);
    if (!this.districts.length) {
      for (const [id, a] of acc) {
        if (a.n < 60) continue;
        this.districts.push({ id, name: DISTRICT_NAMES[id] || id, x: a.x / a.n, z: a.z / a.n });
      }
    }
  }

  /** The placeholder world is a 90 m block lattice — draw exactly that. */
  _lattice() {
    const S = 90, N = 14, HALF = S * N + S * 0.5;
    for (let k = -N; k <= N; k++) {
      const p = k * S + S * 0.5;
      const cls = (k % 4 === 0) ? 1 : 2;
      const w = cls === 1 ? 16 : 11;
      this.roads.push(wrap(new Float32Array([-HALF, p, HALF, p]), { cls, w, name: '', id: 'h' + k }));
      this.roads.push(wrap(new Float32Array([p, -HALF, p, HALF]), { cls, w, name: '', id: 'v' + k }));
    }
    for (let x = -N; x <= N; x++) {
      for (let z = -N; z <= N; z++) {
        if (Math.abs(x) < 2 && Math.abs(z) < 2) continue;
        const cx = x * S, cz = z * S, h = 26;
        this.blocks.push(wrap(new Float32Array([cx - h, cz - h, cx + h, cz - h, cx + h, cz + h, cx - h, cz + h])));
      }
    }
    const g = 132;
    this.parks.push(wrap(new Float32Array([-g, -g, g, -g, g, g, -g, g])));
    this.districts.push({ id: 'park', name: 'The Common', x: 0, z: 0 });
    this.synthetic = true;
  }

  /* ------------------------------------------------------------- drawing --- */

  /**
   * Rasterise the map into a 2D context.
   * @param {CanvasRenderingContext2D} g
   * @param {{cx:number,cz:number,mppx:number,w:number,h:number,rot?:number,names?:boolean}} v
   */
  draw(g, v) {
    const { cx, cz, mppx, w, h } = v;
    const rot = v.rot || 0;
    g.save();
    g.fillStyle = C_LAND;
    g.fillRect(0, 0, w, h);

    g.translate(w / 2, h / 2);
    if (rot) g.rotate(-rot);
    g.scale(1 / mppx, 1 / mppx);
    g.translate(-cx, -cz);

    // Visible world box (padded for rotation).
    const rad = Math.hypot(w, h) * 0.5 * mppx * (rot ? 1.02 : 1) + 40;
    const s = this._scan;
    s.x0 = cx - rad; s.z0 = cz - rad; s.x1 = cx + rad; s.z1 = cz + rad;

    if (this.rWater || this.rPark) {
      const b = this.bounds, bw = b.x1 - b.x0, bh = b.z1 - b.z0;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      if (this.rWater) g.drawImage(this.rWater, b.x0, b.z0, bw, bh);
      if (this.rPark) g.drawImage(this.rPark, b.x0, b.z0, bw, bh);
    }

    g.lineJoin = 'round'; g.lineCap = 'round';

    if (this.water.length) {
      g.fillStyle = C_WATER;
      g.beginPath();
      for (let i = 0; i < this.water.length; i++) {
        const p = this.water[i];
        if (p.x1 < s.x0 || p.x0 > s.x1 || p.z1 < s.z0 || p.z0 > s.z1) continue;
        this._path(g, p.pts);
      }
      g.fill('evenodd');
      g.lineWidth = 1.4 * mppx; g.strokeStyle = C_SHORE; g.stroke();
    }
    if (this.parks.length) {
      g.fillStyle = C_PARK;
      g.beginPath();
      for (let i = 0; i < this.parks.length; i++) {
        const p = this.parks[i];
        if (p.x1 < s.x0 || p.x0 > s.x1 || p.z1 < s.z0 || p.z0 > s.z1) continue;
        this._path(g, p.pts);
      }
      g.fill('evenodd');
    }

    if (mppx < 3.2 && this.blocks.length) {
      const list = this.blockLayer.query(s.x0, s.z0, s.x1, s.z1);
      g.beginPath();
      for (let i = 0; i < list.length; i++) this._path(g, list[i].pts);
      g.fillStyle = C_BLOCK; g.fill();
      if (mppx < 1.4) { g.lineWidth = 0.9 * mppx; g.strokeStyle = C_BLOCK_E; g.stroke(); }
    }

    const roads = this.roadLayer.query(s.x0, s.z0, s.x1, s.z1);
    // Casing pass (all classes at once), then fills back-to-front by class.
    for (let pass = 0; pass < 2; pass++) {
      for (let cls = 3; cls >= 0; cls--) {
        if (mppx > ROAD_HIDE[cls]) continue;
        let started = false;
        for (let i = 0; i < roads.length; i++) {
          const r = roads[i];
          if (r.cls !== cls) continue;
          if (!started) { g.beginPath(); started = true; }
          this._line(g, r.pts);
        }
        if (!started) continue;
        const wpx = Math.max(ROAD_W[cls], Math.min(46, this.clsW[cls] / mppx));
        if (pass === 0) { g.lineWidth = (wpx + 1.8) * mppx; g.strokeStyle = C_CASE; }
        else { g.lineWidth = wpx * mppx; g.strokeStyle = ROAD_FILL[cls]; }
        g.stroke();
      }
    }
    g.restore();
  }

  _path(g, p) {
    g.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
    g.closePath();
  }
  _line(g, p) {
    g.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
  }

  /* ---------------------------------------------------------------- graph --- */

  _adjacency() {
    if (this._adj) return this._adj;
    const adj = new Map();
    for (const r of this.roads) {
      if (r.a == null || r.b == null) continue;
      let len = 0;
      for (let i = 2; i < r.pts.length; i += 2) {
        len += Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
      }
      const cost = len * (r.cls === 0 ? 0.68 : r.cls === 1 ? 0.85 : 1);
      if (!adj.has(r.a)) adj.set(r.a, []);
      adj.get(r.a).push({ to: r.b, e: r, cost, fwd: true });
      if (!r.oneway) {
        if (!adj.has(r.b)) adj.set(r.b, []);
        adj.get(r.b).push({ to: r.a, e: r, cost, fwd: false });
      }
    }
    this._adj = adj;
    return adj;
  }

  _nearestNode(x, z) {
    if (!this._nodes) return null;
    let best = null, bd = Infinity;
    for (const n of this._nodes.values()) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /**
   * A* along the real road graph.
   * @returns {Float32Array|null} flat [x,z,...] polyline, or null when there's no graph.
   */
  route(fromX, fromZ, toX, toZ) {
    if (this.synthetic || !this._nodes || !this._nodes.size) return null;
    const a = this._nearestNode(fromX, fromZ), b = this._nearestNode(toX, toZ);
    if (!a || !b || a.id === b.id) return null;
    const adj = this._adjacency();
    const gScore = new Map([[a.id, 0]]);
    const came = new Map();
    const open = new Heap();
    const hh = (n) => Math.hypot(n.x - b.x, n.z - b.z);
    open.push(a.id, hh(a));
    const closed = new Set();
    let guard = 0;
    while (open.size && guard++ < 60000) {
      const cur = open.pop();
      if (cur === b.id) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      const links = adj.get(cur);
      if (!links) continue;
      const gc = gScore.get(cur) ?? Infinity;
      for (const l of links) {
        const ng = gc + l.cost;
        if (ng >= (gScore.get(l.to) ?? Infinity)) continue;
        gScore.set(l.to, ng);
        came.set(l.to, { from: cur, link: l });
        const n = this._nodes.get(l.to);
        open.push(l.to, ng + (n ? Math.hypot(n.x - b.x, n.z - b.z) : 0));
      }
    }
    if (!came.has(b.id)) return null;
    const chain = [];
    let cur = b.id;
    while (cur !== a.id) {
      const step = came.get(cur);
      if (!step) return null;
      chain.push(step.link);
      cur = step.from;
    }
    chain.reverse();
    const out = [];
    for (const l of chain) {
      const p = l.e.pts;
      if (l.fwd) for (let i = 0; i < p.length; i += 2) out.push(p[i], p[i + 1]);
      else for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
    }
    return new Float32Array(out);
  }
}

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

/* ---------------------------------------------------------------- system --- */

export default class Minimap {
  static id = 'minimap';
  static label = 'Minimap';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.root = uiRoot();
    this.wrap = el('div', 'mm', this.root);
    this.cv = el('canvas', null, this.wrap);
    this.g = this.cv.getContext('2d');

    this.northLock = false;
    this.blips = [];
    this.waypoint = null;
    this.routePts = null;
    this._routeT = 0;
    this._routeKey = '';
    this._heading = 0;
    this._viewR = 105;
    this._speed = 0;
    this._prevX = 0; this._prevZ = 0; this._hasPrev = false;
    this._patchOK = false;
    this._pc = { x: 0, z: 0, ph: 0 };
    this._view = { cx: 0, cz: 0, mppx: 1, w: 0, h: 0, rot: 0 };
    this._blipId = 1;

    this.map = new MapData();
    const city = ctx.get('city');
    this.map.build(city);
    // Coastline fallback continues in the background — never blocks boot.
    this.map.bakeRaster(city).then(() => { this._patchOK = false; }).catch(() => {});

    this._resize();
    this._off = [
      ctx.bus.on('resize', () => this._resize()),
      ctx.bus.on('key:down', (c) => { if (c === 'KeyN') this.setNorthLock(!this.northLock); }),
      ctx.bus.on('map:waypoint', (w) => (w ? this.setWaypoint(w.x, w.z) : this.clearWaypoint())),
      ctx.bus.on('map:blip', (b) => this.addBlip(b)),
      ctx.bus.on('map:removeBlip', (id) => this.removeBlip(id)),
      ctx.bus.on('map:northLock', (v) => this.setNorthLock(!!v)),
    ];
    this._onScale = () => this._resize();
    this.root.addEventListener('ui:scale', this._onScale);
    requestAnimationFrame(() => this.wrap.classList.add('on'));
    window.__minimap = this;
  }

  /* ------------------------------------------------------------ public API --- */

  /** @param {{x:number,z:number,kind?:string,colour?:string,label?:string,scale?:number}} b */
  addBlip(b) {
    if (!b || !isFinite(b.x) || !isFinite(b.z)) return null;
    const id = b.id != null ? b.id : 'b' + this._blipId++;
    this.removeBlip(id);
    this.blips.push({ id, x: b.x, z: b.z, kind: b.kind || 'mission', colour: b.colour, label: b.label, scale: b.scale || 1, edge: b.edge !== false });
    return id;
  }
  removeBlip(id) {
    const i = this.blips.findIndex(b => b.id === id);
    if (i >= 0) this.blips.splice(i, 1);
  }
  setWaypoint(x, z) {
    this.waypoint = { x, z };
    this._routeT = 0; this._routeKey = '';
    this.ctx.bus.emit('map:waypointSet', this.waypoint);
  }
  clearWaypoint() {
    this.waypoint = null; this.routePts = null; this._routeKey = '';
    this.ctx.bus.emit('map:waypointSet', null);
  }
  setNorthLock(v) {
    this.northLock = !!v;
    this._patchOK = false;
    this.ctx.bus.emit('hud:notify', { kind: 'info', title: 'Minimap', text: v ? 'North locked' : 'Rotating with heading', duration: 2.4 });
  }

  /* ---------------------------------------------------------------- sizing --- */

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.wrap.getBoundingClientRect();
    const size = Math.max(64, Math.round(r.width));
    if (this._size === size && this._dpr === dpr) return;
    this._size = size; this._dpr = dpr;
    this.cv.width = Math.round(size * dpr);
    this.cv.height = Math.round(size * dpr);
    this.Rm = size * 0.437;                       // map disc radius, CSS px
    const pp = Math.ceil(2 * 1.45 * this.Rm * dpr);
    if (!this.patch) { this.patch = document.createElement('canvas'); }
    this.patch.width = this.patch.height = pp;
    this.pg = this.patch.getContext('2d');
    this._patchOK = false;
  }

  /* ------------------------------------------------------------------ loop --- */

  update(dt, ctx) {
    if (!this._size) return;
    const pl = ctx.get('player');
    const pos = pl?.position || ctx.camera.position;
    const px = pos.x, pz = pos.z;
    if (!isFinite(px) || !isFinite(pz)) return;

    // Heading: prefer the vehicle/player facing, else the camera.
    const cam = ctx.camera;
    const e = cam.matrixWorld.elements;
    // -Z column of the camera basis = forward.
    const fx = -e[8], fz = -e[10];
    let head = Math.atan2(fx, -fz);
    if (pl && typeof pl.heading === 'number') head = pl.heading;
    // Shortest-arc smoothing so the map doesn't spin the long way round.
    let d = head - this._heading;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this._heading += d * Math.min(1, dt * 12);

    // Speed drives the zoom, the way every driving HUD does it.
    if (this._hasPrev && dt > 0) {
      const inst = Math.hypot(px - this._prevX, pz - this._prevZ) / dt;
      this._speed += (Math.min(inst, 90) - this._speed) * Math.min(1, dt * 2.2);
    }
    this._prevX = px; this._prevZ = pz; this._hasPrev = true;
    const targetR = Math.max(72, Math.min(330, 88 + this._speed * 3.4));
    this._viewR += (targetR - this._viewR) * Math.min(1, dt * 1.6);

    this._routeT -= dt;
    if (this._routeT <= 0) { this._routeT = 1.5; this._updateRoute(px, pz); }

    this._drawFrame(px, pz, ctx);
  }

  _updateRoute(px, pz) {
    if (!this.waypoint) { this.routePts = null; return; }
    const key = `${(px / 60) | 0},${(pz / 60) | 0},${this.waypoint.x | 0},${this.waypoint.z | 0}`;
    if (key === this._routeKey) return;
    this._routeKey = key;
    try { this.routePts = this.map.route(px, pz, this.waypoint.x, this.waypoint.z); }
    catch { this.routePts = null; }
  }

  _bakePatch(px, pz) {
    const R = this.Rm, dpr = this._dpr;
    const ph = this._viewR * 1.45;
    const pp = this.patch.width;
    const g = this.pg;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pp, pp);
    const v = this._view;
    v.cx = px; v.cz = pz; v.w = pp; v.h = pp; v.rot = 0;
    v.mppx = (2 * ph) / pp;
    this.map.draw(g, v);
    this._pc.x = px; this._pc.z = pz; this._pc.ph = ph;
    this._patchOK = true;
    void R; void dpr;
  }

  _drawFrame(px, pz, ctx) {
    const g = this.g, dpr = this._dpr, S = this._size, C = S / 2, R = this.Rm;
    const rot = this.northLock ? 0 : this._heading;
    const viewR = this._viewR;
    const mppx = viewR / R;

    // Re-bake only when we've eaten the margin or the zoom has drifted.
    const pc = this._pc;
    const moved = Math.hypot(px - pc.x, pz - pc.z);
    if (!this._patchOK || moved > pc.ph - viewR - 2 || Math.abs(pc.ph - viewR * 1.45) > viewR * 0.16) {
      this._bakePatch(px, pz);
    }

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);

    g.save();
    g.beginPath(); g.arc(C, C, R, 0, TAU); g.clip();
    g.fillStyle = C_LAND; g.fillRect(0, 0, S, S);

    g.save();
    g.translate(C, C);
    if (rot) g.rotate(-rot);
    g.scale(1 / mppx, 1 / mppx);
    g.translate(-px, -pz);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.patch, pc.x - pc.ph, pc.z - pc.ph, pc.ph * 2, pc.ph * 2);

    // GPS route, in world space so it sits exactly on the road centreline.
    if (this.routePts && this.routePts.length > 3) {
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      const p = this.routePts;
      g.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 6.5 * mppx; g.stroke();
      g.strokeStyle = C_ROUTE; g.lineWidth = 4.0 * mppx; g.stroke();
      g.strokeStyle = 'rgba(190,225,255,.85)'; g.lineWidth = 1.4 * mppx; g.stroke();
    } else if (this.waypoint) {
      // No road graph: the honest fallback is a straight bearing line.
      g.setLineDash([7 * mppx, 6 * mppx]);
      g.beginPath(); g.moveTo(px, pz); g.lineTo(this.waypoint.x, this.waypoint.z);
      g.strokeStyle = 'rgba(255,79,163,.75)'; g.lineWidth = 2.4 * mppx; g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    // Inner shading: darkens the rim so blips and the arrow always separate.
    const vg = g.createRadialGradient(C, C, R * 0.55, C, C, R);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = vg; g.fillRect(0, 0, S, S);

    this._drawBlips(g, px, pz, rot, mppx, C, R, ctx);
    g.restore();

    this._drawRing(g, C, R, rot, ctx);
    this._drawArrow(g, C, R, rot);
  }

  _blipScreen(bx, bz, px, pz, rot, mppx, C) {
    const dx = (bx - px) / mppx, dz = (bz - pz) / mppx;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    _bs.x = C + dx * c - dz * s;
    _bs.y = C + dx * s + dz * c;
    return _bs;
  }

  _drawBlips(g, px, pz, rot, mppx, C, R, ctx) {
    // Live traffic, capped — enough to read as a living city, not a particle sim.
    const traffic = ctx.get('traffic');
    if (traffic?.vehicles?.length) {
      const list = traffic.vehicles;
      const n = Math.min(list.length, 90);
      g.save();
      for (let i = 0; i < n; i++) {
        const v = list[i];
        const p = v?.position || v?.mesh?.position;
        if (!p) continue;
        if (Math.abs(p.x - px) > this._viewR * 1.3 || Math.abs(p.z - pz) > this._viewR * 1.3) continue;
        const s = this._blipScreen(p.x, p.z, px, pz, rot, mppx, C);
        if (Math.hypot(s.x - C, s.y - C) > R - 3) continue;
        g.fillStyle = v.type === 'police' ? '#66a6ff' : 'rgba(228,236,244,.75)';
        g.fillRect(s.x - 1.6, s.y - 1.6, 3.2, 3.2);
      }
      g.restore();
    }

    for (const b of this.blips) this._drawBlip(g, b, px, pz, rot, mppx, C, R);
    if (this.waypoint) {
      this._drawBlip(g, { x: this.waypoint.x, z: this.waypoint.z, kind: 'waypoint', edge: true },
        px, pz, rot, mppx, C, R);
    }
  }

  _drawBlip(g, b, px, pz, rot, mppx, C, R) {
    const s = this._blipScreen(b.x, b.z, px, pz, rot, mppx, C);
    let x = s.x, y = s.y, clamped = false;
    const d = Math.hypot(x - C, y - C);
    const lim = R - 8;
    if (d > lim) {
      if (!b.edge) return;
      x = C + (x - C) / d * lim; y = C + (y - C) / d * lim; clamped = true;
    }
    const col = b.colour || (b.kind === 'waypoint' ? C_WAYPT : b.kind === 'police' ? '#66a6ff' : '#ffc247');
    const sc = (b.scale || 1) * (clamped ? 0.85 : 1);
    g.save();
    g.translate(x, y);
    g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 4;
    if (clamped) {
      const a = Math.atan2(y - C, x - C);
      g.rotate(a + Math.PI / 2);
      g.beginPath(); g.moveTo(0, 5.5 * sc); g.lineTo(-4.6 * sc, -3.4 * sc); g.lineTo(4.6 * sc, -3.4 * sc);
      g.closePath();
      g.fillStyle = col; g.fill();
      g.lineWidth = 1.1; g.strokeStyle = 'rgba(0,0,0,.7)'; g.stroke();
    } else if (b.kind === 'waypoint') {
      g.beginPath();
      g.moveTo(0, 8.5 * sc); g.lineTo(-5 * sc, -1.5 * sc); g.lineTo(0, -8.5 * sc); g.lineTo(5 * sc, -1.5 * sc);
      g.closePath();
      g.fillStyle = col; g.fill();
      g.lineWidth = 1.2; g.strokeStyle = 'rgba(0,0,0,.8)'; g.stroke();
    } else {
      g.beginPath(); g.arc(0, 0, 4.6 * sc, 0, TAU);
      g.fillStyle = col; g.fill();
      g.lineWidth = 1.4; g.strokeStyle = 'rgba(0,0,0,.75)'; g.stroke();
      g.beginPath(); g.arc(0, 0, 1.7 * sc, 0, TAU);
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fill();
    }
    g.restore();
  }

  _drawRing(g, C, R, rot, ctx) {
    const hud = ctx.get('hud');
    const vit = hud?.vitals;

    // Bezel: a dark machined ring with a light top edge.
    g.save();
    g.lineWidth = 3.2;
    g.strokeStyle = 'rgba(6,9,14,.92)';
    g.beginPath(); g.arc(C, C, R + 1.6, 0, TAU); g.stroke();
    g.lineWidth = 1.1;
    const bg = g.createLinearGradient(0, C - R, 0, C + R);
    bg.addColorStop(0, 'rgba(255,255,255,.30)');
    bg.addColorStop(0.5, 'rgba(255,255,255,.10)');
    bg.addColorStop(1, 'rgba(255,255,255,.04)');
    g.strokeStyle = bg;
    g.beginPath(); g.arc(C, C, R + 3.4, 0, TAU); g.stroke();

    // Health (bottom-left) and armour (bottom-right) grow out from due south.
    const ar = R + 6.2;
    g.lineCap = 'round';
    g.lineWidth = 3.4;
    const gap = 0.045;
    g.strokeStyle = 'rgba(255,255,255,.10)';
    g.beginPath(); g.arc(C, C, ar, Math.PI / 2 + gap, Math.PI); g.stroke();
    g.beginPath(); g.arc(C, C, ar, 0, Math.PI / 2 - gap); g.stroke();

    const hp = vit ? vit.health : 1;
    const av = vit ? vit.armour : 0;
    if (hp > 0.001) {
      g.strokeStyle = hp < 0.26 ? '#ff5647' : '#63dd93';
      g.shadowColor = hp < 0.26 ? 'rgba(255,86,71,.8)' : 'rgba(99,221,147,.55)';
      g.shadowBlur = 5;
      g.beginPath();
      g.arc(C, C, ar, Math.PI / 2 + gap, Math.PI / 2 + gap + hp * (Math.PI / 2 - gap));
      g.stroke();
      g.shadowBlur = 0;
    }
    if (av > 0.001) {
      g.strokeStyle = '#5db4ff';
      g.shadowColor = 'rgba(93,180,255,.55)'; g.shadowBlur = 5;
      g.beginPath();
      g.arc(C, C, ar, Math.PI / 2 - gap - av * (Math.PI / 2 - gap), Math.PI / 2 - gap);
      g.stroke();
      g.shadowBlur = 0;
    }
    const st = vit ? vit.stamina : 1;
    if (st < 0.995) {
      g.lineWidth = 1.9;
      g.strokeStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.arc(C, C, ar + 4.2, Math.PI, TAU); g.stroke();
      g.strokeStyle = '#ffd166';
      g.beginPath(); g.arc(C, C, ar + 4.2, Math.PI, Math.PI + st * Math.PI); g.stroke();
    }

    // North indicator — rides the ring, letter stays upright.
    const na = -Math.PI / 2 - rot;
    const nx = C + Math.cos(na) * (R + 3.4), ny = C + Math.sin(na) * (R + 3.4);
    g.save();
    g.translate(nx, ny); g.rotate(na + Math.PI / 2);
    g.beginPath(); g.moveTo(0, -5.4); g.lineTo(-3.6, 2.2); g.lineTo(3.6, 2.2); g.closePath();
    g.fillStyle = '#ff5647'; g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 3; g.fill();
    g.restore();
    g.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 3;
    g.fillText('N', C + Math.cos(na) * (R + 12), C + Math.sin(na) * (R + 12));
    g.restore();
  }

  _drawArrow(g, C, R, rot) {
    const a = this.northLock ? this._heading : 0;
    g.save();
    g.translate(C, C); g.rotate(a);
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 5;
    g.beginPath();
    g.moveTo(0, -8.6); g.lineTo(6.2, 7.4); g.lineTo(0, 3.6); g.lineTo(-6.2, 7.4);
    g.closePath();
    g.fillStyle = '#ffffff'; g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 1.3; g.strokeStyle = 'rgba(10,14,20,.9)'; g.stroke();
    g.beginPath();
    g.moveTo(0, -4.4); g.lineTo(3.0, 4.4); g.lineTo(0, 2.6); g.lineTo(-3.0, 4.4);
    g.closePath();
    g.fillStyle = '#ffc247'; g.fill();
    g.restore();
    void R; void rot;
  }

  dispose() {
    this._off?.forEach(f => f());
    this.root?.removeEventListener('ui:scale', this._onScale);
    this.wrap?.remove();
    if (window.__minimap === this) delete window.__minimap;
  }
}

const _bs = { x: 0, y: 0 };
