import * as THREE from 'three';
import { geo } from '../core/Geo.js';
import { RNG, getPropMaterials, buildFurnitureLibrary, clearGeoCache } from './StreetFurniture.js';
import Decals from './Decals.js';

/**
 * Props — everything bolted to, dropped on, strung over or left lying in a
 * Boston street.
 *
 * Design constraints, in priority order:
 *  1. Density. An empty street reads as fake instantly. This system places tens
 *     of thousands of objects.
 *  2. Draw calls. Tens of thousands of objects must cost ~100 draws, so every
 *     type is a single merged geometry drawn with InstancedMesh, spatially
 *     chunked, and packed into per-LOD contiguous instance ranges.
 *  3. Never block on another agent. The city road graph may not exist yet, so a
 *     synthesised grid stands in and the whole system rebuilds automatically the
 *     moment `city.roads` appears.
 *
 * Nothing here allocates in update(). The per-LOD instance buffers are packed
 * only when the camera crosses a chunk boundary, and that work is spread over
 * frames.
 */

/** Spatial chunk edge, metres. Also the granularity of LOD selection. */
export const CHUNK = 96;
const CHUNK_R = CHUNK * 0.7072;   // half-diagonal, for conservative chunk distance

const _pos = new THREE.Vector3();
const _qt = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _sc = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _camPos = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Instanced, chunked, LOD'd batch
// ---------------------------------------------------------------------------

export class PropBatch {
  /**
   * @param {string} name
   * @param {Array<{geometry:THREE.BufferGeometry, materials:THREE.Material|THREE.Material[],
   *                dist:number, cast:boolean}>} lods near-to-far; `dist` is the
   *        maximum camera distance at which that level is used. Past the last
   *        level's `dist` the instance is not drawn at all.
   * @param {{receive?:boolean}} [opts]
   */
  constructor(name, lods, opts = {}) {
    this.name = name;
    this.lods = lods;
    this.receive = opts.receive !== false;
    this.items = [];
    this.meshes = [];
    this.chunks = null;
    this.mats = null;
    this.cols = null;
    this._counts = [];
  }

  /** @param {number} tint per-instance brightness multiplier (weathering variety) */
  add(x, y, z, ry = 0, s = 1, tint = 1, tiltX = 0, tiltZ = 0) {
    this.items.push({ x, y, z, ry, s, tint, tiltX, tiltZ });
    return this;
  }

  get count() { return this.items.length; }

  build(scene) {
    const n = this.items.length;
    if (!n) return 0;

    // Bucket by chunk, then flatten so each chunk's instances are contiguous.
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const cx = Math.floor(it.x / CHUNK), cz = Math.floor(it.z / CHUNK);
      const key = (cx + 512) * 1024 + (cz + 512);
      let b = buckets.get(key);
      if (!b) buckets.set(key, b = { cx, cz, idx: [] });
      b.idx.push(i);
    }

    this.mats = new Float32Array(n * 16);
    this.cols = new Float32Array(n * 3);
    this.chunks = [];
    let w = 0;
    for (const b of buckets.values()) {
      const start = w;
      for (const i of b.idx) {
        const it = this.items[i];
        _pos.set(it.x, it.y, it.z);
        _eu.set(it.tiltX, it.ry, it.tiltZ, 'YXZ');
        _qt.setFromEuler(_eu);
        _sc.setScalar(it.s);
        _m4.compose(_pos, _qt, _sc);
        _m4.toArray(this.mats, w * 16);
        this.cols[w * 3] = this.cols[w * 3 + 1] = this.cols[w * 3 + 2] = it.tint;
        if (it.tintColor) {
          this.cols[w * 3] = it.tintColor[0];
          this.cols[w * 3 + 1] = it.tintColor[1];
          this.cols[w * 3 + 2] = it.tintColor[2];
        }
        w++;
      }
      this.chunks.push({
        cx: b.cx, cz: b.cz, start, count: w - start,
        wx: b.cx * CHUNK + CHUNK / 2, wz: b.cz * CHUNK + CHUNK / 2,
      });
    }

    for (let li = 0; li < this.lods.length; li++) {
      const lod = this.lods[li];
      const m = new THREE.InstancedMesh(lod.geometry, lod.materials, n);
      m.name = `prop:${this.name}:${li}`;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = lod.cast !== false && li === 0;
      m.receiveShadow = this.receive;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.count = 0;
      m.visible = false;
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), -1);
      // Conservative per-instance radius about the instance origin.
      const bs = lod.geometry.boundingSphere;
      m._radius = bs ? (bs.center.length() + bs.radius) * 1.5 : 4;
      this.meshes.push(m);
      this._counts.push(0);
      scene.add(m);
    }
    this.items.length = 0;   // transforms are baked; drop the authoring list
    return n;
  }

  /**
   * Repack the per-LOD instance ranges for a camera position. Only called when
   * the camera crosses a chunk boundary or quality changes.
   */
  refresh(camX, camZ, scale) {
    if (!this.chunks) return;
    const L = this.lods.length;
    for (let i = 0; i < L; i++) this._counts[i] = 0;
    const bounds = this._bounds || (this._bounds = []);
    for (let i = 0; i < L; i++) {
      const b = bounds[i] || (bounds[i] = {});
      b.x0 = Infinity; b.x1 = -Infinity; b.z0 = Infinity; b.z1 = -Infinity;
    }

    for (let c = 0; c < this.chunks.length; c++) {
      const ch = this.chunks[c];
      const dx = ch.wx - camX, dz = ch.wz - camZ;
      const d = Math.sqrt(dx * dx + dz * dz) - CHUNK_R;
      let li = -1;
      for (let k = 0; k < L; k++) { if (d <= this.lods[k].dist * scale) { li = k; break; } }
      if (li < 0) continue;
      const m = this.meshes[li];
      const at = this._counts[li];
      m.instanceMatrix.array.set(
        this.mats.subarray(ch.start * 16, (ch.start + ch.count) * 16), at * 16);
      m.instanceColor.array.set(
        this.cols.subarray(ch.start * 3, (ch.start + ch.count) * 3), at * 3);
      this._counts[li] = at + ch.count;
      const b = bounds[li];
      if (ch.wx - CHUNK_R < b.x0) b.x0 = ch.wx - CHUNK_R;
      if (ch.wx + CHUNK_R > b.x1) b.x1 = ch.wx + CHUNK_R;
      if (ch.wz - CHUNK_R < b.z0) b.z0 = ch.wz - CHUNK_R;
      if (ch.wz + CHUNK_R > b.z1) b.z1 = ch.wz + CHUNK_R;
    }

    for (let i = 0; i < L; i++) {
      const m = this.meshes[i], cnt = this._counts[i];
      m.count = cnt;
      m.visible = cnt > 0;
      if (!cnt) { m.boundingSphere.radius = -1; continue; }
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, cnt * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, cnt * 3);
      m.instanceColor.needsUpdate = true;
      // Bounds straight from the chunk extents — far cheaper, and safer, than
      // walking every instance matrix.
      const b = this._bounds[i];
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      m.boundingSphere.center.set(cx, m._radius * 0.4, cz);
      m.boundingSphere.radius = Math.hypot(b.x1 - cx, b.z1 - cz) + m._radius;
    }
  }

  setVisible(v) { for (const m of this.meshes) m.visible = v && m.count > 0; }

  dispose(scene) {
    for (const m of this.meshes) {
      scene.remove(m);
      m.dispose();
      m.geometry.dispose();
    }
    this.meshes.length = 0;
    this.chunks = null; this.mats = null; this.cols = null;
  }
}

