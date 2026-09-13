import { GIS_BACKBAY_CANDIDATES, GIS_BACKBAY_SOURCE } from '../data/gis-backbay-candidate.js';
import { isReserved } from '../data/landmarks.js';
import {
  overlapGraph, frontageChain, isContiguousRun, centroid,
  unionArea, differenceArea,
} from './GisAssociate.js';

/**
 * Stage 1B.1 prototype — factual Back Bay building footprints, X/Z only.
 *
 * **DEFAULT OFF.** Without `?gisBackBay=1` nothing here runs and Boston is
 * bit-for-bit the city it was. A bounded experiment, not a migration.
 *
 * ## What changed from Stage 1B, and why
 *
 * Stage 1B swapped `plot.polygon` inside `_collectPlots`, associated one
 * candidate to one parcel by centroid membership, and *predicted* whether the
 * replacement would render. It produced 14 replacements, 12 buildings and **two
 * holes**. Both failures were structural rather than unlucky:
 *
 * 1. **It suppressed before it knew.** The `survives()` predicate replayed the
 *    corridor clip and `makeSpec`'s minimums but not `_respec`, `_districtOf` or
 *    `_fitOrnament`; two candidates died in the stages it did not replay, after
 *    their parcels were already gone. The fix is not a longer predicate — it is
 *    to run `Buildings._specFor` itself and suppress only what has already been
 *    replaced. See `materialise` below.
 * 2. **It asked the wrong geometric question.** Boston's lots are 8.3 m wide
 *    (median) and the real Back Bay rowhouses are the same size but laterally
 *    offset by a median 5.0 m, so a real building routinely holds half of one
 *    lot and a tenth of its neighbour. Centroid membership is a coin toss on
 *    geometry like that, which is why 77 of 110 candidates found no parcel at
 *    all. Ownership is now decided by **share and margin**: a parcel belongs to
 *    the candidate holding most of it, if it holds it decisively.
 *
 * ## What is deliberately still true
 *
 * Height, storeys, base Y, district, zoning and street orientation all come
 * from the donor parcel and `Facades.makeSpec`, exactly as for every other
 * Boston building. The vertical datum of the source's elevation fields is
 * unresolved, so the experiment isolates X/Z and consumes no GIS elevation.
 * Collision is **not** migrated: a replaced building's colliders still follow
 * the baseline parcel and can differ from the visible mass.
 *
 * No network access. No new material, mesh, renderer or dependency. No City
 * `Assessing/DOIT_buildings` data — that service is LEGAL-UNKNOWN and never
 * became a runtime dependency.
 */

/** Query-flag control. Absent flag ⇒ absent feature. */
export function isEnabled() {
  if (typeof location === 'undefined' || !location.search) return false;
  const v = new URLSearchParams(location.search).get('gisBackBay');
  return v === '1' || v === 'true';
}

/**
 * The frozen association gate.
 *
 * Chosen **after** measuring the Back Bay distributions, not before — see
 * `research/gis-stage1b1/measure.json` and `classify.json`, and §H/§I of the
 * Stage 1B.1 report. Each number answers one of the brief's safety conditions
 * and none of them is tuned to an address:
 *
 * - `minParcelShare` — a parcel joins a claim only if the factual building
 *   holds at least 30% of it. The measured `ofParcel` distribution has its 10th
 *   percentile at 0.039 and its median at 0.169: grazes are the common case and
 *   this is what excludes them. Condition 5.
 * - `minOwnerMargin` — the leader must beat the runner-up by 35% of its own
 *   share. Same shape and same constant as the Stage 1A.2 parent gate that was
 *   accepted with zero false merges; contention drops from 12 parcels to 5.
 *   Condition 4.
 * - `minFactualExplained` — the claimed run must hold at least a quarter of the
 *   real building, or the mapping is incidental rather than a replacement.
 *   Condition 3.
 * - `maxStreetBareM2` / `streetBandM` — after every factual building is placed,
 *   no accepted claim may leave more than 12 m² of bare ground within 4 m of
 *   its own street frontage. Measured collectively, so neighbours count as
 *   cover. This is the streetwall-hole condition, 6 and 10.
 * - `minRun` — accepted candidates must sit in a connected run of at least two.
 *   An isolated factual building between two procedural ones is the case that
 *   both leaves the most bare ground and shows the least, so it is not worth
 *   its risk.
 */
