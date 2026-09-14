/**
 * Stage 2A.4 — the derived-influence envelope, and what lies outside it.
 *
 *   node research/gis-stage2a4/envelope.mjs
 *
 * TWO NESTED REGIONS, as the Owner requires, and neither is a chosen radius.
 *
 * ROAD_GEOMETRY_SEAM — where candidate ROAD geometry itself differs. Declared by
 *   the generator as the furthest any vertex it places outside the core reaches
 *   beyond it, over every lot-grid cut and every connector vertex: 6.96 m.
 *
 * DERIVED_INFLUENCE_ENVELOPE — where Boston's own algorithms are ENTITLED to
 *   produce different geometry because they legitimately query roads that
 *   changed. It is the union of two sets, both read off `buildPlots`:
 *
 *   E1  the frontage of any edge whose geometry differs between the worlds.
 *       `buildPlots` subdivides per EDGE over the edge's whole length, so an
 *       edge that changed may legitimately re-lay every lot on itself. This is
 *       not a radius; it is an edge.
 *
 *   E2  everything within `cfg.depth * 2 + 12` of a changed road segment —
 *       the literal `lim` passed to `rayToRoad`, evaluated with the PARCEL'S OWN
 *       district, not a global maximum. backBay 80 m, southEnd 72 m.
 *
 * Outside E1 ∪ E2 the contract is absolute: no changed parcel, no changed spec.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const man = JSON.parse(readFileSync(new URL('../gis-stage2a3/candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
const TOL = 0.05;
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const RN = (await import('../../src/world/RoadNetwork.js')).default;
const C = await build(null, 'E1'), K = await build('?gisRoads=1', 'E2');

const elen = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
const ends = (e) => [e.pts[0], e.pts[e.pts.length - 1]];
const sameEdge = (a, b) => a.name === b.name && Math.abs(elen(a) - elen(b)) < TOL &&
  ends(a).every((q) => ends(b).some((r) => Math.hypot(q.x - r.x, q.z - r.z) < TOL));
const cChanged = C.world.net.edges.filter((e) => !K.world.net.edges.some((o) => sameEdge(e, o)));
const kChanged = K.world.net.edges.filter((e) => !C.world.net.edges.some((o) => sameEdge(e, o)));
const changedIds = { control: new Set(cChanged.map((e) => e.id)), candidate: new Set(kChanged.map((e) => e.id)) };
const segs = [];
for (const e of [...cChanged, ...kChanged]) for (let i = 1; i < e.pts.length; i++) segs.push([e.pts[i - 1], e.pts[i]]);
const dSeg = (p, a, b) => { const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
  let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t)); };
const toChanged = (p) => { let best = Infinity; for (const [a, b] of segs) { const d = dSeg(p, a, b); if (d < best) best = d; } return best; };
const rayLim = (district) => { const Z = RN.ZONING[district]; return Z ? Z.depth * 2 + 12 : 72; };

/** In the envelope? E1: the lot's own edge changed. E2: within its district's ray limit. */
function inEnvelope(item, side, district) {
  if (item.edgeId !== undefined && changedIds[side].has(item.edgeId)) return { in: true, via: 'E1' };
  const d = toChanged(item.pos);
  return d <= rayLim(district) + TOL ? { in: true, via: 'E2', d } : { in: false, via: null, d };
}

/* ---- parcels -------------------------------------------------------------- */
const cP = C.b.plots.filter((p) => p.frontage), kP = K.b.plots.filter((p) => p.frontage);
const sig = (p) => `${p.width.toFixed(1)}_${p.depth.toFixed(1)}`;
const index = (arr, pos) => { const m = new Map();
  for (const v of arr) { const q = pos(v);
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const k = `${Math.round(q.x) + dx}_${Math.round(q.z) + dz}`;
      if (!m.has(k)) m.set(k, []); m.get(k).push(v); } }
  return m; };
const pPos = (p) => p.frontage.a, sPos = (s) => ({ x: s.cx, z: s.cz });
const kPI = index(kP, pPos), cPI = index(cP, pPos);
const hit = (idx, q, pos, ok) => (idx.get(`${Math.round(q.x)}_${Math.round(q.z)}`) || [])
  .some((o) => Math.hypot(pos(o).x - q.x, pos(o).z - q.z) <= TOL && ok(o));

const changedParcels = [];
for (const p of cP) if (!hit(kPI, pPos(p), pPos, (o) => sig(o) === sig(p))) changedParcels.push({ p, side: 'control' });
for (const p of kP) if (!hit(cPI, pPos(p), pPos, (o) => sig(o) === sig(p))) changedParcels.push({ p, side: 'candidate' });

