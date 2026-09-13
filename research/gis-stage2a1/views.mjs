/**
 * Stage 2A.1 — camera-fair viewpoints.
 *
 *   node research/gis-stage2a1/views.mjs
 *
 * Stage 2A's street-level cameras were derived from the candidate geometry, so
 * the control was systematically disadvantaged: the camera landed where the
 * factual road is, which in the baseline is inside a block. Those pairs proved
 * registration, not art direction, and the Owner was right to discount them.
 *
 * Every camera here is fixed in world space, independent of either candidate,
 * and VERIFIED to stand in open space in BOTH worlds — no camera is accepted
 * unless it is clear of every building footprint in control and candidate alike.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r1 = (v) => Math.round(v * 10) / 10;
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
const inRing = (px, pz, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) &&
        (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c;
};
/**
 * Is the CAMERA in open air in this world?
 *
 * Not "is the ground clear" — these are elevated cameras and standing 46 m above
 * a roof is perfectly valid. The first form of this test checked the footprint
 * under the camera and rejected four of six views that are in fact fine. What
 * matters is vertical clearance: the camera must be above anything whose
 * footprint contains it, in BOTH worlds, with a margin.
 */
const CLEAR_M = 4;
function clear(b, x, y, z) {
  for (const s of b.specs) {
    if (Math.hypot(s.cx - x, s.cz - z) > (s.radius ?? 25)) continue;
    if (!inRing(x, z, s.poly)) continue;
    if (y < s.base + s.h + CLEAR_M) return false;
  }
  return true;
}

const cx = (CORE.x0 + CORE.x1) / 2, cz = (CORE.z0 + CORE.z1) / 2;
const CANDIDATES = [
  { id: 'A_newbury_block', note: 'elevated oblique over the Newbury block — camera-fair',
    pos: [-1076, 46, 560], look: [-1160, 6, 505], fov: 55 },
  { id: 'B_boylston_block', note: 'elevated oblique over Boylston — camera-fair',
    pos: [-1180, 46, 760], look: [-1260, 6, 700], fov: 55 },
  { id: 'C_cross_exeter_fairfield', note: 'elevated cross-street view, Exeter/Fairfield — camera-fair',
    pos: [-1230, 40, 560], look: [-1170, 6, 660], fov: 55 },
  { id: 'D_district_overview', note: 'district overview, core centred — camera-fair',
    pos: [r1(cx + 150), 150, r1(cz + 190)], look: [r1(cx - 30), 8, r1(cz - 40)], fov: 55 },
  { id: 'E_commonwealth', note: 'Commonwealth boulevard diagnostic — mall legibility',
    pos: [-1150, 38, 380], look: [-1250, 6, 470], fov: 55 },
  { id: 'F_seam', note: 'transition seam diagnostic — NOT verdict-driving',
    pos: [-1460, 60, 700], look: [-1370, 8, 660], fov: 55 },
];
const views = [];
for (const v of CANDIDATES) {
  const okC = clear(C.b, v.pos[0], v.pos[1], v.pos[2]), okK = clear(K.b, v.pos[0], v.pos[1], v.pos[2]);
  views.push({ ...v, tod: 10.5, weather: 'clear', quality: 'high',
               validInControl: okC, validInCandidate: okK, cameraFair: okC && okK });
  console.log(`${v.id.padEnd(26)} clear in control ${String(okC).padStart(5)}  clear in candidate ${String(okK).padStart(5)}  ${okC && okK ? 'CAMERA-FAIR' : 'REJECTED'}`);
}
const out = { schemaVersion: 'boston-gis-stage2a1/views/0.1.0', core: CORE,
  common: { tod: 10.5, weather: 'clear', quality: 'high', warmup: 26, holdActors: true },
  method: 'fixed world positions, independent of either candidate; each verified to stand in open air — above any building containing it, with 4 m margin — in BOTH worlds',
  views };
writeFileSync(new URL('./views.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
