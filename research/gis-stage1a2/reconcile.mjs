/**
 * Stage 1A.2 acceptance — exact, mutually-exclusive audit accounting.
 *
 *   node research/gis-stage1a2/reconcile.mjs
 *
 * Stage 1A.2 reported record-level accuracy (correct/wrong) alongside
 * event-level counts (false merges/splits) without reconciling them. A record
 * and an event are different units, so the totals never had to agree — and the
 * report did not say so. This file produces both, keeps them separate, and
 * makes each set sum exactly.
 *
 * RECORD-LEVEL (one row per ASSIGNED part that has audit ground truth):
 *   CORRECT_PARENT          assigned LOCAL_ID === City BUILDING_ID
 *   WRONG_PARENT_IN_SPLIT   wrong, and this part's City building is spread
 *                           across >1 assigned group (a split event)
 *   WRONG_PARENT_IN_MERGE   wrong, and this part's assigned group contains
 *                           parts of >1 City building (a merge event)
 *   WRONG_PARENT_ISOLATED   wrong, and neither of the above — a genuine
 *                           one-to-one misassignment
 * A record is placed in exactly ONE bucket; merge is tested before split so the
 * more dangerous event wins the label.
 *
 * EVENT-LEVEL (counted over groups / buildings, NOT over records):
 *   FALSE_MERGE  an assigned LOCAL_ID group whose parts span >1 City building
 *   FALSE_SPLIT  a City building whose parts span >1 assigned LOCAL_ID group
 */
import { writeFileSync } from 'node:fs';
import { loadParts, loadStructures, runFrozenGate } from './gate.mjs';
import { joinGroundTruth } from '../gis-stage1a1/join.mjs';
import { loadNorthEnd, loadAuditTruth } from './northend.mjs';

export function reconcile(assigned, truth) {
  const A = assigned.filter((a) => a.state === 'ASSIGNED');
  const auditable = A.filter((a) => truth.get(a.sourceId));
  const auditUnknown = A.length - auditable.length;

  const groupTruths = new Map();          // localId -> Set(City BUILDING_ID)
  const truthGroups = new Map();          // City BUILDING_ID -> Set(localId)
  for (const a of auditable) {
    const t = truth.get(a.sourceId);
    if (!groupTruths.has(a.localId)) groupTruths.set(a.localId, new Set());
    groupTruths.get(a.localId).add(t);
    if (!truthGroups.has(t)) truthGroups.set(t, new Set());
    truthGroups.get(t).add(a.localId);
  }
  const mergedGroups = [...groupTruths].filter(([, s]) => s.size > 1).map(([g]) => g);
  const splitBuildings = [...truthGroups].filter(([, s]) => s.size > 1).map(([t]) => t);
  const mergeSet = new Set(mergedGroups), splitSet = new Set(splitBuildings);

  const records = { CORRECT_PARENT: [], WRONG_PARENT_IN_MERGE: [], WRONG_PARENT_IN_SPLIT: [], WRONG_PARENT_ISOLATED: [] };
  for (const a of auditable) {
    const t = truth.get(a.sourceId);
    if (a.localId === t) { records.CORRECT_PARENT.push(a.partId); continue; }
    if (mergeSet.has(a.localId)) records.WRONG_PARENT_IN_MERGE.push({ part: a.partId, assigned: a.localId, truth: t });
    else if (splitSet.has(t)) records.WRONG_PARENT_IN_SPLIT.push({ part: a.partId, assigned: a.localId, truth: t });
    else records.WRONG_PARENT_ISOLATED.push({ part: a.partId, assigned: a.localId, truth: t, coverage: a.coverage, margin: a.margin });
  }
  const wrongTotal = records.WRONG_PARENT_IN_MERGE.length + records.WRONG_PARENT_IN_SPLIT.length + records.WRONG_PARENT_ISOLATED.length;
  return {
    recordLevel: {
      assigned: A.length, auditUnknown, auditable: auditable.length,
      CORRECT_PARENT: records.CORRECT_PARENT.length,
      WRONG_PARENT_IN_MERGE: records.WRONG_PARENT_IN_MERGE.length,
      WRONG_PARENT_IN_SPLIT: records.WRONG_PARENT_IN_SPLIT.length,
      WRONG_PARENT_ISOLATED: records.WRONG_PARENT_ISOLATED.length,
      wrongTotal,
      reconciles: records.CORRECT_PARENT.length + wrongTotal === auditable.length,
      precisionPct: +(100 * records.CORRECT_PARENT.length / auditable.length).toFixed(2),
    },
    eventLevel: {
      assignedGroups: groupTruths.size, auditedBuildings: truthGroups.size,
      FALSE_MERGE: mergedGroups.length, FALSE_SPLIT: splitBuildings.length,
      cleanGroups: groupTruths.size - mergedGroups.length,
      cleanBuildings: truthGroups.size - splitBuildings.length,
    },
    detail: {
      wrongInMerge: records.WRONG_PARENT_IN_MERGE,
      wrongInSplit: records.WRONG_PARENT_IN_SPLIT.slice(0, 20),
      wrongIsolated: records.WRONG_PARENT_ISOLATED,
      splitBuildings: splitBuildings.map((t) => ({ building: t, groups: [...truthGroups.get(t)] })),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const U = (p) => new URL(p, import.meta.url).pathname;
  const bbParts = loadParts(U('../gis-stage1a/fixture.json'));
  const bbStructs = loadStructures(U('../gis-stage1a1/cache/massgis_structures_4326.json'));
  const gt = joinGroundTruth();
  const bbTruth = new Map(gt.filter((g) => g.buildingId).map((g) => [String(g.oid), g.buildingId]));
  const bb = reconcile(runFrozenGate(bbParts, bbStructs), bbTruth);

  const ne = loadNorthEnd();
  const neT = loadAuditTruth(ne.parts);
  const neR = reconcile(runFrozenGate(ne.parts, ne.structs), neT.truth);

  const out = { schemaVersion: 'boston-gis-stage1a2/reconciliation/0.1.0', backBay: bb, northEnd: neR };
  writeFileSync(new URL('./reconciliation.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  for (const [name, r] of [['BACK BAY', bb], ['NORTH END', neR]]) {
    console.log(`=== ${name} — RECORD LEVEL ===`);
    console.log(JSON.stringify(r.recordLevel, null, 1));
    console.log(`=== ${name} — EVENT LEVEL ===`);
    console.log(JSON.stringify(r.eventLevel, null, 1));
    if (r.detail.wrongIsolated.length) {
      console.log(`--- ${name} WRONG_PARENT_ISOLATED (the load-bearing ones) ---`);
      for (const w of r.detail.wrongIsolated) console.log('   ', JSON.stringify(w));
    }
    console.log();
  }
}
