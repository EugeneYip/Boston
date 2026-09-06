/**
 * Model Lab — the world, without the game.
 *
 * Boston's building specs are produced by a chain that looks like it needs the
 * whole engine: terrain raster -> street graph -> neighbourhood raster ->
 * parcels -> `Buildings._buildSpecs`. It does not. Every step in that chain is
 * pure arithmetic over typed arrays; only the *mesh* steps that hang off it
 * (`Terrain.build`, `Districts.build`, `Roads`, `Water`) touch a scene, and
 * none of them feed the specs.
 *
 * So this module runs the real chain and stops at the specs. Measured on the
 * canonical tree: 1.5 s, no WebGL, no DOM. That is what makes both halves of
 * the lab possible — the Node auditor gets all 10,048 real buildings, and the
 * browser lab gets a boot that fits inside the Browser pane's survival window
 * instead of Boston's ~5 minute cold start.
 *
 * The point of doing it this way rather than authoring synthetic fixtures is
 * fidelity. `spec.front`, `spec.style`, the setback jitter, the superblock
 * fusion and the road-corridor clip are all decided by code this lab does not
 * own. A fixture that guessed at them would let a modeling change pass here and
 * fail in the city. Building 4,211 in the lab is building 4,211 in Boston.
 *
 * Node AND browser. Import nothing from here that needs a renderer.
 */
import Terrain from '../../src/world/Terrain.js';
import Districts from '../../src/world/Districts.js';
import RoadNetwork from '../../src/world/RoadNetwork.js';
import Buildings from '../../src/world/Buildings.js';

/**
 * Run the production spec chain.
 * @returns {{specs:Array<object>, plots:Array<object>, net:RoadNetwork,
 *            terrain:Terrain, districts:Districts, timing:object}}
 */
export function buildWorld() {
  const T = {};
  let t = now();
  const mark = (k) => { T[k] = Math.round(now() - t); t = now(); };

  const terrain = new Terrain();
  terrain.bake();
  mark('terrain');

  // Same order as City.init, and for the same reason: the roads decide their
  // own elevation profile and stamp it back, so `groundHeight` is only true on
  // the street after this pair has run.
  const net = new RoadNetwork(terrain);
  net.build();
  terrain.stampRoads(net);
  mark('roads');

  const districts = new Districts(terrain);
  districts.bake();
  mark('districts');

  net.buildSidewalks();
  net.buildPlots(
    (x, z) => districts.districtAt(x, z),
    (x, z) => districts.isReserved(x, z));
  mark('parcels');

  // The real `Buildings`, not a copy of it. `_collectPlots` and `_buildSpecs`
  // are the whole spec path and neither touches `this.matOpaque`, the atlases
  // or the scene — those are built by `init`, which is exactly the part that
  // needs a GPU and exactly the part the specs do not need.
  const city = {
    plots: net.plots,
    groundHeight: (x, z) => terrain.groundHeight(x, z),
    districtAt: (x, z) => districts.districtAt(x, z),
    roads: { edges: net.edges },
  };
  const ctx = { get: (k) => (k === 'city' ? city : undefined) };
  const buildings = new Buildings();
  buildings._collectPlots(ctx);
  buildings._buildSpecs();
  mark('specs');

  T.total = Object.values(T).reduce((a, b) => a + b, 0);
  return { specs: buildings.specs, plots: net.plots, net, terrain, districts, timing: T };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
