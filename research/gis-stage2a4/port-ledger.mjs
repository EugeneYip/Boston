/**
 * Stage 2A.4 — final state of every factual boundary port.
 *
 *   node research/gis-stage2a4/port-ledger.mjs
 *
 * Stage 2A.3 classified 23 ports into its own five working classes. This maps
 * them onto the Owner's final, mutually exclusive states and proves the sum,
 * and for every LEGACY_BOUNDARY_INCOMPATIBLE port records the full case: the
 * counterpart that was attempted, why an honest local connector is impossible,
 * whether forcing it would cross another road or reverse a carriageway, and
 * what it costs routing.
 *
 * The distinction that matters:
 *
 *   LEGACY_BOUNDARY_INCOMPATIBLE  a legacy road concept EXISTS and crosses the
 *     boundary, but joining to it would be geographically WRONG — because the
 *     hand-authored line is on the wrong side of a divided boulevard, or crosses
 *     a different face entirely. The fault is in the legacy geometry, and future
 *     factual expansion removes the boundary rather than the port.
 *
 *   INTENTIONALLY_TERMINAL  no legacy counterpart crosses that face at all, so
 *     there is nothing to join to. The factual street simply continues past the
 *     edge of the prototype.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const man = JSON.parse(readFileSync(new URL('../gis-stage2a3/candidate-manifest.json', import.meta.url), 'utf8'));
const sink = JSON.parse(readFileSync(new URL('../gis-stage2a3/gis-stage2a2-sink.json', import.meta.url), 'utf8'));

/** Stage 2A.3 working class -> Owner final state, with the reason for the mapping. */
const MAP = {
  CONNECTED: ['CONNECTED', 'joined to the lot-grid cut stub of its own concept on its own boundary face'],
  TERMINAL_HANDOVER_NOT_LOCAL: ['LEGACY_BOUNDARY_INCOMPATIBLE',
    'the legacy concept crosses this face, but the only connector to it crosses another road or the opposite carriageway'],
  TERMINAL_COUNTERPART_CROSSES_ANOTHER_FACE: ['LEGACY_BOUNDARY_INCOMPATIBLE',
    'the legacy concept crosses a DIFFERENT face of the core, so no local connector exists on this one'],
  TERMINAL_NO_PROCEDURAL_COUNTERPART: ['INTENTIONALLY_TERMINAL',
    'no legacy street of this concept crosses the core boundary anywhere; the factual street runs past the edge of the prototype'],
  TERMINAL_COUNTERPART_ALREADY_PAIRED: ['INTENTIONALLY_TERMINAL',
    'the factual street crosses this face more often than the legacy one does; the surplus crossing has no counterpart to take'],
};
const rej = man.rejectedConnectors;
const ports = man.portLedger.map((p) => {
  const [state, why] = MAP[p.ownership];
  const r = rej.find((q) => q.street === p.street && q.face === p.face) || null;
  const row = { street: p.street, samSegmentId: p.samSegmentId, face: p.face, dir: p.dir,
                oneway: p.oneway, x: p.x, z: p.z, stage2a3Class: p.ownership, finalState: state, why };
  if (state === 'CONNECTED') row.connector = p.pairedTo;
  if (state === 'LEGACY_BOUNDARY_INCOMPATIBLE') {
    row.attemptedCounterpart = r ? { lengthM: r.lengthM, crossings: r.crossings, through: r.through }
      : { lengthM: null, crossings: null, through: [], note: 'no counterpart on this face to attempt' };
    row.wouldCrossAnotherRoad = r ? r.crossings > 0 : false;
    row.wouldReverseCarriageway = !!(r && r.through.some((t) => /Commonwealth/.test(t) &&
      t.replace('connector:', '') !== p.street));
  }
  return row;
});

/* ---- the four candidate-only dead ends, matched to their port ------------- */
const cSet = new Set(sink.control.sinks.map((n) => `${Math.round(n.x * 10)}_${Math.round(n.z * 10)}`));
const onlyK = sink.candidate.sinks.filter((n) => !cSet.has(`${Math.round(n.x * 10)}_${Math.round(n.z * 10)}`));
const cutPts = man.lotCuts.map((c) => c.point);
const deadEnds = onlyK.map((n) => {
  const port = ports.map((p) => ({ p, d: Math.hypot(p.x - n.x, p.z - n.z) })).sort((a, b) => a.d - b.d)[0];
  const cut = cutPts.map((c) => ({ c, d: Math.hypot(c.x - n.x, c.z - n.z) })).sort((a, b) => a.d - b.d)[0];
  const isPort = port.d < 1.0;
  const isCut = cut.d < 1.0;
  return { node: n.node, x: n.x, z: n.z, distFromCoreM: n.distFromCore, forwardReach: n.forwardReach,
           incoming: [...new Set(n.incoming.map((i) => i.name))], outgoing: [...new Set(n.outgoing.map((o) => o.name))],
           classification: isPort ? `FACTUAL PORT — ${port.p.finalState}`
             : isCut ? 'ORPHAN LOT-GRID CUT STUB — the legacy side of the same incompatibility'
             : 'UNCLASSIFIED',
           port: isPort ? { street: port.p.street, face: port.p.face, state: port.p.finalState } : null,
           cutStreet: !isPort && isCut ? cut.c : null,
           ordinaryRoutingSink: false };
});

const tally = {};
for (const s of ['CONNECTED', 'LEGACY_BOUNDARY_INCOMPATIBLE', 'INTENTIONALLY_TERMINAL',
                 'GRADE_SEPARATED_EXCLUDED', 'NON_ROAD_EXCLUDED', 'OTHER_JUSTIFIED', 'UNRESOLVED'])
  tally[s] = ports.filter((p) => p.finalState === s).length;
const sum = Object.values(tally).reduce((a, b) => a + b, 0);

console.log(`factual boundary ports: ${ports.length}\n`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(30)} ${v}`);
console.log(`\nSUM ${sum} == 23 ? ${sum === ports.length && sum === 23}     UNRESOLVED ${tally.UNRESOLVED}`);
console.log(`\nCommonwealth ports, individually:`);
for (const p of ports.filter((q) => /Commonwealth/.test(q.street)))
  console.log(`  ${p.street.padEnd(30)} ${p.face}/${p.dir}  ${p.finalState}` +
    (p.connector ? `  connector ${p.connector.connectorM} m` : `  attempted ${p.attemptedCounterpart.lengthM} m, crosses ${p.attemptedCounterpart.crossings}`));
console.log(`\ncandidate-only dead ends: ${deadEnds.length}`);
for (const d of deadEnds)
  console.log(`  node ${String(d.node).padStart(4)} (${d.x}, ${d.z}) reach ${d.forwardReach}  in[${d.incoming}] out[${d.outgoing || 'NONE'}]\n      ${d.classification}`);
console.log(`\nordinary unintended routing sinks: ${deadEnds.filter((d) => d.classification === 'UNCLASSIFIED').length}`);
writeFileSync(new URL('./port-ledger.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a4/port-ledger/0.1.0', totalPorts: ports.length, tally,
    sumsExactly: sum === 23, unresolved: tally.UNRESOLVED, ports, deadEnds,
    ordinaryUnintendedSinks: deadEnds.filter((d) => d.classification === 'UNCLASSIFIED').length,
    excludedFactualFeatures: man.excludedFeatures }, null, 1) + '\n');
