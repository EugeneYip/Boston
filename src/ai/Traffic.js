import * as THREE from 'three';
import Navigation, { MutablePath, Grid, Rng, GREEN, YELLOW, RED } from './Navigation.js';
import {
  VEHICLE_TYPES, VEHICLE_SPECS, createMaterialKit, buildVehicleVisual, getShellGeometry,
} from '../world/VehicleModels.js';

/**
 * Traffic.
 *
 * ## Why this is kinematic
 * The obvious implementation — spawn `vehicles.spawn()` for every car and drive it
 * with `setInput()` — was measured before it was written: **60 AI cars cost +21 ms
 * of CPU per frame** (3.3 ms -> 24.4 ms), against a whole-game CPU budget of about
 * 3 ms. Rapier's raycast-vehicle solve, CCD and tyre model are simply too expensive
 * to run a city's worth of. So the *simulation* here is arc-length along a baked
 * lane polyline, and the *presentation* borrows the vehicle agent's art: real
 * `VehicleVisual`s for the handful of cars near the camera, and an `InstancedMesh`
 * shell pool for everything else. A hundred cars cost about a third of a millisecond.
 *
 * Nothing is lost visually — the cars still squat under braking, roll into bends,
 * spin their wheels at the right rate, indicate, brake-light and run headlights at
 * dusk — and a great deal is gained: a kinematic car cannot fishtail into a
 * building, flip, or jitter against a kerb, which are the failure modes that make
 * physical AI traffic look worse than none at all.
 *
 * ## Behaviour
 * - Longitudinal: IDM (intelligent driver model) with per-driver aggression.
 * - Junctions: two-phase signals where the graph deserves them, single-slot
 *   reservations everywhere else, plus don't-block-the-box.
 * - Lateral: discretionary lane changes with a gap test, blended over ~2 s so the
 *   car slides across the line instead of teleporting.
 * - Boston: shorter headways, later braking, a fresh yellow gets taken.
 */

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const _pt = { x: 0, y: 0, z: 0, dx: 0, dz: 0, rotY: 0 };
const _pt2 = { x: 0, y: 0, z: 0, dx: 0, dz: 0, rotY: 0 };

const DESPAWN_R = 400;          // beyond this a car is recycled
const SPAWN_MIN = 70;           // never pop a car into existence closer than this
const SPAWN_MAX = 330;
const DETAIL_R = 82;            // articulated visuals only inside this radius
const LOD0_R = 26;
const SHADOW_R = 95;            // past this a shell stops casting a shadow

/**
 * Detail budget. These two numbers are the single biggest cost in the system
 * and they were set by measurement, not by taste: an articulated `VehicleVisual`
 * is roughly nineteen separate meshes at LOD0, none of which is frustum-culled
 * (`VehicleModels` culls the parent `Group`, and three does not cull Groups), and
 * most of them cast shadows into three cascades. Sixteen of them cost **600 draw
 * calls and 1.27M triangles** — more than the entire rest of the city put
 * together, which measured 335 draws and 2.2M triangles. Ten and three costs
 * about a third of that, and at street level the difference is invisible because
 * the cars that lose their articulation are the ones more than 80 m away.
 */
const MAX_LOD0 = 3;
const MAX_DETAIL = 10;
const SHELL_CAP = 72;
const SHELL_SHADOW_CAP = 28;
const LANE_CHANGE_TIME = 2.1;

/** Type mix. Boston is sedans, SUVs and far too many taxis. */
const MIX = [
  ['sedan', 26], ['suv', 20], ['taxi', 11], ['pickup', 9], ['van', 8],
  ['sports', 4], ['police', 3], ['truck', 5], ['bus', 3],
];

/**
 * Every car that is not close enough to deserve an articulated model is drawn
 * from here: two `InstancedMesh`es (paint and trim) per type, so any number of
 * cars costs a fixed handful of draws.
 *
 * There are two banks rather than one because shadow casting is the expensive
 * half. A car within ~95 m needs a shadow — the contact patch under a car is
 * most of what gives it weight — while one beyond that contributes a few pixels
 * of grey to a distant cascade for the same cost as one at your feet. So near
 * shells go in the casting bank and far shells in a bank that does not cast at
 * all, and the far bank is the one that holds most of the traffic.
 */
