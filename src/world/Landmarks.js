import * as THREE from 'three';
import { geo } from '../core/Geo.js';
import {
  MeshBuf, GlassBuf, SURF, hash2,
  buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial,
} from './BuildingKit.js';
import { LANDMARKS } from '../data/landmarks.js';
import { GROUP, groups } from '../physics/PhysicsWorld.js';

/**
 * Boston's landmarks, individually modelled.
 *
 * Every one is placed with `geo(lat, lon)` and built into a single merged mesh
 * sharing the city facade material, so a landmark costs one draw call (two when
 * it is glazed). Glass towers use the shader-subdivided curtain wall (`kind 5`),
 * which turns 240 m of glazing into four triangles while still giving every
 * individual pane its own room interior and its own night light.
 */

const D2R = Math.PI / 180;

/* -------------------------------------------------------------------------- */
/* Local-frame emitter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a MeshBuf/GlassBuf in a local coordinate frame so each landmark can be
 * authored around its own origin with its long axis on +X, then dropped onto the
 * map at the right lat/lon and heading.
 */
class LM {
  constructor(mb, gb, ox, oy, oz, rot) {
    this.mb = mb; this.gb = gb;
    this.ox = ox; this.oy = oy; this.oz = oz; this.rot = rot;
    this.c = Math.cos(rot); this.s = Math.sin(rot);
  }
  wx(x, z) { return this.ox + x * this.c + z * this.s; }
  wz(x, z) { return this.oz - x * this.s + z * this.c; }
  wy(y) { return this.oy + y; }
  p(x, y, z) { return [this.wx(x, z), this.oy + y, this.wz(x, z)]; }

  box(x, y, z, sx, sy, sz, r, surf, col, emis = 0, skipBottom = true) {
    this.mb.box(this.wx(x, z), this.oy + y, this.wz(x, z),
      sx, sy, sz, this.rot + (r || 0), surf, col, emis, skipBottom);
  }
  /** Vertical wall between two local XZ points. */
  wall(x0, z0, x1, z1, y0, y1, surf, col, uo = 0, vo = 0, emis = 0) {
    this.mb.wall(this.wx(x0, z0), this.wz(x0, z0), this.wx(x1, z1), this.wz(x1, z1),
      this.oy + y0, this.oy + y1, surf, col, uo, vo, emis);
  }
  cap(poly, y, surf, col, up = true, emis = 0) {
    this.mb.cap(poly.map(p => ({ x: this.wx(p.x, p.z), z: this.wz(p.x, p.z) })),
      this.oy + y, surf, col, up, emis);
  }
  /** Closed prism: perimeter walls plus a top cap. */
  prism(poly, y0, y1, surf, col, capTop = true, emis = 0) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      this.wall(a.x, a.z, b.x, b.z, y0, y1, surf, col, i * 3.1, 0, emis);
    }
    if (capTop) this.cap(poly, y1, surf, col, true, emis);
  }
  /** Regular n-gon in the local XZ plane. */
  ring(cx, cz, r, sides, phase = 0) {
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * Math.PI * 2;
      out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
    }
    return out;
  }
  /** Tapered prism — obelisks, spires, stepped crowns. */
  taper(cx, cz, r0, r1, y0, y1, sides, surf, col, phase = 0, capTop = true) {
    const a0 = this.ring(cx, cz, r0, sides, phase);
    const a1 = this.ring(cx, cz, r1, sides, phase);
    for (let i = 0; i < sides; i++) {
      const p0 = a0[i], p1 = a0[(i + 1) % sides];
      const q0 = a1[i], q1 = a1[(i + 1) % sides];
      const nx = p1.z - p0.z, nz = -(p1.x - p0.x);
      this.mb.quadAuto(this.p(p0.x, y0, p0.z), this.p(p1.x, y0, p1.z),
        this.p(q1.x, y1, q1.z), this.p(q0.x, y1, q0.z),
        nx * this.c + 0 * this.s, 0.25, -nx * this.s + nz * this.c,
        [0, 0, 2.6, 0, 2.6, (y1 - y0) / 2, 0, (y1 - y0) / 2], col, surf);
    }
    if (capTop && r1 > 0.02) this.cap(a1, y1, surf, col, true);
  }
  /** Hemispherical dome. */
  dome(cx, cz, r, y0, h, sides, rings, surf, col, emis = 0) {
    for (let k = 0; k < rings; k++) {
      const t0 = k / rings, t1 = (k + 1) / rings;
      const a0 = t0 * Math.PI * 0.5, a1 = t1 * Math.PI * 0.5;
      const r0 = r * Math.cos(a0), r1 = r * Math.cos(a1);
      const y0k = y0 + h * Math.sin(a0), y1k = y0 + h * Math.sin(a1);
      const g0 = this.ring(cx, cz, r0, sides), g1 = this.ring(cx, cz, r1, sides);
      for (let i = 0; i < sides; i++) {
        const p0 = g0[i], p1 = g0[(i + 1) % sides];
        const q0 = g1[i], q1 = g1[(i + 1) % sides];
        const mx = (p0.x + p1.x) * 0.5 - cx, mz = (p0.z + p1.z) * 0.5 - cz;
        this.mb.quadAuto(this.p(p0.x, y0k, p0.z), this.p(p1.x, y0k, p1.z),
          this.p(q1.x, y1k, q1.z), this.p(q0.x, y1k, q0.z),
          mx * this.c + mz * this.s, 0.35 + t0, -mx * this.s + mz * this.c,
          [0, 0, 1.4, 0, 1.4, 1.0, 0, 1.0], col, surf, emis);
      }
    }
  }
  /** Column: shaft, base and a simple capital. Doric enough at any real distance. */
  column(x, z, r, y0, h, surf, col) {
    this.prism(this.ring(x, z, r, 8), y0, y0 + h, surf, col, false);
    this.box(x, y0 + 0.16, z, r * 2.7, 0.32, r * 2.7, 0, surf, col);
    this.box(x, y0 + h - 0.22, z, r * 2.5, 0.44, r * 2.5, 0, surf, col);
  }
  /** Pitched roof over a rectangular block, ridge along local X. */
  gable(x0, x1, z0, z1, yEave, rise, surf, col) {
    const cz = (z0 + z1) * 0.5;
    for (const [za, zb] of [[z0, cz], [z1, cz]]) {
      const sgn = za < cz ? -1 : 1;
      this.mb.quadAuto(this.p(x0, yEave, za), this.p(x1, yEave, za),
        this.p(x1, yEave + rise, zb), this.p(x0, yEave + rise, zb),
        0, 0.8, sgn * 0.6,
        [0, 0, (x1 - x0) / 1.4, 0, (x1 - x0) / 1.4, 2.6, 0, 2.6], col, surf);
    }
    for (const x of [x0, x1]) {
      this.mb.quadAuto(this.p(x, yEave, z0), this.p(x, yEave, z1),
        this.p(x, yEave + rise, cz), this.p(x, yEave + rise, cz),
        x === x0 ? -1 : 1, 0, 0, [0, 0, 2, 0, 2, 2, 0, 2], col, surf);
    }
  }
  /** Flat vertical pane on a local segment. */
  pane(x0, z0, x1, z1, y0, y1, seed, lit, kind, frameCol, depth = 3.2) {
    if (!this.gb) return;
    const ax = this.wx(x0, z0), az = this.wz(x0, z0);
    const bx = this.wx(x1, z1), bz = this.wz(x1, z1);
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.02 || y1 - y0 < 0.02) return;
    const tx = dx / L, tz = dz / L;
    const nx = tz, nz = -tx;
    this.gb.pane([ax, this.oy + y0, az], [bx, this.oy + y0, bz],
      [bx, this.oy + y1, bz], [ax, this.oy + y1, az],
      [nx, 0, nz], [tx, 0, tz], L, y1 - y0, depth, seed, lit, kind, frameCol);
  }
  /** Curtain-wall a whole polygon in one pane per face. */
  curtain(poly, y0, y1, seed, lit, frameCol) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      this.pane(a.x, a.z, b.x, b.z, y0, y1, hash2(seed, i * 71), lit, 5, frameCol, 3.6);
    }
  }
  /** Standard flat-roof furniture so no landmark reads as a bare lid. */
  roofKit(cx, cz, w, d, y, seed, big = false) {
    const r = (k) => hash2(seed, k);
    this.box(cx + (r(1) - 0.5) * w * 0.5, y + 1.6, cz + (r(2) - 0.5) * d * 0.5,
      3.4, 3.2, 3.0, 0, 'concrete', [0.86, 0.86, 0.84]);
    const n = big ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const ux = cx + (r(10 + i) - 0.5) * w * 0.72;
      const uz = cz + (r(30 + i) - 0.5) * d * 0.72;
      const s = 1.2 + r(50 + i) * 1.6;
      this.box(ux, y + 0.7, uz, s * 1.5, 1.2, s, 0, 'metal_panel', [0.84, 0.86, 0.88]);
      this.box(ux, y + 1.42, uz, s * 0.8, 0.28, s * 0.6, 0, 'metal_dark', [0.35, 0.35, 0.36]);
    }
    for (let i = 0; i < 4; i++) {
      this.box(cx + (r(70 + i) - 0.5) * w * 0.8, y + 0.65, cz + (r(90 + i) - 0.5) * d * 0.8,
        0.22, 1.3, 0.22, 0, 'metal_dark', [0.45, 0.44, 0.42]);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Individual landmarks                                                       */
/* -------------------------------------------------------------------------- */

const GRANITE = [0.98, 0.98, 0.97];
const BRICK = [0.96, 0.90, 0.86];
const WHITE = [1.02, 1.01, 0.99];
const CONC = [0.92, 0.92, 0.90];

/** 200 Clarendon — the rhomboid blue glass slab. Boston's defining silhouette. */
function hancock(l, h) {
  // 88 x 30.5 m parallelogram, ends sheared ~17 m, with the vertical notch that
  // makes each end read as two razor-thin slabs.
  const A = { x: -44, z: -15.25 }, B = { x: 44, z: -15.25 };
  const C = { x: 27, z: 15.25 }, D = { x: -61, z: 15.25 };
  const Bm = { x: 32.0, z: -1.94 }, Dm = { x: -49.0, z: 1.94 };
  const plan = [A, B, Bm, C, D, Dm];
  const base = 9.0;
  // granite podium
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i], b = plan[(i + 1) % plan.length];
    l.wall(a.x, a.z, b.x, b.z, 0, base, 'granite', GRANITE, i * 5, 0);
  }
  l.curtain(plan, base, h - 1.4, 4001, 0.30, [0.20, 0.23, 0.27]);
  // the shaft's spandrel edge and the crisp parapet
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i], b = plan[(i + 1) % plan.length];
    l.wall(a.x, a.z, b.x, b.z, h - 1.4, h + 0.9, 'metal_dark', [0.42, 0.45, 0.49], i * 4, 0);
  }
  l.cap(plan, h + 0.9, 'roof_gravel', CONC, true);
  l.roofKit(-8, 0, 60, 22, h + 0.9, 4002, true);
  // aircraft warning lights
  for (const p of [B, D]) l.box(p.x * 0.9, h + 2.2, p.z * 0.9, 0.6, 0.5, 0.6, 0,
    'sign', [1, 0.25, 0.2], 3.0);
  // lobby glazing
  l.curtain(plan, 1.0, base - 1.2, 4003, 0.9, [0.28, 0.30, 0.33]);
}

