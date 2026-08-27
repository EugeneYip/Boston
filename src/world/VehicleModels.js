import * as THREE from 'three';

/**
 * Procedural vehicle bodies. There are no downloadable assets in this project, so every
 * car is lofted from cross-section stations at build time and cached per type.
 *
 * How a body is made:
 *  1. A handful of hand-placed *key stations* describe the silhouette front-to-back —
 *     sill height, beltline, roofline, tumblehome, half-width.
 *  2. Those are Catmull-Rom resampled along Z, which is what turns 12 control values
 *     into a surface that actually flows instead of reading as a chamfered box.
 *  3. The underside of each section is computed analytically so the wheel arches are
 *     true arcs cut into the body, with the wheel well as real interior geometry.
 *  4. Pillars, arch lips, mirrors and door shut-lines are swept along that same surface
 *     so they sit on it exactly rather than floating near it.
 *
 * Everything merges down to a handful of meshes per material, and there are three LODs;
 * the cheapest one is fed to an InstancedMesh pool by VehicleFactory.
 */

// ---------------------------------------------------------------------------
//  Small maths helpers
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Centripetal Catmull-Rom through irregularly spaced (x, y) samples. */
function splineAt(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (i < n - 1 && xs[i] < x) i++;
  const x1 = xs[i - 1], x2 = xs[i];
  const t = (x - x1) / (x2 - x1);
  const y0 = ys[Math.max(i - 2, 0)], y1 = ys[i - 1], y2 = ys[i], y3 = ys[Math.min(i + 1, n - 1)];
  const t2 = t * t, t3 = t2 * t;
  // Tension-limited Catmull-Rom: overshoot on a car body reads as a dent.
  const m1 = 0.5 * (y2 - y0), m2 = 0.5 * (y3 - y1);
  return (2 * t3 - 3 * t2 + 1) * y1 + (t3 - 2 * t2 + t) * m1 +
         (-2 * t3 + 3 * t2) * y2 + (t3 - t2) * m2;
}

// ---------------------------------------------------------------------------
//  Mesh builder — accumulates triangles into per-material buckets with welding
// ---------------------------------------------------------------------------

class MeshBuilder {
  constructor(remap) { this.buckets = new Map(); this.remap = remap || null; }

  _bucket(mat) {
    if (this.remap && this.remap[mat]) mat = this.remap[mat];
    let b = this.buckets.get(mat);
    if (!b) { b = { pos: [], idx: [], uv: [], map: new Map() }; this.buckets.set(mat, b); }
    return b;
  }

  /** Weld a vertex within a smoothing group so computeVertexNormals blends it. */
  _vert(b, sg, x, y, z, u, v) {
    const key = sg + '|' + (x * 2000 | 0) + '|' + (y * 2000 | 0) + '|' + (z * 2000 | 0);
    let i = b.map.get(key);
    if (i === undefined) {
      i = b.pos.length / 3;
      b.pos.push(x, y, z); b.uv.push(u, v);
      b.map.set(key, i);
    }
    return i;
  }

  /** Quad a-b-c-d, wound so (b-a)x(d-a) faces out. */
  quad(mat, sg, a, b2, c, d, uvs) {
    const b = this._bucket(mat);
    const i0 = this._vert(b, sg, a[0], a[1], a[2], uvs ? uvs[0] : 0, uvs ? uvs[1] : 0);
    const i1 = this._vert(b, sg, b2[0], b2[1], b2[2], uvs ? uvs[2] : 1, uvs ? uvs[3] : 0);
    const i2 = this._vert(b, sg, c[0], c[1], c[2], uvs ? uvs[4] : 1, uvs ? uvs[5] : 1);
    const i3 = this._vert(b, sg, d[0], d[1], d[2], uvs ? uvs[6] : 0, uvs ? uvs[7] : 1);
    if (i0 === i1 || i1 === i2 || i2 === i0) { /* degenerate side */ } else b.idx.push(i0, i1, i2);
    if (i0 === i2 || i2 === i3 || i3 === i0) { /* degenerate side */ } else b.idx.push(i0, i2, i3);
  }

  tri(mat, sg, a, b2, c) {
    const b = this._bucket(mat);
    const i0 = this._vert(b, sg, a[0], a[1], a[2], 0, 0);
    const i1 = this._vert(b, sg, b2[0], b2[1], b2[2], 1, 0);
    const i2 = this._vert(b, sg, c[0], c[1], c[2], 1, 1);
    if (i0 !== i1 && i1 !== i2 && i2 !== i0) b.idx.push(i0, i1, i2);
  }

  /** Bake an existing geometry (primitives: lathes, cylinders, boxes) into a bucket. */
  add(mat, geo, matrix) {
    const g = matrix ? geo.clone().applyMatrix4(matrix) : geo;
    const b = this._bucket(mat);
    const p = g.attributes.position.array;
    const uv = g.attributes.uv ? g.attributes.uv.array : null;
    const base = b.pos.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      b.pos.push(p[i], p[i + 1], p[i + 2]);
      b.uv.push(uv ? uv[(i / 3) * 2] : 0, uv ? uv[(i / 3) * 2 + 1] : 0);
    }
    const idx = g.index ? g.index.array : null;
    if (idx) for (let i = 0; i < idx.length; i++) b.idx.push(base + idx[i]);
    else for (let i = 0; i < p.length / 3; i++) b.idx.push(base + i);
    if (matrix) g.dispose();
    return this;
  }

  /** @returns {Map<string, THREE.BufferGeometry>} */
  build(smooth = true) {
    const out = new Map();
    for (const [mat, b] of this.buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      if (smooth || !g.attributes.normal) g.computeVertexNormals();
      g.computeBoundingSphere();
      out.set(mat, g);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
//  Body surface: stations -> rings
// ---------------------------------------------------------------------------

const RING_N = 26;          // 14 half-profile points, mirrored (12 duplicated)
const BAND_MAT = [
  'under', 'under', 'under',            // 0-2  floor, well inner wall, well ceiling
  'paint', 'paint', 'paint',            // 3-5  rocker, lower door, upper door
  'paint',                              // 6    shoulder / beltline
  'glass', 'glass',                     // 7-8  greenhouse
  'paint', 'paint', 'paint', 'paint',   // 9-12 drip rail, roof
];
const BAND_SG = [0, 0, 0, 1, 1, 1, 2, 3, 3, 4, 5, 5, 5];

/**
 * Material collapse per LOD. Every distinct material is a draw call, so near cars get
 * seven and mid-distance cars get five; distant ones get two and go through the
 * instanced pool. The visual cost of merging, say, the exhaust tip into the dark trim
 * is nil at any distance you'd notice the draw call.
 */
const REMAP_LOD0 = {
  gap: 'under', interior: 'under', mirror: 'chrome', exhaust: 'trimDark', grille: 'trimDark',
  caliper: 'trimDark', brake: 'chrome',
};
const REMAP_LOD1 = {
  gap: 'trimDark', interior: 'trimDark', mirror: 'chrome', exhaust: 'trimDark',
  grille: 'trimDark', under: 'trimDark', lensClear: 'chrome', tire: 'trimDark',
  brake: 'chrome', caliper: 'trimDark', taxiSign: 'paint', glassDark: 'glass',
};
const REMAP_LOD2 = {
  gap: 'trim', interior: 'trim', mirror: 'trim', exhaust: 'trim', grille: 'trim',
  under: 'trim', lensClear: 'trim', lensRed: 'trim', tire: 'trim', brake: 'trim',
  caliper: 'trim', taxiSign: 'trim', glass: 'trim', glassDark: 'trim', trimDark: 'trim',
  chrome: 'trim', decalTaxi: 'trim', decalPolice: 'trim', decalMbta: 'trim',
};

/**
 * Evaluate a body cross-section. Returns 14 half-profile points, bottom-centre first,
 * running out along the floor, up the side, over the shoulder and across the roof.
 */
function halfProfile(s, out) {
  const w = s.w, by = s.by, sy = s.sy, ty = s.ty, tw = s.tw, ry = s.ry, gw = s.gw;
  const crown = s.crown, gy = ry - crown;
  const wi = Math.min(s.wellInner, w * 0.97);
  out[0] = [0, by0(s)];
  out[1] = [wi, by0(s)];
  out[2] = [wi, by];
  out[3] = [w * 0.985, by];
  out[4] = [w, sy];
  out[5] = [w * 0.998, lerp(sy, ty, 0.55)];
  out[6] = [w * 0.985, ty];
  out[7] = [tw, ty + (gy - ty) * 0.13];
  out[8] = [tw * 0.975, ty + (gy - ty) * 0.60];
  out[9] = [gw * 1.02, gy - (gy - ty) * 0.06];
  out[10] = [gw, gy];
  out[11] = [gw * 0.70, ry - crown * 0.42];
  out[12] = [gw * 0.36, ry - crown * 0.08];
  out[13] = [0, ry];
  return out;
}
const by0 = (s) => s.floorY;

/**
 * Ring entry list: half-profile indices out along +X, then the mirrored ones back.
 * A negative entry means "mirror of this half-profile point". Passing a decimated
 * subset is how the distant LOD drops from 26 points a section to 12.
 */
function ringEntries(subset) {
  const idx = subset.slice();
  for (let i = subset.length - 2; i >= 1; i--) idx.push(-subset[i]);
  return idx;
}
const RING_FULL = ringEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const RING_COARSE = ringEntries([0, 3, 4, 6, 7, 10, 13]);

/** Ring points at a station, as flat [x,y] pairs, following `entries`. */
function ringOf(s, halfBuf, entries, out) {
  halfProfile(s, halfBuf);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    out[i] = e >= 0 ? halfBuf[e] : [-halfBuf[-e][0], halfBuf[-e][1]];
  }
  return out;
}

/**
 * Turn a sparse key-station description into a dense, resampled station list.
 * `body.keys` fields are splined; `by` (the underside) is analytic so the wheel arches
 * stay crisp arcs no matter how the rest of the surface is smoothed.
 */
function makeStations(body, step, coarse = false, minGap = 0) {
  const keys = body.keys;
  const zs = keys.map(k => k.z);
  const fields = ['w', 'sy', 'ty', 'tw', 'ry', 'gw', 'crown'];
  const table = {};
  for (const f of fields) table[f] = keys.map(k => k[f]);

  // z samples: uniform grid plus every feature edge, so arches and pillars stay sharp.
  const z0 = zs[0], z1 = zs[zs.length - 1];
  const set = new Set([z0, z1]);
  for (let z = z0; z <= z1; z += step) set.add(+z.toFixed(4));
  for (const k of keys) set.add(k.z);
  if (!coarse) {
    for (const a of body.arches) {
      for (const d of [-1, 1]) {
        set.add(+(a.z + d * a.r).toFixed(4));
        set.add(+(a.z + d * (a.r - 0.006)).toFixed(4));
        for (let i = 1; i < 7; i++) set.add(+(a.z + d * a.r * Math.sin(i / 7 * Math.PI / 2)).toFixed(4));
      }
      set.add(+a.z.toFixed(4));
    }
    for (const p of body.solidSpans || []) { set.add(p[0] - 0.004); set.add(p[0]); set.add(p[1]); set.add(p[1] + 0.004); }
    for (const p of body.glassSpans || []) { set.add(p[0] - 0.004); set.add(p[0]); set.add(p[1]); set.add(p[1] + 0.004); }
  } else {
    for (const a of body.arches) { set.add(+(a.z - a.r).toFixed(4)); set.add(+a.z.toFixed(4)); set.add(+(a.z + a.r).toFixed(4)); }
    for (const p of body.glassSpans || []) { set.add(p[0]); set.add(p[1]); }
  }

  let list = [...set].filter(z => z >= z0 - 1e-6 && z <= z1 + 1e-6).sort((a, b) => a - b);
  if (minGap > 0) {
    const thin = [list[0]];
    for (let i = 1; i < list.length - 1; i++) {
      if (list[i] - thin[thin.length - 1] >= minGap) thin.push(list[i]);
    }
    thin.push(list[list.length - 1]);
    list = thin;
  }

  return list.map(z => {
    const s = { z, floorY: body.floorY, wellInner: body.wellInner };
    for (const f of fields) s[f] = splineAt(zs, table[f], z);
    // Underside: floor pan, lifted into an arc wherever a wheel arch cuts through.
    let by = body.floorY;
    for (const a of body.arches) {
      const dz = z - a.z;
      if (Math.abs(dz) < a.r) by = Math.max(by, a.hub + Math.sqrt(a.r * a.r - dz * dz));
    }
    s.by = by;
    s.glass = insideAny(body.glassSpans, z) && !insideAny(body.solidSpans, z);
    return s;
  });
}

function insideAny(spans, z) {
  if (!spans) return false;
  for (const s of spans) if (z >= s[0] && z <= s[1]) return true;
  return false;
}

/** Loft the stations into a closed shell. */
function loftBody(mb, stations, opts = {}) {
  const entries = opts.coarse ? RING_COARSE : RING_FULL;
  const N = entries.length;
  const half = new Array(14);
  const rings = stations.map(s => ringOf(s, half, entries, new Array(N)));
  const n = stations.length;
  const zLen = stations[n - 1].z - stations[0].z;

  // Band k spans entries[k] -> entries[k+1]; its material is the lower profile index,
  // which makes the mirrored half fall out for free.
  const bandOf = [];
  for (let k = 0; k < N; k++) {
    const a = entries[k], b = entries[(k + 1) % N];
    bandOf.push(a >= 0 && b >= 0 ? Math.min(a, b) : Math.min(Math.abs(a), Math.abs(b)));
  }

  for (let i = 0; i < n - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const za = stations[i].z, zb = stations[i + 1].z;
    const va = (za - stations[0].z) / zLen, vb = (zb - stations[0].z) / zLen;
    const glass = stations[i].glass && stations[i + 1].glass;
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const band = bandOf[k];
      let mat = BAND_MAT[band];
      if (mat === 'glass' && !glass) mat = 'paint';
      const sg = BAND_SG[band] + (entries[k] < 0 || entries[k2] < 0 ? 10 : 0);
      const u0 = k / N, u1 = (k + 1) / N;
      mb.quad(mat, sg,
        [A[k][0], A[k][1], za], [A[k2][0], A[k2][1], za],
        [B[k2][0], B[k2][1], zb], [B[k][0], B[k][1], zb],
        [u0, va, u1, va, u1, vb, u0, vb]);
    }
  }

  // Caps. Fan to the section centroid; the fascia detail meshes cover these.
  for (const [ringIdx, front] of [[0, true], [n - 1, false]]) {
    const R = rings[ringIdx], z = stations[ringIdx].z;
    let cy = 0;
    for (const p of R) cy += p[1];
    cy /= N;
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const mat = BAND_MAT[bandOf[k]] === 'under' ? 'under' : (opts.capMat || 'paint');
      if (front) mb.tri(mat, 90, [0, cy, z], [R[k2][0], R[k2][1], z], [R[k][0], R[k][1], z]);
      else mb.tri(mat, 91, [0, cy, z], [R[k][0], R[k][1], z], [R[k2][0], R[k2][1], z]);
    }
  }
  return { rings, stations, entries };
}

