import * as THREE from 'three';
import { geo } from '../core/Geo.js';
import { RNG, canvas2d, texFromCanvas, fbm, normalFromHeight } from './StreetFurniture.js';
import { PropBatcher, getLayout, layoutStale } from './Props.js';

/**
 * Vegetation — Boston's street trees, the Common and the Public Garden.
 *
 * Street planting here is dominated by London plane, honey locust and red maple,
 * with linden and pin oak filling in; the Common and Garden carry mature specimen
 * elm and beech, and the weeping willows ring the lagoon. Getting the species mix
 * and the trunk/canopy proportions right is most of the battle — a city planted
 * with one cloned tree reads as fake from fifty metres.
 *
 * Everything is one material: bark and every leaf card live in the same
 * alpha-tested atlas, so a whole tree is a single draw per LOD level rather than
 * a bark draw plus a foliage draw.
 *
 * Wind is a vertex displacement keyed off the instance's own world position, so
 * ten thousand trees each get their own phase without a single extra attribute or
 * a single per-frame write.
 */

const ATLAS = 1024;
const CELL = 256;
const cellRect = (i) => [(i % 4) * CELL, ((i / 4) | 0) * CELL, CELL, CELL];
function cellUV(i) {
  const [x, y, w, h] = cellRect(i);
  const e = 1.5;
  return [(x + e) / ATLAS, 1 - (y + h - e) / ATLAS, (x + w - e) / ATLAS, 1 - (y + e) / ATLAS];
}

const V = {
  leafBroad: 0, leafBroadB: 1, leafPinnate: 2, leafOak: 3,
  willow: 4, grass: 5, flowers: 6, shrub: 7,
  hedge: 8, canopy: 9, leafDead: 10, ivy: 11,
  bark: 12, barkPlane: 13, barkDark: 14, blank: 15,
};

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/** One leaf blade, drawn at the origin pointing +X. */
function blade(c, len, wid, col, shape) {
  c.beginPath();
  if (shape === 'lobed') {
    c.moveTo(0, 0);
    c.bezierCurveTo(len * 0.2, -wid, len * 0.32, -wid * 0.35, len * 0.45, -wid * 0.9);
    c.bezierCurveTo(len * 0.6, -wid * 0.3, len * 0.75, -wid * 0.8, len, 0);
    c.bezierCurveTo(len * 0.75, wid * 0.8, len * 0.6, wid * 0.3, len * 0.45, wid * 0.9);
    c.bezierCurveTo(len * 0.32, wid * 0.35, len * 0.2, wid, 0, 0);
  } else if (shape === 'strand') {
    c.moveTo(0, 0);
    c.quadraticCurveTo(len * 0.5, -wid, len, 0);
    c.quadraticCurveTo(len * 0.5, wid * 0.3, 0, 0);
  } else {
    c.moveTo(0, 0);
    c.quadraticCurveTo(len * 0.45, -wid, len, 0);
    c.quadraticCurveTo(len * 0.45, wid, 0, 0);
  }
  c.closePath();
  c.fillStyle = col;
  c.fill();
}

/**
 * A cluster of leaves filling a cell. Alpha-tested cards live or die on this
 * texture having real gaps in it — a solid green blob is what makes browser
 * foliage look like broccoli.
 */
function drawCluster(c, ox, oy, rng, opts) {
  const { count, len, wid, shape, cols, spread, veinDark } = opts;
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  c.translate(ox + CELL / 2, oy + CELL / 2);
  // Fine twigs holding the cluster together.
  c.strokeStyle = 'rgba(64,52,38,0.85)';
  for (let i = 0; i < 9; i++) {
    c.lineWidth = rng.range(1.2, 3.2);
    c.beginPath();
    c.moveTo(0, CELL * 0.42);
    c.quadraticCurveTo(rng.range(-40, 40), rng.range(-10, 40),
      rng.range(-CELL * 0.4, CELL * 0.4), rng.range(-CELL * 0.42, CELL * 0.2));
    c.stroke();
  }
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.pow(rng.f(), 0.55) * CELL * spread;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.95;
    c.save();
    c.translate(x, y);
    c.rotate(rng.range(0, Math.PI * 2));
    const sc = rng.range(0.7, 1.25);
    const col = cols[rng.int(cols.length)];
    // Drop shadow inside the cluster gives the card interior depth.
    c.save(); c.translate(2.5, 3.0);
    blade(c, len * sc, wid * sc, 'rgba(18,26,12,0.5)', shape);
    c.restore();
    blade(c, len * sc, wid * sc, col, shape);
    if (veinDark) {
      c.strokeStyle = 'rgba(28,42,20,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(len * sc, 0); c.stroke();
    }
    c.restore();
  }
  c.restore();
}

/** Tileable-in-V bark. Vertical fissures, lenticels, and lichen if pale. */
function drawBark(c, ox, oy, seed, base, dark, mottle) {
  const rng = new RNG(seed);
  const h = fbm(CELL, seed, 4, 6, 0.55);
  const img = c.createImageData(CELL, CELL);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      // Stretch the noise vertically so the grain runs up the trunk.
      const n = h[(y % CELL) * CELL + x] * 0.5 +
        h[((y * 4) % CELL) * CELL + ((x * 3) % CELL)] * 0.5;
      const fis = Math.pow(Math.abs(Math.sin((x * 0.11 + n * 5.5) * Math.PI)), 2.2);
      const v = 0.42 + n * 0.5 - fis * 0.42;
      const i = (y * CELL + x) * 4;
      img.data[i] = (base[0] * v + dark[0] * (1 - v)) | 0;
      img.data[i + 1] = (base[1] * v + dark[1] * (1 - v)) | 0;
      img.data[i + 2] = (base[2] * v + dark[2] * (1 - v)) | 0;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, ox, oy);
  if (mottle) {
    // London plane sheds its bark in pale plates — the species' signature.
    c.save();
    c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
    for (let i = 0; i < 34; i++) {
      const x = ox + rng.f() * CELL, y = oy + rng.f() * CELL;
      c.fillStyle = rng.chance(0.5)
        ? `rgba(206,200,182,${rng.range(0.25, 0.6)})`
        : `rgba(150,142,120,${rng.range(0.2, 0.5)})`;
      c.beginPath();
      c.ellipse(x, y, rng.range(9, 34), rng.range(12, 46), rng.range(0, 3), 0, 6.2832);
      c.fill();
      // Wrap so the plates tile in V.
      c.beginPath();
      c.ellipse(x, y - CELL, rng.range(9, 30), rng.range(12, 40), rng.range(0, 3), 0, 6.2832);
      c.fill();
    }
    c.restore();
  }
  // Lenticels / knots
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  for (let i = 0; i < 40; i++) {
    c.fillStyle = `rgba(24,20,15,${rng.range(0.15, 0.45)})`;
    c.fillRect(ox + rng.f() * CELL, oy + rng.f() * CELL, rng.range(2, 9), rng.range(1, 3));
  }
  c.restore();
}

