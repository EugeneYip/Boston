/**
 * Stage 1C — is the measured displacement a BUILDING-LINE signal or a
 * ROAD-PLACEMENT artefact?
 *
 *   node research/gis-stage1c/roadcheck.mjs
 *
 * The phase-3 profile says the factual wall sits several metres in front of
 * Boston's procedural wall on most Back Bay faces. There are two very different
 * explanations and the whole stage turns on which it is:
 *
 *   (a) Boston's buildings are set back too far — a building-line error, which
 *       is exactly what Stage 1C exists to correct; or
 *   (b) Boston's ROAD is not where the real road is — in which case the factual
 *       wall lands inside the carriageway, and "correcting" the building line
 *       would move Boston's houses into its own street.
 *
 * Two tests separate them:
 *
 *   1. How much factual building area lies INSIDE a Boston road corridor? Under
 *      (a) almost none should. Under (b) a great deal will.
 *   2. For a street with both faces present, split the two displacements into a
 *      SHIFT component (d0 - d1)/2 and a WIDTH component (d0 + d1)/2. A
 *      misplaced road shows up as shift; a genuinely too-wide street shows up
 *      as width.
 */
import { writeFileSync } from 'node:fs';
import { buildFrames } from './frames.mjs';
import { loadSources } from './sources.mjs';
import { analyse } from './classify.mjs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';
import { bbox, polyArea } from '../../src/world/GisAssociate.js';

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/** Every road segment in the area, with its corridor half-width and carriageway half-width. */
function segments(net, box) {
  const out = [];
  for (let i = 0; i < net.edges.length; i++) {
    const e = net.edges[i];
    const ch = corridorHalf(e), road = e.halfRoad;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const a = e.pts[k], b = e.pts[k + 1];
      if (Math.max(a.x, b.x) < box.x0 - 80 || Math.min(a.x, b.x) > box.x1 + 80) continue;
      if (Math.max(a.z, b.z) < box.z0 - 80 || Math.min(a.z, b.z) > box.z1 + 80) continue;
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      out.push({ ax: a.x, az: a.z, ux: dx / L, uz: dz / L, len: L, corridor: ch, road, edgeId: i, name: e.name });
    }
  }
  return out;
}
/** Perpendicular distance to a segment, and whether the foot is on it. */
function distTo(s, x, z) {
  let t = (x - s.ax) * s.ux + (z - s.az) * s.uz;
  t = t < 0 ? 0 : t > s.len ? s.len : t;
  return Math.hypot(x - (s.ax + s.ux * t), z - (s.az + s.uz * t));
}
const inRing = (px, pz, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) &&
        (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c;
};

const F = buildFrames();
const { pddl, massgis } = loadSources();
const box = { x0: Math.min(...F.local.map((p) => p.polygon[0].x)) - 60, x1: Math.max(...F.local.map((p) => p.polygon[0].x)) + 60,
              z0: Math.min(...F.local.map((p) => p.polygon[0].z)) - 60, z1: Math.max(...F.local.map((p) => p.polygon[0].z)) + 60 };
const segs = segments(F.world.net, box);

