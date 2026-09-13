/**
 * Stage 2A.1 — contained candidate generator.
 *
 *   node research/gis-stage2a1/build-candidate.mjs
 *
 * Supersedes `research/gis-stage2a/build-candidate.mjs`. Same source, same
 * provenance, same frozen factual core — three defects fixed:
 *
 * ## 1. Per-vertex attribute arrays were not clipped with the path
 *
 * Boston declares `median`, `y` and `bridge` as arrays PARALLEL TO `path`.
 * Stage 2A clipped `path` and kept the arrays whole, so on Huntington Avenue —
 * `median: [0 ×10, 7.0 ×4]` — the run beginning at vertex 8 read median 0 where
 * it should read 7.0. `e.median` fell to 0, `laneLayout` then counted 4 lanes
 * instead of 2, and the `nuniv` MBTA station section was refused as a lane-count
 * change. The geometry was never wrong: control edge #486 and candidate #446 are
 * both 389.5 m. Only the attribute alignment was.
 *
 * ## 2. The factual geometry overhung the core
 *
 * SAM features were selected by *intersects*, so whole segments ran up to
 * 163.2 m past the box (39 of 141 vertices). Out there they crossed
 * hand-authored streets and moved those junctions, which re-split their edges.
 * Since `buildPlots` subdivides PER EDGE — `n = round(acc/cfg.w)` — moving one
 * endpoint re-phases every lot along the whole edge. Gloucester Street was
 * neither clipped nor replaced and still lost 81 parcels 157 m out. Factual
 * geometry is now clipped to the core.
 *
 * ## 3. Hand-authored streets were cut at the bbox line, not at a junction
 *
 * An edge is delimited by junctions. Cutting a street anywhere else shortens the
 * edge that continues outward, so its lots re-phase too. Cuts now land on the
 * nearest BASELINE junction outside the core — the seam anchor — so every edge
 * beyond it keeps both endpoints exactly and regenerates bit-identically.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo, unGeo } from '../../src/core/Geo.js';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const FIX = JSON.parse(readFileSync(new URL('../gis-stage1e/backbay-roads.json', import.meta.url), 'utf8'));
const r7 = (v) => Math.round(v * 1e7) / 1e7;
const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const PER_VERTEX = ['median', 'y', 'bridge'];

/* ---- baseline junctions: the only legal places to cut -------------------- */
globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const baseline = buildCurrentWorld();
const junctions = baseline.net.nodes.filter((n) => n && (n.edges?.length ?? 0) >= 3 && !inCore(n));