/** Owns a set of batches and spreads their repacking over frames. */
export class PropBatcher {
  constructor(scene) {
    this.scene = scene;
    this.batches = new Map();
    this._queue = [];
    this._qi = 0;
  }
  batch(name, lods, opts) {
    let b = this.batches.get(name);
    if (!b) this.batches.set(name, b = new PropBatch(name, lods, opts));
    return b;
  }
  build() {
    let total = 0;
    for (const b of this.batches.values()) total += b.build(this.scene);
    this._queue = [...this.batches.values()].filter(b => b.chunks);
    return total;
  }
  /** Mark every batch for repacking; `step()` works through them. */
  invalidate() { this._qi = 0; }
  /** Repack up to `budget` batches. Returns true when the queue is drained. */
  step(camX, camZ, scale, budget = 6) {
    let done = 0;
    while (this._qi < this._queue.length && done < budget) {
      this._queue[this._qi++].refresh(camX, camZ, scale);
      done++;
    }
    return this._qi >= this._queue.length;
  }
  refreshAll(camX, camZ, scale) {
    for (const b of this._queue) b.refresh(camX, camZ, scale);
    this._qi = this._queue.length;
  }
  stats() {
    let inst = 0, meshes = 0;
    for (const b of this.batches.values()) {
      meshes += b.meshes.length;
      for (const m of b.meshes) inst += m.count;
    }
    return { batches: this.batches.size, meshes, instances: inst };
  }
  dispose() {
    for (const b of this.batches.values()) b.dispose(this.scene);
    this.batches.clear();
    this._queue.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Layout: the street graph props are placed against. Real when the city agent
// has landed, synthesised otherwise.
// ---------------------------------------------------------------------------

const _layouts = new WeakMap();

/** Real Boston park footprints, in world metres via the shared projection. */
function parkPolys() {
  const P = (pairs) => pairs.map(([la, lo]) => geo(la, lo));
  return [
    {
      name: 'common',
      poly: P([[42.35682, -71.06254], [42.35235, -71.06426], [42.35304, -71.06883],
      [42.35566, -71.07050], [42.35766, -71.06340]]),
    },
    {
      name: 'publicGarden',
      poly: P([[42.35595, -71.07030], [42.35330, -71.06960], [42.35245, -71.07270],
      [42.35505, -71.07340]]),
    },
  ];
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) &&
      x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function polyBounds(poly) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  return { x0, x1, z0, z1 };
}

function makeSegment(ax, az, bx, bz, opts) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return {
    ax, az, bx, bz,
    dx: dx / len, dz: dz / len,
    nx: dz / len, nz: -dx / len,      // right-hand normal
    mx: (ax + bx) / 2, mz: (az + bz) / 2,
    len,
    halfRoad: opts.halfRoad, type: opts.type, oneway: !!opts.oneway,
    frontage: opts.frontage ?? null,
    district: opts.district || 'downtown',
  };
}

/**
 * Fallback street graph. Deliberately matches the 90m block pitch of the
 * placeholder city so props land on the streets between its blocks; the whole
 * thing is thrown away the moment a real road graph appears.
 */
function synthGrid(ctx, city) {
  const parks = parkPolys();
  const lines = [];
  for (let k = -10; k <= 9; k++) lines.push(45 + 90 * k);
  const gh = (x, z) => (city?.groundHeight ? city.groundHeight(x, z) : 0) || 0;
  const districtAt = (x, z) => city?.districtAt ? city.districtAt(x, z) : null;

  const segments = [], junctions = [];
  const isPark = (x, z) => parks.some(p => pointInPoly(x, z, p.poly));
  const districtFor = (x, z) => {
    const d = districtAt(x, z);
    if (d) return d;
    if (isPark(x, z)) return 'park';
    if (x < -150 && z > -100) return 'backBay';
    if (x < 40 && z < -260) return 'beaconHill';
    if (x > 380 && z < -300) return 'northEnd';
    if (x > 250) return 'financial';
    return 'southEnd';
  };
  const arterial = (v) => Math.abs(Math.round((v - 45) / 90)) % 3 === 0;

  for (let axis = 0; axis < 2; axis++) {
    for (const v of lines) {
      const art = arterial(v);
      for (let i = 0; i < lines.length - 1; i++) {
        const a = lines[i], b = lines[i + 1];
        const ax = axis ? a : v, az = axis ? v : a;
        const bx = axis ? b : v, bz = axis ? v : b;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (isPark(mx, mz)) continue;
        segments.push(makeSegment(ax, az, bx, bz, {
          halfRoad: art ? 9.0 : 6.4,
          type: art ? 'arterial' : 'street',
          oneway: !art && ((i + v) % 3 === 0),
          frontage: art ? 19.0 : 19.0,
          district: districtFor(mx, mz),
        }));
      }
    }
  }
  for (const vx of lines) for (const vz of lines) {
    if (isPark(vx, vz)) continue;
    junctions.push({
      x: vx, z: vz, major: arterial(vx) || arterial(vz),
      district: districtFor(vx, vz),
      legs: [{ dx: 1, dz: 0, hw: arterial(vz) ? 9.0 : 6.4 },
      { dx: -1, dz: 0, hw: arterial(vz) ? 9.0 : 6.4 },
      { dx: 0, dz: 1, hw: arterial(vx) ? 9.0 : 6.4 },
      { dx: 0, dz: -1, hw: arterial(vx) ? 9.0 : 6.4 }],
    });
  }
  return finishLayout({ source: 'grid', segments, junctions, parks, gh, districtFor });
}