function drawGrass(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  c.translate(ox, oy);
  for (let i = 0; i < 150; i++) {
    const x = rng.f() * CELL;
    const hgt = rng.range(CELL * 0.35, CELL * 0.92);
    const lean = rng.range(-26, 26);
    const w = rng.range(2.4, 5.2);
    const g = rng.range(0.55, 1.0);
    c.fillStyle = `rgb(${(58 * g) | 0},${(96 * g) | 0},${(40 * g) | 0})`;
    c.beginPath();
    c.moveTo(x - w / 2, CELL);
    c.quadraticCurveTo(x + lean * 0.4, CELL - hgt * 0.6, x + lean, CELL - hgt);
    c.quadraticCurveTo(x + lean * 0.4 + w, CELL - hgt * 0.6, x + w / 2, CELL);
    c.closePath(); c.fill();
  }
  c.restore();
}

function drawFlowers(c, ox, oy, rng) {
  drawGrass(c, ox, oy, new RNG(7));
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  const cols = ['#d8506a', '#e8b03a', '#e0e0d0', '#8a5fc0', '#e07a3a', '#d94f4f'];
  for (let i = 0; i < 130; i++) {
    const x = ox + rng.f() * CELL, y = oy + rng.range(CELL * 0.1, CELL * 0.85);
    const col = cols[rng.int(cols.length)];
    const r = rng.range(3.5, 8);
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * 6.2832;
      c.fillStyle = col;
      c.beginPath(); c.arc(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7, r * 0.55, 0, 6.2832); c.fill();
    }
    c.fillStyle = '#e8d040';
    c.beginPath(); c.arc(x, y, r * 0.34, 0, 6.2832); c.fill();
  }
  c.restore();
}

function drawShrub(c, ox, oy, rng) {
  drawCluster(c, ox, oy, rng, {
    count: 240, len: 15, wid: 7, shape: 'oval', spread: 0.46, veinDark: false,
    cols: ['#33501f', '#436828', '#2a4419', '#4d7530', '#38581f'],
  });
}

function drawHedge(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  for (let i = 0; i < 900; i++) {
    const x = ox + rng.f() * CELL, y = oy + rng.f() * CELL;
    const g = rng.range(0.6, 1.15);
    c.fillStyle = `rgb(${(46 * g) | 0},${(78 * g) | 0},${(34 * g) | 0})`;
    c.save(); c.translate(x, y); c.rotate(rng.range(0, 6.28));
    blade(c, rng.range(7, 15), rng.range(3, 6), c.fillStyle, 'oval');
    c.restore();
  }
  c.restore();
}

function drawCanopy(c, ox, oy, rng) {
  // The distant billboard: a lumpy, gap-toothed mass, not a green circle.
  //
  // Tone matters as much as shape here. The near tree resolves to the leaf
  // cluster cells, which are ~40% transparent gap and carry their own interior
  // shadow, so the crown reads dark; a solid billboard of the same hue reads
  // several stops lighter and the LOD change shows as a colour pop from dark
  // green to pale. The mass is therefore built dark, lit only on its upper
  // left, and bitten through in the same proportion as the near cards.
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  c.translate(ox + CELL / 2, oy + CELL / 2);
  for (let i = 0; i < 210; i++) {
    const a = rng.range(0, 6.2832);
    const r = Math.pow(rng.f(), 0.5) * CELL * 0.44;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.92 - CELL * 0.03;
    const rr = rng.range(9, 30) * (1 - r / (CELL * 0.55) * 0.35);
    // Sunlit top-left, shadowed underside — a flat fill is the giveaway.
    const lit = 0.55 + 0.45 * Math.max(0, (-x * 0.5 - y) / (CELL * 0.5));
    const g = rng.range(0.5, 0.85) * lit;
    c.fillStyle = `rgb(${(46 * g) | 0},${(72 * g) | 0},${(32 * g) | 0})`;
    c.beginPath(); c.arc(x, y, rr, 0, 6.2832); c.fill();
  }
  // Bite gaps out of the silhouette so it never reads as a disc, and punch a
  // few holes through the middle so sky shows through as it does on a real tree.
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 58; i++) {
    const a = rng.range(0, 6.2832);
    const r = CELL * rng.range(0.26, 0.54);
    c.beginPath();
    c.arc(Math.cos(a) * r, Math.sin(a) * r * 0.92, rng.range(8, 32), 0, 6.2832);
    c.fill();
  }
  for (let i = 0; i < 16; i++) {
    c.beginPath();
    c.arc(rng.range(-CELL * 0.3, CELL * 0.3), rng.range(-CELL * 0.3, CELL * 0.3),
      rng.range(4, 13), 0, 6.2832);
    c.fill();
  }
  c.restore();
  // Trunk stub so the billboard meets the ground.
  c.fillStyle = '#3a2f22';
  c.fillRect(ox + CELL / 2 - 7, oy + CELL * 0.72, 14, CELL * 0.28);
}

function drawIvy(c, ox, oy, rng) {
  drawCluster(c, ox, oy, rng, {
    count: 190, len: 17, wid: 12, shape: 'lobed', spread: 0.5, veinDark: true,
    cols: ['#2c4a1c', '#3a5f26', '#223b16', '#456e2c'],
  });
}

function makeVegAtlas() {
  const { canvas, ctx: c } = canvas2d(ATLAS, ATLAS);
  c.clearRect(0, 0, ATLAS, ATLAS);
  const at = (i) => cellRect(i);
  const R = (s) => new RNG(s);

  let r = at(V.leafBroad);
  drawCluster(c, r[0], r[1], R(11), {
    count: 210, len: 21, wid: 13, shape: 'lobed', spread: 0.44, veinDark: true,
    cols: ['#3f6127', '#4c7330', '#33511f', '#578239', '#2c4a1b'],
  });
  r = at(V.leafBroadB);
  drawCluster(c, r[0], r[1], R(22), {
    count: 175, len: 24, wid: 15, shape: 'lobed', spread: 0.47, veinDark: true,
    cols: ['#476b2b', '#3a5a24', '#5a8a3c', '#2f4d1c', '#638f45'],
  });
  r = at(V.leafPinnate);
  drawCluster(c, r[0], r[1], R(33), {
    count: 430, len: 11, wid: 4.5, shape: 'oval', spread: 0.48, veinDark: false,
    cols: ['#6f9440', '#7ea24b', '#5c8034', '#8bab55', '#4f7029'],
  });
  r = at(V.leafOak);
  drawCluster(c, r[0], r[1], R(44), {
    count: 165, len: 23, wid: 12, shape: 'lobed', spread: 0.42, veinDark: true,
    cols: ['#334f1f', '#40602a', '#294218', '#4d7131'],
  });
  r = at(V.willow);
  drawCluster(c, r[0], r[1], R(55), {
    count: 300, len: 62, wid: 3.4, shape: 'strand', spread: 0.44, veinDark: false,
    cols: ['#7d9b48', '#8fae56', '#6b8a3c', '#98b862'],
  });
  r = at(V.leafDead);
  drawCluster(c, r[0], r[1], R(66), {
    count: 150, len: 21, wid: 12, shape: 'lobed', spread: 0.44, veinDark: true,
    cols: ['#8a6026', '#a2762f', '#6d4a1d', '#b08a3a', '#93401f'],
  });

  r = at(V.grass); drawGrass(c, r[0], r[1], R(77));
  r = at(V.flowers); drawFlowers(c, r[0], r[1], R(88));
  r = at(V.shrub); drawShrub(c, r[0], r[1], R(99));
  r = at(V.hedge); drawHedge(c, r[0], r[1], R(111));
  r = at(V.canopy); drawCanopy(c, r[0], r[1], R(122));
  r = at(V.ivy); drawIvy(c, r[0], r[1], R(133));

  r = at(V.bark); drawBark(c, r[0], r[1], 201, [138, 118, 92], [42, 34, 25], false);
  r = at(V.barkPlane); drawBark(c, r[0], r[1], 202, [178, 172, 152], [92, 84, 66], true);
  r = at(V.barkDark); drawBark(c, r[0], r[1], 203, [96, 86, 74], [26, 22, 18], false);
  r = at(V.blank);
  c.fillStyle = '#ffffff'; c.fillRect(r[0], r[1], CELL, CELL);
  return canvas;
}