/* ---- specs (building GROUND geometry) ------------------------------------- */
/**
 * Spec GROUND geometry, seed-independent.
 *
 * The spec polygon is not a pure function of the plot: `makeSpec` jitters the
 * setback, bow and bays from a seed derived from `plot.id`, and plot ids are
 * reassigned by distance from the city centre, so adding one parcel in Back Bay
 * re-seeds thousands of buildings that never moved. Keying on the raw polygon
 * counted 13,136 "changes" against the 781 the position-and-footprint key finds.
 * This is the same key Stage 2A.2 and 2A.3 used, for the same reason: position
 * is matched separately, to the same 5 cm the parcel diff uses, and the
 * signature carries only the footprint vertex count.
 */
const ssig = (s) => String(s.poly.length);
const kSI = index(K.b.specs, sPos), cSI = index(C.b.specs, sPos);
const changedSpecs = [];
for (const s of C.b.specs) if (!hit(kSI, sPos(s), sPos, (o) => ssig(o) === ssig(s))) changedSpecs.push({ s, side: 'control' });
for (const s of K.b.specs) if (!hit(cSI, sPos(s), sPos, (o) => ssig(o) === ssig(s))) changedSpecs.push({ s, side: 'candidate' });

/* A spec has no edgeId; attribute it to the nearest plot of its own world. */
const plotAt = (world, s) => {
  const arr = world === 'control' ? cP : kP;
  let best = null;
  for (const p of arr) { const d = Math.hypot(p.frontage.a.x - s.cx, p.frontage.a.z - s.cz);
    if (!best || d < best.d) best = { d, p }; }
  return best && best.d < 60 ? best.p : null;
};

const outP = [], outS = [];
let maxParcelD = 0, maxSpecD = 0;
for (const { p, side } of changedParcels) {
  const r = inEnvelope({ edgeId: p.edgeId, pos: pPos(p) }, side, p.district);
  if (r.via === 'E2') maxParcelD = Math.max(maxParcelD, r.d);
  if (!r.in) outP.push({ side, x: r2(p.frontage.a.x), z: r2(p.frontage.a.z), d: r2(r.d), district: p.district, rayLim: rayLim(p.district) });
}
for (const { s, side } of changedSpecs) {
  const pl = plotAt(side, s);
  const r = inEnvelope({ edgeId: pl?.edgeId, pos: sPos(s) }, side, pl?.district ?? s.district);
  if (r.via === 'E2') maxSpecD = Math.max(maxSpecD, r.d);
  if (!r.in) outS.push({ side, x: r2(s.cx), z: r2(s.cz), d: r2(r.d), district: pl?.district ?? s.district });
}
const beyondSeamP = changedParcels.filter(({ p }) => distOut(pPos(p)) > SEAM + 0.01).length;
const beyondSeamS = changedSpecs.filter(({ s }) => distOut(sPos(s)) > SEAM + 0.01).length;
console.log(`ROAD_GEOMETRY_SEAM          ${SEAM} m outward, over ${man.finalSeam.vertices} generated vertices`);
console.log(`DERIVED_INFLUENCE_ENVELOPE  E1 = frontage of ${cChanged.length + kChanged.length} changed edges; E2 = rayToRoad limit per district (backBay 80 m, southEnd 72 m)\n`);
console.log(`changed parcels ${changedParcels.length} (${beyondSeamP} beyond the road seam)`);
console.log(`  OUTSIDE the derived envelope: ${outP.length}`);
console.log(`  furthest E2 influence: ${r2(maxParcelD)} m`);
console.log(`changed building specs ${changedSpecs.length} (${beyondSeamS} beyond the road seam)`);
console.log(`  OUTSIDE the derived envelope: ${outS.length}`);
console.log(`  furthest E2 influence: ${r2(maxSpecD)} m`);
for (const o of outP.slice(0, 10)) console.log(`   PARCEL OUT ${o.side} (${o.x},${o.z}) ${o.d} m from changed road, district ${o.district}, limit ${o.rayLim}`);
for (const o of outS.slice(0, 10)) console.log(`   SPEC   OUT ${o.side} (${o.x},${o.z}) ${o.d} m from changed road, district ${o.district}`);
writeFileSync(new URL('./envelope.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a4/envelope/0.1.0',
    roadGeometrySeamM: SEAM, changedEdges: cChanged.length + kChanged.length,
    rayLimitByDistrict: Object.fromEntries(Object.entries(RN.ZONING).filter(([, v]) => v).map(([k, v]) => [k, v.depth * 2 + 12])),
    parcels: { changed: changedParcels.length, beyondRoadSeam: beyondSeamP, outsideEnvelope: outP.length, maxE2InfluenceM: r2(maxParcelD), detail: outP },
    specs: { changed: changedSpecs.length, beyondRoadSeam: beyondSeamS, outsideEnvelope: outS.length, maxE2InfluenceM: r2(maxSpecD), detail: outS } }, null, 1) + '\n');
