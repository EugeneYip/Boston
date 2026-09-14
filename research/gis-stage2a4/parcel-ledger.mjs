/**
 * Stage 2A.4 — per-parcel causal ledger, one primary cause each.
 *
 *   node research/gis-stage2a4/parcel-ledger.mjs
 *
 * Stage 2A.3's table summed to 224, but its prose named "121 Huntington + 77
 * depth + 10 connector" = 208 and silently dropped 16 parcels that the table had
 * filed under a mechanism LABEL rather than a cause. This replaces the labels
 * with tests taken from `buildPlots` itself, so every class is decided by the
 * thing that actually produced the change.
 *
 * `buildPlots` computes, per EDGE and per SIDE:
 *
 *     acc   = length of `_frontageLine(e, side)`
 *     cfg   = ZONING[districtAt(midpoint of that frontage)]
 *     n     = max(1, round(acc / cfg.w))          <- integer lot count
 *     step  = acc / n                             <- the lot grid
 *     runs  = _clearFrontage(segs, acc)           <- frontage minus cross-street corridors
 *     depth = min of three rayToRoad casts, limit cfg.depth * 2 + 12
 *
 * Each of those five is a separate way a lot can change, and each is tested
 * directly:
 *
 *   LOT_PHASE_RECOMPUTED   `step` differs between the parcel's edge and its
 *                          counterpart. Every lot on the edge moves.
 *   BOUNDARY_FRONTAGE      the ROAD is inside the seam but its frontage line,
 *                          offset by `corridorHalf`, reaches past it. A street
 *                          lying on the core boundary must lay lots ~12 m
 *                          outside it; that is geometry, not leakage.
 *   RAY_TO_ROAD_DEPTH      same start, same width, different depth.
 *   FRONTAGE_OCCLUSION     same edge, same phase, but `_clearFrontage` returned
 *                          different runs because a nearby corridor changed.
 *   DISTRICT_RECLASSIFIED  the midpoint probe landed in a different district.
 *   CONNECTOR_FRONTAGE     the lot is on a synthetic transition connector.
 *   COORDINATE_ROUNDTRIP   the same lot, displaced under 0.5 m, because a
 *                          clipped street is re-authored as lat/lon at 7
 *                          decimals and comes back about a centimetre away.
 *
 * NOTE ON THE TOTAL. 224 counts changed parcel RECORDS across both worlds: a
 * lot that moved is counted once as the control record that vanished and once
 * as the candidate record that appeared. The ledger reports both the record
 * count and the distinct-lot count so neither is mistaken for the other.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const distOut = (p) => Math.hypot(Math.max(CORE.x0 - p.x, 0, p.x - CORE.x1), Math.max(CORE.z0 - p.z, 0, p.z - CORE.z1));
const man = JSON.parse(readFileSync(new URL('../gis-stage2a3/candidate-manifest.json', import.meta.url), 'utf8'));
const SEAM = man.finalSeam.extentM;
const TOL = 0.05;
const ROUNDTRIP_M = 0.5;   // an order of magnitude above the ~1.1 cm that 7-dp lat/lon costs

async function build(search, tag) {
  globalThis.location = search === null ? undefined : { search };
  const { buildCurrentWorld } = await import(`../gis-stage1a/current-world.mjs?v=${tag}`);
  const { makeBuilder } = await import(`../gis-stage1b1/pipeline.mjs?v=${tag}`);
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx); b._buildSpecs(ctx);
  return { world, b };
}
const RN = (await import('../../src/world/RoadNetwork.js')).default;
const C = await build(null, 'L1'), K = await build('?gisRoads=1', 'L2');

/** Reproduce buildPlots' per-edge, per-side lot grid exactly. */
function grid(world, e, side) {
  const line = world.net._frontageLine(e, side);
  let acc = 0; const segs = [];
  for (let i = 1; i < line.length; i++) {
    const L = Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    segs.push({ a: line[i - 1], b: line[i], L, s: acc }); acc += L;
  }
  if (acc < 6) return null;
  const probe = world.net._along(segs, acc / 2, acc);
  const dist = world.districts.districtAt(probe.x, probe.z);
  const cfg = (dist && dist in RN.ZONING) ? RN.ZONING[dist] : RN.ZONING.southEnd;
  if (!cfg) return { acc, dist, cfg: null };
  const n = Math.max(1, Math.round(acc / cfg.w));
  return { acc, dist, cfg, n, step: acc / n, runs: world.net._clearFrontage(segs, acc) };
}
/**
 * Do the two frontages have different clear runs?
 *
 * An edge cut on the lot grid keeps `step` but its arc ORIGIN moves to the cut,
 * so run boundaries must be compared in a common frame. The shift is the
 * difference in `acc` when the removed part was at the start, which is how the
 * generator cuts. Boundaries are compared from the OUTER end, which both worlds
 * share.
 */