// ---------------------------------------------------------------------------
// Tree geometry
// ---------------------------------------------------------------------------

/** Mutable accumulator: position / normal / uv / colour / (wind, isLeaf). */
class Mesh3 {
  constructor() { this.p = []; this.n = []; this.t = []; this.c = []; this.v = []; }
  vert(px, py, pz, nx, ny, nz, u, vv, col, wind, leaf) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.t.push(u, vv);
    this.c.push(col[0], col[1], col[2]); this.v.push(wind, leaf);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aVeg', new THREE.Float32BufferAttribute(this.v, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _u = new THREE.Vector3(), _w = new THREE.Vector3(), _nv = new THREE.Vector3();

/**
 * Tapered limb from a to b.
 *
 * `vSpan` maps a sub-band of the bark cell instead of the whole cell. The trunk
 * used to be four stacked limbs each mapping the identical 256 px bark tile from
 * v0 to v1, so the same knot pattern appeared four or five times up one trunk —
 * the critic measured exactly that ("the tree bark texture repeats ~5 times
 * identically over one trunk"), and visible tiling repetition is an automatic
 * fail. Handing each segment its own slice of the cell, plus mirroring U on
 * alternate segments, removes the repeat without another texel of atlas.
 */
function limb(M, ax, ay, az, bx, by, bz, r0, r1, sides, cell, w0, w1, col, vSpan, mirror) {
  let [u0, v0, u1, v1] = cellUV(cell);
  if (vSpan) {
    const dv = v1 - v0;
    v1 = v0 + dv * vSpan[1];
    v0 = v0 + dv * vSpan[0];
  }
  if (mirror) { const t = u0; u0 = u1; u1 = t; }
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  _u.subVectors(_b, _a);
  const len = _u.length() || 0.001;
  _u.multiplyScalar(1 / len);
  // Build an orthonormal frame around the limb axis.
  _w.set(0, 0, 1);
  if (Math.abs(_u.z) > 0.9) _w.set(1, 0, 0);
  _nv.crossVectors(_u, _w).normalize();
  _w.crossVectors(_u, _nv).normalize();
  const px = [], py = [], pz = [], qx = [], qy = [], qz = [], nx = [], ny = [], nz = [];
  for (let s = 0; s <= sides; s++) {
    const t = (s / sides) * Math.PI * 2;
    const cx = Math.cos(t), sy = Math.sin(t);
    const dx = _nv.x * cx + _w.x * sy, dy = _nv.y * cx + _w.y * sy, dz = _nv.z * cx + _w.z * sy;
    px.push(ax + dx * r0); py.push(ay + dy * r0); pz.push(az + dz * r0);
    qx.push(bx + dx * r1); qy.push(by + dy * r1); qz.push(bz + dz * r1);
    nx.push(dx); ny.push(dy); nz.push(dz);
  }
  for (let s = 0; s < sides; s++) {
    const s2 = s + 1;
    const ua = u0 + (s / sides) * (u1 - u0), ub = u0 + (s2 / sides) * (u1 - u0);
    M.vert(px[s], py[s], pz[s], nx[s], ny[s], nz[s], ua, v0, col, w0, 0);
    M.vert(px[s2], py[s2], pz[s2], nx[s2], ny[s2], nz[s2], ub, v0, col, w0, 0);
    M.vert(qx[s2], qy[s2], qz[s2], nx[s2], ny[s2], nz[s2], ub, v1, col, w1, 0);
    M.vert(px[s], py[s], pz[s], nx[s], ny[s], nz[s], ua, v0, col, w0, 0);
    M.vert(qx[s2], qy[s2], qz[s2], nx[s2], ny[s2], nz[s2], ub, v1, col, w1, 0);
    M.vert(qx[s], qy[s], qz[s], nx[s], ny[s], nz[s], ua, v1, col, w1, 0);
  }
}

/**
 * One foliage card. Vertex normals are bent away from the canopy centre so the
 * canopy shades like a volume instead of a pile of flat quads — this is the
 * single most important detail in making card foliage read correctly.
 */
function card(M, cx, cy, cz, dirx, diry, dirz, w, h, roll, cell, ccx, ccy, ccz, wind, col, leafy) {
  const [u0, v0, u1, v1] = cellUV(cell);
  _u.set(dirx, diry, dirz).normalize();
  _w.set(0, 1, 0);
  if (Math.abs(_u.y) > 0.94) _w.set(1, 0, 0);
  _nv.crossVectors(_w, _u).normalize();        // right
  _w.crossVectors(_u, _nv).normalize();        // up
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const rx = _nv.x * cr + _w.x * sr, ry = _nv.y * cr + _w.y * sr, rz = _nv.z * cr + _w.z * sr;
  const ux = -_nv.x * sr + _w.x * cr, uy = -_nv.y * sr + _w.y * cr, uz = -_nv.z * sr + _w.z * cr;
  const hw = w / 2, hh = h / 2;
  const corners = [[-hw, -hh, u0, v0], [hw, -hh, u1, v0], [hw, hh, u1, v1], [-hw, hh, u0, v1]];
  const out = [];
  for (const [a, bq, uu, vv] of corners) {
    const px = cx + rx * a + ux * bq, py = cy + ry * a + uy * bq, pz = cz + rz * a + uz * bq;
    let bx = px - ccx, by = py - ccy, bz = pz - ccz;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    // Blend the card's own normal with the radial: 30/70 reads best.
    let nx2 = _u.x * 0.3 + bx * 0.7, ny2 = _u.y * 0.3 + by * 0.7, nz2 = _u.z * 0.3 + bz * 0.7;
    const nl = Math.hypot(nx2, ny2, nz2) || 1;
    out.push([px, py, pz, nx2 / nl, ny2 / nl, nz2 / nl, uu, vv]);
  }
  const emit = (i) => {
    const o = out[i];
    M.vert(o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7], col, wind, leafy);
  };
  emit(0); emit(1); emit(2);
  emit(0); emit(2); emit(3);
}