/** Sample the lofted surface: ring index `k` (fractional) at longitudinal position z. */
function surfacePoint(surf, z, k, out) {
  const st = surf.stations;
  let i = 0;
  while (i < st.length - 2 && st[i + 1].z < z) i++;
  const t = clamp((z - st[i].z) / Math.max(st[i + 1].z - st[i].z, 1e-6), 0, 1);
  const N = surf.entries.length;
  const k0 = Math.floor(k) % N, k1 = (k0 + 1) % N, kt = k - Math.floor(k);
  const A = surf.rings[i], B = surf.rings[i + 1];
  const ax = lerp(A[k0][0], A[k1][0], kt), ay = lerp(A[k0][1], A[k1][1], kt);
  const bx = lerp(B[k0][0], B[k1][0], kt), by = lerp(B[k0][1], B[k1][1], kt);
  out[0] = lerp(ax, bx, t); out[1] = lerp(ay, by, t); out[2] = z;
  return out;
}

/**
 * Sweep a rounded bar along a path that lies on the body surface — pillars, drip rails,
 * shut-lines. Offsetting along the surface normal is what stops them z-fighting.
 */
function sweepPath(mb, mat, sg, pts, radius, sides = 4, offset = 0.004) {
  const n = pts.length;
  if (n < 2) return;
  const up = new THREE.Vector3();
  const dir = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3();
  const prev = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    // Outward normal approximated from the point's own x/y direction from the axis.
    nrm.set(p[0], p[1] * 0.15, 0).normalize();
    if (!isFinite(nrm.x)) nrm.set(1, 0, 0);
    bin.crossVectors(dir, nrm).normalize();
    up.crossVectors(bin, dir).normalize();
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a2 = (s / sides) * Math.PI * 2;
      const c = Math.cos(a2) * radius, si = Math.sin(a2) * radius;
      ring.push([
        p[0] + up.x * (c + offset) + bin.x * si,
        p[1] + up.y * (c + offset) + bin.y * si,
        p[2] + up.z * (c + offset) + bin.z * si,
      ]);
    }
    if (i > 0) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        mb.quad(mat, sg, prev[s], prev[s2], ring[s2], ring[s]);
      }
    }
    prev.length = 0; prev.push(...ring);
  }
}

// ---------------------------------------------------------------------------
//  Wheels
// ---------------------------------------------------------------------------

const _wheelCache = new Map();

/** Tyre + rim + brake disc, axis along +X, outboard face at +X. */
function buildWheel(r, w, style, lod) {
  const key = `${r.toFixed(3)}_${w.toFixed(3)}_${style}_${lod}`;
  if (_wheelCache.has(key)) return _wheelCache.get(key);
  const mb = new MeshBuilder(lod === 0 ? REMAP_LOD0 : lod === 1 ? REMAP_LOD1 : REMAP_LOD2);
  const seg = lod === 0 ? 20 : lod === 1 ? 12 : 6;
  const hw = w * 0.5;

  // --- tyre: lathed carcass with a real shoulder radius and a sidewall bulge
  const prof = lod === 0 ? [
    [r * 0.66, -hw * 0.92], [r * 0.78, -hw * 1.02], [r * 0.90, -hw * 1.06],
    [r * 0.975, -hw * 0.92], [r, -hw * 0.62], [r, 0], [r, hw * 0.62],
    [r * 0.975, hw * 0.92], [r * 0.90, hw * 1.06], [r * 0.78, hw * 1.02],
    [r * 0.66, hw * 0.92],
  ] : lod === 1 ? [
    [r * 0.66, -hw], [r * 0.94, -hw * 1.02], [r, -hw * 0.7], [r, hw * 0.7],
    [r * 0.94, hw * 1.02], [r * 0.66, hw],
  ] : [
    [r * 0.70, -hw], [r, -hw * 0.8], [r, hw * 0.8], [r * 0.70, hw],
  ];
  const tyre = new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), seg);
  tyre.rotateZ(-Math.PI / 2);       // lathe axis Y -> X
  mb.add('tire', tyre); tyre.dispose();

  if (lod === 0) {
    // Tread blocks: a coarse ring of shallow lugs. Reads as tread in a screenshot and
    // catches a specular break, which a smooth torus never does.
    const lug = new THREE.BoxGeometry(w * 0.62, r * 0.035, r * 0.16);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      place(mb, 'tire', lug, 0, Math.cos(a) * r * 0.995, -Math.sin(a) * r * 0.995, a, 0, 0);
    }
    lug.dispose();
  }

  // --- rim barrel
  const rimR = r * 0.665;
  if (lod < 2) {
    const barrel = new THREE.CylinderGeometry(rimR, rimR * 0.97, w * 0.86, seg, 1, true);
    barrel.rotateZ(Math.PI / 2);
    mb.add(style === 'steel' ? 'trimDark' : 'chrome', barrel); barrel.dispose();
  }

  // --- rim face
  const faceX = hw * 0.80;
  if (lod === 0 && style !== 'steel') {
    const spokes = style === 'truck' ? 6 : 5;
    const inner = new THREE.CylinderGeometry(r * 0.20, r * 0.20, 0.045, 12);
    inner.rotateZ(Math.PI / 2);
    place(mb, 'chrome', inner, faceX, 0, 0);
    inner.dispose();
    const spoke = new THREE.BoxGeometry(0.030, r * 0.47, r * 0.135);
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      place(mb, 'chrome', spoke, faceX, Math.cos(a) * r * 0.42, -Math.sin(a) * r * 0.42, a, 0, 0);
    }
    spoke.dispose();
    // Outer lip: a real rim has a bright flange that catches the light.
    const lip = new THREE.TorusGeometry(rimR * 0.99, 0.026, 4, seg);
    lip.rotateY(Math.PI / 2);
    place(mb, 'chrome', lip, hw * 0.90, 0, 0);
    lip.dispose();
  } else {
    const disc = new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, 0.03, seg);
    disc.rotateZ(Math.PI / 2);
    place(mb, style === 'steel' ? 'trimDark' : 'chrome', disc, faceX, 0, 0);
    disc.dispose();
    if (lod === 0) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        cyl(mb, 'chrome', 0.018, 0.018, 0.03,
          faceX + 0.012, Math.cos(a) * r * 0.22, -Math.sin(a) * r * 0.22, 0, 0, Math.PI / 2, 6);
      }
    }
  }

  // --- brake disc, only where you can actually see through the spokes
  if (lod === 0) {
    const rotor = new THREE.CylinderGeometry(r * 0.545, r * 0.545, 0.026, 16);
    rotor.rotateZ(Math.PI / 2);
    place(mb, 'brake', rotor, -hw * 0.10, 0, 0);
    rotor.dispose();
  }

  const geos = mb.build();
  const res = { geos, radius: r, width: w };
  _wheelCache.set(key, res);
  return res;
}

/** Caliper is separate: it must not spin with the wheel. */
const _caliperCache = new Map();
function buildCaliper(r, w) {
  const key = `${r.toFixed(3)}_${w.toFixed(3)}`;
  if (_caliperCache.has(key)) return _caliperCache.get(key);
  const mb = new MeshBuilder();
  cyl(mb, 'trimDark', r * 0.24, r * 0.24, w * 0.34, -w * 0.05, 0, 0, 0, 0, Math.PI / 2, 10);
  const body = new THREE.BoxGeometry(w * 0.30, r * 0.30, r * 0.16);
  mb.add('caliper', body, new THREE.Matrix4().makeTranslation(-w * 0.06, r * 0.44, -r * 0.10));
  body.dispose();
  const geos = mb.build();
  _caliperCache.set(key, geos);
  return geos;
}

// ---------------------------------------------------------------------------
//  Canvas-generated livery textures
// ---------------------------------------------------------------------------

const _texCache = new Map();
function makeTexture(key, w, h, draw) {
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  _texCache.set(key, t);
  return t;
}

function taxiDecal() {
  return makeTexture('veh_taxi_door', 512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    // Boston cabs: white car, black-and-white check band, medallion number on the door.
    const bandY = h * 0.46, bandH = h * 0.20, sq = bandH / 2;
    for (let x = 0; x < w; x += sq) {
      for (let r = 0; r < 2; r++) {
        g.fillStyle = ((x / sq | 0) + r) % 2 ? '#111214' : '#f2f2f0';
        g.fillRect(x, bandY + r * sq, sq, sq);
      }
    }
    g.fillStyle = '#16181c';
    g.font = 'bold 62px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('BOSTON CAB', w / 2, bandY - 22);
    g.font = 'bold 40px Helvetica, Arial, sans-serif';
    g.fillText('617·536·5010', w / 2, bandY + bandH + 46);
    g.strokeStyle = '#16181c'; g.lineWidth = 5;
    g.strokeRect(w * 0.40, bandY + bandH + 62, w * 0.20, 54);
    g.font = 'bold 38px Helvetica, Arial, sans-serif';
    g.fillText('1447', w * 0.50, bandY + bandH + 102);
  });
}

function policeDecal() {
  return makeTexture('veh_police_door', 512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    // BPD cruisers are white with a navy sweep and reflective gold-edged lettering.
    g.fillStyle = '#0d2350';
    g.beginPath();
    g.moveTo(0, h * 0.62); g.lineTo(w, h * 0.50); g.lineTo(w, h * 0.80); g.lineTo(0, h * 0.90);
    g.closePath(); g.fill();
    g.fillStyle = '#c8a02a';
    g.fillRect(0, h * 0.455, w, 6);
    g.fillStyle = '#0d2350';
    g.font = 'bold 56px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('BOSTON POLICE', w / 2, h * 0.36);
    g.font = 'bold 26px Helvetica, Arial, sans-serif';
    g.fillStyle = '#e8e9ec';
    g.fillText('TO PROTECT AND SERVE', w / 2, h * 0.72);
    // City seal, abstracted to a shield.
    g.fillStyle = '#0d2350';
    g.beginPath();
    g.moveTo(w * 0.09, h * 0.10); g.lineTo(w * 0.20, h * 0.10);
    g.lineTo(w * 0.20, h * 0.24); g.lineTo(w * 0.145, h * 0.32); g.lineTo(w * 0.09, h * 0.24);
    g.closePath(); g.fill();
    g.fillStyle = '#c8a02a'; g.font = 'bold 20px Georgia, serif';
    g.fillText('BPD', w * 0.145, h * 0.22);
  });
}

function mbtaDecal() {
  return makeTexture('veh_mbta_side', 1024, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f4c518';
    g.fillRect(0, h * 0.60, w, h * 0.16);
    g.fillStyle = '#1b1d21';
    g.fillRect(0, h * 0.77, w, h * 0.10);
    // The T roundel.
    const cx = w * 0.09, cy = h * 0.34, r = h * 0.24;
    g.fillStyle = '#0b0c0e';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.fillRect(cx - r * 0.52, cy - r * 0.46, r * 1.04, r * 0.30);
    g.fillRect(cx - r * 0.16, cy - r * 0.46, r * 0.32, r * 1.00);
    g.fillStyle = '#0b0c0e';
    g.font = 'bold 54px Helvetica, Arial, sans-serif';
    g.textAlign = 'left';
    g.fillText('MASSACHUSETTS BAY TRANSPORTATION AUTHORITY', w * 0.17, h * 0.40);
  });
}