function runsDiffer(g1, g2) {
  const fromEnd = (g) => g.runs.flatMap((r) => [g.acc - r[0], g.acc - r[1]]).sort((a, b) => a - b);
  const A = fromEnd(g1), B = fromEnd(g2);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) if (Math.abs(A[i] - B[i]) > TOL) return true;
  return A.length !== B.length;
}
/**
 * What depth would the OTHER world give this exact lot?
 *
 * `buildPlots` takes the minimum of three `rayToRoad` casts — midpoint and both
 * frontage ends — with limit `cfg.depth * 2 + 12`, then drops the lot outright
 * if the result is under `MIN_DEPTH`. Recomputing that in the other world turns
 * "the lot vanished" from an inference into a measurement.
 */
const MIN_DEPTH = 8;
function depthIn(world, p, cfg, ignoreEdgeId) {
  const a = p.frontage.a, b = p.frontage.b;
  const dir = { x: (p.polygon[3].x - a.x) / p.depth, z: (p.polygon[3].z - a.z) / p.depth };
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const lim = cfg.depth * 2 + 12;
  const reach = Math.min(world.net.rayToRoad(mx, mz, dir.x, dir.z, lim, ignoreEdgeId),
                         world.net.rayToRoad(a.x, a.z, dir.x, dir.z, lim, ignoreEdgeId),
                         world.net.rayToRoad(b.x, b.z, dir.x, dir.z, lim, ignoreEdgeId));
  // Exactly buildPlots: half the clear reach less a 0.6 m gap, capped by the
  // district depth, then shortened until the outline clears every corridor.
  let depth = Math.min(cfg.depth, Math.max(0, reach / 2 - 0.6));
  if (depth < MIN_DEPTH) return { reach, depth };
  depth = world.net._fitDepth(a, b, dir.x, dir.z, depth);
  return { reach, depth };
}
const gridCache = new Map();
const gridOf = (world, e, side, tag) => {
  const k = `${tag}:${e.id}:${side}`;
  if (!gridCache.has(k)) gridCache.set(k, grid(world, e, side));
  return gridCache.get(k);
};

const elen = (e) => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].z - e.pts[i - 1].z); return L; };
const ends = (e) => [e.pts[0], e.pts[e.pts.length - 1]];
const dSeg = (p, a, b) => { const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
  let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t)); };
