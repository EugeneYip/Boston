/**
 * Stage 1A.2 — coverage-safe parent assignment.
 *
 * Parameterised so the precision/coverage trade-off can be swept rather than
 * asserted. The gate uses ONLY PDDL part geometry and MassGIS parent geometry.
 * City DOIT data is never an input: it is transient audit ground truth while its
 * licence is unresolved.
 *
 * PRINCIPLE: an ungrouped part is preferable to a wrongly merged one. Where the
 * evidence does not support a parent confidently the part is emitted as
 * AMBIGUOUS or NO_PARENT and handed to the procedural fallback, not attached to
 * whichever neighbour happens to score highest.
 */
import { readFileSync } from 'node:fs';
import { geo } from '../../src/core/Geo.js';

const r2 = (v) => +v.toFixed(2);
export function loadParts(fixturePath) {
  return JSON.parse(readFileSync(fixturePath, 'utf8')).features;
}
export function loadStructures(rawPath) {
  const ms = JSON.parse(readFileSync(rawPath, 'utf8'));
  return ms.features.map((f) => ({
    structId: f.attributes.STRUCT_ID,
    // MassGIS carries whitespace-only LOCAL_ID on some features — 34 structures
    // in the Back Bay box share a single " ". Untrimmed, that is truthy and
    // collapses them into one bogus building. Treat blank as absent.
    localId: (f.attributes.LOCAL_ID ?? '').trim() || null,
    areaSqFt: f.attributes.AREA_SQ_FT ?? null,
    source: f.attributes.SOURCE ?? null,
    rings: f.geometry.rings.map((ring) => {
      const pts = (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ? ring.slice(0, -1) : ring;
      return pts.map(([lon, lat]) => { const p = geo(lat, lon); return [r2(p.x), r2(p.z)]; });
    }),
  }));
}
function inRing(px, pz, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i][1] > pz) !== (r[j][1] > pz)) &&
        (px < (r[j][0] - r[i][0]) * (pz - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
  return c;
}
const inPoly = (px, pz, rings) => inRing(px, pz, rings[0]) && !rings.slice(1).some((h) => inRing(px, pz, h));
export function centroid(r) {
  let A = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length, c = r[i][0] * r[j][1] - r[j][0] * r[i][1]; A += c; x += (r[i][0] + r[j][0]) * c; y += (r[i][1] + r[j][1]) * c; }
  A *= 0.5;
  if (Math.abs(A) < 1e-9) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [x / (6 * A), y / (6 * A)];
}
const coverage = (ring, rings) => ring.reduce((n, [x, z]) => n + (inPoly(x, z, rings) ? 1 : 0), 0) / ring.length;

/**
 * @param {{minCoverage:number, minMargin:number, requireCentroidInside:boolean}} gate
 */
export function assign(parts, structs, gate) {
  const out = [];
  for (const f of parts) {
    const ring = f.derived.rings[0];
    const c = centroid(ring);
    const scored = structs.map((s) => {
      const cov = coverage(ring, s.rings);
      const cIn = inPoly(c[0], c[1], s.rings);
      return { s, cov, cIn, score: cov + (cIn ? 0.5 : 0) };
    }).filter((x) => x.score > 0).sort((a, b) => (b.score - a.score) || a.s.structId.localeCompare(b.s.structId));
    const top = scored[0] ?? null, second = scored[1] ?? null;
    const margin = top ? top.score - (second?.score ?? 0) : 0;
    let state, localId = null, structId = null;
    if (!top) {
      state = 'NO_PARENT';
    } else if (top.cov < gate.minCoverage || (gate.requireCentroidInside && !top.cIn)) {
      // The part sticks materially outside its best candidate parent. That is the
      // signature of a part whose true parent is absent from the parent layer:
      // the only structure near it is a neighbour's, which does not cover it.
      state = 'AMBIGUOUS_WEAK_COVER';
    } else if (margin < gate.minMargin) {
      state = 'AMBIGUOUS_STRADDLE';
    } else if (!top.s.localId) {
      state = 'NO_PARENT_ID';
    } else {
      state = 'ASSIGNED'; localId = top.s.localId; structId = top.s.structId;
    }
    out.push({
      partId: f.id, sourceId: f.sourceId, state, localId, structId,
      coverage: top ? +top.cov.toFixed(3) : 0,
      runnerUp: second ? +second.cov.toFixed(3) : 0,
      margin: +margin.toFixed(3), centroidInside: top ? top.cIn : false,
    });
  }
  out.sort((a, b) => (a.sourceId.length - b.sourceId.length) || a.sourceId.localeCompare(b.sourceId));
  return out;
}

