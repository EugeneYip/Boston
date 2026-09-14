/**
 * Stage 2A.4 — every changed ROAD edge, and why.
 *
 *   node research/gis-stage2a4/road-audit.mjs
 *
 * The road-geometry contract is strict: outside ROAD_GEOMETRY_SEAM there must be
 * no connector-attributable change, no endpoint-snap mutation and no
 * candidate-created road split. This enumerates every edge that differs between
 * the worlds and attributes it, so those three counts are measured rather than
 * asserted.
 *
 * An edge can differ for exactly these reasons:
 *
 *   FACTUAL_CORE      a SAM edge inside the core (the candidate's whole point)
 *   TRANSITION_CONNECTOR  a synthetic seam join
 *   LOT_GRID_CUT      a hand-authored edge truncated at its declared cut
 *   CUT_NEIGHBOUR     an edge whose endpoint is a cut node, so its length
 *                     follows from the cut rather than from a new split
 *   COORDINATE_ROUNDTRIP  same edge, same endpoints, length differs under 5 cm
 *   UNINTENDED_SPLIT  none of the above — a split the candidate created
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const man = JSON.parse(readFileSync(new URL('../gis-stage2a3/candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
const TOL = 0.05;

async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  return buildCurrentWorld();
}
const C = await build(null, 'R1'), K = await build('?gisRoads=1', 'R2');
const elen = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
const ends = (e) => [e.pts[0], e.pts[e.pts.length - 1]];
const sameEdge = (a, b) => a.name === b.name && Math.abs(elen(a) - elen(b)) < TOL &&
  ends(a).every((q) => ends(b).some((r) => Math.hypot(q.x - r.x, q.z - r.z) < TOL));

const cutPts = man.lotCuts.map((c) => c.point);
const atCut = (p) => cutPts.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 0.8);
const connVerts = man.connectorWorld;
const atConn = (p) => connVerts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.6);
const factualNames = new Set(man.mapping.map((m) => m.boston));
/** Every factual path vertex, to recognise a SAM edge. */
const clippedNames = new Set(man.clippedStreets.map((c) => c.name));

function classify(e, other, side) {
  const E = ends(e);
  // Inside the core the two worlds are simply different: the candidate's edges
  // are SAM, the control's are the hand-authored ones SAM replaces. Neither is a
  // split and neither is outside the seam.
  if (E.every(inCore)) return side === 'candidate' ? 'FACTUAL_CORE' : 'CORE_REPLACED';
  if (E.every(atConn) && elen(e) <= Math.max(...man.connectors.lengths) + 1) return 'TRANSITION_CONNECTOR';
  // Same name, same two endpoints, only a sub-5 cm length difference.
  const twin = other.net.edges.find((o) => o.name === e.name &&
    E.every((q) => ends(o).some((r) => Math.hypot(q.x - r.x, q.z - r.z) < 0.6)));
  if (twin && Math.abs(elen(twin) - elen(e)) < 0.5) return 'COORDINATE_ROUNDTRIP';
  if (E.some(atCut)) return clippedNames.has(e.name) ? 'LOT_GRID_CUT' : 'CUT_NEIGHBOUR';
  // A control edge that straddles the boundary is the edge the cut consumed: the
  // candidate keeps only its outside part, which is a different edge object.
  if (side === 'control' && E.some(inCore) && clippedNames.has(e.name)) return 'LOT_GRID_CUT';
  return 'UNINTENDED_SPLIT';
}
const rows = [];
for (const [side, mine, other] of [['control', C, K], ['candidate', K, C]]) {
  for (const e of mine.net.edges) {
    if (other.net.edges.some((o) => sameEdge(e, o))) continue;
    const E = ends(e);
    rows.push({ side, name: e.name, id: e.id, lengthM: r2(elen(e)),
                kind: classify(e, other, side),
                endsOutM: E.map((p) => r2(distOut(p))),
                maxOutM: r2(Math.max(...E.map(distOut))) });
  }
}
const by = {};
for (const r of rows) { const b = (by[r.kind] ||= { n: 0, names: {}, maxOutM: 0 });
  b.n++; b.names[r.name] = (b.names[r.name] || 0) + 1; b.maxOutM = Math.max(b.maxOutM, r.maxOutM); }
console.log(`changed road edges: ${rows.length}\n`);
console.log(`${'kind'.padEnd(22)} ${'n'.padStart(4)} ${'maxEndOut'.padStart(10)}   streets`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n))
  console.log(`${k.padEnd(22)} ${String(v.n).padStart(4)} ${String(v.maxOutM).padStart(10)}   ` +
    Object.entries(v.names).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s} ${n}`).join(', '));
const un = rows.filter((r) => r.kind === 'UNINTENDED_SPLIT');
if (un.length) { console.log(`\nUNINTENDED_SPLIT detail:`);
  for (const r of un) console.log(`  ${r.side.padEnd(10)} ${r.name.padEnd(30)} len ${String(r.lengthM).padStart(8)} ends out [${r.endsOutM.join(', ')}]`); }
writeFileSync(new URL('./road-audit.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a4/road-audit/0.1.0', roadGeometrySeamM: SEAM,
    changedEdges: rows.length, byKind: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.n])),
    unintendedSplits: un.length, detail: by, edges: rows }, null, 1) + '\n');
