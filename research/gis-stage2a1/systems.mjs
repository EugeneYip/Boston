/**
 * Stage 2A.1 — dependent-system validation: routing, spawns, tunnel isolation.
 *
 *   node research/gis-stage2a1/systems.mjs
 *
 * Deterministic and headless. Routes are computed by Dijkstra over the real
 * `RoadNetwork` graph, honouring `oneway`, so this tests the graph the runtime
 * routing systems actually consume rather than a model of it.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { bbox } from '../../src/world/GisAssociate.js';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;

async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  return buildCurrentWorld();
}
/** Adjacency honouring one-way, keyed by node id. */
function graphOf(net) {
  const adj = new Map();
  const add = (a, b, e, L) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, e, L }); };
  for (const e of net.edges) {
    let L = 0;
    for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z);
    if (!(L > 0)) continue;
    const ow = e.oneway || 0;
    if (ow >= 0) add(e.a, e.b, e, L);
    if (ow <= 0) add(e.b, e.a, e, L);
  }
  return adj;
}
function dijkstra(adj, from, to) {
  const dist = new Map([[from, 0]]), prev = new Map(), seen = new Set();
  while (true) {
    let u = null, best = Infinity;
    for (const [n, d] of dist) if (!seen.has(n) && d < best) { best = d; u = n; }
    if (u === null) break;
    if (u === to) break;
    seen.add(u);
    for (const { to: v, e, L } of adj.get(u) || []) {
      const nd = best + L;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { u, e }); }
    }
  }
  if (!dist.has(to)) return null;
  const edges = [];
  for (let n = to; prev.has(n); n = prev.get(n).u) edges.unshift(prev.get(n).e);
  return { distanceM: r2(dist.get(to)), edges };
}
/**
 * Nearest JUNCTION, not nearest node.
 *
 * Taking the nearest node of any degree made the cases incomparable between the
 * two worlds: the geometry moves, so each world snapped the endpoint to a
 * different node, and in the candidate two of them landed on one-way stubs —
 * node 102 has a single `Public Alley 435` edge. Both routes then reported "no
 * route" while the graph was in fact fully connected, which would have been a
 * false MAJOR_DEFECT. A junction is traversable in both worlds by construction.
 */
const nearestNode = (net, x, z) => net.nodes.filter((n) => n && (n.edges?.length ?? 0) >= 3)
  .map((n) => ({ n, d: Math.hypot(n.x - x, n.z - z) })).sort((a, b) => a.d - b.d)[0].n;

/** Connected components of the undirected graph, for a disconnection check. */
function components(net) {
  const adj = new Map();
  for (const e of net.edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b); adj.get(e.b).push(e.a);
  }
  const seen = new Set(); let n = 0; let biggest = 0;
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    n++; let size = 0;
    const st = [s]; seen.add(s);
    while (st.length) { const u = st.pop(); size++; for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); st.push(v); } }
    biggest = Math.max(biggest, size);
  }
  return { count: n, largest: biggest, nodes: adj.size };
}

const CASES = [
  { id: 'A_outside_through_core', note: 'baseline world -> seam -> factual core -> seam -> baseline world',
    from: { x: -760, z: 470 }, to: { x: -1600, z: 700 } },
  { id: 'B_east_west_core', note: 'east/west traversal of the core',
    from: { x: -1000, z: 480 }, to: { x: -1360, z: 620 } },
  { id: 'C_north_south_core', note: 'north/south cross-street traversal',
    from: { x: -1150, z: 470 }, to: { x: -1150, z: 840 } },
  { id: 'D_commonwealth', note: 'along the Commonwealth boulevard',
    from: { x: -1050, z: 420 }, to: { x: -1400, z: 545 } },
  { id: 'E_near_northeastern', note: 'near but not through the frozen Northeastern district',
    from: { x: -1300, z: 900 }, to: { x: -1850, z: 1500 } },
];

