import * as THREE from 'three';
import { geo } from '../core/Geo.js';
import {
  RNG, getPropMaterials, buildFurnitureLibrary, clearGeoCache, PARKED_CARS,
} from './StreetFurniture.js';
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
/**
 * Pavement lip above the carriageway. Mirrors `KERB_H` in Roads.js, which is
 * what actually builds the kerb; duplicated rather than imported so props does
 * not take a hard dependency on a file it does not own.
 */
export const KERB_H = 0.145;

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
    /**
     * Durable suppression, honoured by `refresh()`.
     *
     * This used to be a bare `mesh.visible = false` from `setVisible`, which
     * `refresh()` then silently undid on its next pass (`m.visible = cnt > 0`).
     * That is why 41-52 snow banks stood on a clear August street: the weather
     * gate fired correctly, held for one frame, and was overwritten the moment
     * the camera crossed a chunk boundary. Anything conditional on weather or
     * season must go through here, not through `mesh.visible`.
     */
    this.hidden = false;
    /** Opt in to per-instance LOD for the near tier; see `refresh`. */
    this.splitNear = false;
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

      // Per-instance LOD for the near tier, where the chunk is far coarser than
      // the decision needs to be.
      //
      // A chunk is 96 m across, so "LOD0 within 30 m" really admits every
      // instance in any chunk whose CENTRE is within 30 + 67.9 m — up to 120
      // parked cars at realistic kerb occupancy. That is what forced parked-car
      // density down to ~24% of natural: the only way to keep the detailed
      // 3.5k-triangle body affordable was to place fewer cars. Testing each
      // instance's own distance for the first level costs one hypot over a few
      // hundred instances in the nearest chunks and lets the near tier be a true
      // radius, so the street can be properly parked up and still cheap.
      // Opt-in (`splitNear`) so the other ninety-odd prop types keep the bulk
      // path unchanged.
      if (this.splitNear && li === 0 && L > 1) {
        const r0 = this.lods[0].dist * scale;
        const r0sq = r0 * r0;
        const m0 = this.meshes[0], m1 = this.meshes[1];
        for (let k = 0; k < ch.count; k++) {
          const src = ch.start + k;
          const ix = this.mats[src * 16 + 12], iz = this.mats[src * 16 + 14];
          const ddx = ix - camX, ddz = iz - camZ;
          const near = (ddx * ddx + ddz * ddz) <= r0sq;
          const ti = near ? 0 : 1;
          const tm = near ? m0 : m1;
          const at2 = this._counts[ti];
          tm.instanceMatrix.array.set(
            this.mats.subarray(src * 16, src * 16 + 16), at2 * 16);
          tm.instanceColor.array.set(
            this.cols.subarray(src * 3, src * 3 + 3), at2 * 3);
          this._counts[ti] = at2 + 1;
          const bb = bounds[ti];
          if (ix - 3 < bb.x0) bb.x0 = ix - 3;
          if (ix + 3 > bb.x1) bb.x1 = ix + 3;
          if (iz - 3 < bb.z0) bb.z0 = iz - 3;
          if (iz + 3 > bb.z1) bb.z1 = iz + 3;
        }
        continue;
      }

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
      m.visible = cnt > 0 && !this.hidden;
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

  setVisible(v) {
    this.hidden = !v;
    for (const m of this.meshes) m.visible = v && m.count > 0;
  }

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
    edgeId: opts.edgeId ?? null,
    // Road SURFACE height at each trimmed end, from the road graph polyline —
    // which is what Roads.js actually builds the carriageway from. This is NOT
    // `groundHeight()`; see `surfaceY` below.
    ay: opts.ay ?? null, by: opts.by ?? null,
    // Edge-arc-length fractions the trimmed segment spans, so a caller can ask
    // the road graph for the real elevation at an interior point instead of
    // assuming the grade between `ay` and `by` is linear. It very often is not.
    at: opts.at ?? null, bt: opts.bt ?? null,
    // Kerbside parking bay published by the city: { width, offset }, where
    // offset is the lateral distance from the road centreline to the middle of
    // the bay. Null on streets too narrow to have one.
    parking: opts.parking ?? null,
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
        edgeId: e.id, parking: e.parking || null,
        ay: R.sample(e.id, t)?.y ?? null, by: R.sample(e.id, 1 - t)?.y ?? null,
        at: t, bt: 1 - t,
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
      // `n.y` is the road graph's own surface height at the node — the same
      // datum Roads.js builds the junction from, not the clamped raster.
      x: n.x, z: n.z, y: Number.isFinite(n.y) ? n.y : null,
      major: deg >= 4, district: districtFor(n.x, n.z), legs,
    });
  }
  return finishLayout({ source: 'city', segments, junctions, parks, gh, districtFor, city });
}