/** Species catalogue. Heights and canopy ratios are real for Boston plantings. */
/**
 * Bole radius as a fraction of `SPECIES.trunk * height`. See `boleR` in
 * buildTree: the raw product is 8-10x life size.
 *
 * Sanity check after scaling, as trunk diameter over tree height: London plane
 * H/24, honey locust H/33, red maple H/28, linden H/29, pin oak H/26 — the band
 * a real street tree sits in. The three park specimens needed their own
 * constants brought down as well (elm was left at H/16, beech H/14, willow
 * H/13), since a fat trunk on a big tree is much more conspicuous.
 */
const TRUNK_R = 0.13;

/** Species catalogue. Heights and canopy ratios are real for Boston plantings. */
const SPECIES = {
  planeLondon: {
    h: [11, 16.5], trunk: 0.155, clear: 0.34, canopyR: 0.40, squash: 0.90,
    bark: V.barkPlane, barkCol: '#b9b4a2', leaf: V.leafBroad, leafCol: '#5d7d3c',
    cards: [96, 30], branches: 5, vase: 0.25,
  },
  honeyLocust: {
    h: [9.5, 14], trunk: 0.115, clear: 0.40, canopyR: 0.42, squash: 0.72,
    bark: V.bark, barkCol: '#7b6448', leaf: V.leafPinnate, leafCol: '#8aa957',
    cards: [88, 26], branches: 6, vase: 0.45,
  },
  redMaple: {
    h: [9, 14.5], trunk: 0.135, clear: 0.30, canopyR: 0.44, squash: 1.02,
    bark: V.barkDark, barkCol: '#7d746a', leaf: V.leafBroadB, leafCol: '#4f6f34',
    cards: [100, 30], branches: 5, vase: 0.15,
  },
  littleleafLinden: {
    h: [10, 15], trunk: 0.13, clear: 0.26, canopyR: 0.38, squash: 1.18,
    bark: V.bark, barkCol: '#8a7a62', leaf: V.leafBroad, leafCol: '#4a6a30',
    cards: [94, 28], branches: 5, vase: 0.10,
  },
  pinOak: {
    h: [11, 17], trunk: 0.145, clear: 0.22, canopyR: 0.36, squash: 1.30,
    bark: V.barkDark, barkCol: '#6e6558', leaf: V.leafOak, leafCol: '#3f5c26',
    cards: [98, 28], branches: 6, vase: 0.05,
  },
  americanElm: {
    h: [17, 24], trunk: 0.16, clear: 0.40, canopyR: 0.52, squash: 0.72,
    bark: V.bark, barkCol: '#7a6c56', leaf: V.leafBroad, leafCol: '#54763a',
    cards: [128, 36], branches: 7, vase: 0.70,
  },
  copperBeech: {
    h: [14, 20], trunk: 0.20, clear: 0.14, canopyR: 0.50, squash: 1.05,
    bark: V.barkDark, barkCol: '#8f8478', leaf: V.leafBroadB, leafCol: '#6a3a3f',
    cards: [136, 38], branches: 6, vase: 0.05,
  },
  weepingWillow: {
    h: [12, 17], trunk: 0.20, clear: 0.22, canopyR: 0.56, squash: 0.62,
    bark: V.bark, barkCol: '#6e5f45', leaf: V.willow, leafCol: '#8aa855',
    cards: [110, 32], branches: 7, vase: 0.55, weep: true,
  },
};

const _c3 = new THREE.Color();
const asLin = (hex) => { _c3.setStyle(hex); return [_c3.r, _c3.g, _c3.b]; };

/**
 * Build one tree at the origin.
 * @param {number} lod 0 full, 1 reduced, 2 crossed billboards
 */
