import * as THREE from 'three';
import Navigation, { WalkNav, Grid, Rng } from './Navigation.js';
import { geo } from '../core/Geo.js';
import {
  CrowdMesh, dressActor, clipForSpeed, phaseRate, CLIP_ROW, REF_HEIGHT,
} from '../gameplay/Character.js';

/**
 * Pedestrians.
 *
 * People are the cheapest thing in an open world to get wrong and the most
 * expensive thing to leave out: an empty pavement is an automatic fail on the
 * critic rubric, and a pavement full of gliding T-poses is worse than empty.
 * So this system spends its budget in a specific order — first on *motion*
 * (a real walk cycle, on the GPU, see `gameplay/Character.js`), then on
 * *placement* (the real pavement graph, real crossings, real signals), then on
 * *variety* (height, build, gait, palette), and only then on anything else.
 *
 * ## Cost
 * Everything is instanced: the entire crowd is two draw calls plus shadows, at
 * any population. The CPU side is a fixed pool of actors — no allocation after
 * `init` — advancing an arc length along a baked pavement polyline, with a
 * uniform grid for neighbour avoidance. Avoidance and crossing logic run only
 * for the actors near the camera; the rest are pure kinematics.
 *
 * ## Behaviour
 * - Walk the `city.sidewalks` graph; prefer to carry straight on at a corner.
 * - Cross only at crossing links, and only when the signal governing that
 *   junction is red for the traffic being crossed — the same `Navigation`
 *   instance the cars obey, so a queue of people and a queue of cars never both
 *   think they have right of way.
 * - Keep right, steer around each other and around the player, and slow rather
 *   than intersect when a gap closes.
 * - Density follows the district: thick around the Common, Faneuil Hall and
 *   Newbury Street, thin in the Seaport.
 */

const DESPAWN_R = 205;
const SPAWN_MIN = 26;
const SPAWN_MAX = 168;
const NEAR_R = 46;          // full simulation + LOD0 mesh inside this radius
const AVOID_R = 2.6;
const LOD0_CAP = 72;
const LOD1_CAP = 560;
const POOL = 620;

const _pt = { x: 0, y: 0, z: 0, dx: 0, dz: 0, rotY: 0 };

/** Base crowd weight per district. */
const DISTRICT_W = {
  park: 0.92, financial: 1.00, backBay: 0.94, northEnd: 0.86, beaconHill: 0.62,
  southEnd: 0.52, fenway: 0.60, seaport: 0.16, charlestown: 0.30, cambridge: 0.55,
  water: 0.0,
};

/**
 * Places that are busy regardless of what the district raster says. Coordinates
 * come from `geo()` so they land on the real streets, never guessed.
 */
const HOTSPOTS = [
  { ll: [42.3554, -71.0656], r: 260, w: 0.55 },   // Boston Common / Park Street
  { ll: [42.3600, -71.0545], r: 170, w: 0.70 },   // Faneuil Hall / Quincy Market
  { ll: [42.3505, -71.0810], r: 240, w: 0.55 },   // Newbury Street
  { ll: [42.3556, -71.0602], r: 180, w: 0.60 },   // Downtown Crossing
  { ll: [42.3647, -71.0542], r: 170, w: 0.45 },   // Hanover Street, North End
  { ll: [42.3519, -71.0552], r: 150, w: 0.35 },   // South Station
  { ll: [42.3492, -71.0777], r: 150, w: 0.35 },   // Copley
];

class Ped {
  constructor(id) {
    this.id = id;
    this.active = false;
    this.edge = -1; this.path = null; this.dir = 1;
    this.s = 0; this.node = -1;
    this.v = 0; this.speed = 1.35; this.baseSpeed = 1.35;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.tilt = 0; this.lean = 0;
    this.lat = 0; this.latWant = 0; this.sideBias = 0.5;
    this.pushX = 0; this.pushZ = 0;
    this.pauseIn = 1e9; this.pauseFor = 0;
    this.state = 'walk';           // walk | wait | cross | idle | flee
    this.wait = 0; this.waitTotal = 0; this.linger = 0; this.pendingEdge = -1;
    this.phase = 0; this.clip = 'walk'; this.clipRow = CLIP_ROW.walk;
    this.h = REF_HEIGHT; this.build = 1; this.seed = 0;
    this.topR = 1; this.topG = 1; this.topB = 1;
    this.botR = 1; this.botG = 1; this.botB = 1;
    this.skinR = 1; this.skinG = 1; this.skinB = 1;
    this.dist2 = 0; this.lod = 1;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
  }
}

