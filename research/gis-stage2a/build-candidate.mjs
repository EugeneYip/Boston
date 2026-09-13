/**
 * Stage 2A — generate the bounded runtime road candidate from the Stage 1E fixture.
 *
 *   node research/gis-stage2a/build-candidate.mjs
 *
 * Offline and deterministic: reads the committed Stage 1E fixture, never the
 * network. Emits `src/data/gis-backbay-roads.js`, which is a small GENERATED
 * module in the same shape `boston-geo.js` publishes — real lat/lon paths, so
 * nothing downstream invents world coordinates and everything still flows
 * through production `geo()`.
 *
 * ## What is factual and what is not
 *
 * FACTUAL: the centreline geometry, the street identity, ZLEV, and the one-way
 * sense. Nothing else.
 *
 * NOT FACTUAL, and deliberately still procedural: road width, lane count, road
 * class, footway width, kerb, parking bays, surface. SAM publishes no
 * authoritative width and Stage 2A does not invent one — the whole point is to
 * isolate the geometry variable, so each factual street inherits the width
 * semantics Boston already uses for the street of that name.
 *
 * ## Exclusions
 *
 * Grade-separated geometry is dropped, not flattened. The Massachusetts Turnpike
 * crosses Back Bay at `ZLEV -1` — in a tunnel — and its ramps run -2..0. Pulling
 * those onto the surface network would drive an eight-lane highway through the
 * middle of Newbury Street. `Exeter PLZ` is `CFCC A71`, a pedestrian plaza.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo, unGeo } from '../../src/core/Geo.js';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const FIX = JSON.parse(readFileSync(new URL('../gis-stage1e/backbay-roads.json', import.meta.url), 'utf8'));
const r7 = (v) => Math.round(v * 1e7) / 1e7;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;

/* ---- 1. semantic mapping: factual name -> Boston road concept ------------- */
/**
 * Normalised street identity. SAM writes "Newbury ST" and "Public Alley No. 435";
 * Boston writes "Newbury Street" and "Public Alley 435". Both reduce to the same
 * key. This is a generic normalisation, not a lookup table of addresses.
 */
function normName(s) {
  return (s || '').toLowerCase()
    .replace(/\bno\.?\s+/g, '')
    .replace(/\b(street|st)\b/g, 'st').replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd').replace(/\b(square|sq)\b/g, 'sq')
    .replace(/\b(plaza|plz)\b/g, 'plz').replace(/\b(turnpike|tpke)\b/g, 'tpke')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
/** Boston's own entries, indexed by normalised name. */
const bostonByName = new Map();
for (const s of STREETS) {
  const k = normName(s.name);
  if (!bostonByName.has(k)) bostonByName.set(k, []);
  bostonByName.get(k).push(s);
}
/** Boston's street polylines in world X/Z, for the nearest-concept match. */
const bostonWorld = new Map();
for (const s of STREETS) bostonWorld.set(s, s.path.map(([la, lo]) => geo(la, lo)));
const distToStreet = (p, s) => {
  const w = bostonWorld.get(s);
  let best = Infinity;
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1], b = w[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    let t = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
    if (d < best) best = d;
  }
  return best;
};
/**
 * Which Boston road concept does this factual line belong to?
 *
 * Name first, then GEOMETRY to disambiguate. Boston splits Commonwealth Avenue
 * into "Inbound", "Outbound" and "West"; SAM calls all of it "Commonwealth AVE".
 * Taking the first name-prefix match sent every factual carriageway to Inbound
 * and left Boston with 107 parcels on one side against 216 on the other, where
 * the baseline has 167/168. Choosing the nearest candidate line instead assigns
 * each factual carriageway to the Boston carriageway it actually is, and drops
 * "West" — a different street a kilometre away — without naming it.
 */
function pickConcept(name, pts) {
  const k = normName(name);
  const cands = [];
  for (const [bk, bl] of bostonByName) {
    if (bk === k || bk.startsWith(k + ' ') || k.startsWith(bk + ' ')) cands.push(...bl);
  }
  if (!cands.length) return null;
  if (cands.length === 1) return cands;
  const m = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length };
  const scored = cands.map((s) => ({ s, d: distToStreet(m, s) })).sort((a, b) => a.d - b.d || (a.s.name < b.s.name ? -1 : 1));
  return [scored[0].s, ...scored.slice(1).map((v) => v.s)];
}

