import * as THREE from 'three';
import { geo, WORLD } from '../core/Geo.js';
import {
  buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial,
  MeshBuf, GlassBuf, rng, hash2, polyCentroid,
} from './BuildingKit.js';
import { makeSpec, buildBuilding, towerCoreAt } from './Facades.js';
import { corridorHalf } from './RoadNetwork.js';
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

/** Streaming-chunk key for a spec. Must match the bucketing in `_buildSpecs`. */
function chunkKey(s) {
  return Math.floor(s.cx / CHUNK) * 10007 + Math.floor(s.cz / CHUNK);
}

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

/* -------------------------------------------------------------------------- */
/* Road corridor clipping                                                     */
/* -------------------------------------------------------------------------- */

/*
 * `corridorHalf` — half-width of the strip no building may enter: carriageway +
 * kerb + footway — is IMPORTED from RoadNetwork.js, which is the file that lays
 * the frontage line down in the first place. It used to be redeclared here with
 * the kerb inlined as 0.16. The two agreed, but a generator and its downstream
 * clip disagreeing about where the street ends is precisely the bug that put
 * buildings on the pavement, so there is now exactly one definition.
 *
 * We clip at exactly the back of the pavement and not a metre more: that leaves
 * a correct parcel untouched and still lets the building meet the footway —
 * Boston's streetwalls are continuous, and a setback here would trade one
 * automatic fail for another.
 */

/** Tolerance, metres. Below this an "intrusion" is chord slop, not a building. */
const CLIP_EPS = 0.02;

/** Scratch for the corridor rectangle's corners — init-time only, never in update(). */
const _rect = new Float64Array(8);

/**
 * Exact overlap test between a convex parcel and one road's corridor rectangle,
 * by separating axis. Cheap axes (along and across the road) come first because
 * they reject almost everything.
 *
 * This must be exact rather than conservative: a false positive applies a
 * half-plane that has no business touching the parcel, and the visible result
 * is a building sliced off by a street it does not front.
 */
function overlapsCorridor(poly, seg) {
  const { ax, az, dx, dz, len, w } = seg;
  const nx = -dz, nz = dx;
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) {
    const t = (p.x - ax) * dx + (p.z - az) * dz;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  if (hi <= 0 || lo >= len) return false;
  lo = Infinity; hi = -Infinity;
  for (const p of poly) {
    const t = (p.x - ax) * nx + (p.z - az) * nz;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  if (hi <= -w || lo >= w) return false;
  const ex1 = ax + dx * len, ez1 = az + dz * len;
  _rect[0] = ax + nx * w; _rect[1] = az + nz * w;
  _rect[2] = ax - nx * w; _rect[3] = az - nz * w;
  _rect[4] = ex1 + nx * w; _rect[5] = ez1 + nz * w;
  _rect[6] = ex1 - nx * w; _rect[7] = ez1 - nz * w;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let px = -(b.z - a.z), pz = b.x - a.x;
    const L = Math.hypot(px, pz);
    if (L < 1e-9) continue;
    px /= L; pz /= L;
    let plo = Infinity, phi = -Infinity;
    for (const q of poly) {
      const t = q.x * px + q.z * pz;
      if (t < plo) plo = t; if (t > phi) phi = t;
    }
    let rlo = Infinity, rhi = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const t = _rect[k] * px + _rect[k + 1] * pz;
      if (t < rlo) rlo = t; if (t > rhi) rhi = t;
    }
    if (rhi <= plo || rlo >= phi) return false;
  }
  return true;
}

/**
 * Sutherland–Hodgman against one half-plane: keep `p·n >= c`.
 * @returns {{poly:Array<{x,z}>, cut:boolean}} `cut` is true only when real area
 *   was removed, so a parcel that merely touches the line is not re-fronted.
 */
function clipHalfPlane(poly, nx, nz, c) {
  const out = [];
  let cut = false;
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const da = A.x * nx + A.z * nz - c, db = B.x * nx + B.z * nz - c;
    if (da < -0.05) cut = true;
    if (da >= -CLIP_EPS) out.push(A);
    if ((da >= -CLIP_EPS) !== (db >= -CLIP_EPS)) {
      // The crossing test straddles -CLIP_EPS rather than 0, so A and B can sit
      // on opposite sides of it with (da - db) arbitrarily small: da = -0.0199
      // and db = -0.0201 register a crossing but divide by 2e-4. Unclamped that
      // put vertices ~1e11 m out, which silently poisons the bounding radius,
      // frustum culling and collider streaming rather than throwing. Observed:
      // 43 buildings with radius up to 7.7e11 when the road corridor tolerance
      // was raised above CLIP_EPS. The intersection must lie on segment AB, so
      // clamp it there and fall back to A when the edge is parallel to the cut.
      const den = da - db;
      const t = Math.abs(den) < 1e-9 ? 0 : Math.min(1, Math.max(0, da / den));
      out.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t });
    }
  }
  return { poly: out, cut };
}

/* -------------------------------------------------------------------------- */
/* Tower superblocks                                                          */
/* -------------------------------------------------------------------------- */