/** Prudential Tower — 229 m, strong vertical piers, Skywalk band, mast. */
function prudential(l, h) {
  const hw = 29, hd = 21.5, ch = 5.5;    // chamfered corners
  const plan = [
    { x: -hw + ch, z: -hd }, { x: hw - ch, z: -hd }, { x: hw, z: -hd + ch },
    { x: hw, z: hd - ch }, { x: hw - ch, z: hd }, { x: -hw + ch, z: hd },
    { x: -hw, z: hd - ch }, { x: -hw, z: -hd + ch },
  ];
  const base = 12;
  l.prism(plan, 0, base, 'granite', GRANITE, false);
  l.curtain(plan, 2.0, base - 2.0, 4101, 0.85, [0.3, 0.3, 0.32]);
  l.curtain(plan, base, h - 12, 4102, 0.34, [0.72, 0.72, 0.70]);
  // Concrete piers every ~3.6 m: the Pru's whole character.
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i], b = plan[(i + 1) % plan.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(L / 3.6));
    const ang = Math.atan2(dx, dz);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const px = a.x + dx * t, pz = a.z + dz * t;
      const ox = (dz / L) * 0.35, oz = (-dx / L) * 0.35;
      l.box(px + ox, (base + h - 12) * 0.5, pz + oz, 1.15, h - 12 - base, 0.85,
        ang, 'concrete', CONC);
    }
  }
  // Skywalk / Top of the Hub band
  const wide = plan.map(p => ({ x: p.x * 1.06, z: p.z * 1.06 }));
  l.prism(wide, h - 12, h - 4.5, 'concrete', CONC, false);
  l.curtain(wide, h - 11.4, h - 5.2, 4103, 0.95, [0.35, 0.35, 0.36]);
  l.prism(plan, h - 4.5, h + 1.2, 'concrete', CONC, true);
  l.roofKit(0, 0, 40, 30, h + 1.2, 4104, true);
  l.taper(0, 0, 1.5, 0.5, h + 1.2, h + 27, 6, 'metal_dark', [0.5, 0.5, 0.52]);
  l.box(0, h + 28, 0, 0.9, 0.8, 0.9, 0, 'sign', [1, 0.25, 0.2], 3.0);
}

/** Massachusetts State House — red brick, white colonnade, gilded dome. */
function stateHouse(l) {
  const GOLD = [1.0, 0.95, 0.85];
  const bw = 27, bd = 15;                 // Bulfinch front block half-extents
  // granite arcade base
  l.box(0, 3.2, 0, bw * 2 + 2, 6.4, bd * 2 + 2, 0, 'granite', GRANITE);
  for (let i = 0; i < 9; i++) {
    const x = -bw + 2 + (i / 8) * (bw * 2 - 4);
    l.mb.quadAuto(l.p(x - 1.5, 2.4, -bd - 1.02), l.p(x + 1.5, 2.4, -bd - 1.02),
      l.p(x + 1.5, 5.6, -bd - 1.02), l.p(x - 1.5, 5.6, -bd - 1.02),
      -l.s, 0, -l.c, [0, 0, 1.6, 0, 1.6, 1.6, 0, 1.6], [0.30, 0.28, 0.26], 'wood_dark');
  }
  // brick main block
  const body = [{ x: -bw, z: -bd }, { x: bw, z: -bd }, { x: bw, z: bd }, { x: -bw, z: bd }];
  l.prism(body, 6.4, 20.5, 'brick_red', BRICK, false);
  // window rows
  for (let f = 0; f < 2; f++) {
    const y = 8.4 + f * 6.0;
    for (let i = 0; i < 11; i++) {
      const x = -bw + 2.6 + (i / 10) * (bw * 2 - 5.2);
      for (const zz of [-bd - 0.02, bd + 0.02]) {
        l.pane(x - 0.85, zz, x + 0.85, zz, y, y + 3.2, hash2(4200 + f, i), 0.4, 1,
          [0.95, 0.94, 0.90], 2.4);
        l.box(x, y - 0.22, zz, 2.4, 0.20, 0.24, 0, 'trim_stone', WHITE);
        l.box(x, y + 3.42, zz, 2.4, 0.22, 0.20, 0, 'trim_stone', WHITE);
      }
    }
  }
  // white Corinthian portico across the front
  for (let i = 0; i < 12; i++) {
    const x = -19 + (i / 11) * 38;
    l.column(x, -bd - 2.6, 0.72, 6.4, 12.4, 'trim_stone', WHITE);
  }
  l.box(0, 19.6, -bd - 2.6, 41, 1.9, 3.4, 0, 'trim_stone', WHITE);
  l.gable(-20.5, 20.5, -bd - 4.4, -bd - 0.8, 20.5, 3.0, 'trim_stone', WHITE);
  // white balustrade
  for (let i = 0; i < 26; i++) {
    l.box(-bw + 1 + (i / 25) * (bw * 2 - 2), 21.4, -bd + 0.4, 0.28, 1.5, 0.28,
      0, 'trim_stone', WHITE);
  }
  l.box(0, 22.3, -bd + 0.4, bw * 2, 0.3, 0.6, 0, 'trim_stone', WHITE);

  // side wings (the yellow-brick 1895 extension and the 1917 wings)
  for (const sx of [-1, 1]) {
    l.box(sx * (bw + 13), 11, 4, 24, 22, 30, 0, 'brick_brown', [0.98, 0.94, 0.84]);
    l.box(sx * (bw + 13), 22.4, 4, 25, 0.9, 31, 0, 'trim_stone', WHITE);
    for (let f = 0; f < 3; f++) for (let i = 0; i < 5; i++) {
      const y = 4.5 + f * 6.0;
      const x = sx * (bw + 13) - 9 + (i / 4) * 18;
      l.pane(x - 0.8, -11.02, x + 0.8, -11.02, y, y + 3.0, hash2(4210 + f, i), 0.35, 1,
        [0.94, 0.93, 0.90], 2.2);
    }
  }

  // the dome — drum, gilded shell, lantern, gilded pine cone
  const dz = 4;
  l.taper(0, dz, 12.5, 12.0, 20.5, 25.0, 20, 'trim_stone', WHITE, 0, false);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    l.column(Math.cos(a) * 12.6, dz + Math.sin(a) * 12.6, 0.44, 21.0, 3.6,
      'trim_stone', WHITE);
  }
  l.taper(0, dz, 12.0, 11.0, 25.0, 27.2, 20, 'trim_stone', WHITE, 0, false);
  l.dome(0, dz, 11.0, 27.2, 11.6, 22, 7, 'gold', GOLD);
  l.taper(0, dz, 2.6, 2.4, 38.6, 42.2, 12, 'gold', GOLD, 0, false);
  l.dome(0, dz, 2.4, 42.2, 2.2, 12, 3, 'gold', GOLD);
  l.taper(0, dz, 0.75, 0.05, 44.4, 47.0, 8, 'gold', GOLD);
}

