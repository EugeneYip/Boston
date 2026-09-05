import { PROFILE as ROAD_PROFILE } from '../world/RoadNetwork.js';

/**
 * Navigation — the shared routing layer under Traffic and Pedestrians.
 *
 * This module owns the answers to three questions that both AI systems ask
 * constantly and that nothing else in the codebase answers correctly:
 *
 *  1. **Where exactly is a lane?**  `city.roads.laneCenter()` lays every lane of a
 *     one-way street to the *right* of the centreline, so a three-lane one-way ends
 *     up with its outer lane 8.25 m off centre on a carriageway that is only
 *     5.65 m wide — cars would drive down the pavement. `laneOffset()` here
 *     reproduces the cross-section `Roads.js` actually paints, so a car sits on the
 *     asphalt between the lines it can see.
 *  2. **Where do I go next?**  Successor selection across a junction, honouring
 *     one-way direction (`oneway: -1` means b->a even though the paint is
 *     symmetric), refusing U-turns except at dead ends, and preferring to carry
 *     straight on.
 *  3. **May I go now?**  Traffic signals with real phases, and a single-slot
 *     junction reservation for everything unsignalised.
 *
 * Everything is allocation-free after `build()`. Lane polylines are baked once
 * into flat `Float32Array`s; queries write into caller-supplied scratch objects.
 */

/** Mirror of `RoadNetwork.PROFILE`, used only if that import ever goes missing. */
const FALLBACK_PROFILE = {
  highway:  { lane: 3.65, shoulder: 2.4, walk: 0.0, kerb: 0.16, speed: 27.0 },
  arterial: { lane: 3.50, shoulder: 0.7, walk: 3.6, kerb: 0.15, speed: 13.4 },
  street:   { lane: 3.30, shoulder: 0.5, walk: 2.7, kerb: 0.15, speed: 11.2 },
  alley:    { lane: 2.60, shoulder: 0.0, walk: 1.0, kerb: 0.10, speed: 6.7 },
};

export function profileFor(type) {
  const p = (ROAD_PROFILE && ROAD_PROFILE[type]) || FALLBACK_PROFILE[type];
  return p || FALLBACK_PROFILE.street;
}

/** Deterministic xorshift32 — captures must be reproducible frame to frame. */
export class Rng {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return (this.next() * n) | 0; }
  pick(arr) { return arr[(this.next() * arr.length) | 0]; }
}

/* ------------------------------------------------------------------------- */
/*  Spatial hash                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Uniform grid over the XZ plane. Integer keys, recycled bucket arrays, so a
 * full rebuild every frame costs no allocation once it is warm.
 */
export class Grid {
  constructor(cell = 24) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.buckets = new Map();
  }
  clear() { for (const a of this.buckets.values()) a.length = 0; }
  _key(gx, gz) { return ((gx + 4096) << 13) + (gz + 4096); }
  insert(x, z, id) {
    const gx = Math.floor(x * this.inv), gz = Math.floor(z * this.inv);
    const k = this._key(gx, gz);
    let a = this.buckets.get(k);
    if (!a) this.buckets.set(k, a = []);
    a.push(id);
  }
  /** Visit every id in the cells overlapping the square of half-size `r`. */
  forEachNear(x, z, r, fn, arg) {
    const x0 = Math.floor((x - r) * this.inv), x1 = Math.floor((x + r) * this.inv);
    const z0 = Math.floor((z - r) * this.inv), z1 = Math.floor((z + r) * this.inv);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const a = this.buckets.get(this._key(gx, gz));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) fn(a[i], arg);
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/*  Baked polylines                                                           */
/* ------------------------------------------------------------------------- */

/**
 * A drivable/walkable polyline with cumulative arc length and a per-sample
 * curvature speed cap. Positions live in one flat array; nothing here allocates
 * once it is built.
 */
