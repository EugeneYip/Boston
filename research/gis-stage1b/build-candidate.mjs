/**
 * Stage 1B — generate the Back Bay runtime candidate dataset.
 *
 *   node research/gis-stage1b/build-candidate.mjs
 *
 * Reads the accepted Stage 1A / 1A.2 research artifacts and emits ONE small
 * generated runtime module. Deterministic: same inputs, byte-identical output.
 *
 * GEOMETRY SOURCE (Phase 3, recorded because the choice matters):
 *   Boston "Buildings with Roof Breaks" (PDDL) part outlines, dissolved per
 *   MassGIS LOCAL_ID group. This is the geometry the Stage 1A.2 schema already
 *   establishes; it is NOT swapped for the MassGIS structure polygon.
 *   It is a ROOF-BREAK outline — a roofprint-derived plan outline — not a
 *   surveyed ground footprint. Stage 1B may therefore read it as "where the
 *   building sits and what shape it is in plan", and may NOT read it as an
 *   exact ground-floor wall line.
 *
 * NOT INCLUDED, deliberately: any City `Assessing/DOIT_buildings` value
 * (LEGAL-UNKNOWN), any absolute elevation, any GIS height, any audit data.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadParts, loadStructures, runGateV11, GATE_V11 } from '../gis-stage1a2/gate.mjs';

const U = (p) => new URL(p, import.meta.url).pathname;
const parts = loadParts(U('../gis-stage1a/fixture.json'));
const structs = loadStructures(U('../gis-stage1a1/cache/massgis_structures_4326.json'));
const manifest = JSON.parse(readFileSync(U('../gis-stage1a/manifest.json'), 'utf8'));
const byId = new Map(parts.map((p) => [p.id, p]));

const assigned = runGateV11(parts, structs).filter((a) => a.state === 'ASSIGNED');
const groups = new Map();
for (const a of assigned) {
  if (!groups.has(a.localId)) groups.set(a.localId, []);
  groups.get(a.localId).push(a);
}

const K = (p) => p[0].toFixed(2) + ',' + p[1].toFixed(2);
/**
 * Dissolve a group's part rings into ONE ordered outer ring.
 * Edges shared by two sibling parts cancel; the survivors are traced into loops.
 * Returns null when the survivors do not form exactly one closed loop — that
 * group then falls back to procedural rather than being forced.
 */
function dissolve(ringsOfParts) {
  const count = new Map(), dir = new Map();
  for (const rings of ringsOfParts) for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const A = r[i], B = r[(i + 1) % r.length];
      const a = K(A), b = K(B);
      if (a === b) continue;
      const k = a < b ? a + '|' + b : b + '|' + a;
      count.set(k, (count.get(k) || 0) + 1);
      if (!dir.has(k)) dir.set(k, [A, B]);
    }
  }
  const surv = [];
  for (const [k, n] of count) if (n === 1) surv.push(dir.get(k));
  if (!surv.length) return null;
  const adj = new Map();
  for (const [A, B] of surv) {
    for (const [p, q] of [[A, B], [B, A]]) {
      const kp = K(p);
      if (!adj.has(kp)) adj.set(kp, []);
      adj.get(kp).push(q);
    }
  }
  for (const [, v] of adj) if (v.length !== 2) return null;      // not a simple loop
  const start = surv[0][0];
  const ring = [start];
  let prev = K(start), cur = surv[0][1];
  let guard = 0;
  while (K(cur) !== K(start) && guard++ < 10000) {
    ring.push(cur);
    const nb = adj.get(K(cur));
    if (!nb) return null;
    const next = K(nb[0]) === prev ? nb[1] : nb[0];
    prev = K(cur); cur = next;
  }
  if (K(cur) !== K(start)) return null;
  return ring.length >= 3 ? ring : null;
}
const area2 = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; s += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return s; };

