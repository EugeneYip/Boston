/**
 * Stage 2A.3 — containment measurement against the FINAL SEAM.
 *
 *   node research/gis-stage2a3/containment.mjs
 *
 * The seam is declared by the GENERATOR, before this runs, as the furthest any
 * vertex it places outside the core reaches beyond it — over every lot-grid cut
 * AND every connector vertex. Nothing here picks a boundary to make a number
 * look good, and the gate is that seam, not "outside the core": a change 1 m
 * outside the core but inside the declared seam is contained; a change 7 m out
 * is not.
 *
 * Changes are also ATTRIBUTED to the street that caused them, so a residual is
 * a named cause rather than a count.
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
const SEAM = man.finalSeam.extentM;

const C = await build(null, 'c'), K = await build('?gisRoads=1', 'k');

/**
 * Which street does a point belong to? Used only to ATTRIBUTE a change, never
 * to decide whether it counts. Nearest control edge wins.
 */
function attribute(world, p) {
  let best = null;
  for (const e of world.net.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
      if (!best || d < best.d) best = { d, name: e.name };
    }
  }
  return best ? best.name : '(none)';
}

/** Geometry tolerance: see Stage 2A.2 — lat/lon at 7 dp costs about a centimetre. */
const TOL = 0.05;
function diff(cArr, kArr, pos, sig) {
  const build1 = (arr) => {
    const g = new Map();
    for (const v of arr) {
      const p = pos(v);
      for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
        const k = `${Math.round(p.x) + dx}_${Math.round(p.z) + dz}`;
        if (!g.has(k)) g.set(k, []); g.get(k).push(v);
      }
    }
    return g;
  };
  const key = (p) => `${Math.round(p.x)}_${Math.round(p.z)}`;
  const kg = build1(kArr), cg = build1(cArr);
  const unmatched = [];
  for (const v of cArr) {
    const p = pos(v);
    if (!(kg.get(key(p)) || []).some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v))) unmatched.push(v);
  }
  for (const v of kArr) {
    const p = pos(v);
    if (!(cg.get(key(p)) || []).some((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) <= TOL && sig(o) === sig(v))) unmatched.push(v);
  }
  const beyond = unmatched.filter((v) => distOut(pos(v)) > SEAM + 0.01);
  const by = {};
  for (const v of beyond) { const n = attribute(C.world, pos(v)); by[n] = (by[n] || 0) + 1; }
  const outside = unmatched.map((v) => distOut(pos(v))).filter((d) => d > 0).sort((x, y) => x - y);
  return { changed: unmatched.length, outsideCore: outside.length, beyondSeam: beyond.length,
           medianM: r2(outside[Math.floor(outside.length / 2)]), maxM: r2(outside[outside.length - 1] ?? 0),
           beyondSeamByStreet: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1])),
           beyondSeamMaxM: r2(Math.max(0, ...beyond.map((v) => distOut(pos(v))))) };
}
const elen = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
const roads = diff(C.world.net.edges, K.world.net.edges, (e) => e.pts[0], (e) => `${e.name}|${elen(e).toFixed(1)}`);
const plots = diff(C.b.plots.filter((p) => p.frontage), K.b.plots.filter((p) => p.frontage),
                   (p) => p.frontage.a, (p) => `${p.width.toFixed(1)}_${p.depth.toFixed(1)}`);
const specs = diff(C.b.specs, K.b.specs, (s) => ({ x: s.cx, z: s.cz }), (s) => String(s.poly.length));

const out = { schemaVersion: 'boston-gis-stage2a3/containment/0.1.0',
  finalSeam: man.finalSeam, roads, plots, specs };
console.log(`FINAL SEAM (declared by the generator): ${SEAM} m beyond the core, over ${man.finalSeam.vertices} generated vertices`);
console.log(`\n                 changed   outsideCore   BEYOND SEAM   maxOutM`);
for (const [n, d] of [['road edges', roads], ['parcels', plots], ['building specs', specs]]) {
  console.log(`  ${n.padEnd(15)} ${String(d.changed).padStart(7)} ${String(d.outsideCore).padStart(13)} ${String(d.beyondSeam).padStart(13)} ${String(d.maxM).padStart(9)}`);
  if (d.beyondSeam) console.log(`      by street: ${Object.entries(d.beyondSeamByStreet).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
writeFileSync(new URL('./containment.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
