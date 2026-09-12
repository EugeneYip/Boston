/**
 * Stage 1A.1 — M1 / M2 / M3 at BUILDING level.
 *
 *   node research/gis-stage1a1/building-metrics.mjs
 *
 * DISSOLVE. A building's boundary is the set of its constituent parts' edges
 * MINUS every edge shared with a sibling part of the SAME building. No polygon
 * union library, no invented geometry: internal roof-break seams disappear,
 * courtyards and party walls survive, and multipart buildings stay multipart.
 *
 * M2/M3 keep the accepted Stage 1A definitions and the same occlusion-ray
 * street-facing test, so the part-level and building-level numbers are
 * comparable. Only the unit changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { inBox } from '../gis-stage1a/bbox.mjs';
import { stats } from '../gis-stage1a/metrics.mjs';
import { group, centroid } from './group.mjs';

const fx = JSON.parse(readFileSync(new URL('../gis-stage1a/fixture.json', import.meta.url), 'utf8'));
const PARALLEL = Math.cos(30 * Math.PI / 180), SEARCH = 90, FRONT_BAND = 4.0;
const K = (p) => p[0].toFixed(2) + ',' + p[1].toFixed(2);

export function buildUnits() {
  const { assigned } = group();
  const byPart = new Map(assigned.map(a => [a.partId, a]));
  const units = new Map();                       // key -> unit
  for (const f of fx.features) {
    const a = byPart.get(f.id);
    const grouped = a && a.localId;
    const key = grouped ? `ms-${a.localId}` : `solo-${f.id}`;
    if (!units.has(key)) units.set(key, {
      id: key, localId: grouped ? a.localId : null,
      basis: grouped ? 'massgis-local-id' : (a?.confidence === 'AMBIGUOUS' ? 'ungrouped-ambiguous' : 'ungrouped-no-parent'),
      confidence: grouped ? a.confidence : (a?.confidence ?? 'UNASSIGNED'),
      parts: [],
    });
    units.get(key).parts.push(f);
  }
  // deterministic: sort units by id, parts by sourceId
  const out = [...units.values()].sort((p, q) => p.id.localeCompare(q.id));
  for (const u of out) {
    u.parts.sort((p, q) => (p.sourceId.length - q.sourceId.length) || p.sourceId.localeCompare(q.sourceId));
    // dissolve: edges not shared with a sibling in this unit
    const count = new Map();
    for (const p of u.parts) for (const r of p.derived.rings)
      for (let i = 0; i < r.length; i++) {
        const a = K(r[i]), b = K(r[(i + 1) % r.length]);
        if (a === b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        count.set(k, (count.get(k) || 0) + 1);
      }
    u.boundary = [];
    for (const p of u.parts) for (const r of p.derived.rings)
      for (let i = 0; i < r.length; i++) {
        const A = r[i], B = r[(i + 1) % r.length];
        const a = K(A), b = K(B);
        if (a === b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        if (count.get(k) === 1) u.boundary.push([A, B]);
      }
    u.areaM2 = +u.parts.reduce((s, p) => s + p.derived.areaM2, 0).toFixed(2);
    const hs = u.parts.map(p => p.derived.heightM).filter(v => v != null);
    u.heightM = hs.length ? { min: Math.min(...hs), max: Math.max(...hs), n: hs.length } : null;
    const all = u.parts.flatMap(p => p.derived.rings[0]);
    u.centroid = centroid(all).map(v => +v.toFixed(2));
  }
  return out;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const qx = ax + dx * t, qz = az + dz * t;
  return { d: Math.hypot(px - qx, pz - qz), qx, qz };
}

export function measure(units, world) {
  const { net, plots } = world;
  const edgesNear = net.edges.filter(e => e.pts.some(q => q.x > -1600 && q.x < -800 && q.z > 250 && q.z < 1050));
  const wall = new Map();
  for (const p of plots) {
    const k = `${p.edgeId}:${p.side}`;
    if (!wall.has(k)) wall.set(k, []);
    wall.get(k).push(p.frontage);
  }
  // occlusion index over EVERY building boundary edge, so a wall behind another building is not "facing"
  const segs = [];
  for (const u of units) for (const [A, B] of u.boundary) segs.push([A[0], A[1], B[0], B[1], u.id]);
  const rayHit = (px, pz, dx, dz, max, selfId) => {
    let best = null;
    for (const [ax, az, bx, bz, id] of segs) {
      if (id === selfId) continue;
      const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - px) * ez - (az - pz) * ex) / den;
      const uu = ((ax - px) * dz - (az - pz) * dx) / den;
      if (t > 0.25 && t < max && uu >= 0 && uu <= 1 && (best === null || t < best)) best = t;
    }
    return best;
  };
  const rows = [];
  for (const u of units) {
    const c = u.centroid;
    if (!inBox(c[0], c[1])) { rows.push({ id: u.id, bucket: 'OUTSIDE_BOX', parts: u.parts.length }); continue; }
    const fronts = new Map();
    for (const [A, B] of u.boundary) {
      const ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez);
      if (L < 0.5) continue;
      const ux = ex / L, uz = ez / L;
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
      let nx = -uz, nz = ux;
      if ((mx - c[0]) * nx + (mz - c[1]) * nz < 0) { nx = -nx; nz = -nz; }
      const blocked = rayHit(mx, mz, nx, nz, SEARCH, u.id);
      let best = null;
      for (const e of edgesNear) for (let k = 1; k < e.pts.length; k++) {
        const p0 = e.pts[k - 1], p1 = e.pts[k];
        const rd = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (rd < 1e-6) continue;
        const rx = (p1.x - p0.x) / rd, rz = (p1.z - p0.z) / rd;
        if (Math.abs(rx * ux + rz * uz) < PARALLEL) continue;
        const s = segDist(mx, mz, p0.x, p0.z, p1.x, p1.z);
        if (s.d > SEARCH) continue;
        if ((s.qx - mx) * nx + (s.qz - mz) * nz <= 0) continue;
        if (blocked != null && s.d > blocked) continue;
        const side = Math.sign((mx - s.qx) * -rz + (mz - s.qz) * rx) || 1;
        if (!best || s.d < best.d) best = { e, side, d: s.d, nx, nz, mx, mz };
      }
      if (best) {
        const k = `${best.e.id}:${best.side}`;
        if (!fronts.has(k) || best.d < fronts.get(k).d) fronts.set(k, best);
      }
    }
    const fl = [...fronts.values()].sort((p, q) => p.d - q.d);
    const base = { id: u.id, parts: u.parts.length, basis: u.basis, fronts: fl.length };
    if (!fl.length) { rows.push({ ...base, bucket: 'UNMATCHED', reason: 'no-street-facing-edge' }); continue; }
    const bucket = fl.length === 1 ? 'PRIMARY' : 'CORNER';
    const fr = fl[0];
    const segsW = wall.get(`${fr.e.id}:${fr.side}`);
    if (!segsW || !segsW.length) { rows.push({ ...base, bucket: 'UNMATCHED', reason: 'no-parcel-frontage', street: fr.e.name }); continue; }
    let bd = Infinity, bq = null;
    for (const s of segsW) { const r = segDist(fr.mx, fr.mz, s.a.x, s.a.z, s.b.x, s.b.z); if (r.d < bd) { bd = r.d; bq = r; } }
    const sign = Math.sign((bq.qx - fr.mx) * fr.nx + (bq.qz - fr.mz) * fr.nz) || 1;
    rows.push({ ...base, bucket, street: fr.e.name, edgeId: fr.e.id, side: fr.side,
                facing: +fr.d.toFixed(3), normal: [+fr.nx.toFixed(6), +fr.nz.toFixed(6)],
                m2: +(bd * sign).toFixed(3) });
  }
  return rows;
}
export { stats, FRONT_BAND };