function plateTexture(text) {
  return makeTexture('veh_plate_' + text, 256, 128, (g, w, h) => {
    g.fillStyle = '#f4f4ee'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#20304e'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#20304e';
    g.font = 'bold 22px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('MASSACHUSETTS', w / 2, 32);
    g.font = 'bold 56px Helvetica, Arial, sans-serif';
    g.fillText(text, w / 2, 88);
    g.font = '16px Helvetica, Arial, sans-serif';
    g.fillText('THE SPIRIT OF AMERICA', w / 2, 114);
  });
}

// ---------------------------------------------------------------------------
//  Body descriptions
// ---------------------------------------------------------------------------

/**
 * Key stations for each silhouette. z is metres from the body centre, front negative.
 *  w  = max half-width        sy = sill (widest) height
 *  ty = beltline height       tw = beltline half-width (tumblehome)
 *  ry = roof centre height    gw = roof edge half-width      crown = roof crown
 * The greenhouse collapses wherever ty ~= ry - crown, which is how bonnets and boots
 * fall out of the same 7 numbers as the cabin.
 */
const BODIES = {
  sedan: {
    floorY: 0.215, wellInner: 0.61,
    arches: [{ z: -1.425, r: 0.415, hub: 0.335 }, { z: 1.425, r: 0.415, hub: 0.335 }],
    glassSpans: [[-0.86, 1.28]], solidSpans: [[0.10, 0.235]],
    keys: [
      { z: -2.43, w: 0.735, sy: 0.545, ty: 0.815, tw: 0.660, ry: 0.845, gw: 0.560, crown: 0.028 },
      { z: -2.24, w: 0.868, sy: 0.505, ty: 0.900, tw: 0.800, ry: 0.930, gw: 0.700, crown: 0.028 },
      { z: -1.96, w: 0.905, sy: 0.470, ty: 0.952, tw: 0.855, ry: 0.978, gw: 0.770, crown: 0.026 },
      { z: -1.42, w: 0.920, sy: 0.452, ty: 0.995, tw: 0.878, ry: 1.018, gw: 0.812, crown: 0.024 },
      { z: -1.04, w: 0.916, sy: 0.448, ty: 1.018, tw: 0.872, ry: 1.040, gw: 0.810, crown: 0.024 },
      { z: -0.86, w: 0.912, sy: 0.446, ty: 1.028, tw: 0.858, ry: 1.052, gw: 0.800, crown: 0.024 },
      { z: -0.12, w: 0.908, sy: 0.444, ty: 1.030, tw: 0.800, ry: 1.452, gw: 0.660, crown: 0.052 },
      { z: 0.58, w: 0.905, sy: 0.444, ty: 1.024, tw: 0.792, ry: 1.462, gw: 0.658, crown: 0.052 },
      { z: 1.00, w: 0.898, sy: 0.446, ty: 1.012, tw: 0.780, ry: 1.330, gw: 0.640, crown: 0.044 },
      { z: 1.28, w: 0.888, sy: 0.450, ty: 1.120, tw: 0.812, ry: 1.168, gw: 0.760, crown: 0.030 },
      { z: 1.86, w: 0.882, sy: 0.470, ty: 1.115, tw: 0.808, ry: 1.148, gw: 0.756, crown: 0.026 },
      { z: 2.30, w: 0.856, sy: 0.520, ty: 1.080, tw: 0.780, ry: 1.108, gw: 0.720, crown: 0.024 },
      { z: 2.43, w: 0.740, sy: 0.560, ty: 1.010, tw: 0.665, ry: 1.038, gw: 0.600, crown: 0.022 },
    ],
  },
  suv: {
    floorY: 0.330, wellInner: 0.62,
    arches: [{ z: -1.43, r: 0.475, hub: 0.385 }, { z: 1.42, r: 0.475, hub: 0.385 }],
    glassSpans: [[-0.80, 1.72]], solidSpans: [[0.14, 0.285], [1.02, 1.13]],
    keys: [
      { z: -2.45, w: 0.780, sy: 0.660, ty: 1.010, tw: 0.700, ry: 1.045, gw: 0.600, crown: 0.030 },
      { z: -2.26, w: 0.905, sy: 0.620, ty: 1.090, tw: 0.845, ry: 1.125, gw: 0.740, crown: 0.030 },
      { z: -1.94, w: 0.955, sy: 0.580, ty: 1.148, tw: 0.902, ry: 1.185, gw: 0.822, crown: 0.028 },
      { z: -1.43, w: 0.972, sy: 0.560, ty: 1.196, tw: 0.925, ry: 1.235, gw: 0.865, crown: 0.026 },
      { z: -0.98, w: 0.968, sy: 0.556, ty: 1.222, tw: 0.918, ry: 1.262, gw: 0.862, crown: 0.026 },
      { z: -0.80, w: 0.964, sy: 0.554, ty: 1.232, tw: 0.905, ry: 1.276, gw: 0.852, crown: 0.026 },
      { z: -0.16, w: 0.960, sy: 0.552, ty: 1.238, tw: 0.868, ry: 1.735, gw: 0.760, crown: 0.056 },
      { z: 0.90, w: 0.955, sy: 0.554, ty: 1.230, tw: 0.860, ry: 1.752, gw: 0.756, crown: 0.056 },
      { z: 1.55, w: 0.948, sy: 0.560, ty: 1.222, tw: 0.848, ry: 1.740, gw: 0.744, crown: 0.052 },
      { z: 1.90, w: 0.938, sy: 0.575, ty: 1.212, tw: 0.836, ry: 1.700, gw: 0.730, crown: 0.048 },
      { z: 2.28, w: 0.900, sy: 0.620, ty: 1.170, tw: 0.800, ry: 1.630, gw: 0.700, crown: 0.040 },
      { z: 2.45, w: 0.790, sy: 0.680, ty: 1.100, tw: 0.700, ry: 1.540, gw: 0.610, crown: 0.034 },
    ],
  },
  sports: {
    floorY: 0.135, wellInner: 0.66,
    arches: [{ z: -1.34, r: 0.410, hub: 0.325 }, { z: 1.31, r: 0.430, hub: 0.340 }],
    glassSpans: [[-0.72, 0.92]], solidSpans: [[0.42, 0.55]],
    keys: [
      { z: -2.21, w: 0.760, sy: 0.330, ty: 0.585, tw: 0.700, ry: 0.610, gw: 0.610, crown: 0.022 },
      { z: -2.02, w: 0.900, sy: 0.310, ty: 0.640, tw: 0.845, ry: 0.665, gw: 0.740, crown: 0.022 },
      { z: -1.72, w: 0.955, sy: 0.295, ty: 0.700, tw: 0.900, ry: 0.724, gw: 0.815, crown: 0.020 },
      { z: -1.34, w: 0.985, sy: 0.288, ty: 0.760, tw: 0.930, ry: 0.784, gw: 0.850, crown: 0.020 },
      { z: -0.94, w: 0.955, sy: 0.286, ty: 0.775, tw: 0.905, ry: 0.800, gw: 0.845, crown: 0.020 },
      { z: -0.72, w: 0.948, sy: 0.286, ty: 0.782, tw: 0.870, ry: 0.808, gw: 0.800, crown: 0.020 },
      { z: -0.16, w: 0.952, sy: 0.288, ty: 0.800, tw: 0.760, ry: 1.155, gw: 0.560, crown: 0.048 },
      { z: 0.30, w: 0.968, sy: 0.292, ty: 0.805, tw: 0.762, ry: 1.170, gw: 0.560, crown: 0.048 },
      { z: 0.92, w: 1.000, sy: 0.300, ty: 0.845, tw: 0.860, ry: 0.980, gw: 0.700, crown: 0.032 },
      { z: 1.31, w: 1.010, sy: 0.312, ty: 0.925, tw: 0.930, ry: 0.952, gw: 0.860, crown: 0.024 },
      { z: 1.86, w: 0.985, sy: 0.340, ty: 0.905, tw: 0.905, ry: 0.930, gw: 0.840, crown: 0.022 },
      { z: 2.16, w: 0.930, sy: 0.375, ty: 0.860, tw: 0.845, ry: 0.886, gw: 0.780, crown: 0.020 },
      { z: 2.28, w: 0.800, sy: 0.400, ty: 0.800, tw: 0.720, ry: 0.826, gw: 0.650, crown: 0.020 },
    ],
  },
  van: {
    floorY: 0.300, wellInner: 0.60,
    arches: [{ z: -1.70, r: 0.455, hub: 0.365 }, { z: 1.62, r: 0.455, hub: 0.365 }],
    glassSpans: [[-2.10, -0.10]], solidSpans: [[-0.55, -0.42]],
    keys: [
      { z: -2.70, w: 0.760, sy: 0.640, ty: 0.930, tw: 0.700, ry: 0.965, gw: 0.610, crown: 0.030 },
      { z: -2.50, w: 0.910, sy: 0.600, ty: 1.000, tw: 0.860, ry: 1.036, gw: 0.760, crown: 0.030 },
      { z: -2.24, w: 0.968, sy: 0.570, ty: 1.062, tw: 0.918, ry: 1.100, gw: 0.840, crown: 0.028 },
      { z: -2.10, w: 0.975, sy: 0.562, ty: 1.075, tw: 0.905, ry: 1.120, gw: 0.826, crown: 0.028 },
      { z: -1.55, w: 0.982, sy: 0.556, ty: 1.120, tw: 0.880, ry: 2.020, gw: 0.800, crown: 0.070 },
      { z: -0.10, w: 0.995, sy: 0.556, ty: 1.140, tw: 0.930, ry: 2.128, gw: 0.870, crown: 0.070 },
      { z: 1.00, w: 0.998, sy: 0.560, ty: 1.150, tw: 0.940, ry: 2.150, gw: 0.880, crown: 0.070 },
      { z: 2.30, w: 0.995, sy: 0.570, ty: 1.150, tw: 0.938, ry: 2.140, gw: 0.878, crown: 0.068 },
      { z: 2.66, w: 0.965, sy: 0.600, ty: 1.130, tw: 0.910, ry: 2.090, gw: 0.850, crown: 0.060 },
      { z: 2.78, w: 0.870, sy: 0.640, ty: 1.090, tw: 0.820, ry: 2.010, gw: 0.760, crown: 0.050 },
    ],
  },
  bus: {
    floorY: 0.420, wellInner: 0.72,
    arches: [{ z: -4.35, r: 0.610, hub: 0.505 }, { z: 3.20, r: 0.610, hub: 0.505 }],
    glassSpans: [[-5.60, 4.60]], solidSpans: [[-3.05, -2.88], [-0.15, 0.02], [2.55, 2.72]],
    keys: [
      { z: -6.10, w: 0.980, sy: 0.700, ty: 1.130, tw: 0.900, ry: 1.180, gw: 0.800, crown: 0.040 },
      { z: -5.92, w: 1.190, sy: 0.660, ty: 1.220, tw: 1.130, ry: 1.290, gw: 1.020, crown: 0.040 },
      { z: -5.60, w: 1.270, sy: 0.640, ty: 1.320, tw: 1.230, ry: 3.080, gw: 1.130, crown: 0.090 },
      { z: -4.80, w: 1.295, sy: 0.630, ty: 1.380, tw: 1.250, ry: 3.180, gw: 1.170, crown: 0.090 },
      { z: 0.00, w: 1.300, sy: 0.630, ty: 1.390, tw: 1.258, ry: 3.200, gw: 1.180, crown: 0.090 },
      { z: 4.60, w: 1.298, sy: 0.630, ty: 1.385, tw: 1.255, ry: 3.190, gw: 1.176, crown: 0.090 },
      { z: 5.70, w: 1.280, sy: 0.650, ty: 1.360, tw: 1.230, ry: 3.140, gw: 1.150, crown: 0.080 },
      { z: 6.05, w: 1.150, sy: 0.700, ty: 1.300, tw: 1.100, ry: 3.020, gw: 1.020, crown: 0.070 },
      { z: 6.14, w: 0.960, sy: 0.740, ty: 1.240, tw: 0.910, ry: 2.900, gw: 0.840, crown: 0.060 },
    ],
  },
  truck: {
    floorY: 0.520, wellInner: 0.72,
    arches: [{ z: -2.55, r: 0.560, hub: 0.460 }, { z: 1.95, r: 0.560, hub: 0.460 }],
    glassSpans: [[-3.30, -2.05]], solidSpans: [],
    keys: [
      { z: -3.90, w: 0.900, sy: 0.760, ty: 1.180, tw: 0.840, ry: 1.220, gw: 0.740, crown: 0.030 },
      { z: -3.70, w: 1.100, sy: 0.720, ty: 1.260, tw: 1.040, ry: 1.305, gw: 0.930, crown: 0.030 },
      { z: -3.40, w: 1.180, sy: 0.700, ty: 1.320, tw: 1.120, ry: 1.372, gw: 1.020, crown: 0.028 },
      { z: -3.30, w: 1.190, sy: 0.696, ty: 1.335, tw: 1.110, ry: 1.400, gw: 1.010, crown: 0.028 },
      { z: -2.70, w: 1.200, sy: 0.690, ty: 1.400, tw: 1.090, ry: 2.480, gw: 0.990, crown: 0.070 },
      { z: -2.05, w: 1.200, sy: 0.690, ty: 1.420, tw: 1.120, ry: 2.520, gw: 1.030, crown: 0.070 },
      { z: -1.85, w: 1.215, sy: 0.700, ty: 2.560, tw: 1.180, ry: 2.600, gw: 1.140, crown: 0.030 },
      { z: 1.00, w: 1.230, sy: 0.700, ty: 2.580, tw: 1.195, ry: 2.620, gw: 1.155, crown: 0.030 },
      { z: 3.60, w: 1.230, sy: 0.700, ty: 2.580, tw: 1.195, ry: 2.620, gw: 1.155, crown: 0.030 },
      { z: 3.74, w: 1.180, sy: 0.720, ty: 2.520, tw: 1.140, ry: 2.560, gw: 1.100, crown: 0.030 },
    ],
  },
  pickup: {
    floorY: 0.380, wellInner: 0.64,
    arches: [{ z: -1.85, r: 0.505, hub: 0.410 }, { z: 1.78, r: 0.505, hub: 0.410 }],
    glassSpans: [[-1.18, 0.30]], solidSpans: [[-0.32, -0.19]],
    keys: [
      { z: -2.95, w: 0.840, sy: 0.780, ty: 1.170, tw: 0.760, ry: 1.205, gw: 0.660, crown: 0.030 },
      { z: -2.74, w: 0.985, sy: 0.740, ty: 1.245, tw: 0.925, ry: 1.282, gw: 0.820, crown: 0.030 },
      { z: -2.40, w: 1.020, sy: 0.700, ty: 1.300, tw: 0.968, ry: 1.340, gw: 0.890, crown: 0.028 },
      { z: -1.85, w: 1.028, sy: 0.680, ty: 1.330, tw: 0.975, ry: 1.372, gw: 0.900, crown: 0.026 },
      { z: -1.30, w: 1.022, sy: 0.676, ty: 1.352, tw: 0.965, ry: 1.398, gw: 0.895, crown: 0.026 },
      { z: -1.18, w: 1.018, sy: 0.674, ty: 1.360, tw: 0.940, ry: 1.420, gw: 0.860, crown: 0.026 },
      { z: -0.60, w: 1.015, sy: 0.672, ty: 1.372, tw: 0.900, ry: 1.905, gw: 0.790, crown: 0.056 },
      { z: 0.30, w: 1.012, sy: 0.674, ty: 1.365, tw: 0.895, ry: 1.912, gw: 0.786, crown: 0.056 },
      { z: 0.52, w: 1.010, sy: 0.676, ty: 1.360, tw: 0.930, ry: 1.400, gw: 0.870, crown: 0.030 },
      { z: 0.72, w: 1.020, sy: 0.678, ty: 1.330, tw: 0.980, ry: 1.360, gw: 0.930, crown: 0.026 },
      { z: 1.78, w: 1.030, sy: 0.686, ty: 1.320, tw: 0.990, ry: 1.348, gw: 0.945, crown: 0.024 },
      { z: 2.86, w: 1.028, sy: 0.700, ty: 1.315, tw: 0.988, ry: 1.342, gw: 0.942, crown: 0.024 },
      { z: 2.98, w: 0.960, sy: 0.740, ty: 1.280, tw: 0.920, ry: 1.308, gw: 0.870, crown: 0.024 },
    ],
  },
};
BODIES.taxi = BODIES.sedan;
BODIES.police = BODIES.sedan;

