import * as THREE from 'three';
import { PROFILE } from './RoadNetwork.js';

/**
 * Road, kerb and pavement geometry.
 *
 * The central design rule here is that **no two surfaces ever overlap**. Lane
 * markings are not decals floating above the asphalt; they are coplanar strips
 * of the same continuous ribbon, tiled edge-to-edge across the cross-section.
 * Crosswalks occupy the gap between the intersection polygon and the start of
 * the ribbon. Intersections are true polygons stitched to the exact end
 * vertices of the ribbons that feed them. Nothing is ever offset by a
 * millimetre and hoped for — so nothing can z-fight, at any distance.
 *
 * Only two things are drawn as decals (manholes and drain grates) and those use
 * a real polygon offset rather than a depth bias.
 */

const CHUNK = 700;          // merge radius, metres
const STEP = 12;            // ribbon station spacing for solid bands
const DASH_ON = 3.0, DASH_OFF = 6.0;
const CROWN = 0.09;         // camber drop from centreline to gutter
const CROSSWALK = 3.0;      // depth of a zebra band
const KERB_H = 0.145;
const VERGE = 2.2;          // graded strip that hides the terrain stamp seam

// Atlas tiles: 0 asphalt aggregate | 1 concrete slab | 2 red brick | 3 granite sett
const T_ASPHALT = 0, T_CONCRETE = 1, T_BRICK = 2, T_COBBLE = 3;

// --- tints (linear-ish sRGB authored values; the ACES stack does the rest) ---
// Linear albedo. The atlas is a near-white modulation map, so what is written
// here is very close to what the surface actually reflects: aged asphalt sits
// around 0.09, fresh road paint around 0.55, Boston granite kerb around 0.22.
const C = {
  asphalt:   [0.092, 0.095, 0.104],
  asphaltHot:[0.115, 0.116, 0.120],
  gutter:    [0.078, 0.080, 0.086],
  white:     [0.600, 0.590, 0.552],
  whiteWorn: [0.330, 0.326, 0.310],
  yellow:    [0.520, 0.386, 0.108],
  granite:   [0.225, 0.222, 0.216],
  concrete:  [0.330, 0.324, 0.312],
  brick:     [0.235, 0.112, 0.086],
  cobble:    [0.170, 0.166, 0.158],
  verge:     [0.115, 0.126, 0.076],
};

/** Cheap deterministic hash. Math.sin-based noise costs ~1M trig calls building
 *  the atlas; an integer mix is an order of magnitude faster and tiles better. */
