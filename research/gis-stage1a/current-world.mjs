/**
 * Stage 1A — capture the CURRENT Boston world's Back Bay geometry, headlessly.
 *
 *   node research/gis-stage1a/current-world.mjs
 *
 * Runs the real production pipeline up to `RoadNetwork.buildPlots()` — the same
 * call `City.init()` makes — with NO renderer, NO canvas and NO WebGL. This is
 * possible because `RoadNetwork.js` imports zero THREE, and `Terrain.bake()` /
 * `stampRoads()` / `groundHeight()` and `Districts.bake()` touch THREE only for
 * module-scope scratch objects. Nothing here constructs a WebGLRenderer.
 *
 * Read-only: imports production modules, mutates nothing, writes only into
 * research/gis-stage1a/.
 */
import Terrain from '../../src/world/Terrain.js';
import RoadNetwork from '../../src/world/RoadNetwork.js';
import Districts from '../../src/world/Districts.js';
import { BBOX_WORLD, inBox } from './bbox.mjs';

export function buildCurrentWorld() {
  const terrain = new Terrain();
  terrain.bake();
  const net = new RoadNetwork(terrain);
  net.build();
  terrain.stampRoads(net);
  const districts = new Districts(terrain);
  districts.bake();
  net.buildSidewalks();
  const plots = net.buildPlots(
    (x, z) => districts.districtAt(x, z),
    (x, z) => districts.isReserved(x, z));
  return { terrain, net, districts, plots };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const { net, districts, plots } = buildCurrentWorld();
  const s = net.stats();
  const inArea = plots.filter(p => inBox(p.frontage.a.x, p.frontage.a.z));
  const edgesIn = net.edges.filter(e => e.pts.some(q => inBox(q.x, q.z)));
  const names = [...new Set(edgesIn.map(e => e.name).filter(Boolean))].sort();
  console.log(`[current] ${s.nodes} nodes / ${s.edges} edges / ${s.km} km citywide, ${plots.length} parcels, ${Date.now() - t0} ms`);
  console.log(`[bbox]    x [${BBOX_WORLD.x0.toFixed(1)}, ${BBOX_WORLD.x1.toFixed(1)}]  z [${BBOX_WORLD.z0.toFixed(1)}, ${BBOX_WORLD.z1.toFixed(1)}]`);
  console.log(`[in area] ${inArea.length} parcels, ${edgesIn.length} road edges, ${names.length} distinct street names`);
  console.log(`[streets] ${names.join(' | ')}`);
  const dz = {};
  for (const p of inArea) dz[p.district] = (dz[p.district] || 0) + 1;
  console.log('[district]', JSON.stringify(dz));
  const w = inArea.map(p => p.width).sort((a, b) => a - b);
  const d = inArea.map(p => p.depth).sort((a, b) => a - b);
  const q = (a, f) => a.length ? a[Math.floor((a.length - 1) * f)] : NaN;
  console.log(`[parcels] width  min ${q(w,0)?.toFixed(1)} median ${q(w,0.5)?.toFixed(1)} max ${q(w,1)?.toFixed(1)}`);
  console.log(`[parcels] depth  min ${q(d,0)?.toFixed(1)} median ${q(d,0.5)?.toFixed(1)} max ${q(d,1)?.toFixed(1)}`);
}
