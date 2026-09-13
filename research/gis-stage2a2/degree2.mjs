/**
 * Stage 2A.2 Mission A — is the "junction floor" a real requirement, or a
 * limit of the current implementation?
 *
 *   node research/gis-stage2a2/degree2.mjs
 *
 * Two questions, answered separately.
 *
 * 1. CAN the graph carry a degree-2 segmentation node that is not a physical
 *    junction? Nothing in `RoadNetwork`, `Navigation` or `Traffic` branches on
 *    node degree — there is no Intersection type keyed to it — so a degree-2
 *    node is representable. That part is a yes.
 *
 * 2. WOULD splitting there contain the blast radius? That is decided by
 *    `RoadNetwork.buildPlots`, which subdivides PER EDGE:
 *
 *        const n    = Math.max(1, Math.round(acc / cfg.w));
 *        const step = acc / n;
 *
 *    `acc` is the whole edge's frontage length, so lot boundaries sit at
 *    `k * acc / round(acc / w)`. Split the edge anywhere and both halves get a
 *    new `acc`, a new `n` and a new `step`: every lot on BOTH sides moves. The
 *    phase is a function of total edge length, not of absolute position along
 *    the street.
 *
 *    A junction cut is the one exception, and not by luck: at a junction the
 *    two edges ALREADY exist separately in the baseline, so nothing outside
 *    changes because nothing outside is re-subdivided.
 *
 * This file measures (2) on the real Back Bay edges rather than asserting it.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;

globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const world = buildCurrentWorld();

/** Lot boundaries along a frontage of length `acc`, exactly as buildPlots lays them. */
const lots = (acc, w) => {
  const n = Math.max(1, Math.round(acc / w));
  const step = acc / n;
  return Array.from({ length: n + 1 }, (_, k) => k * step);
};
const W = 8.2;                                   // backBay lot rhythm, RoadNetwork.ZONING

/** For a real edge, how far do lots move if it is split at a degree-2 point? */
function probe(e) {
  let acc = 0;
  for (let i = 1; i < e.pts.length; i++) acc += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z);
  if (acc < 20) return null;
  const base = lots(acc, W);
  const worst = [];
  // Split at a range of interior fractions; a real seam cut is wherever the
  // core boundary happens to fall, so sample across the edge.
  for (const f of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const p = acc * f;
    const a = lots(p, W);                        // outside half, measured from the far end
    // Displacement of the OUTSIDE half's lot boundaries against the baseline's.
    let mx = 0;
    for (const v of a) {
      let best = Infinity;
      for (const b of base) { const d = Math.abs(b - v); if (d < best) best = d; }
      if (best > mx) mx = best;
    }
    worst.push({ splitFrac: f, maxLotShiftM: r2(mx) });
  }
  return { name: e.name, lengthM: r2(acc), lots: base.length - 1, worst };
}

// Edges that actually matter: those crossing the core boundary.
const crossing = world.net.edges.filter((e) => e.pts.some(inCore) && e.pts.some((p) => !inCore(p)));
const rows = crossing.map(probe).filter(Boolean);
const allShifts = rows.flatMap((r) => r.worst.map((w) => w.maxLotShiftM));
allShifts.sort((a, b) => a - b);

console.log('Q1  can the graph carry a degree-2 segmentation node?');
console.log('    YES — no consumer branches on node degree; there is no Intersection type keyed to it.\n');
console.log('Q2  would splitting there contain the blast radius?');
console.log('    buildPlots lays lots at k * acc / round(acc / w). Split the edge and BOTH halves re-phase.\n');
console.log('edge (crosses the core boundary)      length   lots   max lot shift on the OUTSIDE half, by split point');
for (const r of rows) console.log(`  ${r.name.padEnd(30)} ${String(r.lengthM).padStart(7)} ${String(r.lots).padStart(6)}   ` +
  r.worst.map((w) => `${w.maxLotShiftM}`).join(' / '));
console.log(`\nmax lot shift across all crossing edges and split points: min ${allShifts[0]} m, median ${allShifts[Math.floor(allShifts.length / 2)]} m, max ${allShifts[allShifts.length - 1]} m`);
console.log('A shift of even a metre re-positions every building on that frontage, which is what the');
console.log('outside-seam parcel count measures. Degree-2 segmentation is REPRESENTABLE but does NOT contain it.');

writeFileSync(new URL('./degree2.json', import.meta.url), JSON.stringify({
  schemaVersion: 'boston-gis-stage2a2/degree2/0.1.0',
  representable: true,
  representableEvidence: 'no consumer in RoadNetwork, Navigation or Traffic branches on node degree; no Intersection type is keyed to it',
  containsBlastRadius: false,
  mechanism: 'buildPlots subdivides per edge with n = round(acc/w), step = acc/n; lot phase is a function of total edge length, so any interior cut re-phases both halves',
  junctionException: 'at a junction the two edges already exist separately in the baseline, so nothing outside is re-subdivided',
  lotWidthM: W, crossingEdges: rows.length,
  maxLotShiftM: { min: allShifts[0], median: allShifts[Math.floor(allShifts.length / 2)], max: allShifts[allShifts.length - 1] },
  perEdge: rows,
}, null, 1) + '\n');