/** Score an assignment against transient City audit ground truth. */
export function score(assigned, truthById) {
  const A = assigned.filter((a) => a.state === 'ASSIGNED');
  const auditable = A.filter((a) => truthById.get(a.sourceId));
  const unknown = A.length - auditable.length;
  let correct = 0, wrong = 0;
  for (const a of auditable) (a.localId === truthById.get(a.sourceId) ? correct++ : wrong++);
  const groups = new Map();
  for (const a of auditable) { if (!groups.has(a.localId)) groups.set(a.localId, new Set()); groups.get(a.localId).add(truthById.get(a.sourceId)); }
  let falseMerge = 0;
  for (const [, t] of groups) if (t.size > 1) falseMerge++;
  const byTruth = new Map();
  for (const a of auditable) { const t = truthById.get(a.sourceId); if (!byTruth.has(t)) byTruth.set(t, new Set()); byTruth.get(t).add(a.localId); }
  let falseSplit = 0;
  for (const [, g] of byTruth) if (g.size > 1) falseSplit++;
  const states = {};
  for (const a of assigned) states[a.state] = (states[a.state] || 0) + 1;
  return {
    parts: assigned.length, assigned: A.length,
    coveragePct: +(100 * A.length / assigned.length).toFixed(1),
    buildingGroups: new Set(A.map((a) => a.localId)).size,
    auditable: auditable.length, auditUnknown: unknown,
    confirmedCorrect: correct, confirmedWrong: wrong,
    precisionPct: auditable.length ? +(100 * correct / auditable.length).toFixed(1) : null,
    falseMerge, falseSplit, states,
  };
}

/**
 * OVER-SUBSCRIPTION GATE.
 *
 * The observed failure mode is not "the rule picked a bad parent"; it is "the
 * true parent is ABSENT from the parent layer, so a neighbour is the only
 * candidate left". That has a signature the parent layer can show on its own,
 * with no City data: the surviving structure ends up carrying more part area
 * than it has footprint. A structure that is over-subscribed is absorbing parts
 * that belong to a building the layer does not hold.
 *
 * Whole groups are demoted, not individual parts: if a structure is
 * over-subscribed, which of its parts are the intruders is exactly what cannot
 * be determined from the parent layer.
 */
export function overSubscriptionFilter(assigned, parts, structs, maxRatio) {
  const areaById = new Map(parts.map((p) => [p.id, p.derived.areaM2]));
  const structArea = new Map();
  for (const s of structs) {
    // AREA_SQ_FT is the source's own figure, in square feet.
    if (s.areaSqFt != null) structArea.set(s.structId, s.areaSqFt * 0.3048 * 0.3048);
  }
  const sum = new Map();
  for (const a of assigned) {
    if (a.state !== 'ASSIGNED') continue;
    sum.set(a.structId, (sum.get(a.structId) || 0) + (areaById.get(a.partId) || 0));
  }
  const ratio = new Map();
  for (const [sid, partSum] of sum) {
    const sa = structArea.get(sid);
    if (sa && sa > 0) ratio.set(sid, partSum / sa);
  }
  return assigned.map((a) => {
    if (a.state !== 'ASSIGNED') return a;
    const r = ratio.get(a.structId);
    if (r != null && r > maxRatio) {
      return { ...a, state: 'AMBIGUOUS_OVERSUBSCRIBED', localId: null, structId: null, areaRatio: +r.toFixed(3) };
    }
    return r != null ? { ...a, areaRatio: +r.toFixed(3) } : a;
  });
}

/**
 * FROZEN STAGE 1A.2 GATE — "mixed ground elevation" demotion.
 *
 * Derived on Back Bay, then frozen BEFORE the second-area test.
 *
 * The residual Back Bay failures are not missing parents and not bad
 * assignments. Measured: for three attached pairs the MassGIS structure area
 * equals the SUM of the two City buildings' part areas to a ratio of exactly
 * 1.00 — MassGIS draws ONE roofprint over TWO City buildings. Neither PDDL nor
 * MassGIS contains the subdivision, so no gate over those two sources can
 * recover it.
 *
 * What a gate CAN do is refuse to assert a single identity where the evidence
 * is mixed. `GRND_ELEV_2010` is surveyed per part; parts of one structure that
 * disagree on it may be separately-founded buildings. As a classifier this is
 * poor — measured 100% recall at 15% precision on Back Bay — but as a
 * DEMOTION it is exactly the right shape: it catches every detectable merge,
 * and its cost is demoting correct groups to AMBIGUOUS. A false negative is
 * preferable to a false merge.
 *
 * Singleton structures are untouched: with one part there is nothing to mix.
 */
export const FROZEN_GATE = {
  minCoverage: 0.0, minMargin: 0.35, requireCentroidInside: false,
  groundToleranceFt: 0.01, version: 'stage1a2-gate/1.0.0',
};
export function mixedGroundFilter(assigned, parts, toleranceFt) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const byStruct = new Map();
  for (const a of assigned) {
    if (a.state !== 'ASSIGNED') continue;
    if (!byStruct.has(a.structId)) byStruct.set(a.structId, []);
    byStruct.get(a.structId).push(a);
  }
  const demote = new Set();
  for (const [sid, list] of byStruct) {
    if (list.length < 2) continue;
    const g = list.map((a) => byId.get(a.partId)?.fact.groundElevFt).filter((v) => v != null);
    if (g.length < 2) continue;
    if (Math.max(...g) - Math.min(...g) > toleranceFt) demote.add(sid);
  }
  return assigned.map((a) => (a.state === 'ASSIGNED' && demote.has(a.structId))
    ? { ...a, state: 'AMBIGUOUS_MIXED_GROUND', localId: null, structId: null }
    : a);
}
export function runFrozenGate(parts, structs) {
  const base = assign(parts, structs, FROZEN_GATE);
  return mixedGroundFilter(base, parts, FROZEN_GATE.groundToleranceFt);
}