// ---------------------------------------------------------------------------
//  Type specs (physics + geometry + trim)
// ---------------------------------------------------------------------------

export const VEHICLE_TYPES = [
  'sedan', 'suv', 'taxi', 'police', 'sports', 'van', 'bus', 'truck', 'pickup',
];

const TYPE_DEFS = {
  sedan: {
    body: 'sedan', L: 4.86, W: 1.84, H: 1.474, mass: 1520, com: [0, 0.50, 0.06],
    axles: [-1.425, 1.425], tyreR: 0.335, tyreW: 0.225, track: 1.575,
    drive: 'fwd', tire: 'street', rim: 'alloy',
    peakTorque: 258, redline: 6300, idle: 780, topSpeed: 62,
    gears: [3.55, 2.02, 1.38, 1.03, 0.84, 0.68], reverse: 3.30, final: 3.95,
    cdA: 0.31 * 2.20, susRest: 0.34, sqRatio: 0.33,
    colors: ['#1b2a3d', '#8d1f24', '#b9bcc0', '#2d3033', '#e8e9ea', '#3c5a44', '#5a6a7a'],
    tags: { mirrors: true, exhaust: 1, plate: 'MA 2FT·471' },
  },
  suv: {
    body: 'suv', L: 4.92, W: 1.96, H: 1.79, mass: 2080, com: [0, 0.60, 0.02],
    axles: [-1.43, 1.42], tyreR: 0.385, tyreW: 0.255, track: 1.68,
    drive: 'awd', tire: 'utility', rim: 'alloy',
    peakTorque: 380, redline: 5800, idle: 720, topSpeed: 56,
    gears: [3.90, 2.30, 1.55, 1.14, 0.87, 0.69], reverse: 3.50, final: 3.55,
    cdA: 0.36 * 2.75, susRest: 0.40, sqRatio: 0.32,
    colors: ['#23262b', '#f0f1f2', '#4a5560', '#6d3c2a', '#1e3a2c', '#8b8f94'],
    tags: { mirrors: true, exhaust: 2, roofRails: true, plate: 'MA 8ZK·203' },
  },
  taxi: {
    body: 'sedan', L: 4.86, W: 1.84, H: 1.474, mass: 1610, com: [0, 0.50, 0.05],
    axles: [-1.425, 1.425], tyreR: 0.335, tyreW: 0.225, track: 1.575,
    drive: 'fwd', tire: 'street', rim: 'steel',
    peakTorque: 235, redline: 6000, idle: 760, topSpeed: 48,
    gears: [3.55, 2.02, 1.38, 1.03, 0.84, 0.68], reverse: 3.30, final: 3.95,
    cdA: 0.32 * 2.20, susRest: 0.35, sqRatio: 0.34,
    colors: ['#f2f2f0'], livery: 'taxi',
    tags: { mirrors: true, exhaust: 1, taxiSign: true, plate: 'MA TAXI 1447' },
  },
  police: {
    body: 'sedan', L: 4.94, W: 1.88, H: 1.478, mass: 1760, com: [0, 0.49, 0.04],
    axles: [-1.44, 1.44], tyreR: 0.345, tyreW: 0.245, track: 1.60,
    drive: 'awd', tire: 'performance', rim: 'steel',
    peakTorque: 420, redline: 6400, idle: 760, topSpeed: 66,
    gears: [3.40, 2.05, 1.42, 1.07, 0.85, 0.68], reverse: 3.20, final: 3.66,
    cdA: 0.33 * 2.25, susRest: 0.33, sqRatio: 0.30,
    colors: ['#f4f5f6'], livery: 'police',
    tags: { mirrors: true, exhaust: 2, lightBar: true, pushBar: true, spotlight: true,
            plate: 'MA BPD 214' },
  },
  sports: {
    body: 'sports', L: 4.49, W: 2.02, H: 1.19, mass: 1450, com: [0, 0.38, 0.10],
    axles: [-1.34, 1.31], tyreR: 0.345, tyreW: 0.305, track: 1.72,
    drive: 'rwd', tire: 'sport', rim: 'sport',
    peakTorque: 640, redline: 7800, idle: 900, topSpeed: 90,
    gears: [3.13, 2.10, 1.55, 1.20, 0.96, 0.78], reverse: 2.90, final: 3.44,
    cdA: 0.33 * 1.92, susRest: 0.24, sqRatio: 0.28,
    clAFront: 0.42 * 1.9, clARear: 0.62 * 1.9,
    colors: ['#8c0f16', '#101215', '#c9ccd0', '#0d3a6e', '#d8b12a', '#2f6b4a'],
    tags: { mirrors: true, exhaust: 4, wing: true, splitter: true, plate: 'MA GT·07' },
  },
  van: {
    body: 'van', L: 5.56, W: 2.00, H: 2.19, mass: 2320, com: [0, 0.72, -0.05],
    axles: [-1.70, 1.62], tyreR: 0.365, tyreW: 0.235, track: 1.71,
    drive: 'fwd', tire: 'utility', rim: 'steel',
    peakTorque: 340, redline: 4600, idle: 720, topSpeed: 44,
    gears: [4.05, 2.37, 1.56, 1.16, 0.85, 0.67], reverse: 3.80, final: 3.72,
    cdA: 0.36 * 4.10, susRest: 0.40, sqRatio: 0.36,
    colors: ['#eceded', '#4a5a6c', '#8d8f92', '#2b3d55', '#6b3a2c'],
    tags: { mirrors: 'big', exhaust: 1, plate: 'MA CM·9903' },
  },
  bus: {
    body: 'bus', L: 12.28, W: 2.60, H: 3.25, mass: 12800, com: [0, 1.05, 0.20],
    axles: [-4.35, 3.20], tyreR: 0.510, tyreW: 0.300, track: 2.10,
    drive: 'rwd', tire: 'heavy', rim: 'steel', dualRear: true,
    peakTorque: 1500, redline: 2600, idle: 620, topSpeed: 27,
    gears: [3.49, 1.86, 1.41, 1.00, 0.75, 0.65], reverse: 5.00, final: 5.63,
    cdA: 0.62 * 8.10, susRest: 0.34, sqRatio: 0.35,
    colors: ['#e9eaec'], livery: 'mbta',
    tags: { mirrors: 'big', exhaust: 0, busDoors: true, destSign: true, plate: 'MBTA 1847' },
  },
  truck: {
    body: 'truck', L: 7.68, W: 2.46, H: 2.66, mass: 6400, com: [0, 0.86, 0.16],
    axles: [-2.55, 1.95], tyreR: 0.470, tyreW: 0.280, track: 2.00,
    drive: 'rwd', tire: 'heavy', rim: 'steel', dualRear: true,
    peakTorque: 950, redline: 3200, idle: 650, topSpeed: 32,
    gears: [4.70, 2.55, 1.62, 1.15, 0.86, 0.70], reverse: 4.40, final: 4.63,
    cdA: 0.58 * 6.10, susRest: 0.36, sqRatio: 0.36,
    colors: ['#e4e5e6', '#3a4a63', '#7a2b2b', '#2e3134'],
    tags: { mirrors: 'big', exhaust: 1, boxBody: true, plate: 'MA TRK·618' },
  },
  pickup: {
    body: 'pickup', L: 5.97, W: 2.06, H: 1.92, mass: 2480, com: [0, 0.63, -0.10],
    axles: [-1.85, 1.78], tyreR: 0.415, tyreW: 0.275, track: 1.76,
    drive: 'awd', tire: 'utility', rim: 'truck',
    peakTorque: 620, redline: 5400, idle: 700, topSpeed: 54,
    gears: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69], reverse: 3.40, final: 3.73,
    cdA: 0.42 * 3.30, susRest: 0.44, sqRatio: 0.33,
    colors: ['#1f2933', '#8e1c1c', '#c8cacd', '#2b4c33', '#6d7278'],
    tags: { mirrors: 'big', exhaust: 1, bed: true, plate: 'MA PU·4412' },
  },
};

/** Build the runtime spec the Vehicle class consumes from the compact type table. */
function buildSpec(type) {
  const d = TYPE_DEFS[type];
  const nAxleZ = d.axles;
  const corner = (d.mass * 9.81) / (nAxleZ.length * 2);
  const rest = d.susRest;
  // Choose the rate so static compression is `sqRatio` of travel: that fixes ride height
  // and gives a natural frequency in the 1.2-1.8 Hz band real road cars use.
  const kFront = corner / (rest * d.sqRatio);
  const kRear = kFront * (d.drive === 'rwd' ? 1.06 : 0.94);
  const critF = 2 * Math.sqrt(kFront * (corner / 9.81));
  const critR = 2 * Math.sqrt(kRear * (corner / 9.81));

  const wheels = [];
  for (let a = 0; a < nAxleZ.length; a++) {
    const front = a === 0;
    const k = front ? kFront : kRear;
    const crit = front ? critF : critR;
    const halfTrack = d.track * 0.5;
    for (const side of [-1, 1]) {
      wheels.push({
        axle: a, steer: front, handbrake: !front,
        p: [side * halfTrack, d.tyreR + rest * (1 - d.sqRatio), nAxleZ[a]],
        radius: d.tyreR, width: d.tyreW,
        rest, stiffness: k,
        bump: crit * 0.30, rebound: crit * 0.56,
        arb: k * (front ? (d.drive === 'rwd' ? 0.30 : 0.42) : (d.drive === 'rwd' ? 0.40 : 0.24)),
      });
    }
  }

  const frontLoadShare = 0.56;
  const g = 9.81;
  const brakeF = d.mass * g * frontLoadShare * 1.85 * d.tyreR / 2;
  const brakeR = d.mass * g * (1 - frontLoadShare) * 1.15 * d.tyreR / 2;

  return {
    type,
    def: d,
    phys: {
      mass: d.mass, length: d.L, width: d.W, height: d.H,
      com: d.com,
      // The hull must clear the ground at ride height or it fights the suspension,
      // so it starts at the floor pan rather than at y = 0.
      colliderY: BODIES[d.body].floorY + (d.H - BODIES[d.body].floorY) * 0.5,
      colliderHalf: [d.W * 0.5 * 0.96, (d.H - BODIES[d.body].floorY) * 0.5 * 0.97,
                     d.L * 0.5 * 0.985],
      inertiaScale: d.body === 'bus' || d.body === 'truck' ? [1.0, 1.15, 1.05] : [0.82, 1.05, 0.95],
      tire: d.tire,
      susRest: rest, susStiffness: kFront, susBump: critF * 0.30, susRebound: critF * 0.56,
      arbFront: kFront * 0.36, arbRear: kRear * 0.28,
      brakeFront: brakeF, brakeRear: brakeR, handbrakeTorque: brakeR * 2.2,
      steerMax: d.body === 'bus' || d.body === 'truck' ? 0.62 : 0.58,
      steerMaxHigh: d.body === 'bus' || d.body === 'truck' ? 0.16 : 0.105,
      steerRate: d.body === 'bus' ? 1.9 : 3.4,
      selfCentre: 0.85,
      cdA: d.cdA, clAFront: d.clAFront || 0, clARear: d.clARear || 0,
      airControl: d.body === 'sports' ? 1.1 : 0.8,
    },
    engine: {
      peakTorque: d.peakTorque, redline: d.redline, idle: d.idle,
      gears: d.gears, reverse: d.reverse, final: d.final,
      drive: d.drive, awdFrontSplit: d.drive === 'awd' ? (type === 'police' ? 0.42 : 0.40) : 0,
      inertia: d.mass > 4000 ? 1.4 : (d.body === 'sports' ? 0.20 : 0.26),
      efficiency: 0.90, shiftTime: d.mass > 4000 ? 0.42 : (d.body === 'sports' ? 0.12 : 0.24),
      shiftUpLight: 0.36, shiftUpFull: 0.96, shiftDownLight: 0.17, shiftDownFull: 0.60,
      lsdPreload: d.body === 'sports' ? 120 : 45,
      lsdPower: d.body === 'sports' ? 0.45 : 0.24,
      abs: type !== 'sports', tcs: type !== 'sports', esc: type === 'taxi' || type === 'bus'
        || type === 'truck' || type === 'van',
      topSpeed: d.topSpeed,
      autoReverse: true,
    },
    wheels,
    seats: seatsFor(d),
  };
}