export class Path {
  constructor(pts) {
    const n = pts.length;
    this.n = n;
    this.p = new Float32Array(n * 3);
    this.cum = new Float32Array(n);
    this.vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.p[i * 3] = pts[i].x; this.p[i * 3 + 1] = pts[i].y; this.p[i * 3 + 2] = pts[i].z;
      if (i > 0) {
        const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
        this.cum[i] = this.cum[i - 1] + Math.hypot(dx, dz);
      }
    }
    this.length = this.cum[n - 1] || 0;
    this._bakeCurvature();
  }

  /** Lateral-acceleration limit turned into a per-vertex speed cap. */
  _bakeCurvature(aLat = 3.6) {
    const p = this.p, n = this.n;
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) { this.vmax[i] = 999; continue; }
      const ax = p[(i - 1) * 3], az = p[(i - 1) * 3 + 2];
      const bx = p[i * 3], bz = p[i * 3 + 2];
      const cx = p[(i + 1) * 3], cz = p[(i + 1) * 3 + 2];
      const d1 = Math.hypot(bx - ax, bz - az), d2 = Math.hypot(cx - bx, cz - bz);
      const d3 = Math.hypot(cx - ax, cz - az);
      // Menger curvature: 4 * area / (|ab||bc||ca|)
      const area2 = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
      const denom = d1 * d2 * d3;
      const k = denom > 1e-4 ? (2 * area2) / denom : 0;
      this.vmax[i] = k > 1e-4 ? Math.min(999, Math.sqrt(aLat / k)) : 999;
    }
    // Smear the cap backwards so a car slows *before* the bend, not in it.
    for (let i = n - 2; i >= 0; i--) {
      if (this.vmax[i + 1] < this.vmax[i]) {
        const d = this.cum[i + 1] - this.cum[i];
        const v = Math.sqrt(this.vmax[i + 1] * this.vmax[i + 1] + 2 * 2.2 * d);
        if (v < this.vmax[i]) this.vmax[i] = v;
      }
    }
  }

  /**
   * Exact nearest arc length to (x, z), by projecting onto every segment.
   *
   * Callers used to seed a short local search with `nearestEdge().t * length`.
   * That quietly assumes a lane runs the same way as the edge it was offset
   * from, and half of them do not: a reverse-direction lane measures arc length
   * from the other end, so the seed arrives mirrored -- `L - s`. On edge 314
   * (432.3 m) a player standing dead on lane 2514 seeds at 174 m when the truth
   * is 258 m, and a +-8 m refinement cannot climb out of an 84 m hole, so the
   * caller concluded the point lay 76 m off the lane and dropped it. A lane is
   * only a couple of dozen points; solve it exactly instead of guessing.
   */
  nearestS(x, z) {
    const p = this.p, n = this.n;
    let bestS = 0, bestD = Infinity;
    for (let i = 0; i < n - 1; i++) {
      const ax = p[i * 3], az = p[i * 3 + 2];
      const vx = p[(i + 1) * 3] - ax, vz = p[(i + 1) * 3 + 2] - az;
      const L2 = vx * vx + vz * vz;
      let u = L2 > 1e-9 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = x - (ax + vx * u), dz = z - (az + vz * u);
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestS = this.cum[i] + u * (this.cum[i + 1] - this.cum[i]); }
    }
    return bestS;
  }

  /** Segment index containing arc length `s`. */
  index(s) {
    const c = this.cum;
    let lo = 0, hi = this.n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * Write position, unit tangent and mesh yaw at arc length `s` into `out`.
   *
   * `rotY` is a THREE Y-rotation, not a compass bearing. A Y-rotation of theta
   * takes local -Z to `(-sin t, -cos t)`, so facing `(dx, dz)` needs
   * `atan2(-dx, -dz)`. `RoadNetwork.sample().heading` uses the *other*
   * convention (compass, `atan2(dx, -dz)`); the two differ by a sign and mixing
   * them mirrors every car about the north axis.
   */
  at(s, out) {
    const n = this.n, p = this.p, c = this.cum;
    if (s <= 0) s = 0;
    else if (s >= this.length) s = this.length;
    const i = this.index(s);
    const j = Math.min(n - 1, i + 1);
    const seg = c[j] - c[i];
    const f = seg > 1e-5 ? (s - c[i]) / seg : 0;
    const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
    const bx = p[j * 3], by = p[j * 3 + 1], bz = p[j * 3 + 2];
    out.x = ax + (bx - ax) * f;
    out.y = ay + (by - ay) * f;
    out.z = az + (bz - az) * f;
    let dx = bx - ax, dz = bz - az;
    if (dx * dx + dz * dz < 1e-8 && i > 0) {
      dx = bx - p[(i - 1) * 3]; dz = bz - p[(i - 1) * 3 + 2];
    }
    const L = Math.hypot(dx, dz) || 1;
    out.dx = dx / L; out.dz = dz / L;
    out.rotY = Math.atan2(-out.dx, -out.dz);
    return out;
  }

  /** Curvature speed cap looking `ahead` metres past `s`. */
  speedCap(s, ahead = 0) {
    const i = this.index(Math.min(this.length, s + ahead));
    return this.vmax[i];
  }
}

