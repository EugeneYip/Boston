/**
 * Stage 1A.2 — second-area transfer test, North End.
 *
 *   node research/gis-stage1a2/northend.mjs
 *
 * The gate is FROZEN (stage1a2-gate/1.0.0, derived on Back Bay and recorded
 * before this area was queried). Nothing here is retuned.
 */
import { readFileSync } from 'node:fs';
import { normalize } from '../gis-stage1a/normalize.mjs';
import { loadStructures, runFrozenGate, assign, score, FROZEN_GATE, centroid } from './gate.mjs';

const U = (p) => new URL(p, import.meta.url);
export function loadNorthEnd() {
  const raw = JSON.parse(readFileSync(U('./cache/ne_roofbreaks_4326.json'), 'utf8'));
  const { features, rejected } = normalize(raw);
  const structs = loadStructures(U('./cache/ne_massgis_4326.json').pathname);
  return { parts: features, rejected, structs };
}
/** AUDIT ONLY. City DOIT identity, never written to any committed artefact. */
export function loadAuditTruth(parts) {
  const dt = JSON.parse(readFileSync(U('./cache/ne_doit_4326.json'), 'utf8'));
  const v0 = (f) => { const r = f.geometry.rings[0][0]; return r[0].toFixed(7) + ',' + r[1].toFixed(7); };
  const byV0 = new Map();
  for (const f of dt.features) byV0.set(v0(f), f);
  const rb = JSON.parse(readFileSync(U('./cache/ne_roofbreaks_4326.json'), 'utf8'));
  const oidToKey = new Map(rb.features.map((f) => [String(f.attributes.OBJECTID), v0(f)]));
  const truth = new Map();
  let joined = 0;
  for (const p of parts) {
    const g = byV0.get(oidToKey.get(p.sourceId));
    if (!g) continue;
    joined++;
    const b = (g.attributes.BUILDING_ID ?? '').trim();
    if (b) truth.set(p.sourceId, b);
  }
  return { truth, joined };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { parts, rejected, structs } = loadNorthEnd();
  const { truth, joined } = loadAuditTruth(parts);
  console.log(`[north-end] parts normalized ${parts.length}, rejected ${rejected.length}`);
  console.log(`[north-end] MassGIS structures ${structs.length}, with usable LOCAL_ID ${structs.filter(s => s.localId).length}, blank ${structs.filter(s => !s.localId).length}`);
  console.log(`[north-end] audit join ${joined}/${parts.length}, with BUILDING_ID ${truth.size}`);
  const msIds = new Set(structs.map(s => s.localId).filter(Boolean));
  const cityIds = new Set([...truth.values()]);
  let inter = 0; for (const x of cityIds) if (msIds.has(x)) inter++;
  console.log(`[north-end] LOCAL_ID audit match: ${inter}/${cityIds.size} = ${(100 * inter / cityIds.size).toFixed(1)}% of City buildings present as a MassGIS LOCAL_ID`);
  console.log(`[north-end] MassGIS MISSING-PARENT rate: ${cityIds.size - inter}/${cityIds.size} = ${(100 * (cityIds.size - inter) / cityIds.size).toFixed(1)}%`);
  const pre = score(assign(parts, structs, FROZEN_GATE), truth);
  console.log('\n[north-end] BEFORE mixed-ground demotion:', JSON.stringify({ assigned: pre.assigned, cov: pre.coveragePct, groups: pre.buildingGroups, prec: pre.precisionPct, FM: pre.falseMerge, FS: pre.falseSplit }));
  const a = runFrozenGate(parts, structs);
  const s = score(a, truth);
  console.log('[north-end] FROZEN GATE:', JSON.stringify(s, null, 1));
}
