/**
 * Stage 1A metrics — M1 source consistency, M2 current-world displacement,
 * M3 residual after one rigid translation.
 *
 *   node research/gis-stage1a/metrics.mjs
 *
 * Reads `fixture.json` and the CURRENT world built headlessly by
 * `current-world.mjs`. No renderer, no WebGL, no production file modified.
 *
 * MATCHING RULES (deterministic, and the reason they are written down):
 *
 *  1. Only the OUTER ring of an authoritative part is used.
 *  2. A ring edge is STREET-FACING against road edge `e` and side `s` when:
 *       (a) the road centreline lies OUTWARD of the ring edge (outward resolved
 *           against the ring centroid, not the winding);
 *       (b) the road runs roughly PARALLEL to the edge, |cos| >= PARALLEL;
 *       (c) casting the outward normal as a ray, the road centreline is reached
 *           BEFORE any other authoritative building segment — i.e. nothing is
 *           built between this wall and that street.
 *
 *     CLARIFICATION, and why (c) is not `Buildings._streetDirs`' third condition.
 *     The real test deducts `corridorHalf(e)` and requires the remainder under
 *     EXPOSED (3.0 m, Buildings.js:522). That is right for GENERATED parcels,
 *     which by construction never lie inside a road corridor. Applied to
 *     AUTHORITATIVE footprints it is a biased selector: footprints frequently do
 *     overlap Boston's roads, such an edge scores a NEGATIVE gap, and sorting by
 *     gap then picks the edge lying deepest inside the carriageway while
 *     rejecting every genuinely set-back wall at gap >= 3 m. Measured: it
 *     returned a median M2 of -5.68 m on a sample where the same buildings sit a
 *     median 15.3 m from the centreline on a 8.76 m corridor — a sign inversion
 *     manufactured by the selection rule. An occlusion ray has no such bias.
 *  3. Facing count decides the bucket:
 *       0  -> UNMATCHED (block interior / alley-facing: `buildPlots` grants no
 *             frontage to alleys, so no streetwall exists to measure against)
 *       1  -> PRIMARY distribution
 *      >=2 -> CORNER, reported separately (the accepted `frontDirs.length > 1`
 *             exclusion)
 *  4. The streetwall for (e, s) is the set of `plot.frontage` segments of the
 *     parcels `buildPlots` actually emitted there. If that set is empty the
 *     building is UNMATCHED (reason `no-parcel-frontage`).
 *  5. M2 is the SIGNED perpendicular distance from the midpoint of the exposed
 *     edge to the nearest frontage segment, signed along the building's outward
 *     normal. POSITIVE = the real building sits INLAND of where Boston puts its
 *     building line. NEGATIVE = it would stand in Boston's pavement or road.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';
import { buildCurrentWorld } from './current-world.mjs';
import { inBox } from './bbox.mjs';
import { area2 } from './normalize.mjs';

const PARALLEL = Math.cos(30 * Math.PI / 180);
const SEARCH = 90;                // m: road edges considered near a building

const centroid = (ring) => {
  let A = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const cr = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    A += cr; cx += (ring[i][0] + ring[j][0]) * cr; cz += (ring[i][1] + ring[j][1]) * cr;
  }
  A *= 0.5;
  if (Math.abs(A) < 1e-9) {
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length,
            ring.reduce((s, p) => s + p[1], 0) / ring.length];
  }
  return [cx / (6 * A), cz / (6 * A)];
};
/** Nearest point on segment ab to p, and the distance. */
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const qx = ax + dx * t, qz = az + dz * t;
  return { d: Math.hypot(px - qx, pz - qz), qx, qz, t };
}

