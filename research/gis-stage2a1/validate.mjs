/**
 * Stage 2A.1 — containment, semantics and dependent-system invariants.
 *
 *   node research/gis-stage2a1/validate.mjs
 *
 * Complements `research/gis-stage2a/validate.mjs`, which still runs and still
 * passes; this adds the checks Stage 2A.1 exists to make.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { centroid } from '../../src/world/GisAssociate.js';
import { corridorHalf } from '../../src/world/RoadNetwork.js';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));

async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const C = await build(null, 'c'), K = await build('?gisRoads=1', 'k');
const { GIS_ROADS, GIS_ROADS_CONNECTORS, GIS_ROADS_SOURCE } = await import('../../src/data/gis-backbay-roads.js');
const FIX = JSON.parse(readFileSync(new URL('../gis-stage1e/backbay-roads.json', import.meta.url), 'utf8'));
const { geo } = await import('../../src/core/Geo.js');

/* -- frozen factual core: every emitted vertex must be a Stage 1E vertex ---- */
// Measured as a DISPLACEMENT, not an exact key match. The runtime module stores
// lat/lon at 7 decimals — Boston's own convention, so nothing downstream invents
// world coordinates — and the unGeo/geo round trip costs about a centimetre.
// An exact-string test called that "moved"; the real worst case is 6 mm.
const fixPts = [];
for (const f of FIX.features) for (const p of f.paths) for (const [x, z] of p) fixPts.push({ x, z });
let worstDisp = 0, onBoundary = 0, interior = 0;
for (const r of GIS_ROADS) for (const [la, lo] of r.path) {
  const g = geo(la, lo);
  const onEdge = Math.min(Math.abs(g.x - CORE.x0), Math.abs(g.x - CORE.x1), Math.abs(g.z - CORE.z0), Math.abs(g.z - CORE.z1));
  if (onEdge < 0.5) { onBoundary++; continue; }        // interpolated by the core clip
  interior++;
  let best = Infinity;
  for (const p of fixPts) { const d = Math.hypot(p.x - g.x, p.z - g.z); if (d < best) best = d; }
  if (best > worstDisp) worstDisp = best;
}
/* -- blast radius by region ------------------------------------------------ */
const pkey = (p) => `${p.frontage.a.x.toFixed(3)}_${p.frontage.a.z.toFixed(3)}_${p.width.toFixed(3)}_${p.depth.toFixed(3)}`;
const cP = new Set(C.b.plots.filter((p) => p.frontage).map(pkey));
const kP = new Set(K.b.plots.filter((p) => p.frontage).map(pkey));
const changed = [...C.b.plots.filter((p) => p.frontage && !kP.has(pkey(p))),
                 ...K.b.plots.filter((p) => p.frontage && !cP.has(pkey(p)))];
const outsideDists = changed.map((p) => distOut(p.frontage.a)).filter((d) => d > 0).sort((a, b) => a - b);
const SEAM = GIS_ROADS_SOURCE.seamMaxBeyondCoreM ?? 0;
const beyondSeam = outsideDists.filter((d) => d > SEAM).length;

/* -- Commonwealth ---------------------------------------------------------- */
function mallIntruders(world) {
  let n = 0;
  for (const p of world.plots) {
    const e = world.net.edges[p.edgeId];
    if (!e?.mall) continue;
    const ox = p.polygon[3].x - p.polygon[0].x, oz = p.polygon[3].z - p.polygon[0].z;
    const ol = Math.hypot(ox, oz) || 1;
    const mx = (p.frontage.a.x + p.frontage.b.x) / 2, mz = (p.frontage.a.z + p.frontage.b.z) / 2;
    for (const o of world.net.edges) {
      if (!o.mall || o.id === e.id) continue;
      for (let i = 1; i < o.pts.length; i++) {
        const a = o.pts[i - 1], b = o.pts[i];
        const ex = b.x - a.x, ez = b.z - a.z;
        const den = (ox / ol) * ez - (oz / ol) * ex;
        if (Math.abs(den) < 1e-12) continue;
        const qx = a.x - mx, qz = a.z - mz;
        const t = (qx * ez - qz * ex) / den, w = (qx * (oz / ol) - qz * (ox / ol)) / -den;
        if (w < 0 || w > 1 || t <= 0) continue;
        if (t < p.depth + corridorHalf(o) + 4) { n++; i = o.pts.length; break; }
      }
    }
  }
  return n;
}
/* -- Huntington / nuniv ---------------------------------------------------- */
const nunivEdge = (net) => {
  const mid = { x: (-1928.9 + -2028.4) / 2, z: (1678.9 + 1732.8) / 2 };
  return net.edges.filter((e) => e.name === 'Huntington Avenue').map((e) => {
    let best = Infinity;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((mid.x - a.x) * ex + (mid.z - a.z) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(mid.x - (a.x + ex * t), mid.z - (a.z + ez * t));
      if (d < best) best = d;
    }
    return { e, d: best };
  }).sort((a, b) => a.d - b.d)[0].e;
};
const cn = nunivEdge(C.world.net), kn = nunivEdge(K.world.net);
/* -- Northeastern ---------------------------------------------------------- */
const { NEU_HERO_PARTS } = await import('../../src/data/neu-hero.js');
let nb = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
for (const part of NEU_HERO_PARTS) for (const [x, z] of part.outline) {
  if (x < nb.x0) nb.x0 = x; if (x > nb.x1) nb.x1 = x; if (z < nb.z0) nb.z0 = z; if (z > nb.z1) nb.z1 = z;
}
const inNeu = (p) => p.x >= nb.x0 - 150 && p.x <= nb.x1 + 150 && p.z >= nb.z0 - 150 && p.z <= nb.z1 + 150;
const neuChanged = changed.filter((p) => inNeu(p.frontage.a)).length;