/** Real street graph from the city agent. */
function fromCityGraph(ctx, city) {
  const parks = parkPolys();
  const gh = (x, z) => city.groundHeight(x, z) || 0;
  const districtFor = (x, z) => city.districtAt?.(x, z) || 'downtown';
  const R = city.roads;
  const byId = new Map();
  for (const n of R.nodes) byId.set(n.id, n);

  const segments = [];
  const degree = new Map();
  const edgeById = new Map();
  for (const e of R.edges) edgeById.set(e.id, e);
  for (const e of R.edges) {
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b) continue;
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
    if (e.type === 'highway') continue;      // no sidewalk furniture on the Pike
    const w = e.width || (e.lanes || 2) * 3.5;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 12) continue;
    // Trim the segment back from each junction so nothing lands in the box.
    const t = Math.min(0.35, (w * 0.9 + 3) / len);
    segments.push(makeSegment(
      a.x + dx * t, a.z + dz * t, b.x - dx * t, b.z - dz * t,
      {
        halfRoad: w / 2, type: e.type, oneway: e.oneway,
        frontage: null, district: districtFor((a.x + b.x) / 2, (a.z + b.z) / 2),
      }));
  }

  const junctions = [];
  for (const n of R.nodes) {
    const deg = degree.get(n.id) || 0;
    if (deg < 3) continue;
    const legs = [];
    for (const eid of (R.outgoing?.(n.id) || [])) {
      const e = edgeById.get(eid);
      if (!e) continue;
      const o = byId.get(e.a === n.id ? e.b : e.a);
      if (!o) continue;
      const dx = o.x - n.x, dz = o.z - n.z, l = Math.hypot(dx, dz) || 1;
      legs.push({ dx: dx / l, dz: dz / l, hw: (e.width || (e.lanes || 2) * 3.5) / 2 });
    }
    if (!legs.length) continue;
    junctions.push({
      x: n.x, z: n.z, major: deg >= 4, district: districtFor(n.x, n.z), legs,
    });
  }
  return finishLayout({ source: 'city', segments, junctions, parks, gh, districtFor, city });
}

/** Shared tail: derive tree sites, park areas and the frontage list. */
function finishLayout(L) {
  L.groundHeight = L.gh;
  L.districtAt = L.districtFor;
  L.inPark = (x, z) => L.parks.some(p => pointInPoly(x, z, p.poly));
  L.kerb = 0;   // sidewalk lip above groundHeight; see report — city may raise this

  // Sort segments by distance from the Common so budgets are spent on the core
  // of the map first and thin out at the edges.
  L.segments.sort((a, b) => (a.mx * a.mx + a.mz * a.mz) - (b.mx * b.mx + b.mz * b.mz));
  L.junctions.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));

  // --- Street tree sites, shared with Vegetation so pits and trees agree ---
  const SPECIES = ['planeLondon', 'honeyLocust', 'redMaple', 'littleleafLinden', 'pinOak'];
  const sites = [];
  let sIdx = 0;
  for (const s of L.segments) {
    const rng = new RNG(1000 + (sIdx++) * 7717);
    if (s.type === 'alley') continue;
    const d = s.district;
    // Back Bay and the Common are heavily planted; the Financial District is not.
    const dense = d === 'backBay' || d === 'southEnd' || d === 'beaconHill' || d === 'park';
    const spacing = dense ? rng.range(9, 12.5) : rng.range(13, 20);
    if (d === 'financial' && rng.chance(0.35)) continue;
    for (const side of [-1, 1]) {
      if (rng.chance(0.16)) continue;         // one bare side happens all the time
      const off = s.halfRoad + 1.05;
      for (let t = rng.range(5, 11); t < s.len - 5; t += spacing * rng.range(0.85, 1.15)) {
        if (rng.chance(0.13)) continue;       // gaps: driveways, dead trees, hydrants
        const x = s.ax + s.dx * t + s.nx * off * side;
        const z = s.az + s.dz * t + s.nz * off * side;
        if (L.inPark(x, z)) continue;
        sites.push({
          x, z, y: L.gh(x, z) + L.kerb,
          species: SPECIES[(rng.int(100) * 7 + sIdx) % SPECIES.length],
          scale: rng.range(0.78, 1.32),
          rot: rng.range(0, Math.PI * 2),
          lean: rng.range(-0.05, 0.05),
          kind: 'street',
        });
      }
    }
  }
  L.treeSites = sites;

  // --- Park planting areas ---
  L.parkAreas = L.parks.map(p => ({ ...p, bounds: polyBounds(p.poly) }));

  // --- Frontage lines (building faces) for wall-mounted props ---
  const front = [];
  const plots = L.city?.plots;
  if (plots && plots.length) {
    for (const pl of plots) {
      const poly = pl.polygon;
      if (!poly || poly.length < 3) continue;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (len < 6) continue;
        // Outward normal: polygons are authored CCW, so the right normal points out.
        front.push({
          ax: a.x, az: a.z, bx: b.x, bz: b.z, len,
          dx: dx / len, dz: dz / len, nx: dz / len, nz: -dx / len,
          district: pl.district || 'downtown', maxHeight: pl.maxHeight || 20,
        });
      }
    }
  } else {
    for (const s of L.segments) {
      if (s.frontage == null) continue;
      for (const side of [-1, 1]) {
        const ox = s.nx * s.frontage * side, oz = s.nz * s.frontage * side;
        front.push({
          ax: s.ax + ox, az: s.az + oz, bx: s.bx + ox, bz: s.bz + oz, len: s.len,
          dx: s.dx, dz: s.dz, nx: -s.nx * side, nz: -s.nz * side,
          district: s.district, maxHeight: 24,
        });
      }
    }
  }
  L.frontage = front;
  return L;
}

/** Memoised per engine; upgrades from the synthetic grid to the real graph. */
export function getLayout(ctx) {
  const key = ctx.engine;
  const city = ctx.get('city');
  const hasCity = !!(city?.roads?.edges?.length && city.roads.nodes?.length);
  let L = _layouts.get(key);
  if (L && (L.source === 'city' || !hasCity)) return L;
  L = hasCity ? fromCityGraph(ctx, city) : synthGrid(ctx, city);
  _layouts.set(key, L);
  return L;
}

