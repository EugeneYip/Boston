/**
 * Stage 2A.1 task 2 — derive the transition seam from TOPOLOGY, not a buffer.
 *
 *   node research/gis-stage2a1/seam-design.mjs
 *
 * The Stage 2A blast radius has two compounding causes, both measured in
 * `blast-trace.json` and `why`:
 *
 *   1. The factual streets reach up to **163.2 m beyond the core** — SAM
 *      features were selected by *intersects*, so whole segments overhang. Out
 *      there they cross hand-authored streets and move those junctions.
 *   2. `RoadNetwork.buildPlots` subdivides **per edge**: `n = round(acc/cfg.w)`.
 *      Move either endpoint of an edge and every lot along its whole length
 *      re-phases. Gloucester Street was neither clipped nor factually replaced
 *      and still lost 81 parcels 157 m out, purely because a factual line
 *      crossed it beyond the box.
 *
 * So containment needs the factual geometry clipped to the core AND the
 * hand-authored cuts placed at **existing junction nodes**, so that every edge
 * outside the seam keeps both endpoints exactly and regenerates bit-identically.
 *
 * This file measures where those anchors are so the seam extent is a
 * consequence of Boston's own road topology rather than a number someone chose.
 */
import { writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo } from '../../src/core/Geo.js';

const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));

globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const world = buildCurrentWorld();

/** Junction nodes of the BASELINE graph — degree >= 3, the stable cuts. */
const junctions = world.net.nodes.filter((n) => n && (n.edges?.length ?? 0) >= 3);
console.log(`baseline junctions: ${junctions.length} citywide, ${junctions.filter(inCore).length} inside the core`);

/**
 * For each hand-authored street entering the core, the nearest baseline
 * junction OUTSIDE the core on each side of its core crossing. Cutting there
 * — rather than at the bbox line — is what lets the outside edges survive
 * untouched, because an edge is delimited by junctions.
 */
const anchors = [];
for (let si = 0; si < STREETS.length; si++) {
  const s = STREETS[si];
  const w = s.path.map(([la, lo]) => geo(la, lo));
  if (!w.some(inCore)) continue;
  // Walk the path; each time it leaves/enters the core, find the next junction.
  const idxIn = w.map(inCore);
  for (let i = 0; i < w.length; i++) {
    const boundary = (i > 0 && idxIn[i] !== idxIn[i - 1]);
    if (!boundary) continue;
    const outIdx = idxIn[i] ? i - 1 : i;
    // nearest baseline junction to this outside vertex, that is itself outside
    let best = null;
    for (const n of junctions) {
      if (inCore(n)) continue;
      const d = Math.hypot(n.x - w[outIdx].x, n.z - w[outIdx].z);
      if (!best || d < best.d) best = { d, n };
    }
    if (best) anchors.push({ street: s.name, streetIndex: si, vertex: outIdx,
      at: { x: r2(w[outIdx].x), z: r2(w[outIdx].z) },
      anchor: { x: r2(best.n.x), z: r2(best.n.z) },
      anchorDistM: r2(best.d), anchorBeyondCoreM: r2(distOut(best.n)) });
  }
}
anchors.sort((a, b) => (a.street < b.street ? -1 : a.street > b.street ? 1 : a.vertex - b.vertex));
const beyond = anchors.map((a) => a.anchorBeyondCoreM).sort((a, b) => a - b);
console.log(`\nseam anchors (nearest outside junction per core crossing): ${anchors.length}`);
console.log('street                          crossing at        anchor at         dist   beyondCore');
for (const a of anchors) console.log(`  ${a.street.padEnd(30)} (${String(a.at.x).padStart(8)},${String(a.at.z).padStart(7)}) (${String(a.anchor.x).padStart(8)},${String(a.anchor.z).padStart(7)}) ${String(a.anchorDistM).padStart(7)} ${String(a.anchorBeyondCoreM).padStart(10)}`);
console.log(`\nanchor distance beyond the core: min ${beyond[0]} m  median ${beyond[Math.floor(beyond.length / 2)]} m  max ${beyond[beyond.length - 1]} m`);
console.log('=> the seam is the annulus out to the furthest anchor; it is a property of Boston\'s junction spacing, not a chosen buffer.');

const out = { schemaVersion: 'boston-gis-stage2a1/seam-design/0.1.0', core: CORE,
  baselineJunctions: junctions.length, junctionsInCore: junctions.filter(inCore).length,
  anchors, anchorBeyondCoreM: { min: beyond[0], median: beyond[Math.floor(beyond.length / 2)], max: beyond[beyond.length - 1] } };
writeFileSync(new URL('./seam-design.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
