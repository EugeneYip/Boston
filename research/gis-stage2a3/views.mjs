/**
 * Stage 2A.3 — reuse the Stage 2A.1 camera-fair set, re-verified.
 *
 *   node research/gis-stage2a3/views.mjs
 *
 * The cameras are NOT re-derived. They are fixed world positions chosen without
 * reference to either candidate, and reusing them unchanged is what makes the
 * pairs comparable across stages. What is re-verified is that each still stands
 * in open air in BOTH worlds with this stage's geometry — vertical clearance
 * above anything whose footprint contains it, 4 m margin.
 */
import { writeFileSync, readFileSync } from 'node:fs';
const prev = JSON.parse(readFileSync(new URL('../gis-stage2a2/captures.json', import.meta.url), 'utf8'));
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const C = await build(null, 'v1'), K = await build('?gisRoads=1', 'v2');
const inRing = (px, pz, r) => { let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) && (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c; };
const CLEAR_M = 4;
const clear = (b, [x, y, z]) => !b.specs.some((s) =>
  Math.hypot(s.cx - x, s.cz - z) <= (s.radius ?? 25) && inRing(x, z, s.poly) && y < s.base + s.h + CLEAR_M);
const views = prev.views.map((v) => ({ ...v, clearControl: clear(C.b, v.pos), clearCandidate: clear(K.b, v.pos) }));
for (const v of views) console.log(`${v.clearControl && v.clearCandidate ? ' ok  ' : 'FAIL '} ${v.id.padEnd(26)} control ${v.clearControl} candidate ${v.clearCandidate}`);
const bad = views.filter((v) => !(v.clearControl && v.clearCandidate));
console.log(bad.length ? `\n${bad.length} camera(s) no longer fair` : `\nall ${views.length} cameras still stand in open air in both worlds`);
writeFileSync(new URL('./views.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a3/views/0.1.0', canvas: prev.canvas, common: prev.common,
    method: 'Stage 2A.1 camera-fair set reused unchanged; re-verified clear in both worlds with Stage 2A.3 geometry.',
    views }, null, 1) + '\n');
