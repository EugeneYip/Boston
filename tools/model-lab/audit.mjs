/**
 * BOSTON — headless modeling auditor.
 *
 * The Model Lab answers "does this look right?"; this answers "how much of the
 * city is like that?". It runs the same spec chain (`world.js`) with no WebGL,
 * so a population-scale question about all 10,048 buildings costs about a
 * second instead of a boot.
 *
 * It never replaces a capture. Triangle counts cannot see a facade whose relief
 * was flattened without changing its topology, and relief cannot see a texture.
 * Use both.
 *
 *   node tools/model-lab/audit.mjs exposure   street exposure vs `spec.front`
 *   node tools/model-lab/audit.mjs lod        LOD0/1/2 cost and wall relief
 *   node tools/model-lab/audit.mjs edges <i>  one building, edge by edge
 */
import { buildWorld } from './world.js';
import { corridorHalf } from '../../src/world/RoadNetwork.js';
import { edgeReport, edgeFrames } from './analysis.js';
import { MeshBuf, GlassBuf } from '../../src/world/BuildingKit.js';
import { buildBuilding } from '../../src/world/Facades.js';

const cmd = process.argv[2] || 'exposure';
const arg = process.argv[3];

const world = buildWorld();
const { specs, net } = world;
process.stderr.write(`[audit] ${specs.length} specs in ${world.timing.total} ms\n`);

/* -------------------------------------------------------------------------- */
/* Street exposure                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which road types count as public realm a building should address.
 *
 * `buildPlots` already refuses to hand frontage to a highway or an alley, and
 * it is right to: a Back Bay service alley is a real place you can drive, but
 * the elevation onto it is a rear elevation, with the bins and the fire escape.
 * Counting alleys as street was worth 400 false "missing facade" verdicts on
 * the first pass of this audit -- almost the entire Back Bay result -- so the
 * filter is the difference between measuring a defect and inventing one.
 * `sidewalk` edges are the pavement graph, not carriageway, and would double
 * count every street.
 */
const STREET_TYPES = (t) => t !== 'alley' && t !== 'highway' && t !== 'sidewalk';

/** Uniform grid over road segments, so 40k exposure probes stay cheap. */
const GRID = 64;
const segGrid = new Map();
for (const e of net.edges) {
  if (!STREET_TYPES(e.type) || e.bridged) continue;
  const half = corridorHalf(e);
  for (let i = 0; i < e.pts.length - 1; i++) {
    const a = e.pts[i], b = e.pts[i + 1];
    const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, half };
    const x0 = Math.floor(Math.min(a.x, b.x) / GRID), x1 = Math.floor(Math.max(a.x, b.x) / GRID);
    const z0 = Math.floor(Math.min(a.z, b.z) / GRID), z1 = Math.floor(Math.max(a.z, b.z) / GRID);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const k = gx + ',' + gz;
      let l = segGrid.get(k); if (!l) segGrid.set(k, l = []);
      l.push(seg);
    }
  }
}

/**
 * How much open street a footprint edge faces, in metres of clearance.
 *
 * A NEAREST-CORRIDOR query rather than a ray. A ray fired down the edge normal
 * slips straight through the gap at a junction and reports "no street" for a
 * wall standing on one; measuring to the nearest carriageway instead cannot.
 *
 * Three conditions, all necessary:
 *   - the street lies on the OUTWARD side, so an edge is never credited with a
 *     street that is behind it;
 *   - the street runs roughly PARALLEL to the edge, so a wall is not called
 *     street-facing because a cross street passes its far end;
 *   - clearance deducts the road's own corridor (carriageway + kerb + footway),
 *     so a wall at the back of the pavement scores ~0.
 */
