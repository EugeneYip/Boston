/**
 * Stage 2A — headless CONTROL vs CANDIDATE, through the real generation code.
 *
 *   node research/gis-stage2a/headless.mjs
 *
 * Builds Boston twice — flag off, flag on — by setting `globalThis.location`,
 * which is the only thing `GisRoads.isEnabled()` reads, so this drives the
 * production path rather than a copy of it. Then it asks the three questions
 * that decide the stage:
 *
 *   1. Does the world still generate? (structural reconciliation)
 *   2. Do the factual roads keep their Stage 1E alignment after normalization
 *      through `RoadNetwork.build()`? (the road-line-inside-a-building rate)
 *   3. Does Boston's GENERATED streetwall move toward the real one? (procedural
 *      frontage measured against Stage 1C's source-agreed factual walls)
 *
 * Question 3 is the new one and the point of the whole stage: better
 * centrelines plus unchanged procedural widths should put the procedural wall
 * closer to where the real wall is.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadSources } from '../gis-stage1c/sources.mjs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { bbox, centroid } from '../../src/world/GisAssociate.js';
import { corridorHalf } from '../../src/world/RoadNetwork.js';

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const inRing = (px, pz, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) &&
        (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c;
};
function firstHit(p, n, polys, reach) {
  let best = Infinity;
  const x1 = p.x + n.x * reach, z1 = p.z + n.z * reach;
  const rb = { x0: Math.min(p.x, x1), x1: Math.max(p.x, x1), z0: Math.min(p.z, z1), z1: Math.max(p.z, z1) };
  for (const g of polys) {
    if (g.b.x1 < rb.x0 || g.b.x0 > rb.x1 || g.b.z1 < rb.z0 || g.b.z0 > rb.z1) continue;
    const r = g.ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      const ex = c.x - a.x, ez = c.z - a.z;
      const den = n.x * ez - n.z * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = a.x - p.x, qz = a.z - p.z;
      const t = (qx * ez - qz * ex) / den;
      const w = (qx * n.z - qz * n.x) / -den;
      if (w < 0 || w > 1 || t <= 0.05 || t > reach) continue;
      if (t < best) best = t;
    }
  }
  return Number.isFinite(best) ? best : null;
}

const { pddl, massgis } = loadSources();
const prep = (set) => set.map((g) => ({ ring: g.ring, b: bbox(g.ring) }))
  .filter((g) => !(g.b.x1 < CORE.x0 - 80 || g.b.x0 > CORE.x1 + 80 || g.b.z1 < CORE.z0 - 80 || g.b.z0 > CORE.z1 + 80));
const PD = prep(pddl), MS = prep(massgis);

/** Build the world under a given location, through the production path. */
async function buildWorld(search) {
  globalThis.location = search === null ? undefined : { search };
  const [{ buildCurrentWorld }, { makeBuilder }] = await Promise.all([
    import(`../gis-stage1a/current-world.mjs?v=${encodeURIComponent(String(search))}`),
    import(`../gis-stage1b1/pipeline.mjs?v=${encodeURIComponent(String(search))}`),
  ]);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._buildSpecs(ctx);
  return { world, b };
}

/** Road-line-inside-a-factual-building rate, on the BUILT graph. */
function roadPathology(net, polys) {
  let n = 0, inside = 0;
  const byStreet = new Map();
  for (const e of net.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b2 = e.pts[i];
      const dx = b2.x - a.x, dz = b2.z - a.z, L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      for (let t = 0; t <= L; t += 2) {
        const p = { x: a.x + dx / L * t, z: a.z + dz / L * t };
        if (!inCore(p)) continue;
        n++;
        let ins = false;
        for (const g of polys) {
          if (p.x < g.b.x0 || p.x > g.b.x1 || p.z < g.b.z0 || p.z > g.b.z1) continue;
          if (inRing(p.x, p.z, g.ring)) { ins = true; break; }
        }
        if (ins) inside++;
        const k = e.name || `edge${e.id}`;
        let s = byStreet.get(k); if (!s) byStreet.set(k, s = { n: 0, in: 0 });
        s.n++; if (ins) s.in++;
      }
    }
  }
  return { samples: n, insidePct: r2(100 * inside / n),
           byStreet: [...byStreet].sort().map(([name, s]) => ({ name, samples: s.n, insidePct: r2(100 * s.in / s.n) })) };
}