/** Shared tail: derive tree sites, park areas and the frontage list. */
function finishLayout(L) {
  /**
   * Height of the DRAWN road surface at a point on (or beside) a segment.
   *
   * `groundHeight()` is not it. `Terrain.stampRoads` deliberately clamps the
   * terrain raster *below* the carriageway so ground cannot poke up through
   * asphalt, and `Roads.js` then builds the road from the graph polyline `y`
   * and the pavement from that plus `KERB_H`. So near any road the raster sits
   * 0.4-1.7 m below what is actually rendered (measured on eight sampled edges:
   * `roads.sample().y - groundHeight()` = 0.40 / 0.40 / 0.40 / 0.41 / 0.41 /
   * 0.48 / 0.59 / 1.66).
   *
   * Placing kerbside furniture at `groundHeight()` therefore buries it. It read
   * as "perfectly aligned" for a long time only because it was being checked
   * against the same clamped raster that caused the problem.
   *
   * Interpolates the surface along the segment chord. Falls back to the raster
   * where a segment has no road graph behind it (the synthesised grid).
   */
  L.surfaceY = (s, x, z) => {
    // The endpoint lerp is a LAST RESORT, not the answer. It assumes the grade
    // between the two segment ends is linear, and on a long edge it is not:
    // edge 314 is a 432 m arterial that sits flat at 3.33 m for its first 200 m
    // and then ramps to 9.91 m, so interpolating its endpoints overshoots the
    // real carriageway by up to 3.40 m across that flat run. That is what left
    // rows of parked cars hanging ~3 m over Tremont Street in the shipped
    // build -- 59.7% of parked instances were more than 1 m high, median 1.87 m.
    //
    // Ask the road mesh what is actually DRAWN at this point instead. That is
    // the same datum `City.surfaceHeight` publishes, it answers per point
    // rather than per segment, and it already carries the crown and the kerb.
    // The lerp is still computed first, because it is the best available
    // `nearY` hint for telling a bridge deck from the street beneath it.
    let lerp = null;
    if (s.ay != null && s.by != null) {
      const t = s.len ? ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len : 0;
      const u = t < 0 ? 0 : t > 1 ? 1 : t;
      lerp = s.ay + (s.by - s.ay) * u;
    }
    const hit = L.city?.roadMesh?.surfaceAt?.(x, z, lerp ?? undefined);
    if (hit) return hit.y;
    // `surfaceAt` answers null when the point is outside the carriageway and its
    // pavement, which happens on curved edges because these segments are the
    // straight CHORD between two nodes: edge 245 is a 643 m curve whose chord
    // leaves a kerbside prop 12 m from the real road. The lateral drift is a
    // separate defect and is not fixed here, but the height need not compound
    // it -- sample the graph's own polyline at the same fraction instead of
    // interpolating the two ends. On that edge the ends are 3.93 m and 20.20 m,
    // so the lerp reads 11.05 m where the road is really 9.91 m.
    const net = L.city?.roads;
    if (net?.sample && s.edgeId != null && s.at != null && s.bt != null) {
      const t2 = s.len ? ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len : 0;
      const u2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
      const y = net.sample(s.edgeId, s.at + u2 * (s.bt - s.at))?.y;
      if (Number.isFinite(y)) return y;
    }
    return lerp != null ? lerp : L.gh(x, z);
  };

  /**
   * A point `d` metres along the segment, taken from the road graph's own
   * polyline rather than the straight chord between its nodes, with the tangent
   * there. Falls back to the chord when the graph cannot answer.
   */
  L.roadPoint = (s, d) => {
    const net = L.city?.roads;
    const u = s.len ? Math.min(1, Math.max(0, d / s.len)) : 0;
    if (net?.sample && s.edgeId != null && s.at != null && s.bt != null) {
      const p = net.sample(s.edgeId, s.at + u * (s.bt - s.at));
      // `RoadNetwork.sample` reports heading as atan2(dx, -dz).
      return { x: p.x, y: p.y, z: p.z, dx: Math.sin(p.heading), dz: -Math.cos(p.heading) };
    }
    return { x: s.ax + s.dx * d, y: L.surfaceY(s, s.ax + s.dx * d, s.az + s.dz * d),
             z: s.az + s.dz * d, dx: s.dx, dz: s.dz };
  };

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
          x, z, y: L.surfaceY(s, x, z) + KERB_H,
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

  // Coarse hash grid over the tree sites so placement can keep furniture out of
  // the pits. The critic listed "a crate through a tree trunk" as an automatic
  // fail, and it is structural rather than unlucky: tree sites sit at
  // `halfRoad + 1.05` and bins, bags, benches and planters sit at
  // `halfRoad + 0.72`, 33 cm away, on the same segments.
  {
    const CELL = 4;
    const grid = new Map();
    const key = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);
    for (const s of sites) {
      const k = key(Math.floor(s.x / CELL), Math.floor(s.z / CELL));
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(s);
    }
    L.nearTree = (x, z, r) => {
      const r2 = r * r;
      const c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL);
      const d0 = Math.floor((z - r) / CELL), d1 = Math.floor((z + r) / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = d0; cz <= d1; cz++) {
          const a = grid.get(key(cx, cz));
          if (!a) continue;
          for (const s of a) {
            const dx = s.x - x, dz = s.z - z;
            if (dx * dx + dz * dz < r2) return true;
          }
        }
      }
      return false;
    };
  }

  // --- Park planting areas ---
  L.parkAreas = L.parks.map(p => ({ ...p, bounds: polyBounds(p.poly) }));

  // --- Frontage lines (building faces) for wall-mounted props ---
  //
  // ONLY the street-facing edge of each parcel. This used to walk all four
  // polygon edges, which put three quarters of every shop sign, fascia, fire
  // escape, A/C unit and wall decal on the sides and *back* of the parcel —
  // buried inside the block, facing a neighbour's party wall, where nothing can
  // ever see them. `RoadNetwork.buildPlots` authors the polygon as
  // [p0, p1, q1, q0] with p0->p1 the kerb line and q = p + inward * depth, so
  // the street edge is edge 0 and the outward normal is exactly -normalize(q0-p0).
  // Deriving it from the parcel's own depth vector rather than from winding is
  // what makes it right for every parcel instead of half of them.
  const front = [];
  const plots = L.city?.plots;
  if (plots && plots.length) {
    for (const pl of plots) {
      const poly = pl.polygon;
      if (!poly || poly.length < 4) continue;
      const a = poly[0], b = poly[1], q0 = poly[3];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (len < 4) continue;
      let ix = q0.x - a.x, iz = q0.z - a.z;          // into the block
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;
      front.push({
        ax: a.x, az: a.z, bx: b.x, bz: b.z, len,
        dx: dx / len, dz: dz / len, nx: -ix, nz: -iz,   // out towards the street
        district: pl.district || 'downtown', maxHeight: pl.maxHeight || 20,
        // Buildings.js bases each building on `plot.y`, not on the terrain under
        // the kerb, so wall-mounted props must use the same datum or they drift
        // off the storey lines on any slope.
        y: Number.isFinite(pl.y) ? pl.y : null,
      });
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
  // `lighting` is an ordering edge, like `materials`' dep on `sky`: init() reaches
  // `_buildLightPool`, which calls `lighting.registerLight` -- and that dereferences
  // a `manager` built inside Lighting.init(). Initialised the other way round it
  // throws, the catch below logs a bare console.info and breaks, and the street-lamp
  // pool is silently gone. Declaring it also keeps Props ahead of Lighting at
  // teardown, where the handles are released.
  static deps = ['assets', 'lighting'];

  async init(ctx) {
    this.ctx = ctx;
    this.M = getPropMaterials(ctx);
    this.lib = buildFurnitureLibrary();
    clearGeoCache();

    this.batcher = new PropBatcher(ctx.scene);
    this.decals = new Decals();
    this.wires = null;
    this._lightPool = [];
    // Handles for the registrations in `_lightPool`. `LightManager.register` returns
    // `{ id, setEnabled, ..., release }`, and the release is the ONLY way to give the
    // slot back -- see `_releaseLightPool`.
    this._lightHandles = [];
    this._lampSites = [];
    this._lastCamX = 1e9; this._lastCamZ = 1e9;
    this._lastScale = -1;
    this._night = 0;
    this._season = 'summer';
    this._weather = ctx.settings.weather;
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
    const spread = populate(this, L, density);
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
    this._spread = spread;
    console.info(`[props] ${n} instances, ${this.batcher.batches.size} types, ` +
      `${this.batcher.stats().meshes} meshes (${L.source} layout, ` +
      `${L.segments.length} segments, ${L.frontage.length} frontages, ` +
      `${L.treeSites.length} tree pits)`);
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
        // A type with no reduced level used to draw its FULL-detail mesh all the
        // way out to `far` — 984-triangle fire escapes at 215 m, 440-triangle
        // tree grates at 130 m seen edge-on. `near` is documented as the range
        // LOD0 is good for, so honour it, with a modest margin so nothing pops
        // out at exactly the authored distance.
        lods[0].dist = Math.min(def.far, def.near * 1.3);
      }
      const bat = this.batcher.batch(name, lods, { receive: def.receive !== false });
      // Parked cars are the one type dense enough for chunk-granular LOD to hurt.
      if (name.startsWith('car')) bat.splitNear = true;
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
        // Keep the handle. Dropping it is what stranded these registrations: a
        // quality change calls `_rebuild`, which scene-removes these anchors and
        // empties `_lightPool`, then rebuilds -- so without the handle the previous
        // N stayed registered forever. `_refreshDynamic` skips a parentless anchor
        // (`!o.parent`), so a stranded one freezes at its last position, but `_select`
        // gates only on F_ENABLED / F_AUTONIGHT / gain -- never on `parent` or
        // `visible` -- so it keeps competing for one of the fifteen real-light slots
        // from wherever it happened to stop.
        const h = lighting.registerLight(o, { type: 'street', range: 26, intensity: 42 });
        this._lightPool.push(o);
        this._lightHandles.push(h);
      } catch (e) {
        ctx.scene.remove(o);
        console.info('[props] lighting.registerLight declined:', e.message);
        break;
      }
    }
  }

  /**
   * Give every pooled street-light registration back and detach its anchor.
   *
   * Symmetric with `_buildLightPool`. Scene-removing the anchor is not enough on its
   * own: the registration outlives it, and an orphan still competes for a real-light
   * slot at a stale position. Idempotent, so a rebuild followed by a dispose is safe.
   */
  _releaseLightPool(ctx) {
    for (const h of this._lightHandles) {
      try { h?.release?.(); } catch { /* manager already gone */ }
    }
    this._lightHandles.length = 0;
    for (const o of this._lightPool) ctx?.scene?.remove(o);
    this._lightPool.length = 0;
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
    this._snow = s === 'winter' || this._weather === 'snow';
    this._applySnow();
    this.decals?.setWeather(this._weather, s);
    this.ctx?.get('vegetation')?.setSeason?.(s);
  }

  setWeather(w) {
    this._weather = w;
    this._snow = w === 'snow' || this._season === 'winter';
    this._applySnow();
    this.decals?.setWeather(w, this._season);
  }

  /**
   * Snow banks are drawn only when there is snow on the ground. Applied
   * unconditionally rather than on a change edge: the old edge-triggered
   * version could not recover if anything else re-showed the batch, and
   * something did — see the `hidden` flag on PropBatch.
   */
  _applySnow() {
    this.batcher.batches.get('snowBank')?.setVisible(this._snow);
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
    this._releaseLightPool(ctx);
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
    this._releaseLightPool(ctx);
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

/**
 * How much of each type's *natural* site list to keep, and a hard ceiling on
 * the instance count.
 *
 * The previous scheme was a flat global counter drained in order, and because
 * `finishLayout` sorts segments and parcels by distance from Boston Common, it
 * spent the entire budget on the few hundred metres nearest the Common and left
 * the other 96 km of street bare. Measured before this change: every shop sign,
 * fascia, fire escape, A/C unit, flag and wall decal in the city lived inside a
 * 340-413 m radius blob; `decal_grimeWall` covered 10 chunks out of 436. Four
 * separate downtown and Back Bay camera positions saw zero of all of them.
 *
 * A rate is not a budget. `keep` is a fraction of the sites the placement rules
 * themselves generate — those rules already encode real spacings (a meter every
 * 6-7 m, a lamp every 34-44 m) — so keep=1 means "as dense as the street really
 * is". The ceiling only exists to bound memory, and is deliberately set above
 * the natural count for anything that should be everywhere.
 *
 * This costs nothing at draw time: instances are chunked and distance-culled,
 * so what is rasterised is set by the LOD radius around the camera, not by how
 * many exist. Spreading the same budget over the whole city actually *lowers*
 * peak triangles near the Common.
 */
const RATE = {
  grate: [1.00, 7000], lamp: [1.00, 2800], meter: [0.80, 7500], hydrant: [1.00, 1000],
  bin: [1.00, 1300], bench: [1.00, 700], bikeRack: [1.00, 700], bollard: [0.85, 1600],
  mailbox: [1.00, 160], newsBox: [1.00, 500], utilityBox: [1.00, 260],
  manhole: [1.00, 2200], drain: [1.00, 4200], sign: [0.85, 6000],
  pole: [1.00, 900], shelter: [1.00, 90], dock: [1.00, 40], planter: [1.00, 700],
  litter: [0.80, 900], construction: [1.00, 70],
  attach: [1.00, 24000], signal: [1.00, 1600], parked: [1.00, 30000],
};

function populate(sys, L, density) {
  // Two passes. The first walks every placement rule with a `take` that only
  // counts, so we learn how many sites each type actually has across the whole
  // city; the second walks the identical rules with an acceptance probability
  // of budget/sites. Same code path both times — a counting pass that diverged
  // from the placing pass would be worse than no spreading at all.
  const cand = {};
  for (const k of Object.keys(RATE)) cand[k] = 0;
  runPlacement(sys, L, true, (k, n = 1) => { cand[k] += n; return true; });

  const rng = new RNG(918273);
  const left = {}, prob = {};
  for (const k of Object.keys(RATE)) {
    const [keep, cap] = RATE[k];
    const want = Math.min(keep, cand[k] > 0 ? (cap * density) / cand[k] : 0) * density;
    prob[k] = Math.min(1, want);
    left[k] = Math.ceil(cap * density);
  }
  runPlacement(sys, L, false, (k, n = 1) => {
    if (left[k] < n) return false;
    if (prob[k] < 1 && rng.f() > prob[k]) return false;
    left[k] -= n;
    return true;
  });
  return { cand, prob };
}

/** No-op stand-in for a batch during the counting pass. */
const NULL_BATCH = { add() { return this; } };

/**
 * @param {boolean} counting  true on the sizing pass: nothing is placed and no
 *        side list (lamp sites, wire runs) is appended to.
 * @param {(k:string, n?:number)=>boolean} take
 */
function runPlacement(sys, L, counting, take) {
  const B = sys.batcher;
  const g = (x, z) => L.gh(x, z) + L.kerb;
  const road = (x, z) => L.gh(x, z);
  const b = counting ? () => NULL_BATCH : (name) => B.batches.get(name);

  // ---- Tree pit grates: exactly one per street tree site -------------------
  {
    const grate = b('treeGrate');
    for (const s of L.treeSites) {
      if (!take('grate')) continue;
      grate.add(s.x, s.y + 0.005, s.z, s.rot, 1, 0.9 + (s.scale - 1) * 0.1);
    }
  }

  // ---- Along-street furniture ---------------------------------------------
  let si = 0;
  for (const s of L.segments) {
    const rng = new RNG(50021 + (si++) * 3607);
    // Shadow the raster-based helpers with surface-based ones for the whole of
    // this segment's placement: `road` is the drawn carriageway, `g` the drawn
    // pavement. Everything kerbside was previously buried ~0.4 m — see
    // `L.surfaceY`.
    const road = (x, z) => L.surfaceY(s, x, z);
    const g = (x, z) => L.surfaceY(s, x, z) + KERB_H;
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
        if (take('lamp')) {
          const off = type === 'lampCobra' ? kerb + 0.65 : furn;
          const x = s.ax + s.dx * t + s.nx * off * side;
          const z = s.az + s.dz * t + s.nz * off * side;
          // Cobra arms reach over the road; acorns face the footway.
          const ry = facing(-s.nx * side, -s.nz * side);
          bat.add(x, g(x, z), z, ry + rng.range(-0.03, 0.03), rng.range(0.97, 1.03),
            rng.range(0.88, 1.06));
          if (!counting) {
            sys._lampSites.push({ x, y: g(x, z) + (type === 'lampCobra' ? 9.2 : 3.85), z });
          }
        }
        side = -side;
      }
    }

    // --- Kerbside parking: meters, or a pay station for the whole face ---
    const metered = !heritage ? rng.chance(0.55) : rng.chance(0.75);
    if (metered && s.type !== 'arterial') {
      for (const side of [-1, 1]) {
        if (rng.chance(0.35)) continue;
        if (rng.chance(0.12)) {
          if (take('meter')) {
            const t = rng.range(8, Math.max(9, s.len - 8));
            const x = s.ax + s.dx * t + s.nx * (kerb + 0.6) * side;
            const z = s.az + s.dz * t + s.nz * (kerb + 0.6) * side;
            b('payStation').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.05));
          }
          continue;
        }
        for (let t = rng.range(7, 12); t < s.len - 7; t += rng.range(6.0, 7.2)) {
          if (!take('meter')) continue;
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
        if (!take('sign')) continue;
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
    // Nothing bulky goes inside a tree pit: `clear` is the automatic-fail guard
    // for "a crate through a tree trunk". Tree sites and kerbside furniture are
    // authored 33 cm apart on the same segments, so without this they collide by
    // construction rather than by bad luck.
    const clear = (x, z, r) => !L.nearTree(x, z, r);
    for (let t = rng.range(20, 70); t < s.len - 10; t += rng.range(70, 130)) {
      if (!take('hydrant')) continue;
      const side = rng.sign();
      const x = s.ax + s.dx * t + s.nx * (kerb + 0.62) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 0.62) * side;
      if (!clear(x, z, 1.25)) continue;
      b(rng.chance(0.55) ? 'hydrantY' : 'hydrantR')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side) + rng.range(-0.2, 0.2),
          1, rng.range(0.86, 1.08));
    }
    for (let t = rng.range(14, 50); t < s.len - 8; t += rng.range(48, 105)) {
      if (!take('bin')) continue;
      const side = rng.sign();
      const x = s.ax + s.dx * t + s.nx * furn * side;
      const z = s.az + s.dz * t + s.nz * furn * side;
      if (!clear(x, z, 1.5)) continue;
      b(busy && rng.chance(0.6) ? 'bigBelly' : 'wireBin')
        .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side) + rng.range(-0.25, 0.25),
          1, rng.range(0.88, 1.05));
      if (rng.chance(0.45) && take('litter')) {
        const bx = x + s.dx * rng.range(-1.4, 1.4), bz = z + s.dz * rng.range(-1.4, 1.4);
        if (clear(bx, bz, 1.35)) {
          b('binBags').add(bx, g(bx, bz), bz, rng.range(0, 6.28), rng.range(0.8, 1.15), rng.range(0.8, 1.05));
        }
      }
    }
    if (rng.chance(0.30) && take('bench')) {
      const side = rng.sign(); const t = rng.range(10, Math.max(11, s.len - 10));
      const x = s.ax + s.dx * t + s.nx * (back - 0.5) * side;
      const z = s.az + s.dz * t + s.nz * (back - 0.5) * side;
      if (clear(x, z, 1.9)) {
        b('bench').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.05));
      }
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
        if (!take('newsBox')) continue;
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
      if (clear(x, z, 1.6)) {
        b(rng.chance(0.5) ? 'utilityBoxA' : 'utilityBoxB')
          .add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.9, 1.06));
      }
    }
    if (heritage && rng.chance(0.34)) {
      const side = rng.sign(); const t = rng.range(8, Math.max(9, s.len - 8));
      const n = 2 + rng.int(4);
      for (let k = 0; k < n; k++) {
        if (!take('bollard')) continue;
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
      if (clear(x, z, 1.5)) {
        b('planter').add(x, g(x, z), z, rng.range(0, 6.28), rng.range(0.9, 1.1), rng.range(0.86, 1.06));
      }
    }

    // --- Roadway: manholes, gutter drains ---
    for (let t = rng.range(8, 30); t < s.len - 6; t += rng.range(28, 55)) {
      if (!take('manhole')) continue;
      const off = rng.range(-kerb * 0.6, kerb * 0.6);
      const x = s.ax + s.dx * t + s.nx * off;
      const z = s.az + s.dz * t + s.nz * off;
      b('manhole').add(x, road(x, z) + 0.004, z, rng.range(0, 6.28), rng.range(0.96, 1.04),
        rng.range(0.8, 1.05));
    }
    for (const side of [-1, 1]) {
      for (let t = rng.range(15, 45); t < s.len - 8; t += rng.range(38, 70)) {
        if (!take('drain')) continue;
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
        if (!take('pole')) continue;
        const x = s.ax + s.dx * t + s.nx * (kerb + 0.5) * side;
        const z = s.az + s.dz * t + s.nz * (kerb + 0.5) * side;
        const tx = rng.chance(0.3);
        b(tx ? 'utilityPoleTx' : 'utilityPole').add(x, g(x, z), z,
          facing(s.dx, s.dz) + rng.range(-0.05, 0.05), rng.range(0.94, 1.08), rng.range(0.82, 1.02));
        run.push({ x, y: g(x, z) + 9.45, z, dx: s.dx, dz: s.dz });
      }
      if (!counting && run.length > 1) (sys._wireRuns || (sys._wireRuns = [])).push(run);
    }

    // --- Bus shelters on arterials ---
    if (s.type === 'arterial' && rng.chance(0.22) && take('shelter')) {
      const side = rng.sign();
      const t = rng.range(14, Math.max(15, s.len - 14));
      const x = s.ax + s.dx * t + s.nx * (kerb + 1.5) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 1.5) * side;
      if (clear(x, z, 3.2)) {
        b('busShelter').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, 1);
      }
    }
    if (rng.chance(0.05) && take('dock')) {
      const side = rng.sign();
      const t = rng.range(10, Math.max(11, s.len - 16));
      const x = s.ax + s.dx * t + s.nx * (kerb + 1.0) * side;
      const z = s.az + s.dz * t + s.nz * (kerb + 1.0) * side;
      b('bluebikes').add(x, g(x, z), z, facing(s.dx, s.dz), 1, 1);
    }

    // --- Construction. Boston is permanently dug up; lean into it. ---
    if (rng.chance(0.11) && take('construction')) placeConstruction(sys, s, rng, b, g, road);

    // --- Parked cars ------------------------------------------------------
    //
    // The single biggest density win at street level: a real city street is
    // mostly parked cars, and before this there was no parked-car prop type at
    // all, so no street could ever be lined with them.
    //
    // They sit in the city's own kerbside parking bay. This used to be a
    // heuristic (`halfRoad >= 2.9`, cars pushed 0.80 m off the kerb) because the
    // road graph spent its whole width on travel lanes and left a car no legal
    // place to stand — measured overlap with the outer lane was up to 0.64 m.
    // The city now publishes `edge.parking = { width, offset }` on 463 of 526
    // edges, so a car goes exactly where a bay is and nowhere else, and the
    // travel lanes are clear by construction.
    if (s.parking && s.type !== 'alley') {
      const off = s.parking.offset;
      // Arterials in the core are tow-away at rush hour and a little emptier —
      // but only a little. These were low enough (0.66) that a North End
      // arterial had 5 parked cars within 40 m of the camera while its
      // neighbours had 11-18, which reads as a street nobody parks on.
      const fill = s.type === 'arterial' ? (busy ? 0.80 : 0.89) : 0.94;
      for (const side of [-1, 1]) {
        // Cars face the direction of travel on their own side of the road.
        // NOTE the extra half turn: `facing` aims the model's local +Z along the
        // street, but a VehicleModels body is lofted with its FRONT at -Z
        // (measured: head lamp anchors at z -2.31, tail lamps at +2.34). Without
        // this every parked car in the city faces backwards, tail lights first.
        let t = rng.range(2, 8);
        while (t < s.len - 6) {
          if (!rng.chance(fill)) { t += rng.range(4.0, 9.0); continue; }   // driveway, hydrant, loading
          const [name, carLen] = PARKED_CARS[rng.int(PARKED_CARS.length)];
          if (take('parked')) {
            // Follow the ROAD, not the chord. `s.ax/s.dx` is the straight line
            // between the two nodes; the carriageway is `edge.pts`. On a curve
            // that put cars up to 12 m off the road -- measured on edge 245, a
            // 643 m arc -- where they came down on whatever was underneath and
            // read as parked on the pavement or in mid air. It also gave every
            // car on the segment ONE shared heading, because `ry` used to be
            // computed once from the chord outside this loop.
            const P = L.roadPoint(s, t + carLen / 2);
            const ry = facing(P.dx, P.dz) + (side > 0 ? Math.PI : 0)
              + rng.range(-0.022, 0.022);
            const x = P.x - P.dz * off * side;
            const z = P.z + P.dx * off * side;
            // Sit it on the surface under its own wheels. A single centre height
            // leaves a level car on a graded or cambered street with one end in
            // the air: measured across the four contact patches, the road climbs
            // up to 0.265 m over one wheelbase. Sampling the drawn surface at
            // each end and fitting a plane is what actually puts four tyres down.
            // Local +Z and +X in world terms follow from `ry`, so the signs hold
            // for both sides of the street without a special case.
            const halfL = carLen * 0.30, halfW = 0.72;
            const zx = Math.sin(ry), zz = Math.cos(ry);
            const xx = Math.cos(ry), xz = -Math.sin(ry);
            const hAt = (ax, az) => {
              const hh = L.city?.roadMesh?.surfaceAt?.(x + ax, z + az, P.y);
              return hh ? hh.y : road(x + ax, z + az);
            };
            const hPz = hAt(zx * halfL, zz * halfL), hMz = hAt(-zx * halfL, -zz * halfL);
            const hPx = hAt(xx * halfW, xz * halfW), hMx = hAt(-xx * halfW, -xz * halfW);
            b(name).add(x, (hPz + hMz + hPx + hMx) / 4, z, ry, 1,
              rng.range(0.86, 1.06),
              Math.atan2(hMz - hPz, 2 * halfL), Math.atan2(hPx - hMx, 2 * halfW));
          }
          t += carLen + rng.range(0.55, 1.9);
        }
      }
    }

    // --- Building frontage attachments happen in their own pass ---
  }

  // ---- Junction furniture -------------------------------------------------
  let ji = 0;
  for (const j of L.junctions) {
    const rng = new RNG(90001 + (ji++) * 5171);
    const legs = j.legs;
    if (!legs.length) continue;
    // Same surface-vs-raster correction as the segment loop.
    const road = j.y != null ? () => j.y : (x, z) => L.gh(x, z);
    const g = j.y != null ? () => j.y + KERB_H : (x, z) => L.gh(x, z) + L.kerb;

    if (j.major) {
      // Two mast arms on opposing approaches, the usual US arrangement.
      const picks = legs.length >= 4 ? [0, 2] : [0];
      for (const li of picks) {
        if (!take('signal')) continue;
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
        if (!take('signal')) continue;
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
        if (!take('sign')) continue;
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
      if (!take('drain')) continue;
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
    // Boston row parcels are 7-8 m wide, so an 8 m floor excluded most of Beacon
    // Hill, the North End and the South End from ever getting a shopfront.
    if (f.len < 5) continue;
    const commercial = f.district === 'financial' || f.district === 'downtown'
      || f.district === 'northEnd' || f.district === 'backBay' || rng.chance(0.4);

    for (let t = rng.range(1.5, 5); t < f.len - 2; t += rng.range(5, 11)) {
      const x = f.ax + f.dx * t, z = f.az + f.dz * t;
      const ry = facing(f.nx, f.nz);
      const y0 = f.y != null ? f.y : L.gh(x, z);
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
      // Upper floors. Capped at four: window A/C and fire escapes are a
      // low-rise signature, and letting a 240 m Financial District tower emit
      // six per bay per storey made A/C units half the whole attachment budget.
      const floors = Math.max(1, Math.min(4, Math.floor((f.maxHeight - 4) / 3.4)));
      for (let fl = 1; fl <= floors; fl++) {
        const y = y0 + 3.6 + (fl - 1) * 3.35;
        if (rng.chance(0.17) && take('attach')) {
          b('acUnit').add(x + f.nx * 0.02, y + 1.05, z + f.nz * 0.02, ry, rng.range(0.9, 1.05));
        }
        if (fl === 1 && rng.chance(0.14) && take('attach')) {
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

  // ---- Winter kerbside snow banks -----------------------------------------
  //
  // These are only ever drawn when `Props._snow` is set — snow weather, or a
  // winter season. They were previously visible in clear weather in August
  // because `setVisible` was undone by the next `PropBatch.refresh`; see the
  // `hidden` flag on PropBatch. They also used to be authored at
  // `halfRoad - 0.2`, i.e. *inside* the carriageway, which is why the critic
  // found them standing in the middle of the road and intersecting a handrail.
  // A plough throws snow onto the kerb line, not into the traffic lane.
  {
    let k = 0;
    for (const s of L.segments) {
      const rng = new RNG(60013 + (k++) * 1231);
      if (rng.chance(0.55)) continue;
      for (const side of [-1, 1]) {
        for (let t = rng.range(5, 20); t < s.len - 5; t += rng.range(22, 42)) {
          const x = s.ax + s.dx * t + s.nx * (s.halfRoad + 0.34) * side;
          const z = s.az + s.dz * t + s.nz * (s.halfRoad + 0.34) * side;
          b('snowBank').add(x, road(x, z), z, facing(s.dx, s.dz), rng.range(0.8, 1.3), rng.range(0.94, 1.02));
        }
      }
      if (k > 420) break;
    }
  }
}

/**
 * A works zone: barriers, cones, drums, signage, and something being dug up.
 *
 * The whole zone is one `take`, decided by the caller. Per-item takes made
 * half-built works zones — a cone taper leading to nothing — once the budget
 * became probabilistic.
 */
function placeConstruction(sys, s, rng, b, g, road) {
  const side = rng.sign();
  const t0 = rng.range(6, Math.max(7, s.len - 26));
  const L = Math.min(s.len - t0 - 4, rng.range(12, 26));
  const kerb = s.halfRoad;
  const lane = kerb - 1.9;

  // Taper of cones leading in, then a run of drums along the closed lane.
  for (let i = 0; i < 7; i++) {
    const t = t0 - 8 + i * 1.5;
    const off = (kerb - 3.4) + (i / 6) * 1.5;
    const x = s.ax + s.dx * t + s.nx * off * side;
    const z = s.az + s.dz * t + s.nz * off * side;
    b('cone').add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.94, 1.06), rng.range(0.75, 1.02));
  }
  for (let t = t0; t < t0 + L; t += rng.range(3.0, 4.6)) {
    const x = s.ax + s.dx * t + s.nx * lane * side;
    const z = s.az + s.dz * t + s.nz * lane * side;
    if (rng.chance(0.45)) {
      b('barrel').add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.95, 1.05), rng.range(0.8, 1.02));
    } else {
      b('jersey').add(x, road(x, z), z, facing(s.dx, s.dz) + rng.range(-0.03, 0.03), 1, rng.range(0.84, 1.02));
    }
  }
  {
    const t = t0 - 11;
    const x = s.ax + s.dx * t + s.nx * (kerb - 2.6) * side;
    const z = s.az + s.dz * t + s.nz * (kerb - 2.6) * side;
    b(rng.chance(0.65) ? 'tempSignWork' : 'tempSignDetour')
      .add(x, road(x, z), z, facing(-s.dx, -s.dz), 1, rng.range(0.9, 1.05));
  }
  if (rng.chance(0.45)) {
    const t = t0 + rng.range(2, Math.max(3, L - 4));
    const x = s.ax + s.dx * t + s.nx * (kerb - 1.4) * side;
    const z = s.az + s.dz * t + s.nz * (kerb - 1.4) * side;
    b('skip').add(x, road(x, z), z, facing(s.dx, s.dz) + rng.range(-0.05, 0.05), 1, rng.range(0.9, 1.04));
  }
  // Hoarding + scaffolding on the frontage behind the works.
  if (s.frontage != null && rng.chance(0.55)) {
    const fo = s.frontage - 0.9;
    for (let t = t0; t < t0 + L; t += 2.44) {
      const x = s.ax + s.dx * t + s.nx * fo * side;
      const z = s.az + s.dz * t + s.nz * fo * side;
      b('hoarding').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.92, 1.02));
    }
    if (rng.chance(0.5)) {
      for (let t = t0; t < t0 + Math.min(L, 12); t += 2.1) {
        const x = s.ax + s.dx * t + s.nx * (s.frontage - 0.75) * side;
        const z = s.az + s.dz * t + s.nz * (s.frontage - 0.75) * side;
        b('scaffold').add(x, g(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.95, 1.02));
      }
    }
  }
}
