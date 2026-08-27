import * as THREE from 'three';
import { geo, WORLD } from '../core/Geo.js';
import {
  buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial,
  MeshBuf, GlassBuf, rng, hash2, polyCentroid,
} from './BuildingKit.js';
import { makeSpec, buildBuilding } from './Facades.js';
import { isReserved } from '../data/landmarks.js';

const CHUNK = 170;        // metres — LOD 0/1 streaming granularity
// Metres — always-resident shell granularity, and therefore the granularity at
// which the shell can be frustum-culled at all.
//
// This was 1200 m, which is wider than most of what a street-level camera can
// see, so culling did almost nothing: at `night_neon` 11 of 19 sectors
// intersected the frustum and submitted 748k of the shell's 841k triangles,
// nearly all of them behind other buildings or kilometres away. Triangles are
// the constrained axis now and draw calls are not (94-688 against a 1200
// budget), so trading a few dozen extra draws for a much tighter cull is the
// right way round.
const SECTOR = 600;
const CATCHUP_FRAMES = 45;   // frames of widened build budget after a camera teleport
// A safety valve against a pathological parcel set, NOT a quality dial.
//
// `RoadNetwork.buildPlots` sorts its output by distance from the centre, so a
// *count* cap here silently becomes a *radius* cap: at 7,200 of the 11,219
// published parcels the city stopped dead at a 1,592 m radius and the outer
// 4,277 parcels got no building at all. The whole west edge (x < -1800) and
// north edge (z < -1800) were bare, and from Boylston St at (-2179, 1095) the
// nearest building was 849 m away — the player could walk out of the city into
// an empty plain. Keep this above the parcel count the city actually publishes.
//
// The outer ring costs almost nothing to carry: it is beyond every LOD radius,
// so it exists only in the always-resident shell at ~80 tris a building, in its
// own 1200 m sector meshes that frustum-cull independently of downtown.
const MAX_BUILDINGS = 14000;

/* -------------------------------------------------------------------------- */
/* Fallback city layout                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Boston's neighbourhoods, with the street bearing that actually defines each
 * one's grain: Back Bay's famous regular grid runs 14° off the cardinals along
 * Commonwealth Avenue, Beacon Hill runs with Mt Vernon Street, the North End is
 * a tight colonial tangle, Southie runs with Broadway.
 *
 * Used only when the City system hasn't published `city.plots` yet — the moment
 * it does, we switch to the real parcels.
 */
