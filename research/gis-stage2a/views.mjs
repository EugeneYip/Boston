/**
 * Stage 2A — fixed viewpoints, derived from the CANDIDATE road geometry.
 *
 *   node research/gis-stage2a/views.mjs
 *
 * Cameras are placed on the factual carriageway and aimed along it, well inside
 * the core so the transition seam never enters a verdict-driving frame. The same
 * cameras are used for control and candidate — the roads move between them, and
 * that is the thing being judged.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

globalThis.location = { search: '?gisRoads=1' };
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const world = buildCurrentWorld();
const r1 = (v) => Math.round(v * 10) / 10;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const MARGIN = 45;   // stay this far inside the core: the seam must not be judged
const deepInCore = (p) => p.x >= CORE.x0 + MARGIN && p.x <= CORE.x1 - MARGIN &&
                          p.z >= CORE.z0 + MARGIN && p.z <= CORE.z1 - MARGIN;

/** The longest run of one named street that stays well inside the core. */
function spineOf(name) {
  let best = null;
  for (const e of world.net.edges) {
    if (e.name !== name) continue;
    const pts = e.pts.filter(deepInCore);
    if (pts.length < 2) continue;
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (!best || L > best.L) best = { L, pts, e };
  }
  return best;
}
/** Eye on the carriageway at `t` along the spine, looking along it. */
function alongView(id, name, t0, t1, eye, fov, note) {
  const s = spineOf(name);
  if (!s) return null;
  const at = (t) => s.pts[Math.max(0, Math.min(s.pts.length - 1, Math.round(t * (s.pts.length - 1))))];
  const a = at(t0), b = at(t1);
  return { id, street: name, note, fov, tod: 10.5, weather: 'clear', quality: 'high',
           pos: [r1(a.x), eye, r1(a.z)], look: [r1(b.x), eye + 2, r1(b.z)] };
}
const mid = (name) => { const s = spineOf(name); return s ? s.pts[Math.floor(s.pts.length / 2)] : null; };

const views = [];
views.push(alongView('A_newbury', 'Newbury Street', 0.12, 0.88, 5.6, 60, 'primary streetwall, along the factual carriageway'));
views.push(alongView('B_boylston', 'Boylston Street', 0.12, 0.88, 5.6, 60, 'second primary street'));
views.push(alongView('C_exeter', 'Exeter Street', 0.15, 0.85, 5.6, 60, 'cross street'));
// Elevated oblique over the Newbury block, and a district overview, both centred in the core.
const n = mid('Newbury Street');
if (n) views.push({ id: 'D_block_oblique', street: 'Newbury Street', note: 'elevated oblique over the block',
  fov: 55, tod: 10.5, weather: 'clear', quality: 'high',
  pos: [r1(n.x + 60), 44, r1(n.z + 60)], look: [r1(n.x - 20), 6, r1(n.z - 25)] });
const cx = (CORE.x0 + CORE.x1) / 2, cz = (CORE.z0 + CORE.z1) / 2;
views.push({ id: 'E_district_overview', street: '(core)', note: 'district overview, core centred',
  fov: 55, tod: 10.5, weather: 'clear', quality: 'high',
  pos: [r1(cx + 150), 150, r1(cz + 190)], look: [r1(cx - 30), 8, r1(cz - 40)] });
views.push(alongView('F_commave', 'Commonwealth Avenue Outbound', 0.15, 0.85, 5.6, 60,
  'divided-boulevard diagnostic — NOT verdict-driving'));

const out = { schemaVersion: 'boston-gis-stage2a/views/0.1.0', core: CORE, coreMarginM: MARGIN,
              common: { tod: 10.5, weather: 'clear', quality: 'high', warmup: 26, holdActors: true },
              views: views.filter(Boolean) };
writeFileSync(new URL('./views.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
for (const v of out.views) console.log(`${v.id.padEnd(22)} ${String(v.street).padEnd(30)} pos ${JSON.stringify(v.pos)} look ${JSON.stringify(v.look)} fov ${v.fov}`);