/** Offset a polyline sideways; positive is to the right of travel. */
export function offsetPolyline(pts, off, out) {
  out.length = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    out.push({ x: pts[i].x - dz * off, y: pts[i].y, z: pts[i].z + dx * off });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/*  Traffic signals                                                           */
/* ------------------------------------------------------------------------- */

export const GREEN = 0, YELLOW = 1, RED = 2;

/** Probability that a pedestrian arriving at a junction chooses to cross. */
const CROSS_CHANCE = 0.24;

/**
 * Two-phase signals on the junctions that deserve them. Arms are grouped by
 * bearing modulo 180 degrees, which is exactly how a real four-way works: the
 * two halves of one street share a phase.
 */
class Signal {
  constructor(nodeId, arms, offset) {
    this.node = nodeId;
    this.arms = arms;                 // [{ edgeId, bearing, group }]
    this.t = offset;
    this.green0 = 13.5; this.green1 = 10.5; this.yellow = 3.2; this.allRed = 1.6;
    this.cycle = this.green0 + this.yellow + this.allRed
               + this.green1 + this.yellow + this.allRed;
    this.state0 = RED; this.state1 = RED;
  }
  update(dt) {
    this.t += dt;
    let t = this.t % this.cycle;
    const a = this.green0, b = a + this.yellow, c = b + this.allRed;
    const d = c + this.green1, e = d + this.yellow;
    if (t < a) { this.state0 = GREEN; this.state1 = RED; }
    else if (t < b) { this.state0 = YELLOW; this.state1 = RED; }
    else if (t < c) { this.state0 = RED; this.state1 = RED; }
    else if (t < d) { this.state0 = RED; this.state1 = GREEN; }
    else if (t < e) { this.state0 = RED; this.state1 = YELLOW; }
    else { this.state0 = RED; this.state1 = RED; }
  }
  stateFor(edgeId) {
    const arms = this.arms;
    for (let i = 0; i < arms.length; i++) {
      if (arms[i].edgeId === edgeId) return arms[i].group === 0 ? this.state0 : this.state1;
    }
    return GREEN;
  }
}

/* ------------------------------------------------------------------------- */
/*  Road navigation                                                           */
/* ------------------------------------------------------------------------- */

const _tmpPts = [];
const _laneInfo = { off: 0, dir: 1, ok: true };
const _laneInfoB = { off: 0, dir: 1, ok: true };

export default class Navigation {
  /**
   * @param {object} city the published `city` contract
   */
  constructor(city) {
    this.city = city;
    this.roads = city.roads;
    this.edges = city.roads.edges;
    this.nodes = city.roads.nodes;
    this.rng = new Rng(0x5eed1234);

    /** laneKey -> Path. laneKey = edgeId * 8 + laneIndex. */
    this.lanes = new Map();
    /** nodeId -> Signal|null */
    this.signals = new Map();
    /** nodeId -> { by: agentId, until: seconds } */
    this.claims = new Map();
    /** nodeId -> radius of the junction box, metres */
    this.nodeRadius = new Float32Array(this.nodes.length);
    /** Directed lanes leaving a node: nodeId -> [laneKey,...] */
    this.exits = new Map();
    this.time = 0;
    this._signalList = [];
    this._drivable = [];
  }

  static laneKey(edgeId, lane) { return edgeId * 8 + lane; }
  static keyEdge(k) { return (k / 8) | 0; }
  static keyLane(k) { return k % 8; }

  build() {
    this._bakeNodes();
    this._bakeSignals();
    this._bakeExits();
    return this;
  }

  // -- cross-section ---------------------------------------------------------

  /** Forward (a->b) and backward lane counts, matching what Roads.js paints. */
  laneSplit(e) {
    const fwd = e.oneway ? e.lanes : Math.ceil(e.lanes / 2);
    return { fwd, bwd: e.lanes - fwd };
  }

  /**
   * Lateral offset of a lane's centre from the edge centreline, positive to the
   * right of a->b, plus the direction that lane is driven in.
   *
   * Lane indices are ordered kerb-outwards in travel direction: 0 is the
   * right-hand (slow) lane. Forward lanes come first, then backward lanes.
   */
  laneInfo(e, laneIndex, out = _laneInfo) {
    const laneW = profileFor(e.type).lane;
    const { fwd, bwd } = this.laneSplit(e);
    // Roads.js recentres the painted section on the edge centreline.
    const shift = ((bwd - fwd) * laneW) / 2;
    if (laneIndex < fwd) {
      // `oneway: -1` is authored b->a, but the paint is symmetric either way, so
      // only the travel direction (and therefore which side is the kerb) flips.
      const dir = e.oneway === -1 ? -1 : 1;
      out.off = dir > 0
        ? shift + (fwd - laneIndex - 0.5) * laneW
        : shift + (laneIndex + 0.5) * laneW;
      out.dir = dir; out.ok = true;
      return out;
    }
    const j = laneIndex - fwd;
    if (j >= bwd) { out.off = 0; out.dir = 1; out.ok = false; return out; }
    out.off = shift - (bwd - j - 0.5) * laneW;
    out.dir = -1; out.ok = true;
    return out;
  }

  /** Number of usable lanes on an edge (capped at 7 so laneKey packing holds). */
  laneCount(e) { return Math.min(7, Math.max(1, e.lanes | 0)); }

  /** Lanes on `e` whose travel direction leaves `nodeId`. */
  lanesLeaving(e, nodeId, out) {
    out.length = 0;
    const n = this.laneCount(e);
    for (let i = 0; i < n; i++) {
      const info = this.laneInfo(e, i);
      if (!info.ok) continue;
      const from = info.dir > 0 ? e.a : e.b;
      if (from === nodeId) out.push(Navigation.laneKey(e.id, i));
    }
    return out;
  }

  /** The node a directed lane starts at / ends at. */
  laneFrom(k) {
    const e = this.edges[Navigation.keyEdge(k)];
    return this.laneInfo(e, Navigation.keyLane(k)).dir > 0 ? e.a : e.b;
  }
  laneTo(k) {
    const e = this.edges[Navigation.keyEdge(k)];
    return this.laneInfo(e, Navigation.keyLane(k)).dir > 0 ? e.b : e.a;
  }

  /** Baked centreline for a directed lane, in travel direction. Cached. */
  lanePath(k) {
    let path = this.lanes.get(k);
    if (path) return path;
    const edgeId = Navigation.keyEdge(k), laneIndex = Navigation.keyLane(k);
    const e = this.edges[edgeId];
    if (!e) return null;
    const info = this.laneInfo(e, laneIndex, _laneInfo);
    const off = info.off, dir = info.dir;
    const src = e.pts || this._samplePts(edgeId);
    if (!src || src.length < 2) return null;
    const pts = offsetPolyline(src, off, _tmpPts).map(p => ({ x: p.x, y: p.y, z: p.z }));
    if (dir < 0) pts.reverse();
    path = new Path(pts);
    path.laneKey = k;
    path.edgeId = edgeId;
    path.speed = e.speed || profileFor(e.type).speed;
    path.type = e.type;
    path.name = e.name;
    path.fromNode = dir > 0 ? e.a : e.b;
    path.toNode = dir > 0 ? e.b : e.a;
    this.lanes.set(k, path);
    return path;
  }

  /** Fallback when an edge does not expose its shape points. */
  _samplePts(edgeId) {
    const e = this.edges[edgeId];
    const n = Math.max(2, Math.ceil((e.length || 40) / 12));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const s = this.roads.sample(edgeId, i / n);
      out.push({ x: s.x, y: s.y, z: s.z });
    }
    return out;
  }

  // -- junctions -------------------------------------------------------------

  _bakeNodes() {
    for (const n of this.nodes) {
      let r = 5;
      const arms = n.edges || this.roads.outgoing(n.id);
      for (const id of arms) {
        const e = this.edges[id];
        if (!e) continue;
        const half = e.halfRoad || (e.width ? e.width / 2 : 6);
        if (half + 1.6 > r) r = half + 1.6;
      }
      this.nodeRadius[n.id] = Math.min(r, 16);
    }
  }

  /** Plain math angle of the arm leaving `nodeId`. Only used for comparisons. */
  _bearing(e, nodeId) {
    const pts = e.pts;
    let p0, p1;
    if (pts && pts.length >= 2) {
      if (e.a === nodeId) { p0 = pts[0]; p1 = pts[1]; }
      else { p0 = pts[pts.length - 1]; p1 = pts[pts.length - 2]; }
    } else {
      p0 = this.roads.sample(e.id, e.a === nodeId ? 0 : 1);
      p1 = this.roads.sample(e.id, e.a === nodeId ? 0.1 : 0.9);
    }
    return Math.atan2(p1.z - p0.z, p1.x - p0.x);
  }

  _bakeSignals() {
    for (const n of this.nodes) {
      const armIds = n.edges || this.roads.outgoing(n.id);
      if (!armIds || armIds.length < 3) continue;
      let hasArterial = false, hasHighway = false;
      for (const id of armIds) {
        const e = this.edges[id];
        if (!e) continue;
        if (e.type === 'arterial') hasArterial = true;
        if (e.type === 'highway') hasHighway = true;
      }
      if (hasHighway || !hasArterial) continue;      // ramps and back streets: priority rules

      const arms = [];
      let ref = null;
      for (const id of armIds) {
        const e = this.edges[id];
        if (!e || e.type === 'alley') continue;
        const b = this._bearing(e, n.id);
        if (ref === null) ref = b;
        // Two arms of the same street point opposite ways, so compare mod PI.
        let d = (b - ref) % Math.PI;
        if (d < 0) d += Math.PI;
        d = Math.min(d, Math.PI - d);
        arms.push({ edgeId: id, bearing: b, group: d < Math.PI / 4 ? 0 : 1 });
      }
      if (arms.length < 3) continue;
      let g0 = 0, g1 = 0;
      for (const a of arms) (a.group === 0 ? g0++ : g1++);
      if (g0 === 0 || g1 === 0) continue;            // all one axis: nothing to phase
      const sig = new Signal(n.id, arms, (n.id * 7.31) % 29);
      this.signals.set(n.id, sig);
      this._signalList.push(sig);
    }
  }

  _bakeExits() {
    const scratch = [];
    for (const n of this.nodes) {
      const out = [];
      const armIds = n.edges || this.roads.outgoing(n.id);
      for (const id of armIds || []) {
        const e = this.edges[id];
        if (!e) continue;
        this.lanesLeaving(e, n.id, scratch);
        for (let i = 0; i < scratch.length; i++) out.push(scratch[i]);
      }
      this.exits.set(n.id, out);
    }
    // Every directed lane that something can actually drive on.
    for (const e of this.edges) {
      const n = this.laneCount(e);
      for (let i = 0; i < n; i++) {
        const info = this.laneInfo(e, i);
        if (!info.ok) continue;
        if (e.type === 'alley' && e.lanes < 2) continue;
        this._drivable.push(Navigation.laneKey(e.id, i));
      }
    }
  }

  /** Every directed lane a vehicle may legally use. */
  drivableLanes() { return this._drivable; }

  /**
   * Pick the lane to take after `fromKey`, preferring to carry straight on and
   * refusing a U-turn unless the junction is a dead end.
   * @returns {number} laneKey, or -1 if the road simply ends
   */
  nextLane(fromKey, rng) {
    const node = this.laneTo(fromKey);
    const outs = this.exits.get(node);
    if (!outs || !outs.length) return -1;
    const fromEdge = Navigation.keyEdge(fromKey);
    const inBearing = this._laneOutBearing(fromKey);

    let best = -1, bestScore = -Infinity, uturn = -1;
    for (let i = 0; i < outs.length; i++) {
      const k = outs[i];
      const e = this.edges[Navigation.keyEdge(k)];
      if (Navigation.keyEdge(k) === fromEdge) { if (uturn < 0) uturn = k; continue; }
      const b = this._laneInBearing(k);
      let turn = b - inBearing;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      if (Math.abs(turn) > 2.44) continue;            // that is a U-turn by another name
      // Straight on is strongly preferred; big roads pull traffic; a little noise
      // stops every car at a junction making the same choice.
      let score = 3.2 - Math.abs(turn) * 1.9;
      if (e.type === 'arterial') score += 0.9;
      else if (e.type === 'highway') score += 0.5;
      else if (e.type === 'alley') score -= 2.2;
      score += (rng ? rng.next() : Math.random()) * 1.5;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best >= 0) return best;
    return uturn;                                     // dead end: turn around
  }

  _laneOutBearing(k) {
    const p = this.lanePath(k);
    if (!p || p.n < 2) return 0;
    const i = p.n - 1;
    return Math.atan2(p.p[i * 3 + 2] - p.p[(i - 1) * 3 + 2], p.p[i * 3] - p.p[(i - 1) * 3]);
  }
  _laneInBearing(k) {
    const p = this.lanePath(k);
    if (!p || p.n < 2) return 0;
    return Math.atan2(p.p[5] - p.p[2], p.p[3] - p.p[0]);
  }

  /** Sibling lane on the same edge and direction, `delta` lanes over. */
  siblingLane(k, delta) {
    const edgeId = Navigation.keyEdge(k), lane = Navigation.keyLane(k);
    const e = this.edges[edgeId];
    if (!e) return -1;
    const target = lane + delta;
    if (target < 0 || target >= this.laneCount(e)) return -1;
    const a = this.laneInfo(e, lane, _laneInfo);
    const dirA = a.dir;
    const b = this.laneInfo(e, target, _laneInfoB);
    if (!b.ok || dirA !== b.dir) return -1;
    return Navigation.laneKey(edgeId, target);
  }

  // -- signals and right of way ---------------------------------------------

  update(dt) {
    this.time += dt;
    const list = this._signalList;
    for (let i = 0; i < list.length; i++) list[i].update(dt);
    // Expire stale junction claims so one wedged car cannot lock a crossing.
    if (this.claims.size) {
      for (const [node, c] of this.claims) {
        if (c.until < this.time) this.claims.delete(node);
      }
    }
  }

  /** GREEN / YELLOW / RED for a vehicle arriving at `node` along `edgeId`. */
  signalState(node, edgeId) {
    const s = this.signals.get(node);
    return s ? s.stateFor(edgeId) : GREEN;
  }
  hasSignal(node) { return this.signals.has(node); }

  /** Priority rank of an edge — higher wins at an unsignalised junction. */
  priority(e) {
    if (!e) return 0;
    if (e.type === 'highway') return 4;
    if (e.type === 'arterial') return 3;
    if (e.type === 'street') return 2;
    return 1;
  }

  /** Try to reserve a junction. Returns true if this agent may proceed. */
  claim(node, agentId, holdFor = 3.0) {
    const c = this.claims.get(node);
    if (c && c.by !== agentId && c.until > this.time) return false;
    if (c) { c.by = agentId; c.until = this.time + holdFor; }
    else this.claims.set(node, { by: agentId, until: this.time + holdFor });
    return true;
  }
  release(node, agentId) {
    const c = this.claims.get(node);
    if (c && c.by === agentId) this.claims.delete(node);
  }

  /**
   * Build a short junction connector from the end of one lane to the start of
   * the next, as a cubic laid along both tangents. Written into `outPath`
   * (a reusable `MutablePath`) so turning allocates nothing.
   */
  buildLink(fromKey, toKey, outPath) {
    const a = this.lanePath(fromKey), b = this.lanePath(toKey);
    if (!a || !b) return null;
    const ai = a.n - 1;
    const ax = a.p[ai * 3], ay = a.p[ai * 3 + 1], az = a.p[ai * 3 + 2];
    let atx = ax - a.p[(ai - 1) * 3], atz = az - a.p[(ai - 1) * 3 + 2];
    let L = Math.hypot(atx, atz) || 1; atx /= L; atz /= L;
    const bx = b.p[0], by = b.p[1], bz = b.p[2];
    let btx = b.p[3] - bx, btz = b.p[5] - bz;
    L = Math.hypot(btx, btz) || 1; btx /= L; btz /= L;

    const span = Math.hypot(bx - ax, bz - az);
    const h = Math.max(2.2, span * 0.55);
    const c1x = ax + atx * h, c1z = az + atz * h;
    const c2x = bx - btx * h, c2z = bz - btz * h;
    outPath.begin();
    const N = span < 3 ? 3 : span < 12 ? 6 : 9;
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      outPath.push(
        w0 * ax + w1 * c1x + w2 * c2x + w3 * bx,
        ay + (by - ay) * t,
        w0 * az + w1 * c1z + w2 * c2z + w3 * bz);
    }
    outPath.end();
    return outPath;
  }
}

