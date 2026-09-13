/**
 * Stage 2A.3 — invariants for the structural port closure.
 *
 *   node research/gis-stage2a3/validate.mjs
 *
 * SUPERSEDES ONE STAGE 2A.1 INVARIANT, deliberately and in the open.
 * `research/gis-stage2a1/validate.mjs` asserts `connectors are short`, defined
 * as `lengthM <= 40`. That is the same 40 m bound Stage 2A.2 used to decide
 * which ports to join, and this stage's central measurement is that no such
 * bound exists: Boston's hand-authored registration error is per-street (0.2 m
 * on Boylston, 44 m on Exeter, 57 m on Commonwealth Inbound) and a boundary
 * crossing multiplies it by `1 / sin(angle to the face)` — 18.5 degrees for Back
 * Bay's grid against the core's north face, so 30 m of offset becomes 94 m of
 * separation. A length gate therefore measures the crossing angle as much as
 * the error.
 *
 * The property that gate was reaching for is that a connector is a LOCAL
 * handover and not an invented street, so that is what is asserted here
 * directly, and without a constant: a connector must cross no other road.
 *
 * The 2A.1 file is left exactly as it was. It is the record of what Stage 2A.1
 * claimed, and rewriting it would hide the fact that a claim was retired.
 */
import { readFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo } from '../../src/core/Geo.js';
import * as ROADS from '../../src/data/gis-backbay-roads.js';

