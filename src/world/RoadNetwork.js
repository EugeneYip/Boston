import { geo } from '../core/Geo.js';
import { STREETS } from '../data/boston-geo.js';

/**
 * Turns hand-authored street polylines into a routable graph.
 *
 * The hard part in Boston is that nothing meets at right angles and the source
 * data is traced by hand, so crossings are never exactly coincident. The build
 * therefore does three passes: resample to terrain, find true segment-segment
 * crossings, then snap dangling endpoints onto whatever they were clearly meant
 * to join. Grade separation is respected — I-93 crossing over Surface Road at
 * +20 m does not become an intersection.
 */

const HASH = 40;                 // spatial hash cell, metres
const RESAMPLE = 20;             // max shape-point spacing along a street
const NODE_SNAP = 7;             // merge graph nodes closer than this
const END_SNAP = 21;             // pull a dangling endpoint onto a nearby street
const GRADE_SEP = 4.5;           // vertical clearance that suppresses a crossing

/**
 * Roadway cross-section by type, per side.
 *   lane     travel lane width
 *   park     kerbside parking lane (0 = no kerbside parking)
 *   shoulder gutter strip between the parking lane and the outer travel lane
 *   walk     pavement width
 * Boston streets park on both sides almost everywhere; without an explicit
 * parking lane a kerbside car has nowhere to sit but the outer travel lane.
 */
export const PROFILE = {
  highway:  { lane: 3.65, park: 0.0, shoulder: 2.4, walk: 0.0, kerb: 0.16, speed: 27.0 },
  arterial: { lane: 3.50, park: 2.5, shoulder: 0.3, walk: 3.6, kerb: 0.15, speed: 13.4 },
  street:   { lane: 3.30, park: 2.4, shoulder: 0.2, walk: 2.7, kerb: 0.15, speed: 11.2 },
  alley:    { lane: 5.00, park: 0.0, shoulder: 0.0, walk: 1.0, kerb: 0.10, speed: 6.7 },
};

const key = (x, z) => `${Math.floor(x / HASH)},${Math.floor(z / HASH)}`;

export default class RoadNetwork {
  constructor(terrain) {
    this.terrain = terrain;
    this.nodes = [];
    this.edges = [];
    this._nodeHash = new Map();
    this._segHash = new Map();     // populated after build, for nearestEdge
    this._out = new Map();
  }

  // -- construction ---------------------------------------------------------

