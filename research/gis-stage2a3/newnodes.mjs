/**
 * Stage 2A.3 — which junctions does the candidate create outside the seam?
 *
 *   node research/gis-stage2a3/newnodes.mjs
 *
 * A parcel moves when the EDGE carrying it is re-split, so the causal object is
 * a node, not a parcel. This lists every candidate node with no control node
 * within tolerance, outside the declared seam, with the streets meeting there.
 */
import { readFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
const r2 = (v) => Math.round(v * 100) / 100;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const man = JSON.parse(readFileSync(new URL('./candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  return buildCurrentWorld();
}
const C = await build(null, 'n1'), K = await build('?gisRoads=1', 'n2');
const names = (w, n) => [...new Set((n.edges || []).map((ei) => w.net.edges[ei]?.name).filter(Boolean))].sort();
const cn = C.net.nodes.filter(Boolean);
const gained = [];
for (const n of K.net.nodes.filter(Boolean)) {
  if (distOut(n) <= SEAM + 0.01) continue;
  if (cn.some((o) => Math.hypot(o.x - n.x, o.z - n.z) <= 0.5)) continue;
  gained.push({ x: r2(n.x), z: r2(n.z), beyondM: r2(distOut(n)), deg: (n.edges || []).length, streets: names(K, n) });
}
const lost = [];
for (const n of cn) {
  if (distOut(n) <= SEAM + 0.01) continue;
  if (K.net.nodes.filter(Boolean).some((o) => Math.hypot(o.x - n.x, o.z - n.z) <= 0.5)) continue;
  lost.push({ x: r2(n.x), z: r2(n.z), beyondM: r2(distOut(n)), deg: (n.edges || []).length, streets: names(C, n) });
}
console.log(`seam ${SEAM} m — nodes gained beyond it: ${gained.length}, lost: ${lost.length}`);
for (const g of gained.sort((a, b) => a.beyondM - b.beyondM)) console.log(`  GAIN +${String(g.beyondM).padStart(7)} m  deg${g.deg}  (${g.x}, ${g.z})  ${g.streets.join(' x ')}`);
for (const g of lost.sort((a, b) => a.beyondM - b.beyondM)) console.log(`  LOST +${String(g.beyondM).padStart(7)} m  deg${g.deg}  (${g.x}, ${g.z})  ${g.streets.join(' x ')}`);