const rnd = (s) => {
  let h = (s * 374761393) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------------------
// Procedural atlases. Four seamless patterns, base colour + normal, so the
// whole city street network is one material and one draw call per chunk.
// ---------------------------------------------------------------------------
function makeAtlas() {
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d');
  const nv = document.createElement('canvas');
  nv.width = nv.height = S * 2;
  const ng = nv.getContext('2d');
  ng.fillStyle = '#8080ff'; ng.fillRect(0, 0, S * 2, S * 2);

  const px = (ctx, ox, oy) => ctx.getImageData(ox, oy, S, S);
  const put = (ctx, d, ox, oy) => ctx.putImageData(d, ox, oy);

  // --- tile 0: asphalt aggregate ---
  {
    const d = px(g, 0, 0), n = px(ng, 0, 0);
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      // clumped aggregate: two octaves of hashed cells
      let v = 0;
      for (let o = 0; o < 3; o++) {
        const sc = 1 << (o + 3);
        const cx = Math.floor(x * sc / S), cy = Math.floor(y * sc / S);
        v += (rnd(cx * 57 + cy * 131 + o * 13) - 0.5) * (0.5 / (o + 1));
      }
      const grain = rnd(x * 3 + y * 7.3) * 0.34 + rnd(x * 11.7 - y * 5.1) * 0.2;
      const l = 232 + v * 46 + (grain - 0.27) * 44;
      d.data[i * 4] = l * 0.99; d.data[i * 4 + 1] = l; d.data[i * 4 + 2] = l * 1.03;
      d.data[i * 4 + 3] = 255;
      const h = (grain - 0.27) * 2.4 + v;
      const hx = ((rnd((x + 1) * 3 + y * 7.3) * 0.34) - 0.27) * 2.4 - (grain - 0.27) * 2.4;
      const hy = ((rnd(x * 3 + (y + 1) * 7.3) * 0.34) - 0.27) * 2.4 - (grain - 0.27) * 2.4;
      n.data[i * 4] = 128 - hx * 105; n.data[i * 4 + 1] = 128 - hy * 105;
      n.data[i * 4 + 2] = 244; n.data[i * 4 + 3] = 255;
    }
    put(g, d, 0, 0); put(ng, n, 0, 0);
  }
  // --- tile 1: concrete slab with control joints ---
  {
    g.fillStyle = '#eeeae2'; g.fillRect(S, 0, S, S);
    const d = px(g, S, 0), n = px(ng, S, 0);
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const blot = (rnd(Math.floor(x / 26) * 31 + Math.floor(y / 26) * 17) - 0.5) * 26;
      const grain = (rnd(x * 5.1 + y * 2.7) - 0.5) * 26;
      const jx = Math.min(x % (S / 2), (S / 2) - 1 - (x % (S / 2)));
      const jy = Math.min(y % (S / 2), (S / 2) - 1 - (y % (S / 2)));
      const joint = (jx < 2 || jy < 2) ? -58 : 0;
      const l = 238 + blot * 0.8 + grain * 0.8 + joint * 0.8;
      d.data[i * 4] = l; d.data[i * 4 + 1] = l * 0.985; d.data[i * 4 + 2] = l * 0.955;
      d.data[i * 4 + 3] = 255;
      const nb = (jx === 2 || jy === 2) ? 60 : (jx < 2 || jy < 2) ? -50 : 0;
      n.data[i * 4] = 128 + (jx < 3 ? nb : 0) + (rnd(x * 9 + y * 4) - 0.5) * 22;
      n.data[i * 4 + 1] = 128 + (jy < 3 ? nb : 0) + (rnd(x * 4 + y * 9) - 0.5) * 22;
      n.data[i * 4 + 2] = 240; n.data[i * 4 + 3] = 255;
    }
    put(g, d, S, 0); put(ng, n, S, 0);
  }
  // --- tile 2: red brick, running bond (Boston pavement) ---
  {
    const d = px(g, 0, S), n = px(ng, 0, S);
    const BW = S / 8, BH = S / 16;
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const row = Math.floor(y / BH);
      const ox = (row % 2) * (BW / 2);
      const bx = ((x + ox) % BW), by = y % BH;
      const bid = Math.floor((x + ox) / BW) * 71 + row * 37;
      const mortar = (bx < 2.2 || by < 2.2);
      const tone = rnd(bid) * 44 - 22;
      const grain = (rnd(x * 6.1 + y * 3.3) - 0.5) * 20;
      let r, gg, b;
      if (mortar) { r = 252 + grain; gg = 250 + grain; b = 244 + grain; }
      else { r = 236 + tone + grain; gg = 214 + tone + grain; b = 206 + tone + grain; }
      d.data[i * 4] = r; d.data[i * 4 + 1] = gg; d.data[i * 4 + 2] = b; d.data[i * 4 + 3] = 255;
      const ex = bx < 3 ? (bx - 1.5) * 34 : bx > BW - 3 ? (bx - (BW - 1.5)) * 34 : 0;
      const ey = by < 3 ? (by - 1.5) * 34 : by > BH - 3 ? (by - (BH - 1.5)) * 34 : 0;
      n.data[i * 4] = 128 - ex; n.data[i * 4 + 1] = 128 - ey;
      n.data[i * 4 + 2] = 232; n.data[i * 4 + 3] = 255;
    }
    put(g, d, 0, S); put(ng, n, 0, S);
  }
  // --- tile 3: granite setts (Acorn St) ---
  {
    const d = px(g, S, S), n = px(ng, S, S);
    const CWd = S / 9, CH = S / 11;
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const row = Math.floor(y / CH);
      const ox = (row % 2) * (CWd / 2);
      const cxi = Math.floor((x + ox) / CWd);
      const bx = (x + ox) % CWd, by = y % CH;
      const id = cxi * 91 + row * 53;
      const jitter = (rnd(id) - 0.5) * 3;
      const inJoint = bx < 3 + jitter || by < 3 + jitter;
      const tone = rnd(id + 7) * 52 - 26;
      const grain = (rnd(x * 7.7 + y * 4.9) - 0.5) * 26;
      const l = inJoint ? 150 + grain * 0.5 : 240 + tone * 0.8 + grain;
      d.data[i * 4] = l * 1.01; d.data[i * 4 + 1] = l; d.data[i * 4 + 2] = l * 0.96;
      d.data[i * 4 + 3] = 255;
      // domed setts
      const u = (bx / CWd - 0.5) * 2, v = (by / CH - 0.5) * 2;
      n.data[i * 4] = 128 - u * 88; n.data[i * 4 + 1] = 128 - v * 88;
      n.data[i * 4 + 2] = 205; n.data[i * 4 + 3] = 255;
    }
    put(g, d, S, S); put(ng, n, S, S);
  }

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  const nrm = new THREE.CanvasTexture(nv);
  for (const t of [map, nrm]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
  }
  return { map, nrm };
}

/**
 * One material for every paved surface in the city.
 * Tiling is done in the shader (`fract` on a world-scaled UV, with explicit
 * gradients so the atlas seams do not blow up the mip selection), which is what
 * lets brick, concrete, granite and asphalt share a single draw call.
 */
function makeRoadMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.map, normalMap: atlas.nrm, vertexColors: true,
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.55,
    normalScale: new THREE.Vector2(1.15, 1.15), dithering: true,
  });
  m.userData.wetnessRough = 0.92;
  m.userData.wetnessColor = m.color.clone();
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aSurf;      // world-scaled pattern UV
        attribute vec2 aTile;      // atlas tile origin (0 or 0.5)
        attribute float aRough;
        varying vec2 vSurf; varying vec2 vTile; varying float vRough;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vSurf = aSurf; vTile = aTile; vRough = aRough;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSurf; varying vec2 vTile; varying float vRough;
        vec4 atlasTex(sampler2D t, vec2 s, vec2 tile) {
          vec2 dx = dFdx(s) * 0.5, dy = dFdy(s) * 0.5;
          return textureGrad(t, tile + fract(s) * 0.5, dx, dy);
        }`)
      .replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = atlasTex(map, vSurf, vTile);
        diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = atlasTex(normalMap, vSurf, vTile).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * vRough;`);
  };
  m.customProgramCacheKey = () => 'bostonRoad';
  return m;
}

// ---------------------------------------------------------------------------
class Batch {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.s = []; this.t = []; this.r = [];
    this.i = []; this.v = 0;
  }
  vert(x, y, z, nx, ny, nz, cr, cg, cb, su, sv, tu, tv, rg) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(cr, cg, cb);
    this.s.push(su, sv); this.t.push(tu, tv); this.r.push(rg);
    return this.v++;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  get empty() { return this.v === 0; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 2));
    g.setAttribute('aTile', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(this.r, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.s, 2));  // for TBN
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const TILE_UV = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];

export default class Roads {
  constructor(net, terrain) {
    this.net = net; this.terrain = terrain;
    this.chunks = new Map();
    this.meshes = [];
    this.decals = null;
    this._nodeGeom = new Map();     // nodeId -> { dirs, trim } used by sidewalks
  }

  /** The chunk covering a world point, created on first touch. */
  _chunk(x, z) {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let b = this.chunks.get(k);
    if (!b) this.chunks.set(k, b = { near: new Batch(), far: new Batch(), key: k });
    return b;
  }

  /** Full-detail vertex sink for a world point. */
  _batch(x, z) { return this._chunk(x, z).near; }

  // -- cross-section --------------------------------------------------------