/* ------------------------------------------------------------------------- */
/*  Mutable path — per-agent junction connectors, allocated once               */
/* ------------------------------------------------------------------------- */

export class MutablePath {
  constructor(cap = 12) {
    this.p = new Float32Array(cap * 3);
    this.cum = new Float32Array(cap);
    this.vmax = new Float32Array(cap);
    this.cap = cap;
    this.n = 0;
    this.length = 0;
  }
  begin() { this.n = 0; }
  push(x, y, z) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
  }
  end() {
    this.cum[0] = 0;
    for (let i = 1; i < this.n; i++) {
      const dx = this.p[i * 3] - this.p[(i - 1) * 3];
      const dz = this.p[i * 3 + 2] - this.p[(i - 1) * 3 + 2];
      this.cum[i] = this.cum[i - 1] + Math.hypot(dx, dz);
    }
    this.length = this.n ? this.cum[this.n - 1] : 0;
    Path.prototype._bakeCurvature.call(this, 3.0);
  }
  index(s) { return Path.prototype.index.call(this, s); }
  at(s, out) { return Path.prototype.at.call(this, s, out); }
  nearestS(x, z) { return Path.prototype.nearestS.call(this, x, z); }
  speedCap(s, ahead) { return Path.prototype.speedCap.call(this, s, ahead); }
}