function seatsFor(d) {
  const y = d.com[1] + 0.16;
  const x = d.W * 0.24;
  if (d.body === 'bus') {
    return [{ name: 'driver', p: [-x, y + 0.30, -d.L * 0.40] },
            { name: 'passenger', p: [x, y + 0.30, -d.L * 0.30] }];
  }
  const zf = d.body === 'truck' || d.body === 'van' ? -d.L * 0.22 : -d.L * 0.02;
  const s = [{ name: 'driver', p: [-x, y, zf] }, { name: 'passenger', p: [x, y, zf] }];
  if (d.body === 'sedan' || d.body === 'suv') {
    s.push({ name: 'rearLeft', p: [-x, y, zf + 0.92] }, { name: 'rearRight', p: [x, y, zf + 0.92] });
  }
  return s;
}

export const VEHICLE_SPECS = {};
for (const t of VEHICLE_TYPES) VEHICLE_SPECS[t] = buildSpec(t);

export default VEHICLE_SPECS;

// ---------------------------------------------------------------------------
//  Detail primitives
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _qq = new THREE.Quaternion();
const _ee = new THREE.Euler();
const _vv = new THREE.Vector3();
const _sc = new THREE.Vector3(1, 1, 1);

function place(mb, mat, geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _ee.set(rx, ry, rz); _qq.setFromEuler(_ee);
  _m4.compose(_vv.set(x, y, z), _qq, _sc.set(sx, sy, sz));
  mb.add(mat, geo, _m4);
}

function box(mb, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  place(mb, mat, g, x, y, z, rx, ry, rz);
  g.dispose();
}

function roundBox(mb, mat, w, h, d, x, y, z, r = 0.03, rx = 0, ry = 0, rz = 0) {
  // Chamfered box: three crossed boxes read as a filleted solid for a fraction of the
  // triangles, and the specular break along the chamfer is what sells it.
  const a = new THREE.BoxGeometry(w, h - r * 2, d - r * 2);
  const b = new THREE.BoxGeometry(w - r * 2, h, d - r * 2);
  const c = new THREE.BoxGeometry(w - r * 2, h - r * 2, d);
  place(mb, mat, a, x, y, z, rx, ry, rz);
  place(mb, mat, b, x, y, z, rx, ry, rz);
  place(mb, mat, c, x, y, z, rx, ry, rz);
  a.dispose(); b.dispose(); c.dispose();
}

function cyl(mb, mat, r1, r2, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 12) {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  place(mb, mat, g, x, y, z, rx, ry, rz);
  g.dispose();
}

/** Body half-width at a longitudinal position, on a given ring index. */
const _sp = [0, 0, 0];
function surfX(surf, z, k) { surfacePoint(surf, z, k, _sp); return _sp[0]; }
function surfY(surf, z, k) { surfacePoint(surf, z, k, _sp); return _sp[1]; }

// ---------------------------------------------------------------------------
//  Body detailing
// ---------------------------------------------------------------------------

function archLips(mb, surf, d, lod) {
  const body = BODIES[d.body];
  for (const a of body.arches) {
    const steps = lod === 0 ? 15 : 8;
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const phi = (-1 + 2 * i / steps) * 1.62;          // ~93 deg each side
      const z = a.z + Math.sin(phi) * a.r;
      const y = a.hub + Math.cos(phi) * a.r;
      const wOut = Math.abs(surfX(surf, z, 3.6));
      const ring = [];
      // 4-point flare section: sits proud of the skin then tucks into the well.
      for (const [dx, dr] of [[0.030, -0.012], [0.014, 0.028], [-0.055, 0.020], [-0.070, -0.030]]) {
        ring.push([wOut + dx, y + dr * Math.cos(phi), z + dr * Math.sin(phi)]);
      }
      if (prev) {
        for (let s = 0; s < 4; s++) {
          const s2 = (s + 1) % 4;
          mb.quad('paint', 60, prev[s], prev[s2], ring[s2], ring[s]);
          mb.quad('paint', 60,
            [-prev[s2][0], prev[s2][1], prev[s2][2]], [-prev[s][0], prev[s][1], prev[s][2]],
            [-ring[s][0], ring[s][1], ring[s][2]], [-ring[s2][0], ring[s2][1], ring[s2][2]]);
        }
      }
      prev = ring;
    }
  }
}

function pillarsAndRails(mb, surf, d) {
  const body = BODIES[d.body];
  const span = body.glassSpans[0];
  const st = surf.stations;
  const zFrontGlass = span[0], zRearGlass = span[1];
  // Find where the roof actually starts/ends: the greenhouse is tallest between them.
  let zRoofF = zFrontGlass, zRoofR = zRearGlass, best = -1;
  for (const s of st) {
    const h = s.ry - s.crown - s.ty;
    if (h > best) { best = h; }
  }
  for (const s of st) {
    const h = s.ry - s.crown - s.ty;
    if (h > best * 0.82) { zRoofF = Math.min(zRoofF === zFrontGlass ? s.z : zRoofF, s.z); }
  }
  for (let i = st.length - 1; i >= 0; i--) {
    const h = st[i].ry - st[i].crown - st[i].ty;
    if (h > best * 0.82) { zRoofR = st[i].z; break; }
  }
  zRoofF = Math.max(zRoofF, zFrontGlass + 0.05);

  for (const sgn of [1, -1]) {
    const k = (idx) => (sgn > 0 ? idx : 26 - idx);
    // A-pillar: cowl shoulder up to the roof leading edge.
    const aPath = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = lerp(zFrontGlass + 0.02, zRoofF, t);
      const kk = lerp(6.15, 9.85, t * t * 0.82 + t * 0.18);
      surfacePoint(surf, z, k(kk), _sp);
      aPath.push([sgn > 0 ? Math.abs(_sp[0]) : -Math.abs(_sp[0]), _sp[1], _sp[2]]);
    }
    sweepPath(mb, 'paint', 61 + (sgn > 0 ? 0 : 1), aPath, 0.040, 4, 0.010);

    // C-pillar: roof trailing edge down to the belt at the base of the backlight.
    const cPath = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = lerp(zRoofR, zRearGlass - 0.02, t);
      const kk = lerp(9.85, 6.15, t * t * 0.82 + t * 0.18);
      surfacePoint(surf, z, k(kk), _sp);
      cPath.push([sgn > 0 ? Math.abs(_sp[0]) : -Math.abs(_sp[0]), _sp[1], _sp[2]]);
    }
    sweepPath(mb, 'paint', 63 + (sgn > 0 ? 0 : 1), cPath, 0.044, 4, 0.010);

    // Drip rail along the roof edge.
    const rPath = [];
    const nr = 7;
    for (let i = 0; i <= nr; i++) {
      const z = lerp(zRoofF, zRoofR, i / nr);
      surfacePoint(surf, z, k(9.9), _sp);
      rPath.push([sgn > 0 ? Math.abs(_sp[0]) : -Math.abs(_sp[0]), _sp[1], _sp[2]]);
    }
    sweepPath(mb, 'trimDark', 65 + (sgn > 0 ? 0 : 1), rPath, 0.020, 4, 0.006);
  }
  return { zRoofF, zRoofR, zFrontGlass, zRearGlass };
}

/** Vertical panel gap between two body sections — doors, bonnet, boot. */
function shutLine(mb, surf, z, k0, k1, sgn) {
  const path = [];
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const kk = lerp(k0, k1, i / n);
    surfacePoint(surf, z, sgn > 0 ? kk : 26 - kk, _sp);
    path.push([_sp[0], _sp[1], _sp[2]]);
  }
  sweepPath(mb, 'gap', 70, path, 0.009, 3, -0.004);
}

function doorFurniture(mb, surf, d, doorZs) {
  for (const sgn of [1, -1]) {
    for (const z of doorZs) shutLine(mb, surf, z, 3.2, 9.0, sgn);
    // Handles just under the beltline.
    for (let i = 0; i < doorZs.length - 1; i++) {
      const z = lerp(doorZs[i], doorZs[i + 1], 0.80);
      surfacePoint(surf, z, sgn > 0 ? 5.65 : 26 - 5.65, _sp);
      roundBox(mb, 'chrome', 0.032, 0.042, 0.145,
        _sp[0] + Math.sign(_sp[0]) * 0.018, _sp[1], _sp[2], 0.012);
    }
    // Rocker crease: the line every car has along the sill, and the thing that most
    // clearly separates a modelled car from an extruded slab in a side-on screenshot.
    const st = surf.stations;
    const cPath = [];
    for (let i = 0; i < st.length; i += 2) {
      const s = st[i];
      if (s.z < doorZs[0] - 0.55 || s.z > doorZs[doorZs.length - 1] + 0.55) continue;
      surfacePoint(surf, s.z, sgn > 0 ? 4.55 : 26 - 4.55, _sp);
      cPath.push([_sp[0], _sp[1], _sp[2]]);
    }
    if (cPath.length > 2) sweepPath(mb, 'paint', 71, cPath, 0.013, 3, 0.006);
  }
}

function mirrors(mb, surf, d, zBase, big) {
  const s = big ? 1.45 : 1.0;
  for (const sgn of [1, -1]) {
    surfacePoint(surf, zBase, sgn > 0 ? 6.4 : 26 - 6.4, _sp);
    const x = _sp[0], y = _sp[1], z = _sp[2];
    const ox = Math.sign(x) * (0.085 * s);
    cyl(mb, 'trimDark', 0.020, 0.016, 0.10 * s, x + ox * 0.35, y + 0.030, z, 0, 0, Math.sign(x) * -1.15);
    roundBox(mb, 'paint', 0.055 * s, 0.090 * s, 0.150 * s, x + ox, y + 0.070 * s, z - 0.01, 0.02,
      0, 0, Math.sign(x) * -0.10);
    box(mb, 'mirror', 0.010, 0.070 * s, 0.125 * s,
      x + ox + Math.sign(x) * 0.024 * s, y + 0.070 * s, z - 0.018, 0, 0.16 * Math.sign(x), 0);
  }
}

function headlights(mb, surf, d, out) {
  const body = BODIES[d.body];
  const zF = body.keys[0].z;
  const z = zF + (d.body === 'bus' || d.body === 'truck' ? 0.10 : 0.16);
  const wOut = Math.abs(surfX(surf, z, 4.4));
  const yTop = surfY(surf, z, 6.0);
  const yBot = surfY(surf, z, 4.2);
  const y = lerp(yBot, yTop, d.body === 'sports' ? 0.72 : 0.66);
  const hw = wOut * (d.body === 'bus' ? 0.34 : 0.40);
  const hh = d.body === 'sports' ? 0.085 : 0.105;

  for (const sgn of [1, -1]) {
    const cx = sgn * (wOut - hw * 0.55);
    // Housing recess, lens, and a separate emitter plane that we toggle.
    box(mb, 'trimDark', hw * 1.9, hh * 1.9, 0.10, cx, y, z + 0.055, 0, 0, 0);
    roundBox(mb, 'lensClear', hw * 1.86, hh * 1.86, 0.09, cx, y, z + 0.005, 0.022,
      0, sgn * 0.16, 0);
    out.head.push({ x: cx, y, z: z - 0.035, w: hw * 1.5, h: hh * 1.35, sgn });
    // Projector barrels read as headlight guts through the clear lens.
    cyl(mb, 'chrome', hh * 0.62, hh * 0.52, 0.05, cx - sgn * hw * 0.42, y, z + 0.035,
      Math.PI / 2, 0, 0, 10);
    cyl(mb, 'chrome', hh * 0.50, hh * 0.42, 0.05, cx + sgn * hw * 0.42, y, z + 0.035,
      Math.PI / 2, 0, 0, 10);
  }
  return { z, y, wOut, hw, hh };
}