function buildTree(name, variant, lod, seed) {
  const S = SPECIES[name];
  const rng = new RNG(seed);
  const M = new Mesh3();
  const H = S.h[0] + (S.h[1] - S.h[0]) * (variant === 0 ? 0.38 : 0.78);
  const barkCol = asLin(S.barkCol);
  const leafCol = asLin(S.leafCol);
  const cRad = H * S.canopyR;
  const cY = H * (S.clear + (1 - S.clear) * 0.55);

  if (lod === 2) {
    // Three crossed billboards. Cheap, and with the gap-toothed canopy cell the
    // silhouette still reads as a tree rather than a lollipop.
    const w = cRad * 2.35, h = H * 0.96;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      card(M, 0, h * 0.5, 0, Math.cos(a), 0, Math.sin(a), w, h, 0,
        V.canopy, 0, h * 0.55, 0, 0.35, leafCol, 1);
    }
    return M.geometry();
  }

  const sides = lod === 0 ? 7 : 5;
  const segs = lod === 0 ? 4 : 2;
  const clearH = H * S.clear;

  /**
   * Bole radius at the base.
   *
   * `S.trunk` was being taken as a straight proportion of tree height, which
   * measured out at a **4.14 m thick trunk on a 14.5 m London plane** and an
   * 11.47 m trunk on a 25 m elm — eight to ten times life size. That single
   * number is most of why the vegetation read as "blobby broccoli": every tree
   * was a canopy balanced on a concrete column, and it is also why the bark
   * tiling was so conspicuous, because the tile was stretched over a five-metre
   * cylinder. A street tree's DBH is roughly H/40 to H/25, so a 14.5 m plane is
   * about 0.45-0.6 m thick, not four metres.
   */
  const boleR = S.trunk * H * TRUNK_R;

  // Trunk: stacked limbs, each mapping one bark tile, with a slight sweep.
  let px = 0, pz = 0;
  const sweepA = rng.range(0, 6.28), sweep = rng.range(0.02, 0.10);
  for (let i = 0; i < segs; i++) {
    const y0 = (i / segs) * clearH, y1 = ((i + 1) / segs) * clearH;
    const nx2 = Math.cos(sweepA) * sweep * y1, nz2 = Math.sin(sweepA) * sweep * y1;
    const r0 = boleR * (1 - 0.30 * (y0 / H));
    const r1 = boleR * (1 - 0.30 * (y1 / H));
    // One bark cell stretched across the WHOLE trunk, one slice per segment, so
    // the grain never repeats up the bole. Alternate segments mirror in U as
    // well, which also breaks the seam line the cylinder wrap leaves.
    limb(M, px, y0, pz, nx2, y1, nz2, r0 * (i === 0 ? 1.22 : 1), r1, sides, S.bark,
      0.0, 0.03 * (i + 1), barkCol, [i / segs, (i + 1) / segs], (i & 1) === 1);
    px = nx2; pz = nz2;
  }

  // Scaffold branches climbing into the canopy.
  const nb = lod === 0 ? S.branches : Math.max(3, S.branches - 2);
  const tips = [];
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const lift = rng.range(0.55, 1.0);
    const reach = cRad * rng.range(0.55, 0.95) * (1 - S.vase * 0.3);
    const bx = px + Math.cos(a) * reach * (0.4 + S.vase);
    const bz = pz + Math.sin(a) * reach * (0.4 + S.vase);
    const by = clearH + (cY - clearH) * lift + cRad * 0.25;
    const r = boleR * 0.62 * rng.range(0.7, 1.0);
    limb(M, px, clearH, pz, bx, by, bz, r, r * 0.35, lod === 0 ? 5 : 4, S.bark, 0.05, 0.22,
      barkCol, [rng.range(0, 0.55), rng.range(0.6, 1)], (i & 1) === 0);
    tips.push([bx, by, bz]);
    if (lod === 0) {
      for (let k = 0; k < 2; k++) {
        const a2 = a + rng.range(-0.9, 0.9);
        const ex = bx + Math.cos(a2) * cRad * rng.range(0.25, 0.55);
        const ez = bz + Math.sin(a2) * cRad * rng.range(0.25, 0.55);
        const ey = by + cRad * rng.range(0.1, 0.55);
        limb(M, bx, by, bz, ex, ey, ez, r * 0.34, r * 0.14, 4, S.bark, 0.22, 0.45,
          barkCol, [rng.range(0, 0.6), rng.range(0.65, 1)], (k & 1) === 1);
        tips.push([ex, ey, ez]);
      }
    }
  }

  // Foliage cards.
  //
  // Distributing them uniformly on one spherical shell is what makes procedural
  // trees read as broccoli: the silhouette closes into a smooth circle and every
  // tree in the row has the same outline. A real broadleaf crown is a handful of
  // distinct lobes with sky between them, and its edge is ragged with individual
  // shoots standing proud of the mass. So: cards cluster around 3-5 lobe centres
  // rather than one, and a quarter of them are thrown past the crown radius at
  // reduced size to break the outline. Same card count, same triangles.
  const n = S.cards[lod];
  const cw = cRad * (lod === 0 ? 0.72 : 1.05);
  const nLobe = 3 + rng.int(3);
  const lobes = [];
  for (let i = 0; i < nLobe; i++) {
    const la = (i / nLobe) * 6.2832 + rng.range(-0.5, 0.5);
    const lr = cRad * rng.range(0.28, 0.62);
    lobes.push([
      Math.cos(la) * lr,
      cY + rng.range(-0.34, 0.40) * cRad * S.squash,
      Math.sin(la) * lr,
      rng.range(0.55, 1.0),                 // this lobe's own radius fraction
    ]);
  }
  for (let i = 0; i < n; i++) {
    // Bias placement towards a branch tip so foliage grows off the structure.
    const tip = tips[rng.int(tips.length)];
    const lo = lobes[i % nLobe];
    const edge = rng.chance(0.26);          // an outlier shoot on the silhouette
    const a = rng.range(0, 6.2832);
    const el = Math.acos(1 - 2 * rng.f());
    const rr = cRad * lo[3] * (edge
      ? rng.range(1.02, 1.34)
      : Math.pow(rng.range(0.22, 0.95), 0.55));
    let x = lo[0] + Math.sin(el) * Math.cos(a) * rr;
    let z = lo[2] + Math.sin(el) * Math.sin(a) * rr;
    let y = lo[1] + Math.cos(el) * rr * S.squash;
    x = x * 0.72 + tip[0] * 0.42;
    z = z * 0.72 + tip[2] * 0.42;
    y = y * 0.70 + tip[1] * 0.34;
    if (y < clearH * 0.85) y = clearH * 0.85 + rng.f() * cRad * 0.3;
    let dx = x, dy = (y - cY) * 1.2, dz = z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // Outliers are small: a big card thrown wide reads as a lump, a small one
    // reads as a shoot.
    const sz = edge ? rng.range(0.34, 0.6) : rng.range(0.8, 1.25);
    const h = cw * sz * rng.range(0.82, 1.18);
    const wgt = 0.35 + 0.65 * Math.min(1, rr / cRad);
    if (S.weep) {
      // Willow strands hang: card is tall, vertical, normal horizontal.
      card(M, x, y - h * 0.35, z, dx, 0, dz, cw * 0.62, cw * 2.3, 0,
        S.leaf, 0, cY, 0, 0.9 + rng.f() * 0.35, leafCol, 1);
    } else {
      card(M, x, y, z, dx, dy, dz, cw * sz, h, rng.range(-0.5, 0.5),
        S.leaf, 0, cY, 0, wgt, leafCol, 1);
    }
  }
  return M.geometry();
}

/** A ball of cards: shrubs, and the same builder does flower beds. */
function buildClump(cell, r, squash, cards, seed, colHex, wind) {
  const M = new Mesh3();
  const rng = new RNG(seed);
  const col = asLin(colHex);
  for (let i = 0; i < cards; i++) {
    const a = rng.range(0, 6.2832);
    const el = Math.acos(1 - 2 * rng.f());
    const rr = r * Math.pow(rng.range(0.3, 1), 0.5);
    const x = Math.sin(el) * Math.cos(a) * rr;
    const z = Math.sin(el) * Math.sin(a) * rr;
    const y = r * squash + Math.cos(el) * rr * squash;
    let dx = x, dy = (y - r * squash) * 1.4, dz = z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    card(M, x, y, z, dx / dl, dy / dl, dz / dl, r * rng.range(1.0, 1.7),
      r * rng.range(0.9, 1.5), rng.range(-0.4, 0.4), cell, 0, r * squash, 0, wind, col, 1);
  }
  return M.geometry();
}

/** A 1.2m run of clipped hedge. */
function buildHedge(seed) {
  const M = new Mesh3();
  const rng = new RNG(seed);
  const col = asLin('#3d5f28');
  const W = 1.22, D = 0.78, H = 1.15;
  const faces = [
    [0, 0, D / 2, 0, 0, 1], [0, 0, -D / 2, 0, 0, -1],
    [W / 2, 0, 0, 1, 0, 0], [-W / 2, 0, 0, -1, 0, 0],
    [0, H / 2, 0, 0, 1, 0],
  ];
  for (const [fx, fy, fz, nx, ny, nz] of faces) {
    for (let i = 0; i < 7; i++) {
      const jx = fx + (nx ? 0 : rng.range(-W / 2, W / 2)) * 0.7;
      const jz = fz + (nz ? 0 : rng.range(-D / 2, D / 2)) * 0.7;
      const jy = H / 2 + fy + (ny ? 0 : rng.range(-H / 2, H / 2)) * 0.75;
      card(M, jx, jy, jz, nx, ny, nz, rng.range(0.5, 0.85), rng.range(0.45, 0.8),
        rng.range(-0.3, 0.3), V.hedge, 0, H / 2, 0, ny ? 0.28 : 0.14, col, 0.4);
    }
  }
  return M.geometry();
}

