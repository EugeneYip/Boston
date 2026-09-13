/**
 * Stage 2A.1 — Commonwealth Avenue boulevard diagnosis.
 *
 *   node research/gis-stage2a1/commonwealth.mjs
 *
 * Structure before art. Tests the brief's hypotheses against measurement:
 * carriageway pairing, semantic concept, procedural width applied per
 * carriageway, parcels invading the planted median, and whether the mall
 * generator recognises the factual pair.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';
import { centroid } from '../../src/world/GisAssociate.js';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const NAMES = ['Commonwealth Avenue Inbound', 'Commonwealth Avenue Outbound'];

function analyse(world, b, label) {
  const edges = world.net.edges.filter((e) => NAMES.includes(e.name) && e.pts.some(inCore));
  const byName = {};
  for (const n of NAMES) {
    const es = edges.filter((e) => e.name === n);
    let len = 0;
    for (const e of es) for (let i = 1; i < e.pts.length; i++) len += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z);
    byName[n] = { edges: es.length, lengthM: r2(len),
      lanes: [...new Set(es.map((e) => e.lanes))], halfRoad: [...new Set(es.map((e) => r2(e.halfRoad)))],
      corridorHalf: [...new Set(es.map((e) => r2(corridorHalf(e))))],
      mall: [...new Set(es.map((e) => !!e.mall))] };
  }
  // Carriageway spacing: for samples on Inbound, distance to the nearest Outbound line.
  const other = edges.filter((e) => e.name === NAMES[1]);
  const gaps = [];
  for (const e of edges.filter((x) => x.name === NAMES[0])) {
    for (const p of e.pts) {
      if (!inCore(p)) continue;
      let best = Infinity;
      for (const o of other) for (let i = 1; i < o.pts.length; i++) {
        const a = o.pts[i - 1], c = o.pts[i];
        const ex = c.x - a.x, ez = c.z - a.z, L2 = ex * ex + ez * ez || 1;
        let t = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
        if (d < best) best = d;
      }
      if (Number.isFinite(best)) gaps.push(best);
    }
  }
  gaps.sort((a, c) => a - c);
  const ch = Math.max(...NAMES.flatMap((n) => byName[n].corridorHalf).filter(Number.isFinite), 0);
  const spacing = gaps.length ? r2(gaps[Math.floor(gaps.length / 2)]) : null;
  // Parcels whose centroid lies BETWEEN the two carriageways — the planted mall.
  let inMedian = 0;
  if (spacing) {
    for (const p of b.plots) {
      const c = centroid(p.polygon);
      if (!inCore(c)) continue;
      let dIn = Infinity, dOut = Infinity;
      for (const e of edges) {
        for (let i = 1; i < e.pts.length; i++) {
          const a = e.pts[i - 1], q = e.pts[i];
          const ex = q.x - a.x, ez = q.z - a.z, L2 = ex * ex + ez * ez || 1;
          let t = ((c.x - a.x) * ex + (c.z - a.z) * ez) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(c.x - (a.x + ex * t), c.z - (a.z + ez * t));
          if (e.name === NAMES[0]) dIn = Math.min(dIn, d); else dOut = Math.min(dOut, d);
        }
      }
      if (dIn < spacing && dOut < spacing && dIn + dOut < spacing * 1.25) inMedian++;
    }
  }
  console.log(`\n--- ${label} ---`);
  for (const n of NAMES) console.log(`  ${n.padEnd(30)} edges ${String(byName[n].edges).padStart(2)} len ${String(byName[n].lengthM).padStart(7)} m  lanes ${JSON.stringify(byName[n].lanes)} halfRoad ${JSON.stringify(byName[n].halfRoad)} corridorHalf ${JSON.stringify(byName[n].corridorHalf)} mall ${JSON.stringify(byName[n].mall)}`);
  console.log(`  carriageway spacing (median): ${spacing} m   -> free public realm between kerbs: ${spacing !== null ? r2(spacing - 2 * ch) : null} m`);
  console.log(`  parcels generated inside the median: ${inMedian}`);
  return { byName, spacingM: spacing, corridorHalfMax: r2(ch), freeRealmM: spacing !== null ? r2(spacing - 2 * ch) : null, parcelsInMedian: inMedian };
}
const C = await build(null, 'c'), K = await build('?gisRoads=1', 'k');
const out = { schemaVersion: 'boston-gis-stage2a1/commonwealth/0.1.0',
  control: analyse(C.world, C.b, 'CONTROL'), candidate: analyse(K.world, K.b, 'CANDIDATE') };
writeFileSync(new URL('./commonwealth.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