/** Custom House Tower — granite Greek Revival base, clock tower, lantern. */
function customHouse(l, h) {
  const bw = 17;
  const base = [{ x: -bw, z: -bw }, { x: bw, z: -bw }, { x: bw, z: bw }, { x: -bw, z: bw }];
  l.prism(base, 0, 22, 'granite', GRANITE, false);
  // Doric peristyle on all four sides
  for (const side of [0, 1, 2, 3]) {
    for (let i = 0; i < 6; i++) {
      const t = -1 + (i / 5) * 2;
      const off = bw + 1.6;
      const x = side === 0 ? t * bw * 0.82 : side === 2 ? t * bw * 0.82
        : (side === 1 ? off : -off);
      const z = side === 0 ? -off : side === 2 ? off : t * bw * 0.82;
      l.column(x, z, 1.05, 2.2, 15.5, 'granite', GRANITE);
    }
  }
  l.box(0, 19.0, 0, (bw + 2.6) * 2, 3.0, (bw + 2.6) * 2, 0, 'granite', GRANITE);
  l.box(0, 22.6, 0, (bw + 1.4) * 2, 1.2, (bw + 1.4) * 2, 0, 'granite', GRANITE);

  // the tower shaft
  const tw = 10.5;
  const shaft = [{ x: -tw, z: -tw }, { x: tw, z: -tw }, { x: tw, z: tw }, { x: -tw, z: tw }];
  l.prism(shaft, 22, h - 34, 'granite', GRANITE, false);
  // pilaster strips + recessed window bays
  for (let i = 0; i < shaft.length; i++) {
    const a = shaft[i], b = shaft[(i + 1) % 4];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      l.box(a.x + dx * t + (dz / L) * 0.30, (22 + h - 34) * 0.5, a.z + dz * t - (dx / L) * 0.30,
        1.5, h - 56, 0.7, ang, 'granite', [1.02, 1.02, 1.00]);
    }
    for (let f = 0; f < 9; f++) {
      const y = 25 + f * 4.0;
      if (y + 3 > h - 34) break;
      for (let k = 0; k < 3; k++) {
        const t = (k + 0.5) / 3;
        const px = a.x + dx * t, pz = a.z + dz * t;
        l.pane(px - (dx / L) * 1.1 + (dz / L) * 0.02, pz - (dz / L) * 1.1 - (dx / L) * 0.02,
          px + (dx / L) * 1.1 + (dz / L) * 0.02, pz + (dz / L) * 1.1 - (dx / L) * 0.02,
          y, y + 2.8, hash2(4300 + f, k * 7 + i), 0.30, 1, [0.55, 0.55, 0.52], 2.2);
      }
    }
  }
  // clock stage: four illuminated faces
  const cy = h - 34;
  const cw = 11.5;
  const clock = [{ x: -cw, z: -cw }, { x: cw, z: -cw }, { x: cw, z: cw }, { x: -cw, z: cw }];
  l.prism(clock, cy, cy + 13, 'granite', GRANITE, false);
  for (let i = 0; i < 4; i++) {
    const a = clock[i], b = clock[(i + 1) % 4];
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    const ox = (dz / L) * 0.30, oz = (-dx / L) * 0.30;
    const ang = Math.atan2(dx, dz);
    l.box(mx + ox, cy + 6.6, mz + oz, 8.6, 8.6, 0.5, ang, 'sign', [1.0, 0.96, 0.86], 1.6);
    l.box(mx + ox * 2.4, cy + 6.6, mz + oz * 2.4, 9.4, 9.4, 0.4, ang,
      'trim_stone', [0.9, 0.89, 0.86]);
    // hands
    l.box(mx + ox * 3, cy + 8.0, mz + oz * 3, 0.4, 3.0, 0.3, ang, 'metal_dark', [0.1, 0.1, 0.1]);
    l.box(mx + ox * 3, cy + 6.6, mz + oz * 3, 2.6, 0.4, 0.3, ang, 'metal_dark', [0.1, 0.1, 0.1]);
  }
  l.box(0, cy + 14.2, 0, cw * 2 + 3, 2.4, cw * 2 + 3, 0, 'granite', GRANITE);
  // stepped pyramid + lantern
  l.taper(0, 0, cw, 4.6, cy + 15.4, h - 8, 4, 'copper', [0.92, 1.02, 0.96], Math.PI / 4, false);
  l.taper(0, 0, 3.2, 3.0, h - 8, h - 3.6, 8, 'granite', GRANITE, 0, false);
  l.taper(0, 0, 3.6, 0.2, h - 3.6, h, 8, 'copper', [0.92, 1.02, 0.96]);
  l.box(0, h + 1.2, 0, 0.5, 2.4, 0.5, 0, 'metal_dark', [0.4, 0.4, 0.4]);
}

/** Faneuil Hall, Quincy Market and the North/South Market blocks. */
function faneuil(l) {
  // --- Faneuil Hall: brick, arcaded ground floor, cupola + grasshopper ---
  l.box(-96, 8.5, 0, 30, 17, 15.5, 0, 'brick_red', BRICK);
  l.box(-96, 17.6, 0, 31.5, 1.2, 17, 0, 'trim_stone', WHITE);
  for (let i = 0; i < 7; i++) {
    const x = -96 - 12 + (i / 6) * 24;
    for (const z of [-7.85, 7.85]) {
      l.pane(x - 1.1, z, x + 1.1, z, 3.2, 6.4, hash2(4400, i), 0.5, 1, [0.94, 0.93, 0.9], 2.5);
      l.pane(x - 1.1, z, x + 1.1, z, 9.0, 13.2, hash2(4401, i), 0.5, 1, [0.94, 0.93, 0.9], 2.5);
      l.box(x, 8.7, z, 2.8, 0.24, 0.22, 0, 'trim_stone', WHITE);
    }
  }
  l.gable(-111, -81, -7.75, 7.75, 17.6, 4.2, 'slate', [0.95, 0.96, 0.98]);
  l.box(-96, 22.4, 0, 5.4, 3.6, 5.4, 0, 'wood_white', WHITE);
  l.taper(-96, 0, 3.4, 2.6, 24.2, 27.6, 8, 'wood_white', WHITE, 0, false);
  l.dome(-96, 0, 2.6, 27.6, 2.4, 10, 3, 'copper', [0.92, 1.02, 0.96]);
  l.box(-96, 31.4, 0, 0.16, 3.4, 0.16, 0, 'gold', [1, 0.95, 0.85]);
  l.box(-96, 33.0, 0, 1.5, 0.7, 0.12, 0, 'gold', [1, 0.95, 0.85], 0.2);  // grasshopper vane

  // --- Quincy Market: 165 m granite hall, Doric porticoes, copper rotunda ---
  const qh = 12.5;
  l.box(0, qh * 0.5, 0, 160, qh, 15, 0, 'granite', GRANITE);
  l.box(0, qh + 0.5, 0, 162, 1.0, 16.5, 0, 'trim_stone', [0.94, 0.93, 0.90]);
  for (let i = 0; i < 40; i++) {
    const x = -76 + (i / 39) * 152;
    for (const z of [-7.6, 7.6]) {
      l.pane(x - 1.4, z, x + 1.4, z, 2.0, 8.4, hash2(4410, i), 0.75, 3, [0.4, 0.38, 0.34], 4.0);
    }
    if (i % 3 === 0) {
      for (const z of [-8.4, 8.4]) {
        l.mb.quadAuto(l.p(x - 3.4, 9.4, z * 0.94), l.p(x + 3.4, 9.4, z * 0.94),
          l.p(x + 3.4, 8.5, z * 1.28), l.p(x - 3.4, 8.5, z * 1.28),
          0, 0.7, Math.sign(z) * 0.6, [0, 0, 6.8, 0, 6.8, 1.4, 0, 1.4],
          [1, 1, 1], 'awning');
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      l.column(sx * 82, -6 + i * 4, 1.0, 0, 11.5, 'granite', GRANITE);
      l.column(sx * 86.5, -6 + i * 4, 1.0, 0, 11.5, 'granite', GRANITE);
    }
    l.box(sx * 84, 12.4, 0, 11, 1.9, 17, 0, 'granite', GRANITE);
    l.gable(sx * 84 - 5.5, sx * 84 + 5.5, -8.5, 8.5, 13.4, 3.4, 'granite', GRANITE);
  }
  // rotunda
  l.taper(0, 0, 11.5, 11.0, qh, qh + 5.5, 16, 'granite', GRANITE, 0, false);
  l.dome(0, 0, 11.0, qh + 5.5, 9.0, 18, 6, 'copper', [0.92, 1.02, 0.96]);
  l.taper(0, 0, 1.6, 1.4, qh + 14.5, qh + 17.5, 8, 'copper', [0.92, 1.02, 0.96]);

  // --- North & South Market: 4-storey granite ranges either side ---
  for (const sz of [-1, 1]) {
    l.box(0, 9, sz * 30, 150, 18, 15, 0, 'granite', [0.94, 0.93, 0.92]);
    l.box(0, 18.4, sz * 30, 152, 1.0, 16.4, 0, 'trim_stone', WHITE);
    for (let f = 0; f < 3; f++) for (let i = 0; i < 34; i++) {
      const x = -72 + (i / 33) * 144;
      const y = 4.4 + f * 4.3;
      const z = sz * (30 - sz * 7.55);
      l.pane(x - 0.9, z, x + 0.9, z, y, y + 2.7, hash2(4420 + f, i), 0.4, 1,
        [0.92, 0.91, 0.88], 2.4);
    }
    for (let i = 0; i < 20; i++) {
      const x = -70 + (i / 19) * 140;
      l.pane(x - 2.6, sz * 22.4, x + 2.6, sz * 22.4, 0.6, 3.6, hash2(4425, i), 0.8, 3,
        [0.35, 0.33, 0.30], 4.0);
    }
    l.roofKit(0, sz * 30, 120, 10, 18.4, 4430 + sz, true);
  }
  l.roofKit(-96, 0, 22, 10, 17.6, 4440);
}

/** Trinity Church — Richardsonian Romanesque, massive central tower. */
function trinity(l) {
  const S = 'brownstone_rus';
  const C = [0.86, 0.72, 0.62];
  const T = [0.98, 0.94, 0.88];
  // nave and transepts
  l.box(0, 9, 0, 46, 18, 20, 0, S, C);
  l.box(0, 9, 0, 20, 18, 42, 0, S, C);
  l.gable(-23, 23, -10, 10, 18, 5.5, 'slate', [0.92, 0.94, 0.96]);
  // central tower
  const tw = 9.6;
  const tower = [{ x: -tw, z: -tw }, { x: tw, z: -tw }, { x: tw, z: tw }, { x: -tw, z: tw }];
  l.prism(tower, 0, 41, S, C, false);
  for (let i = 0; i < 4; i++) {
    const a = tower[i], b = tower[(i + 1) % 4];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    // corner turrets
    l.taper(a.x * 1.06, a.z * 1.06, 1.7, 1.5, 0, 45, 8, S, C, 0, false);
    l.taper(a.x * 1.06, a.z * 1.06, 2.0, 0.1, 45, 50, 8, 'slate', [0.92, 0.94, 0.96]);
    // arcaded belfry openings
    for (let k = 0; k < 3; k++) {
      const t = (k + 0.5) / 3;
      const px = a.x + dx * t + (dz / L) * 0.12, pz = a.z + dz * t - (dx / L) * 0.12;
      l.pane(px - (dx / L) * 1.5, pz - (dz / L) * 1.5, px + (dx / L) * 1.5, pz + (dz / L) * 1.5,
        30, 38, hash2(4500, k * 4 + i), 0.25, 1, [0.3, 0.28, 0.24], 3.0);
      l.box(px, 39.2, pz, 3.6, 1.0, 0.5, ang, 'trim_stone', T);
    }
    // string courses in pale stone — the polychromy
    for (const y of [10.5, 20.5, 28.5]) {
      l.box((a.x + b.x) * 0.5 + (dz / L) * 0.22, y, (a.z + b.z) * 0.5 - (dx / L) * 0.22,
        L, 0.7, 0.5, ang, 'trim_stone', T);
    }
  }
  l.box(0, 42, 0, tw * 2 + 2.4, 2.0, tw * 2 + 2.4, 0, 'trim_stone', T);
  l.taper(0, 0, tw + 1.0, 0.4, 43, 62, 4, 'slate', [0.92, 0.94, 0.96], Math.PI / 4);
  l.box(0, 63.6, 0, 0.4, 3.2, 0.4, 0, 'gold', [1, 0.95, 0.85]);
  // west porch with round arches
  l.box(0, 6.5, -24, 24, 13, 9, 0, S, C);
  for (let i = 0; i < 5; i++) {
    const x = -9 + (i / 4) * 18;
    l.column(x, -28.4, 0.85, 0, 8.0, 'trim_stone', T);
  }
  l.box(0, 13.6, -24, 25, 1.2, 10, 0, 'trim_stone', T);
  // rose window
  l.pane(-5, -10.02, 5, -10.02, 10, 17, 4501, 0.2, 1, [0.55, 0.45, 0.35], 2.0);
  for (let i = 0; i < 20; i++) {
    const x = -14 + (i % 10) * 3.1;
    const y = 5 + Math.floor(i / 10) * 7;
    l.pane(x - 0.9, 10.02, x + 0.9, 10.02, y, y + 4.4, hash2(4502, i), 0.2, 1,
      [0.5, 0.42, 0.34], 2.4);
  }
}

/** Boston Public Library, McKim building — the Copley Square arcade. */
function bpl(l) {
  const G = [0.97, 0.96, 0.93];
  l.box(0, 12.5, 0, 68, 25, 60, 0, 'granite', G);
  l.box(0, 25.6, 0, 69.5, 1.4, 61.5, 0, 'trim_stone', WHITE);
  l.cap([{ x: -34, z: -30 }, { x: 34, z: -30 }, { x: 34, z: 30 }, { x: -34, z: 30 }],
    26.3, 'roof_gravel', CONC, true);
  // the 13-bay arcade on the Dartmouth Street front
  for (let i = 0; i < 13; i++) {
    const x = -30 + (i / 12) * 60;
    l.pane(x - 1.8, -30.05, x + 1.8, -30.05, 10.5, 21.5, hash2(4600, i), 0.35, 1,
      [0.90, 0.88, 0.84], 3.2);
    // arch head
    for (let k = 0; k < 5; k++) {
      const a0 = Math.PI * (k / 5), a1 = Math.PI * ((k + 1) / 5);
      l.mb.quadAuto(
        l.p(x + Math.cos(a0) * 2.1, 21.5 + Math.sin(a0) * 2.1, -30.35),
        l.p(x + Math.cos(a1) * 2.1, 21.5 + Math.sin(a1) * 2.1, -30.35),
        l.p(x + Math.cos(a1) * 2.9, 21.5 + Math.sin(a1) * 2.9, -30.35),
        l.p(x + Math.cos(a0) * 2.9, 21.5 + Math.sin(a0) * 2.9, -30.35),
        -l.s, 0, -l.c, [0, 0, 1, 0, 1, 1, 0, 1], WHITE, 'trim_stone');
    }
    l.box(x, 9.6, -30.2, 4.6, 0.7, 0.7, 0, 'trim_stone', WHITE);
    // small square windows in the plinth
    l.pane(x - 1.2, -30.05, x + 1.2, -30.05, 4.2, 7.4, hash2(4601, i), 0.3, 1,
      [0.88, 0.86, 0.82], 2.2);
  }
  l.box(0, 8.0, -30.4, 68, 0.9, 1.0, 0, 'trim_stone', WHITE);
  l.box(0, 23.0, -30.4, 68, 0.8, 0.9, 0, 'trim_stone', WHITE);
  // side elevations get the same rhythm, cheaper
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      const z = -25 + (i / 10) * 50;
      l.pane(sx * 34.05, z - 1.6, sx * 34.05, z + 1.6, 10.5, 21.0, hash2(4602, i), 0.3, 1,
        [0.90, 0.88, 0.84], 3.0);
    }
  }
  l.roofKit(0, 6, 50, 44, 26.3, 4603, true);
}