/* ------------------------------------------------------------------------- */
/*  Sidewalk navigation                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The pedestrian graph. Same shape as the road graph but simpler: no lanes, no
 * direction, and the only rule is that a `crossing` link belongs to a junction
 * and may be shut by that junction's signal.
 */
export class WalkNav {
  constructor(city, roadNav) {
    this.city = city;
    this.g = city.sidewalks;
    this.roadNav = roadNav;
    this.paths = new Map();
    /** crossing edgeId -> road nodeId that governs it (or -1) */
    this.crossingNode = new Map();
    /** crossing edgeId -> the road edge it spans */
    this.crossingEdge = new Map();
    this.walkable = [];
  }

  build() {
    const g = this.g;
    if (!g) return this;
    for (const e of g.edges) {
      if (e.kind === 'crossing') {
        const mx = (e.pts[0].x + e.pts[e.pts.length - 1].x) * 0.5;
        const mz = (e.pts[0].z + e.pts[e.pts.length - 1].z) * 0.5;
        let bestNode = -1, bd = 40 * 40;
        for (const n of this.roadNav.nodes) {
          const d = (n.x - mx) ** 2 + (n.z - mz) ** 2;
          if (d < bd) { bd = d; bestNode = n.id; }
        }
        this.crossingNode.set(e.id, bestNode);
        const near = this.roadNav.roads.nearestEdge(mx, mz);
        this.crossingEdge.set(e.id, near ? near.edgeId : -1);
      } else if (e.kind === 'walk' && e.length > 8) {
        this.walkable.push(e.id);
      }
    }
    return this;
  }

