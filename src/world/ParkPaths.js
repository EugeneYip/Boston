/**
 * Park circulation — the walks, loops and entrances inside an authored park.
 *
 * Boston's nineteen parks are authored polygons (`boston-geo.js`) and Districts
 * turns them into two merged meshes, lawn and plaza. Nothing inside them was
 * ever drawn: a park was grass, trees and furniture scattered on it. The data
 * comment claimed `kind: 'formal'` "adds paths and beds"; no such code existed.
 *
 * There is no authored path geometry to connect, and inventing one from memory
 * would be fabricating geography, so this is deliberately PROCEDURAL and
 * Boston-INSPIRED, not surveyed. What makes it honest is that every path is
 * derived from geometry the city already owns:
 *
 *   - the park polygon decides the shape, and therefore the topology;
 *   - the park `kind` decides the character — surface, width, whether there is
 *     a loop or a spine, how regular the circulation is;
 *   - the street graph decides where the entrances are;
 *   - the water rings and the carriageways clip it.
 *
 * Nothing here is placed by hand and nothing extends past an authored boundary.
 *
 * Pure geometry. No THREE, no scene, no renderer — `Districts.build` meshes the
 * result and the model lab can audit it headlessly.
 */
import { insetPoly } from './BuildingKit.js';

/**
 * Per-kind character. `plaza` is deliberately absent: City Hall Plaza and
 * Copley Square are already drawn as unbroken hardscape, so a "path" across one
 * would be concrete on concrete. A plaza's circulation IS the plaza.
 *
 * `stone` is the stone-dust walk of the Public Garden and the Comm Ave Mall;
 * `paved` is the asphalt of the Common and the Esplanade. Both map onto
 * materials the city already builds, so park circulation costs no new texture.
 */
const KIND = {
  lawn:   { surface: 'paved', main: 3.4, minor: 2.4, loopInset: 13, regular: false },
  formal: { surface: 'stone', main: 4.0, minor: 2.6, loopInset: 10, regular: true },
  mall:   { surface: 'stone', main: 3.0, minor: 2.0, loopInset: 7,  regular: true },
};

const SPINE_STEP = 6;        // cross-section spacing when tracing a ribbon, m
const SAMPLE = 3;            // validation sample spacing along a path, m
const MIN_RUN = 18;          // a surviving clipped run shorter than this is litter
const EDGE_KEEP = 1.2;       // grass left between a path edge and the park boundary
const WATER_KEEP = 1.5;      // ditto, at a shore
const ROAD_KEEP = 0.4;       // ditto, at a carriageway edge

/* -------------------------------------------------------------------------- */
/* polygon primitives                                                         */
/* -------------------------------------------------------------------------- */

function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

/** Signed distance to a ring. Positive inside, negative outside. */
export function polySdf(pts, x, z) {
  let best = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const d2 = segDist2(x, z, pts[j].x, pts[j].z, pts[i].x, pts[i].z);
    if (d2 < best) best = d2;
    if ((pts[i].z > z) !== (pts[j].z > z) &&
        x < (pts[j].x - pts[i].x) * (z - pts[i].z) / (pts[j].z - pts[i].z) + pts[i].x) {
      inside = !inside;
    }
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

function ringLength(pts) {
  let L = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    L += Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
  }
  return L;
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}

