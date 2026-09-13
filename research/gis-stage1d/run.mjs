/**
 * Stage 1D — deterministic entry point.
 *
 *   node research/gis-stage1d/run.mjs
 *
 * Read-only. Produces research/gis-stage1d/summary.json from repository inputs
 * only: no network, no DOIT, no runtime change, no WebGL.
 */
import { writeFileSync } from 'node:fs';
import { buildSamples, junctionDistance, TOL_M } from './samples.mjs';
import { fitModel, admissibility, MODELS } from './fit.mjs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

const { F, faces, samples, provenance, net } = buildSamples();
const centre = { x: samples.reduce((s, v) => s + v.x, 0) / samples.length,
                 z: samples.reduce((s, v) => s + v.z, 0) / samples.length };

console.log(`samples ${samples.length} on ${new Set(samples.map((s) => s.faceKey)).size} faces, ` +
  `centre (${centre.x.toFixed(1)}, ${centre.z.toFixed(1)})\n`);

const fits = {};
console.log('model                                            params  median   p75    p90    max    rms | admissible frontage');
for (const key of ['G0', 'G1', 'G2', 'G3', 'W', 'G2W', 'PSW', 'PSL', 'PSLW']) {
  const f = fitModel(key, samples, centre);
  const adm = admissibility(samples, f.resid, faces);
  fits[key] = { ...f, resid: undefined, admissibility: { ...adm, detail: undefined } };
  fits[key].admissibleDetail = adm.detail;
  console.log(`${f.name.padEnd(48)} ${String(f.params).padStart(5)} ` +
    `${String(f.residual.median).padStart(7)} ${String(f.residual.p75).padStart(6)} ${String(f.residual.p90).padStart(6)} ` +
    `${String(f.residual.max).padStart(6)} ${String(f.residual.rms).padStart(6)} | ` +
    `${String(adm.admissibleFrontageM).padStart(7)} m of ${adm.twoSidedFrontageM} (${(100 * adm.admissibleFrontageM / adm.twoSidedFrontageM).toFixed(1)}%), ` +
    `${adm.admissibleEdges}/${adm.twoSidedEdges} roads`);
}
// Per-edge fitted parameters: the street-by-street matrix, and the test of
// whether anything global could have produced them.
const edgeIds = [...new Set(samples.map((s) => s.edgeId))].sort((a, b) => a - b);
const nameOf = (id) => net.edges[id]?.name || `edge${id}`;
const twoSidedIds = fits.PSLW.twoSided;
const perEdge = edgeIds.map((id, i) => ({ edgeId: id, street: nameOf(id),
  lateralM: twoSidedIds.indexOf(id) >= 0 ? fits.PSLW.beta[twoSidedIds.indexOf(id)] : null,
  widthM: fits.PSLW.beta[twoSidedIds.length + i],
  samples: samples.filter((s) => s.edgeId === id).length,
  sides: new Set(samples.filter((s) => s.edgeId === id).map((s) => s.side)).size }));
console.log('\n=== per-street fitted corrections (PSL+PSW, diagnostic only) ===');
console.log('street                        edge  sides  n     lateral   width(half)');
for (const e of perEdge) console.log(`${e.street.padEnd(29)} ${String(e.edgeId).padStart(4)} ${String(e.sides).padStart(6)} ${String(e.samples).padStart(5)} ` +
  `${String(e.lateralM).padStart(9)} ${String(e.widthM).padStart(12)}`);
const twoSided = perEdge.filter((e) => e.sides === 2);
const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
console.log(`\ntwo-sided roads ${twoSided.length}: lateral mean ${r2(twoSided.reduce((s,e)=>s+e.lateralM,0)/twoSided.length)} sd ${r2(sd(twoSided.map((e)=>e.lateralM)))} m  |  ` +
  `width mean ${r2(twoSided.reduce((s,e)=>s+e.widthM,0)/twoSided.length)} sd ${r2(sd(twoSided.map((e)=>e.widthM)))} m`);
console.log(`If a global translation explained these, the lateral corrections would share a sign and magnitude. They do not.`);

console.log(`\nG1 translation  (dx, dz) = (${fits.G1.beta[0]}, ${fits.G1.beta[1]}) m`);
console.log(`G2 rigid        (dx, dz) = (${fits.G2.beta[0]}, ${fits.G2.beta[1]}) m, rotation ${r2(fits.G2.beta[2] * 180 / Math.PI)} deg about (${centre.x.toFixed(0)}, ${centre.z.toFixed(0)})`);
console.log(`W  width        per type: ${fits.W.types.map((t, i) => `${t} ${fits.W.beta[i]} m`).join(', ')}`);
console.log(`G2W combined    (dx, dz) = (${fits.G2W.beta[0]}, ${fits.G2W.beta[1]}) m, rot ${r2(fits.G2W.beta[2] * 180 / Math.PI)} deg, width ${fits.G2W.types.map((t, i) => `${t} ${fits.G2W.beta[3 + i]} m`).join(', ')}`);

