/**
 * Stage 1A.2 acceptance — threshold sensitivity, existing fixtures only.
 * No new geographic sample. No new external dataset.
 */
import { writeFileSync } from 'node:fs';
import { loadParts, loadStructures, assign, mixedGroundFilter, FROZEN_GATE } from './gate.mjs';
import { joinGroundTruth } from '../gis-stage1a1/join.mjs';
import { loadNorthEnd, loadAuditTruth } from './northend.mjs';
import { reconcile } from './reconcile.mjs';

const FT2 = 0.3048 * 0.3048;
/** Demote when the parts assigned to a structure account for too little of it. */
export function underFillFilter(assigned, parts, structs, minFill) {
  if (minFill <= 0) return assigned;
  const area = new Map(parts.map((p) => [p.id, p.derived.areaM2]));
  const sArea = new Map(structs.filter((s) => s.areaSqFt != null).map((s) => [s.structId, s.areaSqFt * FT2]));
  const sum = new Map();
  for (const a of assigned) if (a.state === 'ASSIGNED') sum.set(a.structId, (sum.get(a.structId) || 0) + (area.get(a.partId) || 0));
  return assigned.map((a) => {
    if (a.state !== 'ASSIGNED') return a;
    const sa = sArea.get(a.structId);
    if (!sa || sa <= 0) return a;
    return (sum.get(a.structId) / sa) < minFill
      ? { ...a, state: 'AMBIGUOUS_UNDERFILLED_PARENT', localId: null, structId: null }
      : a;
  });
}
function run(parts, structs, truth, { groundTol, minFill }) {
  let a = assign(parts, structs, FROZEN_GATE);
  a = mixedGroundFilter(a, parts, groundTol);
  a = underFillFilter(a, parts, structs, minFill);
  const r = reconcile(a, truth);
  return {
    coveragePct: +(100 * r.recordLevel.assigned / parts.length).toFixed(1),
    assigned: r.recordLevel.assigned,
    correct: r.recordLevel.CORRECT_PARENT,
    wrongIsolated: r.recordLevel.WRONG_PARENT_ISOLATED,
    wrongInMerge: r.recordLevel.WRONG_PARENT_IN_MERGE,
    wrongInSplit: r.recordLevel.WRONG_PARENT_IN_SPLIT,
    falseMerge: r.eventLevel.FALSE_MERGE, falseSplit: r.eventLevel.FALSE_SPLIT,
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const U = (p) => new URL(p, import.meta.url).pathname;
  const bbP = loadParts(U('../gis-stage1a/fixture.json'));
  const bbS = loadStructures(U('../gis-stage1a1/cache/massgis_structures_4326.json'));
  const gt = joinGroundTruth();
  const bbT = new Map(gt.filter((g) => g.buildingId).map((g) => [String(g.oid), g.buildingId]));
  const ne = loadNorthEnd(); const neT = loadAuditTruth(ne.parts);

  const out = { schemaVersion: 'boston-gis-stage1a2/sensitivity/0.1.0', groundToleranceSweep: [], underFillSweep: [] };
  console.log('=== GROUND-TOLERANCE SENSITIVITY (minFill 0) ===');
  console.log('tol ft |            BACK BAY  cov%  corr  wIso wMrg wSpl  FM FS |           NORTH END  cov%  corr  wIso wMrg wSpl  FM FS');
  for (const groundTol of [0, 0.01, 0.1, 0.5, 1.0]) {
    const b = run(bbP, bbS, bbT, { groundTol, minFill: 0 });
    const n = run(ne.parts, ne.structs, neT.truth, { groundTol, minFill: 0 });
    out.groundToleranceSweep.push({ groundToleranceFt: groundTol, backBay: b, northEnd: n });
    console.log(String(groundTol).padStart(6), '|',
      String(b.assigned).padStart(20), String(b.coveragePct).padStart(5), String(b.correct).padStart(5),
      String(b.wrongIsolated).padStart(5), String(b.wrongInMerge).padStart(4), String(b.wrongInSplit).padStart(4),
      String(b.falseMerge).padStart(3), String(b.falseSplit).padStart(2), '|',
      String(n.assigned).padStart(19), String(n.coveragePct).padStart(5), String(n.correct).padStart(5),
      String(n.wrongIsolated).padStart(5), String(n.wrongInMerge).padStart(4), String(n.wrongInSplit).padStart(4),
      String(n.falseMerge).padStart(3), String(n.falseSplit).padStart(2));
  }
  console.log('\n=== UNDER-FILL SENSITIVITY (groundTol 0.01) ===');
  console.log('minFill |            BACK BAY  cov%  corr  wIso  FM FS |           NORTH END  cov%  corr  wIso  FM FS');
  for (const minFill of [0, 0.10, 0.20, 0.30, 0.40, 0.50]) {
    const b = run(bbP, bbS, bbT, { groundTol: 0.01, minFill });
    const n = run(ne.parts, ne.structs, neT.truth, { groundTol: 0.01, minFill });
    out.underFillSweep.push({ minFill, backBay: b, northEnd: n });
    console.log(String(minFill.toFixed(2)).padStart(7), '|',
      String(b.assigned).padStart(20), String(b.coveragePct).padStart(5), String(b.correct).padStart(5),
      String(b.wrongIsolated).padStart(5), String(b.falseMerge).padStart(3), String(b.falseSplit).padStart(2), '|',
      String(n.assigned).padStart(19), String(n.coveragePct).padStart(5), String(n.correct).padStart(5),
      String(n.wrongIsolated).padStart(5), String(n.falseMerge).padStart(3), String(n.falseSplit).padStart(2));
  }
  writeFileSync(new URL('./sensitivity.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log('\n[emit] sensitivity.json written');
}