  /**
   * The full kerb-to-kerb cross-section of one edge, as non-overlapping bands.
   * Bands are emitted left-to-right and tile exactly, so markings are part of
   * the road surface rather than something laid on top of it.
   */
  section(e) {
    const P = PROFILE[e.type];
    const lw = e.width && e.surface !== 'asphalt' ? e.width : null;
    const laneW = P.lane;
    const fwd = e.oneway ? e.lanes : Math.ceil(e.lanes / 2);
    const bwd = e.lanes - fwd;
    const sh = P.shoulder;
    let L = lw ? -lw / 2 : -(bwd * laneW) - sh;
    let R = lw ? lw / 2 : (fwd * laneW) + sh;
    const shift = -(L + R) / 2;
    L += shift; R += shift;
    const half = Math.max(-L, R);

    const bands = [];
    const add = (o0, o1, tile, tint, rough, dash) =>
      bands.push({ o0, o1, tile, tint, rough, dash, road: true });

    const surfTile = e.surface === 'cobble' ? T_COBBLE : T_ASPHALT;
    const surfTint = e.surface === 'cobble' ? C.cobble : C.asphalt;
    const marks = e.type !== 'alley' && e.surface === 'asphalt' && !lw;

    if (!marks) {
      add(L, R, surfTile, surfTint, e.surface === 'cobble' ? 0.86 : 0.97);
    } else {
      let o = L;
      if (sh > 0.05) { add(o, o + sh, T_ASPHALT, C.gutter, 0.99); o += sh; }
      const solid = e.type === 'arterial' || e.type === 'highway';
      if (solid) { add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12; }
      // left-hand (b->a) lanes
      for (let k = bwd; k >= 1; k--) {
        const next = shift - (k - 1) * laneW;
        add(o, k === 1 ? next - 0.09 : next - 0.06, T_ASPHALT, surfTint, 0.97);
        if (k > 1) { add(next - 0.06, next + 0.06, T_ASPHALT, C.white, 0.62, 1); o = next + 0.06; }
        else o = next - 0.09;
      }
      if (bwd > 0 && fwd > 0) {
        // double yellow centre line, with the real 10 cm gap between them
        add(o, o + 0.10, T_ASPHALT, C.yellow, 0.66); o += 0.10;
        add(o, o + 0.08, T_ASPHALT, surfTint, 0.97); o += 0.08;
        add(o, o + 0.10, T_ASPHALT, C.yellow, 0.66); o += 0.10;
      } else if (bwd === 0 && fwd > 0 && sh > 0.05) {
        add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12;
      }
      // right-hand (a->b) lanes
      for (let k = 1; k <= fwd; k++) {
        const next = shift + k * laneW;
        const isLast = k === fwd;
        add(o, isLast ? next : next - 0.06, T_ASPHALT, surfTint, 0.97);
        if (!isLast) { add(next - 0.06, next + 0.06, T_ASPHALT, C.white, 0.62, 1); o = next + 0.06; }
        else o = next;
      }
      if (solid && sh > 0.05) { add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12; }
      if (o < R - 0.02) add(o, R, T_ASPHALT, C.gutter, 0.99);
    }

    // Kerbs and pavement. Boston mixes poured concrete with red brick; brick
    // is the historic districts and the smarter streets.
    const walk = e.walk;
    if (walk > 0.3) {
      const brick = e.brick;
      const wt = brick ? T_BRICK : T_CONCRETE, wc = brick ? C.brick : C.concrete;
      for (const side of [-1, 1]) {
        const edge = side < 0 ? L : R;
        const k0 = edge, k1 = edge + side * 0.16;
        bands.push({ o0: k0, o1: k0, y0: 0, y1: KERB_H, tile: T_ASPHALT,
                     tint: C.granite, rough: 0.74, vertical: true, side });
        bands.push({ o0: side < 0 ? k1 : k0, o1: side < 0 ? k0 : k1, y0: KERB_H, y1: KERB_H,
                     tile: T_ASPHALT, tint: C.granite, rough: 0.72 });
        const w0 = edge + side * 0.16, w1 = edge + side * (0.16 + walk);
        bands.push({ o0: side < 0 ? w1 : w0, o1: side < 0 ? w0 : w1,
                     y0: KERB_H + (side < 0 ? 0.05 : 0.0), y1: KERB_H + (side < 0 ? 0.0 : 0.05),
                     tile: wt, tint: wc, rough: brick ? 0.9 : 0.88, scale: brick ? 1.9 : 2.6 });
        // Graded verge behind the pavement. The terrain raster is stamped a
        // little low around every street so it can never poke through the
        // asphalt; this closes that seam instead of leaving a visible lip.
        const v1 = edge + side * (0.16 + walk + VERGE);
        bands.push({ o0: side < 0 ? v1 : w1, o1: side < 0 ? w1 : v1,
                     y0: side < 0 ? -0.46 : KERB_H, y1: side < 0 ? KERB_H : -0.46,
                     tile: T_CONCRETE, tint: C.verge, rough: 0.98, scale: 3.4 });
      }
    }
    return { bands, L, R, half, shift, corridor: half + (walk > 0.3 ? walk + 0.16 : 0) };
  }

  // -- ribbon ---------------------------------------------------------------

  /** Arc-length frames along an edge, trimmed back from each intersection. */
  _frames(e, t0, t1, step) {
    const out = [];
    const total = e.length;
    const n = Math.max(1, Math.ceil((t1 - t0) / step));
    for (let i = 0; i <= n; i++) {
      const d = t0 + (t1 - t0) * (i / n);
      const s = this._at(e, d);
      s.d = d; s.camber = 1;
      // flatten the camber into the junction so the ribbon end is a straight
      // line and stitches to the intersection polygon without a crack
      const fade = 10;
      s.camber = Math.min(1, Math.min(d - t0, t1 - d) / fade);
      out.push(s);
    }
    return out;
  }

  _at(e, d) {
    const cum = e.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = e.pts[i - 1], b = e.pts[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
    let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
             dx, dz, rx: -dz, rz: dx, slope: (b.y - a.y) / seg };
  }