/** Test 1 — factual area inside a Boston road corridor / carriageway. */
function insideRoad(set, label) {
  const STEP = 1.0;
  let area = 0, inCorr = 0, inRoad = 0;
  const perPoly = [];
  for (const g of set) {
    const b = bbox(g.ring);
    if (b.x1 < box.x0 || b.x0 > box.x1 || b.z1 < box.z0 || b.z0 > box.z1) continue;
    let n = 0, c = 0, r = 0;
    for (let z = b.z0; z <= b.z1; z += STEP) {
      for (let x = b.x0; x <= b.x1; x += STEP) {
        if (!inRing(x, z, g.ring)) continue;
        n++;
        let dc = Infinity, dr = Infinity;
        for (const s of segs) {
          const d = distTo(s, x, z);
          if (d - s.corridor < dc) dc = d - s.corridor;
          if (d - s.road < dr) dr = d - s.road;
        }
        if (dc < 0) c++;
        if (dr < 0) r++;
      }
    }
    if (!n) continue;
    area += n * STEP * STEP; inCorr += c * STEP * STEP; inRoad += r * STEP * STEP;
    perPoly.push({ oid: g.oid, areaM2: n * STEP * STEP, pctInCorridor: 100 * c / n, pctInCarriageway: 100 * r / n });
  }
  const pc = perPoly.map((p) => p.pctInCorridor);
  console.log(`${label.padEnd(9)} polygons ${String(perPoly.length).padStart(4)}  area ${area.toFixed(0).padStart(7)} m2  ` +
    `inside corridor ${(100 * inCorr / area).toFixed(1).padStart(5)}%  inside carriageway ${(100 * inRoad / area).toFixed(1).padStart(5)}%  ` +
    `| per-polygon %-in-corridor p50 ${r2(q(pc, .5))} p90 ${r2(q(pc, .9))}  | wholly clear ${pc.filter((v) => v < 1).length}`);
  return { label, polygons: perPoly.length, areaM2: r2(area), pctAreaInCorridor: r2(100 * inCorr / area),
           pctAreaInCarriageway: r2(100 * inRoad / area),
           perPolygonPctInCorridor: { p50: r2(q(pc, .5)), p90: r2(q(pc, .9)) },
           pollygonsWhollyClear: pc.filter((v) => v < 1).length };
}
console.log('=== TEST 1 — factual building area inside Boston road corridors ===');
const t1 = [insideRoad(pddl, 'PDDL'), insideRoad(massgis, 'MassGIS')];

/** Test 2 — shift vs width, per street edge with both faces measured. */
console.log('\n=== TEST 2 — per-edge decomposition of the displacement ===');
const A = analyse(0.5);
const byEdge = new Map();
for (const f of A.perFace) {
  if (f.dMedian === null) continue;
  let e = byEdge.get(f.edgeId);
  if (!e) byEdge.set(f.edgeId, e = { edgeId: f.edgeId, street: f.street });
  e[f.side ? 'd1' : 'd0'] = f.dMedian;
  e[f.side ? 'a1' : 'a0'] = f.agreePct;
  e[f.side ? 'n1' : 'n0'] = f.parcels;
}
const rows = [...byEdge.values()].filter((e) => e.d0 !== undefined && e.d1 !== undefined);
console.log('street                        edge  corridorHalf  d(side0)  d(side1)   SHIFT   WIDTH  procW  factW  agree%');
const out2 = [];
for (const e of rows.sort((a, b) => (b.a0 + b.a1) - (a.a0 + a.a1))) {
  const ch = corridorHalf(F.world.net.edges[e.edgeId]);
  const shift = (e.d0 - e.d1) / 2, width = (e.d0 + e.d1) / 2;
  const procW = 2 * ch, factW = procW + e.d0 + e.d1;
  out2.push({ ...e, corridorHalfM: r2(ch), shiftM: r2(shift), widthM: r2(width), proceduralWidthM: r2(procW), factualWidthM: r2(factW) });
  console.log(`${e.street.padEnd(29)} ${String(e.edgeId).padStart(4)} ${ch.toFixed(2).padStart(13)} ${String(e.d0).padStart(9)} ${String(e.d1).padStart(9)} ` +
    `${r2(shift).toFixed(2).padStart(7)} ${r2(width).toFixed(2).padStart(7)} ${procW.toFixed(1).padStart(6)} ${factW.toFixed(1).padStart(6)} ${((e.a0 + e.a1) / 2).toFixed(0).padStart(6)}`);
}
const shifts = out2.map((e) => Math.abs(e.shiftM)), widths = out2.map((e) => e.widthM);
console.log(`\n|SHIFT| p50 ${r2(q(shifts,.5))} m  p90 ${r2(q(shifts,.9))} m   (road misplacement)`);
console.log(`WIDTH  p50 ${r2(q(widths,.5))} m  p90 ${r2(q(widths,.9))} m   (genuine setback difference)`);
writeFileSync(new URL('./roadcheck.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage1c/roadcheck/0.1.0', areaInsideRoads: t1, perEdge: out2,
    summary: { absShiftM: { p50: r2(q(shifts,.5)), p90: r2(q(shifts,.9)) }, widthM: { p50: r2(q(widths,.5)), p90: r2(q(widths,.9)) } } }, null, 1) + '\n');