function closestOnEdge(e, p) {
  let best = null;
  for (let i = 1; i < e.pts.length; i++) {
    const a = e.pts[i - 1], b = e.pts[i];
    const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
    let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const q = { x: a.x + vx * t, z: a.z + vz * t };
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (!best || d < best.d) best = { d, q };
  }
  return best.q;
}
const dPoly = (p, e) => { let best = Infinity; for (let i = 1; i < e.pts.length; i++) { const d = dSeg(p, e.pts[i - 1], e.pts[i]); if (d < best) best = d; } return best; };
/**
 * The edge in the other world that carries this same stretch of street.
 *
 * Same name is not enough. The candidate also contains a SAM edge of that name
 * inside the core and possibly a synthetic connector, and matching a procedural
 * lot to either of those invents a phase change that never happened — it put
 * four lots on Dartmouth, Boylston and Newbury into LOT_PHASE_RECOMPUTED when
 * the road audit shows no outside-core edge of theirs was split at all. Only a
 * procedural counterpart counts: not a connector, and not wholly inside the core.
 */
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
function twinEdge(e, p, other, connectorIds) {
  let best = null;
  for (const o of other.net.edges) {
    if (o.name !== e.name) continue;
    if (connectorIds.has(o.id)) continue;
    if (ends(o).every(inCore)) continue;
    const d = dPoly(p, o); if (!best || d < best.d) best = { d, o };
  }
  return best && best.d < 40 ? best.o : null;
}

/* ---- changed roads, for the influence envelope --------------------------- */
const sameEdge = (a, b) => a.name === b.name && Math.abs(elen(a) - elen(b)) < TOL &&
  ends(a).every((q) => ends(b).some((r) => Math.hypot(q.x - r.x, q.z - r.z) < TOL));
const cChanged = C.world.net.edges.filter((e) => !K.world.net.edges.some((o) => sameEdge(e, o)));
const kChanged = K.world.net.edges.filter((e) => !C.world.net.edges.some((o) => sameEdge(e, o)));
const changedSegs = [];
for (const e of [...cChanged, ...kChanged]) for (let i = 1; i < e.pts.length; i++) changedSegs.push([e.pts[i - 1], e.pts[i]]);
const distToChangedRoad = (p) => { let best = Infinity; for (const [a, b] of changedSegs) { const d = dSeg(p, a, b); if (d < best) best = d; } return best; };

const connVerts = man.connectorWorld;
const isConnector = (e) => ends(e).every((p) => connVerts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.6)) &&
  elen(e) <= Math.max(...man.connectors.lengths) + 1;
const kConnectorIds = new Set(K.world.net.edges.filter(isConnector).map((e) => e.id));

/* ---- the changed parcels -------------------------------------------------- */
const cP = C.b.plots.filter((p) => p.frontage), kP = K.b.plots.filter((p) => p.frontage);
const sig = (p) => `${p.width.toFixed(1)}_${p.depth.toFixed(1)}`;
const index = (arr) => { const m = new Map();
  for (const v of arr) { const q = v.frontage.a;
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const k = `${Math.round(q.x) + dx}_${Math.round(q.z) + dz}`;
      if (!m.has(k)) m.set(k, []); m.get(k).push(v); } }
  return m; };
const kIdx = index(kP), cIdx = index(cP);
const near = (idx, q, r) => (idx.get(`${Math.round(q.x)}_${Math.round(q.z)}`) || [])
  .filter((o) => Math.hypot(o.frontage.a.x - q.x, o.frontage.a.z - q.z) <= r);

const changed = [];
for (const p of cP) if (!near(kIdx, p.frontage.a, TOL).some((o) => sig(o) === sig(p))) changed.push({ p, from: 'control' });
for (const p of kP) if (!near(cIdx, p.frontage.a, TOL).some((o) => sig(o) === sig(p))) changed.push({ p, from: 'candidate' });
const beyond = changed.filter((c) => distOut(c.p.frontage.a) > SEAM + 0.01);

