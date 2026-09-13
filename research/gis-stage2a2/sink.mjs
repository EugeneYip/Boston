/**
 * Stage 2A.2 Mission C — exact diagnosis of the one-way seam sink.
 *
 *   node research/gis-stage2a2/sink.mjs
 *
 * Not "make the street two-way until the test passes". Identify the node, its
 * incoming and outgoing edges, each edge's road concept and direction sense,
 * and what the baseline does at the equivalent place.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  return buildCurrentWorld();
}
const adjOf = (net) => {
  const m = new Map();
  const add = (a, b, e) => { if (!m.has(a)) m.set(a, []); m.get(a).push({ to: b, e }); };
  for (const e of net.edges) { const ow = e.oneway || 0; if (ow >= 0) add(e.a, e.b, e); if (ow <= 0) add(e.b, e.a, e); }
  return m;
};
const reach = (adj, s) => { const seen = new Set([s]); const st = [s];
  while (st.length) { const u = st.pop(); for (const { to } of adj.get(u) || []) if (!seen.has(to)) { seen.add(to); st.push(to); } }
  return seen; };

const out = {};
for (const [key, search] of [['control', null], ['candidate', '?gisRoads=1']]) {
  const net = (await build(search, key)).net;
  const adj = adjOf(net);
  const total = net.nodes.filter(Boolean).length;
  // A sink is any node that can reach almost nothing forward while being
  // reachable itself. Measured over every node, not just the routing endpoints.
  const sinks = [];
  for (const n of net.nodes) {
    if (!n) continue;
    const f = reach(adj, n.id);
    if (f.size > 10) continue;
    const outE = net.edges.filter((e) => (e.oneway >= 0 && e.a === n.id) || (e.oneway <= 0 && e.b === n.id));
    const inE = net.edges.filter((e) => (e.oneway >= 0 && e.b === n.id) || (e.oneway <= 0 && e.a === n.id));
    sinks.push({ node: n.id, x: r2(n.x), z: r2(n.z), inCore: inCore(n),
      distFromCore: r2(Math.hypot(Math.max(CORE.x0 - n.x, 0, n.x - CORE.x1), Math.max(CORE.z0 - n.z, 0, n.z - CORE.z1))),
      forwardReach: f.size,
      outgoing: outE.map((e) => ({ name: e.name, oneway: e.oneway || 0, connector: !!e.transitionConnector })),
      incoming: inE.map((e) => ({ name: e.name, oneway: e.oneway || 0 })) });
  }
  out[key] = { nodes: total, sinks };
  console.log(`\n--- ${key.toUpperCase()} --- nodes ${total}, dead-end-forward nodes (<=10 reachable): ${sinks.length}`);
  for (const s of sinks.slice(0, 8))
    console.log(`  node ${String(s.node).padStart(4)} (${String(s.x).padStart(8)},${String(s.z).padStart(7)}) core ${String(s.inCore).padStart(5)} d ${String(s.distFromCore).padStart(6)} reach ${String(s.forwardReach).padStart(3)}  in[${s.incoming.map((e) => e.name).join(',')}]  out[${s.outgoing.map((e) => e.name).join(',') || 'NONE'}]`);
}
writeFileSync(new URL('./sink.json', import.meta.url), JSON.stringify({ schemaVersion: 'boston-gis-stage2a2/sink/0.1.0', ...out }, null, 1) + '\n');