/* ---- 2. the factual surface population ----------------------------------- */
const surface = FIX.features.filter((f) => f.surface).sort((a, b) => a.segmentId - b.segmentId);
const excluded = FIX.features.filter((f) => !f.surface)
  .map((f) => ({ segmentId: f.segmentId, name: f.name || null, zlev: f.zlev, cfcc: f.cfcc,
                 reason: f.cfcc === 'A71' ? 'walkway/plaza (CFCC A71)' : 'grade-separated (ZLEV < 0)' }));

/** Group a divided boulevard's carriageways so each can take a distinct concept. */
const byName = new Map();
for (const f of surface) {
  const k = normName(f.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(f);
}

const emitted = [];
const mapping = [];
for (const f of surface) {
  for (let pi = 0; pi < f.paths.length; pi++) {
    const pts = f.paths[pi].map(([x, z]) => ({ x, z }));
    if (pts.length < 2) continue;
    const list = pickConcept(f.name, pts);
    let concept = list ? list[0] : null;
    let dividedSide = null;
    if (list && list.length > 1) {
      // `pickConcept` has already ordered by geometric proximity, so the nearest
      // Boston carriageway is the right one. No side heuristic is needed and none
      // is used: an axis test on a diagonal boulevard was the earlier mistake.
      dividedSide = concept.name;
    }
    // Fall back on the source's own class only where Boston has no such street.
    const fallback = f.cfcc === 'A73' ? { type: 'alley', lanes: 1 }
      : f.cfcc === 'A25' || f.cfcc === 'A31' ? { type: 'arterial', lanes: 4 }
      : { type: 'street', lanes: 2 };
    const type = concept ? concept.type : fallback.type;
    const lanes = concept ? concept.lanes : fallback.lanes;
    emitted.push({
      samSegmentId: f.segmentId, samObjectId: f.objectId, samName: f.name,
      samCfcc: f.cfcc, samOneway: f.oneway, samZlev: f.zlev,
      name: concept ? concept.name : f.name,
      type, lanes,
      // One-way sense is taken from SAM because the emitted path is SAM's own
      // vertex order; Boston's flag refers to Boston's authored direction and
      // would send traffic backwards on a reversed line. This is consumed for
      // graph correctness, not as a gameplay preference.
      oneway: f.samOneway === 'TF' || f.oneway === 'TF' ? -1 : f.oneway === 'FT' ? 1 : 0,
      mall: concept?.mall ?? false,
      surface: concept?.surface,
      dividedSide,
      path: pts.map((p) => { const g = unGeo(p.x, p.z); return [r7(g.lat), r7(g.lon)]; }),
    });
    mapping.push({ sam: f.name, samCfcc: f.cfcc, boston: concept ? concept.name : '(no Boston equivalent)',
                   type, lanes, source: concept ? 'boston-concept' : 'source-class-fallback', dividedSide });
  }
}

/* ---- 3. clip the hand-authored streets out of the core -------------------- */
// The factual core must not contain two versions of the same street. Boston's
// own lines are cut at the core boundary and everything OUTSIDE is preserved
// untouched; nothing is warped, moved or re-authored.
const clipped = [];
let clipStats = { touched: 0, runsKept: 0, runsDropped: 0 };
for (let si = 0; si < STREETS.length; si++) {
  const s = STREETS[si];
  const w = s.path.map(([la, lo]) => geo(la, lo));
  if (!w.some(inCore) && !w.some((p, i) => i && segCrossesCore(w[i - 1], p))) continue;
  clipStats.touched++;
  const runs = [];
  let cur = [];
  const push = (idx, pt) => cur.push(pt ?? s.path[idx]);
  for (let i = 0; i < w.length; i++) {
    if (!inCore(w[i])) cur.push(s.path[i]);
    else { if (cur.length >= 2) runs.push(cur); cur = []; }
  }
  if (cur.length >= 2) runs.push(cur);
  clipStats.runsKept += runs.length;
  clipStats.runsDropped += (w.filter(inCore).length ? 1 : 0);
  clipped.push({ name: s.name, index: si, runs });
}
/** Does the segment a->b pass through the core even if neither end is inside? */
function segCrossesCore(a, b) {
  for (let t = 0; t <= 1; t += 0.05) {
    const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    if (inCore(p)) return true;
  }
  return false;
}

/* ---- 4. emit ------------------------------------------------------------- */
const header = `/**
 * Back Bay factual road centrelines — GENERATED, do not hand-edit.
 *
 *   node research/gis-stage2a/build-candidate.mjs
 *
 * Stage 2A prototype data. DEFAULT OFF: nothing imports this unless
 * \`?gisRoads=1\` is present. See \`src/world/GisRoads.js\`.
 *
 * Source      Boston Street Segments (SAM System), Boston Maps, City of Boston
 * Licence     ODC-PDDL-1.0 — https://data.boston.gov/dataset/boston-street-segments-sam-system
 * Service     ${FIX.source.service}
 * Layer       ${FIX.source.layerName}
 * Retrieved   ${FIX.source.retrieved}
 * Raw sha256  ${FIX.source.rawSha256}
 * Projection  service EPSG:4326, then production src/core/Geo.js geo()
 *
 * SEMANTICS. These are ADDRESSING / ROUTING centrelines, not surveyed pavement
 * centrelines, and SAM carries no authoritative road width. Only the centreline
 * geometry, street identity, ZLEV and one-way sense are factual here. Width,
 * lane count, road class, footway, kerb and parking all stay procedural and are
 * inherited from Boston's existing entry for the street of the same name.
 *
 * EXCLUSIONS. Grade-separated features are dropped rather than flattened: the
 * Massachusetts Turnpike runs under Back Bay at ZLEV -1 and its ramps at -2..0.
 * \`Exeter PLZ\` is a pedestrian plaza (CFCC A71).
 */
`;
const body = header +
  `export const GIS_ROADS_SOURCE = ${JSON.stringify({
    dataset: FIX.source.dataset, publisher: FIX.source.publisher, licence: 'ODC-PDDL-1.0',
    catalog: FIX.source.catalog, service: FIX.source.service, layer: FIX.source.layerName,
    retrieved: FIX.source.retrieved, rawSha256: FIX.source.rawSha256,
    semantics: FIX.source.semantics,
    core: { x0: r7(CORE.x0), x1: r7(CORE.x1), z0: r7(CORE.z0), z1: r7(CORE.z1) },
    surfaceFilter: FIX.surfaceFilter,
    excludedFeatures: excluded.length,
  }, null, 1)};\n\n` +
  `/** Factual surface streets, in the STREETS shape \`RoadNetwork._prepare\` consumes. */\n` +
  `export const GIS_ROADS = ${JSON.stringify(emitted.map((e) => ({
    name: e.name, type: e.type, lanes: e.lanes,
    ...(e.oneway ? { oneway: e.oneway } : {}), ...(e.mall ? { mall: true } : {}),
    ...(e.surface ? { surface: e.surface } : {}),
    path: e.path,
    sam: { segmentId: e.samSegmentId, objectId: e.samObjectId, name: e.samName, cfcc: e.samCfcc, zlev: e.samZlev },
  })), null, 1)};\n\n` +
  `/** Hand-authored Boston streets, clipped to the parts OUTSIDE the factual core. */\n` +
  `export const GIS_ROADS_CLIPPED = ${JSON.stringify(clipped, null, 1)};\n`;

writeFileSync(new URL('../../src/data/gis-backbay-roads.js', import.meta.url), body);
const outHash = createHash('sha256').update(body).digest('hex');

const manifest = {
  schemaVersion: 'boston-gis-stage2a/candidate/0.1.0',
  source: { ...FIX.source },
  core: CORE,
  emittedStreets: emitted.length,
  excludedFeatures: excluded,
  clipped: clipStats,
  clippedStreets: clipped.map((c) => ({ name: c.name, runs: c.runs.length, vertices: c.runs.reduce((s, r) => s + r.length, 0) })),
  mapping,
  outputBytes: body.length, outputSha256: outHash,
};
writeFileSync(new URL('./candidate-manifest.json', import.meta.url), JSON.stringify(manifest, null, 1) + '\n');

console.log(`emitted ${emitted.length} factual street entries from ${surface.length} SAM surface features`);
console.log(`excluded ${excluded.length} non-surface features: ${[...new Set(excluded.map((e) => e.reason))].join(', ')}`);
console.log(`clipped ${clipStats.touched} hand-authored streets -> ${clipStats.runsKept} outside-core runs kept`);
console.log(`src/data/gis-backbay-roads.js  ${body.length} bytes  sha256 ${outHash.slice(0, 16)}`);
const noConcept = mapping.filter((m) => m.source !== 'boston-concept');
console.log(`\nsemantic mapping: ${mapping.length - noConcept.length} via Boston concept, ${noConcept.length} via source class`);
for (const m of noConcept) console.log(`  fallback: ${m.sam} (${m.samCfcc}) -> ${m.type}/${m.lanes}`);