/* ---- classify ------------------------------------------------------------- */
const rows = [];
for (const { p, from } of beyond) {
  const mine = from === 'candidate' ? K : C, other = from === 'candidate' ? C : K;
  const myTag = from === 'candidate' ? 'k' : 'c', otTag = from === 'candidate' ? 'c' : 'k';
  const otherIdx = from === 'candidate' ? cIdx : kIdx;
  const e = mine.world.net.edges.find((q) => q.id === p.edgeId) || null;
  const a = p.frontage.a;
  const tw = e ? twinEdge(e, a, other.world, from === 'candidate' ? new Set() : kConnectorIds) : null;
  const g1 = e ? gridOf(mine.world, e, p.side, myTag) : null;
  const g2 = tw ? gridOf(other.world, tw, p.side, otTag) : null;
  const atSame = near(otherIdx, a, TOL);
  const nearby = near(otherIdx, a, ROUNDTRIP_M)
    .filter((o) => Math.abs(o.width - p.width) <= TOL && Math.abs(o.depth - p.depth) <= TOL);
  const rayLim = g1?.cfg ? g1.cfg.depth * 2 + 12 : 72;
  const toRoad = distToChangedRoad(a);
  // Is the ROAD that generated this lot inside the seam, even though the lot is
  // not? A frontage line sits `corridorHalf` off its centreline — 10-12 m in Back
  // Bay — so a street lying exactly on the core boundary necessarily lays lots up
  // to 12 m outside it. That is the road being contained and the frontage being
  // geometry, not a containment failure.
  const roadOut = e ? distOut(closestOnEdge(e, a)) : Infinity;
  const roadInSeam = roadOut <= SEAM + 0.01;

  let cause, note;
  if (from === 'candidate' && kConnectorIds.has(p.edgeId)) {
    cause = 'CONNECTOR_FRONTAGE'; note = 'lot generated on a synthetic transition connector';
  } else if (!atSame.length && roadInSeam) {
    // Decided BEFORE the phase test. A lot whose own road lies inside the seam
    // exists only because that road does, so comparing its lot grid to some
    // other edge of the same name invents a phase change: that is what put two
    // Dartmouth lots in LOT_PHASE_RECOMPUTED when the road audit shows no
    // outside-core Dartmouth edge changed at all.
    cause = 'BOUNDARY_FRONTAGE';
    note = `road is ${r2(roadOut)} m outside the core (inside the ${SEAM} m seam); its frontage line reaches ${r2(distOut(a))} m`;
  } else if (g1 && g2 && Math.abs(g1.step - g2.step) > 0.001) {
    cause = 'LOT_PHASE_RECOMPUTED';
    note = `step ${r2(g2.step)} -> ${r2(g1.step)} m (n ${g2.n} -> ${g1.n}, acc ${r2(g2.acc)} -> ${r2(g1.acc)} m)`;
  } else if (g1 && g2 && g1.dist !== g2.dist) {
    cause = 'DISTRICT_RECLASSIFIED'; note = `district ${g2.dist} -> ${g1.dist}`;
  } else if (!atSame.length && nearby.length) {
    // Only AFTER the phase test. A displacement under half a metre is not
    // automatically the lat/lon round trip: once Huntington's cut was corrected
    // its residual phase drift fell to 0.49 m, which has exactly the same
    // signature, and 56 lots were filed as storage precision when they are the
    // phase residual. The step comparison above now claims them first.
    cause = 'COORDINATE_ROUNDTRIP';
    note = `same lot displaced ${r2(Math.hypot(nearby[0].frontage.a.x - a.x, nearby[0].frontage.a.z - a.z))} m; step unchanged, so this is the 7-dp lat/lon re-authoring`;
  } else if (atSame.length && Math.abs(atSame[0].depth - p.depth) > TOL && Math.abs(atSame[0].width - p.width) <= TOL) {
    cause = 'RAY_TO_ROAD_DEPTH'; note = `depth ${r2(atSame[0].depth)} -> ${r2(p.depth)} m; ray limit ${rayLim} m, changed road ${r2(toRoad)} m away`;
  } else if (g1 && g2 && g1.runs && g2.runs && runsDiffer(g1, g2)) {
    // `step`, `n`, the district and the depth are all preserved, so the only
    // remaining input to `buildPlots` that can move a lot is `runs` — the
    // frontage minus every nearby road corridor. Verified, not inferred: the run
    // boundaries are compared directly.
    cause = 'FRONTAGE_OCCLUSION';
    note = `_clearFrontage runs ${JSON.stringify(g2.runs.map((r) => r.map(r2)))} -> ${JSON.stringify(g1.runs.map((r) => r.map(r2)))}` +
           (atSame.length ? `; width ${r2(atSame[0].width)} -> ${r2(p.width)} m` : `; lot start moved`);
  } else if (roadInSeam) {
    cause = 'BOUNDARY_FRONTAGE'; note = `road ${r2(roadOut)} m outside the core, frontage ${r2(distOut(a))} m`;
  } else if (g1?.cfg && tw && depthIn(other.world, p, g1.cfg, tw.id).depth < MIN_DEPTH) {
    const d = depthIn(other.world, p, g1.cfg, tw.id);
    cause = 'RAY_TO_ROAD_DEPTH';
    note = `lot dropped: in the other world rayToRoad reaches ${r2(d.reach)} m so depth is ${r2(d.depth)} m, under MIN_DEPTH ${MIN_DEPTH}; ray limit ${rayLim} m`;
  } else {
    cause = 'UNRESOLVED'; note = null;
  }
  rows.push({ from, cause, note, street: e?.name ?? null, edgeId: p.edgeId, side: p.side,
              x: r2(a.x), z: r2(a.z), beyondSeamM: r2(distOut(a)), distToChangedRoadM: r2(toRoad),
              district: g1?.dist ?? p.district, rayLimM: rayLim, width: r2(p.width), depth: r2(p.depth) });
}

