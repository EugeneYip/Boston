/**
 * Stage 1B.1 — run the transactional replacement through the REAL pipeline.
 *
 *   node research/gis-stage1b1/run.mjs           # frozen gate
 *   node research/gis-stage1b1/run.mjs --sweep   # what the alternatives do
 *
 * Every number this prints comes from `Buildings._buildSpecs` actually emitting
 * specs, not from a model of it.
 */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { makeBuilder } from './pipeline.mjs';
import { apply, GATE } from '../../src/world/GisBackBay.js';
import { GIS_BACKBAY_SOURCE } from '../../src/data/gis-backbay-candidate.js';
import { centroid } from '../../src/world/GisAssociate.js';

const W = GIS_BACKBAY_SOURCE.bboxWorld;
const inBox = (c) => c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1;
const seedOf = (p, i) => (p?.id ?? i) * 2654435761 % 1048573 | 0;

export function runGate(world, gate) {
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
  const parcels = b._superblocks(b.plots);
  const r = apply(parcels, (plot, i) => b._specFor(plot, seedOf(plot, i)), gate);
  // Now build the full candidate spec set exactly as `_buildSpecs` does.
  const specs = [];
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (r.suppressed.has(p?.id)) continue;
    const s = b._specFor(p, seedOf(p, i)).spec;
    if (s) specs.push(s);
  }
  for (const s of r.specs) specs.push(s);
  return { b, parcels, r, specs, box: specs.filter((s) => inBox({ x: s.cx, z: s.cz })) };
}

const MAIN = import.meta.url === `file://${process.argv[1]}`;
const world = MAIN ? buildCurrentWorld() : null;

if (MAIN && process.argv.includes('--sweep')) {
  console.log('share margin expl bare run | repl multi  matFail | supPlots supVis | boxSpecs | bareM2 streetBare | longRun');
  for (const minParcelShare of [0.15, 0.20, 0.25, 0.30, 0.35]) {
    for (const minOwnerMargin of [0.20, 0.35]) {
      for (const [minRun, maxStreetBareM2] of [[1, 1e9], [1, 12], [2, 12], [2, 19], [3, 12]]) {
        const g = { ...GATE, minParcelShare, minOwnerMargin, minRun, maxStreetBareM2 };
        const { r, box } = runGate(world, g);
        const reasons = {};
        for (const f of r.ledger.fallback) reasons[f.reason] = (reasons[f.reason] || 0) + 1;
        console.log(
          `${minParcelShare.toFixed(2)}  ${minOwnerMargin.toFixed(2)} ${GATE.minFactualExplained} ` +
          `${String(maxStreetBareM2 === 1e9 ? 'inf' : maxStreetBareM2).padStart(4)} ${minRun} | ` +
          `${String(r.ledger.replaced.length).padStart(4)} ${String(r.ledger.replaced.filter((x) => x.multiParcel).length).padStart(5)} ` +
          `${String(reasons['materialization-failed'] || 0).padStart(8)} | ` +
          `${String(r.ledger.suppressedPlotIds.length).padStart(8)} ${String(r.ledger.suppressedVisuals).padStart(6)} | ` +
          `${String(box.length).padStart(8)} | ${String(r.ledger.audit.bareM2).padStart(6)} ${String(r.ledger.audit.streetBareM2).padStart(10)} | ` +
          `${r.ledger.audit.longestRun}`);
      }
    }
  }
} else if (MAIN) {
  const base = runGate(world, { ...GATE, minParcelShare: 9 });   // gate nothing through
  const { r, specs, box } = runGate(world, GATE);
  const reasons = {};
  for (const f of r.ledger.fallback) reasons[f.reason] = (reasons[f.reason] || 0) + 1;
  const hist = {};
  for (const s of box) { const n = s.poly.length; hist[n] = (hist[n] || 0) + 1; }
  const out = {
    schemaVersion: 'boston-gis-stage1b1/run/0.1.0',
    gate: r.ledger.gate,
    baselineBoxSpecs: base.box.length, baselineCitySpecs: base.specs.length,
    candidateBoxSpecs: box.length, candidateCitySpecs: specs.length,
    boxVertexHistogram: hist, nonQuadInBox: box.filter((s) => s.poly.length !== 4).length,
    candidates: r.ledger.candidates,
    replaced: r.ledger.replaced.length,
    materialized: r.specs.length,
    singleParcel: r.ledger.replaced.filter((x) => !x.multiParcel).length,
    multiParcel: r.ledger.replaced.filter((x) => x.multiParcel).length,
    parcelsPerReplacement: r.ledger.replaced.map((x) => x.parcels).sort((a, b) => a - b),
    suppressedParcels: r.ledger.suppressedPlotIds.length,
    suppressedVisuals: r.ledger.suppressedVisuals,
    fallbackReasons: reasons,
    contendedParcels: r.ledger.contendedParcels.length,
    audit: r.ledger.audit,
    identity: {
      expected: base.box.length - r.ledger.suppressedVisuals + r.specs.length,
      observed: box.length,
      holds: base.box.length - r.ledger.suppressedVisuals + r.specs.length === box.length,
    },
  };
  writeFileSync(new URL('./run.json', import.meta.url), JSON.stringify({ ...out, ledger: r.ledger }, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
}