/** Resample a polyline at a fixed spacing, keeping both ends exactly. */
export function resamplePath(pts, step) {
  if (pts.length < 2) return pts.map(p => ({ x: p.x, z: p.z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [{ x: pts[0].x, z: pts[0].z }];
  const n = Math.max(1, Math.round(total / step));
  const out = [];
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const span = cum[seg] - cum[seg - 1] || 1;
    const t = (d - cum[seg - 1]) / span;
    const a = pts[seg - 1], b = pts[seg];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

/** Do open segments a-b and c-d properly cross? Shared endpoints do not count. */
function crosses(a, b, c, d) {
  const s = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const d1 = s(a, b, c), d2 = s(a, b, d), d3 = s(c, d, a), d4 = s(c, d, b);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

/** Self-intersection count of a closed ring — the guard on an inset loop. */
function selfCrossings(ring) {
  let n = 0;
  const N = ring.length;
  for (let i = 0; i < N; i++) {
    const a = ring[i], b = ring[(i + 1) % N];
    for (let j = i + 2; j < N; j++) {
      if (i === 0 && j === N - 1) continue;             // adjacent through the seam
      if (crosses(a, b, ring[j], ring[(j + 1) % N])) n++;
    }
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Principal axis, extent and how much of that box the polygon actually fills.
 *
 * Elongation alone misreads a curved ribbon: the Greenway measures 1508 x 377
 * because its own bend widens the box, and the Esplanade 1610 x 130 for the
 * same reason. Both fill under half of it, and that is the tell — a fat park
 * fills its box, a bent ribbon cannot.
 */
export function shapeOf(poly) {
  const dense = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.round(L / 2));
    for (let k = 0; k < n; k++) dense.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  }
  let mx = 0, mz = 0;
  for (const p of dense) { mx += p.x; mz += p.z; }
  mx /= dense.length; mz /= dense.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of dense) {
    const dx = p.x - mx, dz = p.z - mz;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(th), uz = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of poly) {
    const dx = p.x - mx, dz = p.z - mz;
    const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  let a2 = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a2 += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  }
  const area = Math.abs(a2) / 2;
  const len = u1 - u0, wid = Math.max(1e-3, v1 - v0);
  const fill = area / Math.max(1, len * wid);
  return {
    cx: mx, cz: mz, ux, uz, u0, u1, v0, v1, len, wid, area, fill,
    elong: len / wid,
    linear: len / wid >= 3 || fill <= 0.45,
  };
}

/**
 * Trace a ribbon's middle by sweeping cross-sections along the principal axis
 * and taking the centre of the widest span that is inside.
 *
 * Chosen over a medial axis or a half-perimeter pairing because both degenerate
 * on the shapes actually present here: the eight Comm Ave Mall blocks are exact
 * rectangles, and for a rectangle the half-perimeter partner of every boundary
 * point is its reflection through the centre, so every "midpoint" collapses to
 * one point.
 */
function crossMidline(poly, sh, step) {
  const out = [];
  const n = Math.max(2, Math.round(sh.len / step));
  for (let k = 0; k <= n; k++) {
    const u = sh.u0 + (sh.len * k) / n;
    // Ray at parameter u, in the v direction; collect crossings with the ring.
    const hits = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      const ua = (a.x - sh.cx) * sh.ux + (a.z - sh.cz) * sh.uz;
      const ub = (b.x - sh.cx) * sh.ux + (b.z - sh.cz) * sh.uz;
      if ((ua > u) === (ub > u)) continue;
      const t = (u - ua) / (ub - ua);
      const va = -(a.x - sh.cx) * sh.uz + (a.z - sh.cz) * sh.ux;
      const vb = -(b.x - sh.cx) * sh.uz + (b.z - sh.cz) * sh.ux;
      hits.push(va + (vb - va) * t);
    }
    if (hits.length < 2) continue;
    hits.sort((p, q) => p - q);
    // Pairs (0,1), (2,3), ... are the inside spans. Keep the widest.
    let bv = 0, bw = -1;
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const w = hits[i + 1] - hits[i];
      if (w > bw) { bw = w; bv = (hits[i] + hits[i + 1]) / 2; }
    }
    if (bw <= 0) continue;
    out.push({
      x: sh.cx + sh.ux * u - sh.uz * bv,
      z: sh.cz + sh.uz * u + sh.ux * bv,
      half: bw / 2,
    });
  }
  // Three-tap smoothing: a cross-section sweep jitters wherever the ring has a
  // vertex, and a park walk does not have a kink every six metres.
  const sm = out.map((p, i) => {
    if (i === 0 || i === out.length - 1) return { ...p };
    const a = out[i - 1], b = out[i + 1];
    return { x: (a.x + 2 * p.x + b.x) / 4, z: (a.z + 2 * p.z + b.z) / 4, half: p.half };
  });
  return sm;
}

/* -------------------------------------------------------------------------- */
/* clipping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Walk a polyline at `SAMPLE` metres and cut it into the runs that a path of
 * this width may legally occupy. Rejecting a run is always local: one bad
 * stretch costs that stretch, never the whole park.
 */
function clipRun(pts, half, ok, closed) {
  const line = closed ? [...pts, { x: pts[0].x, z: pts[0].z }] : pts;
  const s = resamplePath(line, SAMPLE);
  const runs = [];
  let cur = null;
  for (const p of s) {
    if (ok(p.x, p.z, half)) {
      (cur || (cur = [])).push(p);
    } else if (cur) {
      runs.push(cur); cur = null;
    }
  }
  if (cur) runs.push(cur);
  // A closed loop that survived whole is still one run in this list; stitching
  // the seam back is not worth it, the two ends already meet.
  return runs.filter(r => r.length > 1 && pathLength(r) >= MIN_RUN);
}

/* -------------------------------------------------------------------------- */
/* entrances                                                                  */
/* -------------------------------------------------------------------------- */

/** Point and unit tangent on an edge's polyline at fraction `t` of its length. */
function edgeFrameAt(e, t) {
  const target = (e.length || 0) * Math.min(1, Math.max(0, t));
  const c = e.cum;
  let i = 1;
  while (i < c.length - 1 && c[i] < target) i++;
  const span = c[i] - c[i - 1] || 1;
  const u = (target - c[i - 1]) / span;
  const a = e.pts[i - 1], b = e.pts[i];
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u,
           tx: (b.x - a.x) / L, tz: (b.z - a.z) / L };
}

/**
 * Where the park meets the street. Derived, never authored.
 *
 * The authored ring is NOT the park's edge, and using it as one finds almost no
 * entrances: 238 of Boston Common's 254 boundary samples and all 157 of the
 * Public Garden's fall INSIDE a carriageway, because the rings were traced
 * around the outside of the streets that bound them. Districts already deals
 * with this by dropping every lawn triangle whose centroid lands on a road, so
 * the grass a player sees stops at the back of the pavement.
 *
 * So a gate is placed where the grass really stops: step out from the road
 * centreline, on the park's side, past the carriageway and the footway. That
 * puts the entrance on the public realm the park actually opens onto.
 */
function entrancesFor(poly, net, want, sep) {
  if (!net?.nearestEdge) return [];
  const b = resamplePath([...poly, { x: poly[0].x, z: poly[0].z }], 8);
  const cand = [];
  for (let bi = 0; bi < b.length; bi++) {
    const p = b[bi];
    const ne = net.nearestEdge(p.x, p.z);
    if (!ne) continue;
    const e = net.edges[ne.edgeId];
    if (!e || !(e.walk >= 0.3)) continue;
    // A highway has no frontage and an alley is not a way in. The Esplanade is
    // bounded by Storrow Drive for 409 of its 417 boundary samples, and that is
    // the truth of the place: you reach it by footbridge, and no footbridge is
    // authored, so it gets no gate there rather than an invented one.
    if (e.type === 'alley' || e.type === 'highway') continue;
    const c = edgeFrameAt(e, ne.t);
    // Step off the road along its own normal, and let the POLYGON pick the side.
    // Taking the direction from the centreline to the boundary sample instead
    // fails on 152 of Boston Common's 254 samples, because on its Charles Street
    // and Boylston Street sides the authored ring is drawn straight down the
    // middle of the carriageway and there is no side to read off it.
    const reach = e.halfRoad + 0.16 + e.walk + 1.2;
    const nx = -c.tz, nz = c.tx;
    let gx = 0, gz = 0, best = -Infinity;
    for (const sgn of [1, -1]) {
      const qx = c.x + nx * reach * sgn, qz = c.z + nz * reach * sgn;
      const d = polySdf(poly, qx, qz);
      if (d > best) { best = d; gx = qx; gz = qz; }
    }
    if (best < 1) continue;                     // the gate has to be in the park
    const moved = Math.hypot(gx - p.x, gz - p.z);
    if (moved > 24) continue;                   // this street does not bound the park
    cand.push({ x: gx, z: gz, edgeId: ne.edgeId, arc: bi / b.length,
                score: -moved * 0.15 + (e.lanes || 1) * 0.9 +
                       (e.type === 'arterial' ? 1.5 : 0) });
  }
  // Best candidate per equal arc of the perimeter, NOT the globally best `want`
  // subject to a spacing rule. Pure greedy-by-score obeyed a 140 m separation
  // and still put all four of Boston Common's gates inside one 97-degree arc,
  // because the score prefers big streets and one big street bounds one side.
  // A park is entered from every side that has a street on it.
  const slot = new Map();
  for (const c of cand) {
    const k = Math.min(want - 1, Math.floor(c.arc * want));
    const cur = slot.get(k);
    if (!cur || c.score > cur.score) slot.set(k, c);
  }
  const out = [];
  const take = (c) => {
    if (out.length >= want) return;
    if (out.some(o => Math.hypot(o.x - c.x, o.z - c.z) < sep)) return;
    out.push(c);
  };
  for (const c of [...slot.values()].sort((a, d) => a.arc - d.arc)) take(c);
  // Arcs with no street on them leave holes, and a park whose gates all fall in
  // two arcs would end up with two gates. Backfill by score once every arc that
  // could contribute has, so spread wins first and count still gets served.
  for (const c of [...cand].sort((a, d) => d.score - a.score)) take(c);
  return out;
}

/** Nearest point on any already-accepted path, for hanging an entrance spur on. */
function nearestOnPaths(paths, x, z) {
  let best = null, bd = Infinity;
  for (const p of paths) {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = dx * dx + dz * dz;
      let t = L > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a.x + dx * t, qz = a.z + dz * t;
      const d = Math.hypot(qx - x, qz - z);
      if (d < bd) { bd = d; best = { x: qx, z: qz }; }
    }
  }
  return best ? { ...best, d: bd } : null;
}

