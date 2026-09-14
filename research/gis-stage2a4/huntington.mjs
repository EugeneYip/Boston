/**
 * Stage 2A.4 — is Huntington's 2.28 m phase residual genuinely minimal?
 *
 *   node research/gis-stage2a4/huntington.mjs
 *
 * Independently reproduced, and tested by a DENSE SCAN rather than by the
 * generator's own candidate set — otherwise the answer would only be "the
 * generator picked the best of the positions the generator considered".
 *
 * `buildPlots` subdivides the FRONTAGE line, once per side:
 *
 *     n = max(1, round(acc / cfg.w))      step = acc / n
 *
 * Cutting the edge at arc `t` leaves the outside part with length `kept`, and
 * that part keeps the baseline phase only if `kept` is a whole number of
 * baseline steps. The error on one side is |kept - round(kept/step)*step|, and
 * the error that matters is the WORSE of the two sides, because one cut serves
 * both.
 *
 * On a straight edge both frontages have the same length, so both grids are the
 * same and every lot boundary is a joint zero. Huntington bends.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const man = JSON.parse(readFileSync(new URL('../gis-stage2a3/candidate-manifest.json', import.meta.url), 'utf8'));
globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const RN = (await import('../../src/world/RoadNetwork.js')).default;
const C = buildCurrentWorld();

const cut = man.lotCuts.find((c) => c.phaseErrorM > 0);
console.log(`the one out-of-phase cut: ${cut.street}, edge ${cut.edgeLengthM} m, sideLots ${JSON.stringify(cut.sideLots)}, generator phase error ${cut.phaseErrorM} m\n`);

/** The baseline edge that carries this cut. */
const arcAt = (pts, p) => { let acc = 0, best = { d: Infinity, t: 0 };
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1, L = Math.sqrt(L2);
    let f = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2; f = f < 0 ? 0 : f > 1 ? 1 : f;
    const d = Math.hypot(p.x - (a.x + ex * f), p.z - (a.z + ez * f));
    if (d < best.d) best = { d, t: acc + f * L }; acc += L; }
  return best; };
const atArc = (pts, t) => { let acc = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + d >= t || i === pts.length - 1) { const f = d < 1e-9 ? 0 : (t - acc) / d;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f }; }
    acc += d; }
  return pts[pts.length - 1]; };
const arcLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return L; };

let E = null;
for (const e of C.net.edges) { if (e.name !== cut.street) continue;
  const a = arcAt(e.pts, cut.point); if (!E || a.d < E.a.d) E = { e, a }; }
const e = E.e, acc = arcLen(e.pts);
const outwardIsStart = !inCore(e.pts[0]);

function sideGrid(side) {
  const line = C.net._frontageLine(e, side);
  let a2 = 0; const segs = [];
  for (let i = 1; i < line.length; i++) { const L = Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    segs.push({ a: line[i - 1], b: line[i], L, s: a2 }); a2 += L; }
  const probe = C.net._along(segs, a2 / 2, a2);
  const dist = C.districts.districtAt(probe.x, probe.z);
  const cfg = (dist && dist in RN.ZONING) ? RN.ZONING[dist] : RN.ZONING.southEnd;
  const n = Math.max(1, Math.round(a2 / cfg.w));
  return { line, acc: a2, dist, w: cfg.w, n, step: a2 / n };
}
const A = sideGrid(-1), B = sideGrid(1);
console.log(`edge centreline           ${r2(acc)} m`);
console.log(`frontage side -1          ${r2(A.acc)} m   district ${A.dist}  w ${A.w}  n ${A.n}  step ${r3(A.step)} m`);
console.log(`frontage side +1          ${r2(B.acc)} m   district ${B.dist}  w ${B.w}  n ${B.n}  step ${r3(B.step)} m`);
console.log(`  -> the two sides differ by ${r2(Math.abs(A.acc - B.acc))} m, which rounds to DIFFERENT lot counts (${A.n} vs ${B.n})\n`);