/** True when a real road graph has appeared since the layout was synthesised. */
export function layoutStale(ctx) {
  const L = _layouts.get(ctx.engine);
  return !!(L && L.source === 'grid' && ctx.get('city')?.roads?.edges?.length);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const DENSITY = { low: 0.42, medium: 0.7, high: 1.0, ultra: 1.15 };

/** Yaw so the prop's local +Z points along (fx, fz). */
const facing = (fx, fz) => Math.atan2(fx, fz);

export default class Props {
  static id = 'props';
  static label = 'Street furniture';
  static deps = ['assets'];

  async init(ctx) {
    this.ctx = ctx;
    this.M = getPropMaterials(ctx);
    this.lib = buildFurnitureLibrary();
    clearGeoCache();

    this.batcher = new PropBatcher(ctx.scene);
    this.decals = new Decals();
    this.wires = null;
    this._lightPool = [];
    this._lampSites = [];
    this._lastCamX = 1e9; this._lastCamZ = 1e9;
    this._lastScale = -1;
    this._night = 0;
    this._season = 'summer';
    this._snow = false;

    this.layout = getLayout(ctx);
    this._buildAll(ctx);

    ctx.bus.on('quality:changed', this._onQuality = () => {
      this._lastCamX = 1e9;
      this.batcher.invalidate();
    });
    ctx.bus.on('weather:set', this._onWeather = (w) => this.setWeather(w));
    this.setWeather(ctx.settings.weather);
  }

  _buildAll(ctx) {
    const L = this.layout;
    const density = ctx.settings.propDensity ?? DENSITY[ctx.settings.preset] ?? 1;
    this._registerTypes();
    populate(this, L, density);
    this.decals.register(ctx, L, density, this.batcher);
    const n = this.batcher.build();
    this.decals.afterBuild(this.batcher);
    this._buildWires(ctx, L);
    this._buildLightPool(ctx);
    // Pack every batch once up front so the very first rendered frame is furnished.
    const scale = THREE.MathUtils.clamp(ctx.settings.drawDist / 2200, 0.35, 1.6);
    this.batcher.refreshAll(ctx.camera.position.x, ctx.camera.position.z, scale);
    this.decals.refresh(ctx.camera.position.x, ctx.camera.position.z, scale);
    this._updateLightPool(ctx.camera.position.x, ctx.camera.position.z);
    this._applySnow();
    this.instanceCount = n;
    console.info(`[props] ${n} instances, ${this.batcher.batches.size} types, ` +
      `${this.batcher.stats().meshes} meshes (${L.source} layout, ` +
      `${L.segments.length} segments, ${L.treeSites.length} tree pits)`);
  }

  /** One batch per furniture type, wired to the shared materials. */
  _registerTypes() {
    const M = this.M;
    const matsFor = (slots) => slots.length === 1 ? M[slots[0]] : slots.map(s => M[s]);
    for (const [name, def] of this.lib) {
      const lods = [{
        geometry: def.d0.geometry, materials: matsFor(def.d0.slots),
        dist: def.near, cast: def.cast !== false,
      }];
      if (def.d1) {
        lods.push({
          geometry: def.d1.geometry, materials: matsFor(def.d1.slots),
          dist: def.far, cast: false,
        });
      } else if (def.far > def.near) {
        lods[0].dist = def.far;
      }
      this.batcher.batch(name, lods, { receive: def.receive !== false });
    }
  }

  /**
   * Catenary spans between utility poles. Wires against the sky are one of the
   * strongest "this is a real street" cues there is, and they cost almost
   * nothing: a handful of merged tube meshes, tiled so they distance-cull.
   */
  _buildWires(ctx, L) {
    const runs = this._wireRuns || [];
    if (!runs.length) return;
    const TILE = 320;
    const tiles = new Map();
    const curve = new THREE.CatmullRomCurve3(
      [0, 1, 2, 3, 4].map(() => new THREE.Vector3()));

    for (const run of runs) {
      for (let i = 0; i + 1 < run.length; i++) {
        const a = run[i], b = run[i + 1];
        const span = Math.hypot(b.x - a.x, b.z - a.z);
        if (span < 8 || span > 70) continue;
        const key = `${Math.floor(a.x / TILE)},${Math.floor(a.z / TILE)}`;
        let tile = tiles.get(key);
        if (!tile) tiles.set(key, tile = []);
        const sag = 0.035 * span + 0.25;
        for (let w = 0; w < 3; w++) {
          const ho = (w - 1) * 0.78;                 // crossarm spacing
          const vy = w === 2 ? -0.90 : 0.0;          // comms bundle hangs lower
          const px = -a.dz * ho, pz = a.dx * ho;
          for (let k = 0; k < 5; k++) {
            const t = k / 4;
            const s = 4 * t * (1 - t);
            curve.points[k].set(
              a.x + (b.x - a.x) * t + px,
              a.y + (b.y - a.y) * t + vy - sag * s,
              a.z + (b.z - a.z) * t + pz);
          }
          const g = new THREE.TubeGeometry(curve, 6, 0.032, 3, false);
          tile.push(g);
        }
      }
    }

    const mat = ctx.assets.material('prop_wire', () => new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.72, metalness: 0.25,
    }));
    mat.userData.wetnessRough = mat.roughness;
    mat.userData.wetnessColor = mat.color.clone();

    this.wires = [];
    for (const [, geos] of tiles) {
      if (!geos.length) continue;
      const merged = mergeTubes(geos);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      merged.computeBoundingSphere();
      mesh.name = 'prop:wires';
      ctx.scene.add(mesh);
      this.wires.push(mesh);
    }
  }

  /**
   * Hand the nearest street lamps to the lighting agent, if it offers a pool.
   * Thousands of lamps cannot each be a real light; a small moving set can.
   */
  _buildLightPool(ctx) {
    const lighting = ctx.get('lighting');
    if (!lighting?.registerLight || !this._lampSites.length) return;
    const N = ctx.settings.preset === 'low' ? 8 : 20;
    for (let i = 0; i < N; i++) {
      const o = new THREE.Object3D();
      o.name = 'props:streetLight';
      o.visible = false;
      ctx.scene.add(o);
      try {
        lighting.registerLight(o, { type: 'street', range: 26, intensity: 42 });
        this._lightPool.push(o);
      } catch (e) {
        ctx.scene.remove(o);
        console.info('[props] lighting.registerLight declined:', e.message);
        break;
      }
    }
  }

  _updateLightPool(camX, camZ) {
    const pool = this._lightPool;
    if (!pool.length) return;
    const sites = this._lampSites;
    // Cheap nearest-N: scan with a running worst-of-set threshold. No allocation.
    const idx = this._poolIdx || (this._poolIdx = new Int32Array(pool.length));
    const dst = this._poolDst || (this._poolDst = new Float32Array(pool.length));
    for (let i = 0; i < pool.length; i++) { idx[i] = -1; dst[i] = Infinity; }
    for (let i = 0; i < sites.length; i += 1) {
      const s = sites[i];
      const dx = s.x - camX, dz = s.z - camZ;
      const d = dx * dx + dz * dz;
      if (d >= dst[pool.length - 1]) continue;
      let j = pool.length - 1;
      while (j > 0 && dst[j - 1] > d) { dst[j] = dst[j - 1]; idx[j] = idx[j - 1]; j--; }
      dst[j] = d; idx[j] = i;
    }
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      if (idx[i] < 0) { o.visible = false; continue; }
      const s = sites[idx[i]];
      o.position.set(s.x, s.y, s.z);
      o.visible = this._night > 0.05;
      o.updateMatrixWorld();
    }
  }

  /** @param {'summer'|'earlyAutumn'|'autumn'|'winter'|'spring'} s */
  setSeason(s) {
    this._season = s;
    const snow = s === 'winter';
    if (snow !== this._snow) { this._snow = snow; this._applySnow(); }
    this.ctx?.get('vegetation')?.setSeason?.(s);
  }

  setWeather(w) {
    const snow = w === 'snow' || this._season === 'winter';
    if (snow !== this._snow) { this._snow = snow; this._applySnow(); }
    this.decals?.setWeather(w);
  }

  _applySnow() {
    const b = this.batcher.batches.get('snowBank');
    if (b) b.setVisible(this._snow);
  }

  update(dt, ctx) {
    // The city agent may land after us: rebuild against the real graph once.
    if (layoutStale(ctx)) {
      this._rebuild(ctx);
      return;
    }

    const cam = ctx.camera;
    _camPos.copy(cam.position);
    const scale = THREE.MathUtils.clamp(ctx.settings.drawDist / 2200, 0.35, 1.6);
    const moved = Math.abs(_camPos.x - this._lastCamX) + Math.abs(_camPos.z - this._lastCamZ);
    if (moved > 22 || scale !== this._lastScale) {
      this._lastCamX = _camPos.x; this._lastCamZ = _camPos.z; this._lastScale = scale;
      this.batcher.invalidate();
      this._updateLightPool(_camPos.x, _camPos.z);
      this.decals.refresh(_camPos.x, _camPos.z, scale);
    }
    this.batcher.step(this._lastCamX, this._lastCamZ, scale, 8);
    if (this._snow) this._applySnow();

    // Night emissives. Boston's streetlights are on well before full dark.
    const h = ctx.time.timeOfDay;
    const night = h < 6.4 || h > 18.3
      ? THREE.MathUtils.clamp(Math.min(Math.abs(h - 6.4), Math.abs(h - 18.3)) / 0.9, 0, 1)
      : 0;
    if (Math.abs(night - this._night) > 0.004) {
      this._night = night;
      this.M.emitNight.emissiveIntensity = 0.22 + night * 3.4;
      this.M.emitNight.color.setRGB(0.72 - night * 0.25, 0.71 - night * 0.26, 0.66 - night * 0.24);
      for (const o of this._lightPool) o.visible = night > 0.05;
    }

    // Wires are thin and cheap but pointless at range; cull the far tiles.
    if (this.wires) {
      const far = ctx.settings.drawDist * 0.55;
      for (const m of this.wires) {
        const c = m.geometry.boundingSphere;
        m.visible = !c || _camPos.distanceTo(c.center) < far + c.radius;
      }
    }
  }

  _rebuild(ctx) {
    this.batcher.dispose();
    this.decals.dispose(ctx);
    for (const m of this.wires || []) { ctx.scene.remove(m); m.geometry.dispose(); }
    this.wires = null;
    for (const o of this._lightPool) ctx.scene.remove(o);
    this._lightPool.length = 0;
    this._lampSites.length = 0;
    this._wireRuns = null;
    this.batcher = new PropBatcher(ctx.scene);
    this.layout = getLayout(ctx);
    this._buildAll(ctx);
    this._lastCamX = 1e9;
    ctx.bus.emit('props:rebuilt', this.layout);
  }

  stats() { return { ...this.batcher.stats(), decals: this.decals?.stats() }; }

  dispose() {
    const ctx = this.ctx;
    this.batcher?.dispose();
    this.decals?.dispose(ctx);
    for (const m of this.wires || []) { ctx.scene.remove(m); m.geometry.dispose(); }
    for (const o of this._lightPool) ctx.scene.remove(o);
    ctx?.bus.off?.('quality:changed', this._onQuality);
    ctx?.bus.off?.('weather:set', this._onWeather);
    _layouts.delete(ctx?.engine);
  }
}