/* ---- 1. semantic mapping (unchanged from Stage 2A) ----------------------- */
function normName(s) {
  return (s || '').toLowerCase().replace(/\bno\.?\s+/g, '')
    .replace(/\b(street|st)\b/g, 'st').replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd').replace(/\b(square|sq)\b/g, 'sq')
    .replace(/\b(plaza|plz)\b/g, 'plz').replace(/\b(turnpike|tpke)\b/g, 'tpke')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
const bostonByName = new Map();
for (const s of STREETS) {
  const k = normName(s.name);
  if (!bostonByName.has(k)) bostonByName.set(k, []);
  bostonByName.get(k).push(s);
}
const bostonWorld = new Map(STREETS.map((s) => [s, s.path.map(([la, lo]) => geo(la, lo))]));
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
/** Unit direction of travel along a Boston street, honouring its `oneway` sign. */
function flowDir(st) {
  const w = bostonWorld.get(st);
  const a = w[0], b = w[w.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  const sgn = st.oneway < 0 ? -1 : 1;
  return { x: (dx / L) * sgn, z: (dz / L) * sgn };
}
/**
 * Which Boston road concept does this factual line belong to?
 *
 * Name first; then DIRECTION for a one-way pair, and only then proximity.
 *
 * Proximity alone is wrong for a divided boulevard and was wrong here. Boston's
 * two Commonwealth carriageways sit +/-23 m off the centre while the factual
 * pair sits ~20 m off, so the factual EASTBOUND carriageway came out nearer to
 * Boston's WESTBOUND "Outbound" line. The connector then joined two one-way
 * streets head to head: junction 36 became a sink that could reach 2 nodes out
 * of 428, and the north/south route died. Flow direction is the discriminator a
 * divided boulevard actually has.
 */
function pickConcept(name, pts) {
  const k = normName(name);
  const cands = [];
  for (const [bk, bl] of bostonByName) if (bk === k || bk.startsWith(k + ' ') || k.startsWith(bk + ' ')) cands.push(...bl);
  if (!cands.length) return null;
  if (cands.length === 1) return cands;
  const m = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length };
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  const dir = { x: dx / L, z: dz / L };
  const oneways = cands.filter((c) => c.oneway);
  if (oneways.length > 1) {
    return oneways.map((c) => {
      const f = flowDir(c);
      return { c, align: dir.x * f.x + dir.z * f.z, d: distToStreet(m, c) };
    }).sort((x, y) => y.align - x.align || x.d - y.d || (x.c.name < y.c.name ? -1 : 1)).map((v) => v.c)
      .concat(cands.filter((c) => !c.oneway));
  }
  return cands.map((c) => ({ c, d: distToStreet(m, c) }))
    .sort((x, y) => x.d - y.d || (x.c.name < y.c.name ? -1 : 1)).map((v) => v.c);
}

/* ---- 2. the factual population, CLIPPED TO THE CORE ---------------------- */
const isSurface = (f) => (f.zlev?.[0] ?? 0) >= 0 && (f.zlev?.[1] ?? 0) >= 0 && f.cfcc !== 'A71';
/** Split a polyline into the runs that lie inside the core, cutting on the boundary. */
function clipToCore(pts) {
  const runs = [];
  let cur = [];
  const cut = (a, b) => {                       // parametric crossing of the box edge
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * m, z: a.z + (b.z - a.z) * m };
      if (inCore(p) === inCore(a)) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inCore(p)) {
      if (i > 0 && !inCore(pts[i - 1])) cur.push(cut(pts[i - 1], p));
      cur.push(p);
    } else {
      if (i > 0 && inCore(pts[i - 1])) { cur.push(cut(pts[i - 1], p)); if (cur.length >= 2) runs.push(cur); cur = []; }
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

const surface = FIX.features.filter(isSurface).sort((a, b) => a.segmentId - b.segmentId);
const excluded = FIX.features.filter((f) => !isSurface(f))
  .map((f) => ({ segmentId: f.segmentId, name: f.name || null, zlev: f.zlev, cfcc: f.cfcc,
                 reason: f.cfcc === 'A71' ? 'walkway/plaza (CFCC A71)' : 'grade-separated (ZLEV < 0)' }));

const emitted = [], mapping = [];
let clippedFactualRuns = 0;
for (const f of surface) {
  for (const raw of f.paths) {
    const full = raw.map(([x, z]) => ({ x, z }));
    for (const pts of clipToCore(full)) {
      clippedFactualRuns++;
      const list = pickConcept(f.name, pts);
      const concept = list ? list[0] : null;
      const fallback = f.cfcc === 'A73' ? { type: 'alley', lanes: 1 }
        : f.cfcc === 'A25' || f.cfcc === 'A31' ? { type: 'arterial', lanes: 4 } : { type: 'street', lanes: 2 };
      emitted.push({
        samSegmentId: f.segmentId, samName: f.name, samCfcc: f.cfcc, samZlev: f.zlev,
        name: concept ? concept.name : f.name,
        type: concept ? concept.type : fallback.type,
        lanes: concept ? concept.lanes : fallback.lanes,
        // One-way is Boston's call, not SAM's. SAM marks essentially every
        // Back Bay segment `ONEWAY: FT`, which is its digitisation sense rather
        // than a blanket restriction; consuming it literally made Boylston,
        // Dartmouth, Huntington, Blagden and Ring Road one-way and broke both
        // the north/south and the Commonwealth routes outright. So the
        // RESTRICTION comes from Boston's own concept — preserving current
        // gameplay traffic rules, as the brief prefers — and SAM supplies only
        // the DIRECTION relative to the factual path's own vertex order, which
        // Boston's flag cannot express because it refers to Boston's path.
        oneway: concept?.oneway ? (f.oneway === 'TF' ? -1 : 1) : 0,
        mall: concept?.mall ?? false, surfaceKind: concept?.surface,
        path: pts.map((p) => { const g = unGeo(p.x, p.z); return [r7(g.lat), r7(g.lon)]; }),
      });
      mapping.push({ sam: f.name, boston: concept ? concept.name : '(none)', type: emitted[emitted.length - 1].type,
                     lanes: emitted[emitted.length - 1].lanes, source: concept ? 'boston-concept' : 'source-class-fallback' });
    }
  }
}

/* ---- 3. cut the hand-authored streets AT JUNCTION ANCHORS ---------------- */
/** Nearest baseline junction outside the core to a world point. */
function anchorFor(p) {
  let best = null;
  for (const n of junctions) {
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (!best || d < best.d) best = { d, n };
  }
  return best;
}
const clipped = [];
const anchors = [];
let maxSeamM = 0;
for (let si = 0; si < STREETS.length; si++) {
  const s = STREETS[si];
  const w = s.path.map(([la, lo]) => geo(la, lo));
  if (!w.some(inCore)) continue;
  // Outside runs, cut EXACTLY on the core boundary.
  //
  // Vertex-granularity clipping was the Stage 2A.1 first-attempt bug: Back Bay
  // streets are authored with vertices ~195 m apart, so dropping whole segments
  // that merely touch the core deleted up to 195 m of road beyond it — and with
  // it the crossings that split the cross streets. Gloucester Street collapsed
  // from 11 edges to 8, one of them 207 m long, and every lot on it re-phased.
  // An interpolated boundary vertex keeps the outside geometry exact.
  const runs = [];
  let cur = [];
  const boundary = (ai, bi) => {                 // parametric core-boundary crossing
    const a = w[ai], b = w[bi];
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * m, z: a.z + (b.z - a.z) * m };
      if (inCore(p) === inCore(a)) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    const ll = unGeo(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    // The boundary vertex inherits the OUTSIDE vertex's per-vertex values, so
    // the span it closes keeps exactly the attributes it had.
    return { ll: [r7(ll.lat), r7(ll.lon)], from: inCore(a) ? bi : ai };
  };
  for (let i = 0; i < w.length; i++) {
    if (!inCore(w[i])) {
      if (i > 0 && inCore(w[i - 1])) cur.push(boundary(i - 1, i));
      cur.push({ idx: i });
    } else if (i > 0 && !inCore(w[i - 1])) {
      cur.push(boundary(i - 1, i));
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  const kept = [];
  for (const run of runs) {
    // The end of this run that faces the core is the one to pull back.
    const endIdx = (v) => (v.idx !== undefined ? v.idx : null);
    const innerV = endIdx(run[0]) === 0 ? run[run.length - 1] : run[0];
    const innerPt = innerV.idx !== undefined ? w[innerV.idx] : geo(innerV.ll[0], innerV.ll[1]);
    const a = anchorFor(innerPt);
    if (a) {
      anchors.push({ street: s.name, at: { x: r2(innerPt.x), z: r2(innerPt.z) },
                     anchor: { x: r2(a.n.x), z: r2(a.n.z) }, distM: r2(a.d),
                     beyondCoreM: r2(Math.hypot(Math.max(CORE.x0 - a.n.x, 0, a.n.x - CORE.x1),
                                                Math.max(CORE.z0 - a.n.z, 0, a.n.z - CORE.z1))) });
      maxSeamM = Math.max(maxSeamM, anchors[anchors.length - 1].beyondCoreM);
    }
    // Keep the run's vertices, carrying the matching slice of every per-vertex
    // array. An interpolated boundary vertex takes its values from the outside
    // vertex it was derived from.
    if (run.length >= 2) kept.push(run.slice());
  }
  clipped.push({
    name: s.name, index: si,
    runs: kept.map((run) => ({
      path: run.map((v) => (v.idx !== undefined ? s.path[v.idx] : v.ll)),
      ...Object.fromEntries(PER_VERTEX.filter((p) => Array.isArray(s[p]))
        .map((p) => [p, run.map((v) => s[p][v.idx !== undefined ? v.idx : v.from])])),
    })),
  });
}

/* ---- 3b. TRANSITION CONNECTORS ------------------------------------------- */
/**
 * A factual street clipped at the core boundary ends in mid-air, and Boston's
 * own clipped stub begins a few metres away — a median 10.6 m, which is exactly
 * the registration offset Stage 1D measured. `RoadNetwork.build()`'s 21 m
 * endpoint snap bridges some of those gaps but not all, and a ONE-WAY street
 * that fails to bridge becomes a trap: the candidate's Commonwealth Avenue
 * Outbound flowed east out of the core and dead-ended, leaving its junction able
 * to reach three nodes out of 411 and killing the north/south route outright.
 *
 * So the joins are made explicit. A connector is SYNTHETIC — it is not SAM
 * geometry and is labelled `TRANSITION_CONNECTOR` — and it lives entirely in the
 * seam, between a factual port on the core boundary and the nearest Boston stub
 * end of the same road concept.
 */
const ports = [];
for (const e of emitted) {
  for (const idx of [0, e.path.length - 1]) {
    const g = geo(e.path[idx][0], e.path[idx][1]);
    // A port is an endpoint sitting on the core boundary, not an interior end.
    const onEdge = Math.min(Math.abs(g.x - CORE.x0), Math.abs(g.x - CORE.x1),
                            Math.abs(g.z - CORE.z0), Math.abs(g.z - CORE.z1));
    if (onEdge < 0.5) ports.push({ e, idx, g, ll: e.path[idx] });
  }
}
const connectors = [];
const connStats = { ports: ports.length, joined: 0, unjoined: 0, lengths: [] };
for (const port of ports) {
  let best = null;
  for (const c of clipped) {
    if (c.name !== port.e.name) continue;
    for (const run of c.runs) {
      for (const idx of [0, run.path.length - 1]) {
        const g = geo(run.path[idx][0], run.path[idx][1]);
        const d = Math.hypot(g.x - port.g.x, g.z - port.g.z);
        if (!best || d < best.d) best = { d, ll: run.path[idx] };
      }
    }
  }
  // Bound taken from the measured registration offset, not chosen: Stage 1E put
  // Boston a median 10.64 m and a p90 26.5 m from the factual lines, so 40 m
  // covers the distribution without letting a connector reach across a block.
  if (best && best.d <= 40 && best.d > 0.05) {
    connectors.push({ name: port.e.name, type: port.e.type, lanes: port.e.lanes,
      ...(port.e.oneway ? { oneway: port.e.oneway } : {}),
      transitionConnector: true, lengthM: r2(best.d),
      path: port.idx === 0 ? [best.ll, port.ll] : [port.ll, best.ll] });
    connStats.joined++; connStats.lengths.push(r2(best.d));
  } else connStats.unjoined++;
}
connStats.lengths.sort((a, b) => a - b);
connStats.maxLengthM = connStats.lengths.length ? connStats.lengths[connStats.lengths.length - 1] : 0;
connStats.medianLengthM = connStats.lengths.length ? connStats.lengths[Math.floor(connStats.lengths.length / 2)] : 0;

/* ---- 4. emit ------------------------------------------------------------- */
const header = `/**
 * Back Bay factual road centrelines — GENERATED, do not hand-edit.
 *
 *   node research/gis-stage2a1/build-candidate.mjs
 *
 * Stage 2A.1 prototype data. DEFAULT OFF: nothing imports this unless
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
 * SEMANTICS. Addressing / routing centrelines, not surveyed pavement centrelines,
 * and SAM carries no authoritative width. Only centreline geometry, street
 * identity, ZLEV and one-way sense are factual. Width, lanes, class, footway,
 * kerb and parking stay procedural, inherited from Boston's own entry for the
 * street of that name.
 *
 * CONTAINMENT (Stage 2A.1). Factual geometry is CLIPPED TO THE CORE so it cannot
 * create junctions outside it, and Boston's own streets are cut at the nearest
 * baseline junction beyond the core — never mid-edge — so every edge outside the
 * seam keeps both endpoints and regenerates bit-identically. Clipped streets
 * carry the matching slice of every per-vertex array (\`median\`, \`y\`, \`bridge\`);
 * Stage 2A kept them whole, which misaligned Huntington's median and caused the
 * \`nuniv\` station section to be refused.
 *
 * EXCLUSIONS. Grade-separated features are dropped, not flattened: the Turnpike
 * runs under Back Bay at ZLEV -1 and its ramps at -2..0. \`Exeter PLZ\` is a
 * pedestrian plaza (CFCC A71).
 */
`;
const body = header +
  `export const GIS_ROADS_SOURCE = ${JSON.stringify({
    dataset: FIX.source.dataset, publisher: FIX.source.publisher, licence: 'ODC-PDDL-1.0',
    catalog: FIX.source.catalog, service: FIX.source.service, layer: FIX.source.layerName,
    retrieved: FIX.source.retrieved, rawSha256: FIX.source.rawSha256, semantics: FIX.source.semantics,
    core: { x0: r7(CORE.x0), x1: r7(CORE.x1), z0: r7(CORE.z0), z1: r7(CORE.z1) },
    surfaceFilter: FIX.surfaceFilter, excludedFeatures: excluded.length,
    containment: 'factual geometry clipped to the core; Boston streets cut at the nearest baseline junction beyond it',
    seamMaxBeyondCoreM: r2(maxSeamM),
  }, null, 1)};\n\n` +
  `/** Factual surface streets, clipped to the core, in the STREETS shape. */\n` +
  `export const GIS_ROADS = ${JSON.stringify(emitted.map((e) => ({
    name: e.name, type: e.type, lanes: e.lanes,
    ...(e.oneway ? { oneway: e.oneway } : {}), ...(e.mall ? { mall: true } : {}),
    ...(e.surfaceKind ? { surface: e.surfaceKind } : {}),
    path: e.path,
    sam: { segmentId: e.samSegmentId, name: e.samName, cfcc: e.samCfcc, zlev: e.samZlev },
  })), null, 1)};\n\n` +
  `/** Boston streets, clipped to the parts outside the core, per-vertex arrays sliced to match. */\n` +
  `export const GIS_ROADS_CLIPPED = ${JSON.stringify(clipped, null, 1)};\n\n` +
  `/** SYNTHETIC seam joins. NOT factual SAM geometry; they exist only in the transition seam. */\n` +
  `export const GIS_ROADS_CONNECTORS = ${JSON.stringify(connectors, null, 1)};\n`;

writeFileSync(new URL('../../src/data/gis-backbay-roads.js', import.meta.url), body);
const outHash = createHash('sha256').update(body).digest('hex');
const manifest = {
  schemaVersion: 'boston-gis-stage2a1/candidate/0.2.0', source: { ...FIX.source }, core: CORE,
  emittedStreets: emitted.length, clippedFactualRuns, excludedFeatures: excluded,
  connectors: connStats,
  clippedStreets: clipped.map((c) => ({ name: c.name, runs: c.runs.length,
    perVertexArrays: PER_VERTEX.filter((p) => c.runs.some((r) => Array.isArray(r[p]))) })),
  seamAnchors: anchors, seamMaxBeyondCoreM: r2(maxSeamM), mapping,
  outputBytes: body.length, outputSha256: outHash,
};
writeFileSync(new URL('./candidate-manifest.json', import.meta.url), JSON.stringify(manifest, null, 1) + '\n');
console.log(`factual: ${emitted.length} entries from ${surface.length} surface features (${clippedFactualRuns} core-clipped runs)`);
console.log(`clipped: ${clipped.length} Boston streets; per-vertex arrays carried on ${clipped.filter((c) => c.runs.some((r) => PER_VERTEX.some((p) => Array.isArray(r[p])))).map((c) => c.name).join(', ') || 'none'}`);
console.log(`seam anchors: ${anchors.length}, furthest ${r2(maxSeamM)} m beyond the core`);
console.log(`connectors: ${connStats.joined} of ${connStats.ports} ports joined (${connStats.unjoined} left open), median ${connStats.medianLengthM} m, max ${connStats.maxLengthM} m`);
console.log(`src/data/gis-backbay-roads.js  ${body.length} bytes  sha256 ${outHash.slice(0, 16)}`);