const checks = {
  'factual core is frozen: interior vertices within 5 cm of Stage 1E': worstDisp < 0.05,
  'clip introduced only core-boundary vertices': onBoundary > 0,
  'factual geometry does not overhang the core': GIS_ROADS.every((r) => r.path.every(([la, lo]) => {
    const g = geo(la, lo); return inCore(g) || distOut(g) < 0.5; })),
  'connectors are labelled and never claimed as factual':
    GIS_ROADS_CONNECTORS.every((c) => c.transitionConnector === true),
  'connectors are short': GIS_ROADS_CONNECTORS.every((c) => c.lengthM <= 40),
  'no parcel in a mall reservation, candidate': mallIntruders(K.world) === 0,
  'no parcel in a mall reservation, control (rule is a baseline no-op)': mallIntruders(C.world) === 0,
  'nuniv: candidate Huntington edge matches control lanes': cn.lanes === kn.lanes,
  'nuniv: candidate Huntington edge matches control median': cn.median === kn.median,
  'nuniv: the station section attaches in the candidate': (kn.sections?.length ?? 0) === (cn.sections?.length ?? 0),
  'Northeastern parcels unchanged': neuChanged === 0,
  'no Turnpike edge on the surface graph': K.world.net.edges.every((e) => e.name !== 'Massachusetts TPKE W'),
  'candidate parcels all finite': K.b.plots.every((p) => p.polygon.every((q) => Number.isFinite(q.x) && Number.isFinite(q.z))),
};
const failed = Object.entries(checks).filter(([, v]) => !v);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? ' ok ' : 'FAIL'}  ${k}`);
console.log(`\n${failed.length ? failed.length + ' FAILED' : 'all ' + Object.keys(checks).length + ' Stage 2A.1 invariants hold'}`);
console.log(`containment: ${changed.length} parcels changed, ${outsideDists.length} outside the core; ` +
  `median ${r2(outsideDists[Math.floor(outsideDists.length / 2)])} m, max ${r2(outsideDists[outsideDists.length - 1])} m`);
console.log(`declared seam (max junction anchor): ${SEAM} m -> parcels changed BEYOND the seam: ${beyondSeam}`);
console.log(`connectors: ${GIS_ROADS_CONNECTORS.length}, max ${r2(Math.max(0, ...GIS_ROADS_CONNECTORS.map((c) => c.lengthM)))} m`);

writeFileSync(new URL('./validate.json', import.meta.url), JSON.stringify({
  schemaVersion: 'boston-gis-stage2a1/validate/0.1.0', checks, failed: failed.map(([k]) => k), pass: failed.length === 0,
  containment: { parcelsChanged: changed.length, outsideCore: outsideDists.length,
    medianM: r2(outsideDists[Math.floor(outsideDists.length / 2)]), maxM: r2(outsideDists[outsideDists.length - 1]),
    declaredSeamM: SEAM, parcelsBeyondSeam: beyondSeam },
  connectors: { count: GIS_ROADS_CONNECTORS.length, maxM: r2(Math.max(0, ...GIS_ROADS_CONNECTORS.map((c) => c.lengthM))) },
  northeasternParcelsChanged: neuChanged,
  frozenCore: { interiorVertices: interior, boundaryInterpolated: onBoundary, worstDisplacementM: r2(worstDisp * 1000) / 1000 },
}, null, 1) + '\n');
