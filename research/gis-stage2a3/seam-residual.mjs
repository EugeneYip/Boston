/**
 * Stage 2A.3 — what is left changed beyond the final seam, and why.
 *
 *   node research/gis-stage2a3/seam-residual.mjs
 *
 * Every changed parcel beyond the declared seam is attributed to the CONTROL
 * EDGE whose frontage it sits on, and then to a mechanism, by asking one
 * question about that edge: does it still exist in the candidate, with both
 * endpoints in the same place?
 *
 *   EDGE_CHANGED   — it does not. `buildPlots` phases lots per edge over the
 *                    edge's own length, so every lot on it moves. The edge
 *                    changed because a junction that delimited it has gone:
 *                    a hand-authored street crossing the core makes junctions
 *                    INSIDE it, with other hand-authored streets that the
 *                    factual data replaces, and clipping deletes those.
 *                    No cut position can prevent this — the lot-boundary
 *                    identity assumes the edge's OTHER end is fixed.
 *
 *   DEPTH_COUPLING — it does, unchanged. The lot moved anyway because its depth
 *                    comes from `rayToRoad`, cast up to `cfg.depth * 2 + 12` m
 *                    — 80 m in Back Bay — and inside that reach the ray now hits
 *                    factual geometry across the boundary. Replacing a road
 *                    changes what a lot 80 m away can see; that coupling is a
 *                    property of `buildPlots`, not of the seam.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
const r2 = (v) => Math.round(v * 100) / 100;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const man = JSON.parse(readFileSync(new URL('./candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const C = await build(null, 's1'), K = await build('?gisRoads=1', 's2');

const ends = (e) => [e.pts[0], e.pts[e.pts.length - 1]];
const survives = (ce) => K.world.net.edges.some((ke) => ke.name === ce.name &&
  ends(ce).every((p) => ends(ke).some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.5)));
const survivesInControl = (ke) => C.world.net.edges.some((ce) => ce.name === ke.name &&
  ends(ke).every((p) => ends(ce).some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.5)));
const surviveCache = new Map(), controlCache = new Map();
const lives = (ce) => { if (!surviveCache.has(ce)) surviveCache.set(ce, survives(ce)); return surviveCache.get(ce); };
const livesInControl = (ke) => { if (!controlCache.has(ke)) controlCache.set(ke, survivesInControl(ke)); return controlCache.get(ke); };

/**
 * The edge a lot is ACTUALLY on — `buildPlots` records it as `edgeId`.
 *
 * Nearest-centreline attribution is not good enough here: a Back Bay lot's
 * frontage sits `corridorHalf` off its own street and the alleys are ~30 m
 * apart, so the nearest centreline is often the wrong street. That misread put
 * depth-coupled lots 155 m out, well past `rayToRoad`'s 80 m reach.
 */
const cEdgeById = new Map(C.world.net.edges.map((e) => [e.id, e]));
const kEdgeById = new Map(K.world.net.edges.map((e) => [e.id, e]));
const ownerEdge = (p, cand) => (cand ? kEdgeById : cEdgeById).get(p.edgeId) || null;
const TOL = 0.05;
const pkey = (p) => `${p.width.toFixed(1)}_${p.depth.toFixed(1)}`;
function changedBeyond(cArr, kArr, pos, sig) {
  const g = (arr) => { const m = new Map();
    for (const v of arr) { const p = pos(v);
      for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
        const k = `${Math.round(p.x) + dx}_${Math.round(p.z) + dz}`;
        if (!m.has(k)) m.set(k, []); m.get(k).push(v); } }
    return m; };
  const key = (p) => `${Math.round(p.x)}_${Math.round(p.z)}`;
  const kg = g(kArr), cg = g(cArr), out = [];
  for (const v of cArr) { const p = pos(v);
    if (!(kg.get(key(p)) || []).some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v))) out.push(v); }
  for (const v of kArr) { const p = pos(v);
    if (!(cg.get(key(p)) || []).some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v))) out.push(v); }
  return out.filter((v) => distOut(pos(v)) > SEAM + 0.01);
}
const beyond = changedBeyond(C.b.plots.filter((p) => p.frontage), K.b.plots.filter((p) => p.frontage),
                             (p) => p.frontage.a, pkey);
const byMech = { EDGE_CHANGED: {}, DEPTH_COUPLING: {}, CONNECTOR_FRONTAGE: {} };
const reach = {};
const kSet = new Set(K.b.plots.filter((q) => q.frontage));
const connLL = new Set();
for (const c of man.connectorPaths || []) for (const v of c) connLL.add(`${v[0]},${v[1]}`);
const connectorEdges = new Set(K.world.net.edges.filter((e) =>
  ends(e).every((p) => (man.connectorWorld || []).some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.6))));
for (const p of beyond) {
  const fromCandidate = kSet.has(p);
  const e = ownerEdge(p, fromCandidate);
  if (!e) { byMech.UNATTRIBUTED = byMech.UNATTRIBUTED || {}; byMech.UNATTRIBUTED['(no edge)'] = (byMech.UNATTRIBUTED['(no edge)'] || 0) + 1; continue; }
  // A candidate-side lot is judged by whether ITS edge exists in the control.
  // A connector is SYNTHETIC road. Any frontage it generates is new by
  // definition, and it sits `corridorHalf` off a line that hugs the core
  // boundary — so it lands outside a seam declared from VERTICES alone.
  const m = connectorEdges.has(e) ? 'CONNECTOR_FRONTAGE'
    : (fromCandidate ? livesInControl(e) : lives(e)) ? 'DEPTH_COUPLING' : 'EDGE_CHANGED';
  byMech[m][e.name] = (byMech[m][e.name] || 0) + 1;
  reach[m] = Math.max(reach[m] || 0, distOut(p.frontage.a));
}
const tot = (o) => Object.values(o).reduce((a, b) => a + b, 0);
console.log(`FINAL SEAM ${SEAM} m — parcels changed beyond it: ${beyond.length}\n`);
for (const m of Object.keys(byMech)) {
  console.log(`  ${m}  ${tot(byMech[m])} parcels, furthest ${r2(reach[m] || 0)} m beyond the core`);
  console.log(`      ${Object.entries(byMech[m]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}\n`);
}
writeFileSync(new URL('./seam-residual.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a3/seam-residual/0.1.0', finalSeamM: SEAM,
    beyondSeam: beyond.length, byMechanism: byMech,
    furthestM: Object.fromEntries(Object.entries(reach).map(([k, v]) => [k, r2(v)])) }, null, 1) + '\n');