class ShellPool {
  constructor(type, kit, group, cap, shadowCap) {
    const { paint, trim } = getShellGeometry(type);
    this.group = group; this.meshes = [];
    this.nS = 0; this.nF = 0;
    this.capS = shadowCap; this.capF = cap;
    const mk = (geo, mat, n, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;             // instances span the whole streamed area
      m.castShadow = shadow;
      m.receiveShadow = false;
      m.count = 0;
      m.name = `traffic_shell_${type}_${shadow ? 'near' : 'far'}`;
      this.meshes.push(m); group.add(m);
      return m;
    };
    const paintMat = kit.paint(0xffffff);
    if (paint) {
      this.paintS = mk(paint, paintMat, shadowCap, true);
      this.paintF = mk(paint, paintMat, cap, false);
      this.paintS.setColorAt(0, _col.setHex(0xffffff));
      this.paintF.setColorAt(0, _col.setHex(0xffffff));
    }
    if (trim) {
      this.trimS = mk(trim, kit.trim, shadowCap, true);
      this.trimF = mk(trim, kit.trim, cap, false);
    }
  }
  begin() { this.nS = 0; this.nF = 0; }
  push(matrix, colorHex, shadow) {
    if (shadow && this.nS < this.capS) {
      const i = this.nS++;
      if (this.paintS) { this.paintS.setMatrixAt(i, matrix); this.paintS.setColorAt(i, _col.setHex(colorHex)); }
      if (this.trimS) this.trimS.setMatrixAt(i, matrix);
      return true;
    }
    if (this.nF >= this.capF) return false;
    const i = this.nF++;
    if (this.paintF) { this.paintF.setMatrixAt(i, matrix); this.paintF.setColorAt(i, _col.setHex(colorHex)); }
    if (this.trimF) this.trimF.setMatrixAt(i, matrix);
    return true;
  }
  end() {
    for (const m of this.meshes) {
      m.count = m.castShadow ? this.nS : this.nF;
      if (!m.count) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
  dispose() {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.meshes.length = 0;
  }
}

/** One car. Allocated once at init, then recycled forever. */
class Car {
  constructor(id) {
    this.id = id;
    this.active = false;
    this.key = -1; this.nextKey = -1;
    this.path = null;
    this.link = new MutablePath(12);
    this.onLink = false;
    this.s = 0; this.v = 0; this.a = 0;
    this.type = 'sedan'; this.spec = VEHICLE_SPECS.sedan;
    this.color = 0xcccccc;
    this.len = 4.8; this.halfLen = 2.4; this.width = 1.85;
    this.v0 = 12; this.aMax = 1.9; this.bComf = 2.6; this.T = 0.95; this.gap0 = 2.0;
    this.x = 0; this.y = 0; this.z = 0; this.rotY = 0;
    this.pitch = 0; this.roll = 0; this.bob = 0;
    this.wheelSpin = 0; this.steer = 0; this.steerVel = 0;
    this.latOff = 0; this.latVel = 0;
    this.indicator = 0; this.blinkFor = 0;
    this.headlightsOn = false; this.highBeams = false;
    this.brakeLightOn = false; this.reverseLightOn = false; this.sirenOn = false;
    this.claimedNode = -1;
    this.stuck = 0; this.age = 0; this.dist2 = 0;
    this.visual = null; this.lod = 2;
    this.laneChange = 0;
    this.decideIn = 0;
    this.noise = 0;
  }
  get cur() { return this.onLink ? this.link : this.path; }
}

export default class Traffic {
  static id = 'traffic';
  static label = 'Traffic';
  static deps = ['city'];

  constructor() {
    this.vehicles = [];              // the `traffic` contract: live AI cars
    this.cars = [];
    this.density = 1;
    this.ready = false;
    this.wanted = 0;
    this._laneLists = new Map();
    this._free = [];
    this._order = [];
    this._pools = new Map();
    this._visualFree = new Map();
    this._streamT = 0;
    this._lodT = 99;
    this._rng = new Rng(0xc0ffee);
    this._grid = new Grid(28);
    this._playerCar = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    const city = ctx.get('city');
    if (!city?.roads?.edges?.length) {
      console.warn('[traffic] no city road graph — traffic disabled');
      return;
    }
    this.city = city;
    this.nav = new Navigation(city).build();

    this.group = new THREE.Group();
    this.group.name = 'traffic';
    ctx.scene.add(this.group);

    this.density = clamp01(ctx.settings.trafficDensity ?? 0.8);

    // Pre-build the recycling pools. Nothing is allocated once the game is running.
    const MAX_CARS = 150;
    for (let i = 0; i < MAX_CARS; i++) {
      const c = new Car(i);
      this.cars.push(c); this._free.push(c); this._order.push(i);
    }

    this._lanes = this.nav.drivableLanes();
    this._laneRnd = new Rng(0x1234abcd);
    this.ready = this._lanes.length > 0;
    if (!this.ready) console.warn('[traffic] road graph produced no drivable lanes');

    // A point every ~34 m of every drivable lane, as (x, z, laneKey, t). Picking
    // a lane uniformly from 96 km of street lands in the spawn ring about once
    // in three hundred tries; picking one by its midpoint misses a long street
    // running straight past the camera. Sample points solve both.
    //
    // These are taken from the *edge* centreline rather than the lane, so the
    // index costs nothing: lane polylines stay lazily built, and `t` transfers
    // to the lane unchanged because a lane is just that polyline offset.
    const samp = [];
    for (let i = 0; i < this._lanes.length; i++) {
      const k = this._lanes[i];
      const e = this.nav.edges[Navigation.keyEdge(k)];
      if (!e) continue;
      const rev = this.nav.laneInfo(e, Navigation.keyLane(k)).dir < 0;
      const len = e.length || 60;
      const n = Math.max(1, Math.round(len / 34));
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        const m = e.pts?.length
          ? e.pts[Math.min(e.pts.length - 1, Math.round(t * (e.pts.length - 1)))]
          : city.roads.sample(e.id, t);
        samp.push(m.x, m.z, k, rev ? 1 - t : t);
      }
    }
    this._samp = new Float32Array(samp);
    this._nSamp = this._samp.length / 4;
    this._cand = [];
    this._candX = 1e9; this._candZ = 1e9;

    this._onWanted = (lvl) => { this.wanted = lvl | 0; };
    ctx.bus.on('player:wanted', this._onWanted);

    console.info(`[traffic] ${this._lanes.length} drivable lanes, ` +
      `${this.nav.signals.size} signalised junctions`);
  }

  /** Materials, shell pools and articulated visuals — built on first update so the
   *  vehicle agent has certainly finished its own init. */
  _lazyBuild(ctx) {
    if (this._built) return;
    this._built = true;
    const factory = ctx.get('vehicles');
    this.kit = factory?.kit || createMaterialKit(ctx);
    this._ownKit = !factory?.kit;
    this.lighting = ctx.get('lighting') || null;

    for (const t of VEHICLE_TYPES) {
      try {
        this._pools.set(t, new ShellPool(t, this.kit, this.group, SHELL_CAP, SHELL_SHADOW_CAP));
      } catch (err) { console.warn('[traffic] no shell geometry for', t, err); }
      this._visualFree.set(t, []);
    }
  }

  /** Grab (or build) an articulated visual of `type`. Pool never shrinks. */
  _claimVisual(type, wantLights) {
    const free = this._visualFree.get(type);
    if (free && free.length) { const v = free.pop(); v.root.visible = true; return v; }
    try {
      const v = buildVehicleVisual(type, {
        kit: this.kit, color: 0xffffff,
        lighting: wantLights ? this.lighting : null,
        castShadow: true,
      });
      this.group.add(v.root);
      return v;
    } catch (err) {
      console.warn('[traffic] visual build failed for', type, err);
      return null;
    }
  }
  _releaseVisual(car) {
    if (!car.visual) return;
    car.visual.setLights(OFF_LIGHTS, 0);
    car.visual.root.visible = false;
    this._visualFree.get(car.type)?.push(car.visual);
    car.visual = null;
    car.lod = 2;
  }

  // -- contract --------------------------------------------------------------

  /** @param {number} d 0..1 */
  setDensity(d) { this.density = clamp01(d); }

  // -- streaming -------------------------------------------------------------

  _targetCount() {
    const base = 18 + 118 * this.density;
    return Math.min(this.cars.length, Math.round(base));
  }

  /** Lane sample points near the camera. Rebuilt only when the view really moves. */
  _refreshCandidates(cx, cz) {
    if (this._cand.length &&
        (cx - this._candX) ** 2 + (cz - this._candZ) ** 2 < 60 * 60) return;
    this._candX = cx; this._candZ = cz;
    const out = this._cand; out.length = 0;
    const sp = this._samp, R2 = (SPAWN_MAX + 40) ** 2;
    for (let i = 0; i < this._nSamp; i++) {
      const dx = sp[i * 4] - cx, dz = sp[i * 4 + 1] - cz;
      if (dx * dx + dz * dz < R2) out.push(i);
    }
  }

  _spawnOne(cam, minR) {
    const car = this._free.pop();
    if (!car) return false;
    const nav = this.nav, rng = this._rng;
    const list = this._cand, sp = this._samp;
    if (!list.length) { this._free.push(car); return false; }

    // Try a handful of nearby places for one that is the right distance away
    // and has a hole big enough to drop a car into.
    let path = null, key = -1, s = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const i = list[rng.int(list.length)];
      const d = Math.hypot(sp[i * 4] - cam.x, sp[i * 4 + 1] - cam.z);
      if (d < minR || d > SPAWN_MAX) continue;
      const k = sp[i * 4 + 2];
      const p = nav.lanePath(k);
      if (!p || p.length < 14) continue;
      const at = Math.max(1, Math.min(p.length - 1,
        sp[i * 4 + 3] * p.length + rng.range(-12, 12)));
      if (this._occupied(k, at, 13)) continue;
      path = p; key = k; s = at;
      break;
    }
    if (!path) { this._free.push(car); return false; }

    const type = pickType(rng);
    const spec = VEHICLE_SPECS[type] || VEHICLE_SPECS.sedan;
    car.type = type; car.spec = spec;
    car.len = spec.phys.length; car.halfLen = spec.phys.length * 0.5;
    car.width = spec.phys.width;
    car.color = pickColor(spec, rng);
    car.key = key; car.path = path; car.s = s;
    car.onLink = false; car.nextKey = -1;
    car.claimedNode = -1; car.stuck = 0; car.age = 0;
    car.latOff = 0; car.latVel = 0; car.laneChange = 0;
    car.indicator = 0; car.blinkFor = 0;
    car.pitch = 0; car.roll = 0; car.bob = 0; car.steer = 0; car.steerVel = 0;
    car.wheelSpin = rng.range(0, 6.28);
    car.noise = rng.range(0, 100);
    car.decideIn = rng.range(0, 2);
    car.sirenOn = false;
    car.visual = null; car.lod = 2;

    // Boston drivers: quick off the mark, short gaps, and they take a yellow.
    const aggro = rng.range(0.55, 1.0);
    car.aggro = aggro;
    const heavy = type === 'bus' || type === 'truck';
    car.v0 = (path.speed || 11) * (heavy ? rng.range(0.80, 0.94) : rng.range(0.96, 1.22));
    car.aMax = heavy ? 0.85 : 1.6 + aggro * 1.5;
    car.bComf = heavy ? 1.9 : 2.3 + aggro * 1.3;
    car.T = heavy ? 1.5 : 1.15 - aggro * 0.45;
    car.gap0 = heavy ? 3.2 : 1.6 + (1 - aggro) * 1.4;
    car.v = Math.min(car.v0, path.speedCap(s, 8)) * rng.range(0.5, 1);
    car.active = true;
    this.vehicles.push(car);
    return true;
  }

