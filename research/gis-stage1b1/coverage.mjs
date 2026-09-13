/**
 * Stage 1B.1 — street-facing coverage of the accepted replacements.
 *
 *   node research/gis-stage1b1/coverage.mjs
 *
 * Building count is the wrong unit for a streetwall question: eight buildings
 * scattered over four streets and eight buildings in a row are the same number
 * and not the same experiment. This measures FRONTAGE — metres of block face —
 * and the length of the longest unbroken factual run, which is what a camera
 * can actually see.
 */
import { writeFileSync } from 'node:fs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { runGate } from './run.mjs';
import { GATE } from '../../src/world/GisBackBay.js';
import { makeBuilder } from './pipeline.mjs';
import { frontageChain, centroid } from '../../src/world/GisAssociate.js';
import { GIS_BACKBAY_SOURCE } from '../../src/data/gis-backbay-candidate.js';

const W = GIS_BACKBAY_SOURCE.bboxWorld;
const inBox = (c) => c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1;

const world = buildCurrentWorld();
const { r, parcels } = runGate(world, GATE);
const { b, ctx } = makeBuilder(world);
b._collectPlots(ctx);
const net = world.net;
const nameOf = (p) => net.edges[p.edgeId]?.name || `edge${p.edgeId}`;
const byId = new Map(parcels.map((p) => [p.id, p]));
const chain = frontageChain(parcels);
const local = parcels.filter((p) => inBox(centroid(p.polygon)));

// Block face = one (edgeId, side). Frontage = the sum of parcel widths on it.
const faces = new Map();
for (const p of local) {
  const k = `${p.edgeId}|${p.side > 0 ? 1 : 0}`;
  let f = faces.get(k);
  if (!f) faces.set(k, f = { key: k, street: nameOf(p), totalM: 0, parcels: [], factualM: 0, factualParcels: [] });
  f.totalM += p.width; f.parcels.push(p.id);
}
const replacedBy = new Map();
for (const x of r.ledger.replaced) for (const id of x.suppressedPlotIds) replacedBy.set(id, x.id);
for (const [id, cid] of replacedBy) {
  const p = byId.get(id); if (!p) continue;
  const f = faces.get(`${p.edgeId}|${p.side > 0 ? 1 : 0}`);
  if (f) { f.factualM += p.width; f.factualParcels.push({ id, cid }); }
}

// Longest unbroken factual frontage: walk each chain, accumulating while the
// parcel under the walker is factual.
let best = { m: 0, n: 0, street: null, ids: [] };
// Heads come from the WHOLE parcel set, not the in-box subset: the Newbury
// chain starts west of the prototype box, so filtering heads to the box left
// its run unreachable and reported a longest run of zero.
const heads = parcels.filter((p) => !chain.prev.has(p.id));
for (const h of heads) {
  let run = [], m = 0;
  for (let id = h.id; id !== undefined; id = chain.next.get(id)) {
    const p = byId.get(id); if (!p) break;
    if (replacedBy.has(id)) { run.push(id); m += p.width;
      if (m > best.m) best = { m, n: new Set(run.map((i) => replacedBy.get(i))).size, street: nameOf(p), ids: run.slice() };
    } else { run = []; m = 0; }
  }
}
const out = {
  schemaVersion: 'boston-gis-stage1b1/coverage/0.1.0',
  gate: GATE.version,
  blockFaces: [...faces.values()].filter((f) => f.factualM > 0)
    .map((f) => ({ street: f.street, key: f.key, totalFrontageM: Math.round(f.totalM * 10) / 10,
                   factualFrontageM: Math.round(f.factualM * 10) / 10,
                   factualPct: Math.round(1000 * f.factualM / f.totalM) / 10,
                   factualBuildings: new Set(f.factualParcels.map((x) => x.cid)).size }))
    .sort((a, b2) => b2.factualFrontageM - a.factualFrontageM),
  faceCount: faces.size,
  longestFactualRun: { metres: Math.round(best.m * 10) / 10, buildings: best.n, street: best.street },
  replaced: r.ledger.replaced.map((x) => ({ id: x.id, cx: x.cx, cz: x.cz, parcels: x.parcels,
    street: nameOf(byId.get(x.donorPlotId)), heightM: x.heightM, storeys: x.storeys,
    ringVertices: x.ringVertices, specVertices: x.specVertices, streetBareM2: x.streetBareM2 })),
};
writeFileSync(new URL('./coverage.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