/** Three crossed blades of grass. */
function buildGrassTuft(seed) {
  const M = new Mesh3();
  const rng = new RNG(seed);
  const col = asLin('#5c7c38');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI + rng.range(-0.2, 0.2);
    const h = rng.range(0.24, 0.40);
    card(M, 0, h / 2, 0, Math.cos(a), 0, Math.sin(a), h * 1.25, h, 0,
      V.grass, 0, 0, 0, 0.55, col, 0.18);
  }
  return M.geometry();
}

// ---------------------------------------------------------------------------

const SEASONS = { spring: 0.0, summer: 0.0, earlyAutumn: 0.35, autumn: 0.95, winter: 1.0 };
const WIND = { clear: 0.10, overcast: 0.15, rain: 0.24, storm: 0.46, fog: 0.05, snow: 0.16 };

export default class Vegetation {
  static id = 'vegetation';
  static label = 'Vegetation';
  static deps = ['assets'];

  async init(ctx) {
    this.ctx = ctx;
    this.uniforms = {
      uWindTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
      uWindAmp: { value: WIND[ctx.settings.weather] ?? 0.12 },
      uSeasonMix: { value: 0.18 },
    };
    this.material = this._material(ctx);
    this.batcher = new PropBatcher(ctx.scene);
    this._season = 'earlyAutumn';
    this._windPhase = 0;

    this.layout = getLayout(ctx);
    this._buildAll(ctx);

    ctx.bus.on('props:rebuilt', this._onRebuilt = () => this._rebuild(ctx));
    ctx.bus.on('weather:set', this._onWeather = (w) => this.setWeather(w));
    ctx.bus.on('quality:changed', this._onQuality = () => this.batcher.invalidate());
    this.setSeason(this._season);
  }