/*
 * Under the Prudential and 200 Clarendon, every parcel the city publishes is a
 * Back Bay house lot: measured, the largest parcel within 300 m of either tower
 * is 297 m² and the median is 233 m². `RoadNetwork.ZONING` subdivides the whole
 * neighbourhood at `w: 8.2` because that is right for Marlborough Street, and
 * `Facades.makeSpec` demotes anything under 420 m² to a mid-rise on the grounds
 * that a tower on a 8 x 30 m lot is a pencil, not a building. Both rules are
 * correct, and between them no height policy of any kind could have put a tower
 * in Back Bay — which is why the district came out 2,499 buildings with a
 * 33.6 m ceiling for three critic passes running.
 *
 * So assemble the land first. Runs of adjacent lots along one frontage are
 * fused into a superblock, and only inside the cluster radii in `TOWER_CORES`.
 * This is what actually happened: Copley Place, the Prudential Center and the
 * Christian Science plaza were all cleared out of Back Bay house lots between
 * 1959 and 1983, and the surviving rowhouse streets a block away are why the
 * merge radius is 178-185 m and not the whole 280-300 m cluster.
 *
 * The merged ring is a strict subset of the union of its parts — the lots must
 * be collinear along the frontage and the run takes the SHALLOWEST depth in it —
 * so nothing here can reach ground that a published parcel did not already own,
 * and the road-corridor clip below still runs on the result regardless.
 */
const SB_MIN_W = 34;      // m of frontage: under this it is a wide house, not a block
const SB_MAX_W = 82;
const SB_MAX_LOTS = 14;
const SB_LOT_AREA = 700;  // per lot; leaves the Financial District's real parcels alone
const SB_COLLINEAR = 0.9995;

/** Endpoint identity key, to the centimetre. Init-time only. */
const ptKey = (q) => `${Math.round(q.x * 100)}_${Math.round(q.z * 100)}`;

/** Twice the signed area of an XZ ring. */
function polyArea2(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a;
}

/** Drop vertices a clip left on top of each other, so no zero-length wall is emitted. */
function dedupe(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (Math.hypot(q.x - p.x, q.z - p.z) > 0.06) out.push(p);
  }
  return out;
}

/**
 * Outward normal of the parcel's own street frontage.
 *
 * `RoadNetwork` publishes `frontage: {a, b}` but no direction, and `makeSpec`'s
 * last-resort rule is "the longest edge is the facade". On a 8 m x 22 m Back Bay
 * lot the longest edge is the *party wall*, so 96% of the city was presenting a
 * blank flank to the street and its shopfront to its neighbour. Handing the
 * direction over removes the guess.
 */
function frontageDir(plot, poly) {
  const f = plot.frontage;
  if (!f || !f.a || !f.b) return null;
  const dx = f.b.x - f.a.x, dz = f.b.z - f.a.z;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) return null;
  let nx = -dz / L, nz = dx / L;
  const c = polyCentroid(poly);
  if ((c.x - f.a.x) * nx + (c.z - f.a.z) * nz > 0) { nx = -nx; nz = -nz; }
  return { x: nx, z: nz };
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

/* -------------------------------------------------------------------------- */
/* Shadow LOD                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * World metres per shadow texel above which LOD-0 facade relief stops existing.
 *
 * The detail LOD-0 carries over the shell is bays, sills, cornices, areaways and
 * shopfront recesses: 0.2 - 0.4 m of projection. A cascade whose texel is wider
 * than that cannot represent any of it — the depth buffer it writes is identical
 * either way — and the PCF disc then blurs over 1.4 more texels on top.
 *
 * Measured at `high`: cascade texels are 0.03 / 0.11 / 0.61 m at `night_neon`
 * and 0.03 / 0.10 / 0.56 m at `st_beaconhill`, so this threshold selects the far
 * cascade only and leaves both near cascades — the ones that carry every shadow
 * the player reads on a facade — completely untouched. It is deliberately set
 * BELOW the far cascade and far ABOVE cascade 1, not between them by a hair.
 */
const SHADOW_DETAIL_TEXEL = 0.30;

/** True when this cascade is too coarse to resolve LOD-0 relief. */
function coarseCascade(shadowCamera) {
  const t = shadowCamera.userData.csmTexel;
  return t !== undefined && t > SHADOW_DETAIL_TEXEL;
}