function taillights(mb, surf, d, out) {
  const body = BODIES[d.body];
  const zR = body.keys[body.keys.length - 1].z;
  const z = zR - 0.12;
  const wOut = Math.abs(surfX(surf, z, 4.4));
  const y = lerp(surfY(surf, z, 4.2), surfY(surf, z, 6.0), 0.70);
  const hw = wOut * 0.34, hh = d.body === 'van' || d.body === 'truck' ? 0.20 : 0.115;

  for (const sgn of [1, -1]) {
    const cx = sgn * (wOut - hw * 0.60);
    box(mb, 'trimDark', hw * 1.9, hh * 1.9, 0.08, cx, y, z - 0.045);
    roundBox(mb, 'lensRed', hw * 1.84, hh * 1.84, 0.075, cx, y, z + 0.005, 0.020,
      0, -sgn * 0.14, 0);
    out.tail.push({ x: cx, y, z: z + 0.030, w: hw * 1.4, h: hh * 1.3, sgn });
    out.brake.push({ x: cx, y: y + hh * 0.42, z: z + 0.032, w: hw * 1.35, h: hh * 0.72, sgn });
    out.turnR.push({ x: cx, y: y - hh * 0.55, z: z + 0.032, w: hw * 1.3, h: hh * 0.55, sgn });
    out.reverse.push({ x: cx * 0.52, y: y - hh * 0.55, z: z + 0.030, w: hw * 0.55, h: hh * 0.45, sgn });
  }
  // High-level brake light on the parcel shelf / above the rear screen.
  const zh = zR - (d.body === 'sedan' ? 1.05 : 0.16);
  const yh = surfY(surf, zh, 6.6) + 0.03;
  out.brake.push({ x: 0, y: yh, z: zh + 0.04, w: 0.20, h: 0.022, sgn: 1 });
  return { z, y, wOut };
}

function frontFascia(mb, surf, d, out) {
  const body = BODIES[d.body];
  const zF = body.keys[0].z;
  const hl = headlights(mb, surf, d, out);
  const wOut = hl.wOut;

  // Grille: recessed dark panel, chrome surround, slats.
  const gw = wOut * (d.body === 'van' || d.body === 'truck' || d.body === 'bus' ? 0.62 : 0.50);
  const gy0 = hl.y - hl.hh * 1.1, gy1 = hl.y + hl.hh * 1.05;
  const gcy = (gy0 + gy1) * 0.5, gh = Math.max(gy1 - gy0, 0.16);
  box(mb, 'grille', gw * 2, gh, 0.06, 0, gcy, zF + 0.10);
  const slats = Math.max(3, Math.round(gh / 0.045));
  for (let i = 0; i < slats; i++) {
    const y = gy0 + (i + 0.5) * (gh / slats);
    box(mb, 'chrome', gw * 1.94, 0.014, 0.05, 0, y, zF + 0.065);
  }
  box(mb, 'chrome', gw * 2.06, gh + 0.028, 0.028, 0, gcy, zF + 0.055);

  // Lower intake + valance. Dark plastic below the bumper line is on every modern car.
  const yLow = surfY(surf, zF + 0.06, 4.0);
  const vy = lerp(yLow, gy0, 0.28);
  box(mb, 'grille', wOut * 1.30, Math.max(gh * 0.62, 0.13), 0.05, 0, vy, zF + 0.085);
  box(mb, 'trimDark', wOut * 1.86, 0.055, 0.09, 0, vy - gh * 0.42, zF + 0.10);

  // Number plate.
  const plateY = lerp(vy, gy0, -0.15);
  out.plateFront = { x: 0, y: plateY, z: zF + 0.035, w: 0.30, h: 0.15 };

  // Bumper shut line where the cover meets the wings.
  for (const sgn of [1, -1]) shutLine(mb, surf, zF + 0.62, 3.3, 6.4, sgn);

  // Bonnet shut line.
  const zCowl = body.glassSpans[0][0];
  for (const sgn of [1, -1]) {
    const path = [];
    for (let i = 0; i <= 6; i++) {
      const z = lerp(zF + 0.34, zCowl - 0.02, i / 6);
      surfacePoint(surf, z, sgn > 0 ? 6.05 : 26 - 6.05, _sp);
      path.push([_sp[0], _sp[1], _sp[2]]);
    }
    sweepPath(mb, 'gap', 72, path, 0.009, 3, -0.004);
  }
  return hl;
}

function rearFascia(mb, surf, d, out) {
  const body = BODIES[d.body];
  const zR = body.keys[body.keys.length - 1].z;
  const tl = taillights(mb, surf, d, out);
  const yLow = surfY(surf, zR - 0.06, 4.0);
  box(mb, 'trimDark', tl.wOut * 1.80, 0.10, 0.07, 0, yLow + 0.10, zR - 0.10);
  out.plateRear = { x: 0, y: lerp(yLow, tl.y, 0.42), z: zR - 0.032, w: 0.30, h: 0.15 };

  // Boot / tailgate shut line.
  for (const sgn of [1, -1]) shutLine(mb, surf, zR - 0.52, 3.3, 6.6, sgn);

  const n = d.tags.exhaust | 0;
  if (n > 0) {
    const spread = n === 1 ? [-tl.wOut * 0.62] :
      n === 2 ? [-tl.wOut * 0.66, tl.wOut * 0.66] :
      [-tl.wOut * 0.70, -tl.wOut * 0.50, tl.wOut * 0.50, tl.wOut * 0.70];
    for (const x of spread) {
      cyl(mb, 'chrome', 0.041, 0.038, 0.16, x, yLow + 0.045, zR - 0.10, Math.PI / 2, 0, 0, 10);
      cyl(mb, 'exhaust', 0.032, 0.032, 0.02, x, yLow + 0.045, zR - 0.035, Math.PI / 2, 0, 0, 8);
    }
  }
}

function wipersAndTrim(mb, surf, d) {
  const body = BODIES[d.body];
  const zCowl = body.glassSpans[0][0];
  for (const sgn of [1, -1]) {
    surfacePoint(surf, zCowl + 0.06, sgn > 0 ? 7.2 : 26 - 7.2, _sp);
    const g = new THREE.BoxGeometry(0.020, 0.014, 0.52);
    place(mb, 'trimDark', g, _sp[0] * 0.55, _sp[1] + 0.02, _sp[2] + 0.24, 0, sgn * 0.42, 0.10);
    g.dispose();
  }
}

// ---------------------------------------------------------------------------
//  Type-specific bodywork
// ---------------------------------------------------------------------------

function typeExtras(mb, surf, d, type, out, lod) {
  const body = BODIES[d.body];
  const zF = body.keys[0].z, zR = body.keys[body.keys.length - 1].z;

  if (d.tags.roofRails) {
    for (const sgn of [1, -1]) {
      const path = [];
      for (let i = 0; i <= 6; i++) {
        const z = lerp(-0.35, 1.65, i / 6);
        surfacePoint(surf, z, sgn > 0 ? 11.2 : 26 - 11.2, _sp);
        path.push([_sp[0], _sp[1] + 0.035, _sp[2]]);
      }
      sweepPath(mb, 'trimDark', 80, path, 0.026, 5, 0.010);
    }
  }

  if (d.tags.wing) {
    const zw = zR - 0.52;
    const wx = Math.abs(surfX(surf, zw, 4.2));
    const y = surfY(surf, zw, 6.6) + 0.30;
    box(mb, 'trimDark', wx * 1.86, 0.035, 0.30, 0, y, zw, -0.10, 0, 0);
    for (const sgn of [1, -1]) {
      box(mb, 'trimDark', 0.035, 0.30, 0.11, sgn * wx * 0.80, y - 0.15, zw + 0.02, 0.18, 0, 0);
    }
  }
  if (d.tags.splitter) {
    const wx = Math.abs(surfX(surf, zF + 0.28, 4.0));
    box(mb, 'trimDark', wx * 1.92, 0.028, 0.34, 0, surfY(surf, zF + 0.20, 3.4) - 0.01, zF + 0.14);
    // Side skirts.
    for (const sgn of [1, -1]) {
      box(mb, 'trimDark', 0.055, 0.075, 1.70, sgn * Math.abs(surfX(surf, 0, 4.0)) - 0.01,
        surfY(surf, 0, 3.6) + 0.02, 0);
    }
  }

  if (d.tags.taxiSign) {
    const y = surfY(surf, -0.05, 13) + 0.055;
    roundBox(mb, 'taxiSign', 0.62, 0.115, 0.20, 0, y, -0.10, 0.03);
    box(mb, 'trimDark', 0.30, 0.03, 0.10, 0, y - 0.075, -0.10);
  }

  if (d.tags.lightBar) {
    const y = surfY(surf, -0.10, 13) + 0.070;
    box(mb, 'trimDark', 1.24, 0.045, 0.20, 0, y - 0.045, -0.12);
    roundBox(mb, 'trimDark', 1.30, 0.105, 0.22, 0, y + 0.020, -0.12, 0.03);
    // Six emitter cells, alternating sides. Reds outboard-left, blues outboard-right,
    // which is how a real bar is laid out.
    for (let i = 0; i < 6; i++) {
      const x = -0.52 + i * 0.208;
      const isRed = i < 3;
      out[isRed ? 'sirenR' : 'sirenB'].push(
        { x, y: y + 0.022, z: -0.12, w: 0.088, h: 0.062, sgn: 1, axis: 'z' });
      out[isRed ? 'sirenR' : 'sirenB'].push(
        { x, y: y + 0.022, z: -0.12, w: 0.088, h: 0.062, sgn: -1, axis: 'z' });
    }
  }
  if (d.tags.pushBar) {
    const wx = Math.abs(surfX(surf, zF + 0.20, 4.4));
    const y0 = surfY(surf, zF + 0.10, 4.0) + 0.05;
    for (const sgn of [1, -1]) {
      box(mb, 'trimDark', 0.055, 0.62, 0.055, sgn * wx * 0.72, y0 + 0.31, zF - 0.09);
      box(mb, 'trimDark', 0.30, 0.055, 0.055, sgn * wx * 0.62, y0 + 0.05, zF + 0.02, 0, 0.5, 0);
    }
    box(mb, 'trimDark', wx * 1.50, 0.10, 0.05, 0, y0 + 0.58, zF - 0.09);
    box(mb, 'trimDark', wx * 1.50, 0.10, 0.05, 0, y0 + 0.24, zF - 0.09);
  }
  if (d.tags.spotlight) {
    surfacePoint(surf, body.glassSpans[0][0] + 0.05, 6.3, _sp);
    cyl(mb, 'chrome', 0.058, 0.058, 0.11, _sp[0] + 0.05, _sp[1] + 0.10, _sp[2], 0, 0, Math.PI / 2, 10);
  }

  if (d.tags.bed) {
    // Pickup bed: floor + inner walls + tailgate, so it reads as a hollow box.
    const zb0 = 0.62, zb1 = zR - 0.10;
    const wx = Math.abs(surfX(surf, (zb0 + zb1) / 2, 4.4));
    const yFloor = 1.03;
    box(mb, 'trimDark', wx * 1.62, 0.04, zb1 - zb0, 0, yFloor, (zb0 + zb1) / 2);
    for (const sgn of [1, -1]) {
      box(mb, 'paint', 0.04, 0.30, zb1 - zb0, sgn * wx * 0.81, yFloor + 0.15, (zb0 + zb1) / 2);
    }
    box(mb, 'paint', wx * 1.62, 0.30, 0.04, 0, yFloor + 0.15, zb0 + 0.02);
  }

  if (d.tags.boxBody) {
    // Box truck: corrugated side panels + roller shutter at the back.
    for (const sgn of [1, -1]) {
      for (let i = 0; i < 16; i++) {
        const z = lerp(-1.75, 3.5, i / 15);
        box(mb, 'paint', 0.022, 1.60, 0.05, sgn * 1.235, 1.72, z);
      }
    }
    for (let i = 0; i < 10; i++) {
      box(mb, 'trimDark', 2.30, 0.13, 0.03, 0, 0.86 + i * 0.165, zR - 0.03);
    }
  }

  if (d.tags.busDoors) {
    for (const z of [-4.95, 1.30]) {
      for (const sgn of [1, -1]) {
        box(mb, 'trimDark', 0.03, 1.62, 1.06, sgn * 1.295, 1.42, z);
        box(mb, 'glassDark', 0.02, 1.34, 0.94, sgn * 1.312, 1.50, z);
      }
    }
    // Roof hatches + HVAC pod.
    roundBox(mb, 'trimDark', 1.70, 0.22, 2.60, 0, 3.28, 1.20, 0.06);
  }
  if (d.tags.destSign) {
    box(mb, 'trimDark', 1.70, 0.30, 0.05, 0, 2.86, -6.06);
    out.destSign = { x: 0, y: 2.86, z: -6.10, w: 1.60, h: 0.24 };
  }

  if (d.body === 'bus' || d.body === 'truck' || d.body === 'van') {
    // Steel bumpers, because these things actually have them.
    const wx = Math.abs(surfX(surf, zF + 0.14, 4.4));
    const yb = surfY(surf, zF + 0.10, 3.4) + 0.10;
    roundBox(mb, 'trimDark', wx * 2.02, 0.20, 0.14, 0, yb, zF + 0.03, 0.04);
    const wr = Math.abs(surfX(surf, zR - 0.14, 4.4));
    roundBox(mb, 'trimDark', wr * 2.02, 0.20, 0.14, 0,
      surfY(surf, zR - 0.10, 3.4) + 0.10, zR - 0.03, 0.04);
  }
  if (d.tags.exhaust === 0 && d.body === 'bus') {
    cyl(mb, 'exhaust', 0.055, 0.055, 0.30, 1.10, 0.52, 5.60, Math.PI / 2, 0, 0, 10);
  }
}

