/**
 * Stage 1B.1 — derive the fixed viewpoints FROM the accepted geometry.
 *
 *   node research/gis-stage1b1/views.mjs
 *
 * Stage 1B reused viewpoints chosen before the replacements were known and two
 * of them contained no factual content at all. Here the cameras are computed
 * from the run that was actually accepted: the street side comes from the
 * donor parcel's own outward vector (`polygon[3] - polygon[0]`, which is how
 * `RoadNetwork` builds a lot), so a camera cannot end up behind the block.
 */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { runGate } from './run.mjs';
import { GATE } from '../../src/world/GisBackBay.js';

const world = buildCurrentWorld();
const { r, parcels } = runGate(world, GATE);
const byId = new Map(parcels.map((p) => [p.id, p]));

// The accepted set, ordered along the street.
const acc = r.ledger.replaced.map((x) => ({ ...x, plot: byId.get(x.donorPlotId) }))
  .sort((a, b) => b.cx - a.cx);
const runs = [];
for (const a of acc) {
  const last = runs[runs.length - 1];
  if (last && Math.hypot(a.cx - last[last.length - 1].cx, a.cz - last[last.length - 1].cz) < 14) last.push(a);
  else runs.push([a]);
}
runs.sort((p, q) => q.length - p.length);

/** Outward = away from the street, straight from the parcel's own construction. */
function outward(plot) {
  const ox = plot.polygon[3].x - plot.polygon[0].x, oz = plot.polygon[3].z - plot.polygon[0].z;
  const l = Math.hypot(ox, oz) || 1;
  return { x: ox / l, z: oz / l };
}
const mid = (run) => ({ x: run.reduce((s, a) => s + a.cx, 0) / run.length, z: run.reduce((s, a) => s + a.cz, 0) / run.length });

function views() {
  const out = [];
  const R0 = runs[0], R1 = runs[1];
  const m0 = mid(R0), o0 = outward(R0[Math.floor(R0.length / 2)].plot);
  // A — perpendicular, stand in the street and look straight at the run.
  out.push({ id: 'A_newbury_run5', note: `${R0.length}-building factual run, perpendicular`,
    pos: [r1(m0.x - o0.x * 26), 5.6, r1(m0.z - o0.z * 26)], look: [r1(m0.x), 8, r1(m0.z)], fov: 58 });
  // B — the second run, same treatment.
  const m1 = mid(R1), o1 = outward(R1[Math.floor(R1.length / 2)].plot);
  out.push({ id: 'B_newbury_run3', note: `${R1.length}-building factual run, perpendicular`,
    pos: [r1(m1.x - o1.x * 24), 5.6, r1(m1.z - o1.z * 24)], look: [r1(m1.x), 8, r1(m1.z)], fov: 58 });
  // C — oblique down the street, so setback and block rhythm read.
  const head = R0[0], tail = R0[R0.length - 1];
  const dx = tail.cx - head.cx, dz = tail.cz - head.cz, dl = Math.hypot(dx, dz) || 1;
  out.push({ id: 'C_newbury_oblique', note: 'along the run — setback, rhythm, streetwall line',
    pos: [r1(head.cx + (dx / dl) * -26 - o0.x * 13), 6.0, r1(head.cz + (dz / dl) * -26 - o0.z * 13)],
    look: [r1(tail.cx), 9, r1(tail.cz)], fov: 55 });
  // D — above the block.
  out.push({ id: 'D_block_overview', note: 'block as a whole — footprint and roofscape',
    pos: [r1(m0.x - o0.x * 62), 58, r1(m0.z - o0.z * 62)], look: [r1(m0.x + o0.x * 12), 8, r1(m0.z + o0.z * 12)], fov: 55 });
  return out;
}
const r1 = (v) => Math.round(v * 10) / 10;
const V = views();
const out = { schemaVersion: 'boston-gis-stage1b1/views/0.1.0', gate: GATE.version,
  tod: 10.5, weather: 'clear', quality: 'high', viewport: '800x450', warmup: 26, holdActors: true,
  runs: runs.map((R) => ({ n: R.length, ids: R.map((a) => a.id) })), views: V };
writeFileSync(new URL('./views.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`runs: ${runs.map((R) => R.length).join(' + ')}`);
for (const v of V) console.log(`${v.id.padEnd(20)} pos ${JSON.stringify(v.pos)} look ${JSON.stringify(v.look)} fov ${v.fov}  — ${v.note}`);