/**
 * The decisive measurement: how far is Boston's GENERATED procedural street
 * wall from the factual wall, measured outward from the procedural frontage?
 * Uses only samples where both accepted factual sources agree, exactly as
 * Stage 1C did, so the yardstick is unchanged.
 */
function proceduralWallResidual(net, plots) {
  const faces = new Map();
  for (const p of plots) {
    if (!p?.polygon || !Number.isFinite(p.edgeId) || !p.frontage?.a) continue;
    if (!inCore(centroid(p.polygon))) continue;
    const k = `${p.edgeId}|${p.side > 0 ? 1 : 0}`;
    let f = faces.get(k);
    if (!f) faces.set(k, f = { edgeId: p.edgeId, side: p.side > 0 ? 1 : 0, name: net.edges[p.edgeId]?.name || `edge${p.edgeId}`, members: [] });
    f.members.push(p);
  }
  const all = [], byStreet = new Map();
  for (const f of faces.values()) {
    for (const p of f.members) {
      const a = p.frontage.a, b2 = p.frontage.b;
      const dx = b2.x - a.x, dz = b2.z - a.z, L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const ox = p.polygon[3].x - p.polygon[0].x, oz = p.polygon[3].z - p.polygon[0].z;
      const ol = Math.hypot(ox, oz) || 1;
      const u = { x: ox / ol, z: oz / ol };
      for (let t = 0; t <= L; t += 2) {
        const pt = { x: a.x + dx / L * t, z: a.z + dz / L * t };
        if (!inCore(pt)) continue;
        const dp = firstHit(pt, u, PD, 45);
        const dm = firstHit(pt, u, MS, 45);
        if (dp === null || dm === null || Math.abs(dp - dm) > 0.5) continue;   // Stage 1C agreement gate
        const d = Math.abs((dp + dm) / 2);
        all.push(d);
        let s = byStreet.get(f.name); if (!s) byStreet.set(f.name, s = []);
        s.push(d);
      }
    }
  }
  return { n: all.length, median: r2(q(all, .5)), p75: r2(q(all, .75)), p90: r2(q(all, .9)),
           byStreet: [...byStreet].sort().map(([name, a]) => ({ name, n: a.length, median: r2(q(a, .5)), p90: r2(q(a, .9)) })) };
}

function structure(net, b) {
  const edges = net.edges.filter((e) => e.pts.some(inCore));
  let len = 0;
  for (const e of edges) for (let i = 1; i < e.pts.length; i++) {
    const a = e.pts[i - 1], c = e.pts[i];
    if (inCore(a) || inCore(c)) len += Math.hypot(c.x - a.x, c.z - a.z);
  }
  const nodes = net.nodes.filter((n) => n && inCore(n));
  const plots = b.plots.filter((p) => p?.polygon && inCore(centroid(p.polygon)));
  const specs = b.specs.filter((s) => inCore({ x: s.cx, z: s.cz }));
  const dims = plots.map((p) => ({ w: p.width, d: p.depth }));
  return {
    roadEdgesCity: net.edges.length, roadNodesCity: net.nodes.length,
    roadEdgesCore: edges.length, roadNodesCore: nodes.length,
    junctionsCore: nodes.filter((n) => (n.edges?.length ?? 0) >= 3).length,
    roadLengthCoreM: r2(len),
    plotsCity: b.plots.length, plotsCore: plots.length,
    specsCity: b.specs.length, specsCore: specs.length,
    clipStats: b._clipStats,
    parcelWidthM: { min: r2(Math.min(...dims.map((d) => d.w))), median: r2(q(dims.map((d) => d.w), .5)), max: r2(Math.max(...dims.map((d) => d.w))) },
    parcelDepthM: { min: r2(Math.min(...dims.map((d) => d.d))), median: r2(q(dims.map((d) => d.d), .5)), max: r2(Math.max(...dims.map((d) => d.d))) },
  };
}

