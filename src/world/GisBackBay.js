import { GIS_BACKBAY_CANDIDATES, GIS_BACKBAY_SOURCE } from '../data/gis-backbay-candidate.js';
import { isReserved } from '../data/landmarks.js';

/**
 * Stage 1B prototype — factual Back Bay building footprints, X/Z only.
 *
 * **DEFAULT OFF.** Without `?gisBackBay=1` nothing here runs: `apply()` returns
 * the caller's own array by identity, so baseline Boston is bit-for-bit the
 * city it was. This is a bounded experiment, not a migration.
 *
 * ## What it does
 *
 * `RoadNetwork.buildPlots` derives every Boston building from road frontage: a
 * parcel is a 4-vertex quad, frontage line extruded to a depth. That is why the
 * city has buildings at all, and it is not being replaced. This swaps ONE field
 * — `plot.polygon` — for a factual footprint, on a small subset of Back Bay
 * parcels, and leaves the rest of the pipeline untouched. Clipping, facade
 * grammar, district style, storey generation, chunking, LOD and colliders all
 * run exactly as before, on a different ring.
 *
 * Height is deliberately NOT touched. The vertical datum of the source's
 * elevation fields is unresolved (see the Stage 1A.2 acceptance note), so the
 * replacement plot inherits the donor parcel's `y`, `district`, `zoning` and
 * `maxHeight`, and `Facades.makeSpec` generates storeys procedurally exactly as
 * it does for every other building. The experiment isolates X/Z.
 *
 * ## Why association is conservative
 *
 * A factual candidate may only replace procedural parcels when it is obvious
 * which ones it replaces. Anything else stays procedural: a missing building is
 * a visible hole and a doubled building is a visible artefact, and both are
 * worse than an un-migrated block that already looks like Boston. Every
 * rejection is recorded with a reason in the ledger rather than being silent.
 *
 * No network access. No new material, mesh or renderer. No City
 * `Assessing/DOIT_buildings` data — that service is LEGAL-UNKNOWN and never
 * became a runtime dependency.
 *
 * ## KNOWN DEFECT — measured 2026-09-12, unfixed
 *
 * **Two of fourteen accepted replacements suppress their parcels and render
 * nothing.** Counted in the box: 361 baseline buildings − 23 suppressed + 12
 * rendered = 350, against 14 accepted. So two holes.
 *
 * `survives()` below re-runs the corridor clip and `makeSpec`'s footprint
 * minimums, which is not the whole of what `Buildings._buildSpecs` can reject —
 * `_respec`, `orientOutward` and `_fitOrnament` all run afterwards and none of
 * them is replayed here. Phase 5 of the Stage 1B brief requires that every
 * suppressed visual has a replacement; this does not yet guarantee it, and a
 * hole is the one outcome worse than not migrating.
 *
 * **Fix before any further stage:** emit the spec first and accept the
 * suppression only if a spec actually materialised, rather than predicting it.
 * That inverts the order and removes the class of bug rather than chasing it.
 */

/** Query-flag control. Absent flag ⇒ absent feature. */
export function isEnabled() {
  if (typeof location === 'undefined' || !location.search) return false;
  const v = new URLSearchParams(location.search).get('gisBackBay');
  return v === '1' || v === 'true';
}

const ringOf = (c) => c.ring;
function bounds(ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
function inRing(px, pz, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (((ring[i][1] > pz) !== (ring[j][1] > pz)) &&
        (px < (ring[j][0] - ring[i][0]) * (pz - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0])) c = !c;
  }
  return c;
}
function polyCentroid2(poly) {
  let A = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const cr = poly[i].x * poly[j].z - poly[j].x * poly[i].z;
    A += cr; cx += (poly[i].x + poly[j].x) * cr; cz += (poly[i].z + poly[j].z) * cr;
  }
  A *= 0.5;
  if (Math.abs(A) < 1e-9) {
    return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, z: poly.reduce((s, p) => s + p.z, 0) / poly.length };
  }
  return { x: cx / (6 * A), z: cz / (6 * A) };
}
const cornersIn = (poly, ring) => poly.reduce((n, p) => n + (inRing(p.x, p.z, ring) ? 1 : 0), 0);

/**
 * Swap the footprint of a safe Back Bay subset. Returns the array to build from
 * plus a ledger that must reconcile: every suppressed parcel has a replacement,
 * every replacement suppressed at least one parcel.
 *
 * @param {Array} plots parcels as published by `RoadNetwork.buildPlots`
 * @param {(poly:Array)=>boolean} [survives] optional predicate that answers
 *        "would `Buildings` actually emit a building for this ring?". Supplied
 *        by the caller so the adapter tests the REAL pipeline rather than a
 *        guess at it. Without it a candidate can be accepted, suppress its
 *        parcels, and then be rejected downstream by clipping or `makeSpec` —
 *        which is a hole, and holes are the one outcome worse than not
 *        migrating at all.
 * @returns {{plots: Array, ledger: object}}
 */
