import * as THREE from 'three';
import { geo, WORLD } from '../core/Geo.js';
import { HILLS, WATER } from '../data/boston-geo.js';

/**
 * Ground elevation and the mesh that shows it.
 *
 * Boston is almost entirely made land — the Back Bay, the South End, the
 * Seaport and half of downtown are 19th-century fill over tidal flats, so they
 * are flat and low. The relief that survives is the drumlins: Beacon Hill,
 * Bunker Hill, Copp's Hill. Those have to actually climb, because the streets
 * on them climb and that is what the place feels like.
 *
 * Everything is baked once into a raster and sampled bilinearly. That makes
 * `groundHeight()` O(1), branch-free and — critically — identical for every
 * system that asks, so roads, buildings, peds and physics never disagree.
 */

const CELL = 10;                                 // raster resolution, metres
const PAD = 400;                                 // raster overhang past the play area
const MINX = WORLD.minX - PAD, MINZ = WORLD.minZ - PAD;
const SPAN = (WORLD.maxX - WORLD.minX) + PAD * 2;
const NX = Math.round(SPAN / CELL) + 1;          // 681 x 681
const BASE_LAND = 3.9;                           // mean height of the filled ground

// --- deterministic value noise ---------------------------------------------
function hash2(x, y) {
  // Math.imul, not `*`: the float product of two 32-bit constants overflows 2^53
  // and silently drops the low bits, which correlates the noise along diagonals
  // and shows up as smeared banding across large flat surfaces.
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c - a) + (d - c) * u - (b - a) * u) * v;
}
function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * amp; amp *= 0.5; f *= 2.03; }
  return s;
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Squared distance from p to segment ab, plus the closest-point parameter. */
function segDist2(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const wx = px - ax, wz = pz - az;
  const L = vx * vx + vz * vz;
  let t = L > 1e-9 ? (wx * vx + wz * vz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dz = wz - vz * t;
  return dx * dx + dz * dz;
}

export default class Terrain {
  constructor() {
    this.height = new Float32Array(NX * NX);
    this.waterLevel = new Float32Array(NX * NX);   // -1e4 where dry
    this.bodies = [];                              // prepared water polygons
    this.meshes = [];
  }

  // -- build ----------------------------------------------------------------

  /** Project every water ring to world space once and cache bounds + edges. */
  _prepWater() {
    for (const w of WATER) {
      const pts = w.ring.map(([la, lo]) => geo(la, lo));
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (const p of pts) {
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
      }
      this.bodies.push({ ...w, pts, minx, minz, maxx, maxz });
    }
  }

  /** Signed distance to a prepared polygon. Positive inside. */
  static _sdf(b, x, z) {
    const p = b.pts;
    let best = Infinity, inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const d2 = segDist2(x, z, p[j].x, p[j].z, p[i].x, p[i].z);
      if (d2 < best) best = d2;
      if ((p[i].z > z) !== (p[j].z > z) &&
          x < (p[j].x - p[i].x) * (z - p[i].z) / (p[j].z - p[i].z) + p[i].x) inside = !inside;
    }
    const d = Math.sqrt(best);
    return inside ? d : -d;
  }

  bake() {
    this._prepWater();
    const H = this.height, W = this.waterLevel;
    const hills = HILLS.map(h => ({ ...geo(h.lat, h.lon), h: h.height, r: h.radius, s: h.sharp }));

    for (let j = 0; j < NX; j++) {
      const z = MINZ + j * CELL;
      for (let i = 0; i < NX; i++) {
        const x = MINX + i * CELL;
        const k = j * NX + i;

        // Rolling fill-land base. Low amplitude: this is a tidal flat with
        // gravel on top, not a landscape.
        let y = BASE_LAND
          + fbm(x * 0.0016, z * 0.0016, 4) * 3.4 - 1.4
          + fbm(x * 0.014, z * 0.014, 2) * 0.30;

        // Drumlins.
        for (let n = 0; n < hills.length; n++) {
          const hl = hills[n];
          const dx = x - hl.x, dz = z - hl.z;
          const t = Math.sqrt(dx * dx + dz * dz) / hl.r;
          if (t >= 1) continue;
          // cos^s falloff: rounded crown, steep flanks, flat runout at the toe
          y += hl.h * Math.pow(0.5 + 0.5 * Math.cos(t * Math.PI), hl.s);
        }

        // Water: cut a bed, and lift a bank just outside the shoreline.
        let wl = -1e4;
        for (let n = 0; n < this.bodies.length; n++) {
          const b = this.bodies[n];
          if (x < b.minx - 90 || x > b.maxx + 90 || z < b.minz - 90 || z > b.maxz + 90) continue;
          const sd = Terrain._sdf(b, x, z);
          if (sd > 0) {
            const bed = (b.level - 0.45) - b.depth * smooth(sd / 70);
            if (bed < y) y = bed;
            if (b.level > wl) wl = b.level;
          } else if (sd > -34) {
            // bank: blend the surrounding ground down to just above the waterline
            const t = smooth((-sd) / 34);
            y = (b.level + 0.55) * (1 - t) + y * t;
          }
        }
        H[k] = y;
        W[k] = wl;
      }
    }
  }

  /**
   * Flatten the ground under the street network.
   *
   * Roads are built by smoothing an elevation profile along each polyline, so
   * on undulating fill they cut and fill by a few tens of centimetres — which
   * means the raw terrain pokes up through the carriageway. Stamping the
   * corridor back into the raster makes `groundHeight()` agree with the road
   * surface exactly, and has the happy side effect of removing the ground
   * ripple from under every street in the city.
   *
   * Three zones per station: carriageway (set just below the gutter), pavement
   * (set just below the kerb top), then a blend back to natural ground.
   * @param {import('./RoadNetwork.js').default} net
   */
  stampRoads(net) {
    const H = this.height;
    const BLEND = 11;
    // A raster cell is 10 m across and a Boston side street is 7 m wide, so the
    // stamp has to reach a full cell past the kerb: every cell that a point on
    // the carriageway can bilinearly sample from must be clamped, or the ground
    // interpolates straight back up through the asphalt.
    const NEAR = CELL * 1.1;
    // Out past the fine ring the ground mesh is 36 m per quad, so the stamp has
    // to reach that far or the coarse triangles interpolate back up through the
    // carriageway (Main Street Charlestown, 19 cm).
    const FAR = 40;
    for (const e of net.edges) {
      if (e.bridged) continue;
      const rad = Math.max(Math.abs(e.pts[0].x), Math.abs(e.pts[0].z));
      const REACH = rad > 1400 ? FAR : NEAR;
      const zA = e.halfRoad + 0.25 + REACH;               // never above the gutter
      const zB = zA + REACH + (e.walk > 0.3 ? e.walk : 0); // never above the kerb top
      const outer = zB + BLEND;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - outer - MINX) / CELL));
        const i1 = Math.min(NX - 1, Math.ceil((Math.max(a.x, b.x) + outer - MINX) / CELL));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - outer - MINZ) / CELL));
        const j1 = Math.min(NX - 1, Math.ceil((Math.max(a.z, b.z) + outer - MINZ) / CELL));
        const vx = b.x - a.x, vz = b.z - a.z;
        const L2 = vx * vx + vz * vz || 1;
        for (let j = j0; j <= j1; j++) {
          const z = MINZ + j * CELL;
          for (let i2 = i0; i2 <= i1; i2++) {
            const x = MINX + i2 * CELL;
            let t = ((x - a.x) * vx + (z - a.z) * vz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = x - (a.x + vx * t), dz = z - (a.z + vz * t);
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > outer) continue;
            const y = a.y + (b.y - a.y) * t;
            const k = j * NX + i2;
            // Lowest wins, so two streets crossing never fight over a cell.
            let cap;
            // A coarser ring interpolates over a longer span, so it needs more
            // clearance under the carriageway to stay beneath it.
            if (d <= zA) cap = y - (REACH > 20 ? 0.75 : 0.40);
            else if (d <= zB) cap = y + 0.02;
            else cap = y + 0.02 + (d - zB) * (1 / BLEND) * Math.max(0, H[k] - y);
            if (cap < H[k]) H[k] = cap;
          }
        }
      }
    }
  }

  // -- query ----------------------------------------------------------------

  /**
   * Terrain elevation in metres. The single source of truth — roads, buildings,
   * physics and AI all come through here.
   * @param {number} x @param {number} z @returns {number}
   */
  groundHeight(x, z) {
    let fx = (x - MINX) / CELL, fz = (z - MINZ) / CELL;
    fx = fx < 0 ? 0 : fx > NX - 1.001 ? NX - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > NX - 1.001 ? NX - 1.001 : fz;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const H = this.height, r0 = j * NX + i, r1 = r0 + NX;
    const a = H[r0] + (H[r0 + 1] - H[r0]) * tx;
    const b = H[r1] + (H[r1 + 1] - H[r1]) * tx;
    return a + (b - a) * tz;
  }

  /** Water surface level at a point, or null if dry land. */
  waterAt(x, z) {
    let fx = Math.round((x - MINX) / CELL), fz = Math.round((z - MINZ) / CELL);
    if (fx < 0 || fz < 0 || fx >= NX || fz >= NX) return null;
    const w = this.waterLevel[fz * NX + fx];
    return w < -1000 ? null : w;
  }

  /** Uphill gradient, used for camber and for tilting props to the slope. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = CELL;
    const hx = this.groundHeight(x + e, z) - this.groundHeight(x - e, z);
    const hz = this.groundHeight(x, z + e) - this.groundHeight(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // -- mesh -----------------------------------------------------------------

  /**
   * One grid patch. `hole` carves out the middle so rings nest without overlap
   * (an overlapping inner/outer terrain ring is a classic z-fighting source).
   *
   * `half`, `step` and `hole` must satisfy `2*half % step === 0` and
   * `(half + hole) % step === 0`, so a vertex lands exactly on the hole
   * boundary and the ring abuts its neighbour instead of leaving a gap. See
   * RINGS below — getting this wrong opened a 2 m and a 100 m hole right around
   * the city, through which you could see the back of the sky dome.
   */
  _patch(half, step, hole = 0, tile = 24, surf = null, skirt = 0) {
    const n = Math.round((half * 2) / step);
    if (Math.abs((half * 2) / step - n) > 1e-6) {
      console.warn(`[terrain] ring ${half}/${step} is not grid-aligned`);
    }
    const pos = [], nrm = [], uv = [], col = [], idx = [];
    const map = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const c = new THREE.Color();
    let v = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -half + i * step, z = -half + j * step;
        if (hole > 0 && Math.abs(x) < hole - 1e-3 && Math.abs(z) < hole - 1e-3) continue;
        const y = this.groundHeight(x, z);
        map[j * (n + 1) + i] = v++;
        pos.push(x, y, z);
        const e = step * 0.5;
        const hx = this.groundHeight(x + e, z) - this.groundHeight(x - e, z);
        const hz = this.groundHeight(x, z + e) - this.groundHeight(x, z - e);
        const nl = Math.hypot(-hx, 2 * e, -hz);
        nrm.push(-hx / nl, 2 * e / nl, -hz / nl);
        uv.push(x / tile, z / tile);
        // Grass on the flats, dry dirt on steep flanks, silt near the water.
        const slope = Math.min(1, Math.hypot(hx, hz) / (2 * e) * 1.6);
        const wet = 1 - Math.min(1, Math.max(0, (y - 1.2) / 2.4));
        const tint = fbm(x * 0.006, z * 0.006, 3);
        // Downtown Boston is not built on a lawn. Only parks, the riverbank and
        // the outskirts get green; everything between the buildings reads as
        // the grey-brown of yard, gravel and packed dirt it actually is.
        const green = surf ? surf(x, z) : 1;
        const gr = 0.118 + slope * 0.20 + wet * 0.09 + tint * 0.055;
        const gg = 0.152 + slope * 0.13 + wet * 0.05 + tint * 0.070;
        const gb = 0.076 + slope * 0.08 + wet * 0.06 + tint * 0.030;
        const dr = 0.108 + slope * 0.10 + tint * 0.048;
        c.setRGB(
          dr + (gr - dr) * green,
          (dr * 0.97) + (gg - dr * 0.97) * green,
          (dr * 0.90) + (gb - dr * 0.90) * green);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = map[j * (n + 1) + i], b = map[j * (n + 1) + i + 1];
        const d = map[(j + 1) * (n + 1) + i], e2 = map[(j + 1) * (n + 1) + i + 1];
        if (a < 0 || b < 0 || d < 0 || e2 < 0) continue;
        idx.push(a, d, b, b, d, e2);
      }
    }
    // Perimeter skirt. Neighbouring rings meet on the same grid line but sample
    // the ground at different densities, so the shared edge can differ by a few
    // centimetres over a 54 m span. A wall hanging down from the edge means any
    // residual hairline shows ground, never sky.
    if (skirt > 0) {
      const edge = [];
      for (let i = 0; i <= n; i++) edge.push([i, 0]);
      for (let j = 1; j <= n; j++) edge.push([n, j]);
      for (let i = n - 1; i >= 0; i--) edge.push([i, n]);
      for (let j = n - 1; j >= 1; j--) edge.push([0, j]);
      edge.push(edge[0]);
      let prevTop = -1, prevBot = -1;
      for (const [i, j] of edge) {
        const src = map[j * (n + 1) + i];
        if (src < 0) { prevTop = -1; continue; }
        const x = pos[src * 3], y = pos[src * 3 + 1], z = pos[src * 3 + 2];
        const top = v++;
        pos.push(x, y, z); nrm.push(0, 1, 0); uv.push(x / tile, z / tile);
        col.push(col[src * 3], col[src * 3 + 1], col[src * 3 + 2]);
        const bot = v++;
        pos.push(x, y - skirt, z); nrm.push(0, 1, 0); uv.push(x / tile, (z - skirt) / tile);
        col.push(col[src * 3] * 0.7, col[src * 3 + 1] * 0.7, col[src * 3 + 2] * 0.7);
        if (prevTop >= 0) idx.push(prevTop, prevBot, top, top, prevBot, bot);
        prevTop = top; prevBot = bot;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /** Build the nested LOD rings and add them to the scene. */
  build(scene, material, surf = null) {
    // The materials library's convention: uv 1.0 spans `tileMeters` of world
    // surface. Ignoring it stretched grass over 24 m and turned turf into a
    // large blotchy crackle. Coarser rings tile proportionally larger so the
    // texture does not alias into shimmer at distance.
    const tile = material?.userData?.tileMeters || 4;
    const [C, M, F] = Terrain.RINGS;
    const core = this._patch(C.half, C.step, 0, tile, surf, 4);
    const mid = this._patch(M.half, M.step, M.hole, tile * 4, surf, 8);
    const far = this._patch(F.half, F.step, F.hole, tile * 40, null, 0);
    for (const g of [core, mid, far]) {
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.name = 'terrain';
      scene.add(m);
      this.meshes.push(m);
    }
    // Terrain does not cast: it would re-render the whole core patch into the
    // shadow map for silhouettes that buildings already provide.
    return this.meshes;
  }

  /**
   * A single Rapier heightfield for the whole world — vastly cheaper than a
   * trimesh and exactly consistent with `groundHeight()`.
   */
  addCollider(physics) {
    const R = physics.RAPIER;
    const N = 300;                               // 300 x 300 cells over 6.8 km
    const span = SPAN;
    const heights = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) {
      const z = MINZ + (j / N) * span;
      for (let i = 0; i <= N; i++) {
        // column-major: heights[col * (nrows+1) + row]
        heights[j * (N + 1) + i] = this.groundHeight(MINX + (i / N) * span, z);
      }
    }
    const body = physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    const desc = R.ColliderDesc
      .heightfield(N, N, heights, { x: span, y: 1, z: span })
      .setTranslation(MINX + span / 2, 0, MINZ + span / 2)
      .setFriction(0.98);
    physics.world.createCollider(desc, body);
    this.collider = body;
    return body;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.parent?.remove(m); }
    this.meshes.length = 0;
  }
}

/**
 * Nested LOD rings, chosen so the seams are exact.
 *
 * Each ring must satisfy `2*half % step === 0` (so the grid is symmetric about
 * the origin) and `(half + hole) % step === 0` (so a vertex lands exactly on the
 * hole boundary). Pick these by eye and the rings miss each other: the previous
 * set left a 2 m gap at 1506 and a 100 m gap at 3200, both full perimeter
 * rings, through which you could see the back of the sky dome.
 *
 *   core 1458 / 18 : the fine ring. 18 m is the coarsest spacing at which the
 *                    road stamp still keeps the ground out of the carriageway.
 *   mid  3186 / 36 : covers the rest of the play area.
 *   far 11151 / 531: horizon filler out past the sky dome's visible ground.
 */
Terrain.RINGS = [
  { half: 1458, step: 18, hole: 0 },
  { half: 3186, step: 36, hole: 1458 },
  { half: 11151, step: 531, hole: 3186 },
];

export { CELL as TERRAIN_CELL, BASE_LAND };