const out = {};
for (const [key, search] of [['control', null], ['candidate', '?gisRoads=1']]) {
  const { world, b } = await buildWorld(search);
  out[key] = {
    flag: search ?? 'absent',
    gisRoadLedger: world.net.gisRoadLedger,
    structure: structure(world.net, b),
    roadPathologyVsPDDL: roadPathology(world.net, PD),
    proceduralWallResidual: proceduralWallResidual(world.net, b.plots),
  };
}

/* ---- blast radius, Northeastern, and landmarks ---------------------------- */
const C = await buildWorld(null), K = await buildWorld('?gisRoads=1');
const pkey = (p) => `${p.frontage.a.x.toFixed(3)}_${p.frontage.a.z.toFixed(3)}_${p.width.toFixed(3)}_${p.depth.toFixed(3)}`;
const cP = new Set(C.b.plots.filter((p) => p.frontage).map(pkey));
const kP = new Set(K.b.plots.filter((p) => p.frontage).map(pkey));
const changed = [...C.b.plots.filter((p) => p.frontage && !kP.has(pkey(p))),
                 ...K.b.plots.filter((p) => p.frontage && !cP.has(pkey(p)))];
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.frontage.a.x, 0, p.frontage.a.x - CORE.x1),
                                  Math.max(CORE.z0 - p.frontage.a.z, 0, p.frontage.a.z - CORE.z1));
const outside = changed.filter((p) => distOut(p) > 0).map(distOut).sort((a, b) => a - b);
// Which streets moved at all?
const byStreet = (w, b) => {
  const m = new Map();
  for (const p of b.plots) {
    if (!p.frontage || !Number.isFinite(p.edgeId)) continue;
    const n = w.net.edges[p.edgeId]?.name || '?';
    m.set(n, (m.get(n) || 0) + 1);
  }
  return m;
};
const csn = byStreet(C.world, C.b), ksn = byStreet(K.world, K.b);
const movedStreets = [...new Set([...csn.keys(), ...ksn.keys()])].sort()
  .map((n) => ({ name: n, control: csn.get(n) || 0, candidate: ksn.get(n) || 0 }))
  .filter((r) => r.control !== r.candidate);
// Northeastern: FROZEN. Did anything inside the hero envelope move?
const { NEU_HERO_PARTS } = await import('../../src/data/neu-hero.js');
const nb = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
for (const part of NEU_HERO_PARTS) for (const [x, z] of part.outline) {
  if (x < nb.x0) nb.x0 = x; if (x > nb.x1) nb.x1 = x;
  if (z < nb.z0) nb.z0 = z; if (z > nb.z1) nb.z1 = z;
}
const inNeu = (p) => p.x >= nb.x0 - 150 && p.x <= nb.x1 + 150 && p.z >= nb.z0 - 150 && p.z <= nb.z1 + 150;
const neuChanged = changed.filter((p) => inNeu(p.frontage.a)).length;
// Landmarks: does any candidate road run through a landmark keep-out?
const { LANDMARKS } = await import('../../src/data/landmarks.js');
const { geo } = await import('../../src/core/Geo.js');
function landmarkHits(net) {
  const hits = [];
  for (const L of LANDMARKS) {
    const c = geo(L.lat, L.lon);
    let best = Infinity;
    for (const e of net.edges) for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1], b2 = e.pts[i];
      const ex = b2.x - a.x, ez = b2.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((c.x - a.x) * ex + (c.z - a.z) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(c.x - (a.x + ex * t), c.z - (a.z + ez * t));
      if (d < best) best = d;
    }
    if (best < (L.keepout ?? 0)) hits.push({ id: L.id, keepout: L.keepout, nearestRoadM: r2(best) });
  }
  return hits;
}
const blast = {
  plotsChanged: changed.length,
  outsideCore: outside.length,
  outsideCoreDistanceM: outside.length ? { min: r2(outside[0]), median: r2(q(outside, .5)), p90: r2(q(outside, .9)), max: r2(outside[outside.length - 1]) } : null,
  streetsWithChangedParcelCount: movedStreets,
  northeasternEnvelope: { bbox: { x0: r2(nb.x0), x1: r2(nb.x1), z0: r2(nb.z0), z1: r2(nb.z1) }, plotsChanged: neuChanged },
  landmarkKeepoutViolations: { control: landmarkHits(C.world.net), candidate: landmarkHits(K.world.net) },
};
out.blastRadius = blast;