const out = {};
for (const [key, search] of [['control', null], ['candidate', '?gisRoads=1']]) {
  const world = await build(search, key);
  const net = world.net;
  const adj = graphOf(net);
  const comp = components(net);
  const routes = CASES.map((c) => {
    const a = nearestNode(net, c.from.x, c.from.z), b = nearestNode(net, c.to.x, c.to.z);
    const r = dijkstra(adj, a.id, b.id);
    const coreEdges = r ? r.edges.filter((e) => e.pts.some(inCore)).length : 0;
    // Seam crossings: transitions between an in-core edge and an out-of-core one.
    let crossings = 0;
    if (r) for (let i = 1; i < r.edges.length; i++) {
      const p = r.edges[i - 1].pts.some(inCore), q = r.edges[i].pts.some(inCore);
      if (p !== q) crossings++;
    }
    const tunnel = r ? r.edges.filter((e) => e.name === 'Massachusetts TPKE W' || e.bridged).length : 0;
    return { id: c.id, note: c.note, found: !!r, distanceM: r?.distanceM ?? null,
             edges: r?.edges.length ?? 0, coreEdges, seamCrossings: crossings, tunnelEdges: tunnel };
  });
  /**
   * Trap census. One failing route proves little; what matters is whether a
   * vehicle placed anywhere in the core can still leave it, and whether the core
   * can be entered. Measured over every core junction, in both directions.
   */
  const reach = (start, adjacency) => {
    const seen = new Set([start]); const st = [start];
    while (st.length) { const u = st.pop(); for (const { to } of adjacency.get(u) || []) if (!seen.has(to)) { seen.add(to); st.push(to); } }
    return seen;
  };
  const radj = new Map();                        // reversed graph, for "can be entered"
  for (const [u, list] of adj) for (const { to, e, L } of list) {
    if (!radj.has(to)) radj.set(to, []);
    radj.get(to).push({ to: u, e, L });
  }
  const outside = net.nodes.filter((n) => n && !inCore(n)).map((n) => n.id);
  const outsideSet = new Set(outside);
  const coreJunctions = net.nodes.filter((n) => n && inCore(n) && (n.edges?.length ?? 0) >= 3);
  let canExit = 0, canEnter = 0;
  const traps = [];
  for (const n of coreJunctions) {
    const f = reach(n.id, adj), r = reach(n.id, radj);
    const exits = [...f].some((v) => outsideSet.has(v));
    const enters = [...r].some((v) => outsideSet.has(v));
    if (exits) canExit++; else traps.push({ node: n.id, x: r2(n.x), z: r2(n.z), forwardReach: f.size, kind: 'cannot-exit' });
    if (enters) canEnter++;
  }
  const trapCensus = { coreJunctions: coreJunctions.length, canExit, canEnter, traps };

  // Spawn validity: on a road, not inside a building, finite.
  const spawns = net.buildSpawns();
  const coreSpawns = spawns.filter(inCore);
  let nonFinite = 0;
  for (const s of spawns) if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) nonFinite++;
  // A spawn is suspect if it is further than a corridor width from ANY road.
  const suspect = coreSpawns.filter((s) => {
    let best = Infinity;
    for (const e of net.edges) for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((s.x - a.x) * ex + (s.z - a.z) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(s.x - (a.x + ex * t), s.z - (a.z + ez * t));
      if (d < best) best = d;
    }
    return best > 20;
  }).length;
  out[key] = { components: comp, routes, trapCensus,
               spawns: { total: spawns.length, core: coreSpawns.length, nonFinite, suspectInCore: suspect },
               tunnelEdgesInGraph: net.edges.filter((e) => e.name === 'Massachusetts TPKE W').length };
  console.log(`\n--- ${key.toUpperCase()} ---`);
  console.log(`  graph: ${comp.nodes} nodes, ${comp.count} components, largest ${comp.largest}`);
  for (const r of routes) console.log(`  ${r.id.padEnd(26)} found ${String(r.found).padStart(5)}  ${String(r.distanceM).padStart(8)} m  edges ${String(r.edges).padStart(3)}  core ${String(r.coreEdges).padStart(3)}  seamCross ${r.seamCrossings}  tunnel ${r.tunnelEdges}`);
  console.log(`  core junctions ${trapCensus.coreJunctions}: can exit the core ${trapCensus.canExit}, can be entered ${trapCensus.canEnter}, traps ${trapCensus.traps.length}`);
  console.log(`  spawns ${out[key].spawns.total} (core ${out[key].spawns.core}), non-finite ${nonFinite}, >20 m from any road in core ${suspect}`);
  console.log(`  Turnpike edges present in the surface graph: ${out[key].tunnelEdgesInGraph}`);
}
writeFileSync(new URL('./systems.json', import.meta.url), JSON.stringify({ schemaVersion: 'boston-gis-stage2a1/systems/0.1.0', core: CORE, ...out }, null, 1) + '\n');