  /** Emit one band as a strip of quads along the given frames. */
  _strip(bat, frames, band, sec, dashPhase) {
    const tile = TILE_UV[band.tile];
    const sc = band.scale || 2.4;
    const half = sec.half || 1;
    const vy = (o, fr) => {
      const base = band.vertical || band.y0 !== undefined ? 0 : 0;
      const cam = band.road === true || band.y0 === undefined
        ? -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / half), 2) * fr.camber : 0;
      return base + cam;
    };
    const nrm = new THREE.Vector3();
    let prevA = -1, prevB = -1;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const o0 = band.o0, o1 = band.o1;
      const y0 = (band.y0 !== undefined ? band.y0 : vy(o0, f));
      const y1 = (band.y1 !== undefined ? band.y1 : vy(o1, f));
      const x0 = f.x + f.rx * o0, z0 = f.z + f.rz * o0;
      const x1 = f.x + f.rx * o1, z1 = f.z + f.rz * o1;
      // surface normal from the across-vector tilt and the along-slope
      const ax = f.rx * (o1 - o0), ay = y1 - y0, az = f.rz * (o1 - o0);
      nrm.set(f.dx, f.slope, f.dz).cross(new THREE.Vector3(ax, ay, az)).normalize();
      if (nrm.y < 0) nrm.negate();
      let cr = band.tint[0], cg = band.tint[1], cb = band.tint[2];
      if (band.dash) {
        const on = ((f.d + dashPhase) % (DASH_ON + DASH_OFF)) < DASH_ON;
        if (!on) { cr = C.asphalt[0]; cg = C.asphalt[1]; cb = C.asphalt[2]; }
      }
      // age the surface: large-scale patchiness plus per-station wear
      const w = 0.86 + rnd(Math.floor(f.x / 9) * 13 + Math.floor(f.z / 9) * 31) * 0.3;
      cr *= w; cg *= w; cb *= w;
      const a = bat.vert(x0, f.y + y0, z0, nrm.x, nrm.y, nrm.z, cr, cg, cb,
        f.d / sc, o0 / sc, tile[0], tile[1], band.rough);
      const b = bat.vert(x1, f.y + y1, z1, nrm.x, nrm.y, nrm.z, cr, cg, cb,
        f.d / sc, o1 / sc, tile[0], tile[1], band.rough);
      if (i > 0) bat.quad(prevA, prevB, b, a);
      prevA = a; prevB = b;
    }
  }

  // -- intersections --------------------------------------------------------

  /** Corner geometry and trim distances for every node. Must run before ribbons. */
  planNodes() {
    const net = this.net;
    for (const n of net.nodes) {
      const arms = [];
      for (const id of n.edges) {
        const e = net.edges[id];
        const fromA = e.a === n.id;
        const p0 = fromA ? e.pts[0] : e.pts[e.pts.length - 1];
        const p1 = fromA ? e.pts[1] : e.pts[e.pts.length - 2];
        let dx = p1.x - p0.x, dz = p1.z - p0.z;
        const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const sec = this.section(e);
        arms.push({ e, fromA, dx, dz, rx: -dz, rz: dx, sec,
                    hw: sec.half, ang: Math.atan2(dz, dx), trim: sec.half * 0.6 });
      }
      arms.sort((a, b) => a.ang - b.ang);

      const corners = [];
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length];
        corners.push(this._corner(n, A, B));
      }
      // trim each arm back far enough to clear both of its corners
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i];
        const prev = corners[(i - 1 + corners.length) % corners.length];
        const need = [prev, corners[i]].map(c =>
          (c.x - n.x) * A.dx + (c.z - n.z) * A.dz);
        const t = Math.max(A.hw * 0.35, ...need) + 0.4;
        A.trim = Math.min(t, A.e.length * 0.42);
      }
      this._nodeGeom.set(n.id, { arms, corners });
    }
  }

  /** Where two adjacent kerb lines meet, i.e. the actual corner of the junction. */
  _corner(n, A, B) {
    // A's right-hand edge line vs B's left-hand edge line
    const ax = n.x + A.rx * A.hw, az = n.z + A.rz * A.hw;
    const bx = n.x - B.rx * B.hw, bz = n.z - B.rz * B.hw;
    const den = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(den) < 0.12) {
      // near head-on or near-parallel: fall back to a rounded splay
      const mx = (A.dx - B.dx), mz = (A.dz - B.dz);
      const L = Math.hypot(mx, mz) || 1;
      const r = Math.max(A.hw, B.hw);
      return { x: ax + (mx / L) * r * 0.5, z: az + (mz / L) * r * 0.5, A, B };
    }
    const t = ((bx - ax) * B.dz - (bz - az) * B.dx) / den;
    const tc = Math.min(Math.max(t, -Math.max(A.hw, B.hw) * 2.2), Math.max(A.hw, B.hw) * 3.2);
    return { x: ax + A.dx * tc, z: az + A.dz * tc, A, B };
  }

  /** Fill the junction polygon and the pavement corners around it. */
  _emitNode(n) {
    const { arms, corners } = this._nodeGeom.get(n.id);
    if (arms.length < 2) return;
    const bat = this._batch(n.x, n.z);
    const tile = TILE_UV[T_ASPHALT];
    const loop = [];
    const ends = [];
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i];
      const px = n.x + A.dx * A.trim, pz = n.z + A.dz * A.trim;
      const py = n.y + A.trim * (A.fromA ? A.e.pts[1].y - A.e.pts[0].y : 0) * 0;
      const l = { x: px - A.rx * A.hw, z: pz - A.rz * A.hw, y: py };
      const r = { x: px + A.rx * A.hw, z: pz + A.rz * A.hw, y: py };
      ends.push({ A, l, r, px, pz, py });
      loop.push(l, r, { x: corners[i].x, z: corners[i].z, y: n.y });
    }
    // fan from the node centre — crowned very slightly so water sheds
    const nrm = [0, 1, 0];
    const cIdx = bat.vert(n.x, n.y + 0.035, n.z, 0, 1, 0,
      C.asphaltHot[0], C.asphaltHot[1], C.asphaltHot[2], n.x / 2.4, n.z / 2.4,
      tile[0], tile[1], 0.98);
    const ring = loop.map(p => bat.vert(p.x, p.y, p.z, nrm[0], nrm[1], nrm[2],
      C.asphaltHot[0] * 0.96, C.asphaltHot[1] * 0.96, C.asphaltHot[2] * 0.96,
      p.x / 2.4, p.z / 2.4, tile[0], tile[1], 0.98));
    for (let i = 0; i < ring.length; i++) {
      bat.i.push(cIdx, ring[i], ring[(i + 1) % ring.length]);
    }

    // pavement corners: a wedge between each pair of arms, at kerb height
    const ct = TILE_UV[T_CONCRETE];
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i], B = arms[(i + 1) % arms.length], c = corners[i];
      if (A.e.walk < 0.3 || B.e.walk < 0.3) continue;
      const oa = A.hw + 0.16 + A.e.walk, ob = B.hw + 0.16 + B.e.walk;
      const ea = ends[i], eb = ends[(i + 1) % arms.length];
      const co = { x: c.x, z: c.z };
      const dirx = co.x - n.x, dirz = co.z - n.z;
      const dl = Math.hypot(dirx, dirz) || 1;
      const outer = { x: n.x + (dirx / dl) * (dl + Math.max(oa, ob) - Math.max(A.hw, B.hw)),
                      z: n.z + (dirz / dl) * (dl + Math.max(oa, ob) - Math.max(A.hw, B.hw)) };
      const pA = { x: ea.px + A.rx * oa, z: ea.pz + A.rz * oa };
      const pB = { x: eb.px - B.rx * ob, z: eb.pz - B.rz * ob };
      const y = n.y + KERB_H;
      const quad = [
        [ea.r.x, ea.r.z], [pA.x, pA.z], [outer.x, outer.z], [pB.x, pB.z], [eb.l.x, eb.l.z],
        [c.x, c.z],
      ];
      const vs = quad.map(([x, z]) => bat.vert(x, y, z, 0, 1, 0,
        C.concrete[0], C.concrete[1], C.concrete[2], x / 2.6, z / 2.6, ct[0], ct[1], 0.88));
      for (let k = 1; k < vs.length - 1; k++) bat.i.push(vs[0], vs[k], vs[k + 1]);
      // kerb face around the corner
      const gt = TILE_UV[T_ASPHALT];
      const face = [[ea.r.x, ea.r.z], [c.x, c.z], [eb.l.x, eb.l.z]];
      for (let k = 0; k < face.length - 1; k++) {
        const [x0, z0] = face[k], [x1, z1] = face[k + 1];
        let fx = x1 - x0, fz = z1 - z0; const fl = Math.hypot(fx, fz) || 1;
        const nx = -fz / fl, nz = fx / fl;
        const a = bat.vert(x0, n.y, z0, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x0 / 2.4, 0, gt[0], gt[1], 0.74);
        const b = bat.vert(x1, n.y, z1, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x1 / 2.4, 0, gt[0], gt[1], 0.74);
        const c2 = bat.vert(x1, n.y + KERB_H, z1, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x1 / 2.4, KERB_H / 2.4, gt[0], gt[1], 0.74);
        const d = bat.vert(x0, n.y + KERB_H, z0, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x0 / 2.4, KERB_H / 2.4, gt[0], gt[1], 0.74);
        bat.quad(a, b, c2, d);
      }
    }
  }

  /** Zebra crossing in the gap between the junction polygon and the ribbon. */
  _crosswalk(e, sec, d0, d1) {
    const f0 = this._at(e, d0), f1 = this._at(e, d1);
    const bat = this._batch(f0.x, f0.z);
    const tile = TILE_UV[T_ASPHALT];
    const inset = 0.35;
    const w = sec.R - sec.L - inset * 2;
    const stripes = Math.max(2, Math.round(w / 1.05));
    const sw = w / stripes;
    for (let i = 0; i < stripes; i++) {
      const paint = i % 2 === 0;
      const t = paint ? C.white : C.asphalt;
      const wear = 0.72 + rnd(i * 7 + Math.floor(f0.x)) * 0.42;
      const o0 = sec.L + inset + i * sw, o1 = o0 + sw * (paint ? 0.86 : 1);
      const vs = [[f0, o0], [f0, o1], [f1, o1], [f1, o0]].map(([f, o]) => {
        const cam = -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / sec.half), 2) * 0.35;
        return bat.vert(f.x + f.rx * o, f.y + cam, f.z + f.rz * o, 0, 1, 0,
          t[0] * wear, t[1] * wear, t[2] * wear, (f.d || 0) / 2.4, o / 2.4,
          tile[0], tile[1], paint ? 0.66 : 0.97);
      });
      bat.quad(vs[0], vs[1], vs[2], vs[3]);
    }
  }

  // -- build ----------------------------------------------------------------

  build(scene, materials, assets) {
    // The road material carries custom vertex attributes (atlas tile, world
    // pattern UV, per-band roughness) and does its tiling in the shader, so it
    // cannot be one of the materials library's generic surfaces. Build it here
    // and register it so it is still shared, disposed centrally and picked up
    // by `assets.setWetness()` when it rains.
    this.atlas = makeAtlas();
    this.material = assets
      ? assets.material('road_atlas', () => makeRoadMaterial(this.atlas))
      : makeRoadMaterial(this.atlas);
    this._ownMaterial = !assets;
    // Match the materials library's environment response if it has landed.
    const ref = materials?.get?.('asphalt');
    if (ref && ref.name === 'asphalt') {
      this.material.envMapIntensity = ref.envMapIntensity ?? this.material.envMapIntensity;
    }

    this.planNodes();
    const net = this.net;

    // Boston's brick pavement districts.
    for (const e of net.edges) {
      e.brick = e.surface === 'cobble' ||
        (e.type !== 'highway' && (e.name.includes('Beacon') || e.name.includes('Chestnut') ||
         e.name.includes('Mount Vernon') || e.name.includes('Pinckney') ||
         e.name.includes('Charles Street') || e.name.includes('Hanover') ||
         e.name.includes('Salem') || e.name.includes('Newbury') ||
         e.name.includes('Marlborough') || e.name.includes('Commonwealth')));
    }

    for (const e of net.edges) {
      const sec = this.section(e);
      e._sec = sec;
      const ga = this._nodeGeom.get(e.a), gb = this._nodeGeom.get(e.b);
      const ta = ga?.arms.find(a => a.e === e && a.fromA);
      const tb = gb?.arms.find(a => a.e === e && !a.fromA);
      let d0 = ta ? ta.trim : 0;
      let d1 = e.length - (tb ? tb.trim : 0);
      if (d1 - d0 < 3) { const m = (d0 + d1) / 2; d0 = m - 1.5; d1 = m + 1.5; }

      // crosswalks only where it is a real junction and a real street
      const cwA = net.nodes[e.a].edges.length > 2 && e.type !== 'alley' && e.type !== 'highway';
      const cwB = net.nodes[e.b].edges.length > 2 && e.type !== 'alley' && e.type !== 'highway';
      if (cwA && d1 - d0 > CROSSWALK * 2 + 6) { this._crosswalk(e, sec, d0, d0 + CROSSWALK); d0 += CROSSWALK; }
      if (cwB && d1 - d0 > CROSSWALK + 6) { this._crosswalk(e, sec, d1 - CROSSWALK, d1); d1 -= CROSSWALK; }
      e._span = [d0, d1];

      const coarse = this._frames(e, d0, d1, STEP);
      const fine = this._frames(e, d0, d1, DASH_ON);
      const phase = rnd(e.id) * (DASH_ON + DASH_OFF);
      const mid = this._at(e, (d0 + d1) / 2);
      const ch = this._chunk(mid.x, mid.z);
      const bat = ch.near;
      for (const band of sec.bands) {
        this._strip(bat, band.dash ? fine : coarse, band, sec, phase);
      }
      // low-detail version: bare carriageway + pavement, no markings
      const fbat = ch.far;
      const lo = this._frames(e, d0, d1, STEP * 3);
      this._strip(fbat, lo, { o0: sec.L, o1: sec.R, tile: T_ASPHALT, tint: C.asphalt,
                              rough: 0.97, road: true }, sec, 0);
      for (const band of sec.bands) {
        if (band.tile === T_CONCRETE || band.tile === T_BRICK) this._strip(fbat, lo, band, sec, 0);
      }
    }

    for (const n of net.nodes) this._emitNode(n);

    // stop lines: a solid bar across the approach lanes, just past the zebra
    this._stopLines();
    this._details();

    let tris = 0;
    for (const ch of this.chunks.values()) {
      if (ch.near.empty) continue;
      const near = new THREE.Mesh(ch.near.geometry(), this.material);
      near.receiveShadow = true; near.castShadow = false;
      near.matrixAutoUpdate = false; near.name = 'road_' + ch.key;
      scene.add(near);
      const far = new THREE.Mesh(ch.far.geometry(), this.material);
      far.receiveShadow = true; far.matrixAutoUpdate = false;
      far.visible = false; far.name = 'roadLod_' + ch.key;
      scene.add(far);
      ch.nearMesh = near; ch.farMesh = far;
      ch.center = near.geometry.boundingSphere.center.clone();
      ch.radius = near.geometry.boundingSphere.radius;
      this.meshes.push(near, far);
      tris += ch.near.i.length / 3;
    }
    this.triangles = tris;
    return this;
  }

  _stopLines() {
    const net = this.net, tile = TILE_UV[T_ASPHALT];
    for (const e of net.edges) {
      if (e.type === 'alley' || e.type === 'highway' || !e._span) continue;
      const sec = e._sec;
      for (const end of [0, 1]) {
        const nid = end === 0 ? e.a : e.b;
        if (net.nodes[nid].edges.length < 3) continue;
        const d = end === 0 ? e._span[0] + 0.05 : e._span[1] - 0.65;
        if (d < 0 || d + 0.6 > e.length) continue;
        const f0 = this._at(e, d), f1 = this._at(e, d + 0.6);
        const bat = this._batch(f0.x, f0.z);
        // only the approach half of the carriageway
        const o0 = end === 0 ? sec.shift + 0.14 : sec.L + 0.6;
        const o1 = end === 0 ? sec.R - 0.5 : sec.shift - 0.14;
        if (o1 - o0 < 1) continue;
        const wear = 0.6 + rnd(e.id * 3 + end) * 0.5;
        const vs = [[f0, o0], [f0, o1], [f1, o1], [f1, o0]].map(([f, o]) => {
          const cam = -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / sec.half), 2) * 0.3;
          return bat.vert(f.x + f.rx * o, f.y + cam, f.z + f.rz * o, 0, 1, 0,
            C.white[0] * wear, C.white[1] * wear, C.white[2] * wear,
            f.d / 2.4, o / 2.4, tile[0], tile[1], 0.66);
        });
        bat.quad(vs[0], vs[1], vs[2], vs[3]);
      }
    }
  }

  /**
   * Manholes and gully gratings. The only true decals in the system, so they
   * get a real polygon offset instead of a hopeful vertical nudge.
   */
  _details() {
    const pos = [], nrm = [], col = [], idx = [];
    let v = 0;
    const disc = (cx, cy, cz, r, sides, shade, ring) => {
      const c0 = v;
      pos.push(cx, cy, cz); nrm.push(0, 1, 0); col.push(shade * 1.1, shade, shade * 0.92); v++;
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r);
        nrm.push(0, 1, 0);
        const s = shade * (ring ? (0.7 + 0.3 * Math.abs(Math.sin(a * 4))) : 1);
        col.push(s * 1.1, s, s * 0.92); v++;
      }
      for (let i = 0; i < sides; i++) idx.push(c0, c0 + 1 + i, c0 + 1 + ((i + 1) % sides));
    };
    for (const e of this.net.edges) {
      if (!e._span || e.type === 'highway' || e.type === 'alley') continue;
      const sec = e._sec;
      const [d0, d1] = e._span;
      for (let d = d0 + 6; d < d1 - 6; d += 34) {
        const j = rnd(e.id * 17 + d);
        if (j > 0.55) continue;
        const f = this._at(e, d + j * 20);
        if (j < 0.24) {                      // manhole, near the crown
          const o = sec.shift + (j - 0.12) * 8;
          disc(f.x + f.rx * o, f.y + 0.006, f.z + f.rz * o, 0.33, 14, 0.055, true);
        } else {                             // gully grating, in the gutter
          const side = j > 0.4 ? 1 : -1;
          const o = (side < 0 ? sec.L : sec.R) - side * 0.34;
          disc(f.x + f.rx * o, f.y - CROWN * 0.85 + 0.004, f.z + f.rz * o, 0.26, 8, 0.035, false);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.72,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      depthWrite: false,
    });
    this.decals = new THREE.Mesh(g, m);
    this.decals.renderOrder = 2;
    this.decals.matrixAutoUpdate = false;
    this.decals.receiveShadow = true;
    this._detailMat = m;
  }

  /** Distance LOD. Markings are sub-pixel past ~320 m, so drop them. */
  update(camera) {
    const p = camera.position;
    for (const ch of this.chunks.values()) {
      if (!ch.nearMesh) continue;
      const d = Math.hypot(p.x - ch.center.x, p.z - ch.center.z) - ch.radius;
      const near = d < 290;
      if (ch.nearMesh.visible !== near) {
        ch.nearMesh.visible = near;
        ch.farMesh.visible = !near;
      }
    }
    if (this.decals) this.decals.visible = true;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.parent?.remove(m); }
    this.meshes.length = 0;
    this.decals?.geometry.dispose();
    this.decals?.parent?.remove(this.decals);
    this._detailMat?.dispose();
    if (this._ownMaterial) this.material?.dispose();
    this.atlas?.map.dispose(); this.atlas?.nrm.dispose();
  }
}

export { KERB_H, makeRoadMaterial, makeAtlas };