export function apply(plots, survives) {
  const ledger = {
    enabled: true, source: GIS_BACKBAY_SOURCE.gate,
    candidates: GIS_BACKBAY_CANDIDATES.length,
    replaced: [], fallback: [], suppressedPlotIds: [],
  };
  const W = GIS_BACKBAY_SOURCE.bboxWorld;
  // Only parcels inside the prototype box can take part, so nothing outside
  // Back Bay can be disturbed even by a mistake here.
  const local = [];
  for (const p of plots) {
    const c = polyCentroid2(p.polygon);
    if (c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1) local.push({ p, c });
  }
  // Pass 1 — claims. A parcel is claimed when its centroid is inside a
  // candidate, or when most of its corners are.
  const claims = new Map();                 // candidate id -> [{p,c}]
  const claimedBy = new Map();              // plot id -> [candidate id]
  for (const cand of GIS_BACKBAY_CANDIDATES) {
    const ring = ringOf(cand), b = bounds(ring), hit = [];
    for (const e of local) {
      if (e.c.x < b.x0 - 2 || e.c.x > b.x1 + 2 || e.c.z < b.z0 - 2 || e.c.z > b.z1 + 2) continue;
      // Asymmetric on purpose. A symmetric test — also claiming a parcel when
      // the footprint's centroid falls inside it — was tried and MEASURED
      // WORSE: 12 replacements against 14, because it put 22 parcels in
      // contention between neighbouring candidates, which the gate below then
      // correctly rejects. Claiming more is not the goal; claiming
      // unambiguously is.
      if (inRing(e.c.x, e.c.z, ring) || cornersIn(e.p.polygon, ring) >= 3) {
        hit.push(e);
        if (!claimedBy.has(e.p.id)) claimedBy.set(e.p.id, []);
        claimedBy.get(e.p.id).push(cand.id);
      }
    }
    claims.set(cand.id, hit);
  }
  // Pass 2 — gates. Conservative: any doubt is procedural.
  const accepted = new Map();
  for (const cand of GIS_BACKBAY_CANDIDATES) {
    const hit = claims.get(cand.id);
    const ring = ringOf(cand);
    const fail = (reason) => { ledger.fallback.push({ id: cand.id, reason, claimed: hit.length }); };
    if (!hit.length) { fail('no-procedural-parcel-claimed'); continue; }
    if (hit.some((e) => (claimedBy.get(e.p.id) || []).length > 1)) { fail('parcel-claimed-by-multiple-candidates'); continue; }
    // A reserved centroid is dropped downstream by `Buildings`, so replacing
    // here would suppress a parcel and render nothing — a hole.
    const cc = { x: ring.reduce((s, p) => s + p[0], 0) / ring.length, z: ring.reduce((s, p) => s + p[1], 0) / ring.length };
    if (isReserved(cc.x, cc.z)) { fail('candidate-centroid-reserved'); continue; }
    // Would suppressing these parcels leave ground the candidate does not cover?
    const uncovered = hit.filter((e) => cornersIn(e.p.polygon, ring) === 0);
    if (uncovered.length) { fail('suppressed-parcel-not-covered-by-candidate'); continue; }
    // Would the real pipeline emit anything for this ring?
    if (survives && !survives(ring.map(([x, z]) => ({ x, z })))) {
      fail('candidate-would-not-survive-building-pipeline'); continue;
    }
    accepted.set(cand.id, hit);
  }
  // Pass 3 — a surviving parcel must not sit inside an accepted candidate, or
  // the scene would carry both.
  const suppressed = new Set();
  for (const [, hit] of accepted) for (const e of hit) suppressed.add(e.p.id);
  for (const [id, hit] of [...accepted]) {
    const ring = ringOf(GIS_BACKBAY_CANDIDATES.find((c) => c.id === id));
    const intruder = local.some((e) => !suppressed.has(e.p.id) && cornersIn(e.p.polygon, ring) >= 2);
    if (intruder) {
      accepted.delete(id);
      for (const e of hit) if (![...accepted.values()].flat().some((o) => o.p.id === e.p.id)) suppressed.delete(e.p.id);
      ledger.fallback.push({ id, reason: 'unsuppressed-parcel-overlaps-candidate', claimed: hit.length });
    }
  }
  if (!accepted.size) { ledger.suppressedPlotIds = []; return { plots, ledger }; }
  // Emit. Donor = the claimed parcel with the largest footprint; it carries
  // every non-geometry attribute so district, zoning, height ceiling, ground
  // height and street orientation are unchanged from baseline.
  const out = plots.filter((p) => !suppressed.has(p.id));
  for (const [id, hit] of accepted) {
    const cand = GIS_BACKBAY_CANDIDATES.find((c) => c.id === id);
    const donor = hit.slice().sort((a, b) => areaOf(b.p.polygon) - areaOf(a.p.polygon))[0].p;
    out.push({
      ...donor,
      polygon: cand.ring.map(([x, z]) => ({ x, z })),
      gisCandidateId: cand.id,
      gisLocalId: cand.localId,
    });
    ledger.replaced.push({
      id: cand.id, localId: cand.localId, donorPlotId: donor.id,
      suppressedPlotIds: hit.map((e) => e.p.id), areaM2: cand.areaM2, ringVertices: cand.ring.length,
    });
  }
  ledger.suppressedPlotIds = [...suppressed];
  return { plots: out, ledger };
}
function areaOf(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; s += poly[i].x * poly[j].z - poly[j].x * poly[i].z; }
  return Math.abs(s) / 2;
}