// ---------------------------------------------------------------------------
//  Livery decals
// ---------------------------------------------------------------------------

function liveryDecals(mb, surf, d, type) {
  const put = (z0, z1, k0, k1, mat) => {
    const NZ = 8, NK = 4;
    for (const sgn of [1, -1]) {
      for (let i = 0; i < NZ; i++) {
        for (let j = 0; j < NK; j++) {
          const za = lerp(z0, z1, i / NZ), zb = lerp(z0, z1, (i + 1) / NZ);
          const ka = lerp(k0, k1, j / NK), kb = lerp(k0, k1, (j + 1) / NK);
          const P = (z, k) => {
            surfacePoint(surf, z, sgn > 0 ? k : 26 - k, _sp);
            return [_sp[0] + Math.sign(_sp[0] || sgn) * 0.010, _sp[1], _sp[2]];
          };
          const uA = sgn > 0 ? i / NZ : 1 - i / NZ, uB = sgn > 0 ? (i + 1) / NZ : 1 - (i + 1) / NZ;
          mb.quad(mat, 85, P(za, ka), P(zb, ka), P(zb, kb), P(za, kb),
            [uA, 1 - j / NK, uB, 1 - j / NK, uB, 1 - (j + 1) / NK, uA, 1 - (j + 1) / NK]);
        }
      }
    }
  };
  if (type === 'taxi') put(-0.95, 1.30, 3.6, 6.2, 'decalTaxi');
  else if (type === 'police') put(-1.00, 1.35, 3.6, 6.2, 'decalPolice');
  else if (type === 'bus') put(-5.4, 4.6, 3.6, 6.4, 'decalMbta');
}

// ---------------------------------------------------------------------------
//  Assembly
// ---------------------------------------------------------------------------

const _geoCache = new Map();

function emptyAnchors() {
  return { head: [], tail: [], brake: [], turnL: [], turnR: [], reverse: [],
           sirenR: [], sirenB: [], plateFront: null, plateRear: null, destSign: null };
}

/** Bake static wheels into a body builder — LOD1 and below don't animate them. */
function bakeWheels(mb, spec, lod) {
  const d = spec.def;
  const wheel = buildWheel(d.tyreR, d.tyreW, d.rim, lod);
  for (const c of spec.wheels) {
    const side = Math.sign(c.p[0]) || 1;
    for (const [name, geo] of wheel.geos) {
      place(mb, name, geo, c.p[0], d.tyreR, c.p[2], 0, side < 0 ? Math.PI : 0, 0);
      if (d.dualRear && c.axle > 0) {
        place(mb, name, geo, c.p[0] - side * d.tyreW * 1.06, d.tyreR, c.p[2],
          0, side < 0 ? Math.PI : 0, 0);
      }
    }
  }
}

/** Build (and cache) all geometry for a type. */
export function getVehicleGeometry(type) {
  if (_geoCache.has(type)) return _geoCache.get(type);
  const spec = VEHICLE_SPECS[type];
  const d = spec.def;
  const body = BODIES[d.body];
  const scale = Math.max(1, d.L / 5.0);      // buses need the same relative station count

  const result = { lods: [], wheel: null, caliper: null, anchors: emptyAnchors(), spec };

  for (let lod = 0; lod < 3; lod++) {
    const step = (lod === 0 ? 0.105 : lod === 1 ? 0.30 : 0.85) * scale;
    const mb = new MeshBuilder(lod === 0 ? REMAP_LOD0 : lod === 1 ? REMAP_LOD1 : REMAP_LOD2);
    const stations = makeStations(body, step, lod > 0, lod === 2 ? step * 0.8 : 0);
    const surf = loftBody(mb, stations, { coarse: lod === 2 });
    const anchors = emptyAnchors();

    if (lod < 2) {
      archLips(mb, surf, d, lod);
      frontFascia(mb, surf, d, anchors);
      rearFascia(mb, surf, d, anchors);
      typeExtras(mb, surf, d, type, anchors, lod);
      // Indicators live in the front lamp cluster.
      for (const h of anchors.head) {
        anchors.turnL.push({ x: h.x, y: h.y - h.h * 0.42, z: h.z, w: h.w * 0.44, h: h.h * 0.42,
          sgn: h.sgn, side: h.sgn });
      }
      for (const t of anchors.turnR) t.side = t.sgn;
      if (d.livery) liveryDecals(mb, surf, d, type);
    }
    if (lod === 0) {
      pillarsAndRails(mb, surf, d);
      const doorZs = d.body === 'sedan' || d.body === 'suv'
        ? [body.glassSpans[0][0] + 0.06, 0.17, 1.16]
        : (d.body === 'sports' ? [body.glassSpans[0][0] + 0.06, 0.92]
          : [body.glassSpans[0][0] + 0.02, body.glassSpans[0][1] - 0.02]);
      doorFurniture(mb, surf, d, doorZs);
      if (d.tags.mirrors) {
        mirrors(mb, surf, d, body.glassSpans[0][0] + 0.34, d.tags.mirrors === 'big');
      }
      wipersAndTrim(mb, surf, d);
      // Interior: a dark shell so the glass has something behind it. Without this,
      // windows read as painted-on holes the moment the sun is behind the car.
      const zc = (body.glassSpans[0][0] + body.glassSpans[0][1]) * 0.5;
      const wI = Math.abs(surfX(surf, zc, 6.5)) * 0.92;
      const yI = surfY(surf, zc, 6.2);
      const len = (body.glassSpans[0][1] - body.glassSpans[0][0]) * 0.94;
      box(mb, 'interior', wI * 2, 0.34, len, 0, yI - 0.08, zc);
      box(mb, 'interior', wI * 1.5, 0.30, 0.10, 0, yI + 0.16, zc + len * 0.30);
    } else {
      bakeWheels(mb, spec, lod);
    }

    const geos = mb.build();
    result.lods.push({ geos, anchors: lod < 2 ? anchors : null, surf: lod === 0 ? surf : null });
    if (lod === 0) result.anchors = anchors;
  }

  result.wheel = buildWheel(d.tyreR, d.tyreW, d.rim, 0);
  result.caliper = buildCaliper(d.tyreR, d.tyreW);
  result.plateTex = plateTexture(d.tags.plate || 'MA 0000');

  _geoCache.set(type, result);
  return result;
}

// ---------------------------------------------------------------------------
//  Materials
// ---------------------------------------------------------------------------

function wet(m) {
  // Opt into the global rain retune described in CONTRACTS.md.
  m.userData.wetnessRough = m.roughness;
  m.userData.wetnessColor = m.color.clone();
  return m;
}

/**
 * Resolve shared materials through the materials system when it exists, and fall back
 * to locally authored ones when it doesn't, so vehicles look right on their own.
 */
export function createMaterialKit(ctx) {
  const M = ctx?.get?.('materials');
  const owned = [];
  const own = (m) => { owned.push(m); return m; };
  const shared = (name, make) => {
    const m = M?.get?.(name);
    if (m && m.isMaterial) return m;
    return own(make());
  };

  const paintCache = new Map();
  const kit = {
    fromSystem: !!M,

    paint(hex) {
      const key = hex >>> 0;
      if (paintCache.has(key)) return paintCache.get(key);
      let m = M?.carPaint?.(hex);
      if (!m) {
        const base = M?.get?.('car_paint');
        if (base && base.isMaterial) { m = base.clone(); m.color.setHex(hex); }
      }
      if (!m) {
        m = new THREE.MeshPhysicalMaterial({
          color: hex, metalness: 0.62, roughness: 0.315,
          clearcoat: 1.0, clearcoatRoughness: 0.055,
          envMapIntensity: 1.15,
        });
        wet(m);
      }
      m.name = 'car_paint_' + key.toString(16);
      owned.push(m);
      paintCache.set(key, m);
      return m;
    },

    glass: shared('glass_car', () => wet(new THREE.MeshPhysicalMaterial({
      color: 0x121a22, metalness: 0.02, roughness: 0.045, transparent: true,
      opacity: 0.62, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 2.4, side: THREE.DoubleSide,
    }))),
    glassDark: own(new THREE.MeshPhysicalMaterial({
      color: 0x0a0d10, metalness: 0.1, roughness: 0.10, transparent: true,
      opacity: 0.82, depthWrite: false, envMapIntensity: 1.6,
    })),
    chrome: shared('chrome', () => new THREE.MeshStandardMaterial({
      color: 0xd7dade, metalness: 1.0, roughness: 0.115, envMapIntensity: 1.6,
    })),
    tire: shared('tire', () => wet(new THREE.MeshStandardMaterial({
      color: 0x14151a, metalness: 0.02, roughness: 0.90,
    }))),
    trimDark: own(wet(new THREE.MeshStandardMaterial({
      color: 0x1b1d21, metalness: 0.25, roughness: 0.62,
    }))),
    under: own(new THREE.MeshStandardMaterial({
      color: 0x0b0c0e, metalness: 0.15, roughness: 0.95,
    })),
    grille: own(new THREE.MeshStandardMaterial({
      color: 0x0c0d10, metalness: 0.45, roughness: 0.48,
    })),
    gap: own(new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.9, metalness: 0.1 })),
    brake: own(new THREE.MeshStandardMaterial({
      color: 0x4a4c52, metalness: 0.92, roughness: 0.42,
    })),
    caliper: own(new THREE.MeshStandardMaterial({
      color: 0x8d1116, metalness: 0.5, roughness: 0.40,
    })),
    mirror: own(new THREE.MeshStandardMaterial({
      color: 0xc8ccd2, metalness: 1.0, roughness: 0.06, envMapIntensity: 2.0,
    })),
    exhaust: own(new THREE.MeshStandardMaterial({
      color: 0x14161a, metalness: 0.7, roughness: 0.55,
    })),
    interior: own(new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.85 })),
    lensClear: own(new THREE.MeshPhysicalMaterial({
      color: 0xdfe6ec, metalness: 0.0, roughness: 0.06, transparent: true, opacity: 0.42,
      clearcoat: 1, depthWrite: false, envMapIntensity: 2.2,
    })),
    lensRed: own(new THREE.MeshPhysicalMaterial({
      color: 0x8e0d12, metalness: 0.0, roughness: 0.10, transparent: true, opacity: 0.72,
      clearcoat: 1, depthWrite: false, envMapIntensity: 1.5,
    })),
    taxiSign: own(new THREE.MeshStandardMaterial({
      color: 0xf3c53a, roughness: 0.45, metalness: 0.05,
      emissive: 0xf3c53a, emissiveIntensity: 0.35,
    })),
    trim: own(new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.7, metalness: 0.3 })),

    decalTaxi: own(new THREE.MeshStandardMaterial({
      map: taxiDecal(), transparent: true, roughness: 0.34, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2,
    })),
    decalPolice: own(new THREE.MeshStandardMaterial({
      map: policeDecal(), transparent: true, roughness: 0.30, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2,
    })),
    decalMbta: own(new THREE.MeshStandardMaterial({
      map: mbtaDecal(), transparent: true, roughness: 0.42, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2,
    })),

    /** Per-vehicle emissive lamp material. Toggled by visibility, tuned by intensity. */
    lamp(hex, intensity) {
      const m = new THREE.MeshStandardMaterial({
        color: hex, emissive: hex, emissiveIntensity: intensity,
        roughness: 0.3, metalness: 0, toneMapped: true,
      });
      return m;
    },

    dispose() {
      for (const m of owned) m.dispose();
      owned.length = 0;
      paintCache.clear();
    },
  };
  return kit;
}

// ---------------------------------------------------------------------------
//  Emitter geometry (light groups)
// ---------------------------------------------------------------------------

const _emitCache = new Map();
function buildEmitters(type, anchors) {
  if (_emitCache.has(type)) return _emitCache.get(type);
  const groups = {};
  const mk = (list, filter) => {
    const mb = new MeshBuilder();
    let any = false;
    for (const a of list) {
      if (filter && !filter(a)) continue;
      const g = new THREE.BoxGeometry(a.w, a.h, 0.035);
      place(mb, 'e', g, a.x, a.y, a.z, 0, 0, 0);
      g.dispose(); any = true;
    }
    if (!any) return null;
    const built = mb.build();
    return built.get('e') || null;
  };
  groups.head = mk(anchors.head);
  groups.tail = mk(anchors.tail);
  groups.brake = mk(anchors.brake);
  groups.reverse = mk(anchors.reverse);
  groups.turnL = mk([...anchors.turnL, ...anchors.turnR], a => a.side < 0);
  groups.turnR = mk([...anchors.turnL, ...anchors.turnR], a => a.side > 0);
  groups.sirenR = mk(anchors.sirenR);
  groups.sirenB = mk(anchors.sirenB);
  _emitCache.set(type, groups);
  return groups;
}