const out = [], rejected = [];
for (const [localId, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ps = list.map((a) => byId.get(a.partId))
    .sort((p, q) => (p.sourceId.length - q.sourceId.length) || p.sourceId.localeCompare(q.sourceId));
  if (ps.some((p) => p.derived.rings.length > 1)) { rejected.push({ localId, reason: 'interior-ring' }); continue; }
  let ring = ps.length === 1 ? ps[0].derived.rings[0].map((p) => [...p]) : dissolve(ps.map((p) => p.derived.rings));
  if (!ring) { rejected.push({ localId, reason: 'dissolve-not-a-single-loop' }); continue; }
  if (area2(ring) < 0) ring.reverse();                            // CCW in XZ
  const a = Math.abs(area2(ring)) / 2;
  if (!(a > 24)) { rejected.push({ localId, reason: 'area-under-24m2' }); continue; }
  out.push({
    id: `bb-${localId}`, localId,
    partIds: ps.map((p) => p.sourceId),
    ring: ring.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
    areaM2: +a.toFixed(2),
  });
}

const body = out.map((c) =>
  `  { id: '${c.id}', localId: '${c.localId}', parts: [${c.partIds.map((p) => `'${p}'`).join(', ')}], areaM2: ${c.areaM2},\n` +
  `    ring: [${c.ring.map(([x, z]) => `[${x},${z}]`).join(',')}] },`).join('\n');

const src = `/**
 * Back Bay GIS candidate footprints — Stage 1B prototype. GENERATED, do not hand-edit.
 *
 *   node research/gis-stage1b/build-candidate.mjs
 *
 * DEFAULT OFF. Consumed only when the Stage 1B prototype flag is set; see
 * \`src/world/GisBackBay.js\`. With the flag absent this module is imported but
 * never applied, and Boston behaves exactly as baseline.
 *
 * WHAT THIS IS. The high-confidence factual subset accepted by Stage 1A.2:
 * roof-break part outlines from the City of Boston PDDL layer, dissolved per
 * MassGIS \`LOCAL_ID\` building identity, restricted to parts the frozen gate
 * classified FACTUAL_PARENT_CONFIRMED. Every ambiguous, missing-parent,
 * blank-identity or delineation-conflict case is EXCLUDED and stays procedural.
 *
 * WHAT THIS IS NOT. Not a ground footprint — these are roof-break outlines, so
 * they say where a building sits and what shape it is in plan, not where its
 * ground-floor wall line runs. No height, no elevation, no vertical datum: X/Z
 * only. No City \`Assessing/DOIT_buildings\` value appears here; that service is
 * LEGAL-UNKNOWN and was audit-only research evidence, never runtime input.
 *
 * Rings are CLOSED (first vertex not repeated), CCW in XZ, [x, z] in world
 * metres, already projected through \`Geo.geo()\`, so nothing converts at runtime.
 */

/** Provenance for every byte below. */
export const GIS_BACKBAY_SOURCE = {
  geometry: {
    dataset: 'Boston Buildings with Roof Breaks',
    publisher: 'Boston Maps (City of Boston)',
    record: 'https://data.boston.gov/dataset/boston-buildings-with-roof-breaks',
    service: '${manifest.sources[0].service}',
    licence: 'ODC-PDDL-1.0',
    sourceCrs: 'EPSG:6492',
    extractDate: '${manifest.sources[0].retrievedUtc}',
    rawSha256: '${manifest.sources[0].rawSha256}',
    geometryType: 'roof-break part outline, dissolved per building identity',
  },
  identity: {
    dataset: 'MassGIS Building Structures (2-D)',
    publisher: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS',
    item: '607d9827695341deb11b44a686b45fa4',
    licence: 'MassGIS public record — freely redistributable including derivative works',
    attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS',
    field: 'LOCAL_ID',
    note: 'Boston features observed to preserve City BUILDING_ID in LOCAL_ID; that is observed behaviour, not documented field semantics. Layer publication date is not evidence of the Boston subset vintage.',
  },
  gate: '${GATE_V11.version}',
  gateParams: ${JSON.stringify({ minMargin: GATE_V11.minMargin, groundToleranceFt: GATE_V11.groundToleranceFt, minParentFill: GATE_V11.minParentFill })},
  bboxWgs84: ${JSON.stringify(manifest.area.bboxWgs84)},
  bboxWorld: ${JSON.stringify(manifest.area.bboxWorldBostonLocal)},
  projection: 'src/core/Geo.js geo() — UNCHANGED',
  fallbackState: 'FACTUAL_PARENT_CONFIRMED',
};

/** ${out.length} candidate buildings from ${assigned.length} confirmed parts. */
export const GIS_BACKBAY_CANDIDATES = [
${body}
];
`;
writeFileSync(U('../../src/data/gis-backbay-candidate.js'), src);
const sha = createHash('sha256').update(src).digest('hex');
console.log(`[candidate] parts ${assigned.length} -> groups ${groups.size} -> emitted ${out.length}, rejected ${rejected.length}`);
if (rejected.length) console.log('[candidate] rejected:', JSON.stringify(rejected));
console.log(`[candidate] src/data/gis-backbay-candidate.js  ${(src.length / 1024).toFixed(1)} KiB  sha256 ${sha.slice(0, 16)}`);