/* -------------------------------------------------------------------------- */
/* the generator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object}   o
 * @param {Array}    o.parks   `Districts.parkPolys` — `{name, kind, reserveOnly, polygon}`
 * @param {object}   o.net     the road network, for entrances and carriageway clipping
 * @param {Array}    o.water   `terrain.bodies` — prepared water rings
 * @returns {{paths:Array, entrances:Array, report:Array}}
 */
export function buildParkPaths({ parks = [], net = null, water = [] } = {}) {
  const paths = [], entrances = [], report = [];
  const bodies = (water || []).filter(b => b?.pts?.length > 2);

  for (const park of parks) {
    if (park.reserveOnly) continue;                 // a no-build corridor, not a place
    const K = KIND[park.kind];
    const poly = park.polygon;
    if (!K || !poly || poly.length < 3) {
      report.push({ name: park.name, kind: park.kind, skipped: K ? 'degenerate' : 'hardscape' });
      continue;
    }
    const sh = shapeOf(poly);

    // Legality of one point, for a path of half-width `half`.
    const ok = (x, z, half) => {
      if (polySdf(poly, x, z) < half + EDGE_KEEP) return false;
      for (const b of bodies) {
        if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
        if (polySdf(b.pts, x, z) > -(half + WATER_KEEP)) return false;
      }
      if (net?.nearestEdge) {
        const ne = net.nearestEdge(x, z);
        if (ne) {
          const e = net.edges[ne.edgeId];
          if (e && ne.distance < e.halfRoad + half + ROAD_KEEP) return false;
        }
      }
      return true;
    };

    const local = [];
    const add = (role, width, pts, closed) => {
      for (const run of clipRun(pts, width / 2, ok, closed)) {
        local.push({ park: park.name, kind: park.kind, surface: K.surface,
                     role, width, pts: run, length: pathLength(run) });
      }
    };

    if (sh.linear) {
      // A ribbon gets one walk down its middle, which is what the Comm Ave Mall
      // and the Esplanade actually are.
      const spine = crossMidline(poly, sh, SPINE_STEP);
      add('spine', K.main, spine, false);
      // Long ribbons get occasional crossings; a 166 m mall block does not need
      // to be cut in half.
      if (sh.len > 250 && spine.length > 4) {
        const every = Math.max(110, sh.len / Math.round(sh.len / 150));
        let acc = every * 0.5;
        for (let i = 1; i < spine.length; i++) {
          acc += Math.hypot(spine[i].x - spine[i - 1].x, spine[i].z - spine[i - 1].z);
          if (acc < every) continue;
          acc = 0;
          const a = spine[i - 1], b = spine[i];
          const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
          const r = Math.max(4, (spine[i].half || 8) - K.minor / 2 - EDGE_KEEP);
          add('cross', K.minor,
              [{ x: b.x - nx * r, z: b.z - nz * r }, { x: b.x + nx * r, z: b.z + nz * r }], false);
        }
      }
    } else {
      // A park with real width gets a perimeter walk. `insetPoly` is the same
      // true edge offset the building setbacks use.
      const inset = Math.min(K.loopInset, Math.max(4, sh.wid * 0.14));
      const loop = insetPoly(poly, inset);
      const shrunk = Math.abs(shapeOf(loop).area) < sh.area * 0.15;
      if (loop.length > 2 && !shrunk && selfCrossings(loop) === 0) {
        add('loop', K.main, loop, true);
      } else {
        report.push({ name: park.name, note: 'inset loop rejected' });
      }
    }

    // Entrances, then a spur from each one to whatever circulation exists.
    const per = ringLength(poly);
    const want = Math.min(8, Math.max(2, Math.round(per / 220)));
    const sep = Math.min(140, Math.max(40, per / 9));
    const ent = entrancesFor(poly, net, want, sep);
    for (const e of ent) {
      entrances.push({ park: park.name, kind: park.kind, x: e.x, z: e.z });
      const t = nearestOnPaths(local, e.x, e.z);
      if (!t || t.d < 3 || t.d > 70) continue;
      // Step the mouth of the spur just inside the boundary; a run that starts
      // exactly on the ring can never pass its own clearance test.
      const dx = (t.x - e.x) / t.d, dz = (t.z - e.z) / t.d;
      add('spur', K.minor,
          [{ x: e.x + dx * 1.5, z: e.z + dz * 1.5 }, { x: t.x, z: t.z }], false);
    }

    // Desire lines. A big lawn is crossed, not walked around: the Common has
    // had diagonals for three centuries. A formal square is crossed on its
    // axes instead, which is what "formal" means.
    if (!sh.linear) {
      if (K.regular) {
        add('axis', K.minor,
            [{ x: sh.cx + sh.ux * sh.u0, z: sh.cz + sh.uz * sh.u0 },
             { x: sh.cx + sh.ux * sh.u1, z: sh.cz + sh.uz * sh.u1 }], false);
        add('axis', K.minor,
            [{ x: sh.cx - sh.uz * sh.v0, z: sh.cz + sh.ux * sh.v0 },
             { x: sh.cx - sh.uz * sh.v1, z: sh.cz + sh.ux * sh.v1 }], false);
      } else if (ent.length > 2) {
        const nDiag = Math.min(3, Math.max(1, Math.round(sh.area / 70000)));
        const pairs = [];
        for (let i = 0; i < ent.length; i++) {
          for (let j = i + 1; j < ent.length; j++) {
            pairs.push({ i, j, d: Math.hypot(ent[i].x - ent[j].x, ent[i].z - ent[j].z) });
          }
        }
        pairs.sort((a, b) => b.d - a.d);
        // A gate may anchor two walks but not three. Forbidding reuse entirely
        // caps a park at floor(gates/2) diagonals, which left the Common — the
        // one park in Boston that has been crossed diagonally since 1634 — with
        // two; allowing a third makes a junction, which is what its paths do.
        const used = new Map();
        let made = 0;
        for (const p of pairs) {
          if (made >= nDiag) break;
          if ((used.get(p.i) || 0) >= 2 || (used.get(p.j) || 0) >= 2) continue;
          used.set(p.i, (used.get(p.i) || 0) + 1);
          used.set(p.j, (used.get(p.j) || 0) + 1);
          made++;
          add('diagonal', K.main, [ent[p.i], ent[p.j]], false);
        }
      }
    }

    for (const p of local) paths.push(p);
    report.push({
      name: park.name, kind: park.kind, shape: sh.linear ? 'linear' : 'area',
      area: Math.round(sh.area), elong: +sh.elong.toFixed(2), fill: +sh.fill.toFixed(2),
      entrances: ent.length, runs: local.length,
      length: Math.round(local.reduce((a, p) => a + p.length, 0)),
    });
  }

  return { paths, entrances, report };
}
