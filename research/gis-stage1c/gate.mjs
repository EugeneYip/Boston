/**
 * Stage 1C phase 4 — frozen streetwall-confidence gate, and the classification.
 *
 *   node research/gis-stage1c/gate.mjs
 *
 * The gate has three clauses and each one answers a question the brief asks.
 * All three were chosen AFTER the distributions in `envelope.json`,
 * `classify.json` and `roadcheck.json` were measured.
 *
 *   1. SOURCES AGREE. Both allowed sources must see a wall over most of the
 *      face and place it within `tolM`. The measured agreement is sharply
 *      bimodal — 79.6% of samples agree within 0.25 m and the rest miss by a
 *      building — so any tolerance from 0.25 m to 2 m selects the same faces.
 *      0.5 m is the middle of that dead band.
 *   2. THE IMPLIED STREET IS POSSIBLE. Taking both faces of one road, the
 *      factual wall-to-wall width must be within `widthTolM` of Boston's own.
 *      This is the clause that cannot be argued with: a street whose implied
 *      width is negative is not a street.
 *   3. THE ROAD IS WHERE THE DATA THINKS IT IS. The shift component,
 *      (d_side0 - d_side1)/2, must be small. A large shift means Boston's road
 *      centreline is not the real one, and a wall aligned to the data would be
 *      corrected against the wrong reference.
 *
 * Clause 2 exists because clause 1 alone is not enough, and that is the whole
 * finding of this stage: the sources agree with each other beautifully and
 * still cannot be used, because what they agree about is a city whose streets
 * are somewhere else.
 */
import { writeFileSync } from 'node:fs';
import { analyse } from './classify.mjs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';

export const GATE = Object.freeze({
  version: 'stage1c-streetwall/1.0.0',
  tolM: 0.5,              // source-to-source first-wall agreement
  minAgreePct: 70,        // of the face's samples
  minBothPct: 80,         // both sources must actually see a wall
  widthTolM: 4.0,         // |implied factual street width - procedural width|
  maxShiftM: 2.0,         // road-centreline registration
  maxSlopeDisagreeDeg: 3, // the two sources must agree on the wall's direction
  minRunM: 25,            // a run shorter than this cannot carry a visual verdict
});

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

const A = analyse(GATE.tolM);
const net = A.F.world.net;

// Pair the faces of each road so the width and shift clauses can be evaluated.
const byEdge = new Map();
for (const f of A.perFace) {
  let e = byEdge.get(f.edgeId);
  if (!e) byEdge.set(f.edgeId, e = { edgeId: f.edgeId, street: f.street, faces: {} });
  e.faces[f.side] = f;
}

const classified = [];
for (const f of A.perFace) {
  const e = byEdge.get(f.edgeId);
  const other = e.faces[f.side ? 0 : 1];
  const ch = corridorHalf(net.edges[f.edgeId]);
  const procW = 2 * ch;
  let factW = null, shift = null;
  if (other && other.dMedian !== null && f.dMedian !== null) {
    factW = procW + f.dMedian + other.dMedian;
    shift = (f.side ? other.dMedian - f.dMedian : f.dMedian - other.dMedian) / 2;
  }
  let state;
  if (f.bothPct < GATE.minBothPct && f.dMedian === null) state = 'STREETWALL_NO_SUPPORT';
  else if (f.bothPct < GATE.minBothPct) state = 'STREETWALL_SINGLE_SOURCE';
  else if (f.agreePct < GATE.minAgreePct) state = 'STREETWALL_SOURCE_DISAGREEMENT';
  else if (f.slopeDisagreeDeg === null || f.slopeDisagreeDeg > GATE.maxSlopeDisagreeDeg) state = 'STREETWALL_ORIENTATION_AMBIGUOUS';
  else if (factW === null) state = 'STREETWALL_NO_OPPOSITE_FACE';
  else if (Math.abs(factW - procW) > GATE.widthTolM) state = 'STREETWALL_ROAD_FRAME_INVALID';
  else if (Math.abs(shift) > GATE.maxShiftM) state = 'STREETWALL_ROAD_FRAME_INVALID';
  else state = 'STREETWALL_HIGH_CONFIDENCE';
  classified.push({ key: f.key, street: f.street, edgeId: f.edgeId, side: f.side, frontageM: f.frontageM,
    parcels: f.parcels, bothPct: f.bothPct, agreePct: f.agreePct, dMedian: f.dMedian, dMad: f.dMad,
    slopeDisagreeDeg: f.slopeDisagreeDeg, proceduralWidthM: r2(procW), factualWidthM: r2(factW),
    shiftM: r2(shift), state });
}

const tally = classified.reduce((m, c) => (m[c.state] = (m[c.state] || 0) + 1, m), {});
const high = classified.filter((c) => c.state === 'STREETWALL_HIGH_CONFIDENCE');
const runs = A.allRuns.filter((r) => r.lengthM >= GATE.minRunM && !r.heroOrReserved &&
  high.some((h) => h.key === r.faceKey));

console.log(`frozen gate ${GATE.version}: ${JSON.stringify(GATE)}\n`);
console.log('state                              faces   frontage m');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  const m = classified.filter((c) => c.state === k).reduce((s, c) => s + c.frontageM, 0);
  console.log(`${k.padEnd(36)} ${String(v).padStart(3)} ${m.toFixed(0).padStart(11)}`);
}
console.log(`\nHIGH-CONFIDENCE faces: ${high.length}`);
console.log(`Eligible runs >= ${GATE.minRunM} m on a high-confidence face: ${runs.length}`);

console.log('\n=== why each of the best-agreeing faces failed ===');
console.log('street                        key    agree%  dMed   procW  factW   shift  state');
for (const c of classified.filter((c) => c.agreePct >= GATE.minAgreePct).sort((a, b) => b.agreePct - a.agreePct).slice(0, 14))
  console.log(`${c.street.padEnd(29)} ${c.key.padEnd(6)} ${String(c.agreePct).padStart(6)} ${String(c.dMedian).padStart(6)} ` +
    `${String(c.proceduralWidthM).padStart(6)} ${String(c.factualWidthM).padStart(6)} ${String(c.shiftM).padStart(7)}  ${c.state}`);

writeFileSync(new URL('./gate.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage1c/gate/0.1.0', gate: GATE, tally,
    highConfidenceFaces: high.length, eligibleRuns: runs.length, runs, faces: classified }, null, 1) + '\n');