  path(edgeId) {
    let p = this.paths.get(edgeId);
    if (p) return p;
    const e = this.g.edges[edgeId];
    if (!e || !e.pts || e.pts.length < 2) return null;
    p = new Path(e.pts);
    p.edgeId = edgeId;
    p.kind = e.kind;
    this.paths.set(edgeId, p);
    return p;
  }

  /** A crossing is walkable when the traffic it crosses is stopped. */
  crossingClear(edgeId) {
    const node = this.crossingNode.get(edgeId);
    if (node === undefined || node < 0) return true;
    if (!this.roadNav.hasSignal(node)) return true;   // unsignalised: peds just go
    const roadEdge = this.crossingEdge.get(edgeId);
    if (roadEdge === undefined || roadEdge < 0) return true;
    // Green for cars on the road being crossed means red for the pedestrian.
    return this.roadNav.signalState(node, roadEdge) === RED;
  }

  /**
   * Pick the next sidewalk edge at `node`, avoiding an immediate about-turn.
   *
   * Crossing the road is decided *first* and separately, on a coin flip. It has
   * to be: a crossing is one arm among several at every junction, so any scheme
   * that scores it against the pavement and corner links has to score it low
   * enough to stay a minority choice — and "low enough" turns out to be "below
   * the worst score a pavement link can draw", at which point it is not a
   * minority choice, it is an impossible one. Measured over 14 s of a 105-person
   * crowd with the previous weights: **zero** crossings taken, ever. Nobody
   * crossed a road in the entire city.
   */
  nextEdge(node, fromEdge, rng, allowCross = true) {
    const outs = this.g.outgoing(node);
    if (!outs || !outs.length) return -1;

    if (allowCross && rng.next() < CROSS_CHANCE) {
      let pick = -1, n = 0;
      for (let i = 0; i < outs.length; i++) {
        const id = outs[i];
        const e = this.g.edges[id];
        if (!e || e.kind !== 'crossing' || id === fromEdge) continue;
        if (rng.next() < 1 / ++n) pick = id;          // reservoir sample
      }
      if (pick >= 0) return pick;
    }

    let best = -1, bestScore = -Infinity, fallback = -1;
    for (let i = 0; i < outs.length; i++) {
      const id = outs[i];
      const e = this.g.edges[id];
      if (!e) continue;
      if (id === fromEdge) { fallback = id; continue; }
      if (e.kind === 'crossing') continue;            // already had its chance
      let score = rng.next() * 1.4;
      if (e.kind === 'walk') score += 1.6;
      else score += 1.1;                              // corner link
      if (score > bestScore) { bestScore = score; best = id; }
    }
    return best >= 0 ? best : fallback;
  }

  other(edgeId, node) {
    const e = this.g.edges[edgeId];
    if (!e) return -1;
    return e.a === node ? e.b : e.a;
  }
}