  _despawn(car) {
    if (!car.active) return;
    car.active = false;
    if (car.claimedNode >= 0) { this.nav.release(car.claimedNode, car.id); car.claimedNode = -1; }
    this._releaseVisual(car);
    const i = this.vehicles.indexOf(car);
    if (i >= 0) this.vehicles.splice(i, 1);
    this._free.push(car);
  }

  /** Is there already something within `pad` metres of `s` on lane `key`? */
  _occupied(key, s, pad) {
    const list = this._laneLists.get(key);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (Math.abs(o.s - s) < pad) return true;
    }
    return false;
  }

  // -- simulation ------------------------------------------------------------

  /**
   * `capture()` drives the whole `update()` chain synchronously, so a throw in
   * here does not just break traffic — it aborts the screenshot for every other
   * agent and for the visual critic. One bad frame therefore retires this system
   * rather than the run.
   */
  update(dt, ctx) {
    if (!this.ready) return;
    try {
      this._update(dt, ctx);
    } catch (err) {
      this.ready = false;
      if (this.group) this.group.visible = false;
      console.error('[traffic] disabled after an error in update():', err);
    }
  }

  _update(dt, ctx) {
    this._lazyBuild(ctx);
    if (dt > 0.1) dt = 0.1;
    const cam = ctx.camera.position;

    this.density = clamp01(ctx.settings.trafficDensity ?? this.density);
    this.nav.update(dt);

    this._buildLaneLists(ctx);
    this._stream(dt, cam);

    const list = this.vehicles;
    for (let i = 0; i < list.length; i++) this._drive(list[i], dt, ctx);

    // Recycle anything that ran off the end of the world or wedged itself.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const d2 = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
      c.dist2 = d2;
      if (d2 > DESPAWN_R * DESPAWN_R || c.stuck > 24) this._despawn(c);
    }

    this._present(dt, ctx);
  }

  /** Bucket every car by the lane it is on so the leader search is O(1). */
  _buildLaneLists(ctx) {
    for (const a of this._laneLists.values()) a.length = 0;
    const list = this.vehicles;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      // A car mid-junction is registered on the lane it is *entering*, at a
      // negative arc length, so whoever is behind it there already sees it.
      const key = c.onLink ? c.nextKey : c.key;
      if (key < 0) continue;
      const s = c.onLink ? c.link.length - c.s === 0 ? 0 : -(c.link.length - c.s) : c.s;
      let arr = this._laneLists.get(key);
      if (!arr) this._laneLists.set(key, arr = []);
      c._s = s;
      arr.push(c);
    }
    this._injectPlayer(ctx);
    // Nearly sorted every frame, so insertion sort is linear in practice.
    for (const arr of this._laneLists.values()) {
      for (let i = 1; i < arr.length; i++) {
        const v = arr[i]; let j = i - 1;
        while (j >= 0 && arr[j]._s > v._s) { arr[j + 1] = arr[j]; j--; }
        arr[j + 1] = v;
      }
    }
  }

  /** The player's car is an obstacle like any other — traffic queues behind it. */
  _injectPlayer(ctx) {
    const pv = ctx.get('vehicles')?.playerVehicle;
    let px, pz, pv0 = 0, plen = 4.8;
    if (pv?.position) { px = pv.position.x; pz = pv.position.z; pv0 = Math.abs(pv.speed || 0); plen = pv.spec?.phys?.length || 4.8; }
    else {
      const pl = ctx.get('player');
      if (!pl || pl.mode !== 'onFoot' || !pl.position) return;
      px = pl.position.x; pz = pl.position.z; pv0 = 0; plen = 0.8;
    }
    const near = this.city.roads.nearestEdge(px, pz);
    if (!near || near.distance > 9) return;
    const e = this.city.roads.edges[near.edgeId];
    if (!e) return;
    // Which lane of that edge is the player actually sitting in?
    let bestKey = -1, bestD = 5.5;
    const n = this.nav.laneCount(e);
    for (let i = 0; i < n; i++) {
      const k = Navigation.laneKey(e.id, i);
      const p = this.nav.lanePath(k);
      if (!p) continue;
      const s = near.t * p.length;
      p.at(this._laneS(p, px, pz, s), _pt);
      const d = Math.hypot(_pt.x - px, _pt.z - pz);
      if (d < bestD) { bestD = d; bestKey = k; }
    }
    if (bestKey < 0) return;
    const p = this.nav.lanePath(bestKey);
    const ghost = this._playerGhost || (this._playerGhost = {
      id: -1, isGhost: true, s: 0, _s: 0, v: 0, halfLen: 2.4, len: 4.8, active: true,
    });
    ghost.s = ghost._s = this._laneS(p, px, pz, near.t * p.length);
    ghost.v = pv0; ghost.len = plen; ghost.halfLen = plen * 0.5;
    let arr = this._laneLists.get(bestKey);
    if (!arr) this._laneLists.set(bestKey, arr = []);
    arr.push(ghost);
  }

  /** Refine an arc-length guess by sampling a couple of neighbours. */
  _laneS(p, x, z, guess) {
    let best = guess, bd = Infinity;
    for (let i = -2; i <= 2; i++) {
      const s = Math.max(0, Math.min(p.length, guess + i * 4));
      p.at(s, _pt2);
      const d = (_pt2.x - x) ** 2 + (_pt2.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  _stream(dt, cam) {
    this._streamT -= dt;
    if (this._streamT > 0) return;
    this._streamT = 0.22;
    this._refreshCandidates(cam.x, cam.z);
    const want = this._targetCount();
    // An empty road is the thing to avoid, so fill aggressively while it is
    // empty and then keep new cars out beyond the far end of the street.
    const priming = this.vehicles.length < want * 0.6;
    const minR = priming ? 24 : SPAWN_MIN;
    let budget = priming ? 40 : 8;
    while (this.vehicles.length < want && budget-- > 0) {
      if (!this._spawnOne(cam, minR)) break;
    }
    if (this.vehicles.length > want + 6) {
      // Trim the farthest away first.
      let worst = null, wd = -1;
      for (const c of this.vehicles) {
        const d = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
        if (d > wd && d > 140 * 140) { wd = d; worst = c; }
      }
      if (worst) this._despawn(worst);
    }
  }

  /**
   * One car, one step: IDM against the leader, a junction test at the stop line,
   * lane-change bookkeeping, then integrate and pose.
   */
  _drive(c, dt, ctx) {
    const nav = this.nav;
    const path = c.cur;
    if (!path || path.length <= 0) { c.stuck += 1; return; }
    c.age += dt;

    // ---- desired speed ----------------------------------------------------
    let vTarget = Math.min(c.v0, path.speedCap(c.s, 6 + c.v * 1.1));
    if (c.onLink) vTarget = Math.min(vTarget, 7.5);

    // ---- car in front -----------------------------------------------------
    let gap = Infinity, leadV = 0;
    const key = c.onLink ? c.nextKey : c.key;
    const list = this._laneLists.get(key);
    if (list) {
      const mine = c._s;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === c || o._s <= mine) continue;
        gap = o._s - mine - o.halfLen - c.halfLen;
        leadV = o.v;
        break;
      }
    }

    // ---- the junction ahead ----------------------------------------------
    const toEnd = path.length - c.s;
    if (!c.onLink) {
      const node = path.toNode;
      const stopBack = nav.nodeRadius[node] * 0.62 + 1.1;
      const distToLine = toEnd - stopBack;

      if (c.nextKey < 0 && distToLine < 46) {
        c.nextKey = nav.nextLane(c.key, this._laneRnd);
        if (c.nextKey >= 0) {
          const turn = this._turnSign(c.key, c.nextKey);
          c.indicator = turn;
          c.blinkFor = 4.5;
        }
      }

      if (distToLine < 60 && distToLine > -1.5) {
        const mayGo = this._junctionClear(c, node, distToLine, dt);
        if (!mayGo) {
          // The stop line behaves as a stationary car sitting on it.
          const g = distToLine - 0.4;
          if (g < gap) { gap = g; leadV = 0; }
        }
      }
    }

    // ---- IDM --------------------------------------------------------------
    const v = c.v;
    let accel;
    const freeTerm = 1 - Math.pow(v / Math.max(vTarget, 0.4), 4);
    if (gap < 220) {
      const dv = v - leadV;
      const sStar = c.gap0 + Math.max(0, v * c.T + (v * dv) / (2 * Math.sqrt(c.aMax * c.bComf)));
      const safe = Math.max(gap, 0.35);
      accel = c.aMax * (freeTerm - (sStar / safe) * (sStar / safe));
    } else {
      accel = c.aMax * freeTerm;
    }
    if (accel < -8) accel = -8;
    else if (accel > c.aMax) accel = c.aMax;
    c.a = accel;

    c.v += accel * dt;
    if (c.v < 0) c.v = 0;
    // Hard backstop: never drive through the car in front, whatever IDM says.
    if (gap < 0.25 && c.v > 0.4) c.v = 0.4;

    c.s += c.v * dt;
    c.stuck = c.v < 0.25 ? c.stuck + dt : 0;

    // ---- path transitions -------------------------------------------------
    if (c.s >= path.length) {
      const over = c.s - path.length;
      if (c.onLink) {
        if (c.claimedNode >= 0) { nav.release(c.claimedNode, c.id); c.claimedNode = -1; }
        c.onLink = false;
        c.key = c.nextKey;
        c.path = nav.lanePath(c.key);
        c.nextKey = -1;
        c.s = over;
        if (!c.path) { c.stuck = 99; return; }
      } else {
        if (c.nextKey < 0) c.nextKey = nav.nextLane(c.key, this._laneRnd);
        if (c.nextKey < 0) { c.stuck = 99; return; }
        if (!nav.buildLink(c.key, c.nextKey, c.link)) { c.stuck = 99; return; }
        c.onLink = true;
        c.s = over;
        c.indicator = 0;
      }
    }

    // ---- lane changes -----------------------------------------------------
    c.decideIn -= dt;
    if (c.laneChange > 0) {
      c.laneChange -= dt;
    } else if (!c.onLink && c.decideIn <= 0) {
      c.decideIn = 1.6 + this._rng.next() * 2.5;
      this._tryLaneChange(c, gap, leadV, vTarget);
    }
    // Blend the lateral offset back to zero — that is the visible lane change.
    const relax = Math.exp(-dt * 2.4);
    c.latVel = (c.latOff * relax - c.latOff) / Math.max(dt, 1e-4);
    c.latOff *= relax;
    if (Math.abs(c.latOff) < 0.01) c.latOff = 0;

    if (c.blinkFor > 0) { c.blinkFor -= dt; if (c.blinkFor <= 0) c.indicator = 0; }

    this._pose(c, dt, ctx);
  }

  /** -1 left, +1 right, 0 straight — for the indicator. */
  _turnSign(fromKey, toKey) {
    const a = this.nav._laneOutBearing(fromKey);
    const b = this.nav._laneInBearing(toKey);
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < 0.38) return 0;
    // Math angles run anticlockwise in XZ with +Z south, so a positive delta is a
    // right-hand turn in world terms.
    return d > 0 ? 1 : -1;
  }

  /**
   * May this car enter the junction? Signal phase first, then a reservation, then
   * a check that there is somewhere to actually go on the far side.
   */
  _junctionClear(c, node, distToLine, dt) {
    const nav = this.nav;
    if (c.claimedNode === node) return true;

    if (nav.hasSignal(node)) {
      const e = this.nav.edges[Navigation.keyEdge(c.key)];
      const state = nav.signalState(node, e ? e.id : -1);
      if (state === RED) return false;
      if (state === YELLOW) {
        // Boston: if you can clear it comfortably, you go.
        const stopDist = (c.v * c.v) / (2 * c.bComf);
        if (distToLine > stopDist * (1.25 - c.aggro * 0.5)) return false;
      }
    } else {
      // Unsignalised: only commit when close, and give way to the bigger road.
      if (distToLine > 12) return true;
      const e = this.nav.edges[Navigation.keyEdge(c.key)];
      const hold = nav.priority(e) >= 3 ? 2.2 : 3.4;
      if (!nav.claim(node, c.id, hold)) return false;
      c.claimedNode = node;
      return true;
    }

    if (distToLine > 10) return true;
    if (!nav.claim(node, c.id, 2.6)) return false;

    // Don't block the box: refuse to enter unless the exit lane has a car's length free.
    if (c.nextKey >= 0) {
      const out = this._laneLists.get(c.nextKey);
      if (out && out.length) {
        let closest = Infinity;
        for (let i = 0; i < out.length; i++) {
          const o = out[i];
          if (o._s >= 0 && o._s < closest) closest = o._s;
        }
        if (closest < c.len + 2.5) { nav.release(node, c.id); return false; }
      }
    }
    c.claimedNode = node;
    return true;
  }

  /** Discretionary lane change: is the next lane over clearly better and clear? */
  _tryLaneChange(c, gap, leadV, vTarget) {
    if (c.v < 2.5 || gap > 32) return;
    if (c.type === 'bus' || c.type === 'truck') return;
    const nav = this.nav;
    const path = c.path;
    if (!path || path.length - c.s < 45) return;      // no point right before a junction

    for (const delta of (this._rng.next() < 0.5 ? LEFT_FIRST : RIGHT_FIRST)) {
      const k = nav.siblingLane(c.key, delta);
      if (k < 0) continue;
      const p = nav.lanePath(k);
      if (!p) continue;
      const s = (c.s / path.length) * p.length;
      // Room in front and behind, with a bit more behind because closing speed.
      const list = this._laneLists.get(k);
      let ok = true, aheadGap = 999;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          const d = o._s - s;
          if (d > 0 && d < aheadGap) aheadGap = d;
          const need = d > 0 ? c.halfLen + o.halfLen + 6 : c.halfLen + o.halfLen + 9 + Math.max(0, o.v - c.v) * 1.4;
          if (Math.abs(d) < need) { ok = false; break; }
        }
      }
      if (!ok) continue;
      if (aheadGap < gap + 12) continue;              // not actually an improvement
      // Commit: keep the world position, hand the car to the new lane, and let the
      // lateral offset decay so it slides across the line.
      path.at(c.s, _pt);
      p.at(s, _pt2);
      const dx = _pt.x - _pt2.x, dz = _pt.z - _pt2.z;
      c.latOff = dx * -_pt2.dz + dz * _pt2.dx;        // signed, right-positive
      if (Math.abs(c.latOff) > 6) { c.latOff = 0; continue; }
      c.key = k; c.path = p; c.s = s;
      c.laneChange = LANE_CHANGE_TIME;
      c.indicator = c.latOff > 0 ? -1 : 1;
      c.blinkFor = LANE_CHANGE_TIME;
      c.nextKey = -1;
      return;
    }
  }

  /** Position, yaw, and the little dynamic cues that sell a car as a moving mass. */
  _pose(c, dt, ctx) {
    const path = c.cur;
    path.at(c.s, _pt);
    // Lateral offset (mid lane change) is applied along the path normal.
    c.x = _pt.x - _pt.dz * c.latOff;
    c.z = _pt.z + _pt.dx * c.latOff;
    c.y = _pt.y;

    // Yaw: path tangent, plus a slice of the lateral velocity so the nose points
    // where the car is actually going during a lane change.
    const slip = Math.atan2(-c.latVel, Math.max(c.v, 1.2));
    const targetYaw = _pt.rotY + slip * 0.7;
    let d = targetYaw - c.rotY;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const k = 1 - Math.exp(-dt * 12);
    c.rotY += d * k;
    const yawRate = (d * k) / Math.max(dt, 1e-4);

    // Weight transfer. Real numbers, small values: brake dive, squat, corner roll.
    const targetPitch = clamp(-c.a * 0.0085, -0.035, 0.028);
    const targetRoll = clamp(yawRate * c.v * 0.010, -0.05, 0.05);
    c.pitch += (targetPitch - c.pitch) * (1 - Math.exp(-dt * 7));
    c.roll += (targetRoll - c.roll) * (1 - Math.exp(-dt * 6));

    // Road noise: a車 body never sits perfectly still on asphalt.
    c.noise += dt * (1.2 + c.v * 0.32);
    c.bob = Math.sin(c.noise * 3.1) * 0.006 + Math.sin(c.noise * 1.37) * 0.004;

    const wheelR = c.spec.wheels?.[0]?.radius || 0.33;
    c.wheelSpin += (c.v / wheelR) * dt;
    if (c.wheelSpin > 1e5) c.wheelSpin -= 1e5;

    const steerTarget = clamp(yawRate * 2.4 / Math.max(1, c.v * 0.22), -0.5, 0.5);
    c.steer += (steerTarget - c.steer) * (1 - Math.exp(-dt * 9));

    const tod = ctx.time.timeOfDay;
    c.headlightsOn = tod > 18.1 || tod < 6.9 || ctx.settings.weather === 'storm';
    c.brakeLightOn = c.a < -0.55 || (c.v < 0.4 && c.a <= 0.02);
  }

  // -- presentation ----------------------------------------------------------

  _present(dt, ctx) {
    const list = this.vehicles;
    const n = list.length;
    for (const p of this._pools.values()) p.begin();
    if (!n) { for (const p of this._pools.values()) p.end(); return; }

    // Re-rank every few frames: distances change slowly and the sort is the only
    // superlinear thing in here.
    this._lodT += dt;
    if (this._lodT > 0.18) {
      this._lodT = 0;
      list.sort(byDistance);
      const cam = ctx.camera;
      _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const fx = _v.x, fz = _v.z;
      const cx = cam.position.x, cz = cam.position.z;
      let detail = 0;
      for (let i = 0; i < n; i++) {
        const c = list[i];
        const d2 = c.dist2;
        let want = 2;
        // Spend the detail budget only on cars that can actually be seen. The
        // articulated meshes set `frustumCulled = false` and three does not cull
        // the Group above them, so a car behind the camera is submitted in full
        // unless it is denied a visual here.
        const d = Math.sqrt(d2) || 1;
        const facing = ((c.x - cx) * fx + (c.z - cz) * fz) / d;
        if (d2 < DETAIL_R * DETAIL_R && detail < MAX_DETAIL && (facing > -0.15 || d < 12)) {
          want = (d2 < LOD0_R * LOD0_R && detail < MAX_LOD0) ? 0 : 1;
          detail++;
        }
        if (want === 2) { if (c.visual) this._releaseVisual(c); c.lod = 2; continue; }
        if (!c.visual) {
          c.visual = this._claimVisual(c.type, want === 0);
          if (!c.visual) { c.lod = 2; continue; }
          c.visual.setPaint?.(c.color);
          c.lod = -1;
        }
        if (c.lod !== want) { c.visual.setLod(want); c.lod = want; }
      }
    }

    for (let i = 0; i < n; i++) {
      const c = list[i];
      _e.set(c.pitch, c.rotY, c.roll);
      _q.setFromEuler(_e);
      if (c.visual) {
        const r = c.visual.root;
        r.position.set(c.x, c.y + c.bob, c.z);
        r.quaternion.copy(_q);
        if (c.lod === 0) {
          const w = c.spec.wheels;
          for (let k = 0; k < w.length; k++) {
            const rest = w[k].p[1] - w[k].radius;
            const squat = rest - (c.pitch * (w[k].p[2] > 0 ? -1 : 1) * 0.9
                                + c.roll * (w[k].p[0] > 0 ? 1 : -1) * 0.6) * 0.9;
            c.visual.setWheel(k, squat, w[k].steer ? c.steer : 0, c.wheelSpin);
          }
        }
        c.visual.setLights(c, dt);
      } else {
        const pool = this._pools.get(c.type);
        if (!pool) continue;
        _v.set(c.x, c.y + c.bob, c.z);
        _m.compose(_v, _q, _scale);
        pool.push(_m, c.color, c.dist2 < SHADOW_R * SHADOW_R);
      }
    }
    for (const p of this._pools.values()) p.end();
  }

  dispose() {
    this.ctx?.bus.off?.('player:wanted', this._onWanted);
    for (const c of this.cars) {
      if (c.visual) { c.visual.dispose(); c.visual = null; }
    }
    for (const arr of this._visualFree.values()) for (const v of arr) v.dispose();
    this._visualFree.clear();
    for (const p of this._pools.values()) p.dispose();
    this._pools.clear();
    this.vehicles.length = 0;
    this.cars.length = 0;
    this.group?.parent?.remove(this.group);
    if (this._ownKit) this.kit?.dispose();
  }
}

/* -- helpers ------------------------------------------------------------- */

const LEFT_FIRST = [-1, 1];
const RIGHT_FIRST = [1, -1];
const OFF_LIGHTS = {
  headlightsOn: false, highBeams: false, brakeLightOn: false,
  reverseLightOn: false, indicator: 0, sirenOn: false,
};

function byDistance(a, b) { return a.dist2 - b.dist2; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

let _mixTotal = 0;
for (const m of MIX) _mixTotal += m[1];

function pickType(rng) {
  let r = rng.next() * _mixTotal;
  for (let i = 0; i < MIX.length; i++) {
    r -= MIX[i][1];
    if (r <= 0) return MIX[i][0];
  }
  return 'sedan';
}

function pickColor(spec, rng) {
  const c = spec.def?.colors;
  if (!c || !c.length) return 0xb8bcc2;
  const hex = parseInt(c[(rng.next() * c.length) | 0].slice(1), 16);
  if (c.length === 1) return hex;
  const j = 0.92 + rng.next() * 0.16;
  const ch = (sh) => {
    const v = Math.round(((hex >> sh) & 255) * j);
    return (v < 0 ? 0 : v > 255 ? 255 : v) << sh;
  };
  return ch(16) | ch(8) | ch(0);
}