/** Fenway Park — the Green Monster, the grandstand and the light towers. */
function fenwayPark(l) {
  const GREEN = [0.95, 1.05, 0.95];
  // playing field
  l.cap([{ x: -58, z: -46 }, { x: 62, z: -46 }, { x: 62, z: 58 }, { x: -58, z: 58 }],
    0.05, 'paint_green', [0.72, 0.92, 0.66], true);
  l.cap([{ x: -6, z: 26 }, { x: 26, z: 26 }, { x: 26, z: 54 }, { x: -6, z: 54 }],
    0.10, 'brick_brown', [1.0, 0.86, 0.68], true);

  // --- The Green Monster: 11.3 m, left field ---
  const mz = -46;
  l.box(0, 5.65, mz, 116, 11.3, 1.2, 0, 'paint_green', GREEN);
  // manual scoreboard
  l.box(-24, 3.0, mz - 0.7, 26, 4.2, 0.4, 0, 'metal_dark', [0.22, 0.30, 0.24]);
  for (let i = 0; i < 12; i++) {
    l.box(-36 + i * 2.1, 3.4, mz - 0.95, 1.5, 1.4, 0.12, 0, 'sign', [1, 1, 0.94], 0.5);
  }
  // ladder, and the netting posts on top
  l.box(14, 6.0, mz - 0.75, 0.7, 10.0, 0.18, 0, 'metal_dark', [0.3, 0.36, 0.3]);
  for (let i = 0; i < 14; i++) {
    l.box(-56 + i * 8.6, 12.6, mz, 0.22, 2.6, 0.22, 0, 'metal_dark', [0.25, 0.3, 0.26]);
  }
  l.box(0, 11.6, mz - 0.1, 116, 0.5, 1.5, 0, 'metal_dark', [0.2, 0.26, 0.22]);
  // the Monster seats
  l.box(0, 12.4, mz + 1.6, 116, 1.6, 3.4, 0, 'metal_dark', [0.3, 0.34, 0.3]);

  // --- Grandstand: a stepped bowl around the other three sides ---
  const bowl = (x0, x1, z0, z1, rows, dir) => {
    for (let r = 0; r < rows; r++) {
      const t = r / rows;
      const off = t * 13;
      const y = 1.5 + t * 13;
      if (dir === 'z+') l.box((x0 + x1) / 2, y, z1 + off, x1 - x0, 2.4, 3.0, 0,
        'concrete', [0.86, 0.86, 0.85]);
      else if (dir === 'x+') l.box(x1 + off, y, (z0 + z1) / 2, 3.0, 2.4, z1 - z0, 0,
        'concrete', [0.86, 0.86, 0.85]);
      else l.box(x0 - off, y, (z0 + z1) / 2, 3.0, 2.4, z1 - z0, 0,
        'concrete', [0.86, 0.86, 0.85]);
    }
  };
  bowl(-58, 62, -46, 58, 6, 'z+');
  bowl(-58, 62, -46, 58, 6, 'x+');
  bowl(-58, 62, -46, 58, 6, 'x-');
  // roof over the grandstand
  l.box(2, 22.0, 76, 124, 1.0, 26, 0, 'metal_dark', [0.42, 0.44, 0.44]);
  for (let i = 0; i < 12; i++) {
    l.box(-56 + i * 10.5, 12.0, 84, 0.6, 20, 0.6, 0, 'metal_dark', [0.4, 0.42, 0.42]);
  }
  // outer brick wall on Yawkey Way
  l.box(2, 8.0, 92, 128, 16, 2.0, 0, 'brick_red', [0.92, 0.82, 0.76]);
  for (let i = 0; i < 16; i++) {
    l.pane(-58 + i * 7.8, 90.95, -55 + i * 7.8, 90.95, 3.0, 7.0, hash2(4700, i), 0.5, 3,
      [0.35, 0.33, 0.30], 3.6);
  }
  l.box(2, 16.6, 92, 130, 1.2, 3.0, 0, 'trim_stone', [0.9, 0.88, 0.84]);

  // --- Light towers ---
  for (const [tx, tz] of [[-52, -40], [-14, -44], [30, 78], [-40, 80], [66, 20]]) {
    l.box(tx, 16, tz, 1.2, 32, 1.2, 0, 'metal_dark', [0.4, 0.42, 0.44]);
    for (let r = 0; r < 3; r++) {
      l.box(tx, 30 + r * 3.0, tz, 9.0, 0.5, 1.4, 0, 'metal_dark', [0.35, 0.37, 0.38]);
      for (let i = 0; i < 7; i++) {
        l.box(tx - 3.8 + i * 1.28, 30 + r * 3.0, tz - 0.5, 0.9, 0.9, 0.5, 0,
          'sign', [1, 0.98, 0.90], 0.9);
      }
    }
  }
  // foul poles
  for (const [px, pz] of [[-56, -44], [62, 50]]) {
    l.box(px, 12, pz, 0.5, 24, 0.5, 0, 'sign', [1, 0.45, 0.1], 0.4);
  }
}