/*
 * Per-cascade caster substitution.
 *
 * Three re-submits every caster to every cascade, and `object.layers` is tested
 * against the VIEW camera inside `WebGLShadowMap.renderObject`, so layers cannot
 * separate cascades. `Object3D.onBeforeShadow` / `onAfterShadow` can: three
 * calls them per object PER CASCADE, immediately around the draw, with the
 * shadow camera in hand. `drawRange` is read inside `renderBufferDirect`, so
 * setting it there is honoured with no upload and no state invalidation.
 *
 * The pair below swaps the LOD-0 chunk meshes for their shell twins in the far
 * cascade only. Measured at `st_beaconhill`: 457 k triangles out, 21 k of
 * unmasked shell back in. The shell is inset 0.25 m in plan and dropped 0.30 m
 * at every cap (`Facades.buildShell`) — under half a texel at that cascade's
 * 0.56-0.61 m sampling, i.e. below the resolution the cascade has. Comparing
 * cascade 2's depth map before and after, the occluder silhouette moves on
 * 0.89% of its occupied texels; cascades 0 and 1 come back bit-identical inside
 * the scene's own frame-to-frame noise.
 *
 * The one difference you CAN find is a bonus rather than a loss. LOD 0 and LOD 1
 * cut real holes in the wall for windows and fill them with a glass mesh that
 * carries `castShadow = false`, so the detailed mesh let sunlight through every
 * window it had; the shell's wall is solid. The far cascade's building shadows
 * are therefore now solid, which is both what a real building does and what
 * every building past the LOD-0 radius has always done here. It shows up as the
 * far cascade being very slightly DARKER, never brighter.
 *
 * Both hooks must be restored before the camera pass, which is why the restore
 * lives in `onAfterShadow` and not at the end of the frame: three builds the
 * camera render list BEFORE `shadowMap.render`, but reads `drawRange` at draw
 * time, so a range left wide open here would corrupt the visible frame.
 */
function detailBeforeShadow(renderer, object, camera, shadowCamera) {
  if (coarseCascade(shadowCamera)) object.geometry.setDrawRange(0, 0);
}
function detailAfterShadow(renderer, object) {
  object.geometry.setDrawRange(0, Infinity);
}
/**
 * The shell is masked wherever an LOD-0 chunk covers it (`_refreshShellMask`),
 * so the far cascade has to get those spans BACK the moment the detailed mesh
 * stops casting, or the buildings nearest the camera would cast nothing at all
 * past the second split. `mask` holds every index — kept run first, dropped runs
 * appended — precisely so that "unmask" is a draw-range widen and never an
 * index-buffer swap, which would need an upload three has not scheduled.
 */