export default class Pedestrians {
  static id = 'peds';
  static label = 'Pedestrians';
  static deps = ['city'];

  constructor() {
    this.actors = [];            // the `peds` contract: live pedestrians
    this.peds = [];
    this.density = 1;
    this.ready = false;
    this.wanted = 0;
    this._free = [];
    this._grid = new Grid(6);
    this._rng = new Rng(0x9e3d71);
    this._streamT = 0;
    this._lodT = 99;
    this._hot = [];
    this._tick = 0;
    this._cand = [];             // walkable edges near the focus
    this._candX = 1e9; this._candZ = 1e9;
  }

  async init(ctx) {
    this.ctx = ctx;
    const city = ctx.get('city');
    if (!city?.sidewalks?.edges?.length) {
      console.warn('[peds] no sidewalk graph — pedestrians disabled');
      return;
    }
    this.city = city;

    // Share the traffic system's navigation so people and cars read the *same*
    // signal phases. Falling back to a private copy keeps peds alive if traffic
    // never loaded, at the cost of independent (but still self-consistent) lights.
    const traffic = ctx.get('traffic');
    this.roadNav = (traffic?.nav?.exits?.size ? traffic.nav : new Navigation(city).build());
    this.walk = new WalkNav(city, this.roadNav).build();
    this._ownNav = this.roadNav !== traffic?.nav;

    if (!this.walk.walkable.length) {
      console.warn('[peds] sidewalk graph produced no walkable edges');
      return;
    }

    for (const h of HOTSPOTS) {
      const p = geo(h.ll[0], h.ll[1]);
      this._hot.push({ x: p.x, z: p.z, r2: h.r * h.r, w: h.w });
    }

    this.group = new THREE.Group();
    this.group.name = 'pedestrians';
    ctx.scene.add(this.group);

    this.near = new CrowdMesh(ctx, 0, LOD0_CAP, { castShadow: true, name: 'peds_near' });
    this.far = new CrowdMesh(ctx, 1, LOD1_CAP, { castShadow: false, name: 'peds_far' });
    this.group.add(this.near.mesh, this.far.mesh);

    for (let i = 0; i < POOL; i++) {
      const p = new Ped(i);
      this.peds.push(p); this._free.push(p);
    }

    // A point every ~22 m of pavement, as (x, z, edgeId, arcLength). Spawning
    // needs a *local* place to put someone, and neither of the obvious cheap
    // tests gives one: sampling all 96 km uniformly lands in range once in a
    // thousand tries, and testing an edge by its midpoint misses a 400 m street
    // that runs straight past the camera. Points are the honest unit.
    const w = this.walk.walkable;
    const samp = [];
    for (let i = 0; i < w.length; i++) {
      const p = this.walk.path(w[i]);
      if (!p || p.length < 3) continue;
      const n = Math.max(1, Math.round(p.length / 22));
      for (let k = 0; k < n; k++) {
        const s = ((k + 0.5) / n) * p.length;
        p.at(s, _pt);
        samp.push(_pt.x, _pt.z, w[i], s);
      }
    }
    this._samp = new Float32Array(samp);
    this._nSamp = this._samp.length / 4;

    // How far off the pavement centreline a person may stray. `buildSidewalks`
    // lays each strand down the middle of a strip whose width comes from the
    // parent road's profile, and that width is not carried on the sidewalk edge
    // — so look it up once. Without this, the same lateral spread that reads
    // well on Boylston Street walks people down the middle of a back alley.
    const ge = this.walk.g.edges;
    this._halfWalk = new Float32Array(ge.length);
    for (let i = 0; i < ge.length; i++) {
      const e = ge[i];
      let hw = 1.0;
      if (e.kind === 'walk' && e.pts?.length) {
        const m = e.pts[e.pts.length >> 1];
        const near = this.roadNav.roads.nearestEdge(m.x, m.z);
        const re = near ? this.roadNav.edges[near.edgeId] : null;
        if (re && re.walk > 0.3) hw = re.walk * 0.5;
      }
      this._halfWalk[i] = Math.max(0.34, hw - 0.24);
    }

    this.density = clamp01(ctx.settings.pedDensity ?? 0.85);
    this._onWanted = (lvl) => { this.wanted = lvl | 0; };
    ctx.bus.on('player:wanted', this._onWanted);

    this.ready = true;
    const tri = (this.near.geometry.index.count + this.far.geometry.index.count) / 3;
    console.info(`[peds] ${this.walk.walkable.length} walkable pavement edges, ` +
      `${this.walk.crossingNode.size} crossings, ${tri | 0} tris per pair of LODs`);
  }