/* ---- Phase 5: intersection effect ---------------------------------------- */
const withJ = samples.map((s) => ({ ...s, j: junctionDistance(net, s.x, s.z) }));
const jd = withJ.map((s) => s.j).sort((a, b) => a - b);
const cut = q(jd, 0.25);
const g0 = fitModel('G0', samples, centre), g2w = fitModel('G2W', samples, centre);
const near = withJ.map((s, i) => ({ ...s, r0: g0.resid[i], r2: g2w.resid[i] })).filter((s) => s.j <= cut);
const mid = withJ.map((s, i) => ({ ...s, r0: g0.resid[i], r2: g2w.resid[i] })).filter((s) => s.j > cut);
const st = (a, k) => ({ n: a.length, median: r2(q(a.map((v) => Math.abs(v[k])), 0.5)), p90: r2(q(a.map((v) => Math.abs(v[k])), 0.9)) });
const intersection = { cutoffM: r2(cut), near: { raw: st(near, 'r0'), afterG2W: st(near, 'r2') },
                       midBlock: { raw: st(mid, 'r0'), afterG2W: st(mid, 'r2') } };
console.log(`\nintersection effect (cutoff ${r2(cut)} m to nearest junction):`);
console.log(`  near-junction  n=${intersection.near.raw.n}  raw median ${intersection.near.raw.median} p90 ${intersection.near.raw.p90}   after G2+W median ${intersection.near.afterG2W.median}`);
console.log(`  mid-block      n=${intersection.midBlock.raw.n}  raw median ${intersection.midBlock.raw.median} p90 ${intersection.midBlock.raw.p90}   after G2+W median ${intersection.midBlock.afterG2W.median}`);

/* ---- Phase 10: cross-validation ------------------------------------------ */
const keys = [...new Set(samples.map((s) => s.faceKey))].sort();
const trainKeys = new Set(keys.filter((_, i) => i % 2 === 0));
const tr = samples.filter((s) => trainKeys.has(s.faceKey));
const te = samples.filter((s) => !trainKeys.has(s.faceKey));
const cv = {};
for (const key of ['G1', 'G2', 'W', 'G2W', 'PSL', 'PSW']) {
  const f = fitModel(key, tr, centre);
  const types = f.types, edges = [...new Set(samples.map((s) => s.edgeId))].sort((a, b) => a - b);
  const helper = { typeCols: (s) => types.map((t) => (s.type === t ? 1 : 0)),
                   edgeCols: (s) => edges.map((e) => (s.edgeId === e ? 1 : 0)) };
  const held = te.map((s) => {
    const row = MODELS[key].cols(s, centre, helper);
    return Math.abs(s.d - row.reduce((a, v, k) => a + v * (f.beta[k] ?? 0), 0));
  });
  cv[key] = { trainMedian: f.residual.median, heldOutMedian: r2(q(held, 0.5)), heldOutP90: r2(q(held, 0.9)), n: held.length };
  console.log(`cross-val ${key.padEnd(4)} train median ${String(f.residual.median).padStart(6)}   held-out median ${String(cv[key].heldOutMedian).padStart(6)}  p90 ${cv[key].heldOutP90}`);
}

const out = {
  schemaVersion: 'boston-gis-stage1d/summary/0.1.0',
  inputs: { provenance, tolM: TOL_M, samples: samples.length,
            faces: new Set(samples.map((s) => s.faceKey)).size, centre: { x: r2(centre.x), z: r2(centre.z) } },
  semantics: {
    proceduralFrontLine: 'centreline offset by corridorHalf(e) = e.halfRoad + 0.16 + e.walk, via RoadNetwork._frontageLine',
    proceduralWallToWall: '2 * corridorHalf(e)',
    proceduralWallMidline: 'identically the road centreline — the offset is symmetric in side and nothing downstream moves it laterally',
    factualWallMidline: 'midpoint of the two opposing factual first-hit walls; NOT a road centreline',
    dSign: 'positive outward, away from the carriageway',
  },
  corridorHalfByType: Object.fromEntries([...new Set(samples.map((s) => s.type))].sort()
    .map((t) => [t, r2(samples.find((s) => s.type === t).corridorHalf)])),
  fits, perEdge, intersection, crossValidation: cv,
};
writeFileSync(new URL('./summary.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('\nwrote research/gis-stage1d/summary.json');
