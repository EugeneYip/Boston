/**
 * Stage 2A.1 task 1 — WHY did 1,038 parcels outside the core move?
 *
 *   node research/gis-stage2a1/blast-trace.mjs
 *
 * Attribution before repair. Traces one representative street all the way from
 * the Stage 2A replacement decision to the parcels that changed, and tests the
 * competing mechanisms against each other rather than assuming one.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));

async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const C = await build(null, 'c'), K = await build('?gisRoads=1', 'k');

/** An edge's identity independent of array index: name + endpoints + length. */
function edgeKey(e) {
  let L = 0;
  for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z);
  const a = e.pts[0], b = e.pts[e.pts.length - 1];
  return { key: `${e.name}|${a.x.toFixed(1)},${a.z.toFixed(1)}|${b.x.toFixed(1)},${b.z.toFixed(1)}`, L };
}
const cEdges = new Map(), kEdges = new Map();
for (const e of C.world.net.edges) { const { key, L } = edgeKey(e); cEdges.set(key, { e, L }); }
for (const e of K.world.net.edges) { const { key, L } = edgeKey(e); kEdges.set(key, { e, L }); }

/** Parcels keyed by exact geometry, so an id change is not a geometry change. */
const pkey = (p) => `${p.frontage.a.x.toFixed(3)}_${p.frontage.a.z.toFixed(3)}_${p.width.toFixed(3)}_${p.depth.toFixed(3)}`;
const cP = new Map(C.b.plots.filter((p) => p.frontage).map((p) => [pkey(p), p]));
const kP = new Map(K.b.plots.filter((p) => p.frontage).map((p) => [pkey(p), p]));
const lost = [...cP].filter(([k]) => !kP.has(k)).map(([, p]) => p);
const gained = [...kP].filter(([k]) => !cP.has(k)).map(([, p]) => p);
const changed = [...lost, ...gained];
const outside = changed.filter((p) => distOut(p.frontage.a) > 0);

/* -- mechanism 1: was the parcel's own street CLIPPED by Stage 2A? ---------- */
const { GIS_ROADS_CLIPPED, GIS_ROADS } = await import('../../src/data/gis-backbay-roads.js');
const clippedNames = new Set(GIS_ROADS_CLIPPED.map((c) => c.name));
/* -- mechanism 2: was a FACTUAL street added with the same Boston name? ----- */
const factualNames = new Set(GIS_ROADS.map((r) => r.name));

const tally = { clippedStreet: 0, factualSameName: 0, neither: 0 };
const byStreet = new Map();
for (const p of outside) {
  const w = (cP.has(pkey(p)) ? C : K).world;
  const name = w.net.edges[p.edgeId]?.name || '?';
  const cl = clippedNames.has(name), fa = factualNames.has(name);
  if (cl) tally.clippedStreet++; else if (fa) tally.factualSameName++; else tally.neither++;
  let s = byStreet.get(name);
  if (!s) byStreet.set(name, s = { n: 0, clipped: cl, factual: fa, maxDist: 0 });
  s.n++; s.maxDist = Math.max(s.maxDist, distOut(p.frontage.a));
}

/* -- mechanism 3: did the parcel's EDGE change length (re-split)? ----------- */
let edgeSplitExplained = 0, edgeIdentical = 0;
for (const p of outside) {
  const src = cP.has(pkey(p)) ? C : K;
  const e = src.world.net.edges[p.edgeId];
  if (!e) continue;
  const { key } = edgeKey(e);
  const other = (src === C ? kEdges : cEdges).get(key);
  if (other) edgeIdentical++; else edgeSplitExplained++;
}

console.log(`parcels changed ${changed.length} (lost ${lost.length}, gained ${gained.length}); outside the core ${outside.length}`);
console.log(`max distance beyond the core edge: ${r2(Math.max(...outside.map((p) => distOut(p.frontage.a))))} m\n`);
console.log('=== mechanism attribution, per outside-core changed parcel ===');
console.log(`  its street was CLIPPED by Stage 2A              : ${tally.clippedStreet}`);
console.log(`  a FACTUAL street of the same name was ADDED     : ${tally.factualSameName}`);
console.log(`  neither — collateral                            : ${tally.neither}`);
console.log(`  its road EDGE no longer exists with the same identity (re-split): ${edgeSplitExplained}`);
console.log(`  its road EDGE is identical in both worlds       : ${edgeIdentical}`);
console.log('\n=== per street ===');
console.log('street                          changed  maxDist  clipped  factualAdded');
for (const [n, s] of [...byStreet].sort((a, b) => b[1].n - a[1].n))
  console.log(`  ${n.padEnd(30)} ${String(s.n).padStart(6)} ${r2(s.maxDist).toFixed(1).padStart(8)} ${String(s.clipped).padStart(8)} ${String(s.factual).padStart(13)}`);

/* -- trace one representative street end to end ---------------------------- */
const TRACE = 'Gloucester Street';
console.log(`\n=== trace: ${TRACE} (neither clipped nor factually added) ===`);
const cg = C.world.net.edges.filter((e) => e.name === TRACE);
const kg = K.world.net.edges.filter((e) => e.name === TRACE);
console.log(`  edges: control ${cg.length}, candidate ${kg.length}`);
const len = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
for (const [lbl, arr] of [['control', cg], ['candidate', kg]])
  console.log(`  ${lbl}: ` + arr.map((e) => `#${e.id} ${r2(len(e))}m a=${e.a} b=${e.b}`).join('  |  '));
const cNodes = new Set(cg.flatMap((e) => [e.a, e.b])), kNodes = new Set(kg.flatMap((e) => [e.a, e.b]));
console.log(`  node count on this street: control ${cNodes.size}, candidate ${kNodes.size}`);

const out = { schemaVersion: 'boston-gis-stage2a1/blast-trace/0.1.0',
  core: CORE, changed: changed.length, outsideCore: outside.length,
  maxDistanceM: r2(Math.max(...outside.map((p) => distOut(p.frontage.a)))),
  attribution: { ...tally, edgeReSplit: edgeSplitExplained, edgeIdentical },
  perStreet: [...byStreet].map(([name, s]) => ({ name, changed: s.n, maxDistM: r2(s.maxDist), clipped: s.clipped, factualAdded: s.factual })).sort((a, b) => b.changed - a.changed),
  trace: { street: TRACE, controlEdges: cg.map((e) => ({ id: e.id, lengthM: r2(len(e)), a: e.a, b: e.b })),
           candidateEdges: kg.map((e) => ({ id: e.id, lengthM: r2(len(e)), a: e.a, b: e.b })) } };
writeFileSync(new URL('./blast-trace.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
