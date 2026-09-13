/**
 * Stage 1B.1 — measure the Back Bay factual↔procedural overlap distribution.
 *
 *   node research/gis-stage1b1/measure.mjs
 *
 * Deliberately gate-free. This answers "what does the geometry actually look
 * like?" so that the acceptance gate can be chosen from measured structure
 * rather than from a number someone liked. Nothing here accepts or rejects a
 * candidate.
 */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { makeBuilder } from './pipeline.mjs';
import { GIS_BACKBAY_CANDIDATES, GIS_BACKBAY_SOURCE } from '../../src/data/gis-backbay-candidate.js';
import { overlapGraph, frontageChain, isContiguousRun, centroid, polyArea } from '../../src/world/GisAssociate.js';

const W = GIS_BACKBAY_SOURCE.bboxWorld;
const inBox = (c) => c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1;

const world = buildCurrentWorld();
const { b, ctx } = makeBuilder(world);
b._collectPlots(ctx);
b._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
const parcels = b._superblocks(b.plots);
const seedOf = (p, i) => (p?.id ?? i) * 2654435761 % 1048573 | 0;

// Which procedural visual units exist in the box, and which of them actually
// render? Only a parcel that renders can leave a hole when suppressed.
const localIdx = [];
for (let i = 0; i < parcels.length; i++) if (inBox(centroid(parcels[i].polygon))) localIdx.push(i);
const local = localIdx.map((i) => parcels[i]);
const emits = new Map();
for (const i of localIdx) emits.set(parcels[i].id, !!b._specFor(parcels[i], seedOf(parcels[i], i)).spec);
const idsUnique = new Set(parcels.map((p) => p.id)).size === parcels.length;

const graph = overlapGraph(GIS_BACKBAY_CANDIDATES, local);
const chain = frontageChain(parcels);

// ---- distributions, raw -----------------------------------------------------
const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

const perCand = graph.map((g) => {
  const ids = g.edges.map((e) => e.plotId);
  return {
    id: g.id,
    factualArea: Math.round(g.factualArea * 10) / 10,
    overlapping: g.edges.length,
    ofFactualTotal: g.edges.reduce((s, e) => s + e.ofFactual, 0),
    topOfParcel: g.edges.map((e) => e.ofParcel),
    contiguousAll: isContiguousRun(ids, chain),
  };
});

// The decisive shape: for a sweep of "a parcel counts as claimed when the
// factual footprint covers >= t of it", how do coverage and claim size move?
const sweep = [];
for (const t of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.60, 0.70]) {
  let claimedCands = 0, contiguous = 0, sumClaimed = 0, maxClaimed = 0;
  let cov = [], outside = [];
  const owners = new Map();
  for (const g of graph) {
    const kept = g.edges.filter((e) => e.ofParcel >= t);
    if (!kept.length) continue;
    claimedCands++;
    sumClaimed += kept.length;
    if (kept.length > maxClaimed) maxClaimed = kept.length;
    if (isContiguousRun(kept.map((e) => e.plotId), chain)) contiguous++;
    cov.push(kept.reduce((s, e) => s + e.ofFactual, 0));
    const un = kept.reduce((s, e) => s + e.parcelArea, 0);
    const ia = kept.reduce((s, e) => s + e.interArea, 0);
    outside.push((un - ia) / un);
    for (const e of kept) owners.set(e.plotId, (owners.get(e.plotId) || 0) + 1);
  }
  const contended = [...owners.values()].filter((v) => v > 1).length;
  sweep.push({ t, claimedCands, contiguous, contended,
    meanClaimed: r2(sumClaimed / Math.max(1, claimedCands)), maxClaimed,
    factualCoveredMedian: r2(q(cov, 0.5)), factualCoveredP10: r2(q(cov, 0.1)),
    parcelMassOutsideMedian: r2(q(outside, 0.5)), parcelMassOutsideP90: r2(q(outside, 0.9)) });
}

// Is `ofParcel` actually bimodal — a real gap between "held" and "grazed"?
const allOfParcel = graph.flatMap((g) => g.edges.map((e) => e.ofParcel));
const hist = {};
for (const v of allOfParcel) { const k = Math.min(19, Math.floor(v * 20)); hist[`${(k * 5)}-${k * 5 + 5}%`] = (hist[`${(k * 5)}-${k * 5 + 5}%`] || 0) + 1; }

const out = {
  schemaVersion: 'boston-gis-stage1b1/measure/0.1.0',
  gate: GIS_BACKBAY_SOURCE.gate,
  world: { parcelsCity: b.plots.length, parcelsAfterSuperblocks: parcels.length,
           superblocksMade: b._clipStats.superblocks, plotIdsUniqueAfterFuse: idsUnique },
  box: { proceduralUnits: local.length, ofWhichRender: [...emits.values()].filter(Boolean).length },
  candidates: { total: GIS_BACKBAY_CANDIDATES.length,
                withAnyOverlap: graph.filter((g) => g.edges.length).length,
                withNoOverlap: graph.filter((g) => !g.edges.length).length },
  overlapCountPerCandidate: perCand.reduce((m, c) => (m[c.overlapping] = (m[c.overlapping] || 0) + 1, m), {}),
  ofParcelHistogram: hist,
  ofParcelQuantiles: { p10: r2(q(allOfParcel, 0.1)), p25: r2(q(allOfParcel, 0.25)), p50: r2(q(allOfParcel, 0.5)),
                       p75: r2(q(allOfParcel, 0.75)), p90: r2(q(allOfParcel, 0.9)) },
  factualAreaQuantiles: { min: r2(q(graph.map((g) => g.factualArea), 0)), p50: r2(q(graph.map((g) => g.factualArea), 0.5)),
                          max: r2(q(graph.map((g) => g.factualArea), 1)) },
  parcelAreaQuantiles: { min: r2(q(local.map((p) => polyArea(p.polygon)), 0)), p50: r2(q(local.map((p) => polyArea(p.polygon)), 0.5)),
                         max: r2(q(local.map((p) => polyArea(p.polygon)), 1)) },
  sweep,
};
writeFileSync(new URL('./measure.json', import.meta.url), JSON.stringify({ ...out, perCandidate: perCand, graph }, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
