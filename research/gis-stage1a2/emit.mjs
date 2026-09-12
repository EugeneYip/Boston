/** Stage 1A.2 — emit deterministic results for both areas. */
import { writeFileSync } from 'node:fs';
import { loadParts, loadStructures, runFrozenGate, runGateV11, assign, score, FROZEN_GATE, GATE_V11 } from './gate.mjs';
import { reconcile } from './reconcile.mjs';
import { joinGroundTruth } from '../gis-stage1a1/join.mjs';
import { loadNorthEnd, loadAuditTruth } from './northend.mjs';
import { BBOX_WGS84 as NE_BBOX, BBOX_WORLD as NE_WORLD } from './bbox-northend.mjs';

const bbParts = loadParts(new URL('../gis-stage1a/fixture.json', import.meta.url).pathname);
const bbStructs = loadStructures(new URL('../gis-stage1a1/cache/massgis_structures_4326.json', import.meta.url).pathname);
const gt = joinGroundTruth();
const bbTruth = new Map(gt.filter(g => g.buildingId).map(g => [String(g.oid), g.buildingId]));
const bbA = runFrozenGate(bbParts, bbStructs);
const ne = loadNorthEnd();
const neT = loadAuditTruth(ne.parts);
const neA = runFrozenGate(ne.parts, ne.structs);

const curve = [];
for (const minCoverage of [0.00, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80]) {
  for (const minMargin of [0.00, 0.35]) {
    const s = score(assign(bbParts, bbStructs, { minCoverage, minMargin, requireCentroidInside: false }), bbTruth);
    curve.push({ minCoverage, minMargin, mixedGroundDemotion: false, assigned: s.assigned, coveragePct: s.coveragePct,
                 groups: s.buildingGroups, auditable: s.auditable, auditUnknown: s.auditUnknown,
                 confirmedCorrect: s.confirmedCorrect, confirmedWrong: s.confirmedWrong,
                 precisionPct: s.precisionPct, falseMerge: s.falseMerge, falseSplit: s.falseSplit });
  }
}
const bbS = score(bbA, bbTruth), neS = score(neA, neT.truth);
curve.push({ ...FROZEN_GATE, mixedGroundDemotion: true, assigned: bbS.assigned, coveragePct: bbS.coveragePct,
             groups: bbS.buildingGroups, auditable: bbS.auditable, auditUnknown: bbS.auditUnknown,
             confirmedCorrect: bbS.confirmedCorrect, confirmedWrong: bbS.confirmedWrong,
             precisionPct: bbS.precisionPct, falseMerge: bbS.falseMerge, falseSplit: bbS.falseSplit, SELECTED: true });

const msIds = new Set(ne.structs.map(s => s.localId).filter(Boolean));
const neCity = new Set([...neT.truth.values()]);
let inter = 0; for (const x of neCity) if (msIds.has(x)) inter++;

const bbV11 = reconcile(runGateV11(bbParts, bbStructs), bbTruth);
const neV11 = reconcile(runGateV11(ne.parts, ne.structs), neT.truth);
const out = {
  schemaVersion: 'boston-gis-stage1a2/results/0.2.0',
  frozenGate: FROZEN_GATE,
  gateV11: GATE_V11,
  reconciledV11: { backBay: bbV11, northEnd: neV11 },
  fallbackStates: ['FACTUAL_PARENT_CONFIRMED', 'FACTUAL_PARENT_AMBIGUOUS', 'FACTUAL_PARENT_MISSING', 'PROCEDURAL_FALLBACK_REQUIRED'],
  backBay: { area: 'Back Bay 400 m box (Stage 1A bbox)', ...bbS },
  northEnd: { area: 'North End 400 m box', bboxWgs84: NE_BBOX, bboxWorld: NE_WORLD,
              partsNormalized: ne.parts.length, partsRejected: ne.rejected.length,
              massgisStructures: ne.structs.length,
              massgisWithLocalId: ne.structs.filter(s => s.localId).length,
              massgisBlankLocalId: ne.structs.filter(s => !s.localId).length,
              auditJoined: neT.joined, auditBuildings: neCity.size,
              localIdAuditMatch: inter, missingParentRate: +(100 * (neCity.size - inter) / neCity.size).toFixed(1),
              ...neS },
  backBayPrecisionCoverageCurve: curve,
};
const j = JSON.stringify(out, null, 1) + '\n';
writeFileSync(new URL('./results.json', import.meta.url), j);
console.log('[emit] wrote results.json', (j.length / 1024).toFixed(1), 'KiB');