const phaseErr = (g, p) => { const t = arcAt(g.line, p).t;
  const kept = outwardIsStart ? t : g.acc - t;
  return Math.abs(kept - Math.round(kept / g.step) * g.step); };
/** Dense scan: every centimetre of the edge that lies outside the core. */
const STEP_M = 0.01;
let best = null, bestNear = null;
const crossingT = arcAt(e.pts, { x: cut.point.x, z: cut.point.z }).t;
const oneLot = Math.max(A.step, B.step);
const samples = [];
for (let t = 0; t <= acc; t += STEP_M) {
  const p = atArc(e.pts, t);
  if (inCore(p)) continue;
  const eA = phaseErr(A, p), eB = phaseErr(B, p);
  const worst = Math.max(eA, eB);
  samples.push({ t, worst });
  if (!best || worst < best.worst) best = { t, worst, eA, eB, p };
  if (Math.abs(t - crossingT) <= oneLot + 1e-6 && (!bestNear || worst < bestNear.worst)) bestNear = { t, worst, eA, eB, p };
}
console.log(`DENSE SCAN at ${STEP_M * 100} cm over every position outside the core (${samples.length} positions)`);
console.log(`  best anywhere on the edge      worst-side error ${r3(best.worst)} m  at arc ${r2(best.t)} m  (side -1 ${r3(best.eA)}, side +1 ${r3(best.eB)})`);
console.log(`  best within ONE LOT of the crossing  worst-side error ${r3(bestNear.worst)} m  at arc ${r2(bestNear.t)} m`);
console.log(`  generator chose                 ${cut.phaseErrorM} m`);
const confirmed = Math.abs(bestNear.worst - cut.phaseErrorM) < 0.02;
console.log(`\n  2.28 m confirmed minimal within the seam bound? ${confirmed}`);
console.log(`  could a cut further out do better? ${best.worst < bestNear.worst - 0.02 ? `yes, ${r3(best.worst)} m at ${r2(Math.abs(best.t - crossingT))} m from the crossing` : 'no'}`);

/* Why no position can be zero: the two grids share a zero only where
   kA*stepA == kB*stepB for integers kA, kB within the edge. */
const lcmHits = [];
for (let ka = 0; ka <= A.n; ka++) { const tA = ka * A.step;
  const kb = Math.round(tA / B.step);
  if (Math.abs(tA - kb * B.step) < 0.05) lcmHits.push({ ka, kb, tA: r2(tA) }); }
console.log(`\njoint zeros of the two lot grids (within 5 cm): ${lcmHits.length}` +
  (lcmHits.length ? ` at arc ${lcmHits.map((h) => h.tA).join(', ')} m` : ''));

const affected = JSON.parse(readFileSync(new URL('./parcel-ledger.json', import.meta.url), 'utf8'))
  .parcels.filter((p) => p.cause === 'LOT_PHASE_RECOMPUTED');
console.log(`\naffected parcel records: ${affected.length}, furthest ${Math.max(...affected.map((p) => p.beyondSeamM))} m beyond the core`);
writeFileSync(new URL('./huntington.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a4/huntington/0.1.0', street: cut.street,
    centrelineM: r2(acc), sideMinus1: { acc: r2(A.acc), district: A.dist, w: A.w, n: A.n, step: r3(A.step) },
    sidePlus1: { acc: r2(B.acc), district: B.dist, w: B.w, n: B.n, step: r3(B.step) },
    scanStepM: STEP_M, positionsScanned: samples.length,
    bestAnywhere: { arcM: r2(best.t), worstSideErrorM: r3(best.worst) },
    bestWithinOneLot: { arcM: r2(bestNear.t), worstSideErrorM: r3(bestNear.worst) },
    generatorChoseM: cut.phaseErrorM, confirmedMinimal: confirmed,
    jointZeros: lcmHits, affectedParcelRecords: affected.length,
    furthestBeyondCoreM: Math.max(...affected.map((p) => p.beyondSeamM)) }, null, 1) + '\n');