const DISTRICTS = [
  {
    id: 'backBay', poly: [[42.3556, -71.0709], [42.3520, -71.0895],
      [42.3452, -71.0855], [42.3489, -71.0678]],
    axis: [[42.3520, -71.0705], [42.3486, -71.0885]],
    blockL: 148, blockD: 92, street: 26, cross: 18,
    row: true, lotW: 7.6, lotD: 40, maxH: 21, tallEdge: 0.10,
  },
  {
    id: 'beaconHill', poly: [[42.3562, -71.0703], [42.3620, -71.0710],
      [42.3607, -71.0630], [42.3571, -71.0638]],
    axis: [[42.3583, -71.0655], [42.3577, -71.0706]],
    blockL: 78, blockD: 62, street: 15, cross: 12,
    row: true, lotW: 6.2, lotD: 27, maxH: 14,
  },
  {
    id: 'northEnd', poly: [[42.3606, -71.0578], [42.3672, -71.0570],
      [42.3676, -71.0507], [42.3600, -71.0521]],
    axis: [[42.3610, -71.0565], [42.3660, -71.0535]],
    blockL: 66, blockD: 54, street: 13, cross: 11,
    row: true, lotW: 7.0, lotD: 23, maxH: 21,
  },
  {
    id: 'southEnd', poly: [[42.3452, -71.0788], [42.3401, -71.0642],
      [42.3338, -71.0700], [42.3390, -71.0842]],
    axis: [[42.3450, -71.0720], [42.3370, -71.0790]],
    blockL: 132, blockD: 86, street: 22, cross: 16,
    row: true, lotW: 7.2, lotD: 36, maxH: 18,
  },
  {
    id: 'financial', poly: [[42.3598, -71.0600], [42.3590, -71.0512],
      [42.3522, -71.0532], [42.3535, -71.0618]],
    axis: [[42.3560, -71.0575], [42.3530, -71.0565]],
    blockL: 88, blockD: 76, street: 18, cross: 15,
    row: false, lotW: 30, lotD: 34, maxH: 175, core: [42.3563, -71.0565], coreR: 420,
  },
  {
    id: 'downtown', poly: [[42.3618, -71.0642], [42.3606, -71.0566],
      [42.3540, -71.0602], [42.3556, -71.0668]],
    axis: [[42.3590, -71.0600], [42.3540, -71.0610]],
    blockL: 82, blockD: 68, street: 17, cross: 13,
    row: false, lotW: 24, lotD: 30, maxH: 95, core: [42.3575, -71.0605], coreR: 380,
  },
  {
    id: 'westEnd', poly: [[42.3618, -71.0686], [42.3668, -71.0672],
      [42.3662, -71.0592], [42.3612, -71.0606]],
    axis: [[42.3640, -71.0670], [42.3630, -71.0600]],
    blockL: 100, blockD: 84, street: 20, cross: 16,
    row: false, lotW: 30, lotD: 38, maxH: 82, core: [42.3640, -71.0640], coreR: 300,
  },
  {
    id: 'chinatown', poly: [[42.3518, -71.0648], [42.3508, -71.0568],
      [42.3464, -71.0588], [42.3474, -71.0668]],
    axis: [[42.3505, -71.0620], [42.3490, -71.0570]],
    blockL: 74, blockD: 60, street: 15, cross: 12,
    row: false, lotW: 18, lotD: 26, maxH: 52, core: [42.3495, -71.0615], coreR: 260,
  },
  {
    id: 'seaport', poly: [[42.3524, -71.0472], [42.3512, -71.0334],
      [42.3424, -71.0356], [42.3438, -71.0498]],
    axis: [[42.3510, -71.0450], [42.3500, -71.0350]],
    blockL: 148, blockD: 106, street: 24, cross: 20,
    row: false, lotW: 44, lotD: 48, maxH: 62, core: [42.3495, -71.0420], coreR: 500,
  },
  {
    id: 'fenway', poly: [[42.3514, -71.0898], [42.3496, -71.1058],
      [42.3410, -71.1016], [42.3428, -71.0886]],
    axis: [[42.3480, -71.0930], [42.3450, -71.1010]],
    blockL: 120, blockD: 88, street: 22, cross: 16,
    row: true, lotW: 9.5, lotD: 36, maxH: 34, core: [42.3490, -71.0950], coreR: 300,
  },
  {
    id: 'charlestown', poly: [[42.3706, -71.0688], [42.3792, -71.0662],
      [42.3788, -71.0536], [42.3702, -71.0554]],
    axis: [[42.3740, -71.0630], [42.3790, -71.0600]],
    blockL: 92, blockD: 70, street: 17, cross: 13,
    row: true, lotW: 8.0, lotD: 28, maxH: 13,
  },
  {
    id: 'cambridge', poly: [[42.3668, -71.1096], [42.3768, -71.1090],
      [42.3762, -71.0722], [42.3664, -71.0730]],
    axis: [[42.3660, -71.1050], [42.3730, -71.1010]],
    blockL: 124, blockD: 92, street: 22, cross: 17,
    row: false, lotW: 28, lotD: 38, maxH: 42, core: [42.3700, -71.0870], coreR: 500,
  },
  {
    id: 'southBoston', poly: [[42.3404, -71.0512], [42.3398, -71.0306],
      [42.3300, -71.0326], [42.3312, -71.0530]],
    axis: [[42.3355, -71.0480], [42.3340, -71.0340]],
    blockL: 104, blockD: 76, street: 18, cross: 14,
    row: true, lotW: 8.2, lotD: 30, maxH: 13,
  },
];

/** Point in polygon, XZ plane. */
function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) &&
        x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Synthesise a plausible parcel layout so this system is never blocked on the
 * City agent. Blocks are laid on each district's own street bearing, then
 * subdivided into real-width rowhouse lots (or deep commercial parcels).
 * @returns {Array<object>} plots in the `city.plots` shape
 */
