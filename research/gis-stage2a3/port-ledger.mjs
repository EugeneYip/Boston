/**
 * Stage 2A.3 Phase 1 — the complete factual boundary-port ledger.
 *
 *   node research/gis-stage2a3/port-ledger.mjs
 *
 * Attribution before implementation. Every port the generator can see, with the
 * exact predicate that fails for the ones that end up unconnected.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo } from '../../src/core/Geo.js';
import { GIS_ROADS, GIS_ROADS_CLIPPED, GIS_ROADS_CONNECTORS } from '../../src/data/gis-backbay-roads.js';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const onBoundary = (g) => Math.min(Math.abs(g.x - CORE.x0), Math.abs(g.x - CORE.x1),
                                   Math.abs(g.z - CORE.z0), Math.abs(g.z - CORE.z1));
globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const baseline = buildCurrentWorld();

/* ---- enumerate ports exactly as the generator does ----------------------- */
const ports = [];
for (const e of GIS_ROADS) {
  for (const idx of [0, e.path.length - 1]) {
    const g = geo(e.path[idx][0], e.path[idx][1]);
    if (onBoundary(g) < 0.5) ports.push({ e, idx, g });
  }
}
/* ---- which connector, if any, serves each port? -------------------------- */
const connFor = (port) => {
  for (let i = 0; i < GIS_ROADS_CONNECTORS.length; i++) {
    const c = GIS_ROADS_CONNECTORS[i];
    for (const p of [c.path[0], c.path[c.path.length - 1]]) {
      if (Math.abs(p[0] - port.e.path[port.idx][0]) < 1e-9 && Math.abs(p[1] - port.e.path[port.idx][1]) < 1e-9) return i;
    }
  }
  return -1;
};
/* ---- the generator's own matching predicates, replayed ------------------- */
const clippedByName = new Map();
for (const c of GIS_ROADS_CLIPPED) {
  if (!clippedByName.has(c.name)) clippedByName.set(c.name, []);
  clippedByName.get(c.name).push(c);
}
const nearestStubSameName = (port) => {
  let best = null;
  for (const c of clippedByName.get(port.e.name) || []) {
    for (const run of c.runs) for (const idx of [0, run.path.length - 1]) {
      const g = geo(run.path[idx][0], run.path[idx][1]);
      const d = Math.hypot(g.x - port.g.x, g.z - port.g.z);
      if (!best || d < best.d) best = { d, ll: run.path[idx] };
    }
  }
  return best;
};
const nearestBaselineNode = (port) => {
  let bn = null;
  for (const n of baseline.net.nodes) {
    if (!n || inCore(n)) continue;
    const d = Math.hypot(n.x - port.g.x, n.z - port.g.z);
    if (!bn || d < bn.d) bn = { d, n };
  }
  return bn;
};
/** What would RoadNetwork.build()'s 21 m END_SNAP grab instead? */
const END_SNAP = 21;
const snapTarget = (port) => {
  let best = null;
  for (const e of baseline.net.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b = e.pts[i];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((port.g.x - a.x) * ex + (port.g.z - a.z) * ez) / L2;
      const mid = t > 0.02 && t < 0.98;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(port.g.x - (a.x + ex * t), port.g.z - (a.z + ez * t));
      if (d < END_SNAP && (!best || d < best.d)) best = { d, name: e.name, midEdge: mid };
    }
  }
  return best;
};

const ledger = ports.map((port, i) => {
  const ci = connFor(port);
  const stub = nearestStubSameName(port);
  const node = nearestBaselineNode(port);
  const snap = ci >= 0 ? null : snapTarget(port);
  let reason = null;
  if (ci < 0) {
    if (!clippedByName.has(port.e.name)) reason = 'no-clipped-stub-of-this-concept';
    else if (!stub) reason = 'concept-clipped-but-no-run-endpoint';
    else if (stub.d > 40) reason = `nearest-same-name-stub-too-far-${r2(stub.d)}m`;
    else reason = 'matched-but-lost-downstream';
    if (reason !== 'no-clipped-stub-of-this-concept' && (!node || node.d > 40)) reason += '; no-baseline-node-within-40m';
  }
  return {
    portId: `P${String(i).padStart(2, '0')}`,
    street: port.e.name, sam: port.e.sam?.name ?? null, samSegmentId: port.e.sam?.segmentId ?? null,
    zlev: port.e.sam?.zlev ?? null, oneway: port.e.oneway ?? 0, end: port.idx === 0 ? 'start' : 'end',
    x: r2(port.g.x), z: r2(port.g.z),
    connected: ci >= 0, connectorIndex: ci >= 0 ? ci : null,
    nearestSameNameStubM: stub ? r2(stub.d) : null,
    nearestBaselineNodeM: node ? r2(node.d) : null,
    conceptIsClipped: clippedByName.has(port.e.name),
    endSnapTarget: snap ? { street: snap.name, distM: r2(snap.d), midEdge: snap.midEdge } : null,
    failure: reason,
  };
});

const connected = ledger.filter((p) => p.connected);
const missing = ledger.filter((p) => !p.connected);
const byReason = {};
for (const m of missing) byReason[m.failure] = (byReason[m.failure] || 0) + 1;

console.log(`ports ${ledger.length}: connected ${connected.length}, missing ${missing.length}\n`);
console.log('id   street                        end    x         z        conn  stubM   nodeM  clipped  END_SNAP target');
for (const p of ledger) console.log(
  `${p.portId} ${p.street.padEnd(29)} ${p.end.padEnd(5)} ${String(p.x).padStart(9)} ${String(p.z).padStart(8)} ` +
  `${(p.connected ? ' yes' : ' NO ').padStart(5)} ${String(p.nearestSameNameStubM).padStart(7)} ${String(p.nearestBaselineNodeM).padStart(6)} ` +
  `${String(p.conceptIsClipped).padStart(7)}  ${p.endSnapTarget ? `${p.endSnapTarget.street}@${p.endSnapTarget.distM}m${p.endSnapTarget.midEdge ? ' MID-EDGE' : ''}` : '-'}`);
console.log('\nfailure categories:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

writeFileSync(new URL('./port-ledger.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a3/port-ledger/0.1.0', core: CORE, endSnapM: END_SNAP,
    totals: { ports: ledger.length, connected: connected.length, missing: missing.length },
    failureCategories: byReason, ports: ledger }, null, 1) + '\n');