const fmt = (k) => {
  const s = out[k].structure, r = out[k].roadPathologyVsPDDL, w = out[k].proceduralWallResidual;
  console.log(`\n--- ${k.toUpperCase()} (flag ${out[k].flag}) ---`);
  console.log(`  roads      city ${s.roadEdgesCity} edges / ${s.roadNodesCity} nodes   core ${s.roadEdgesCore} edges / ${s.roadNodesCore} nodes / ${s.junctionsCore} junctions / ${s.roadLengthCoreM} m`);
  console.log(`  parcels    city ${s.plotsCity}   core ${s.plotsCore}   width ${s.parcelWidthM.min}/${s.parcelWidthM.median}/${s.parcelWidthM.max}  depth ${s.parcelDepthM.min}/${s.parcelDepthM.median}/${s.parcelDepthM.max}`);
  console.log(`  buildings  city ${s.specsCity}   core ${s.specsCore}   clip ${JSON.stringify(s.clipStats)}`);
  console.log(`  road line inside a factual building: ${r.insidePct}%  (n=${r.samples})`);
  console.log(`  procedural wall -> factual wall: median ${w.median} m  p75 ${w.p75}  p90 ${w.p90}  (n=${w.n})`);
};
fmt('control'); fmt('candidate');

console.log('\n=== per-street: road line inside a factual building ===');
const cs = new Map(out.control.roadPathologyVsPDDL.byStreet.map((s) => [s.name, s]));
for (const s of out.candidate.roadPathologyVsPDDL.byStreet) {
  const c = cs.get(s.name);
  console.log(`  ${s.name.padEnd(30)} control ${String(c ? c.insidePct : '—').padStart(6)}%   candidate ${String(s.insidePct).padStart(6)}%`);
}
console.log('\n=== per-street: procedural wall -> factual wall (median m) ===');
const cw = new Map(out.control.proceduralWallResidual.byStreet.map((s) => [s.name, s]));
for (const s of out.candidate.proceduralWallResidual.byStreet) {
  const c = cw.get(s.name);
  console.log(`  ${s.name.padEnd(30)} control ${String(c ? c.median : '—').padStart(6)}   candidate ${String(s.median).padStart(6)}   (n ${c ? c.n : 0} -> ${s.n})`);
}

console.log(`\n=== blast radius ===`);
console.log(`  parcels changed ${blast.plotsChanged}; outside the core ${blast.outsideCore}` +
  (blast.outsideCoreDistanceM ? `, distance from core edge median ${blast.outsideCoreDistanceM.median} m max ${blast.outsideCoreDistanceM.max} m` : ''));
console.log(`  streets with a changed parcel count: ${blast.streetsWithChangedParcelCount.length} of ${new Set([...csn.keys(), ...ksn.keys()]).size}`);
for (const r of blast.streetsWithChangedParcelCount) console.log(`    ${r.name.padEnd(32)} ${String(r.control).padStart(4)} -> ${String(r.candidate).padStart(4)}`);
console.log(`  Northeastern envelope parcels changed: ${blast.northeasternEnvelope.plotsChanged}`);
console.log(`  landmark keep-out violations: control ${blast.landmarkKeepoutViolations.control.length}, candidate ${blast.landmarkKeepoutViolations.candidate.length}`);
for (const h of blast.landmarkKeepoutViolations.candidate) console.log(`    ${h.id}: nearest road ${h.nearestRoadM} m vs keepout ${h.keepout} m`);

const body = JSON.stringify({ schemaVersion: 'boston-gis-stage2a/headless/0.2.0', core: CORE, ...out }, null, 1) + '\n';
writeFileSync(new URL('./headless.json', import.meta.url), body);
console.log(`\nwrote headless.json  sha256 ${createHash('sha256').update(body).digest('hex').slice(0, 16)}`);