function fallbackPlots() {
  const plots = [];
  let id = 0;
  for (const d of DISTRICTS) {
    const poly = d.poly.map(([la, lo]) => geo(la, lo));
    const A = geo(d.axis[0][0], d.axis[0][1]);
    const B = geo(d.axis[1][0], d.axis[1][1]);
    let ux = B.x - A.x, uz = B.z - A.z;
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const vx = -uz, vz = ux;            // perpendicular

    // District bounds in the local (u,v) frame
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of poly) {
      const u = p.x * ux + p.z * uz, v = p.x * vx + p.z * vz;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const toWorld = (u, v) => ({ x: u * ux + v * vx, z: u * uz + v * vz });
    const core = d.core ? geo(d.core[0], d.core[1]) : null;
    const r = rng((d.id.charCodeAt(0) * 7919 + d.id.length * 131) | 0);

    const stepV = d.blockD + d.street;
    const stepU = d.blockL + d.cross;
    for (let bv = v0; bv < v1; bv += stepV) {
      for (let bu = u0; bu < u1; bu += stepU) {
        // A little jitter keeps the fallback grid from reading as graph paper.
        const ju = bu + (r() - 0.5) * 5, jv = bv + (r() - 0.5) * 4;
        const bl = d.blockL * (0.82 + r() * 0.34);
        const bd = d.blockD * (0.88 + r() * 0.22);
        if (d.row) {
          const rowD = Math.min(d.lotD, bd * 0.5 - 3);
          for (const side of [0, 1]) {
            const rv0 = side === 0 ? jv : jv + bd - rowD;
            const rv1 = rv0 + rowD;
            const frontV = side === 0 ? -1 : 1;
            const fdir = { x: vx * frontV, z: vz * frontV };
            let u = ju;
            let idx = 0;
            while (u < ju + bl - 3) {
              const w = d.lotW * (0.86 + r() * 0.36);
              const uu = Math.min(u + w, ju + bl);
              const p = [toWorld(u, rv0), toWorld(uu, rv0),
                         toWorld(uu, rv1), toWorld(u, rv1)];
              const dirs = [fdir];
              if (idx === 0) dirs.push({ x: -ux, z: -uz });
              if (uu >= ju + bl - 3.05) dirs.push({ x: ux, z: uz });
              pushPlot(plots, id++, p, d, core, dirs, r);
              u = uu; idx++;
            }
          }
        } else {
          const nu = Math.max(1, Math.round(bl / d.lotW));
          const nv = Math.max(1, Math.round(bd / d.lotD));
          for (let i = 0; i < nu; i++) for (let k = 0; k < nv; k++) {
            const pu0 = ju + (bl * i) / nu, pu1 = ju + (bl * (i + 1)) / nu;
            const pv0 = jv + (bd * k) / nv, pv1 = jv + (bd * (k + 1)) / nv;
            const p = [toWorld(pu0, pv0), toWorld(pu1, pv0),
                       toWorld(pu1, pv1), toWorld(pu0, pv1)];
            const dirs = [];
            if (k === 0) dirs.push({ x: -vx, z: -vz });
            if (k === nv - 1) dirs.push({ x: vx, z: vz });
            if (i === 0) dirs.push({ x: -ux, z: -uz });
            if (i === nu - 1) dirs.push({ x: ux, z: uz });
            pushPlot(plots, id++, p, d, core, dirs, r);
          }
        }
      }
    }
    void poly;
  }
  // Reject anything outside its district or on reserved ground.
  return plots;
}