function exposure(spec) {
  const out = [];
  for (const e of edgeFrames(spec.poly)) {
    const mx = e.ax + e.dx * e.L * 0.5, mz = e.az + e.dz * e.L * 0.5;
    let best = 120;
    const g0x = Math.floor((mx - 60) / GRID), g1x = Math.floor((mx + 60) / GRID);
    const g0z = Math.floor((mz - 60) / GRID), g1z = Math.floor((mz + 60) / GRID);
    for (let gx = g0x; gx <= g1x; gx++) for (let gz = g0z; gz <= g1z; gz++) {
      const list = segGrid.get(gx + ',' + gz);
      if (!list) continue;
      for (const s of list) {
        const rx = s.bx - s.ax, rz = s.bz - s.az;
        const rl2 = rx * rx + rz * rz || 1e-9;
        let t = ((mx - s.ax) * rx + (mz - s.az) * rz) / rl2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = s.ax + rx * t, pz = s.az + rz * t;
        const vx = px - mx, vz = pz - mz;
        if (vx * e.nx + vz * e.nz <= 0) continue;              // behind the wall
        const rl = Math.sqrt(rl2);
        if (Math.abs((rx / rl) * e.dx + (rz / rl) * e.dz) < 0.70) continue;  // crossing, not fronting
        const d = Math.hypot(vx, vz) - s.half;
        if (d < best) best = d;
      }
    }
    out.push(Math.max(0, best));
  }
  return out;
}

function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '—'; }

function histogram(values, edges) {
  const bins = new Array(edges.length).fill(0);
  for (const v of values) {
    let k = edges.length - 1;
    for (let i = 0; i < edges.length; i++) if (v < edges[i]) { k = i; break; }
    bins[k]++;
  }
  return bins;
}

if (cmd === 'exposure') {
  const THRESH = +(arg ?? 3.0);
  const all = [];
  let edgesTotal = 0, exposedTotal = 0, exposedParty = 0;
  let multi = 0, multiOneFront = 0, frontNotExposed = 0;
  const byDistrict = new Map(), byStyle = new Map();

  for (const s of specs) {
    const ex = exposure(s);
    all.push(...ex);
    let nExposed = 0, nExposedParty = 0;
    for (let i = 0; i < ex.length; i++) {
      edgesTotal++;
      const isExposed = ex[i] < THRESH;
      const isFront = s.front.has(i);
      if (isExposed) {
        exposedTotal++; nExposed++;
        if (!isFront) { exposedParty++; nExposedParty++; }
      } else if (isFront) frontNotExposed++;
    }
    if (nExposed >= 2) {
      multi++;
      if (s.front.size === 1) multiOneFront++;
    }
    for (const [m, k] of [[byDistrict, s.district], [byStyle, s.style]]) {
      const r = m.get(k) || { n: 0, multi: 0, missed: 0, exposedParty: 0 };
      r.n++;
      if (nExposed >= 2) r.multi++;
      if (nExposed >= 2 && s.front.size === 1) r.missed++;
      r.exposedParty += nExposedParty;
      m.set(k, r);
    }
  }

  console.log(`\nSTREET EXPOSURE  (exposed = open street within ${THRESH} m of the edge)\n`);
  console.log(`buildings                              ${specs.length}`);
  console.log(`footprint edges                        ${edgesTotal}`);
  console.log(`  street-exposed                       ${exposedTotal}  (${pct(exposedTotal, edgesTotal)})`);
  console.log(`  street-exposed but NOT in spec.front ${exposedParty}  (${pct(exposedParty, exposedTotal)} of exposed)`);
  console.log(`  in spec.front but not exposed        ${frontNotExposed}`);
  console.log(`buildings with >=2 exposed edges       ${multi}  (${pct(multi, specs.length)})`);
  console.log(`  ...of which get only ONE front       ${multiOneFront}  (${pct(multiOneFront, multi)})`);

  const bins = histogram(all, [1, 2, 3, 5, 8, 15, 30, 60, 120]);
  console.log(`\nclearance histogram (m):`);
  const lbl = ['<1', '1-2', '2-3', '3-5', '5-8', '8-15', '15-30', '30-60', '60+'];
  bins.forEach((b, i) => console.log(`  ${lbl[i].padStart(6)}  ${String(b).padStart(6)}  ${pct(b, edgesTotal)}`));

  const table = (m, title) => {
    console.log(`\n${title}`);
    console.log(`  ${'key'.padEnd(14)} ${'n'.padStart(6)} ${'multi'.padStart(7)} ${'1-front'.padStart(8)} ${'expParty'.padStart(9)}`);
    for (const [k, r] of [...m].sort((a, b) => b[1].missed - a[1].missed)) {
      console.log(`  ${k.padEnd(14)} ${String(r.n).padStart(6)} ${String(r.multi).padStart(7)} ` +
        `${String(r.missed).padStart(8)} ${String(r.exposedParty).padStart(9)}`);
    }
  };
  table(byDistrict, 'by district');
  table(byStyle, 'by style');
}

