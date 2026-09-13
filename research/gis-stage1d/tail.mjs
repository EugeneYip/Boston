/**
 * Stage 1D phase 11 — what is in Stage 1C's ~20% source-disagreement tail?
 *
 * Bounded classification only. The tail is not allowed to drive the main
 * diagnosis; this exists so it is characterised rather than left as a shrug.
 */
import { writeFileSync } from 'node:fs';
import { buildEnvelopes } from '../gis-stage1c/envelope.mjs';
import { loadSources } from '../gis-stage1c/sources.mjs';
import { centroid, polyArea, bbox, intersectionArea } from '../../src/world/GisAssociate.js';

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const TOL = 0.5, DEEP = 2.0;

const { byFace } = buildEnvelopes();
const { pddl, massgis } = loadSources();

/** Does this polygon have a counterpart in the other source? Centroid-in-ring,
 *  then area agreement — a coarse test, used only to count missing structures. */
const inRing = (px, pz, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) &&
        (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c;
};
function counterpart(g, other) {
  const c = centroid(g.ring);
  for (const o of other) {
    const b = bbox(o.ring);
    if (c.x < b.x0 || c.x > b.x1 || c.z < b.z0 || c.z > b.z1) continue;
    if (inRing(c.x, c.z, o.ring)) return o;
  }
  return null;
}
const pddlById = new Map(pddl.map((g) => [g.oid, g]));
const msById = new Map(massgis.map((g) => [g.oid, g]));

const tally = {}, add = (k) => (tally[k] = (tally[k] || 0) + 1);
let both = 0, agree = 0;
const gaps = [];
for (const rec of byFace) {
  for (const s of rec.samples) {
    if (s.pd === null || s.md === null) continue;
    both++;
    if (s.dis <= TOL) { agree++; continue; }
    gaps.push(s.dis);
    const same = s.pOid !== null && s.mOid !== null && pddlById.get(s.pOid) && msById.get(s.mOid) &&
      intersectionArea(pddlById.get(s.pOid).ring, bboxQuad(msById.get(s.mOid).ring)) > 0;
    if (s.md > s.pd + DEEP) add(same ? 'massgis-wall-deeper-same-building' : 'massgis-misses-a-structure-pddl-sees');
    else if (s.pd > s.md + DEEP) add(same ? 'pddl-wall-deeper-same-building' : 'pddl-misses-a-structure-massgis-sees');
    else add('delineation-difference-under-2m');
  }
}
/** Axis-aligned quad of a ring — a convex stand-in so `intersectionArea`'s
 *  convex-clip precondition holds for this coarse "same building?" test. */
function bboxQuad(r) {
  const b = bbox(r);
  return [{ x: b.x0, z: b.z0 }, { x: b.x1, z: b.z0 }, { x: b.x1, z: b.z1 }, { x: b.x0, z: b.z1 }];
}

const pddlNoMs = pddl.filter((g) => !counterpart(g, massgis));
const msNoPddl = massgis.filter((g) => !counterpart(g, pddl));
const areaOf = (a) => a.reduce((s, g) => s + polyArea(g.ring), 0);

const out = {
  schemaVersion: 'boston-gis-stage1d/tail/0.1.0',
  paired: both, agreeWithinTolM: TOL, agree, disagree: both - agree,
  disagreePct: r2(100 * (both - agree) / both),
  gapDistributionM: { p25: r2(q(gaps, .25)), p50: r2(q(gaps, .5)), p75: r2(q(gaps, .75)), p90: r2(q(gaps, .9)), max: r2(q(gaps, 1)) },
  classification: tally,
  structureCoverage: {
    pddlPolygons: pddl.length, massgisPolygons: massgis.length,
    pddlWithNoMassgisCounterpart: pddlNoMs.length,
    massgisWithNoPddlCounterpart: msNoPddl.length,
    pddlOrphanAreaM2: r2(areaOf(pddlNoMs)), massgisOrphanAreaM2: r2(areaOf(msNoPddl)),
  },
};
writeFileSync(new URL('./tail.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
