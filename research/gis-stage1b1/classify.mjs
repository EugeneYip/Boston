/**
 * Stage 1B.1 — dominant-owner association, swept.
 *
 *   node research/gis-stage1b1/classify.mjs
 *
 * The Stage 1B rule asked "does this parcel's centroid fall in the footprint?"
 * and got 14 replacements. The distribution measured in `measure.mjs` says why
 * that is the wrong question: Boston's lots are 8.3 m wide and the factual
 * rowhouses are the same size but laterally offset, so a real building
 * routinely holds 50% of one lot and 12% of its neighbour. Centroid membership
 * is a coin toss on geometry like that.
 *
 * The question asked here instead is **"which candidate holds most of this
 * parcel, and does it hold it decisively?"** — a share-and-margin rule, the same
 * shape as the Stage 1A.2 parent gate that was already accepted at
 * `minMargin 0.35` with zero false merges. Ownership is single-valued by
 * construction, so contention cannot arise silently.
 *
 * Areas of unions are RASTERISED, not summed: Boston emits a parcel per road
 * frontage, so two streets meeting at a corner publish parcels that physically
 * overlap, and `bb-Bos_0501341000_B0` sums to 165% of its own footprint. A sum
 * would have quietly over-counted exactly the corner cases that matter most.
 */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { makeBuilder } from './pipeline.mjs';
import { GIS_BACKBAY_CANDIDATES, GIS_BACKBAY_SOURCE } from '../../src/data/gis-backbay-candidate.js';
import { overlapGraph, frontageChain, isContiguousRun, centroid, polyArea, bbox,
         unionArea, differenceArea, CELL } from '../../src/world/GisAssociate.js';

const W = GIS_BACKBAY_SOURCE.bboxWorld;
const inBox = (c) => c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1;
/** Ownership: each parcel goes to the candidate holding most of it, decisively. */
export function assignOwners(graph, minShare, minMargin) {
  const byParcel = new Map();
  for (const g of graph) for (const e of g.edges) {
    let a = byParcel.get(e.plotId); if (!a) byParcel.set(e.plotId, a = []);
    a.push({ cand: g.id, ofParcel: e.ofParcel, interArea: e.interArea, parcelArea: e.parcelArea });
  }
  const owner = new Map(), contested = [];
  for (const [pid, arr] of byParcel) {
    arr.sort((x, y) => y.ofParcel - x.ofParcel);
    const s1 = arr[0].ofParcel, s2 = arr[1]?.ofParcel ?? 0;
    if (s1 < minShare) continue;
    if (s1 - s2 < minMargin * s1) { contested.push({ plotId: pid, s1, s2, between: arr.slice(0, 2).map((v) => v.cand) }); continue; }
    owner.set(pid, arr[0].cand);
  }
  return { owner, contested };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
  const parcels = b._superblocks(b.plots);
  const local = parcels.filter((p) => inBox(centroid(p.polygon)));
  const graph = overlapGraph(GIS_BACKBAY_CANDIDATES, local);
  const chain = frontageChain(parcels);
  const byId = new Map(local.map((p) => [p.id, p]));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);

  const rows = [];
  for (const minShare of [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]) {
    for (const minMargin of [0.20, 0.35, 0.50]) {
      const { owner, contested } = assignOwners(graph, minShare, minMargin);
      const claims = new Map();
      for (const [pid, cid] of owner) { let a = claims.get(cid); if (!a) claims.set(cid, a = []); a.push(pid); }
      const per = [];
      for (const [cid, ids] of claims) {
        const g = graph.find((x) => x.id === cid);
        const kept = g.edges.filter((e) => ids.includes(e.plotId));
        const claimPolys = ids.map((id) => byId.get(id).polygon);
        const uA = unionArea(claimPolys);
        const ring = GIS_BACKBAY_CANDIDATES.find((c) => c.id === cid).ring.map(([x, z]) => ({ x, z }));
        const interSum = kept.reduce((s, e) => s + e.interArea, 0);
        per.push({ cid, n: ids.length, contiguous: isContiguousRun(ids, chain),
          factualExplained: interSum / g.factualArea,     // how much of the real building the run holds
          claimExplained: differenceArea(claimPolys, [ring]).area / uA }); // fraction of claimed ground left bare
      }
      rows.push({ minShare, minMargin, ownedParcels: owner.size, contestedParcels: contested.length,
        candidates: per.length, contiguous: per.filter((p) => p.contiguous).length,
        multi: per.filter((p) => p.n > 1).length, maxN: Math.max(0, ...per.map((p) => p.n)),
        factExplained: { p10: r3(q(per.map((p) => p.factualExplained), 0.1)), p50: r3(q(per.map((p) => p.factualExplained), 0.5)), p90: r3(q(per.map((p) => p.factualExplained), 0.9)) },
        bareClaim: { p10: r3(q(per.map((p) => p.claimExplained), 0.1)), p50: r3(q(per.map((p) => p.claimExplained), 0.5)), p90: r3(q(per.map((p) => p.claimExplained), 0.9)) } });
    }
  }
  const out = { schemaVersion: 'boston-gis-stage1b1/classify/0.2.0', cellM: CELL, sweep: rows };
  writeFileSync(new URL('./classify.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log('minShare margin | owned contested | cands contig multi maxN | factualExplained p10/p50/p90 | bareClaim p10/p50/p90');
  for (const r of rows) console.log(
    `   ${r.minShare.toFixed(2)}   ${r.minMargin.toFixed(2)} | ${String(r.ownedParcels).padStart(5)} ${String(r.contestedParcels).padStart(9)} | ` +
    `${String(r.candidates).padStart(5)} ${String(r.contiguous).padStart(6)} ${String(r.multi).padStart(5)} ${String(r.maxN).padStart(4)} | ` +
    `${r.factExplained.p10}/${r.factExplained.p50}/${r.factExplained.p90}`.padStart(28) +
    ` | ${r.bareClaim.p10}/${r.bareClaim.p50}/${r.bareClaim.p90}`);
}