/** The Citgo sign at Kenmore Square — 18 m of animated neon on a roof. */
function citgo(l) {
  // host building
  l.box(0, 10, 0, 34, 20, 22, 0, 'brick_dark', [0.86, 0.80, 0.76]);
  l.box(0, 20.4, 0, 35, 0.9, 23, 0, 'trim_stone', [0.88, 0.86, 0.82]);
  for (let f = 0; f < 5; f++) for (let i = 0; i < 8; i++) {
    l.pane(-13 + i * 3.6, -11.05, -11 + i * 3.6, -11.05, 3 + f * 3.6, 5.4 + f * 3.6,
      hash2(4800 + f, i), 0.45, 1, [0.9, 0.88, 0.84], 2.4);
  }
  l.roofKit(6, 4, 20, 14, 20.9, 4801);
  // sign frame
  for (const sx of [-9.5, 9.5]) {
    l.box(sx, 30, 0.6, 0.45, 19, 0.45, 0, 'metal_dark', [0.3, 0.3, 0.32]);
    l.box(sx, 21.5, 3.4, 0.35, 0.35, 6.0, 0, 'metal_dark', [0.3, 0.3, 0.32]);
  }
  for (let i = 0; i < 5; i++) {
    l.box(0, 21.6 + i * 4.6, 0.6, 20, 0.3, 0.3, 0, 'metal_dark', [0.3, 0.3, 0.32]);
  }
  // the sign face is its own emissive quad, added by the system
  l.signQuad = {
    p: [l.p(-9.2, 21.4, -0.02), l.p(9.2, 21.4, -0.02),
        l.p(9.2, 39.8, -0.02), l.p(-9.2, 39.8, -0.02)],
    p2: [l.p(9.2, 21.4, 0.02), l.p(-9.2, 21.4, 0.02),
         l.p(-9.2, 39.8, 0.02), l.p(9.2, 39.8, 0.02)],
  };
}

/** Zakim Bunker Hill Bridge — inverted-Y towers and fanned cable stays. */
function zakim(l) {
  const STEEL = [0.94, 0.95, 0.97];
  const deckY = 26, halfW = 27, len = 380;
  // deck
  l.box(0, deckY, 0, len, 2.2, halfW * 2, 0, 'concrete', CONC);
  l.box(0, deckY + 1.9, 0, len, 0.35, halfW * 2 + 1.2, 0, 'asphalt' in SURF
    ? 'asphalt' : 'concrete', [0.55, 0.55, 0.56]);
  for (const sz of [-1, 1]) {
    l.box(0, deckY + 2.7, sz * (halfW + 0.4), len, 1.3, 0.6, 0, 'concrete', CONC);
    for (let i = 0; i < 60; i++) {
      l.box(-len / 2 + i * (len / 59), deckY + 3.8, sz * (halfW + 0.4), 0.2, 1.0, 0.2, 0,
        'metal_dark', [0.4, 0.4, 0.42]);
    }
  }
  // two inverted-Y towers
  const towers = [-74, 74];
  for (const tx of towers) {
    const splay = halfW - 3;
    const yJoin = 52, yTop = 82;
    for (const sz of [-1, 1]) {
      // leg: from the deck edge in to the centre line
      const x0 = tx, z0 = sz * splay, z1 = 0;
      const segs = 5;
      for (let k = 0; k < segs; k++) {
        const t0 = k / segs, t1 = (k + 1) / segs;
        const za = z0 + (z1 - z0) * t0, zb = z0 + (z1 - z0) * t1;
        const ya = 2 + (yJoin - 2) * t0, yb = 2 + (yJoin - 2) * t1;
        const w0 = 4.6 - t0 * 1.4, w1 = 4.6 - t1 * 1.4;
        l.mb.quadAuto(l.p(x0 - w0 / 2, ya, za), l.p(x0 + w0 / 2, ya, za),
          l.p(x0 + w1 / 2, yb, zb), l.p(x0 - w1 / 2, yb, zb),
          0, 0, sz, [0, 0, 3, 0, 3, 3, 0, 3], STEEL, 'concrete');
        l.mb.quadAuto(l.p(x0 - w0 / 2, ya, za), l.p(x0 - w1 / 2, yb, zb),
          l.p(x0 - w1 / 2, yb, zb), l.p(x0 - w0 / 2, ya, za), -1, 0, 0,
          [0, 0, 3, 0, 3, 3, 0, 3], STEEL, 'concrete');
        l.box(x0, (ya + yb) / 2, (za + zb) / 2, w0, Math.hypot(yb - ya, zb - za) * 1.02,
          3.6, 0, 'concrete', STEEL);
      }
    }
    // mast above the join
    l.taper(tx, 0, 2.4, 1.5, yJoin, yTop, 4, 'concrete', STEEL, Math.PI / 4);
    l.box(tx, yTop + 1.0, 0, 1.4, 1.2, 1.4, 0, 'sign', [1, 0.3, 0.25], 2.4);
    // cable fan
    for (let i = 0; i < 11; i++) {
      const t = i / 10;
      const ay = yJoin + 3 + t * (yTop - yJoin - 6);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const bx = tx + sx * (16 + t * 105);
        const bz = sz * (halfW - 2);
        const mx = (tx + bx) / 2, mz = bz / 2, my = (ay + deckY + 2) / 2;
        const dx = bx - tx, dz = bz - 0, dy = deckY + 2 - ay;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // thin box aligned to the cable, rotated in the XZ plane and tilted by
        // stretching along its length
        const yaw = Math.atan2(dx, dz);
        l.box(mx, my, mz, 0.22, L * Math.abs(dy) / L + 0.0, 0.22, yaw,
          'metal_dark', [0.85, 0.86, 0.88]);
        l.cableQuads = l.cableQuads || [];
        l.cableQuads.push([l.p(tx, ay, 0), l.p(bx, deckY + 2.2, bz)]);
      }
    }
  }
  // approach piers
  for (const px of [-165, -120, 120, 165]) {
    l.box(px, deckY / 2, 0, 5, deckY, 12, 0, 'concrete', CONC);
  }
}

/** Old North Church — brick body, white tiered steeple. */
function oldNorth(l, h) {
  l.box(0, 8, 0, 17, 16, 26, 0, 'brick_red', [0.94, 0.86, 0.80]);
  l.gable(-8.5, 8.5, -13, 13, 16, 4.0, 'slate', [0.93, 0.95, 0.97]);
  for (let f = 0; f < 2; f++) for (let i = 0; i < 5; i++) {
    const z = -10 + (i / 4) * 20;
    for (const sx of [-8.55, 8.55]) {
      l.pane(sx, z - 1.1, sx, z + 1.1, 3 + f * 6.5, 7.6 + f * 6.5, hash2(4900 + f, i), 0.3, 0,
        [0.95, 0.94, 0.90], 2.6);
    }
  }
  // tower + steeple
  const tz = -15.5;
  l.box(0, 11, tz, 10.5, 22, 10.5, 0, 'brick_red', [0.94, 0.86, 0.80]);
  l.box(0, 22.6, tz, 11.6, 1.4, 11.6, 0, 'wood_white', WHITE);
  l.box(0, 27.5, tz, 9.0, 8.8, 9.0, 0, 'wood_white', WHITE);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    void a;
  }
  for (const [dx, dz] of [[0, -4.6], [0, 4.6], [-4.6, 0], [4.6, 0]]) {
    l.pane(dx - (dz ? 1.6 : 0), tz + dz - (dx ? 1.6 : 0),
      dx + (dz ? 1.6 : 0), tz + dz + (dx ? 1.6 : 0), 24.5, 30.5, hash2(4901, dx + dz),
      0.9, 1, [1, 0.94, 0.82], 2.0);
  }
  l.box(0, 32.4, tz, 10.0, 1.0, 10.0, 0, 'wood_white', WHITE);
  l.taper(0, tz, 4.0, 3.2, 32.9, 39.0, 8, 'wood_white', WHITE, 0, false);
  l.box(0, 39.6, tz, 7.2, 1.0, 7.2, 0, 'wood_white', WHITE);
  l.taper(0, tz, 2.8, 2.2, 40.1, 44.0, 8, 'wood_white', WHITE, 0, false);
  l.taper(0, tz, 2.6, 0.16, 44.0, h - 2.4, 8, 'wood_white', WHITE);
  l.box(0, h - 1.2, tz, 0.12, 2.4, 0.12, 0, 'gold', [1, 0.95, 0.85]);
  l.box(0, h - 0.3, tz, 1.3, 0.6, 0.1, 0, 'gold', [1, 0.95, 0.85], 0.15);
}

