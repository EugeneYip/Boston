/** Stage 1B — headless association dry-run. Real parcels, no renderer. */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { apply } from '../../src/world/GisBackBay.js';
import { GIS_BACKBAY_SOURCE, GIS_BACKBAY_CANDIDATES } from '../../src/data/gis-backbay-candidate.js';

const { net, plots } = buildCurrentWorld();
const W = GIS_BACKBAY_SOURCE.bboxWorld;
const cen = (poly) => {
  let A = 0, x = 0, z = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; const c = poly[i].x * poly[j].z - poly[j].x * poly[i].z; A += c; x += (poly[i].x + poly[j].x) * c; z += (poly[i].z + poly[j].z) * c; }
  A *= 0.5;
  return Math.abs(A) < 1e-9 ? { x: poly[0].x, z: poly[0].z } : { x: x / (6 * A), z: z / (6 * A) };
};
const inBox = (p) => { const c = cen(p.polygon); return c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1; };
const baselineLocal = plots.filter(inBox);

const { plots: out, ledger } = apply(plots);
const candLocal = out.filter(inBox);

const reasons = {};
for (const f of ledger.fallback) reasons[f.reason] = (reasons[f.reason] || 0) + 1;
const report = {
  baseline: { totalPlots: plots.length, inBoxPlots: baselineLocal.length },
  candidate: { totalPlots: out.length, inBoxPlots: candLocal.length },
  ledger: {
    candidates: ledger.candidates,
    replaced: ledger.replaced.length,
    fallback: ledger.fallback.length,
    fallbackReasons: reasons,
    suppressedPlots: ledger.suppressedPlotIds.length,
  },
  reconciliation: {
    candidatesAccountedFor: ledger.replaced.length + ledger.fallback.length === ledger.candidates,
    everySuppressedHasReplacement: ledger.replaced.reduce((s, r) => s + r.suppressedPlotIds.length, 0) === ledger.suppressedPlotIds.length,
    plotDelta: out.length - plots.length,
    expectedPlotDelta: ledger.replaced.length - ledger.suppressedPlotIds.length,
    noDuplicateSuppression: new Set(ledger.replaced.flatMap(r => r.suppressedPlotIds)).size === ledger.suppressedPlotIds.length,
  },
  geometry: {
    ringVertices: { min: Math.min(...ledger.replaced.map(r => r.ringVertices)), max: Math.max(...ledger.replaced.map(r => r.ringVertices)),
                    median: ledger.replaced.map(r => r.ringVertices).sort((a, b) => a - b)[Math.floor(ledger.replaced.length / 2)] },
    quads: ledger.replaced.filter(r => r.ringVertices === 4).length,
    areaM2: { min: Math.min(...ledger.replaced.map(r => r.areaM2)), max: Math.max(...ledger.replaced.map(r => r.areaM2)) },
  },
  suppressedPerReplacement: ledger.replaced.reduce((m, r) => (m[r.suppressedPlotIds.length] = (m[r.suppressedPlotIds.length] || 0) + 1, m), {}),
};
writeFileSync(new URL('./dryrun-ledger.json', import.meta.url), JSON.stringify({ ...report, replaced: ledger.replaced, fallback: ledger.fallback }, null, 1) + '\n');
console.log(JSON.stringify(report, null, 1));