  /** Resample one authored street to world space, following the terrain. */
  _prepare(st) {
    const raw = st.path.map(([la, lo]) => geo(la, lo));
    const T = this.terrain;
    // Per-authored-vertex elevation.
    const ry = raw.map((p, i) => {
      if (st.y) return st.y[i];
      const g = T.groundHeight(p.x, p.z);
      if (st.bridge) return g + (st.bridge[i] || 0) * (st.bridgeHeight || 10);
      return g;
    });
    const onGrade = !st.y && !st.bridge;

    const out = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(L / RESAMPLE));
      for (let s = 0; s < n; s++) {
        const t = s / n;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        out.push({ x, z, y: onGrade ? T.groundHeight(x, z) : ry[i] + (ry[i + 1] - ry[i]) * t });
      }
    }
    const last = raw[raw.length - 1];
    out.push({ x: last.x, z: last.z, y: ry[ry.length - 1] });

    // Smooth the elevation profile: a road cuts and fills, it does not follow
    // every ripple of the ground.
    if (onGrade) {
      const src = out.map(p => p.y);
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < out.length - 1; i++) {
          out[i].y = (src[i - 1] + src[i] * 2 + src[i + 1]) * 0.25;
        }
        for (let i = 0; i < out.length; i++) src[i] = out[i].y;
      }
    }

    const p = PROFILE[st.type];
    // Alleys and cobbled lanes are too narrow to park on legally.
    const park = st.width || st.surface === 'cobble' ? 0 : p.park;
    const halfRoad = (st.width ? st.width / 2
                               : (st.lanes * p.lane) / 2 + p.shoulder + park);
    return {
      name: st.name, type: st.type, lanes: st.lanes, oneway: st.oneway || 0,
      surface: st.surface || 'asphalt', mall: !!st.mall, bridged: !!(st.y || st.bridge),
      halfRoad, park, walk: st.surface === 'cobble' ? 1.4 : p.walk, kerb: p.kerb,
      speed: p.speed, pts: out, splits: [],
    };
  }

  /** Bucket every segment of every street for O(1) neighbourhood queries. */
  _hashSegments(streets) {
    const H = new Map();
    for (let si = 0; si < streets.length; si++) {
      const pts = streets[si].pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const x0 = Math.floor(Math.min(a.x, b.x) / HASH), x1 = Math.floor(Math.max(a.x, b.x) / HASH);
        const z0 = Math.floor(Math.min(a.z, b.z) / HASH), z1 = Math.floor(Math.max(a.z, b.z) / HASH);
        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            const k = `${cx},${cz}`;
            let arr = H.get(k); if (!arr) H.set(k, arr = []);
            arr.push(si, i);
          }
        }
      }
    }
    return H;
  }

  build() {
    const streets = STREETS.map(s => this._prepare(s));
    const H = this._hashSegments(streets);

    // --- pass 1: true crossings -------------------------------------------
    const seen = new Set();
    for (const list of H.values()) {
      for (let a = 0; a < list.length; a += 2) {
        for (let b = a + 2; b < list.length; b += 2) {
          const si = list[a], i = list[a + 1], sj = list[b], j = list[b + 1];
          if (si === sj) continue;
          const pk = si < sj ? `${si}:${i}:${sj}:${j}` : `${sj}:${j}:${si}:${i}`;
          if (seen.has(pk)) continue; seen.add(pk);
          this._cross(streets[si], i, streets[sj], j);
        }
      }
    }

    // --- pass 2: dangling endpoints that clearly meant to join -------------
    for (let si = 0; si < streets.length; si++) {
      const st = streets[si];
      for (const endIdx of [0, st.pts.length - 1]) {
        const p = st.pts[endIdx];
        let best = null;
        const cx = Math.floor(p.x / HASH), cz = Math.floor(p.z / HASH);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const list = H.get(`${cx + dx},${cz + dz}`); if (!list) continue;
          for (let a = 0; a < list.length; a += 2) {
            const sj = list[a]; if (sj === si) continue;
            const o = streets[sj], j = list[a + 1];
            const q0 = o.pts[j], q1 = o.pts[j + 1];
            const vx = q1.x - q0.x, vz = q1.z - q0.z;
            const L2 = vx * vx + vz * vz; if (L2 < 1e-6) continue;
            let t = ((p.x - q0.x) * vx + (p.z - q0.z) * vz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = q0.x + vx * t, qz = q0.z + vz * t;
            const d = Math.hypot(p.x - qx, p.z - qz);
            const dy = Math.abs(p.y - (q0.y + (q1.y - q0.y) * t));
            if (d < END_SNAP && dy < GRADE_SEP && (!best || d < best.d)) {
              best = { d, o, j, t, x: qx, z: qz };
            }
          }
        }
        if (best && best.d > 0.05) {
          // Move the endpoint onto the street it meets, and split that street.
          p.x = best.x; p.z = best.z;
          st.splits.push({ i: endIdx, t: 0 });
          best.o.splits.push({ i: best.j, t: best.t });
        }
      }
    }

    // --- pass 3: cut streets into edges at their split points --------------
    for (const st of streets) this._emit(st);

    this._index();
    return this;
  }

  /** Record a split on both streets if segments i and j actually cross. */
  _cross(A, i, B, j) {
    const p = A.pts[i], p2 = A.pts[i + 1], q = B.pts[j], q2 = B.pts[j + 1];
    const rx = p2.x - p.x, rz = p2.z - p.z;
    const sx = q2.x - q.x, sz = q2.z - q.z;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-7) return;                  // parallel
    const t = ((q.x - p.x) * sz - (q.z - p.z) * sx) / den;
    const u = ((q.x - p.x) * rz - (q.z - p.z) * rx) / den;
    if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return;
    const ya = p.y + (p2.y - p.y) * t, yb = q.y + (q2.y - q.y) * u;
    if (Math.abs(ya - yb) > GRADE_SEP) return;          // flyover, not a junction
    A.splits.push({ i, t });
    B.splits.push({ i: j, t: u });
  }

  _nodeAt(x, z, y) {
    const k = key(x, z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const arr = this._nodeHash.get(`${Math.floor(x / HASH) + dx},${Math.floor(z / HASH) + dz}`);
      if (!arr) continue;
      for (const id of arr) {
        const n = this.nodes[id];
        if (Math.abs(n.y - y) > GRADE_SEP) continue;
        if ((n.x - x) ** 2 + (n.z - z) ** 2 < NODE_SNAP * NODE_SNAP) return id;
      }
    }
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, y, edges: [] });
    let arr = this._nodeHash.get(k); if (!arr) this._nodeHash.set(k, arr = []);
    arr.push(id);
    return id;
  }

  /** Split one prepared street into graph edges at its recorded cut points. */
  _emit(st) {
    const cuts = st.splits
      .map(s => s.i + Math.min(1, Math.max(0, s.t)))
      .concat([0, st.pts.length - 1])
      .sort((a, b) => a - b);

    const at = (f) => {
      const i = Math.min(st.pts.length - 2, Math.floor(f));
      const t = f - i, a = st.pts[i], b = st.pts[i + 1];
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
               y: a.y + (b.y - a.y) * t };
    };

    let prev = 0;
    for (let c = 1; c < cuts.length; c++) {
      const f = cuts[c];
      if (f - prev < 0.02) continue;
      const pa = at(prev), pb = at(f);
      if (Math.hypot(pb.x - pa.x, pb.z - pa.z) < 4) { prev = f; continue; }

      const pts = [pa];
      for (let i = Math.ceil(prev + 1e-6); i < f - 1e-6; i++) pts.push(st.pts[i]);
      pts.push(pb);

      const a = this._nodeAt(pa.x, pa.z, pa.y);
      const b = this._nodeAt(pb.x, pb.z, pb.y);
      if (a === b) { prev = f; continue; }
      const na = this.nodes[a], nb = this.nodes[b];
      pts[0] = { x: na.x, y: na.y, z: na.z };
      pts[pts.length - 1] = { x: nb.x, y: nb.y, z: nb.z };

      const id = this.edges.length;
      const e = {
        id, a, b, name: st.name, type: st.type, lanes: st.lanes,
        oneway: st.oneway, width: st.halfRoad * 2, halfRoad: st.halfRoad,
        walk: st.walk, kerb: st.kerb, speed: st.speed, surface: st.surface,
        mall: st.mall, bridged: st.bridged, pts, length: 0, cum: [0],
        // Kerbside parking bay, for the props agent to line cars up in.
        parking: st.park > 0.5
          ? { width: st.park, offset: st.halfRoad - st.park * 0.5 } : null,
      };
      for (let i = 1; i < pts.length; i++) {
        e.length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        e.cum.push(e.length);
      }
      this.edges.push(e);
      this.nodes[a].edges.push(id);
      this.nodes[b].edges.push(id);
      prev = f;
    }
  }

  /** Build the lookup structures the public API needs. */
  _index() {
    for (const n of this.nodes) this._out.set(n.id, n.edges);
    for (const e of this.edges) {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const x0 = Math.floor(Math.min(a.x, b.x) / HASH), x1 = Math.floor(Math.max(a.x, b.x) / HASH);
        const z0 = Math.floor(Math.min(a.z, b.z) / HASH), z1 = Math.floor(Math.max(a.z, b.z) / HASH);
        for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
          const k = `${cx},${cz}`;
          let arr = this._segHash.get(k); if (!arr) this._segHash.set(k, arr = []);
          arr.push(e.id, i);
        }
      }
    }
  }

  // -- public API (see CONTRACTS.md) ---------------------------------------

  /**
   * Centreline of one lane, in travel direction.
   * Lanes 0..f-1 run a->b on the right of the centreline; the rest run b->a.
   * @param {number} edgeId @param {number} laneIndex @returns {{x,y,z}[]}
   */
  laneCenter(edgeId, laneIndex) {
    const e = this.edges[edgeId]; if (!e) return [];
    const { lane } = PROFILE[e.type];
    const fwd = e.oneway ? e.lanes : Math.ceil(e.lanes / 2);
    const back = laneIndex >= fwd;
    const k = back ? laneIndex - fwd : laneIndex;
    const off = (k + 0.5) * lane * (back ? -1 : 1);
    const out = this.offsetPolyline(e, off);
    if (back) out.reverse();
    return out;
  }

  /** Offset an edge's centreline sideways (positive = right of a->b). */
  offsetPolyline(e, off) {
    const p = e.pts, out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      out.push({ x: p[i].x - dz * off, y: p[i].y, z: p[i].z + dx * off });
    }
    return out;
  }

  /** Position and heading at parameter t along an edge. */
  sample(edgeId, t) {
    const e = this.edges[edgeId];
    if (!e) return { x: 0, y: 0, z: 0, heading: 0 };
    const d = Math.min(Math.max(t, 0), 1) * e.length;
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < d) i++;
    const a = e.pts[i - 1], b = e.pts[i];
    const seg = e.cum[i] - e.cum[i - 1] || 1;
    const f = (d - e.cum[i - 1]) / seg;
    return {
      x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
      heading: Math.atan2(b.x - a.x, -(b.z - a.z)),
    };
  }

  /** Nearest edge to a world point, searching outward by hash ring. */
  nearestEdge(x, z) {
    const cx = Math.floor(x / HASH), cz = Math.floor(z / HASH);
    let best = null;
    for (let r = 0; r <= 4 && !best; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const list = this._segHash.get(`${cx + dx},${cz + dz}`); if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const e = this.edges[list[k]], i = list[k + 1];
          const a = e.pts[i], b = e.pts[i + 1];
          const vx = b.x - a.x, vz = b.z - a.z;
          const L2 = vx * vx + vz * vz || 1;
          let u = ((x - a.x) * vx + (z - a.z) * vz) / L2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const d = Math.hypot(x - (a.x + vx * u), z - (a.z + vz * u));
          if (!best || d < best.distance) {
            const along = e.cum[i] + u * (e.cum[i + 1] - e.cum[i]);
            best = { edgeId: e.id, t: e.length ? along / e.length : 0, distance: d };
          }
        }
      }
    }
    return best;
  }

  outgoing(nodeId) { return this._out.get(nodeId) || []; }

  /**
   * Centreline of the kerbside parking bay, or null where there is none.
   * Points are in a->b order for side +1 (the right kerb) and b->a for side -1,
   * so a car placed along it faces the way it would legally have parked.
   * @param {number} edgeId @param {-1|1} side
   */
  parkingLane(edgeId, side = 1) {
    const e = this.edges[edgeId];
    if (!e?.parking) return null;
    const out = this.offsetPolyline(e, side * e.parking.offset);
    if (side < 0) out.reverse();
    return out;
  }

  /**
   * Distance from a point along a direction to the next road centreline,
   * ignoring one edge. Used to size building plots to the real block depth.
   */
  rayToRoad(x, z, dx, dz, maxD, ignoreEdge) {
    let best = maxD;
    const steps = Math.ceil(maxD / HASH) + 1;
    const tested = new Set();
    for (let s = 0; s <= steps; s++) {
      const px = x + dx * (s * HASH), pz = z + dz * (s * HASH);
      const cx = Math.floor(px / HASH), cz = Math.floor(pz / HASH);
      for (let jz = -1; jz <= 1; jz++) for (let jx = -1; jx <= 1; jx++) {
        const k = `${cx + jx},${cz + jz}`;
        if (tested.has(k)) continue; tested.add(k);
        const list = this._segHash.get(k); if (!list) continue;
        for (let n = 0; n < list.length; n += 2) {
          if (list[n] === ignoreEdge) continue;
          const e = this.edges[list[n]], i = list[n + 1];
          const a = e.pts[i], b = e.pts[i + 1];
          const rx = b.x - a.x, rz = b.z - a.z;
          const den = dx * rz - dz * rx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((a.x - x) * rz - (a.z - z) * rx) / den;
          const u = ((a.x - x) * dz - (a.z - z) * dx) / den;
          if (t > 0.5 && t < best && u >= 0 && u <= 1) best = t - e.halfRoad - e.walk;
        }
      }
    }
    return Math.max(0, best);
  }

  // -- pavement graph -------------------------------------------------------

  /** Lateral offset from the centreline to the middle of the pavement. */
  walkOffset(e) { return e.halfRoad + 0.16 + e.walk * 0.5; }

  /**
   * The graph pedestrians actually walk: one strand per kerb, corner links
   * around every junction, and explicit crossing links spanning each arm.
   * Same public shape as `roads`, so an AI can use either interchangeably.
   */
  buildSidewalks() {
    const nodes = [], edges = [];
    const ends = new Map();                    // `${edgeId}:${side}:${end}` -> nodeId
    const T = this.terrain;
    const nodeAt = (x, z, y) => {
      const id = nodes.length;
      nodes.push({ id, x, z, y, edges: [] });
      return id;
    };
    const link = (a, b, pts, kind) => {
      const id = edges.length;
      let len = 0; const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        cum.push(len);
      }
      edges.push({ id, a, b, pts, length: len, cum, kind, lanes: 1, width: 2.4,
                   oneway: 0, type: 'sidewalk', speed: 1.35, name: kind });
      nodes[a].edges.push(id); nodes[b].edges.push(id);
      return id;
    };

    for (const e of this.edges) {
      if (e.walk < 0.3) continue;
      for (const side of [-1, 1]) {
        const pts = this.offsetPolyline(e, side * this.walkOffset(e))
          .map(p => ({ x: p.x, y: p.y + 0.145, z: p.z }));
        const a = nodeAt(pts[0].x, pts[0].z, pts[0].y);
        const b = nodeAt(pts[pts.length - 1].x, pts[pts.length - 1].z, pts[pts.length - 1].y);
        ends.set(`${e.id}:${side}:0`, a);
        ends.set(`${e.id}:${side}:1`, b);
        link(a, b, pts, 'walk');
      }
    }

    // Corner links and crossings, arm by arm around each junction.
    for (const n of this.nodes) {
      const arms = [];
      for (const id of n.edges) {
        const e = this.edges[id];
        if (e.walk < 0.3) continue;
        const fromA = e.a === n.id;
        const p0 = fromA ? e.pts[0] : e.pts[e.pts.length - 1];
        const p1 = fromA ? e.pts[1] : e.pts[e.pts.length - 2];
        let dx = p1.x - p0.x, dz = p1.z - p0.z;
        const L = Math.hypot(dx, dz) || 1;
        arms.push({ e, end: fromA ? 0 : 1, ang: Math.atan2(dz / L, dx / L) });
      }
      if (!arms.length) continue;
      arms.sort((a, b) => a.ang - b.ang);
      // ordered endpoints: for each arm, its left kerb then its right kerb
      const seq = [];
      for (const a of arms) {
        const lSide = a.end === 0 ? -1 : 1;      // "left" seen from the junction
        seq.push({ arm: a, id: ends.get(`${a.e.id}:${lSide}:${a.end}`), cross: true });
        seq.push({ arm: a, id: ends.get(`${a.e.id}:${-lSide}:${a.end}`), cross: false });
      }
      for (let i = 0; i < seq.length; i++) {
        const A = seq[i], B = seq[(i + 1) % seq.length];
        if (A.id === undefined || B.id === undefined || A.id === B.id) continue;
        if (seq.length === 2 && i === 1) continue;
        const pa = nodes[A.id], pb = nodes[B.id];
        // A pair from the same arm spans the carriageway: that is a crossing.
        const crossing = A.arm === B.arm;
        link(A.id, B.id,
          [{ x: pa.x, y: pa.y, z: pa.z }, { x: pb.x, y: pb.y, z: pb.z }],
          crossing ? 'crossing' : 'corner');
      }
    }

    const hash = new Map();
    for (const e of edges) {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const x0 = Math.floor(Math.min(a.x, b.x) / HASH), x1 = Math.floor(Math.max(a.x, b.x) / HASH);
        const z0 = Math.floor(Math.min(a.z, b.z) / HASH), z1 = Math.floor(Math.max(a.z, b.z) / HASH);
        for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
          const k = `${cx},${cz}`;
          let arr = hash.get(k); if (!arr) hash.set(k, arr = []);
          arr.push(e.id, i);
        }
      }
    }
    const self = this;
    this.sidewalks = {
      nodes, edges,
      laneCenter: (id) => (edges[id] ? edges[id].pts.map(p => ({ ...p })) : []),
      sample: (id, t) => RoadNetwork.prototype.sample.call({ edges }, id, t),
      outgoing: (id) => (nodes[id] ? nodes[id].edges : []),
      nearestEdge: (x, z) => RoadNetwork.prototype.nearestEdge.call(
        { edges, _segHash: hash }, x, z),
      offsetPolyline: (e, o) => self.offsetPolyline(e, o),
    };
    return this.sidewalks;
  }

  // -- parcels --------------------------------------------------------------

  /** Typical street frontage and build limits per neighbourhood. */
  static ZONING = {
    financial:  { w: 30, depth: 62, zoning: 'tower',      maxHeight: 240 },
    backBay:    { w: 8.2, depth: 34, zoning: 'brownstone', maxHeight: 26 },
    beaconHill: { w: 7.4, depth: 26, zoning: 'rowhouse',   maxHeight: 19 },
    northEnd:   { w: 7.0, depth: 22, zoning: 'tenement',   maxHeight: 21 },
    southEnd:   { w: 7.8, depth: 30, zoning: 'brownstone', maxHeight: 20 },
    seaport:    { w: 38, depth: 58, zoning: 'modern',      maxHeight: 90 },
    fenway:     { w: 18, depth: 40, zoning: 'midrise',     maxHeight: 45 },
    charlestown:{ w: 8.0, depth: 24, zoning: 'rowhouse',   maxHeight: 16 },
    cambridge:  { w: 24, depth: 46, zoning: 'midrise',     maxHeight: 60 },
    park:       null, water: null,
  };

  /**
   * Subdivide the land between roads into parcels with real street frontage.
   * Depth is measured by casting into the block until the next street, so a
   * parcel never runs through the building behind it.
   */
  buildPlots(districtAt, blocked) {
    const plots = [];
    const Z = RoadNetwork.ZONING;
    let pid = 0;
    for (const e of this.edges) {
      if (e.type === 'highway' || e.type === 'alley' || e.bridged) continue;
      const off = e.halfRoad + 0.16 + e.walk;
      for (const side of [-1, 1]) {
        const line = this.offsetPolyline(e, side * off);
        // walk the frontage in even steps
        let acc = 0;
        const segs = [];
        for (let i = 1; i < line.length; i++) {
          const L = Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
          segs.push({ a: line[i - 1], b: line[i], L, s: acc }); acc += L;
        }
        if (acc < 6) continue;
        const midDist = acc / 2;
        const probe = this._along(segs, midDist, acc);
        const dist = districtAt(probe.x, probe.z);
        const cfg = (dist in Z) ? Z[dist] : Z.southEnd;
        if (!cfg) continue;                       // parks and water are not for sale
        const n = Math.max(1, Math.round(acc / cfg.w));
        const w = acc / n;
        for (let k = 0; k < n; k++) {
          const p0 = this._along(segs, k * w, acc);
          const p1 = this._along(segs, (k + 1) * w, acc);
          const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2;
          let dx = -(p1.z - p0.z), dz = (p1.x - p0.x);
          const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
          if ((dx * (mx - this.sample(e.id, 0.5).x) + dz * (mz - this.sample(e.id, 0.5).z)) < 0) {
            dx = -dx; dz = -dz;
          }
          const reach = this.rayToRoad(mx, mz, dx, dz, cfg.depth * 2 + 12, e.id);
          const depth = Math.min(cfg.depth, Math.max(0, reach / 2 - 0.6));
          if (depth < 8) continue;
          // Test the middle of the parcel, not the kerb: a street that runs
          // along the Common has frontage on the pavement but no land behind it.
          if (blocked && blocked(mx + dx * depth * 0.5, mz + dz * depth * 0.5)) continue;
          const q0 = { x: p0.x + dx * depth, z: p0.z + dz * depth };
          const q1 = { x: p1.x + dx * depth, z: p1.z + dz * depth };
          plots.push({
            id: pid++, district: dist, zoning: cfg.zoning, maxHeight: cfg.maxHeight,
            polygon: [{ x: p0.x, z: p0.z }, { x: p1.x, z: p1.z }, q1, q0],
            frontage: { a: { x: p0.x, z: p0.z }, b: { x: p1.x, z: p1.z } },
            width: w, depth, edgeId: e.id, side,
            y: this.terrain.groundHeight(mx + dx * depth * 0.5, mz + dz * depth * 0.5),
          });
        }
      }
    }
    // Buildings.js takes the first N under its cap, so order by distance from
    // the centre: whatever gets dropped is out at the edge of the map.
    plots.sort((a, b) => {
      const ax = a.frontage.a.x, az = a.frontage.a.z;
      const bx = b.frontage.a.x, bz = b.frontage.a.z;
      return (ax * ax + az * az) - (bx * bx + bz * bz);
    });
    plots.forEach((p, i) => { p.id = i; });
    this.plots = plots;
    return plots;
  }

  _along(segs, d, total) {
    d = Math.min(Math.max(d, 0), total);
    for (const s of segs) {
      if (d <= s.s + s.L || s === segs[segs.length - 1]) {
        const t = s.L ? (d - s.s) / s.L : 0;
        return { x: s.a.x + (s.b.x - s.a.x) * t, z: s.a.z + (s.b.z - s.a.z) * t };
      }
    }
    return segs[0].a;
  }

  /** Places the game can put the player or a car down legally. */
  buildSpawns() {
    const out = [];
    for (const e of this.edges) {
      if (e.bridged || e.length < 30) continue;
      const step = e.type === 'highway' ? 220 : 130;
      for (let d = step * 0.5; d < e.length; d += step) {
        const t = d / e.length;
        const s = this.sample(e.id, t);
        const lane = this.laneCenter(e.id, 0);
        const i = Math.min(lane.length - 1, Math.round(t * (lane.length - 1)));
        out.push({ x: lane[i].x, y: lane[i].y + 0.35, z: lane[i].z,
                   heading: s.heading, kind: 'road' });
      }
    }
    if (this.sidewalks) {
      for (const e of this.sidewalks.edges) {
        if (e.kind !== 'walk' || e.length < 24) continue;
        const m = e.pts[Math.floor(e.pts.length / 2)];
        const p = e.pts[Math.min(e.pts.length - 1, Math.floor(e.pts.length / 2) + 1)];
        out.push({ x: m.x, y: m.y + 0.05, z: m.z,
                   heading: Math.atan2(p.x - m.x, -(p.z - m.z)), kind: 'sidewalk' });
      }
    }
    this.spawnPoints = out;
    return out;
  }

  stats() {
    return { nodes: this.nodes.length, edges: this.edges.length,
             km: +(this.edges.reduce((s, e) => s + e.length, 0) / 1000).toFixed(1) };
  }
}