/** Merge tube geometries (position/normal/uv only) without the utils dependency. */
function mergeTubes(geos) {
  let vtx = 0, idx = 0;
  for (const g of geos) { vtx += g.attributes.position.count; idx += g.index.count; }
  const pos = new Float32Array(vtx * 3), nor = new Float32Array(vtx * 3), uv = new Float32Array(vtx * 2);
  const index = vtx > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) index[io + i] = gi[i] + vo;
    io += gi.length; vo += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

// ---------------------------------------------------------------------------
// The actual furnishing pass. Budgets are total instance counts, spent on
// segments nearest the Common first so the playable core is densest.
// ---------------------------------------------------------------------------

function populate(sys, L, density) {
  const B = sys.batcher;
  const g = (x, z) => L.gh(x, z) + L.kerb;
  const road = (x, z) => L.gh(x, z);
  const b = (name) => B.batches.get(name);
  const budget = (n) => Math.round(n * density);

  const quota = {
    lamp: budget(1500), meter: budget(1400), hydrant: budget(420), bin: budget(620),
    bench: budget(430), bikeRack: budget(330), bollard: budget(1100),
    mailbox: budget(140), newsBox: budget(300), utilityBox: budget(260),
    manhole: budget(1500), drain: budget(1200), sign: budget(2600),
    pole: budget(430), shelter: budget(90), dock: budget(38), planter: budget(260),
    litter: budget(1500), construction: budget(1400), attach: budget(2600),
    grate: budget(4200), signal: budget(340),
  };
  const take = (k, n = 1) => (quota[k] -= n) >= 0;

  // ---- Tree pit grates: exactly one per street tree site -------------------
  {
    const grate = b('treeGrate');
    for (const s of L.treeSites) {
      if (!take('grate')) break;
      grate.add(s.x, s.y + 0.005, s.z, s.rot, 1, 0.9 + (s.scale - 1) * 0.1);
    }
  }

  // ---- Along-street furniture ---------------------------------------------
  let si = 0;
  for (const s of L.segments) {
    const rng = new RNG(50021 + (si++) * 3607);
    const d = s.district;
    const heritage = d === 'beaconHill' || d === 'backBay' || d === 'park' || d === 'northEnd';
    const busy = d === 'financial' || d === 'downtown' || s.type === 'arterial';
    const kerb = s.halfRoad;
    const furn = kerb + 0.72;
    const back = kerb + 2.55;

    // --- Street lamps: alternate sides, ~32m ---
    {
      const type = heritage ? (rng.chance(0.22) ? 'lampTwin' : 'lampAcorn') : 'lampCobra';
      const bat = b(type);
      let side = rng.chance(0.5) ? 1 : -1;
      const step = heritage ? rng.range(26, 34) : rng.range(34, 44);
      for (let t = rng.range(6, 16); t < s.len - 5; t += step) {
        if (!take('lamp')) break;
        const off = type === 'lampCobra' ? kerb + 0.65 : furn;
        const x = s.ax + s.dx * t + s.nx * off * side;
        const z = s.az + s.dz * t + s.nz * off * side;
        // Cobra arms reach over the road; acorns face the footway.
        const ry = facing(-s.nx * side, -s.nz * side);
        bat.add(x, g(x, z), z, ry + rng.range(-0.03, 0.03), rng.range(0.97, 1.03),
          rng.range(0.88, 1.06));
        sys._lampSites.push({ x, y: g(x, z) + (type === 'lampCobra' ? 9.2 : 3.85), z });
        side = -side;
      }
    }

    // --- Kerbside parking: meters, or a pay station for the whole face ---
    const metered = !heritage ? rng.chance(0.55) : rng.chance(0.75);
    if (metered && s.type !== 'arterial') {
      for (const side of [-1, 1]) {
        if (rng.chance(0.35)) continue;
        if (rng.chance(0.12)) {
          if (!take('meter')) break;
          const t = rng.range(8, Math.max(9, s.len - 8));
          const x = s.ax + s.dx * t + s.nx * (kerb + 0.6) * side;
          const z = s.az + s.dz * t + s.nz * (kerb + 0.6) * side;
          b('payStation').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.05));
          continue;
        }
        for (let t = rng.range(7, 12); t < s.len - 7; t += rng.range(6.0, 7.2)) {
          if (!take('meter')) break;
          const x = s.ax + s.dx * t + s.nx * (kerb + 0.55) * side;
          const z = s.az + s.dz * t + s.nz * (kerb + 0.55) * side;
          b('parkingMeter').add(x, g(x, z), z,
            facing(-s.nx * side, -s.nz * side) + rng.range(-0.12, 0.12), 1, rng.range(0.86, 1.06));
        }
      }
    }

    // --- Regulatory signs on the kerb line ---
    for (const side of [-1, 1]) {
      for (let t = rng.range(6, 20); t < s.len - 6; t += rng.range(22, 46)) {
        if (!take('sign')) break;
        const pick = rng.f();
        const name = pick < 0.42 ? 'signNoParking' : pick < 0.62 ? 'signTowZone'
          : pick < 0.74 ? 'signHandicap' : pick < 0.86 ? 'signFireLane' : 'signSpeed';
        const x = s.ax + s.dx * t + s.nx * (kerb + 0.5) * side;
        const z = s.az + s.dz * t + s.nz * (kerb + 0.5) * side;
        b(name).add(x, g(x, z), z,
          facing(-s.nx * side, -s.nz * side) + rng.range(-0.08, 0.08) + (rng.chance(0.5) ? Math.PI : 0),
          rng.range(0.97, 1.02), rng.range(0.85, 1.05));
      }
    }
    if (s.oneway && take('sign')) {
      // The blade faces across the footway; its arrow runs along local +X, which
      // for this yaw resolves to the travel direction only on the +side.
      const side = rng.sign();
      const t = rng.range(3, 8);
      const x = s.ax + s.dx * t + s.nx * (kerb + 0.5) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 0.5) * side;
      b(side > 0 ? 'signOneWayR' : 'signOneWayL')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.05));
    }

    // --- Hydrants, bins, benches, racks, boxes ---
    for (let t = rng.range(20, 70); t < s.len - 10; t += rng.range(70, 130)) {
      if (!take('hydrant')) break;
      const side = rng.sign();
      const x = s.ax + s.dx * t + s.nx * (kerb + 0.62) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 0.62) * side;
      b(rng.chance(0.55) ? 'hydrantY' : 'hydrantR')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side) + rng.range(-0.2, 0.2),
          1, rng.range(0.86, 1.08));
    }
    for (let t = rng.range(14, 50); t < s.len - 8; t += rng.range(48, 105)) {
      if (!take('bin')) break;
      const side = rng.sign();
      const x = s.ax + s.dx * t + s.nx * furn * side;
      const z = s.az + s.dz * t + s.nz * furn * side;
      b(busy && rng.chance(0.6) ? 'bigBelly' : 'wireBin')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side) + rng.range(-0.25, 0.25),
          1, rng.range(0.88, 1.05));
      if (rng.chance(0.45) && take('litter')) {
        const bx = x + s.dx * rng.range(-1.4, 1.4), bz = z + s.dz * rng.range(-1.4, 1.4);
        b('binBags').add(bx, g(bx, bz), bz, rng.range(0, 6.28), rng.range(0.8, 1.15), rng.range(0.8, 1.05));
      }
    }
    if (rng.chance(0.30) && take('bench')) {
      const side = rng.sign(); const t = rng.range(10, Math.max(11, s.len - 10));
      const x = s.ax + s.dx * t + s.nx * (back - 0.5) * side;
      const z = s.az + s.dz * t + s.nz * (back - 0.5) * side;
      b('bench').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.05));
    }
    if (rng.chance(0.26) && take('bikeRack')) {
      const side = rng.sign(); const t = rng.range(10, Math.max(11, s.len - 10));
      const n = 1 + rng.int(3);
      for (let k = 0; k < n; k++) {
        const tt = t + k * 0.85;
        const x = s.ax + s.dx * tt + s.nx * furn * side;
        const z = s.az + s.dz * tt + s.nz * furn * side;
        b('bikeRack').add(x, g(x, z), z, facing(s.dx, s.dz), 1, rng.range(0.95, 1.02));
      }
    }
    if (rng.chance(0.12) && take('mailbox')) {
      const side = rng.sign(); const t = rng.range(8, Math.max(9, s.len - 8));
      const x = s.ax + s.dx * t + s.nx * furn * side;
      const z = s.az + s.dz * t + s.nz * furn * side;
      b('mailbox').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.94, 1.03));
    }
    if (busy && rng.chance(0.30)) {
      const side = rng.sign(); const t = rng.range(8, Math.max(9, s.len - 8));
      const n = 1 + rng.int(3);
      for (let k = 0; k < n; k++) {
        if (!take('newsBox')) break;
        const tt = t + k * 0.5;
        const x = s.ax + s.dx * tt + s.nx * (furn + 0.1) * side;
        const z = s.az + s.dz * tt + s.nz * (furn + 0.1) * side;
        b(k % 2 ? 'newsBoxA' : 'newsBoxB').add(x, g(x, z), z,
          facing(-s.nx * side, -s.nz * side) + rng.range(-0.15, 0.15), 1, rng.range(0.88, 1.04));
      }
    }
    if (rng.chance(0.22) && take('utilityBox')) {
      const side = rng.sign(); const t = rng.range(10, Math.max(11, s.len - 10));
      const x = s.ax + s.dx * t + s.nx * back * side;
      const z = s.az + s.dz * t + s.nz * back * side;
      b(rng.chance(0.5) ? 'utilityBoxA' : 'utilityBoxB')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.06));
    }
    if (heritage && rng.chance(0.34)) {
      const side = rng.sign(); const t = rng.range(8, Math.max(9, s.len - 8));
      const n = 2 + rng.int(4);
      for (let k = 0; k < n; k++) {
        if (!take('bollard')) break;
        const tt = t + k * 1.65;
        if (tt > s.len - 4) break;
        const x = s.ax + s.dx * tt + s.nx * (kerb + 0.45) * side;
        const z = s.az + s.dz * tt + s.nz * (kerb + 0.45) * side;
        b('bollard').add(x, g(x, z), z, rng.range(0, 6.28), 1, rng.range(0.9, 1.05));
      }
    }
    if (heritage && rng.chance(0.18) && take('planter')) {
      const side = rng.sign(); const t = rng.range(8, Math.max(9, s.len - 8));
      const x = s.ax + s.dx * t + s.nx * furn * side;
      const z = s.az + s.dz * t + s.nz * furn * side;
      b('planter').add(x, g(x, z), z, rng.range(0, 6.28), rng.range(0.9, 1.1), rng.range(0.86, 1.06));
    }

    // --- Roadway: manholes, gutter drains ---
    for (let t = rng.range(8, 30); t < s.len - 6; t += rng.range(28, 55)) {
      if (!take('manhole')) break;
      const off = rng.range(-kerb * 0.6, kerb * 0.6);
      const x = s.ax + s.dx * t + s.nx * off;
      const z = s.az + s.dz * t + s.nz * off;
      b('manhole').add(x, road(x, z) + 0.004, z, rng.range(0, 6.28), rng.range(0.96, 1.04),
        rng.range(0.8, 1.05));
    }
    for (const side of [-1, 1]) {
      for (let t = rng.range(15, 45); t < s.len - 8; t += rng.range(38, 70)) {
        if (!take('drain')) break;
        const x = s.ax + s.dx * t + s.nx * (kerb - 0.30) * side;
        const z = s.az + s.dz * t + s.nz * (kerb - 0.30) * side;
        b('stormDrain').add(x, road(x, z) + 0.004, z,
          facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.04));
      }
    }

    // --- Overhead: utility poles on neighbourhood streets ---
    const overhead = !busy && d !== 'financial' && d !== 'backBay' && rng.chance(0.55);
    if (overhead) {
      const side = rng.sign();
      const run = [];
      for (let t = rng.range(4, 12); t < s.len - 4; t += rng.range(34, 46)) {
        if (!take('pole')) break;
        const x = s.ax + s.dx * t + s.nx * (kerb + 0.5) * side;
        const z = s.az + s.dz * t + s.nz * (kerb + 0.5) * side;
        const tx = rng.chance(0.3);
        b(tx ? 'utilityPoleTx' : 'utilityPole').add(x, g(x, z), z,
          facing(s.dx, s.dz) + rng.range(-0.05, 0.05), rng.range(0.94, 1.08), rng.range(0.82, 1.02));
        run.push({ x, y: g(x, z) + 9.45, z, dx: s.dx, dz: s.dz });
      }
      if (run.length > 1) (sys._wireRuns || (sys._wireRuns = [])).push(run);
    }

    // --- Bus shelters on arterials ---
    if (s.type === 'arterial' && rng.chance(0.22) && take('shelter')) {
      const side = rng.sign();
      const t = rng.range(14, Math.max(15, s.len - 14));
      const x = s.ax + s.dx * t + s.nx * (kerb + 1.5) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 1.5) * side;
      b('busShelter').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, 1);
    }
    if (rng.chance(0.05) && take('dock')) {
      const side = rng.sign();
      const t = rng.range(10, Math.max(11, s.len - 16));
      const x = s.ax + s.dx * t + s.nx * (kerb + 1.0) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 1.0) * side;
      b('bluebikes').add(x, g(x, z), z, facing(s.dx, s.dz), 1, 1);
    }

    // --- Construction. Boston is permanently dug up; lean into it. ---
    if (rng.chance(0.11)) placeConstruction(sys, s, rng, take, g, road);

    // --- Building frontage attachments happen in their own pass ---
  }

  // ---- Junction furniture -------------------------------------------------
  let ji = 0;
  for (const j of L.junctions) {
    const rng = new RNG(90001 + (ji++) * 5171);
    const legs = j.legs;
    if (!legs.length) continue;

    if (j.major && quota.signal > 0) {
      // Two mast arms on opposing approaches, the usual US arrangement.
      const picks = legs.length >= 4 ? [0, 2] : [0];
      for (const li of picks) {
        if (!take('signal')) break;
        const leg = legs[li];
        // Approach direction points into the junction.
        const ax = -leg.dx, az = -leg.dz;
        const rx = -az, rz = ax;                 // right of the approach
        const k = leg.hw + 2.2;
        const x = j.x + ax * k + rx * k;
        const z = j.z + az * k + rz * k;
        b(li === 0 ? 'trafficMastR' : 'trafficMastG')
          .add(x, g(x, z), z, facing(-ax, -az), 1, rng.range(0.9, 1.0));
      }
      for (const leg of legs) {
        if (!take('signal')) break;
        const rx = -leg.dz, rz = leg.dx;
        const k = leg.hw + 1.5;
        const x = j.x + leg.dx * k + rx * 1.9;
        const z = j.z + leg.dz * k + rz * 1.9;
        b('pedSignal').add(x, g(x, z), z, facing(-leg.dx, -leg.dz), 1, rng.range(0.9, 1.04));
      }
    } else {
      // Minor junction: stop signs facing each approach.
      for (const leg of legs) {
        if (rng.chance(0.35)) continue;
        if (!take('sign')) break;
        const ax = -leg.dx, az = -leg.dz;
        const rx = -az, rz = ax;
        const k = leg.hw + 1.4;
        const x = j.x - ax * k + rx * (leg.hw + 0.9);
        const z = j.z - az * k + rz * (leg.hw + 0.9);
        b('signStop').add(x, g(x, z), z, facing(-ax, -az) + rng.range(-0.05, 0.05),
          1, rng.range(0.9, 1.05));
      }
    }

    // Street name blades on one corner.
    if (take('sign')) {
      const leg = legs[rng.int(legs.length)];
      const rx = -leg.dz, rz = leg.dx;
      const k = leg.hw + 1.6;
      const x = j.x + leg.dx * k + rx * k;
      const z = j.z + leg.dz * k + rz * k;
      b(rng.chance(0.5) ? 'signBlades02' : 'signBlades13')
        .add(x, g(x, z), z, facing(leg.dx, leg.dz) + rng.range(-0.1, 0.1), 1, rng.range(0.9, 1.04));
    }

    // Corner drains catch the crown of the junction.
    for (const leg of legs) {
      if (!take('drain')) break;
      const rx = -leg.dz, rz = leg.dx;
      const k = leg.hw + 0.6;
      const x = j.x + leg.dx * k + rx * (leg.hw - 0.4);
      const z = j.z + leg.dz * k + rz * (leg.hw - 0.4);
      b('stormDrain').add(x, road(x, z) + 0.004, z, facing(-rx, -rz), 1, 1);
    }
  }

  // ---- Building attachments ----------------------------------------------
  let fi = 0;
  for (const f of L.frontage) {
    const rng = new RNG(70001 + (fi++) * 2777);
    if (f.len < 8) continue;
    const commercial = f.district === 'financial' || f.district === 'downtown'
      || f.district === 'northEnd' || f.district === 'backBay' || rng.chance(0.4);

    for (let t = rng.range(2, 7); t < f.len - 3; t += rng.range(6, 13)) {
      const x = f.ax + f.dx * t, z = f.az + f.dz * t;
      const ry = facing(f.nx, f.nz);
      const y0 = L.gh(x, z);
      // Ground floor
      if (commercial && rng.chance(0.42) && take('attach')) {
        b(rng.chance(0.5) ? 'awningRed' : 'awningGreen')
          .add(x + f.nx * 0.06, y0 + rng.range(2.55, 2.95), z + f.nz * 0.06, ry, rng.range(0.85, 1.15));
      }
      if (commercial && rng.chance(0.34) && take('attach')) {
        b(rng.chance(0.5) ? 'storeFasciaA' : 'storeFasciaB')
          .add(x + f.nx * 0.05, y0 + rng.range(3.4, 4.0), z + f.nz * 0.05, ry, rng.range(0.85, 1.1));
      }
      if (commercial && rng.chance(0.22) && take('attach')) {
        b(rng.chance(0.5) ? 'shopSignA' : 'shopSignB')
          .add(x, y0 + rng.range(3.1, 3.7), z, ry, rng.range(0.9, 1.1));
      }
      if (rng.chance(0.12) && take('attach')) {
        b('standpipe').add(x + f.nx * 0.04, y0 + 0.95, z + f.nz * 0.04, ry, 1);
      }
      // Upper floors
      const floors = Math.max(1, Math.min(6, Math.floor((f.maxHeight - 4) / 3.4)));
      for (let fl = 1; fl <= floors; fl++) {
        const y = y0 + 3.6 + (fl - 1) * 3.35;
        if (rng.chance(0.20) && take('attach')) {
          b('acUnit').add(x + f.nx * 0.02, y + 1.05, z + f.nz * 0.02, ry, rng.range(0.9, 1.05));
        }
        if (fl === 1 && rng.chance(0.10) && take('attach')) {
          b('fireEscape').add(x + f.nx * 0.04, y + 0.6, z + f.nz * 0.04, ry, rng.range(0.95, 1.08));
        }
      }
      if (rng.chance(0.05) && take('attach')) {
        b('satDish').add(x + f.nx * 0.03, y0 + rng.range(6, Math.max(7, f.maxHeight - 2)), z + f.nz * 0.03,
          ry + rng.range(-0.5, 0.5), rng.range(0.8, 1.1));
      }
      if (rng.chance(0.055) && take('attach')) {
        b(rng.chance(0.6) ? 'flagUS' : 'flagMA')
          .add(x + f.nx * 0.05, y0 + rng.range(3.8, 5.2), z + f.nz * 0.05, ry, rng.range(0.9, 1.1));
      }
    }
  }

  // ---- Park furniture ------------------------------------------------------
  let pi = 0;
  for (const p of L.parkAreas) {
    const rng = new RNG(31337 + (pi++) * 911);
    const { x0, x1, z0, z1 } = p.bounds;
    for (let i = 0; i < 320; i++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (!pointInPoly(x, z, p.poly)) continue;
      const r = rng.f();
      if (r < 0.34 && take('bench')) {
        b('benchPark').add(x, g(x, z), z, rng.range(0, 6.28), 1, rng.range(0.88, 1.06));
      } else if (r < 0.52 && take('lamp')) {
        b('lampTwin').add(x, g(x, z), z, rng.range(0, 6.28), rng.range(0.97, 1.04), rng.range(0.9, 1.05));
        sys._lampSites.push({ x, y: g(x, z) + 4.3, z });
      } else if (r < 0.66 && take('bin')) {
        b('wireBin').add(x, g(x, z), z, rng.range(0, 6.28), 1, rng.range(0.9, 1.05));
      } else if (r < 0.76 && take('bollard')) {
        b('bollard').add(x, g(x, z), z, rng.range(0, 6.28), 1, rng.range(0.9, 1.05));
      } else if (r < 0.84 && take('planter')) {
        b('planter').add(x, g(x, z), z, rng.range(0, 6.28), rng.range(0.9, 1.15), rng.range(0.88, 1.05));
      } else if (r < 0.90 && take('litter')) {
        b('binBags').add(x, g(x, z), z, rng.range(0, 6.28), rng.range(0.7, 1.0), rng.range(0.85, 1.05));
      }
    }
  }

  // ---- Winter kerbside snow banks (hidden unless it is snowing) ------------
  {
    let k = 0;
    for (const s of L.segments) {
      const rng = new RNG(60013 + (k++) * 1231);
      if (rng.chance(0.55)) continue;
      for (const side of [-1, 1]) {
        for (let t = rng.range(5, 20); t < s.len - 5; t += rng.range(22, 42)) {
          const x = s.ax + s.dx * t + s.nx * (s.halfRoad - 0.2) * side;
          const z = s.az + s.dz * t + s.nz * (s.halfRoad - 0.2) * side;
          b('snowBank').add(x, road(x, z), z, facing(s.dx, s.dz), rng.range(0.8, 1.3), rng.range(0.94, 1.02));
        }
      }
      if (k > 420) break;
    }
  }
}