/** Segment index over every authoritative ring, for the occlusion ray. */
let _segs = null;
function buildSegIndex(fx) {
  _segs = [];
  for (const f of fx.features)
    for (const r of f.derived.rings)
      for (let i = 0; i < r.length; i++) {
        const j = (i + 1) % r.length;
        _segs.push([r[i][0], r[i][1], r[j][0], r[j][1], f.id]);
      }
}
/** Distance along ray (px,pz)+t*(dx,dz) to the nearest OTHER building segment, or null. */
function rayHit(px, pz, dx, dz, max, selfId) {
  let best = null;
  for (const [ax, az, bx, bz, id] of _segs) {
    if (id === selfId) continue;
    const ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - px) * ez - (az - pz) * ex) / den;
    const u = ((ax - px) * dz - (az - pz) * dx) / den;
    if (t > 0.25 && t < max && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

export function computeMetrics(fx, world) {
  const { net, plots } = world;
  buildSegIndex(fx);
  const edgesNear = net.edges.filter(e => e.pts.some(q =>
    q.x > -1600 && q.x < -800 && q.z > 250 && q.z < 1050));
  // streetwall, keyed by `${edgeId}:${side}`
  const wall = new Map();
  for (const p of plots) {
    const k = `${p.edgeId}:${p.side}`;
    if (!wall.has(k)) wall.set(k, []);
    wall.get(k).push(p.frontage);
  }

  const rows = [];
  for (const f of fx.features) {
    const ring = f.derived.rings[0];
    const c = centroid(ring);
    if (!inBox(c[0], c[1])) { rows.push({ id: f.id, bucket: 'OUTSIDE_BOX' }); continue; }
    // signed area>0 means CCW; outward is resolved against the centroid, so winding is irrelevant
    const exposures = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const L = Math.hypot(ex, ez);
      if (L < 0.5) continue;                       // ignore sub-0.5 m slivers
      const ux = ex / L, uz = ez / L;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      let nx = -uz, nz = ux;                       // candidate normal
      if ((mx - c[0]) * nx + (mz - c[1]) * nz < 0) { nx = -nx; nz = -nz; }   // point outward
      // (c) occlusion: how far along the outward normal until we hit another building?
      const blocked = rayHit(mx, mz, nx, nz, SEARCH, f.id);
      let best = null;
      for (const e of edgesNear) {
        for (let k = 1; k < e.pts.length; k++) {
          const p0 = e.pts[k - 1], p1 = e.pts[k];
          const rd = Math.hypot(p1.x - p0.x, p1.z - p0.z);
          if (rd < 1e-6) continue;
          const rx = (p1.x - p0.x) / rd, rz = (p1.z - p0.z) / rd;
          if (Math.abs(rx * ux + rz * uz) < PARALLEL) continue;            // (b) parallel
          const s = segDist(mx, mz, p0.x, p0.z, p1.x, p1.z);
          if (s.d > SEARCH) continue;
          const outward = (s.qx - mx) * nx + (s.qz - mz) * nz;
          if (outward <= 0) continue;                                       // (a) road outward
          if (blocked != null && s.d > blocked) continue;                   // (c) something built in between
          const side = Math.sign((mx - s.qx) * -rz + (mz - s.qz) * rx) || 1;
          if (!best || s.d < best.d) best = { edge: e, side, nx, nz, mx, mz, d: s.d, ch: corridorHalf(e), i };
        }
      }
      if (best) exposures.push(best);
    }
    // collapse exposures that resolve to the same (edge, side) — one street, one front
    const uniq = new Map();
    for (const x of exposures) {
      const k = `${x.edge.id}:${x.side}`;
      if (!uniq.has(k) || x.d < uniq.get(k).d) uniq.set(k, x);
    }
    const fronts = [...uniq.values()];
    const base = { id: f.id, areaM2: f.derived.areaM2, heightM: f.derived.heightM,
                   centroid: [ +c[0].toFixed(2), +c[1].toFixed(2) ], fronts: fronts.length };
    if (fronts.length === 0) { rows.push({ ...base, bucket: 'UNMATCHED', reason: 'no-street-exposed-edge' }); continue; }
    const bucket = fronts.length === 1 ? 'PRIMARY' : 'CORNER';
    // measure against the nearest front
    const fr = fronts.sort((p, q) => p.d - q.d)[0];
    const segs = wall.get(`${fr.edge.id}:${fr.side}`);
    if (!segs || !segs.length) { rows.push({ ...base, bucket: 'UNMATCHED', reason: 'no-parcel-frontage', street: fr.edge.name }); continue; }
    let bd = Infinity, bq = null;
    for (const s of segs) {
      const r = segDist(fr.mx, fr.mz, s.a.x, s.a.z, s.b.x, s.b.z);
      if (r.d < bd) { bd = r.d; bq = r; }
    }
    const sign = Math.sign((bq.qx - fr.mx) * fr.nx + (bq.qz - fr.mz) * fr.nz) || 1;
    // sign > 0  => the streetwall lies OUTWARD of the building  => building is INLAND => positive
    rows.push({ ...base, bucket, street: fr.edge.name, edgeId: fr.edge.id, side: fr.side,
                normal: [ +fr.nx.toFixed(6), +fr.nz.toFixed(6) ],
                facing: +fr.d.toFixed(3),
                m2: +(bd * sign).toFixed(3) });
  }
  return rows;
}

export function stats(vals) {
  if (!vals.length) return { n: 0 };
  const s = [...vals].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const rms = Math.sqrt(s.reduce((a, b) => a + b * b, 0) / s.length);
  const f = (v) => +v.toFixed(2);
  return { n: s.length, min: f(q(0)), p10: f(q(0.10)), p25: f(q(0.25)), median: f(q(0.5)),
           p75: f(q(0.75)), p90: f(q(0.90)), max: f(q(1)), mean: f(mean), rms: f(rms) };
}