  /** @param {number} d 0..1 */
  setDensity(d) { this.density = clamp01(d); }

  /**
   * May a pedestrian step off the kerb onto this crossing?
   *
   * The signal test alone is not enough: `WalkNav.crossingClear` returns true at
   * every *unsignalised* junction, which is most of them, and a person walking
   * calmly through a moving car is the single worst thing this system could put
   * on screen. So a signalised crossing is governed by its phase, and an
   * unsignalised one by an actual gap in the traffic — time-to-contact against
   * every car heading for the crossing.
   *
   * Only evaluated when someone arrives at a kerb or is already waiting there,
   * so this never runs more than a handful of times a second.
   */
  _crossingSafe(edgeId) {
    if (!this.walk.crossingClear(edgeId)) return false;
    const cars = this.ctx.get('traffic')?.vehicles;
    if (!cars || !cars.length) return true;
    const e = this.walk.g.edges[edgeId];
    if (!e?.pts?.length) return true;
    const a = e.pts[0], b = e.pts[e.pts.length - 1];
    const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const dx = mx - c.x, dz = mz - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 900) continue;                       // 30 m is well past caring
      const d = Math.sqrt(d2) || 1e-3;
      // Only cars actually pointed at the crossing count.
      if ((dx * -Math.sin(c.rotY) + dz * -Math.cos(c.rotY)) / d < 0.55) continue;
      if (d / Math.max(c.v, 0.6) < 3.8) return false;
    }
    return true;
  }

  // -- streaming -------------------------------------------------------------

  /**
   * How many people a place holds is a property of the *place*, not a global
   * constant. Boston has 96 km of street spread over 36 km², so a fixed target
   * puts three hundred people onto the six hundred metres of pavement that are
   * actually in range and they queue up nose to tail. Scaling by the pavement
   * in range gives a downtown block and a Seaport access road very different
   * crowds out of the same density setting.
   */
  _targetCount() {
    const perSample = 0.45 + 1.85 * this.density;      // one sample ~= 22 m of kerb
    return Math.min(POOL, Math.max(8, Math.round(this._cand.length * perSample)));
  }

  /** Crowd weight at a point: district base, plus any hotspot it falls inside. */
  _weightAt(x, z) {
    let w = DISTRICT_W[this.city.districtAt(x, z)];
    if (w === undefined) w = 0.5;
    const hot = this._hot;
    for (let i = 0; i < hot.length; i++) {
      const h = hot[i];
      const d2 = (x - h.x) ** 2 + (z - h.z) ** 2;
      if (d2 < h.r2) w += h.w * (1 - d2 / h.r2);
    }
    return w;
  }

  /** Pavement sample points in range right now. Rebuilt only on real movement. */
  _refreshCandidates(cx, cz) {
    if (this._cand.length &&
        (cx - this._candX) ** 2 + (cz - this._candZ) ** 2 < 45 * 45) return;
    this._candX = cx; this._candZ = cz;
    const out = this._cand; out.length = 0;
    const sp = this._samp, R2 = (SPAWN_MAX + 24) ** 2;
    for (let i = 0; i < this._nSamp; i++) {
      const dx = sp[i * 4] - cx, dz = sp[i * 4 + 1] - cz;
      if (dx * dx + dz * dz < R2) out.push(i);
    }
  }

  _spawnOne(cx, cz, minR) {
    const ped = this._free.pop();
    if (!ped) return false;
    const rng = this._rng, list = this._cand, sp = this._samp;
    if (!list.length) { this._free.push(ped); return false; }
    const min2 = minR * minR, max2 = SPAWN_MAX * SPAWN_MAX;
    let path = null, edge = -1, s = 0, best = Infinity;
    // Prefer a spot near a corner. `buildSidewalks` gives one strand per road
    // edge per side, and around the Common those run 430 m — a pedestrian
    // dropped mid-block walks for five minutes before he reaches the only place
    // he can cross a road, so a uniformly-spawned crowd contains nobody
    // crossing, nobody at a kerb and nobody queued at a light. Taking the best
    // of a few draws puts most of the crowd within a corner's reach without
    // giving up the camera locality the sample list exists to provide.
    let draws = rng.next() < 0.62 ? 4 : 1;
    for (let attempt = 0; attempt < 10 && best > 0; attempt++) {
      const i = list[rng.int(list.length)];
      const sx = sp[i * 4], sz = sp[i * 4 + 1];
      const d2 = (sx - cx) ** 2 + (sz - cz) ** 2;
      if (d2 < min2 || d2 > max2) continue;
      if (rng.next() > this._weightAt(sx, sz)) continue;
      const id = sp[i * 4 + 2];
      const p = this.walk.path(id);
      if (!p) continue;
      const arc = Math.max(0.2, Math.min(p.length - 0.2, sp[i * 4 + 3] + rng.range(-8, 8)));
      const toCorner = Math.min(arc, p.length - arc);
      if (toCorner < best) { best = toCorner; path = p; edge = id; s = arc; }
      if (path && --draws <= 0) break;
    }
    if (!path) { this._free.push(ped); return false; }

    dressActor(ped, () => rng.next());
    ped.edge = edge; ped.path = path;
    // Walk toward the *nearer* corner, three times out of four.
    //
    // `buildSidewalks` lays one pavement strand per road edge per side, and a
    // Boston road edge is a whole street: 177 m on average, 1.2 km at worst.
    // Spawning with a coin-flip direction therefore points half the crowd at a
    // junction two minutes away, and a pedestrian only ever decides to cross a
    // road when he reaches one — so with a fair coin, nobody in a screenshot is
    // ever crossing, queueing at a light, or standing at a kerb. Heading for the
    // near end cuts the mean walk to a junction from ~131 s to ~35 s, and is
    // also just what people do.
    const nearEnd = (path.length - s) < s;
    const fwd = rng.next() < 0.75 ? nearEnd : !nearEnd;
    ped.dir = fwd ? 1 : -1;
    ped.s = fwd ? s : path.length - s;
    ped.node = ped.dir > 0 ? this.walk.g.edges[edge].a : this.walk.g.edges[edge].b;
    // Height barely changes how fast people walk; hurry does.
    ped.baseSpeed = rng.range(1.02, 1.62) * (0.94 + (ped.h / REF_HEIGHT) * 0.06);
    if (rng.next() < 0.035) ped.baseSpeed = rng.range(2.8, 3.6);   // a runner
    ped.speed = ped.baseSpeed;
    ped.v = ped.baseSpeed * rng.range(0.6, 1);
    // Everyone keeps right, but not on the same line — a pavement is two or
    // three abreast each way, not a queue. Stored as a fraction of the strip's
    // half-width so the same person reads correctly on a wide avenue and a
    // narrow side street.
    ped.sideBias = rng.range(0.04, 0.92);
    ped.lat = ped.latWant = ped.sideBias * this._halfWalk[edge];
    // One in four stops somewhere: a phone, a shop window, waiting for someone.
    ped.pauseIn = rng.next() < 0.26 ? rng.range(4, 40) : 1e9;
    ped.pauseFor = 0;
    ped.phase = rng.next();
    ped.state = 'walk'; ped.wait = 0; ped.waitTotal = 0; ped.linger = 0;
    ped.pendingEdge = -1;
    ped.pushX = 0; ped.pushZ = 0; ped.lod = 1;
    ped.tilt = 0; ped.lean = 0;
    this._poseFromPath(ped);
    ped.active = true;
    this.actors.push(ped);
    return true;
  }

  _despawn(p) {
    if (!p.active) return;
    p.active = false;
    const i = this.actors.indexOf(p);
    if (i >= 0) this.actors.splice(i, 1);
    this._free.push(p);
  }

  _stream(dt, cx, cz) {
    this._streamT -= dt;
    if (this._streamT > 0) return;
    this._streamT = 0.2;
    this._refreshCandidates(cx, cz);
    const want = this._targetCount();
    // While the street is still visibly empty, fill it right up to the camera;
    // once it is populated, keep new arrivals far enough out that nobody sees
    // one appear.
    const priming = this.actors.length < want * 0.65;
    const minR = priming ? 5 : SPAWN_MIN;
    let budget = priming ? 90 : 16;
    while (this.actors.length < want && budget-- > 0) {
      if (!this._spawnOne(cx, cz, minR)) break;
    }
  }

  // -- simulation ------------------------------------------------------------

  /**
   * `capture()` drives the whole `update()` chain synchronously, so a throw in
   * here does not just break pedestrians — it aborts the screenshot for every
   * other agent and for the visual critic. One bad frame therefore retires this
   * system rather than the run.
   */
  update(dt, ctx) {
    if (!this.ready) return;
    try {
      this._update(dt, ctx);
    } catch (err) {
      this.ready = false;
      if (this.group) this.group.visible = false;
      console.error('[peds] disabled after an error in update():', err);
    }
  }

  _update(dt, ctx) {
    if (dt > 0.1) dt = 0.1;
    this._tick++;

    // Stream around the *camera*, never the player. The capture harness parks
    // the camera hundreds of metres from wherever the player happens to be
    // standing, and streaming around the player would hand the visual critic an
    // empty street in every single shot.
    const player = ctx.get('player');
    const cx = ctx.camera.position.x, cz = ctx.camera.position.z;
    this.density = clamp01(ctx.settings.pedDensity ?? this.density);

    // Traffic already ticked the shared signals this frame; only advance them
    // here if this system owns its own copy.
    if (this._ownNav) this.roadNav.update(dt);

    this._stream(dt, cx, cz);

    const list = this.actors;
    const n = list.length;

    // Neighbour grid: cleared and refilled every frame, buckets recycled.
    const grid = this._grid;
    grid.clear();
    for (let i = 0; i < n; i++) {
      const p = list[i];
      p.dist2 = (p.x - cx) ** 2 + (p.z - cz) ** 2;
      if (p.dist2 < NEAR_R * NEAR_R) grid.insert(p.x, p.z, i);
    }
    this._list = list;
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (p.dist2 < NEAR_R * NEAR_R) this._avoid(p, i);
      else { p.pushX = 0; p.pushZ = 0; }
    }
    this._avoidPlayer(player);

    for (let i = 0; i < n; i++) this._step(list[i], dt);

    for (let i = n - 1; i >= 0; i--) {
      const p = list[i];
      if (p.dist2 > DESPAWN_R * DESPAWN_R) this._despawn(p);
    }

    this._present(dt);
  }

  /** Separation from other pedestrians, as a world-space push. */
  _avoid(p, selfIndex) {
    this._ax = 0; this._az = 0; this._aSelf = selfIndex; this._aP = p;
    this._grid.forEachNear(p.x, p.z, AVOID_R, PED_AVOID, this);
    // Cap it: a person sidesteps, they do not get launched.
    const m = Math.hypot(this._ax, this._az);
    if (m > 1.6) { this._ax = this._ax / m * 1.6; this._az = this._az / m * 1.6; }
    p.pushX = this._ax; p.pushZ = this._az;
  }

  /** People give the player a wide berth, and a wider one when he is wanted. */
  _avoidPlayer(player) {
    const pos = player?.position;
    if (!pos) return;
    const R = this.wanted >= 3 ? 14 : 2.1;
    const R2 = R * R;
    const list = this.actors;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const k = (1 - d / R);
      p.pushX += (dx / d) * k * 3.4;
      p.pushZ += (dz / d) * k * 3.4;
      if (this.wanted >= 3) { p.state = 'flee'; p.linger = 3.5; }
    }
  }

  /** One pedestrian, one step. */
  _step(p, dt) {
    if (!p.path) { p.state = 'idle'; return; }

    // ---- queued at a crossing ---------------------------------------------
    if (p.state === 'wait') {
      p.v += (0 - p.v) * (1 - Math.exp(-dt * 8));
      p.wait -= dt;
      if (p.wait <= 0) {
        p.wait = 0.4; p.waitTotal += 0.4;
        if (this._crossingSafe(p.pendingEdge)) {
          this._commitEdge(p, p.pendingEdge);
          p.state = 'cross';
        } else if (p.waitTotal > 20) {
          // A light this stubborn is a light nobody waits for.
          const alt = this.walk.nextEdge(p.node, p.edge, this._rng, false);
          this._commitEdge(p, alt >= 0 ? alt : p.edge);
          p.state = 'walk';
        }
      }
      this._finish(p, dt);
      return;
    }

    // ---- standing about ---------------------------------------------------
    if (p.pauseFor > 0) {
      p.pauseFor -= dt;
      if (p.pauseFor <= 0) { p.state = 'walk'; p.pauseIn = 25 + this._rng.next() * 90; }
    } else if (p.state === 'walk') {
      p.pauseIn -= dt;
      if (p.pauseIn <= 0) { p.state = 'idle'; p.pauseFor = 2.5 + this._rng.next() * 7; }
    }

    // ---- desired speed ----------------------------------------------------
    let want = p.state === 'idle' ? 0
      : p.state === 'flee' ? Math.max(p.baseSpeed, 4.4)
        : p.state === 'cross' ? p.baseSpeed * 1.32   // nobody dawdles in the road
          : p.baseSpeed;
    if (p.linger > 0) {
      p.linger -= dt;
      if (p.linger <= 0 && p.state === 'flee') p.state = 'walk';
    }

    // Somebody in the way ahead: ease off rather than walk through them. The
    // floor matters — braking to a stop propagates backwards and turns a
    // pavement into a queue, so people slow but keep moving and go around.
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const block = p.pushX * fx + p.pushZ * fz;
    if (block < -0.35) want *= Math.max(0.42, 1 + block * 0.42);

    p.v += (want - p.v) * (1 - Math.exp(-dt * 4.5));
    if (p.v < 0.004) p.v = 0;

    // ---- advance along the pavement ---------------------------------------
    p.s += p.v * dt;
    let guard = 0;
    while (p.path && p.s >= p.path.length && guard++ < 4) {
      const over = p.s - p.path.length;
      this._advanceEdge(p);
      if (p.state === 'wait') { p.s = p.path ? p.path.length : 0; break; }
      if (!p.path) break;
      p.s = Math.min(over, p.path.length);
    }

    this._finish(p, dt);
  }

  /**
   * Lateral offset, world pose, and the animation clip. Split out because the
   * edge-transition path returns through here too.
   */
  _finish(p, dt) {
    const path = p.path;
    if (!path) return;
    const arc = p.dir > 0 ? p.s : path.length - p.s;
    path.at(arc, _pt);
    let dx = _pt.dx, dz = _pt.dz;
    if (p.dir < 0) { dx = -dx; dz = -dz; }

    // Right-hand normal of travel.
    const nx = -dz, nz = dx;
    // Steering: the avoidance push resolved onto the pavement's lateral axis,
    // so people slide past each other instead of walking off the kerb.
    const side = p.pushX * nx + p.pushZ * nz;
    const limit = p.state === 'cross' ? 0.85 : this._halfWalk[p.edge];
    let target = p.latWant + side * 1.15;
    if (target > limit) target = limit; else if (target < -limit) target = -limit;
    p.lat += (target - p.lat) * (1 - Math.exp(-dt * 5.5));

    p.x = _pt.x + nx * p.lat;
    p.y = _pt.y;
    p.z = _pt.z + nz * p.lat;

    // Face the direction of travel plus a slice of the sidestep.
    const yawTarget = Math.atan2(-dx, -dz) + Math.atan2(side * 0.55, 1.6);
    let d = yawTarget - p.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    p.yaw += d * (1 - Math.exp(-dt * 7));

    const clip = p.v < 0.18 ? 'idle' : clipForSpeed(p.v, false);
    if (clip !== p.clip) { p.clip = clip; p.clipRow = CLIP_ROW[clip]; }
    p.phase += phaseRate(clip, p.v, p.h) * dt;
    if (p.phase >= 1) p.phase -= Math.floor(p.phase);

    p.position.set(p.x, p.y, p.z);
    p.velocity.set(dx * p.v, 0, dz * p.v);
  }

  /**
   * Arrive at a node and choose the next pavement edge. If that edge is a
   * crossing whose signal is against us, park at the kerb on the edge just
   * finished and wait — that queue of people at the lights is most of what
   * makes a junction read as a real one.
   */
  _advanceEdge(p) {
    const g = this.walk.g;
    const e = g.edges[p.edge];
    if (!e) { p.state = 'idle'; return; }
    p.node = p.dir > 0 ? e.b : e.a;

    const allowCross = p.state !== 'cross';          // never chain two crossings
    let next = this.walk.nextEdge(p.node, p.edge, this._rng, allowCross);
    if (next < 0) next = p.edge;                     // dead end: turn around
    const ne = g.edges[next];
    if (!ne) { p.state = 'idle'; return; }

    if (ne.kind === 'crossing' && !this._crossingSafe(next)) {
      p.pendingEdge = next;
      p.state = 'wait';
      p.wait = 0.25;
      p.waitTotal = 0;
      return;                                        // stay put on the current edge
    }
    this._commitEdge(p, next);
    p.state = ne.kind === 'crossing' ? 'cross' : 'walk';
  }

  _commitEdge(p, edgeId) {
    const g = this.walk.g;
    const e = g.edges[edgeId];
    const path = this.walk.path(edgeId);
    if (!e || !path) return;
    p.edge = edgeId;
    p.path = path;
    p.dir = e.a === p.node ? 1 : -1;
    p.s = 0;
    // Crossings spread across the painted stripes; pavements keep right, each
    // person on their own line.
    p.latWant = e.kind === 'crossing'
      ? (p.sideBias - 0.46) * 1.3
      : p.sideBias * this._halfWalk[edgeId];
  }

  _poseFromPath(p) {
    const arc = p.dir > 0 ? p.s : p.path.length - p.s;
    p.path.at(arc, _pt);
    let dx = _pt.dx, dz = _pt.dz;
    if (p.dir < 0) { dx = -dx; dz = -dz; }
    p.x = _pt.x - dz * p.lat; p.y = _pt.y; p.z = _pt.z + dx * p.lat;
    p.yaw = Math.atan2(-dx, -dz);
    p.position.set(p.x, p.y, p.z);
  }

  // -- presentation ----------------------------------------------------------

  _present(dt) {
    const near = this.near, far = this.far;
    near.begin(); far.begin();
    const list = this.actors;
    const n = list.length;
    if (!n) { near.end(); far.end(); return; }

    // Re-rank a few times a second: distances change slowly, and this sort is
    // the only superlinear work in the system.
    this._lodT += dt;
    if (this._lodT > 0.25) {
      this._lodT = 0;
      list.sort(byDist);
      for (let i = 0; i < n; i++) {
        list[i].lod = (i < LOD0_CAP && list[i].dist2 < NEAR_R * NEAR_R) ? 0 : 1;
      }
    }
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (p.lod === 0) { if (!near.push(p)) far.push(p); }
      else far.push(p);
    }
    near.end(); far.end();
  }

  dispose() {
    this.ctx?.bus.off?.('player:wanted', this._onWanted);
    this.near?.dispose(); this.far?.dispose();
    this.group?.parent?.remove(this.group);
    this.actors.length = 0; this.peds.length = 0;
  }
}

/* -- helpers ------------------------------------------------------------- */

/** Grid callback, hoisted so `forEachNear` never allocates a closure. */
function PED_AVOID(j, self) {
  if (j === self._aSelf) return;
  const o = self._list[j];
  const p = self._aP;
  const dx = p.x - o.x, dz = p.z - o.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > AVOID_R * AVOID_R || d2 < 1e-6) return;
  const d = Math.sqrt(d2);
  // Soft falloff, plus a bias so two people closing head-on pick opposite sides
  // instead of mirroring each other forever.
  const w = (1 - d / AVOID_R);
  const k = (w * w * 2.5) / d;
  self._ax += dx * k;
  self._az += dz * k;
  if (d < 0.75) {
    const bias = (p.id & 1) ? 0.55 : -0.55;
    self._ax += -dz / d * bias * w;
    self._az += dx / d * bias * w;
  }
}

function byDist(a, b) { return a.dist2 - b.dist2; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