function pushPlot(out, id, poly, d, core, frontDirs, r) {
  const c = polyCentroid(poly);
  if (c.x < WORLD.minX + 40 || c.x > WORLD.maxX - 40 ||
      c.z < WORLD.minZ + 40 || c.z > WORLD.maxZ - 40) return;
  const dpoly = d._xz || (d._xz = d.poly.map(([la, lo]) => geo(la, lo)));
  if (!inPoly(c.x, c.z, dpoly)) return;
  // Reject partly-outside parcels so blocks end cleanly at district edges.
  for (const p of poly) if (!inPoly(p.x, p.z, dpoly)) return;
  if (isReserved(c.x, c.z)) return;

  let maxH = d.maxH;
  if (core) {
    const dist = Math.hypot(c.x - core.x, c.z - core.z);
    const t = Math.max(0, 1 - dist / d.coreR);
    maxH = 22 + (d.maxH - 22) * (0.18 + 0.82 * t * t) * (0.55 + r() * 0.75);
  } else {
    maxH = d.maxH * (0.88 + r() * 0.30);
    if (d.tallEdge && r() < d.tallEdge) maxH *= 1.9;
  }
  out.push({
    id, polygon: poly, district: d.id, zoning: d.row ? 'residential' : 'mixed',
    maxHeight: maxH, frontDirs,
  });
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

const _v = new THREE.Vector3();

/**
 * Every generic building in Boston: parcels -> specs -> three levels of merged
 * geometry, streamed around the camera.
 *
 * Draw-call strategy: one shared material for all opaque surfaces (texture
 * arrays, not per-building maps) and one for all glass, so a whole chunk of the
 * city costs two draws. The distant skyline is a set of always-resident
 * "shell" sector meshes at ~16 draws total.
 */
export default class Buildings {
  static id = 'buildings';
  static label = 'Buildings';
  // Only hard-depend on what always exists. `city` is consumed defensively so a
  // sibling system that fails to import can never take the whole world down.
  static deps = ['assets'];

  constructor() {
    this.specs = [];
    this.chunks = new Map();
    this.sectors = new Map();
    this.root = null;
    this._queue = [];
    this._camChunk = { x: 9999, z: 9999 };
    this._tmpKeys = [];
    this._usedFallback = false;
    this._swapChecks = 0;
    // Teleport catch-up. Plain numbers, not a vector: update() must not allocate.
    this._lastCamX = NaN;
    this._lastCamZ = NaN;
    this._catchUp = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();

    this.root = new THREE.Group();
    this.root.name = 'buildings';
    ctx.scene.add(this.root);

    // --- materials (registered through ctx.assets so wetness reaches them) ---
    const assets = ctx.assets;
    const tex = assets ? assets.texture('bk_atlas', () => {
      const a = buildAtlas(); this._atlas = a; return a.albedo;
    }) : null;
    if (this._atlas) {
      assets.textures.set('bk_atlas_n', this._atlas.normal);
      assets.textures.set('bk_atlas_orm', this._atlas.orm);
    } else {
      this._atlas = buildAtlas();
    }
    void tex;
    this.rooms = assets ? assets.texture('bk_rooms', buildRoomAtlas) : buildRoomAtlas();
    this.macro = assets ? assets.texture('bk_macro', buildMacroNoise) : buildMacroNoise();

    const mk = (k, fn) => (assets ? assets.material(k, fn) : fn());
    this.matOpaque = mk('building_facade',
      () => makeOpaqueMaterial(this._atlas, this.rooms, this.macro));
    this.matGlass = mk('building_glass', () => makeGlassMaterial(this.rooms));

    // Take reflection strength from the materials agent if they've landed, so
    // our glass matches theirs rather than fighting it.
    const mats = ctx.get('materials');
    if (mats?.get) {
      const gt = mats.get('glass_tower');
      if (gt && gt.envMapIntensity) this.matGlass.envMapIntensity = gt.envMapIntensity;
    }

    this._collectPlots(ctx);
    this._buildSpecs(ctx);
    this._buildShell(ctx);

    const ms = performance.now() - t0;
    console.info(`[buildings] ${this.specs.length} buildings, ` +
      `${this.sectors.size} shell sectors, ${(ms | 0)}ms` +
      (this._usedFallback ? ' (fallback parcels — city.plots not published)' : ''));
  }

  /* ---- parcels -------------------------------------------------------- */

  _collectPlots(ctx) {
    const city = ctx.get('city');
    this.groundAt = (city && typeof city.groundHeight === 'function')
      ? (x, z) => city.groundHeight(x, z) : () => 0;
    if (Array.isArray(city?.plots) && city.plots.length > 8) {
      this.plots = city.plots;
      this._usedFallback = false;
    } else {
      this.plots = fallbackPlots();
      this._usedFallback = true;
    }
  }

  _buildSpecs() {
    const specs = [];
    const n = Math.min(this.plots.length, MAX_BUILDINGS);
    for (let i = 0; i < n; i++) {
      const plot = this.plots[i];
      if (!plot?.polygon || plot.polygon.length < 3) continue;
      const c = polyCentroid(plot.polygon);
      if (isReserved(c.x, c.z)) continue;
      // The city publishes a per-parcel ground elevation; prefer it over
      // sampling the terrain ourselves so a building can never float or sink
      // relative to the pavement the city laid at the same height.
      const g = Number.isFinite(plot.y) ? plot.y : this.groundAt(c.x, c.z);
      const base = g - 0.25;
      if (!Number.isFinite(base)) continue;
      const spec = makeSpec(plot, base, (plot.id ?? i) * 2654435761 % 1048573 | 0);
      if (!spec) continue;
      spec.cx = c.x; spec.cz = c.z;
      // Conservative radius for culling and collider streaming.
      let rad = 0;
      for (const p of plot.polygon) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d > rad) rad = d;
      }
      spec.radius = rad + 2.5;
      specs.push(spec);
    }
    this.specs = specs;

    // Spatial bucketing
    this.chunks.clear();
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const cx = Math.floor(s.cx / CHUNK), cz = Math.floor(s.cz / CHUNK);
      const key = cx * 10007 + cz;
      let ch = this.chunks.get(key);
      if (!ch) {
        ch = { cx, cz, x: (cx + 0.5) * CHUNK, z: (cz + 0.5) * CHUNK,
               list: [], lod: -1, want: -1, meshes: null, body: null, job: null };
        this.chunks.set(key, ch);
      }
      ch.list.push(i);
    }
  }

  /* ---- always-resident distant shell ---------------------------------- */

  _buildShell(ctx) {
    const bySector = new Map();
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      const sx = Math.floor(s.cx / SECTOR), sz = Math.floor(s.cz / SECTOR);
      const key = sx * 1009 + sz;
      let arr = bySector.get(key);
      if (!arr) bySector.set(key, arr = []);
      arr.push(i);
    }
    for (const [key, list] of bySector) {
      // Pre-size: growing a 1 M-vertex typed array by doubling costs more in
      // memcpy and GC than the whole emit does.
      const mb = new MeshBuf(Math.max(4096, list.length * 96));
      for (const i of list) buildBuilding(this.specs[i], mb, null, 2);
      const g = mb.build();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this.matOpaque);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'shell';
      this.root.add(mesh);
      this.sectors.set(key, mesh);
    }
  }

  /* ---- streaming ------------------------------------------------------ */

  /**
   * Build a chunk incrementally, stopping at `deadline`. A dense Back Bay chunk
   * is ~55 buildings and ~160 ms of emit; done in one go that is a visible
   * hitch, so the partially-filled buffers live on the chunk until it finishes.
   * @returns {boolean} true when the chunk is complete
   */
  _stepChunk(ch, lod, deadline) {
    if (!ch.job || ch.job.lod !== lod) {
      ch.job = {
        lod, i: 0,
        mb: new MeshBuf(Math.max(2048, ch.list.length * 900)),
        gb: new GlassBuf(Math.max(512, ch.list.length * 90)),
      };
    }
    const j = ch.job;
    const list = ch.list;
    while (j.i < list.length) {
      buildBuilding(this.specs[list[j.i++]], j.mb, j.gb, lod);
      if ((j.i & 3) === 0 && performance.now() > deadline) return false;
    }

    this._disposeChunk(ch, false);
    const meshes = [];
    const go = j.mb.build();
    if (go) {
      const m = new THREE.Mesh(go, this.matOpaque);
      m.castShadow = lod === 0;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.root.add(m); meshes.push(m);
    }
    const gg = j.gb.build();
    if (gg) {
      const m = new THREE.Mesh(gg, this.matGlass);
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.root.add(m); meshes.push(m);
    }
    ch.meshes = meshes;
    ch.lod = lod;
    ch.job = null;
    if (lod === 0) this._addColliders(ch);
    return true;
  }

  _addColliders(ch) {
    const p = this.ctx.physics;
    if (!p?.world || ch.body) return;
    const R = p.RAPIER;
    const body = p.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const i of ch.list) {
      const s = this.specs[i];
      // Oriented box around the footprint: exact for the rectangular parcels
      // that make up nearly all of Boston.
      const poly = s.poly;
      let bestL = 0, ang = 0;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L > bestL) { bestL = L; ang = Math.atan2(b.x - a.x, b.z - a.z); }
      }
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      let hu = 0, hv = 0;
      for (const q of poly) {
        const dx = q.x - s.cx, dz = q.z - s.cz;
        const u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
        hu = Math.max(hu, Math.abs(u)); hv = Math.max(hv, Math.abs(v));
      }
      const half = s.h * 0.5;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
      const cd = R.ColliderDesc.cuboid(Math.max(hu, 0.4), half, Math.max(hv, 0.4))
        .setTranslation(s.cx, s.base + half, s.cz)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(0.9);
      p.world.createCollider(cd, body);
    }
    ch.body = body;
  }

  _disposeChunk(ch, dropColliders = true) {
    if (ch.meshes) {
      for (const m of ch.meshes) { this.root.remove(m); m.geometry.dispose(); }
      ch.meshes = null;
    }
    ch.lod = -1;
    if (dropColliders) ch.job = null;
    if (dropColliders && ch.body) {
      this.ctx.physics?.world?.removeRigidBody(ch.body);
      ch.body = null;
    }
  }

  update(dt, ctx) {
    // Night: window interiors, shop signage and the baked facade-strip window
    // mask all come up together between roughly 18:30 and 06:30.
    const tod = ctx.time.timeOfDay;
    const dawn = THREE.MathUtils.smoothstep(tod, 5.4, 7.3);
    const dusk = 1 - THREE.MathUtils.smoothstep(tod, 17.5, 19.5);
    const night = 1 - Math.min(dawn, dusk);
    const uo = this.matOpaque.userData.uniforms;
    const ug = this.matGlass.userData.uniforms;
    uo.uNight.value = night;
    ug.uNight.value = night;
    ug.uDayInterior.value = 0.06 + 0.40 * (1 - night);

    // The City agent may publish real parcels after us; adopt them once.
    if (this._usedFallback && this._swapChecks < 400) {
      if ((ctx.time.frame & 15) === 0) {
        this._swapChecks++;
        const city = ctx.get('city');
        if (Array.isArray(city?.plots) && city.plots.length > 8) {
          this._rebuildFromCity(ctx);
        }
      }
    }

    const cam = ctx.camera.position;
    // A teleport — capture() parking the camera, fast travel, a respawn —
    // invalidates every near chunk at once, and the near field then has nothing
    // but the crude LOD 2 shell in it until streaming catches up. Flag it so
    // `_pump` is allowed to spend real time rebuilding.
    if (Number.isFinite(this._lastCamX)) {
      const moved = Math.hypot(cam.x - this._lastCamX, cam.z - this._lastCamZ);
      if (moved > CHUNK) this._catchUp = CATCHUP_FRAMES;
    }
    this._lastCamX = cam.x; this._lastCamZ = cam.z;

    const cx = Math.floor(cam.x / CHUNK), cz = Math.floor(cam.z / CHUNK);
    if (cx !== this._camChunk.x || cz !== this._camChunk.z ||
        (ctx.time.frame & 31) === 0) {
      this._camChunk.x = cx; this._camChunk.z = cz;
      this._retarget(ctx, cam);
    }
    this._pump(ctx);
  }

  /** Decide which chunks want which LOD, and queue the deltas by distance. */
  _retarget(ctx, cam) {
    // Radii are the whole triangle budget. Boston's dense districts run ~55
    // buildings to a 170 m chunk, so every extra 100 m of LOD-1 radius costs
    // roughly a quarter of a million triangles. The always-resident shell means
    // the city still reaches the horizon regardless.
    const scale = Math.min(1.4, Math.max(0.55, ctx.settings.drawDist / 2200));
    const r0 = 175 * scale, r1 = 410 * scale;
    const r0h = r0 + 40, r1h = r1 + 80;       // hysteresis, so LOD never flickers
    const q = this._queue;
    q.length = 0;
    for (const ch of this.chunks.values()) {
      const dx = ch.x - cam.x, dz = ch.z - cam.z;
      const d = Math.hypot(dx, dz);
      let want;
      if (d < (ch.lod === 0 ? r0h : r0)) want = 0;
      else if (d < (ch.lod === 1 ? r1h : r1)) want = 1;
      else want = -1;
      ch.want = want;
      ch.dist = d;
      if (want !== ch.lod) q.push(ch);
    }
    q.sort((a, b) => a.dist - b.dist);
  }

  /** Spend a slice of the frame turning queued chunks into geometry. */
  _pump(ctx) {
    if (this._catchUp > 0) this._catchUp--;
    if (!this._queue.length) return;
    // Three regimes:
    //   boot      — the world is coming up and there is nothing to stutter yet;
    //   catch-up  — the camera just teleported, so the near field is entirely
    //               LOD 2 shell and needs real time to rebuild;
    //   steady    — a slice that can never cost a frame.
    //
    // The old rule widened the budget only for `frame < 200`, i.e. the first few
    // seconds of the session. Every capture() taken after that rendered before
    // the detailed chunks existed, so most buildings in the shot were the crude
    // shell — flat, pale and untextured next to fully facaded neighbours that
    // happened to already be built. A dense chunk is ~160 ms of emit on its own,
    // and capture() only warms up ~24 frames, so 6 ms/frame could never converge.
    const budget = ctx.time.frame < 200 ? 24 : (this._catchUp > 0 ? 50 : 6);
    const deadline = performance.now() + budget;
    while (this._queue.length && performance.now() < deadline) {
      const ch = this._queue[0];
      if (ch.want === ch.lod) { this._queue.shift(); ch.job = null; continue; }
      if (ch.want === -1) { this._disposeChunk(ch); this._queue.shift(); continue; }
      if (this._stepChunk(ch, ch.want, deadline)) this._queue.shift();
      else break;               // out of time; resume this chunk next frame
    }
  }

  /** One-shot swap from fallback parcels to the City agent's real ones. */
  _rebuildFromCity(ctx) {
    console.info('[buildings] city.plots published — rebuilding on real parcels');
    for (const ch of this.chunks.values()) this._disposeChunk(ch);
    for (const m of this.sectors.values()) { this.root.remove(m); m.geometry.dispose(); }
    this.sectors.clear();
    this._usedFallback = false;
    this._collectPlots(ctx);
    this._buildSpecs(ctx);
    this._buildShell(ctx);
    this._camChunk.x = 9999;
    this._queue.length = 0;
  }

  /** Ground-truth height of the tallest building near a point (for the AI/camera). */
  heightAt(x, z) {
    let best = 0;
    for (const s of this.specs) {
      if (Math.abs(s.cx - x) > s.radius || Math.abs(s.cz - z) > s.radius) continue;
      if (Math.hypot(s.cx - x, s.cz - z) < s.radius) best = Math.max(best, s.base + s.h);
    }
    return best;
  }

  stats() {
    let live = 0, tris = 0;
    for (const ch of this.chunks.values()) {
      if (!ch.meshes) continue;
      live++;
      for (const m of ch.meshes) tris += (m.geometry.index?.count ?? 0) / 3;
    }
    for (const m of this.sectors.values()) tris += (m.geometry.index?.count ?? 0) / 3;
    return { buildings: this.specs.length, liveChunks: live, sectors: this.sectors.size,
             tris: tris | 0 };
  }

  dispose() {
    for (const ch of this.chunks.values()) this._disposeChunk(ch);
    for (const m of this.sectors.values()) { this.root?.remove(m); m.geometry.dispose(); }
    this.sectors.clear(); this.chunks.clear(); this.specs.length = 0;
    if (this.root) this.ctx?.scene.remove(this.root);
    // Textures and materials live in ctx.assets, which disposes them itself.
    void _v; void hash2;
  }
}

export { CHUNK, SECTOR, DISTRICTS, fallbackPlots };