/** Bunker Hill Monument — 67 m granite obelisk. */
function bunkerHill(l, h) {
  l.box(0, 1.0, 0, 26, 2.0, 26, 0, 'granite', [0.94, 0.94, 0.92]);
  l.box(0, 2.9, 0, 15, 1.9, 15, 0, 'granite', GRANITE);
  l.taper(0, 0, 6.65, 3.25, 3.85, h - 5.5, 4, 'granite', GRANITE, Math.PI / 4, false);
  l.taper(0, 0, 3.25, 0.25, h - 5.5, h, 4, 'granite', GRANITE, Math.PI / 4);
  // the small lodge at the base
  l.box(-22, 4, 0, 14, 8, 11, 0, 'granite', [0.93, 0.93, 0.91]);
  l.gable(-29, -15, -5.5, 5.5, 8, 2.6, 'slate', [0.92, 0.94, 0.96]);
}

/** TD Garden — arena box with a curved roof and a signed west facade. */
function tdGarden() { /* handled by arena() */ }
function arena(l) {
  const w = 78, d = 62, h = 34;
  const plan = [
    { x: -w, z: -d + 12 }, { x: -w + 12, z: -d }, { x: w - 12, z: -d }, { x: w, z: -d + 12 },
    { x: w, z: d - 12 }, { x: w - 12, z: d }, { x: -w + 12, z: d }, { x: -w, z: d - 12 },
  ];
  l.prism(plan, 0, h, 'brick_dark', [0.88, 0.82, 0.78], false);
  l.prism(plan.map(p => ({ x: p.x * 0.985, z: p.z * 0.985 })), h, h + 2.2,
    'metal_panel', [0.82, 0.84, 0.86], false);
  // curved roof, approximated with 7 stepped bands
  for (let i = 0; i < 7; i++) {
    const t = i / 7, t2 = (i + 1) / 7;
    const s0 = 1 - t * 0.9, s1 = 1 - t2 * 0.9;
    const y0 = h + 2.2 + Math.sin(t * Math.PI * 0.5) * 12;
    const y1 = h + 2.2 + Math.sin(t2 * Math.PI * 0.5) * 12;
    const p0 = plan.map(p => ({ x: p.x * s0, z: p.z * s0 }));
    const p1 = plan.map(p => ({ x: p.x * s1, z: p.z * s1 }));
    for (let k = 0; k < plan.length; k++) {
      const a = p0[k], b = p0[(k + 1) % plan.length];
      const c = p1[(k + 1) % plan.length], e = p1[k];
      l.mb.quadAuto(l.p(a.x, y0, a.z), l.p(b.x, y0, b.z), l.p(c.x, y1, c.z), l.p(e.x, y1, e.z),
        (a.z - b.z), 0.5, -(a.x - b.x), [0, 0, 8, 0, 8, 3, 0, 3],
        [0.86, 0.88, 0.90], 'metal_panel');
    }
  }
  l.cap(plan.map(p => ({ x: p.x * 0.1, z: p.z * 0.1 })), h + 14.4, 'roof_gravel', CONC, true);
  // glazed west entry + signage band
  for (let i = 0; i < 8; i++) {
    const x = -60 + (i / 7) * 120;
    l.pane(x - 6.5, -d - 0.05, x + 6.5, -d - 0.05, 3, 22, hash2(5000, i), 0.7, 5,
      [0.3, 0.32, 0.34], 5.0);
  }
  l.box(0, 26.5, -d - 0.4, 60, 5.0, 0.8, 0, 'sign', [1, 1, 1], 1.4);
  l.roofKit(0, 0, 40, 30, h + 14.4, 5001, true);
}

/** South Station — granite classical head house with the curved corner clock. */
function southStation(l) {
  const G = [0.95, 0.95, 0.93];
  l.box(-30, 14, 0, 60, 28, 34, 0, 'granite', G);
  l.box(38, 14, 6, 44, 28, 46, 0, 'granite', G);
  // curved corner
  for (let i = 0; i < 8; i++) {
    const a0 = Math.PI * (0.5 + i / 16), a1 = Math.PI * (0.5 + (i + 1) / 16);
    const R = 22;
    const x0 = 6 + Math.cos(a0) * R, z0 = -17 + R - Math.sin(a0) * R;
    const x1 = 6 + Math.cos(a1) * R, z1 = -17 + R - Math.sin(a1) * R;
    l.wall(x0, z0, x1, z1, 0, 28, 'granite', G, i * 4, 0);
  }
  l.box(4, 29.4, -8, 96, 2.8, 62, 0, 'trim_stone', WHITE);
  // colonnade
  for (let i = 0; i < 6; i++) {
    l.column(-8 - i * 8.5, -17.6, 1.15, 6, 20, 'granite', G);
  }
  for (let i = 0; i < 24; i++) {
    const x = -56 + i * 4.0;
    l.pane(x - 1.2, -17.05, x + 1.2, -17.05, 8, 20, hash2(5100, i), 0.5, 1,
      [0.9, 0.89, 0.86], 3.0);
  }
  for (let i = 0; i < 9; i++) {
    l.pane(-56 + i * 6.6, -17.05, -53 + i * 6.6, -17.05, 1.0, 5.5, hash2(5101, i), 0.85, 3,
      [0.32, 0.30, 0.28], 4.0);
  }
  // clock and eagle over the corner
  l.box(6, 26.5, -16.5, 6.4, 6.4, 0.5, 0, 'sign', [1, 0.97, 0.88], 1.4);
  l.box(6, 26.5, -16.9, 7.2, 7.2, 0.4, 0, 'trim_stone', WHITE);
  l.box(6, 33.0, -14, 4.0, 3.4, 3.0, 0, 'trim_stone', WHITE);
  // train shed behind
  l.box(40, 9, 52, 84, 18, 60, 0, 'metal_panel', [0.80, 0.82, 0.84]);
  for (let i = 0; i < 9; i++) {
    l.box(4 + i * 9, 19.5, 52, 1.0, 3.0, 60, 0, 'metal_dark', [0.4, 0.42, 0.44]);
  }
  l.roofKit(-30, 0, 45, 25, 30.8, 5102, true);
}

/** Boston City Hall — the brutalist inverted ziggurat on its brick plinth. */
function cityHall(l) {
  const P = [0.90, 0.88, 0.86];
  // brick plinth
  l.box(0, 5, 0, 92, 10, 74, 0, 'brick_red', [0.86, 0.76, 0.70]);
  l.box(0, 10.3, 0, 93, 0.7, 75, 0, 'concrete', CONC);
  // concrete lower floors, recessed
  l.box(0, 16, 0, 80, 12, 62, 0, 'concrete', P);
  for (let i = 0; i < 18; i++) {
    const x = -37 + (i / 17) * 74;
    for (const sz of [-31.1, 31.1]) {
      l.pane(x - 1.6, sz, x + 1.6, sz, 12, 20, hash2(5200, i), 0.55, 2,
        [0.4, 0.4, 0.4], 4.0);
    }
  }
  // three cantilevered upper floors, each stepping OUT — the whole point
  for (let f = 0; f < 3; f++) {
    const y0 = 22 + f * 7.0, y1 = y0 + 7.0;
    const ex = 42 + f * 3.4, ez = 33 + f * 3.0;
    l.box(0, (y0 + y1) / 2, 0, ex * 2, 7.0, ez * 2, 0, 'concrete', P);
    // deep coffered fins — the facade is nothing but these
    const n = 30;
    for (let i = 0; i < n; i++) {
      const x = -ex + 1.2 + (i / (n - 1)) * (ex * 2 - 2.4);
      for (const sz of [-1, 1]) {
        l.box(x, (y0 + y1) / 2, sz * (ez + 0.9), 0.9, 6.4, 1.8, 0, 'concrete',
          [0.96, 0.96, 0.94]);
      }
    }
    const m = 22;
    for (let i = 0; i < m; i++) {
      const z = -ez + 1.2 + (i / (m - 1)) * (ez * 2 - 2.4);
      for (const sx of [-1, 1]) {
        l.box(sx * (ex + 0.9), (y0 + y1) / 2, z, 1.8, 6.4, 0.9, 0, 'concrete',
          [0.96, 0.96, 0.94]);
      }
    }
    // recessed glazing behind the fins
    for (const sz of [-1, 1]) {
      l.pane(-ex + 1, sz * ez, ex - 1, sz * ez, y0 + 0.7, y1 - 0.9,
        hash2(5210, f * 3 + sz), 0.5, 5, [0.28, 0.28, 0.28], 4.5);
    }
  }
  const top = 43;
  l.box(0, top + 0.6, 0, 100, 1.2, 82, 0, 'concrete', P);
  l.roofKit(0, 0, 70, 55, top + 1.2, 5211, true);
}