/** A works zone: barriers, cones, drums, signage, and something being dug up. */
function placeConstruction(sys, s, rng, take, g, road) {
  const b = (n) => sys.batcher.batches.get(n);
  const side = rng.sign();
  const t0 = rng.range(6, Math.max(7, s.len - 26));
  const L = Math.min(s.len - t0 - 4, rng.range(12, 26));
  const kerb = s.halfRoad;
  const lane = kerb - 1.9;

  // Taper of cones leading in, then a run of drums along the closed lane.
  for (let i = 0; i < 7; i++) {
    if (!take('construction')) return;
    const t = t0 - 8 + i * 1.5;
    const off = (kerb - 3.4) + (i / 6) * 1.5;
    const x = s.ax + s.dx * t + s.nx * off * side;
    const z = s.az + s.dz * t + s.nz * off * side;
    b('cone').add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.94, 1.06), rng.range(0.75, 1.02));
  }
  for (let t = t0; t < t0 + L; t += rng.range(3.0, 4.6)) {
    if (!take('construction')) return;
    const x = s.ax + s.dx * t + s.nx * lane * side;
    const z = s.az + s.dz * t + s.nz * lane * side;
    if (rng.chance(0.45)) {
      b('barrel').add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.95, 1.05), rng.range(0.8, 1.02));
    } else {
      b('jersey').add(x, road(x, z), z, facing(s.dx, s.dz) + rng.range(-0.03, 0.03), 1, rng.range(0.84, 1.02));
    }
  }
  if (take('construction')) {
    const t = t0 - 11;
    const x = s.ax + s.dx * t + s.nx * (kerb - 2.6) * side;
    const z = s.az + s.dz * t + s.nz * (kerb - 2.6) * side;
    b(rng.chance(0.65) ? 'tempSignWork' : 'tempSignDetour')
      .add(x, road(x, z), z, facing(-s.dx, -s.dz), 1, rng.range(0.9, 1.05));
  }
  if (rng.chance(0.45) && take('construction')) {
    const t = t0 + rng.range(2, Math.max(3, L - 4));
    const x = s.ax + s.dx * t + s.nx * (kerb - 1.4) * side;
    const z = s.az + s.dz * t + s.nz * (kerb - 1.4) * side;
    b('skip').add(x, road(x, z), z, facing(s.dx, s.dz) + rng.range(-0.05, 0.05), 1, rng.range(0.9, 1.04));
  }
  // Hoarding + scaffolding on the frontage behind the works.
  if (s.frontage != null && rng.chance(0.55)) {
    const fo = s.frontage - 0.9;
    for (let t = t0; t < t0 + L; t += 2.44) {
      if (!take('construction')) return;
      const x = s.ax + s.dx * t + s.nx * fo * side;
      const z = s.az + s.dz * t + s.nz * fo * side;
      b('hoarding').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.92, 1.02));
    }
    if (rng.chance(0.5)) {
      for (let t = t0; t < t0 + Math.min(L, 12); t += 2.1) {
        if (!take('construction')) return;
        const x = s.ax + s.dx * t + s.nx * (s.frontage - 0.75) * side;
        const z = s.az + s.dz * t + s.nz * (s.frontage - 0.75) * side;
        b('scaffold').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.95, 1.02));
      }
    }
  }
}