const { GIS_ROADS, GIS_ROADS_CLIPPED, GIS_ROADS_CONNECTORS } = ROADS;
const man = JSON.parse(readFileSync(new URL('./candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const W = (ll) => geo(ll[0], ll[1]);

/** Segments incident to a connector end are meetings, not crossings. See the generator. */
const VTOL = 0.05;
function properlyCrosses(a0, a1, b0, b1) {
  for (const q of [b0, b1]) for (const p of [a0, a1]) if (Math.hypot(q.x - p.x, q.z - p.z) <= VTOL) return false;
  const rx = a1.x - a0.x, rz = a1.z - a0.z, sx = b1.x - b0.x, sz = b1.z - b0.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((b0.x - a0.x) * sz - (b0.z - a0.z) * sx) / den;
  const u = ((b0.x - a0.x) * rz - (b0.z - a0.z) * rx) / den;
  const E = 1e-4;
  return t > E && t < 1 - E && u > E && u < 1 - E;
}
/** Every road the shipped candidate actually contains, as world polylines. */
const others = [];
for (const r of GIS_ROADS) others.push({ name: r.name, pts: r.path.map(W) });
for (const c of GIS_ROADS_CLIPPED) for (const run of c.runs) others.push({ name: c.name, pts: run.path.map(W) });
const clippedNames = new Set(GIS_ROADS_CLIPPED.map((c) => c.name));
for (const st of STREETS) if (!clippedNames.has(st.name)) others.push({ name: st.name, pts: st.path.map(W) });
for (const k of GIS_ROADS_CONNECTORS) others.push({ name: k.name, pts: k.path.map(W), connector: true });

let crossHits = 0;
for (const k of GIS_ROADS_CONNECTORS) {
  const [a0, a1] = [W(k.path[0]), W(k.path[k.path.length - 1])];
  for (const o of others) {
    if (o.name === k.name) continue;                      // its own two ends
    for (let i = 1; i < o.pts.length; i++) if (properlyCrosses(a0, a1, o.pts[i - 1], o.pts[i])) { crossHits++; break; }
  }
}

/** Commonwealth's two carriageways must never be joined to each other. */
const commCross = GIS_ROADS_CONNECTORS.some((k) => {
  if (!/Commonwealth/.test(k.name)) return false;
  const mate = k.name.includes('Inbound') ? 'Outbound' : 'Inbound';
  return (man.portLedger.find((p) => p.street === k.name && p.pairedTo)?.pairedTo || {}).street === `Commonwealth Avenue ${mate}`;
});

const ledger = man.portLedger;
const connected = ledger.filter((p) => p.ownership === 'CONNECTED');
const terminal = ledger.filter((p) => p.ownership !== 'CONNECTED');
const noSnapStreets = new Set(GIS_ROADS.filter((r) => r.noSnap?.length).map((r) => r.name));
const cutPts = man.lotCuts.map((c) => c.point);
const nearCut = (p) => cutPts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.6);

const checks = {
  'every port is classified exactly once':
    ledger.length === man.connectors.ports && ledger.every((p) => typeof p.ownership === 'string'),
  'connected + terminal accounts for every port':
    connected.length + terminal.length === ledger.length,
  'every connector joins the SAME road concept':
    GIS_ROADS_CONNECTORS.every((k) => GIS_ROADS.some((r) => r.name === k.name)),
  'Commonwealth Inbound and Outbound are never cross-connected': !commCross,
  'every connector crosses no other road (supersedes 2A.1 "connectors are short")': crossHits === 0,
  'every connector ends on a LOT-GRID CUT, never an arbitrary baseline node':
    GIS_ROADS_CONNECTORS.every((k) => nearCut(W(k.path[0])) || nearCut(W(k.path[k.path.length - 1]))),
  'no connector claims to be factual':
    GIS_ROADS_CONNECTORS.every((k) => k.transitionConnector === true && !k.sam),
  'every connector vertex lies within the declared seam':
    GIS_ROADS_CONNECTORS.every((k) => k.path.every((ll) => distOut(W(ll)) <= SEAM + 0.01)),
  'every TERMINAL port carries noSnap':
    terminal.every((p) => noSnapStreets.has(p.street)),
  'every orphan cut stub carries noSnap':
    man.orphanCuts.every((o) => GIS_ROADS_CLIPPED.some((c) => c.name === o.street &&
      c.runs.some((r) => r.noSnap?.length))),
  'no hand-authored street carries noSnap (data-only opt-in)':
    STREETS.every((s) => s.noSnap === undefined),
  'lot-grid cut is exactly in phase wherever both frontages agree on lot count':
    man.lotCuts.every((c) => (c.sideLots[0] === c.sideLots[1]) ? c.phaseErrorM === 0 : true),
  'the only out-of-phase cut is the one bent edge, and it is declared':
    man.lotCuts.filter((c) => c.phaseErrorM > 0).every((c) => c.sideLots[0] !== c.sideLots[1]),
  'factual geometry still does not overhang the core':
    GIS_ROADS.every((r) => r.path.every((ll) => { const g = W(ll); return inCore(g) || distOut(g) < 0.5; })),
  'every lot-grid cut lies outside the core':
    man.lotCuts.every((c) => !inCore(c.point)),
  'no rejected connector was silently kept':
    man.rejectedConnectors.every((r) => !GIS_ROADS_CONNECTORS.some((k) =>
      k.name === r.street && Math.abs(k.lengthM - r.lengthM) < 0.01)),
};
let fail = 0;
for (const [k, v] of Object.entries(checks)) { if (!v) fail++; console.log(`${v ? ' ok  ' : 'FAIL '} ${k}`); }
console.log(fail ? `\n${fail} FAILED` : `\nall ${Object.keys(checks).length} invariants hold`);
console.log(`\nports ${ledger.length}: ${connected.length} connected, ${terminal.length} terminal`);
for (const o of [...new Set(terminal.map((p) => p.ownership))]) {
  console.log(`  ${o}: ${terminal.filter((p) => p.ownership === o).map((p) => `${p.street}/${p.face}`).join(', ')}`);
}
console.log(`connectors ${GIS_ROADS_CONNECTORS.length}, max ${Math.max(...GIS_ROADS_CONNECTORS.map((k) => k.lengthM))} m, all crossing 0 roads`);
console.log(`rejected as non-local: ${man.rejectedConnectors.map((r) => `${r.street}/${r.face} ${r.lengthM} m`).join('; ')}`);
process.exitCode = fail ? 1 : 0;