/** USS Constitution at the Charlestown Navy Yard. */
function constitution(l) {
  const HULL = [0.30, 0.28, 0.27];
  const L = 62, B = 6.8;
  // hull: tapered box sections
  const secs = 9;
  for (let i = 0; i < secs; i++) {
    const t0 = i / secs, t1 = (i + 1) / secs;
    const w0 = Math.sin(Math.PI * Math.min(1, t0 * 1.05)) ** 0.55 * B;
    const w1 = Math.sin(Math.PI * Math.min(1, t1 * 1.05)) ** 0.55 * B;
    const x0 = -L / 2 + t0 * L, x1 = -L / 2 + t1 * L;
    for (const sz of [-1, 1]) {
      l.mb.quadAuto(l.p(x0, -1.5, sz * w0 * 0.6), l.p(x1, -1.5, sz * w1 * 0.6),
        l.p(x1, 4.2, sz * w1), l.p(x0, 4.2, sz * w0),
        0, 0.2, sz, [0, 0, 6, 0, 6, 3, 0, 3], HULL, 'wood_dark');
      // the white gun stripe
      l.mb.quadAuto(l.p(x0, 2.9, sz * (w0 + 0.02)), l.p(x1, 2.9, sz * (w1 + 0.02)),
        l.p(x1, 3.9, sz * (w1 + 0.02)), l.p(x0, 3.9, sz * (w0 + 0.02)),
        0, 0, sz, [0, 0, 6, 0, 6, 0.6, 0, 0.6], [0.95, 0.94, 0.90], 'wood_white');
      // gun ports
      for (let g = 0; g < 3; g++) {
        l.box(x0 + (x1 - x0) * (0.2 + g * 0.3), 3.4, sz * (w0 + 0.05), 0.7, 0.7, 0.06, 0,
          'wood_dark', [0.1, 0.09, 0.08]);
      }
    }
  }
  l.cap([{ x: -L / 2, z: -B * 0.75 }, { x: L / 2, z: -B * 0.75 },
    { x: L / 2, z: B * 0.75 }, { x: -L / 2, z: B * 0.75 }], 4.2, 'wood_dark',
    [0.72, 0.60, 0.44], true);
  l.box(0, 5.4, 0, 26, 2.4, 8.4, 0, 'wood_dark', [0.68, 0.56, 0.42]);
  // three masts with yards, plus bowsprit
  const masts = [[-18, 46], [1, 54], [19, 44]];
  for (const [mx, mh] of masts) {
    l.taper(mx, 0, 0.55, 0.16, 4.2, mh, 8, 'wood_dark', [0.62, 0.50, 0.36]);
    for (let y = 0; y < 4; y++) {
      const yy = 12 + y * (mh - 16) / 3.4;
      const half = (16 - y * 2.6) * 0.5;
      l.box(mx, yy, 0, 0.34, 0.34, half * 2, 0, 'wood_dark', [0.58, 0.47, 0.34]);
      // furled sail suggestion
      l.box(mx, yy - 0.5, 0, 0.7, 0.7, half * 1.8, 0, 'wood_white', [0.86, 0.84, 0.78]);
    }
  }
  l.box(-L / 2 - 5, 6.5, 0, 14, 0.5, 0.5, 0, 'wood_dark', [0.6, 0.49, 0.35], 0);
  // pier
  l.box(0, -0.4, 16, L + 20, 1.6, 16, 0, 'wood_dark', [0.52, 0.46, 0.40]);
}

/** Old State House — small, brick, gambrel, gilded lion and unicorn. */
function oldState(l) {
  l.box(0, 8, 0, 26, 16, 12, 0, 'brick_red', [0.93, 0.85, 0.79]);
  l.gable(-13, 13, -6, 6, 16, 3.2, 'slate', [0.92, 0.94, 0.96]);
  for (let f = 0; f < 2; f++) for (let i = 0; i < 6; i++) {
    const x = -10 + (i / 5) * 20;
    for (const z of [-6.05, 6.05]) {
      l.pane(x - 0.9, z, x + 0.9, z, 3.5 + f * 5.6, 6.9 + f * 5.6, hash2(5300 + f, i), 0.4, 0,
        [0.95, 0.94, 0.90], 2.2);
      l.box(x, 3.28 + f * 5.6, z, 2.4, 0.18, 0.18, 0, 'trim_stone', WHITE);
    }
  }
  // east gable with the lion & unicorn
  l.box(-11.5, 17.8, -5, 1.6, 1.6, 1.2, 0, 'gold', [1, 0.95, 0.85], 0.15);
  l.box(11.5, 17.8, -5, 1.6, 1.6, 1.2, 0, 'gold', [1, 0.95, 0.85], 0.15);
  // tower with clock and cupola
  l.box(9, 20, 0, 6.4, 8, 6.4, 0, 'wood_white', WHITE);
  l.box(9, 22.5, -3.25, 3.4, 3.4, 0.3, 0, 'sign', [1, 0.97, 0.88], 1.2);
  l.taper(9, 0, 2.8, 2.2, 24.2, 27.5, 8, 'wood_white', WHITE, 0, false);
  l.taper(9, 0, 2.4, 0.14, 27.5, 31.5, 8, 'wood_white', WHITE);
}

/**
 * Generic Financial District tower, parameterised. Gives the skyline the mass
 * it needs around the individually-modelled landmarks.
 */
function genericTower(l, h, seed, glassy) {
  const r = (k) => hash2(seed, k);
  const hw = 16 + r(1) * 11, hd = 13 + r(2) * 9;
  const ch = 3 + r(3) * 4;
  const plan = [
    { x: -hw + ch, z: -hd }, { x: hw - ch, z: -hd }, { x: hw, z: -hd + ch },
    { x: hw, z: hd - ch }, { x: hw - ch, z: hd }, { x: -hw + ch, z: hd },
    { x: -hw, z: hd - ch }, { x: -hw, z: -hd + ch },
  ];
  const base = 7 + r(4) * 4;
  const surf = glassy ? 'metal_panel' : (r(5) < 0.5 ? 'limestone' : 'granite');
  const col = glassy ? [0.86, 0.88, 0.92] : [0.98, 0.97, 0.94];
  l.prism(plan, 0, base, 'granite', GRANITE, false);
  l.curtain(plan, 1.5, base - 1.5, seed + 11, 0.8, [0.3, 0.3, 0.32]);

  let y = base;
  let p = plan;
  const stages = glassy ? 1 : 2 + Math.floor(r(6) * 2);
  for (let s = 0; s < stages; s++) {
    const y1 = s === stages - 1 ? h : y + (h - base) * (0.42 + r(10 + s) * 0.22);
    l.prism(p, y, y1, surf, col, false);
    l.curtain(p, y + 1.0, y1 - 1.0, seed + s * 31, 0.34, glassy
      ? [0.3, 0.32, 0.34] : [0.7, 0.7, 0.68]);
    if (!glassy) {
      // pier articulation
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
        const n = Math.max(1, Math.round(L / 3.2));
        const ang = Math.atan2(dx, dz);
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          l.box(a.x + dx * t + (dz / L) * 0.28, (y + y1) * 0.5, a.z + dz * t - (dx / L) * 0.28,
            0.9, y1 - y, 0.65, ang, surf, col);
        }
      }
    }
    if (s < stages - 1) {
      l.cap(p, y1, 'roof_gravel', CONC, true);
      const ins = 1.8 + r(20 + s) * 2.4;
      const cc = { x: 0, z: 0 };
      p = p.map(q => {
        const dx = q.x - cc.x, dz = q.z - cc.z, L = Math.hypot(dx, dz) || 1;
        const k = Math.max(0.2, L - ins) / L;
        return { x: dx * k, z: dz * k };
      });
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const ang = Math.atan2(b.x - a.x, b.z - a.z);
        l.box((a.x + b.x) / 2, y1 + 0.9, (a.z + b.z) / 2,
          Math.hypot(b.x - a.x, b.z - a.z), 1.8, 0.8, ang, 'trim_stone', WHITE);
      }
    }
    y = y1;
  }
  l.prism(p, h, h + 1.6, surf, col, false);
  l.cap(p, h + 1.6, 'roof_gravel', CONC, true);
  l.roofKit(0, 0, hw * 1.2, hd * 1.2, h + 1.6, seed + 77, true);
  l.box(0, h + 5.5, 0, 8, 8, 8, 0, 'metal_panel', [0.84, 0.86, 0.88]);
  l.box(0, h + 12, 0, 0.5, 5, 0.5, 0, 'metal_dark', [0.45, 0.45, 0.47]);
  l.box(0, h + 14.6, 0, 0.8, 0.7, 0.8, 0, 'sign', [1, 0.28, 0.22], 2.6);
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

const BUILDERS = {
  hancock: (l, d) => hancock(l, d.h),
  prudential: (l, d) => prudential(l, d.h),
  stateHouse: (l) => stateHouse(l),
  customHouse: (l, d) => customHouse(l, d.h),
  faneuil: (l) => faneuil(l),
  trinity: (l) => trinity(l),
  bpl: (l) => bpl(l),
  fenway: (l) => fenwayPark(l),
  citgo: (l) => citgo(l),
  zakim: (l) => zakim(l),
  oldNorth: (l, d) => oldNorth(l, d.h),
  bunkerHill: (l, d) => bunkerHill(l, d.h),
  tdGarden: (l) => arena(l),
  southStation: (l) => southStation(l),
  cityHall: (l) => cityHall(l),
  constitution: (l) => constitution(l),
  oldState: (l) => oldState(l),
  onePru: (l, d) => genericTower(l, d.h, 8801, false),
  federalSt: (l, d) => genericTower(l, d.h, 8802, false),
  intlPlace: (l, d) => genericTower(l, d.h, 8803, true),
};

export default class Landmarks {
  static id = 'landmarks';
  static label = 'Landmarks';
  static deps = ['assets'];