/* ---- report --------------------------------------------------------------- */
const by = {};
for (const r of rows) { const b = (by[r.cause] ||= { n: 0, streets: {}, maxBeyondM: 0, maxToChangedRoadM: 0 });
  b.n++; b.streets[r.street ?? '(none)'] = (b.streets[r.street ?? '(none)'] || 0) + 1;
  b.maxBeyondM = Math.max(b.maxBeyondM, r.beyondSeamM);
  b.maxToChangedRoadM = Math.max(b.maxToChangedRoadM, r.distToChangedRoadM); }
const total = rows.length;
const sum = Object.values(by).reduce((a, b) => a + b.n, 0);
/** Distinct lots: a moved lot appears twice, once per world. */
let paired = 0;
for (const r of rows.filter((q) => q.from === 'control')) {
  if (rows.some((q) => q.from === 'candidate' && q.street === r.street &&
      Math.hypot(q.x - r.x, q.z - r.z) < 2.5)) paired++;
}
console.log(`ROAD_GEOMETRY_SEAM ${SEAM} m — changed parcel RECORDS beyond it: ${total}`);
console.log(`  (${rows.filter((r) => r.from === 'control').length} control-side, ${rows.filter((r) => r.from === 'candidate').length} candidate-side; ~${paired} are the same lot seen twice)\n`);
console.log(`${'primary cause'.padEnd(24)} ${'n'.padStart(4)} ${'maxBeyond'.padStart(10)} ${'maxToRoad'.padStart(10)}   streets`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n))
  console.log(`${k.padEnd(24)} ${String(v.n).padStart(4)} ${String(v.maxBeyondM).padStart(10)} ${String(v.maxToChangedRoadM).padStart(10)}   ` +
    Object.entries(v.streets).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', '));
console.log(`\nSUM ${sum} == TOTAL ${total}: ${sum === total}      UNRESOLVED: ${by.UNRESOLVED?.n ?? 0}`);
writeFileSync(new URL('./parcel-ledger.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a4/parcel-ledger/0.2.0', roadGeometrySeamM: SEAM,
    totalRecords: total, controlSide: rows.filter((r) => r.from === 'control').length,
    candidateSide: rows.filter((r) => r.from === 'candidate').length, pairedSameLot: paired,
    byCause: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.n])),
    unresolved: by.UNRESOLVED?.n ?? 0, sumsExactly: sum === total, detail: by, parcels: rows }, null, 1) + '\n');