if (cmd === 'lod') {
  // Wall relief and cost per LOD, split by whether the edge is a `front`.
  const rows = [];
  const N = Math.min(specs.length, +(arg ?? 1200));
  const step = Math.max(1, Math.floor(specs.length / N));
  const acc = {};
  for (const lod of [0, 1, 2]) acc[lod] = { front: [], party: [], tris: 0, n: 0, ms: 0 };
  for (let i = 0; i < specs.length; i += step) {
    const s = specs[i];
    for (const lod of [0, 1, 2]) {
      const mb = new MeshBuf(4096), gb = new GlassBuf(512);
      const t = performance.now();
      buildBuilding(s, mb, gb, lod);
      acc[lod].ms += performance.now() - t;
      acc[lod].tris += mb.ni / 3;
      acc[lod].n++;
      const r = edgeReport(s, mb);
      for (const e of r.edges) {
        (e.front ? acc[lod].front : acc[lod].party).push(
          { d: e.triPerM2, r: e.relief });
      }
    }
  }
  const mean = (v, k) => v.length ? v.reduce((a, x) => a + x[k], 0) / v.length : 0;
  console.log(`\nLOD COST AND WALL ARTICULATION  (${acc[0].n} buildings sampled)\n`);
  console.log(`  lod  tris/bldg   ms/bldg   front tri/m2  front relief   party tri/m2  party relief`);
  for (const lod of [0, 1, 2]) {
    const a = acc[lod];
    console.log(`  ${lod}    ${(a.tris / a.n).toFixed(0).padStart(9)}  ${(a.ms / a.n).toFixed(3).padStart(8)}` +
      `   ${mean(a.front, 'd').toFixed(2).padStart(12)}  ${mean(a.front, 'r').toFixed(3).padStart(12)}` +
      `   ${mean(a.party, 'd').toFixed(2).padStart(12)}  ${mean(a.party, 'r').toFixed(3).padStart(12)}`);
  }
  void rows;
}

if (cmd === 'edges') {
  const i = Math.max(0, Math.min(specs.length - 1, +(arg ?? 0)));
  const s = specs[i];
  const ex = exposure(s);
  console.log(`\n#${i}  ${s.style}  ${s.district}  ${s.storeys} storeys  h ${s.h.toFixed(1)} m` +
    `  front {${[...s.front].join(',')}} of ${s.poly.length}\n`);
  for (const lod of [0, 1, 2]) {
    const mb = new MeshBuf(4096), gb = new GlassBuf(512);
    buildBuilding(s, mb, gb, lod);
    const r = edgeReport(s, mb);
    console.log(`  lod ${lod}  (${r.tris} tris)`);
    for (const e of r.edges) {
      console.log(`    edge ${e.i}  ${e.front ? 'FRONT' : 'party'}  L=${e.L.toFixed(1).padStart(5)}m` +
        `  clearance=${ex[e.i].toFixed(1).padStart(5)}m  tris=${String(e.tris).padStart(5)}` +
        `  tri/m2=${e.triPerM2.toFixed(2).padStart(6)}  relief=${e.relief.toFixed(3)}`);
    }
  }
}
