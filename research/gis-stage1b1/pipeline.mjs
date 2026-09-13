/**
 * Stage 1B.1 — run Boston's REAL visual-building pipeline headlessly.
 *
 *   node research/gis-stage1b1/pipeline.mjs
 *
 * Stage 1B's `survives()` predicate was a surrogate: it replayed the corridor
 * clip and `makeSpec`'s footprint minimums, but not `_respec`, `_districtOf`,
 * `orientOutward` or `_fitOrnament` — and two candidates were rejected by the
 * stages it did not replay, after their parcels had already been suppressed.
 * That is the hole.
 *
 * The fix is not a better predicate. It is to stop predicting: `Buildings`
 * imports cleanly under Node (no WebGLRenderer is constructed at module scope,
 * and neither `_collectPlots` nor `_buildSpecs` touches the GPU), so the actual
 * production `_buildSpecs` can be executed here against the actual parcels
 * `RoadNetwork.buildPlots` publishes. No surrogate, no second implementation.
 *
 * Read-only with respect to the world: constructs, measures, writes nothing
 * outside research/gis-stage1b1/.
 */
import Buildings from '../../src/world/Buildings.js';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';

/** The `ctx` shape `_collectPlots` actually consumes: one `get('city')`. */
function mockCtx(city) { return { get: (k) => (k === 'city' ? city : null) }; }

/**
 * A `Buildings` instance with only the state the spec path reads, so nothing
 * allocates a renderer, a material or a mesh.
 */
export function makeBuilder(world) {
  const { terrain, net, districts, plots } = world;
  const city = {
    plots,
    groundHeight: (x, z) => terrain.groundHeight(x, z),
    districtAt: (x, z) => districts.districtAt(x, z),
    roads: net,
    net,
  };
  const b = Object.create(Buildings.prototype);
  b.chunks = new Map();
  b.specs = [];
  b.plots = [];
  b._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
  return { b, ctx: mockCtx(city), city };
}

export function runBaseline(world) {
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._buildSpecs(ctx);
  return b;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const world = buildCurrentWorld();
  const t1 = Date.now();
  const b = runBaseline(world);
  const t2 = Date.now();
  const { BBOX_WORLD } = await import('../gis-stage1a/bbox.mjs');
  const W = BBOX_WORLD;
  const inBox = (s) => s.cx >= W.x0 && s.cx <= W.x1 && s.cz >= W.z0 && s.cz <= W.z1;
  const box = b.specs.filter(inBox);
  const hist = {};
  for (const s of box) { const n = s.polygon?.length ?? 0; hist[n] = (hist[n] || 0) + 1; }
  console.log(`[world]  ${world.plots.length} parcels in ${t1 - t0} ms`);
  console.log(`[specs]  ${b.specs.length} citywide, ${b.plots.length} buildings plots, in ${t2 - t1} ms`);
  console.log(`[box]    ${box.length} specs   vertexHistogram ${JSON.stringify(hist)}`);
  console.log(`[clip]   ${JSON.stringify(b._clipStats)}`);
  console.log(`[ledger] ${JSON.stringify(b.gisLedger)}`);
}