  constructor() {
    this.meshes = [];
    this.built = [];
    this.parts = [];
    this.body = null;
    this._neon = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = 'landmarks';
    ctx.scene.add(root);
    this.root = root;

    // Share the city's facade material so landmarks add no material churn.
    const b = ctx.get('buildings');
    if (b?.matOpaque && b?.matGlass) {
      this.matOpaque = b.matOpaque;
      this.matGlass = b.matGlass;
    } else {
      const assets = ctx.assets;
      const atlas = assets ? assets.texture('bk_atlas', () => {
        const a = buildAtlas(); this._atlas = a; return a.albedo;
      }) : null;
      void atlas;
      if (!this._atlas) this._atlas = buildAtlas();
      const rooms = assets ? assets.texture('bk_rooms', buildRoomAtlas) : buildRoomAtlas();
      const macro = assets ? assets.texture('bk_macro', buildMacroNoise) : buildMacroNoise();
      const mk = (k, fn) => (assets ? assets.material(k, fn) : fn());
      this.matOpaque = mk('building_facade',
        () => makeOpaqueMaterial(this._atlas, rooms, macro));
      this.matGlass = mk('building_glass', () => makeGlassMaterial(rooms));
    }

    const city = ctx.get('city');
    const groundAt = (city && typeof city.groundHeight === 'function')
      ? (x, z) => city.groundHeight(x, z) : () => 0;

    // Everything merges into one opaque and one glass mesh. Twenty landmarks
    // scattered across 6 km would otherwise be forty draw calls; merged they are
    // two, and 24k triangles is far too little to be worth culling individually.
    const mb = new MeshBuf(16384);
    const gb = new GlassBuf(4096);
    for (const d of LANDMARKS) {
      const fn = BUILDERS[d.id];
      if (!fn) continue;
      const p = geo(d.lat, d.lon);
      const y = groundAt(p.x, p.z);
      const l = new LM(mb, gb, p.x, y, p.z, d.rot || 0);
      // Where this landmark's triangles start in the shared opaque buffer.
      // `MeshBuf.build(false)` copies indices through 1:1 and leaves positions in
      // world space, so [i0, i1) slices the finished geometry exactly -- which is
      // what gives each landmark its own collider out of one merged mesh.
      const i0 = mb.ni;
      try {
        fn(l, d);
      } catch (e) {
        console.warn(`[landmarks] "${d.id}" failed to build:`, e);
        continue;
      }
      if (l.signQuad) this._makeCitgo(l.signQuad);
      if (l.cableQuads) this._makeCables(l.cableQuads);
      this.parts.push({ id: d.id, i0, i1: mb.ni });
      this.built.push(d.id);
    }

    let tris = 0;
    const go = mb.build();
    if (go) {
      const m = new THREE.Mesh(go, this.matOpaque);
      m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'landmarks_opaque';
      root.add(m); this.meshes.push(m);
      tris += go.index.count / 3;
      this._addColliders(ctx, go);
    }
    const gg = gb.build();
    if (gg) {
      const m = new THREE.Mesh(gg, this.matGlass);
      m.castShadow = false; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'landmarks_glass';
      root.add(m); this.meshes.push(m);
      tris += gg.index.count / 3;
    }

    console.info(`[landmarks] ${this.built.length} built, ${tris | 0} tris, ` +
      `${this.meshes.length} draws, ${(performance.now() - t0) | 0}ms`);
  }

  /**
   * One static trimesh collider per landmark, cut from the merged opaque mesh.
   *
   * Landmarks are individually modelled rather than generated, so there is no
   * footprint polygon to extrude the way `Buildings._addColliders` does -- and
   * `keepout` in `data/landmarks.js` is emphatically NOT one. That value is the
   * radius inside which the generic building generator must not place anything;
   * it reaches 150 m at Fenway and 128 m at Faneuil, and extruding it would wall
   * off whole blocks of open street. The rendered triangles are the only
   * description of a landmark's actual shape, so they are what collides.
   *
   * Using the geometry directly also means the shape is right for free: the open
   * side of Fenway's bowl, the span under the Zakim deck, Faneuil's colonnade and
   * every arch stay open because there are no triangles there to collide with.
   * No per-class special case is needed and none is used.
   *
   * Deliberately excluded, because they are separate meshes and never reach this
   * buffer: the Zakim cables (thin, and catching a player on a suspension cable
   * would be worse than passing through one) and the Citgo sign (a billboard on
   * a roof). The glass buffer is excluded too -- curtain walls are coincident
   * with the opaque shell they hang on, so they would only duplicate surfaces.
   */
  _addColliders(ctx, geom) {
    const p = ctx.physics;
    if (!p?.world || !this.parts.length) return;
    const R = p.RAPIER;
    const pos = geom.attributes.position.array;
    const idx = geom.index.array;
    const body = p.world.createRigidBody(R.RigidBodyDesc.fixed());
    const remap = new Map();
    let made = 0, tris = 0;
    for (const part of this.parts) {
      const n = part.i1 - part.i0;
      if (n < 12) continue;                     // 4 triangles is not a landmark
      // Compact this slice's vertices into their own buffer: Rapier wants a
      // self-contained mesh, and the merged one is 44k vertices wide.
      remap.clear();
      const verts = [];
      const tri = new Uint32Array(n);
      for (let k = 0; k < n; k++) {
        const vi = idx[part.i0 + k];
        let m = remap.get(vi);
        if (m === undefined) {
          m = verts.length / 3;
          remap.set(vi, m);
          verts.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        }
        tri[k] = m;
      }
      const cd = R.ColliderDesc.trimesh(new Float32Array(verts), tri)
        .setCollisionGroups(groups(GROUP.STATIC, 0xFFFF))
        .setFriction(0.9);
      p.world.createCollider(cd, body);
      made++; tris += n / 3;
    }
    if (made) { this.body = body; this.colliderTris = tris; }
    else { p.world.removeRigidBody(body); this.body = null; }
    console.info(`[landmarks] ${made} colliders, ${tris} collision tris`);
  }

  /** The Citgo sign: its own emissive quad with a procedural neon texture. */
  _makeCitgo(q) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#0a0d14'; g.fillRect(0, 0, 512, 512);
    // the red trimark triangle
    g.beginPath();
    g.moveTo(256, 60); g.lineTo(452, 400); g.lineTo(60, 400); g.closePath();
    g.fillStyle = '#e01a20'; g.fill();
    g.lineWidth = 14; g.strokeStyle = '#ff5a4a'; g.stroke();
    // the blue triangle inside
    g.beginPath();
    g.moveTo(256, 150); g.lineTo(372, 355); g.lineTo(140, 355); g.closePath();
    g.fillStyle = '#123a86'; g.fill();
    g.lineWidth = 8; g.strokeStyle = '#5aa0ff'; g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold 78px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('CITGO', 256, 330);
    g.strokeStyle = '#bfe0ff'; g.lineWidth = 3;
    g.strokeText('CITGO', 256, 330);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    const m = new THREE.MeshBasicMaterial({ map: t, toneMapped: false, side: THREE.DoubleSide });
    const geo2 = new THREE.BufferGeometry();
    const pts = [...q.p];
    const pos = new Float32Array([
      ...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3],
    ]);
    geo2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo2.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
    geo2.computeVertexNormals();
    geo2.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo2, m);
    mesh.matrixAutoUpdate = false;
    mesh.name = 'citgo_sign';
    this.root.add(mesh);
    this.meshes.push(mesh);
    this._neon = m;
  }

  /** Zakim cable stays as a single LineSegments-free thin-quad batch. */
  _makeCables(pairs) {
    const mb = new MeshBuf(512);
    for (const [a, b] of pairs) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1) continue;
      // billboard-ish ribbon: two crossed quads along the cable
      const px = -dz / Math.hypot(dx, dz) * 0.11, pz = dx / Math.hypot(dx, dz) * 0.11;
      mb.quadAuto([a[0] - px, a[1], a[2] - pz], [a[0] + px, a[1], a[2] + pz],
        [b[0] + px, b[1], b[2] + pz], [b[0] - px, b[1], b[2] - pz],
        0, 1, 0, [0, 0, 0.2, 0, 0.2, L / 2, 0, L / 2], [0.9, 0.91, 0.93], 'metal_dark');
      mb.quadAuto([a[0], a[1] - 0.11, a[2]], [a[0], a[1] + 0.11, a[2]],
        [b[0], b[1] + 0.11, b[2]], [b[0], b[1] - 0.11, b[2]],
        px, 0, pz, [0, 0, 0.2, 0, 0.2, L / 2, 0, L / 2], [0.9, 0.91, 0.93], 'metal_dark');
    }
    const g = mb.build();
    if (!g) return;
    const m = new THREE.Mesh(g, this.matOpaque);
    m.castShadow = false; m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    m.name = 'zakim_cables';
    this.root.add(m);
    this.meshes.push(m);
  }

  update(dt, ctx) {
    if (!this._neon) return;
    // The Citgo sign is a night landmark: it fades up at dusk and its neon
    // breathes rather than sitting at a dead constant.
    const tod = ctx.time.timeOfDay;
    const dawn = THREE.MathUtils.smoothstep(tod, 5.2, 6.8);
    const dusk = 1 - THREE.MathUtils.smoothstep(tod, 17.4, 19.2);
    const night = 1 - Math.min(dawn, dusk);
    const pulse = 0.90 + 0.10 * Math.sin(ctx.time.elapsed * 1.9);
    const k = 0.22 + night * 2.7 * pulse;
    this._neon.color.setRGB(k, k, k);
  }

  dispose() {
    for (const m of this.meshes) {
      this.root?.remove(m);
      m.geometry.dispose();
      if (m.material && m.material.map && m.material !== this.matOpaque
          && m.material !== this.matGlass) {
        m.material.map.dispose();
        m.material.dispose();
      }
    }
    this.meshes.length = 0;
    if (this.body) {
      this.ctx?.physics?.world?.removeRigidBody(this.body);
      this.body = null;
    }
    this.parts.length = 0;
    if (this.root) this.ctx?.scene.remove(this.root);
    void D2R; void tdGarden;
  }
}