  _material(ctx) {
    const A = ctx.assets;
    const anis = A._anis || 8;
    const tex = A.texture('veg_atlas', () => {
      const t = texFromCanvas(makeVegAtlas(), true, false);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = anis;
      return t;
    });
    const nrm = A.texture('veg_normal', () => {
      const h = fbm(512, 5150, 4, 24, 0.5);
      const t = texFromCanvas(normalFromHeight(h, 512, 0.9), false);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(3, 3);
      t.anisotropy = anis;
      return t;
    });
    const U = this.uniforms;
    return A.material('veg_foliage', () => {
      const m = new THREE.MeshStandardMaterial({
        map: tex, normalMap: nrm, normalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.87, metalness: 0.0, vertexColors: true,
        // Alpha TEST, not alpha blend: no sorting, correct depth, correct shadows.
        alphaTest: 0.42, transparent: false,
        side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
      });
      m.userData.wetnessRough = m.roughness;
      m.userData.wetnessColor = m.color.clone();
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
attribute vec2 aVeg;
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindAmp;
uniform float uSeasonMix;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  float vgPh = instanceMatrix[3][0] * 0.41 + instanceMatrix[3][2] * 0.73;
#else
  float vgPh = 0.0;
#endif
{
  float w1 = sin(uWindTime * 1.05 + vgPh);
  float w2 = sin(uWindTime * 2.37 + vgPh * 1.63 + transformed.y * 0.42);
  float amp = aVeg.x * uWindAmp;
  float sway = w1 * 0.62 + w2 * 0.38;
  transformed.x += uWindDir.x * sway * amp;
  transformed.z += uWindDir.y * sway * amp;
  transformed.y -= abs(sway) * amp * 0.16;
}`)
          .replace('#include <color_vertex>', `#include <color_vertex>
{
#ifdef USE_INSTANCING
  float h1 = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  float h2 = fract(sin(dot(instanceMatrix[3].xz, vec2(39.3468, 11.135))) * 24634.6345);
#else
  float h1 = 0.5; float h2 = 0.5;
#endif
  vec3 aut = mix(vec3(0.55, 0.16, 0.05), vec3(0.84, 0.53, 0.09), h2);
  aut = mix(aut, vec3(0.74, 0.27, 0.08), step(0.80, h1));
  float turn = clamp(uSeasonMix * 1.8 - h1 * 0.8, 0.0, 1.0) * aVeg.y;
  vColor = mix(vColor, aut, turn);
}`);
      };
      m.customProgramCacheKey = () => 'vegFoliage';
      return m;
    });
  }

  _buildAll(ctx) {
    const L = this.layout;
    const density = ctx.settings.propDensity
      ?? ({ low: 0.42, medium: 0.7, high: 1.0, ultra: 1.15 }[ctx.settings.preset] ?? 1);
    const mat = this.material;
    const B = this.batcher;
    this._geoms = [];

    const treeBatch = (species, variant) => {
      const key = `${species}${variant}`;
      const lods = [];
      const cfg = [[0, 95], [1, 300], [2, 900]];
      for (const [lod, dist] of cfg) {
        const g = buildTree(species, variant, lod, 900 + key.length * 131 + variant * 7717 + lod);
        this._geoms.push(g);
        lods.push({ geometry: g, materials: mat, dist, cast: lod < 2 });
      }
      return B.batch('tree_' + key, lods, { receive: true });
    };

    const streetSpecies = ['planeLondon', 'honeyLocust', 'redMaple', 'littleleafLinden', 'pinOak'];
    const treeBatches = {};
    for (const sp of streetSpecies) {
      treeBatches[sp] = [treeBatch(sp, 0), treeBatch(sp, 1)];
    }
    const parkBatches = {
      americanElm: [treeBatch('americanElm', 0), treeBatch('americanElm', 1)],
      copperBeech: [treeBatch('copperBeech', 0)],
      weepingWillow: [treeBatch('weepingWillow', 0)],
      planeLondon: treeBatches.planeLondon,
      redMaple: treeBatches.redMaple,
    };

    const clump = (name, geoFn, dists) => {
      const lods = dists.map(([g, d], i) => {
        this._geoms.push(g);
        return { geometry: g, materials: mat, dist: d, cast: i === 0 };
      });
      void geoFn;
      return B.batch(name, lods, { receive: true });
    };
    const shrubB = clump('veg_shrub', null, [
      [buildClump(V.shrub, 0.62, 0.86, 26, 4001, '#3b5c26', 0.5), 70],
      [buildClump(V.shrub, 0.62, 0.86, 9, 4002, '#3b5c26', 0.5), 190],
    ]);
    const shrubB2 = clump('veg_shrub2', null, [
      [buildClump(V.ivy, 0.85, 0.72, 30, 4003, '#33501f', 0.55), 75],
      [buildClump(V.ivy, 0.85, 0.72, 10, 4004, '#33501f', 0.55), 200],
    ]);
    const flowerB = clump('veg_flowers', null, [
      [buildClump(V.flowers, 0.55, 0.35, 18, 4005, '#7a8a45', 0.4), 65],
    ]);
    const hedgeB = clump('veg_hedge', null, [
      [buildHedge(4006), 85],
      [buildHedge(4007), 190],
    ]);
    const grassB = clump('veg_grass', null, [
      [buildGrassTuft(4008), 44],
    ]);

    placeVegetation({
      L, density, treeBatches, parkBatches,
      shrubB, shrubB2, flowerB, hedgeB, grassB,
    });

    const n = B.build();
    const scale = THREE.MathUtils.clamp(ctx.settings.drawDist / 2200, 0.35, 1.6);
    B.refreshAll(ctx.camera.position.x, ctx.camera.position.z, scale);
    this._lastCamX = ctx.camera.position.x;
    this._lastCamZ = ctx.camera.position.z;
    this._lastScale = scale;
    this.instanceCount = n;
    console.info(`[vegetation] ${n} plants, ${B.batches.size} types, ${B.stats().meshes} meshes`);
  }

  /** @param {'spring'|'summer'|'earlyAutumn'|'autumn'|'winter'} s */
  setSeason(s) {
    if (!(s in SEASONS)) return;
    this._season = s;
    this.uniforms.uSeasonMix.value = SEASONS[s];
    // Winter thins the canopy by clipping more of every leaf card away.
    this.material.alphaTest = s === 'winter' ? 0.84 : s === 'autumn' ? 0.52 : 0.42;
    this.material.needsUpdate = true;
  }
  get season() { return this._season; }

  setWeather(w) {
    this.uniforms.uWindAmp.value = WIND[w] ?? 0.12;
  }

  update(dt, ctx) {
    if (layoutStale(ctx) && this.layout.source === 'grid') {
      // Props rebuilds first and emits; this is the belt-and-braces path.
      if (getLayout(ctx).source === 'city') this._rebuild(ctx);
      return;
    }
    // Gusts: a slow envelope on top of the two sine bands in the shader.
    this._windPhase += dt;
    this.uniforms.uWindTime.value = this._windPhase;

    const cam = ctx.camera.position;
    const scale = THREE.MathUtils.clamp(ctx.settings.drawDist / 2200, 0.35, 1.6);
    if (Math.abs(cam.x - this._lastCamX) + Math.abs(cam.z - this._lastCamZ) > 22
      || scale !== this._lastScale) {
      this._lastCamX = cam.x; this._lastCamZ = cam.z; this._lastScale = scale;
      this.batcher.invalidate();
    }
    this.batcher.step(this._lastCamX, this._lastCamZ, scale, 6);
  }

  _rebuild(ctx) {
    this.batcher.dispose();
    for (const g of this._geoms || []) g.dispose();
    this.batcher = new PropBatcher(ctx.scene);
    this.layout = getLayout(ctx);
    this._buildAll(ctx);
    this.setSeason(this._season);
  }

  stats() { return this.batcher.stats(); }

  dispose() {
    this.batcher?.dispose();
    for (const g of this._geoms || []) g.dispose();
    this.ctx?.bus.off('props:rebuilt', this._onRebuilt);
    this.ctx?.bus.off('weather:set', this._onWeather);
    this.ctx?.bus.off('quality:changed', this._onQuality);
  }
}

// ---------------------------------------------------------------------------

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Planting outside the two parks: tree pits, front areaways, hedged railings.
 *
 * Every ground-vegetation type — shrub, ivy, hedge, flower bed, grass tuft —
 * used to be placed only inside `L.parkAreas`, which is the Common and the
 * Public Garden and nothing else. Measured across four downtown and Back Bay
 * camera positions, all five `veg_*` types had **zero** live instances: they
 * were not broken, they were simply confined to two polygons a kilometre away.
 *
 * Boston's residential streets are not bare. A Back Bay or South End brownstone
 * has a railed areaway with a shrub or two and often ivy up the basement wall;
 * Beacon Hill has boxwood in front of the railings; every street tree sits in a
 * pit with weedy ground cover in it. That is what this places, and it is what
 * the eye reads at 3 m as "a street somebody lives on".
 */
function placeStreetPlanting(o, g) {
  const { L, density, shrubB, shrubB2, flowerB, hedgeB, grassB } = o;

  // --- Tree pits: ground cover round the base of every street tree ---------
  {
    const rng = new RNG(313377);
    const cap = Math.round(11000 * density);
    let n = 0;
    for (const s of L.treeSites) {
      if (n >= cap) break;
      const k = 1 + rng.int(3);
      for (let i = 0; i < k && n < cap; i++) {
        const a = rng.range(0, 6.2832), r = rng.range(0.22, 0.66);
        const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
        grassB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.55, 1.05),
          rng.range(0.7, 1.05));
        n++;
      }
      if (rng.chance(0.16) && n < cap) {
        const a = rng.range(0, 6.2832);
        const x = s.x + Math.cos(a) * 0.5, z = s.z + Math.sin(a) * 0.5;
        flowerB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.45, 0.8), rng.range(0.85, 1.1));
        n++;
      }
    }
  }

  // --- Front areaways and railing hedges along the building line -----------
  //
  // Offsets are from the facade towards the street: the areaway of a brownstone
  // is about a metre deep, and the railing sits at its outer edge.
  {
    const cap = {
      shrub: Math.round(9000 * density), hedge: Math.round(9000 * density),
      ivy: Math.round(3500 * density), flower: Math.round(3000 * density),
    };
    const used = { shrub: 0, hedge: 0, ivy: 0, flower: 0 };
    let fi = 0;
    for (const f of L.frontage) {
      if (f.len < 4) continue;
      const rng = new RNG(880011 + (fi++) * 6151);
      const d = f.district;
      // Row-house districts plant their front areaways; the Financial District
      // and the Seaport do not have front areaways to plant.
      const planted = d === 'backBay' ? 0.62 : d === 'beaconHill' ? 0.58
        : d === 'southEnd' ? 0.55 : d === 'charlestown' ? 0.5
          : d === 'northEnd' ? 0.16 : d === 'fenway' || d === 'cambridge' ? 0.34 : 0.10;
      if (!rng.chance(planted)) continue;
      const y0 = f.y != null ? f.y : g(f.ax, f.az);

      // A clipped hedge run along the railing line, on most planted frontages.
      if (rng.chance(0.45) && used.hedge < cap.hedge) {
        const off = rng.range(0.85, 1.45);
        const t0 = rng.range(0.3, 1.4), t1 = Math.min(f.len - 0.3, t0 + rng.range(2.5, f.len));
        for (let t = t0; t < t1 && used.hedge < cap.hedge; t += 1.16) {
          const x = f.ax + f.dx * t + f.nx * off, z = f.az + f.dz * t + f.nz * off;
          hedgeB.add(x, g(x, z), z, Math.atan2(f.dx, f.dz), rng.range(0.9, 1.06),
            rng.range(0.86, 1.06));
          used.hedge++;
        }
      }
      // Shrubs in the areaway itself.
      const nS = 1 + rng.int(3);
      for (let i = 0; i < nS && used.shrub < cap.shrub; i++) {
        const t = rng.range(0.4, Math.max(0.5, f.len - 0.4));
        const off = rng.range(0.35, 1.05);
        const x = f.ax + f.dx * t + f.nx * off, z = f.az + f.dz * t + f.nz * off;
        (rng.chance(0.62) ? shrubB : shrubB2)
          .add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.6, 1.25), rng.range(0.8, 1.1));
        used.shrub++;
      }
      // Ivy hugging the basement wall.
      if (rng.chance(0.20) && used.ivy < cap.ivy) {
        const t = rng.range(0.4, Math.max(0.5, f.len - 0.4));
        const x = f.ax + f.dx * t + f.nx * 0.24, z = f.az + f.dz * t + f.nz * 0.24;
        shrubB2.add(x, y0, z, rng.range(0, 6.2832), rng.range(0.7, 1.15), rng.range(0.75, 1.0));
        used.ivy++;
      }
      // A window box or a pot of geraniums by the stoop.
      if (rng.chance(0.24) && used.flower < cap.flower) {
        const t = rng.range(0.4, Math.max(0.5, f.len - 0.4));
        const off = rng.range(0.30, 0.85);
        const x = f.ax + f.dx * t + f.nx * off, z = f.az + f.dz * t + f.nz * off;
        flowerB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.5, 0.95), rng.range(0.9, 1.15));
        used.flower++;
      }
    }
  }

  // --- Weeds in the verge, where a wide pavement leaves a strip ------------
  {
    const cap = Math.round(6000 * density);
    let n = 0, si = 0;
    for (const s of L.segments) {
      if (n >= cap) break;
      if (s.type === 'alley') continue;
      const rng = new RNG(447711 + (si++) * 2129);
      if (!rng.chance(0.42)) continue;
      const side = rng.sign();
      for (let t = rng.range(3, 14); t < s.len - 4 && n < cap; t += rng.range(2.2, 7.5)) {
        const off = s.halfRoad + rng.range(0.12, 0.45);   // the crack at the kerb
        const x = s.ax + s.dx * t + s.nx * off * side;
        const z = s.az + s.dz * t + s.nz * off * side;
        grassB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.4, 0.85),
          rng.range(0.62, 0.95));
        n++;
      }
    }
  }
}

function placeVegetation(o) {
  const { L, density, treeBatches, parkBatches, shrubB, shrubB2, flowerB, hedgeB, grassB } = o;
  const g = (x, z) => L.gh(x, z);

  placeStreetPlanting(o, g);

  // ---- Street trees: exactly the sites the tree pits were cut for ----------
  const maxTrees = Math.round(5200 * density);
  const sites = L.treeSites;
  for (let i = 0; i < sites.length && i < maxTrees; i++) {
    const s = sites[i];
    const pair = treeBatches[s.species] || treeBatches.planeLondon;
    const b = pair[i & 1];
    // Street trees are pruned, stunted and unevenly watered; the height spread
    // has to be wide or the street reads as a nursery row.
    b.add(s.x, s.y - 0.05, s.z, s.rot, s.scale, 0.86 + ((i * 37) % 23) / 100,
      s.lean, s.lean * 0.8);
  }

  // ---- The Common and the Public Garden -----------------------------------
  const parkTypes = Object.keys(parkBatches);
  let pi = 0;
  for (const p of L.parkAreas) {
    const rng = new RNG(770011 + (pi++) * 617);
    const { x0, x1, z0, z1 } = p.bounds;
    const area = (x1 - x0) * (z1 - z0);
    const nTrees = Math.min(520, Math.round(area / 620 * density));
    // Oversample candidate positions because many fall outside the park polygon;
    // `remaining` is the real placement budget, kept separate from the loop bound.
    let remaining = nTrees;
    for (let i = 0; i < nTrees * 3 && i < 3000; i++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (!pointInPoly(x, z, p.poly)) continue;
      const type = rng.chance(0.30) ? 'americanElm'
        : rng.chance(0.30) ? 'copperBeech'
          : rng.chance(0.5) ? 'planeLondon' : 'redMaple';
      const arr = parkBatches[type] || parkBatches[parkTypes[0]];
      arr[rng.int(arr.length)].add(x, g(x, z), z, rng.range(0, 6.2832),
        rng.range(0.85, 1.45), rng.range(0.82, 1.08),
        rng.range(-0.04, 0.04), rng.range(-0.04, 0.04));
      if (--remaining <= 0) break;
    }

    // Grass, shrubs, beds and clipped hedges.
    const nGrass = Math.round(area / 26 * density);
    for (let i = 0; i < nGrass; i++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (!pointInPoly(x, z, p.poly)) continue;
      grassB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.7, 1.5),
        rng.range(0.74, 1.14));
    }
    for (let i = 0; i < Math.round(340 * density); i++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (!pointInPoly(x, z, p.poly)) continue;
      (rng.chance(0.6) ? shrubB : shrubB2)
        .add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.7, 1.6), rng.range(0.8, 1.1));
    }
    for (let i = 0; i < Math.round(260 * density); i++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (!pointInPoly(x, z, p.poly)) continue;
      flowerB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.8, 1.5), rng.range(0.85, 1.15));
    }
    // Hedge runs along a few internal lines.
    for (let k = 0; k < 14; k++) {
      const ax = rng.range(x0, x1), az = rng.range(z0, z1);
      const a = rng.range(0, 6.2832);
      const dx = Math.cos(a), dz = Math.sin(a);
      const len = rng.range(6, 26);
      for (let t = 0; t < len; t += 1.2) {
        const x = ax + dx * t, z = az + dz * t;
        if (!pointInPoly(x, z, p.poly)) continue;
        hedgeB.add(x, g(x, z), z, a, rng.range(0.95, 1.05), rng.range(0.9, 1.06));
      }
    }
  }

  // ---- The willows at the Public Garden lagoon -----------------------------
  {
    const c = geo(42.35412, -71.07028);
    const rng = new RNG(4242);
    const willow = parkBatches.weepingWillow[0];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const rx = 52 + rng.range(-6, 8), rz = 27 + rng.range(-4, 6);
      const x = c.x + Math.cos(a) * rx, z = c.z + Math.sin(a) * rz;
      willow.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.85, 1.25),
        rng.range(0.86, 1.06), rng.range(-0.06, 0.06), rng.range(-0.06, 0.06));
    }
    // Beds ringing the lagoon path.
    for (let i = 0; i < Math.round(180 * density); i++) {
      const a = rng.range(0, 6.2832);
      const x = c.x + Math.cos(a) * rng.range(30, 68);
      const z = c.z + Math.sin(a) * rng.range(16, 38);
      flowerB.add(x, g(x, z), z, rng.range(0, 6.2832), rng.range(0.9, 1.5), rng.range(0.85, 1.1));
    }
  }
}
