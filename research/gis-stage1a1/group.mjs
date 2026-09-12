/**
 * Stage 1A.1 — group PDDL roof-break parts into BUILDING units.
 *
 *   node research/gis-stage1a1/group.mjs
 *
 * METHOD (authoritative, not heuristic):
 *   parent identity  = MassGIS "Building Structures (2-D)" `LOCAL_ID`
 *   parent geometry  = the same layer's structure polygon
 *   assignment       = maximum-overlap containment of the PDDL part in a structure
 *
 * WHY THIS AND NOT A GEOMETRIC RULE. The PDDL roof-break layer carries no parent
 * identifier — 12 fields on the FeatureServer, the same 12 in the PDDL CSV. A
 * connected-component union on shared edges is catastrophic in Back Bay: 218
 * parts collapse to 31 components, one of which swallows 20 distinct buildings.
 * And no PDDL-only signal separates a party wall from a roof break — measured,
 * shared-boundary median 16.13 m within a building against 16.41 m between
 * buildings. MassGIS supplies the identity the PDDL layer omits.
 *
 * LICENCE. MassGIS data is a public record, freely redistributable including
 * derivative works, credit requested as "MassGIS (Bureau of Geographic
 * Information), Commonwealth of Massachusetts EOTSS". This layer's
 * `copyrightText` is "MassGIS, City of Boston" and every feature here carries
 * SOURCE = "City of Boston". The City's own DOIT_buildings service, which holds
 * the same identifier as BUILDING_ID, is NOT used as input: it publishes no
 * licence, only a warranty disclaimer, and no Analyze Boston record names it. It
 * appears in this programme only as audit evidence, never as committed data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { geo } from '../../src/core/Geo.js';

const fx = JSON.parse(readFileSync(new URL('../gis-stage1a/fixture.json', import.meta.url), 'utf8'));
const ms = JSON.parse(readFileSync(new URL('./cache/massgis_structures_4326.json', import.meta.url), 'utf8'));

const r2 = (v) => +v.toFixed(2);
/** Minimum score margin over the runner-up structure before a part is grouped. */
export const MARGIN = 0.35;
export function msToWorld() {
  return ms.features.map((f) => ({
    structId: f.attributes.STRUCT_ID,
    localId: f.attributes.LOCAL_ID ?? null,
    areaSqFt: f.attributes.AREA_SQ_FT ?? null,
    rings: f.geometry.rings.map((ring) => {
      const pts = (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
        ? ring.slice(0, -1) : ring;
      return pts.map(([lon, lat]) => { const p = geo(lat, lon); return [r2(p.x), r2(p.z)]; });
    }),
  }));
}
const area2 = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; s += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return s; };
export const centroid = (r) => {
  let A = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length, c = r[i][0] * r[j][1] - r[j][0] * r[i][1]; A += c; x += (r[i][0] + r[j][0]) * c; y += (r[i][1] + r[j][1]) * c; }
  A *= 0.5;
  if (Math.abs(A) < 1e-9) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [x / (6 * A), y / (6 * A)];
};
function inRing(px, pz, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (((r[i][1] > pz) !== (r[j][1] > pz)) &&
        (px < (r[j][0] - r[i][0]) * (pz - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
  }
  return c;
}
/** Point in a polygon with holes: inside ring 0 and outside every later ring. */
const inPoly = (px, pz, rings) => inRing(px, pz, rings[0]) && !rings.slice(1).some((h) => inRing(px, pz, h));
/** Fraction of a part's vertices falling inside a structure — the overlap proxy. */
function coverage(partRing, rings) {
  let n = 0;
  for (const [x, z] of partRing) if (inPoly(x, z, rings)) n++;
  return n / partRing.length;
}

export function group() {
  const structs = msToWorld();
  const assigned = [];
  for (const f of fx.features) {
    const ring = f.derived.rings[0];
    const c = centroid(ring);
    // Score every candidate structure, then require a clear MARGIN over the
    // runner-up. The two layers are different geometry lineages — MassGIS
    // roofprints were interpreted from 2011-12 imagery and NDSM-shifted, the
    // City parts are roof-break polygons — so overlap is genuinely partial
    // (median coverage 0.47). A part straddling two structures is exactly the
    // party-wall case, and forcing it into the better-scoring one is how
    // adjacent Newbury Street houses get merged. Straddles are marked AMBIGUOUS
    // and left ungrouped instead.
    const scored = structs.map((s) => {
      const cov = coverage(ring, s.rings);
      const cIn = inPoly(c[0], c[1], s.rings);
      return { s, cov, cIn, score: cov + (cIn ? 0.5 : 0) };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const top = scored[0] ?? null, second = scored[1] ?? null;
    const margin = top ? top.score - (second?.score ?? 0) : 0;
    let confidence = 'UNASSIGNED';
    if (top && margin >= MARGIN && (top.cov >= 0.50 || top.cIn)) {
      confidence = (top.cov >= 0.90 || (top.cIn && top.cov >= 0.60)) ? 'HIGH' : 'MEDIUM';
    } else if (top && margin < MARGIN) {
      confidence = 'AMBIGUOUS';
    } else if (top) {
      confidence = 'LOW';
    }
    const grouped = confidence === 'HIGH' || confidence === 'MEDIUM';
    assigned.push({
      partId: f.id, sourceId: f.sourceId,
      structId: grouped ? top.s.structId : null,
      localId: grouped ? (top.s.localId ?? null) : null,
      coverage: top ? +top.cov.toFixed(3) : 0,
      runnerUpCoverage: second ? +second.cov.toFixed(3) : 0,
      margin: +margin.toFixed(3),
      centroidInside: top ? top.cIn : false, confidence,
    });
  }
  return { structs, assigned };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { structs, assigned } = group();
  const byConf = {};
  for (const a of assigned) byConf[a.confidence] = (byConf[a.confidence] || 0) + 1;
  console.log('[group] parts', assigned.length, 'assignment confidence:', JSON.stringify(byConf));
  const ids = assigned.filter(a => a.localId).map(a => a.localId);
  const cnt = {}; for (const i of ids) cnt[i] = (cnt[i] || 0) + 1;
  const dist = {}; for (const v of Object.values(cnt)) dist[v] = (dist[v] || 0) + 1;
  console.log('[group] unique LOCAL_ID buildings:', Object.keys(cnt).length);
  console.log('[group] parts-per-building:', JSON.stringify(dist));
  console.log('[group] MassGIS structures in bbox:', structs.length,
              '| distinct LOCAL_ID:', new Set(structs.map(s => s.localId).filter(Boolean)).size);
}