// ---------------------------------------------------------------------------
//  VehicleVisual
// ---------------------------------------------------------------------------

const LAMP = {
  head: { hex: 0xfff2d8, on: 5.5, high: 11.0 },
  tail: { hex: 0xff2418, on: 1.4 },
  brake: { hex: 0xff2010, on: 7.0 },
  reverse: { hex: 0xf4f7ff, on: 4.0 },
  turn: { hex: 0xff8c10, on: 7.0 },
  sirenR: { hex: 0xff1418, on: 14.0 },
  sirenB: { hex: 0x2050ff, on: 14.0 },
};

// Real bar patterns are bursts, not a sine: three quick hits then a gap, sides alternating.
const SIREN_PATTERN = [
  1, 1, 0, 1, 1, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0, 0,
];

export class VehicleVisual {
  /**
   * @param {string} type
   * @param {object} opts { kit, color, lighting, castShadow }
   */
  constructor(type, opts = {}) {
    const geo = getVehicleGeometry(type);
    this.type = type;
    this.geo = geo;
    this.kit = opts.kit;
    this.spec = geo.spec;
    this.def = geo.spec.def;
    this.color = opts.color ?? 0xcccccc;
    this._owned = [];
    this._lod = -1;
    this._blink = 0;
    this._sirenT = 0;

    this.root = new THREE.Group();
    this.root.name = 'vehicle_' + type;
    this.root.matrixAutoUpdate = true;

    const paintMat = this.kit.paint(this.color);
    const matFor = (name) => {
      switch (name) {
        case 'paint': return paintMat;
        case 'glass': return this.kit.glass;
        case 'glassDark': return this.kit.glassDark;
        case 'under': return this.kit.under;
        case 'chrome': return this.kit.chrome;
        case 'tire': return this.kit.tire;
        case 'brake': return this.kit.brake;
        case 'caliper': return this.kit.caliper;
        case 'grille': return this.kit.grille;
        case 'gap': return this.kit.gap;
        case 'mirror': return this.kit.mirror;
        case 'exhaust': return this.kit.exhaust;
        case 'interior': return this.kit.interior;
        case 'lensClear': return this.kit.lensClear;
        case 'lensRed': return this.kit.lensRed;
        case 'taxiSign': return this.kit.taxiSign;
        case 'decalTaxi': return this.kit.decalTaxi;
        case 'decalPolice': return this.kit.decalPolice;
        case 'decalMbta': return this.kit.decalMbta;
        case 'trim': return this.kit.trim;
        default: return this.kit.trimDark;
      }
    };
    this._matFor = matFor;

    // --- body LODs
    this.lodGroups = [];
    for (let l = 0; l < 3; l++) {
      const g = new THREE.Group();
      g.visible = false;
      for (const [name, bg] of geo.lods[l].geos) {
        const m = new THREE.Mesh(bg, matFor(name));
        m.castShadow = opts.castShadow !== false && name !== 'gap' && name !== 'under';
        m.receiveShadow = l === 0;
        m.renderOrder = name === 'glass' ? 2 : (name.startsWith('decal') ? 1 : 0);
        m.frustumCulled = false;              // the parent group is culled instead
        if (name === 'paint') { if (l === 0) this._paintMesh = m; }
        g.add(m);
      }
      this.root.add(g);
      this.lodGroups.push(g);
    }

    // --- number plates
    const pt = geo.plateTex;
    if (pt && geo.anchors.plateFront) {
      const pm = new THREE.MeshStandardMaterial({ map: pt, roughness: 0.55, metalness: 0.1 });
      this._owned.push(pm);
      for (const a of [geo.anchors.plateFront, geo.anchors.plateRear]) {
        if (!a) continue;
        const pg = new THREE.PlaneGeometry(a.w, a.h);
        const mesh = new THREE.Mesh(pg, pm);
        mesh.position.set(a.x, a.y, a.z + (a === geo.anchors.plateFront ? -0.006 : 0.006));
        if (a !== geo.anchors.plateFront) mesh.rotation.y = Math.PI;
        this._owned.push(pg);
        this.lodGroups[0].add(mesh);
      }
    }

    // --- lamps (per-vehicle materials so each car's lights are independent)
    const em = buildEmitters(type, geo.anchors);
    this.lamps = {};
    const addLamp = (key, cfg, geoRef) => {
      if (!geoRef) return;
      const mat = this.kit.lamp(cfg.hex, cfg.on);
      const mesh = new THREE.Mesh(geoRef, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this._owned.push(mat);
      this.lodGroups[0].add(mesh);
      const m1 = new THREE.Mesh(geoRef, mat);
      m1.visible = false; m1.frustumCulled = false; m1.renderOrder = 3;
      this.lodGroups[1].add(m1);
      this.lamps[key] = { mesh, mesh1: m1, mat, base: cfg.on };
    };
    addLamp('head', LAMP.head, em.head);
    addLamp('tail', LAMP.tail, em.tail);
    addLamp('brake', LAMP.brake, em.brake);
    addLamp('reverse', LAMP.reverse, em.reverse);
    addLamp('turnL', LAMP.turn, em.turnL);
    addLamp('turnR', LAMP.turn, em.turnR);
    addLamp('sirenR', LAMP.sirenR, em.sirenR);
    addLamp('sirenB', LAMP.sirenB, em.sirenB);

    // --- wheels: only ever present at LOD0. Past ~30 m you cannot see a wheel rotate
    // on a moving car, so LOD1/2 bake them into the body and save 12 draw calls.
    this.wheels = [];
    const wcfg = this.spec.wheels;
    const wheelGeo = geo.wheel;
    this.wheelRoot = new THREE.Group();
    this.root.add(this.wheelRoot);
    for (let i = 0; i < wcfg.length; i++) {
      const c = wcfg[i];
      const side = Math.sign(c.p[0]) || 1;
      const root = new THREE.Group();
      root.position.set(c.p[0], c.p[1] - c.rest, c.p[2]);
      const spin = new THREE.Group();
      root.add(spin);
      for (const [name, bg] of wheelGeo.geos) {
        const m = new THREE.Mesh(bg, matFor(name));
        m.castShadow = true;
        m.frustumCulled = false;
        spin.add(m);
        if (this.def.dualRear && c.axle > 0) {
          const m2 = new THREE.Mesh(bg, matFor(name));
          m2.position.x = -side * c.width * 1.06;
          m2.castShadow = true;
          m2.frustumCulled = false;
          spin.add(m2);
        }
      }
      // Caliper hangs off the upright, so it must not spin.
      const cal = new THREE.Group();
      for (const [name, bg] of geo.caliper) {
        const m = new THREE.Mesh(bg, matFor(name));
        m.frustumCulled = false;
        cal.add(m);
      }
      root.add(cal);
      this.wheels.push({ root, spin, caliper: cal, side, cfg: c });
      this.wheelRoot.add(root);
    }

    // --- optional real lights from the lighting agent
    const lighting = opts.lighting;
    this.lightHandles = [];
    if (lighting?.registerLight && geo.anchors.head.length) {
      for (const a of geo.anchors.head) {
        const anchor = new THREE.Object3D();
        anchor.position.set(a.x, a.y, a.z - 0.05);
        this.lodGroups[0].add(anchor);
        try {
          const h = lighting.registerLight(anchor, {
            type: 'headlight', range: 55, intensity: 0,
          });
          if (h) this.lightHandles.push(h);
        } catch (e) { /* lighting agent not ready for this shape yet */ }
      }
    }

    this.setLod(0);
  }

  /** @param {number} level 0 = full, 1 = medium, 2 = distant shell */
  setLod(level) {
    if (level === this._lod) return;
    this._lod = level;
    for (let i = 0; i < 3; i++) this.lodGroups[i].visible = i === level;
    this.wheelRoot.visible = level === 0;
  }

  /** Hide everything — used when an instanced shell is standing in for this car. */
  setHidden(on) {
    this.root.visible = !on;
  }

  /**
   * @param {number} i        wheel index
   * @param {number} susLen   current suspension length (m)
   * @param {number} steer    steer angle (rad)
   * @param {number} spin     accumulated wheel rotation (rad)
   */
  setWheel(i, susLen, steer, spin) {
    if (this._lod !== 0) return;
    const w = this.wheels[i];
    if (!w) return;
    w.root.position.y = w.cfg.p[1] - susLen;
    // The left-hand wheels are the same geometry turned around, so their spin flips.
    const flip = w.side < 0;
    w.root.rotation.y = steer + (flip ? Math.PI : 0);
    w.spin.rotation.x = flip ? -spin : spin;
  }

  /** Drive every lamp from the vehicle's actual state. */
  setLights(v, dt) {
    const L = this.lamps;
    const on = (k, vis, intensity) => {
      const l = L[k]; if (!l) return;
      l.mesh.visible = vis && this._lod === 0;
      if (l.mesh1) l.mesh1.visible = vis && this._lod === 1;
      if (vis && intensity !== undefined && l.mat.emissiveIntensity !== intensity) {
        l.mat.emissiveIntensity = intensity;
      }
    };

    on('head', v.headlightsOn, v.highBeams ? LAMP.head.high : LAMP.head.on);
    on('tail', v.headlightsOn || v.brakeLightOn, LAMP.tail.on);
    on('brake', v.brakeLightOn, LAMP.brake.on);
    on('reverse', v.reverseLightOn, LAMP.reverse.on);

    this._blink += dt;
    const blinkOn = (this._blink % 0.94) < 0.47;
    on('turnL', v.indicator < 0 && blinkOn, LAMP.turn.on);
    on('turnR', v.indicator > 0 && blinkOn, LAMP.turn.on);

    if (L.sirenR) {
      this._sirenT += dt;
      const step = SIREN_PATTERN[(this._sirenT * 13) % SIREN_PATTERN.length | 0];
      on('sirenR', v.sirenOn && step === 1, LAMP.sirenR.on);
      on('sirenB', v.sirenOn && step === 2, LAMP.sirenB.on);
    }

    for (const h of this.lightHandles) {
      if (h && h.light) h.light.intensity = v.headlightsOn ? (v.highBeams ? 90 : 48) : 0;
      else if (h) h.intensity = v.headlightsOn ? 48 : 0;
    }
  }

  /**
   * Push the panel in around a local-space impact point.
   * Copy-on-write: undamaged cars keep sharing the cached geometry.
   */
  deform(localPoint, amount) {
    const mesh = this._paintMesh;
    if (!mesh) return;
    if (!this._deformed) {
      mesh.geometry = mesh.geometry.clone();
      this._deformed = true;
      this._owned.push(mesh.geometry);
      this._origPos = new Float32Array(mesh.geometry.attributes.position.array);
    }
    const pos = mesh.geometry.attributes.position;
    const arr = pos.array;
    const radius = 0.34 + amount * 0.55;
    const depth = 0.06 + amount * 0.20;
    const r2 = radius * radius;
    const px = localPoint.x, py = localPoint.y, pz = localPoint.z;
    // Direction of the dent: inward, toward the body's centreline at that height.
    const len = Math.hypot(px, pz) || 1;
    const dx = -px / len, dz = -pz / len;
    let touched = false;
    for (let i = 0; i < arr.length; i += 3) {
      const ddx = arr[i] - px, ddy = arr[i + 1] - py, ddz = arr[i + 2] - pz;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 > r2) continue;
      const f = 1 - Math.sqrt(d2) / radius;
      const k = f * f * depth;
      // A hash-based wrinkle keeps the dent from looking like a smooth thumbprint.
      const n = Math.sin(arr[i] * 41.3 + arr[i + 1] * 27.7 + arr[i + 2] * 33.1) * 0.30;
      arr[i] += dx * k * (1 + n);
      arr[i + 1] -= k * 0.28 * (1 + n);
      arr[i + 2] += dz * k * (1 + n);
      touched = true;
    }
    if (touched) {
      pos.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this.root.traverse(o => { if (o.isMesh) o.geometry = null; });
    this.lamps = {};
    this.wheels.length = 0;
  }
}

/** @returns {VehicleVisual} */
export function buildVehicleVisual(type, opts) {
  return new VehicleVisual(type, opts);
}

/** Shell geometry for the distant-traffic InstancedMesh pool. */
export function getShellGeometry(type) {
  const g = getVehicleGeometry(type);
  return { paint: g.lods[2].geos.get('paint'), trim: g.lods[2].geos.get('trim') };
}

/** Free every cached geometry and texture. Call from VehicleFactory.dispose(). */
export function disposeSharedGeometry() {
  for (const r of _geoCache.values()) {
    for (const l of r.lods) for (const g of l.geos.values()) g.dispose();
  }
  _geoCache.clear();
  for (const w of _wheelCache.values()) for (const g of w.geos.values()) g.dispose();
  _wheelCache.clear();
  for (const c of _caliperCache.values()) for (const g of c.values()) g.dispose();
  _caliperCache.clear();
  for (const gr of _emitCache.values()) for (const k in gr) gr[k]?.dispose();
  _emitCache.clear();
  for (const t of _texCache.values()) t.dispose();
  _texCache.clear();
}
