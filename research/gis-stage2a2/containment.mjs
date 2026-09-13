/**
 * Stage 2A.2 — containment measurement against the frozen seam.
 *
 *   node research/gis-stage2a2/containment.mjs
 *
 * The seam is declared BEFORE this runs: it is the set of lot-grid cuts emitted
 * by the generator, and its extent is the furthest of those cuts from the core.
 * Nothing here chooses a boundary to make a number look good.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
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
const man = JSON.parse(readFileSync(new URL('./candidate-manifest.json', import.meta.url), 'utf8'));
/** FROZEN seam extent: the furthest lot-grid cut from the core, declared by the generator. */
const SEAM = Math.max(...man.lotCuts.map((c) => distOut(c.point)));

const C = await build(null, 'c'), K = await build('?gisRoads=1', 'k');

/* geometry keys — an id change is not a geometry change */
const pkey = (p) => `${p.frontage.a.x.toFixed(3)}_${p.frontage.a.z.toFixed(3)}_${p.width.toFixed(3)}_${p.depth.toFixed(3)}`;
// Spec key is GEOMETRY only. Height comes from `makeSpec` via a seed derived
// from `plot.id`, and plot ids are reassigned by distance from the centre, so
// adding a single parcel in Back Bay re-seeds the whole city. Including `h`
// measured id churn, not movement: 12,596 "changes" against 784 real ones.
const skey = (s) => `${s.cx.toFixed(3)}_${s.cz.toFixed(3)}_${s.poly.length}`;
const ekey = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z);
  return `${e.name}|${e.pts[0].x.toFixed(2)},${e.pts[0].z.toFixed(2)}|${e.pts[e.pts.length - 1].x.toFixed(2)},${e.pts[e.pts.length - 1].z.toFixed(2)}|${L.toFixed(2)}`; };

/**
 * Matched by DISPLACEMENT, not by an exact key.
 *
 * Cut points are stored as lat/lon at 7 decimals — Boston's convention, so that
 * nothing downstream invents world coordinates — which costs about a centimetre
 * on the round trip. An exact-millimetre key called every outside parcel
 * "changed" even where the edge had been restored to the identical whole number
 * of baseline lots. TOL is set an order of magnitude above that storage
 * precision and three orders below a lot width, so it cannot hide movement:
 * the smallest thing that matters here is a lot re-phasing by metres.
 */
const TOL = 0.05;
function diff(cArr, kArr, pos, sig) {
  const grid = new Map();
  const key = (p) => `${Math.round(p.x / 1)}_${Math.round(p.z / 1)}`;
  for (const v of kArr) {
    const p = pos(v);
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const k = `${Math.round(p.x) + dx}_${Math.round(p.z) + dz}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(v);
    }
  }
  const unmatched = [];
  for (const v of cArr) {
    const p = pos(v);
    const near = grid.get(key(p)) || [];
    const hit = near.some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v));
    if (!hit) unmatched.push(v);
  }
  // and the reverse, so a gained parcel counts too
  const cgrid = new Map();
  for (const v of cArr) {
    const p = pos(v);
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const k = `${Math.round(p.x) + dx}_${Math.round(p.z) + dz}`;
      if (!cgrid.has(k)) cgrid.set(k, []);
      cgrid.get(k).push(v);
    }
  }
  for (const v of kArr) {
    const p = pos(v);
    const near = cgrid.get(key(p)) || [];
    if (!near.some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v))) unmatched.push(v);
  }
  const outside = unmatched.map((v) => distOut(pos(v))).filter((d) => d > 0).sort((x, y) => x - y);
  return { changed: unmatched.length, outsideCore: outside.length,
           beyondSeam: outside.filter((d) => d > SEAM + 0.01).length,
           medianM: r2(outside[Math.floor(outside.length / 2)]), maxM: r2(outside[outside.length - 1] ?? 0) };
}
const elen = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
const roads = diff(C.world.net.edges, K.world.net.edges, (e) => e.pts[0], (e) => `${e.name}|${elen(e).toFixed(1)}`);
const plots = diff(C.b.plots.filter((p) => p.frontage), K.b.plots.filter((p) => p.frontage),
                   (p) => p.frontage.a, (p) => `${p.width.toFixed(1)}_${p.depth.toFixed(1)}`);
const specs = diff(C.b.specs, K.b.specs, (s) => ({ x: s.cx, z: s.cz }), (s) => String(s.poly.length));

/* identity-only churn: same geometry, different plot id */
const cGeo = new Map(C.b.plots.filter((p) => p.frontage).map((p) => [pkey(p), p.id]));
const kGeo = new Map(K.b.plots.filter((p) => p.frontage).map((p) => [pkey(p), p.id]));
let idChurn = 0;
for (const [k, id] of cGeo) if (kGeo.has(k) && kGeo.get(k) !== id) idChurn++;

const out = { schemaVersion: 'boston-gis-stage2a2/containment/0.1.0',
  frozenSeamM: r2(SEAM), lotCuts: man.lotCuts.length,
  lotCutOffsetM: { min: r2(Math.min(...man.lotCuts.map((c) => c.offsetFromCrossingM))),
                   max: r2(Math.max(...man.lotCuts.map((c) => c.offsetFromCrossingM))) },
  roads, plots, specs, identityOnlyChurn: idChurn };
console.log(`FROZEN seam extent (furthest lot-grid cut beyond the core): ${r2(SEAM)} m   [${man.lotCuts.length} cuts]`);
console.log(`\n                changed   outsideCore   BEYOND SEAM   median   max`);
for (const [n, d] of [['road edges', roads], ['parcels', plots], ['building specs', specs]])
  console.log(`  ${n.padEnd(15)} ${String(d.changed).padStart(6)} ${String(d.outsideCore).padStart(13)} ${String(d.beyondSeam).padStart(13)} ${String(d.medianM).padStart(8)} ${String(d.maxM).padStart(7)}`);
console.log(`\nidentity-only churn (same geometry, different plot id): ${idChurn}`);
writeFileSync(new URL('./containment.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