function shellBeforeShadow(renderer, object, camera, shadowCamera) {
  if (coarseCascade(shadowCamera)) object.geometry.setDrawRange(0, Infinity);
}
function shellAfterShadow(renderer, object) {
  const rec = object.userData.sector;
  object.geometry.setDrawRange(0, rec && rec.masked ? rec.drawCount : Infinity);
}

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
    /** @type {Map<number, {mesh:THREE.Mesh, spans:Array, full:THREE.BufferAttribute,
     *                      mask:?THREE.BufferAttribute, masked:boolean}>} */
    this.sectors = new Map();
    this.root = null;
    this._queue = [];
    this._camChunk = { x: 9999, z: 9999 };
    this._tmpKeys = [];
    this._usedFallback = false;
    this._swapChecks = 0;
    // Shell/detail overlap bookkeeping — see `_refreshShellMask`.
    this._maskDirty = true;
    this._maskSig = 1;          // never a real signature, so the first pass runs
    this._covered = new Set();
    /** @type {?{cells:Map<number,number[]>, segs:Array, cell:number, seen:Set<number>}} */
    this._roadIndex = null;
    this._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
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
    const cs = this._clipStats;
    console.info(`[buildings] ${this.specs.length} buildings, ` +
      `${this.sectors.size} shell sectors, ${(ms | 0)}ms` +
      ` (road corridor: ${cs.clipped} reshaped, ${cs.dropped} dropped,` +
      ` ${cs.trimmed} stoops fitted to the pavement;` +
      ` ${cs.superblocks || 0} tower superblocks)` +
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
    this._indexRoads(city);
    // `districtAt` is nullable BY CONTRACT and in two distinct ways — outside the
    // baked raster, and inside it on ground no neighbourhood claims (41% of
    // cells). `_districtOf` below is the only place that decides what to do
    // about that, and it never invents an answer it does not have.
    this._districtAt = (typeof city?.districtAt === 'function')
      ? (x, z) => city.districtAt(x, z)
      : (typeof city?.districts?.districtAt === 'function')
        ? (x, z) => city.districts.districtAt(x, z)
        : null;
  }

  /**
   * Which neighbourhood's rules a parcel is really built under.
   *
   * `RoadNetwork.buildPlots` stamps the district of the **midpoint of the whole
   * frontage line** onto every lot subdivided from it, and a road runs from the
   * middle of one junction to the middle of the next, so a street on a boundary
   * hands one neighbourhood's zoning to lots standing in another. Measured: 30
   * South End lots carrying Financial District zoning, which is where the South
   * End's 150.6 m ceiling came from, plus 52 unzoned lots standing in Beacon
   * Hill. The parcel's own centroid is a strictly better probe than a point up
   * to 200 m away.
   *
   * Order of preference, and each step is deliberate:
   *   1. the raster at the parcel's own centroid, when it names a buildable
   *      neighbourhood — `park` and `water` are answers about ground, not about
   *      what may be built on it, and a parcel already survived those tests;
   *   2. what the city published, which at worst is a neighbouring street's;
   *   3. `null`, and `makeSpec` spells its own default. Not resolved here: a
   *      fallback hidden in a shared helper makes every caller wrong at once.
   */
  _districtOf(plot, cx, cz) {
    const g = this._districtAt ? this._districtAt(cx, cz) : null;
    if (g && g !== 'park' && g !== 'water') return g;
    return plot.district ?? null;
  }

  /**
   * Bucket every road segment's corridor so a parcel can be clipped out of it.
   *
   * Read-only: the road graph belongs to the city agent. Keeping buildings off
   * the carriageway is enforced there too, but only by sampling a 5 x 3 grid of
   * points per parcel, which lets a corner clip the far kerb of a skew junction
   * and does nothing at all for the footway. This is the geometric guarantee.
   */
  _indexRoads(city) {
    this._roadIndex = null;
    const edges = city?.roads?.edges;
    if (!Array.isArray(edges) || !edges.length) return;
    const CELL = 48;
    const cells = new Map();
    const segs = [];
    for (const e of edges) {
      const w = corridorHalf(e);
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const id = segs.length;
        segs.push({ ax: a.x, az: a.z, dx: dx / len, dz: dz / len, len, w,
                    street: (e.walk || 0) >= 0.3 });
        const x0 = Math.floor((Math.min(a.x, b.x) - w) / CELL);
        const x1 = Math.floor((Math.max(a.x, b.x) + w) / CELL);
        const z0 = Math.floor((Math.min(a.z, b.z) - w) / CELL);
        const z1 = Math.floor((Math.max(a.z, b.z) + w) / CELL);
        for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
          const k = cx * 100003 + cz;
          let arr = cells.get(k); if (!arr) cells.set(k, arr = []);
          arr.push(id);
        }
      }
    }
    this._roadIndex = {
      cells, segs, cell: CELL, seen: new Set(), edges,
      nearestEdge: typeof city.roads.nearestEdge === 'function'
        ? (x, z) => city.roads.nearestEdge(x, z) : null,
    };
  }

  /**
   * Clip one parcel out of every road corridor it overlaps.
   *
   * Half-plane clipping, not rectangle subtraction: the result stays a single
   * convex ring, so a parcel shaved on one side keeps a full-width frontage on
   * the other and the streetwall stays continuous instead of growing notches.
   * A parcel that loses everything is dropped rather than emitted as a sliver.
   *
   * @returns {?{poly:Array<{x,z}>, cutDirs:Array<{x,z}>, changed:boolean}}
   */
  _clipParcel(poly) {
    const idx = this._roadIndex;
    if (!idx) return { poly, cutDirs: null, changed: false };
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of poly) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    const C = idx.cell, seen = idx.seen;
    seen.clear();
    let out = poly, changed = false;
    let cutDirs = null;
    for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
      for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) {
        const list = idx.cells.get(cx * 100003 + cz);
        if (!list) continue;
        for (const si of list) {
          if (seen.has(si)) continue;
          seen.add(si);
          const seg = idx.segs[si];
          if (!overlapsCorridor(out, seg)) continue;
          const nx = -seg.dz, nz = seg.dx;
          // Which side of the road does the parcel belong to? Keep whichever
          // side reaches further out, so a parcel straddling the corridor is
          // pushed off it rather than halved down the middle.
          let lo = Infinity, hi = -Infinity;
          for (const p of out) {
            const t = (p.x - seg.ax) * nx + (p.z - seg.az) * nz;
            if (t < lo) lo = t; if (t > hi) hi = t;
          }
          const pos = hi + lo >= 0;
          const kx = pos ? nx : -nx, kz = pos ? nz : -nz;
          const c = seg.w + (pos ? 1 : -1) * (seg.ax * nx + seg.az * nz);
          const r = clipHalfPlane(out, kx, kz, c);
          out = r.poly;
          if (r.cut) {
            changed = true;
            if (seg.street) {
              (cutDirs || (cutDirs = [])).push({ x: -kx, z: -kz });
            }
          }
          if (out.length < 3) return null;
        }
      }
    }
    if (!changed) return { poly, cutDirs: null, changed: false };
    out = dedupe(out);
    // Match `makeSpec`'s own rejects so a clipped-to-nothing parcel disappears
    // here instead of becoming a degenerate footprint downstream.
    if (out.length < 3 || Math.abs(polyArea2(out)) * 0.5 < 24) return null;
    let ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity;
    for (const p of out) {
      if (p.x < ax0) ax0 = p.x; if (p.x > ax1) ax1 = p.x;
      if (p.z < az0) az0 = p.z; if (p.z > az1) az1 = p.z;
    }
    if (ax1 - ax0 < 3.3 || az1 - az0 < 3.3) return null;
    return { poly: out, cutDirs, changed: true };
  }

  /**
   * Keep the front steps on the pavement.
   *
   * Clipping the *footprint* is only half the job. A Back Bay bowfront bulges up
   * to 1.45 m past the property line and its stoop runs another 0.30 m per step
   * plus a newel on top of that — together up to 4.15 m, across a footway that
   * is 3.76 m on Beacon Street and 1.56 m on a cobbled Beacon Hill lane. 1,703
   * buildings put their steps on the kerb and 1,230 of those put them in the
   * gutter, which raycasts as a building standing in the road exactly like a
   * misplaced parcel does — it is what the critic photographed on Acorn Street.
   *
   * Shorten the rise first (three steps is the floor, which is what the narrow
   * Beacon Hill lanes really have) and only drop the bow if that is still not
   * enough: an empty pavement is a tech-demo tell, but so is a missing bowfront.
   * `spec` is shared by LOD 0, LOD 1 and the shell, so all three stay identical.
   *
   * Bays are measured here too. A bay over the *pavement* is authentic — every
   * South End block has them — but its cornice carries roughly half a metre past
   * the bay face, and reaching the carriageway with it would trade the Boston
   * read for a building standing in the road.
   */
  _fitOrnament(spec) {
    const near = this._roadIndex?.nearestEdge;
    if (!near) return;
    let bow = (spec.bow && !spec.shop) ? 0.95 + spec.rnd(6001) * 0.5 : 0;
    const runOf = (rise) => Math.max(3, Math.round(rise / 0.175)) * 0.30 + 0.08;
    let run = (spec.hasStoop && spec.stoopH > 0.5) ? runOf(spec.stoopH) : 0;
    // `bayFront` carries a cornice `St.cornice * 0.45 + (St.cornice * 0.9 + 0.2)/2`
    // past the bay face; 0.55 covers the deepest cornice in the catalogue.
    const bayTip = spec.bay ? spec.bayProj + 0.55 : 0;
    const want = Math.max(bow + run, bayTip);
    if (want <= 0) return;

    // How far each street face may project before its tip is on a carriageway.
    // Measured at the tip rather than from the parcel's own street width, so a
    // corner house whose steps face a *different*, narrower street than the one
    // it was subdivided from is caught too (Louisburg Square does this).
    const poly = spec.poly, m = poly.length;
    let avail = Infinity;
    for (const i of spec.front) {
      const a = poly[i], b = poly[(i + 1) % m];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const nx = dz / L, nz = -dx / L;          // outward, matching `makeSpec`
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      let p = want;
      while (p > 0.98) {
        const ne = near(mx + nx * p, mz + nz * p);
        if (!ne) break;
        if (ne.distance >= this._roadIndex.edges[ne.edgeId].halfRoad + 0.30) break;
        p -= 0.30;
      }
      if (p < avail) avail = p;
    }
    if (!Number.isFinite(avail) || want <= avail) return;

    if (run > 0) {
      const steps = Math.max(3, Math.floor((avail - bow - 0.08) / 0.30));
      spec.stoopH = Math.min(spec.stoopH, steps * 0.175);
      run = runOf(spec.stoopH);
    }
    if (bow + run > avail && bow > 0) { spec.bow = false; bow = 0; }
    if (spec.bay && bayTip > avail) {
      const pr = avail - 0.55;
      // Below ~0.35 m it is a moulding, not a bay; drop it rather than fake it.
      if (pr >= 0.35) spec.bayProj = pr;
      else { spec.bay = false; spec.bayProj = 0; }
    }
    this._clipStats.trimmed++;
  }

  /**
   * The parcel as `makeSpec` should see it: the clipped ring, plus every
   * direction that actually faces a street.
   *
   * The city's parcels are never mutated — props, traffic and the minimap read
   * the same array — so this returns a shallow copy whenever anything changed.
   */
  _respec(plot, poly, cutDirs) {
    const dirs = [];
    const push = (d) => {
      if (!d) return;
      for (const q of dirs) if (q.x * d.x + q.z * d.z > 0.985) return;
      dirs.push(d);
    };
    push(frontageDir(plot, poly));
    if (cutDirs) for (const d of cutDirs) push(d);
    if (!dirs.length) return poly === plot.polygon ? plot : { ...plot, polygon: poly };
    return { ...plot, polygon: poly, frontDirs: plot.frontDirs || dirs };
  }

  /**
   * Fuse rowhouse lots into tower superblocks inside the Back Bay clusters.
   *
   * Returns a NEW array in the input's order — `RoadNetwork.buildPlots` sorts by
   * distance from the centre and `MAX_BUILDINGS` is a count cap, so re-ordering
   * here would silently become a radius cap. A lot that is not merged is passed
   * through by reference and keeps its `id`, so its seed, and therefore every
   * roll in its spec, is bit-for-bit what it was before.
   *
   * The city's own parcels are never mutated: props, traffic and the minimap
   * read the same array.
   * @returns {Array<object>}
   */
  _superblocks(plots) {
    // Pass 1 — which lots are even candidates, bucketed by the frontage they sit on.
    const runs = new Map();
    for (const p of plots) {
      if (!p?.polygon || p.polygon.length !== 4 || !Number.isFinite(p.edgeId)) continue;
      if (!p.frontage?.a || !p.frontage?.b || !(p.depth > 6)) continue;
      const c = polyCentroid(p.polygon);
      const hit = towerCoreAt(c.x, c.z);
      if (!(hit.merge > 0) || !(hit.dist < hit.merge)) continue;
      if (Math.abs(polyArea2(p.polygon)) * 0.5 > SB_LOT_AREA) continue;
      const k = p.edgeId * 2 + (p.side > 0 ? 1 : 0);
      let arr = runs.get(k); if (!arr) runs.set(k, arr = []);
      arr.push(p);
    }
    if (!runs.size) return plots;

    // Pass 2 — chain each frontage by exact endpoint identity rather than by
    // emission order, then walk it accumulating compatible lots.
    /** @type {Map<object, ?object>} lot -> merged plot, or null if consumed */
    const fused = new Map();
    let made = 0;
    for (const list of runs.values()) {
      const byStart = new Map(), isTail = new Set();
      for (const p of list) { byStart.set(ptKey(p.frontage.a), p); isTail.add(ptKey(p.frontage.b)); }
      const seen = new Set();
      for (const head of list) {
        if (isTail.has(ptKey(head.frontage.a)) || seen.has(head)) continue;
        let run = [], acc = 0, want = 0;
        const flush = () => {
          const m = run.length >= 2 && acc >= SB_MIN_W ? this._fuse(run) : null;
          if (m) {
            fused.set(run[0], m);
            for (let i = 1; i < run.length; i++) fused.set(run[i], null);
            made++;
          }
          run = []; acc = 0;
        };
        for (let p = head; p && !seen.has(p); p = byStart.get(ptKey(p.frontage.b))) {
          seen.add(p);
          if (run.length) {
            const compat = this._sbCompatible(run, p) &&
              acc + p.width <= SB_MAX_W && run.length < SB_MAX_LOTS;
            if (!compat) flush();
          }
          if (!run.length) {
            // One target width per run, so the block sizes are not all identical.
            want = SB_MIN_W + hash2(Math.round(p.frontage.a.x) | 0,
                                    Math.round(p.frontage.a.z) | 0) * (SB_MAX_W - SB_MIN_W);
          }
          run.push(p); acc += p.width;
          if (acc >= want) flush();
        }
        flush();
      }
    }
    if (!made) return plots;

    const out = [];
    for (const p of plots) {
      if (!fused.has(p)) { out.push(p); continue; }
      const m = fused.get(p);
      if (m) out.push(m);
    }
    this._clipStats.superblocks = made;
    return out;
  }

  /** May `p` join this run? Collinear frontage and comparable depth, or no. */
  _sbCompatible(run, p) {
    const a = run[0].frontage, b = p.frontage;
    const ax = a.b.x - a.a.x, az = a.b.z - a.a.z;
    const bx = b.b.x - b.a.x, bz = b.b.z - b.a.z;
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    if ((ax * bx + az * bz) / (la * lb) < SB_COLLINEAR) return false;
    let lo = Infinity, hi = 0;
    for (const q of run) { if (q.depth < lo) lo = q.depth; if (q.depth > hi) hi = q.depth; }
    if (p.depth < lo) lo = p.depth; if (p.depth > hi) hi = p.depth;
    return hi <= lo * 1.30;
  }

  /**
   * One superblock out of a run of lots.
   *
   * `depth` is the run's minimum and the frontage is collinear, so the emitted
   * quad lies inside the union of the source parcels — it cannot reach land the
   * city did not already sell, and in particular cannot reach a road corridor
   * that every source parcel was already clear of.
   * @returns {?object} a plot in the `city.plots` shape
   */
  _fuse(run) {
    const first = run[0], last = run[run.length - 1];
    const a = first.frontage.a, b = last.frontage.b;
    // Outward is taken from the parcel itself: polygon is [p0, p1, q1, q0] with
    // q0 = p0 + outward * depth.
    const ox = first.polygon[3].x - first.polygon[0].x;
    const oz = first.polygon[3].z - first.polygon[0].z;
    const ol = Math.hypot(ox, oz);
    if (ol < 1e-6) return null;
    let depth = Infinity, y = 0, maxH = 0;
    const votes = new Map();
    for (const p of run) {
      if (p.depth < depth) depth = p.depth;
      y += Number.isFinite(p.y) ? p.y : 0;
      if ((p.maxHeight || 0) > maxH) maxH = p.maxHeight || 0;
      if (p.district) votes.set(p.district, (votes.get(p.district) || 0) + 1);
    }
    if (!(depth > 6)) return null;
    const dx = (ox / ol) * depth, dz = (oz / ol) * depth;
    let district = first.district ?? null, best = 0;
    for (const [k, v] of votes) if (v > best) { best = v; district = k; }
    return {
      id: first.id,
      polygon: [{ x: a.x, z: a.z }, { x: b.x, z: b.z },
                { x: b.x + dx, z: b.z + dz }, { x: a.x + dx, z: a.z + dz }],
      district, zoning: 'tower', maxHeight: maxH,
      frontage: { a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } },
      width: Math.hypot(b.x - a.x, b.z - a.z), depth,
      edgeId: first.edgeId, side: first.side,
      y: y / run.length,
    };
  }

  _buildSpecs() {
    const specs = [];
    this._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
    const parcels = this._superblocks(this.plots);
    const n = Math.min(parcels.length, MAX_BUILDINGS);
    let clipped = 0, dropped = 0;
    for (let i = 0; i < n; i++) {
      const plot = parcels[i];
      if (!plot?.polygon || plot.polygon.length < 3) continue;
      const cut = this._clipParcel(plot.polygon);
      if (!cut) { dropped++; continue; }
      const poly = cut.poly;
      if (cut.changed) clipped++;
      const c = polyCentroid(poly);
      if (isReserved(c.x, c.z)) continue;
      // The city publishes a per-parcel ground elevation; prefer it over
      // sampling the terrain ourselves so a building can never float or sink
      // relative to the pavement the city laid at the same height.
      const g = Number.isFinite(plot.y) ? plot.y : this.groundAt(c.x, c.z);
      const base = g - 0.25;
      if (!Number.isFinite(base)) continue;
      const src = this._respec(plot, poly, cut.cutDirs);
      const dist = this._districtOf(plot, c.x, c.z);
      const spec = makeSpec(dist === src.district ? src : { ...src, district: dist },
        base, (plot.id ?? i) * 2654435761 % 1048573 | 0);
      if (!spec) continue;
      this._fitOrnament(spec);
      spec.cx = c.x; spec.cz = c.z;
      // Conservative radius for culling and collider streaming.
      let rad = 0;
      for (const p of poly) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d > rad) rad = d;
      }
      spec.radius = rad + 2.5;
      specs.push(spec);
    }
    this.specs = specs;
    this._clipStats.clipped = clipped;
    this._clipStats.dropped = dropped;

    // Spatial bucketing
    this.chunks.clear();
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const cx = Math.floor(s.cx / CHUNK), cz = Math.floor(s.cz / CHUNK);
      const key = chunkKey(s);
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
      // Emit in streaming-chunk order so each chunk owns one contiguous run of
      // the sector's index buffer. That is what makes `_refreshShellMask` a
      // memcpy rather than a rebuild.
      list.sort((a, b) => chunkKey(this.specs[a]) - chunkKey(this.specs[b]));
      // Pre-size: growing a 1 M-vertex typed array by doubling costs more in
      // memcpy and GC than the whole emit does.
      const mb = new MeshBuf(Math.max(4096, list.length * 96));
      const spans = [];
      let cur = -1;
      for (const i of list) {
        const ck = chunkKey(this.specs[i]);
        if (ck !== cur) { spans.push({ key: ck, start: mb.ni, count: 0 }); cur = ck; }
        buildBuilding(this.specs[i], mb, null, 2);
        const sp = spans[spans.length - 1];
        sp.count = mb.ni - sp.start;
      }
      const g = mb.build(true);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this.matOpaque);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.fromArray(g.userData.origin);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'shell';
      mesh.onBeforeShadow = shellBeforeShadow;
      mesh.onAfterShadow = shellAfterShadow;
      this.root.add(mesh);
      const rec = {
        mesh, spans, full: g.index, mask: null, masked: false,
        drawCount: Infinity,
      };
      mesh.userData.sector = rec;
      this.sectors.set(key, rec);
    }
    this._maskDirty = true;
    this._maskSig = 1;
  }

  /**
   * Stop the always-resident shell from re-drawing buildings a detailed chunk is
   * already drawing.
   *
   * The shell is built for every building in the city and never turned off, so
   * wherever an LOD-0 chunk is loaded the same wall is rasterised twice: once as
   * the detailed mesh and once as the shell 0.25 m inside it. Measured at
   * `st_beaconhill`, the nearest in-frustum sector held 733 buildings of which
   * **704 already had a detailed mesh** — 61 k triangles of the 63 k that sector
   * submits, all of it hidden, all of it in the part of the frame that covers
   * the most pixels, and all of it re-submitted to three shadow cascades on top.
   *
   * Only LOD 0 is masked. An LOD-1 chunk mesh carries `castShadow = false`
   * (`_stepChunk`), so at that range the shell is the only thing casting the
   * building's shadow and dropping it would put holes in the cascade.
   *
   * The mask is a CAMERA-and-near-cascade state. The far cascade takes the
   * dropped spans back for the duration of its own pass (`shellBeforeShadow`),
   * because that is where the detailed mesh stands down — see the shadow-LOD
   * block at the top of this file.
   *
   * Nothing about the image changes: `Facades.buildShell` insets the shell 0.25 m
   * and drops every cap 0.30 m precisely so it is strictly inside its LOD-0 twin,
   * and window openings are closed by the glass mesh at every LOD.
   */
  _refreshShellMask() {
    this._maskDirty = false;
    const covered = this._covered;
    covered.clear();
    let sig = 0;
    for (const [key, ch] of this.chunks) {
      if (ch.meshes && ch.lod === 0) { covered.add(key); sig = (sig * 31 + key) | 0; }
    }
    // Streaming re-flags this on every chunk that completes, but the set of
    // LOD-0 chunks only actually moves when the camera crosses a boundary.
    if (sig === this._maskSig) return;
    this._maskSig = sig;
    for (const rec of this.sectors.values()) {
      let drop = 0;
      if (covered.size) {
        for (const sp of rec.spans) if (covered.has(sp.key)) drop += sp.count;
      }
      const g = rec.mesh.geometry;
      if (drop === 0) {
        if (rec.masked) {
          g.setIndex(rec.full);
          g.setDrawRange(0, Infinity);
          rec.masked = false;
          rec.drawCount = Infinity;
        }
        continue;
      }
      const src = rec.full.array;
      if (!rec.mask) {
        rec.mask = new THREE.BufferAttribute(new src.constructor(src.length), 1);
        rec.mask.setUsage(THREE.DynamicDrawUsage);
      }
      const dst = rec.mask.array;
      let n = 0;
      // Coalesce runs of chunks so this is a handful of typed-array `set()`
      // calls rather than a per-index copy.
      //
      // PARTITION, not a filter: the kept spans go first and the dropped ones
      // are appended behind them, so `mask` is a permutation of the whole index
      // buffer rather than a prefix of it. `drawRange = (0, n)` is then the
      // masked shell and `(0, Infinity)` the complete one, off ONE uploaded
      // attribute. That is what lets the far cascade take the complete shell
      // back inside `onBeforeShadow` — swapping `geometry.index` there would
      // reference a buffer three has not uploaded for this draw.
      const emit = (wanted) => {
        let runStart = -1, runEnd = -1;
        for (const sp of rec.spans) {
          if (covered.has(sp.key) !== wanted) {
            if (runStart >= 0) { dst.set(src.subarray(runStart, runEnd), n); n += runEnd - runStart; }
            runStart = -1;
          } else if (runStart < 0) { runStart = sp.start; runEnd = sp.start + sp.count; }
          else runEnd = sp.start + sp.count;
        }
        if (runStart >= 0) { dst.set(src.subarray(runStart, runEnd), n); n += runEnd - runStart; }
      };
      emit(false);            // spans no detailed chunk covers — the visible shell
      const kept = n;
      emit(true);             // the covered spans, parked past the draw range
      if (rec.mask.clearUpdateRanges) {
        rec.mask.clearUpdateRanges();
        rec.mask.addUpdateRange(0, n);
      }
      rec.mask.needsUpdate = true;
      g.setIndex(rec.mask);
      g.setDrawRange(0, kept);
      rec.masked = true;
      rec.drawCount = kept;
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
    const go = j.mb.build(true);
    if (go) {
      const m = new THREE.Mesh(go, this.matOpaque);
      m.castShadow = lod === 0;
      if (lod === 0) {
        // Cast into the near cascades at full detail; hand the far cascade back
        // to the shell, which is already resident under this mesh.
        m.onBeforeShadow = detailBeforeShadow;
        m.onAfterShadow = detailAfterShadow;
      }
      m.receiveShadow = true;
      m.position.fromArray(go.userData.origin);
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.root.add(m); meshes.push(m);
    }
    const gg = j.gb.build(true);
    if (gg) {
      const m = new THREE.Mesh(gg, this.matGlass);
      m.castShadow = false;
      m.receiveShadow = true;
      m.position.fromArray(gg.userData.origin);
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.root.add(m); meshes.push(m);
    }
    ch.meshes = meshes;
    ch.lod = lod;
    ch.job = null;
    this._maskDirty = true;
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
      this._maskDirty = true;
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
    if (this._maskDirty) this._refreshShellMask();
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

  /**
   * True when streaming has finished and the near field is real geometry.
   *
   * `capture()` parks the camera, which is a teleport, which invalidates every
   * near chunk at once — so for `CATCHUP_FRAMES` afterwards the shot is mostly
   * the crude LOD-2 shell. `capture()` used to advance a fixed 30 frames against
   * this system's 45, so every capture ever taken rendered a half-built city and
   * the visual critic measured flat pale shells next to fully facaded
   * neighbours. The harness now asks instead of counting, so the two can never
   * drift apart again.
   * @returns {boolean}
   */
  settled() { return this._catchUp === 0 && this._queue.length === 0; }

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
    this._disposeSectors();
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

  /**
   * Drop every shell sector. The full index attribute is put back first: three
   * frees the buffers of whatever `geometry.index` points at when the geometry
   * is disposed, so a sector left on its masked index would leak the original.
   */
  _disposeSectors() {
    for (const rec of this.sectors.values()) {
      const g = rec.mesh.geometry;
      if (rec.masked) { g.setIndex(rec.full); g.setDrawRange(0, Infinity); }
      rec.mask = null;
      this.root?.remove(rec.mesh);
      g.dispose();
    }
    this.sectors.clear();
  }

  stats() {
    let live = 0, tris = 0, shellTris = 0, maskedSectors = 0;
    for (const ch of this.chunks.values()) {
      if (!ch.meshes) continue;
      live++;
      for (const m of ch.meshes) tris += (m.geometry.index?.count ?? 0) / 3;
    }
    for (const rec of this.sectors.values()) {
      const g = rec.mesh.geometry;
      const n = Math.min(g.drawRange.count, g.index?.count ?? 0);
      shellTris += n / 3;
      if (rec.masked) maskedSectors++;
    }
    return { buildings: this.specs.length, liveChunks: live, sectors: this.sectors.size,
             maskedSectors, shellTris: shellTris | 0, tris: (tris + shellTris) | 0 };
  }

  dispose() {
    for (const ch of this.chunks.values()) this._disposeChunk(ch);
    this._disposeSectors();
    this.chunks.clear(); this.specs.length = 0;
    this._roadIndex = null;
    if (this.root) this.ctx?.scene.remove(this.root);
    // Textures and materials live in ctx.assets, which disposes them itself.
    void _v; void hash2;
  }
}

export { CHUNK, SECTOR, DISTRICTS, fallbackPlots };