export const GATE = Object.freeze({
  version: 'stage1b1-assoc/1.0.0',
  minParcelShare: 0.30,
  minOwnerMargin: 0.35,
  minFactualExplained: 0.25,
  streetBandM: 4,
  maxStreetBareM2: 12,
  minRun: 2,
  // One candidate is dropped per round, so the cap must exceed the number of
  // proposals or the audit stops at a state that still fails its own gate —
  // which is what a cap of 8 did on the first run of this sweep.
  maxAuditRounds: 256,
});

const ringPts = (c) => c.ring.map(([x, z]) => ({ x, z }));

/**
 * Replace procedural Back Bay parcels with factual footprints, transactionally.
 *
 * @param {Array<object>} parcels post-`_superblocks` procedural visual units.
 *        Association happens here and not on raw lots because a fused run of
 *        lots is ONE building on screen, and suppression has to operate on the
 *        unit the player actually sees.
 * @param {(plot:object, i:number)=>{spec:?object}} specFor `Buildings._specFor`
 *        itself — the real emission path, not a description of it.
 * @param {object} [gate] frozen by default; parameterised only so the research
 *        harness can show what the alternatives would have done.
 * @returns {{specs: Array<object>, suppressed: Set, ledger: object}}
 */
export function apply(parcels, specFor, gate = GATE) {
  const W = GIS_BACKBAY_SOURCE.bboxWorld;
  const ledger = {
    enabled: true, source: GIS_BACKBAY_SOURCE.gate, gate: { ...gate },
    candidates: GIS_BACKBAY_CANDIDATES.length,
    replaced: [], fallback: [], suppressedPlotIds: [],
    suppressedVisuals: 0, contendedParcels: [], audit: null,
  };
  const fail = (id, reason, extra) => ledger.fallback.push({ id, reason, ...extra });

  // Only parcels inside the prototype box take part, so nothing outside Back
  // Bay can be disturbed even by a mistake in here.
  const index = new Map();
  const local = [];
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (!p?.polygon) continue;
    index.set(p.id, i);
    const c = centroid(p.polygon);
    if (c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1) local.push(p);
  }
  const byId = new Map(local.map((p) => [p.id, p]));
  const graph = overlapGraph(GIS_BACKBAY_CANDIDATES, local);
  const chain = frontageChain(parcels);

  /* -- ownership: one parcel, at most one owner, decided by share and margin -- */
  const byParcel = new Map();
  for (const g of graph) {
    for (const e of g.edges) {
      let a = byParcel.get(e.plotId);
      if (!a) byParcel.set(e.plotId, a = []);
      a.push({ cand: g.id, ofParcel: e.ofParcel });
    }
  }
  const owner = new Map(), lostToContention = new Set();
  for (const [pid, arr] of byParcel) {
    arr.sort((a, b) => b.ofParcel - a.ofParcel || (a.cand < b.cand ? -1 : 1));
    const s1 = arr[0].ofParcel, s2 = arr[1]?.ofParcel ?? 0;
    if (s1 < gate.minParcelShare) continue;
    if (s1 - s2 < gate.minOwnerMargin * s1) {
      ledger.contendedParcels.push({ plotId: pid, s1: r3(s1), s2: r3(s2), between: arr.slice(0, 2).map((v) => v.cand) });
      for (const v of arr) if (v.ofParcel >= gate.minParcelShare) lostToContention.add(v.cand);
      continue;
    }
    owner.set(pid, arr[0].cand);
  }
  const claims = new Map();
  for (const [pid, cid] of owner) {
    let a = claims.get(cid);
    if (!a) claims.set(cid, a = []);
    a.push(pid);
  }
  for (const a of claims.values()) a.sort((x, y) => x - y);

  /* -- per-candidate gates, in deterministic id order ----------------------- */
  const proposals = [];
  for (const cand of [...GIS_BACKBAY_CANDIDATES].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const g = graph.find((x) => x.id === cand.id);
    const ids = claims.get(cand.id);
    if (!ids || !ids.length) {
      if (!g || !g.edges.length) fail(cand.id, 'no-procedural-support', { overlapping: 0 });
      else if (lostToContention.has(cand.id)) fail(cand.id, 'contended', { overlapping: g.edges.length });
      else fail(cand.id, 'weak-overlap', { overlapping: g.edges.length, bestShare: r3(g.edges[0].ofParcel) });
      continue;
    }
    if (!isContiguousRun(ids, chain)) { fail(cand.id, 'disconnected-run', { claimed: ids.length }); continue; }
    const kept = g.edges.filter((e) => ids.includes(e.plotId));
    const explained = kept.reduce((s, e) => s + e.interArea, 0) / g.factualArea;
    if (explained < gate.minFactualExplained) { fail(cand.id, 'incidental-overlap', { claimed: ids.length, factualExplained: r3(explained) }); continue; }
    const ring = ringPts(cand);
    const cc = centroid(ring);
    // A reserved or hero centroid is dropped downstream, so replacing here
    // would suppress a parcel and render nothing — the Stage 1B hole, exactly.
    if (isReserved(cc.x, cc.z)) { fail(cand.id, 'hero-or-reserved', { claimed: ids.length }); continue; }
    const donor = kept.slice().sort((a, b) => b.interArea - a.interArea || a.plotId - b.plotId)[0];
    proposals.push({ cand, ids, ring, explained, donorId: donor.plotId, kept });
  }

  /* -- MATERIALISE FIRST. Nothing is suppressed above this line. ------------ */
  const live = [];
  for (const pr of proposals) {
    const donor = byId.get(pr.donorId);
    const plot = { ...donor, polygon: pr.ring, gisCandidateId: pr.cand.id, gisLocalId: pr.cand.localId };
    const { spec } = specFor(plot, index.get(donor.id));
    if (!spec) { fail(pr.cand.id, 'materialization-failed', { claimed: pr.ids.length }); continue; }
    spec.gisCandidateId = pr.cand.id;
    live.push({ ...pr, donor, spec });
  }

  /* -- collective audit: would suppressing these runs open the streetwall? --- */
  // Run to a fixed point. Dropping a candidate only removes factual cover, so
  // a drop can cascade; the loop is monotone and therefore terminates.
  const renderedOf = new Map();   // plotId -> the baseline spec it would have emitted
  for (const p of local) {
    const { spec } = specFor(p, index.get(p.id));
    if (spec) renderedOf.set(p.id, spec);
  }
  let round = 0, dropped = true;
  while (dropped && round++ < gate.maxAuditRounds) {
    dropped = false;
    const factual = live.map((l) => l.spec.poly);
    // (a) streetwall voids, measured against every factual building, not just
    //     the candidate's own — attached neighbours legitimately cover for each
    //     other, and Back Bay is nothing but attached neighbours.
    for (const l of live) {
      const sup = l.ids.map((id) => renderedOf.get(id)?.poly).filter(Boolean);
      if (!sup.length) { l.streetBare = 0; l.bare = 0; continue; }
      const lines = l.ids.map((id) => byId.get(id).frontage).filter(Boolean).map((f) => ({ a: f.a, b: f.b }));
      const d = differenceArea(sup, factual, { lines, within: gate.streetBandM });
      l.bare = d.area; l.streetBare = d.nearArea;
    }
    const over = live.filter((l) => l.streetBare > gate.maxStreetBareM2);
    if (over.length) {
      // Drop the worst offender only, then re-measure: dropping one can fix or
      // worsen its neighbours, and removing them all at once would reject a run
      // on evidence that the first removal had already changed.
      over.sort((a, b) => b.streetBare - a.streetBare || (a.cand.id < b.cand.id ? -1 : 1));
      const x = over[0];
      fail(x.cand.id, 'streetwall-void', { claimed: x.ids.length, streetBareM2: r1(x.streetBare) });
      live.splice(live.indexOf(x), 1);
      dropped = true; continue;
    }
    // (b) run length: an isolated factual building leaves the most bare ground
    //     and shows the least.
    if (gate.minRun > 1) {
      const comp = components(live, chain);
      const small = live.filter((l) => comp.get(l.cand.id) < gate.minRun);
      if (small.length) {
        small.sort((a, b) => (a.cand.id < b.cand.id ? -1 : 1));
        const x = small[0];
        fail(x.cand.id, 'run-too-short', { claimed: x.ids.length, runLength: comp.get(x.cand.id) });
        live.splice(live.indexOf(x), 1);
        dropped = true;
      }
    }
  }

  /* -- commit --------------------------------------------------------------- */
  const suppressed = new Set();
  const specs = [];
  for (const l of live) {
    for (const id of l.ids) suppressed.add(id);
    specs.push(l.spec);
  }
  for (const l of live) {
    ledger.replaced.push({
      id: l.cand.id, localId: l.cand.localId, donorPlotId: l.donor.id,
      suppressedPlotIds: l.ids.slice(),
      multiParcel: l.ids.length > 1, parcels: l.ids.length,
      factualExplained: r3(l.explained), areaM2: l.cand.areaM2,
      ringVertices: l.cand.ring.length, specVertices: l.spec.poly.length,
      bareM2: r1(l.bare ?? 0), streetBareM2: r1(l.streetBare ?? 0),
      cx: r1(l.spec.cx), cz: r1(l.spec.cz), heightM: r1(l.spec.h), storeys: l.spec.storeys,
    });
  }
  ledger.suppressedPlotIds = [...suppressed];
  ledger.suppressedVisuals = ledger.suppressedPlotIds.filter((id) => renderedOf.has(id)).length;
  const supPolys = ledger.suppressedPlotIds.map((id) => renderedOf.get(id)?.poly).filter(Boolean);
  const factPolys = specs.map((s) => s.poly);
  const lines = ledger.suppressedPlotIds.map((id) => byId.get(id)?.frontage).filter(Boolean).map((f) => ({ a: f.a, b: f.b }));
  const d = supPolys.length ? differenceArea(supPolys, factPolys, { lines, within: gate.streetBandM }) : { area: 0, nearArea: 0 };
  ledger.audit = {
    rounds: round,
    suppressedAreaM2: r1(unionArea(supPolys)),
    factualAreaM2: r1(unionArea(factPolys)),
    bareM2: r1(d.area), streetBareM2: r1(d.nearArea),
    longestRun: longestRun(live, chain),
    // Every candidate ends in exactly one bucket, and every suppressed parcel
    // belongs to exactly one replacement. Both are asserted, not assumed.
    reconciles: ledger.replaced.length + ledger.fallback.length === ledger.candidates &&
      ledger.replaced.reduce((s, r) => s + r.suppressedPlotIds.length, 0) === suppressed.size &&
      new Set(ledger.replaced.map((r) => r.id)).size === ledger.replaced.length,
  };
  return { specs, suppressed, ledger };
}

/** Connected components of accepted candidates under parcel adjacency. */
function components(live, chain) {
  const ownerOf = new Map();
  for (const l of live) for (const id of l.ids) ownerOf.set(id, l.cand.id);
  const adj = new Map(live.map((l) => [l.cand.id, new Set()]));
  for (const l of live) {
    for (const id of l.ids) {
      for (const nb of [chain.next.get(id), chain.prev.get(id)]) {
        const o = nb === undefined ? undefined : ownerOf.get(nb);
        if (o && o !== l.cand.id) { adj.get(l.cand.id).add(o); adj.get(o).add(l.cand.id); }
      }
    }
  }
  const size = new Map(), seen = new Set();
  for (const l of live) {
    if (seen.has(l.cand.id)) continue;
    const stack = [l.cand.id], comp = [];
    seen.add(l.cand.id);
    while (stack.length) {
      const c = stack.pop(); comp.push(c);
      for (const n of adj.get(c)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    for (const c of comp) size.set(c, comp.length);
  }
  return size;
}

function longestRun(live, chain) {
  const c = components(live, chain);
  return Math.max(0, ...c.values());
}

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
