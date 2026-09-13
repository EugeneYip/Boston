/**
 * Stage 2A.3 — contained candidate generator, with STRUCTURAL port closure.
 *
 *   node research/gis-stage2a3/build-candidate.mjs
 *
 * Supersedes `research/gis-stage2a2/build-candidate.mjs`. Same source, same
 * provenance, same frozen factual core, same lot-grid cut. Only the seam JOIN
 * changes, and it changes from a distance search to a structural one.
 *
 * ## Why the Stage 2A.2 join left 14 of 23 ports open
 *
 * Stage 2A.2 joined a factual port to "the nearest Boston stub end of the same
 * road concept, within 40 m", then ran a second pass from the stub ends to make
 * the join symmetric. The second pass never emitted anything, and instrumenting
 * it showed why with no ambiguity: of 34 stub ends, 17 were rejected as far ends
 * (`d0 > 25`), 8 were rejected by the dedup key because pass 1 had already
 * emitted that exact pair, and 9 were rejected by the same 40 m bound that
 * rejected them from the port side. Euclidean distance is SYMMETRIC, so a second
 * pass over a symmetric predicate cannot admit a pair the first pass refused.
 * The pass was structurally incapable of firing.
 *
 * The 40 m bound was the real gate, and no bound would have worked. Stage 1D
 * already established that `boston-geo.js` is hand-authored and sits a median
 * ~25 m from reality, and the error is PER-STREET, not a global transform:
 * measured centreline-to-centreline here, Boylston is 0.2 m out, Newbury 8 m,
 * Blagden 31 m, Exeter 44 m, Commonwealth Inbound 57 m. A threshold that admits
 * Exeter admits half of Back Bay's unrelated alleys too.
 *
 * Worse, a boundary crossing amplifies that error. Back Bay's grid meets the
 * core's axis-aligned north face at about 18.5 degrees, so Commonwealth's 30 m
 * lateral offset becomes a 94 m displacement ALONG the boundary. Distance
 * between boundary crossings measures the crossing angle as much as the
 * registration error, which is why it sorts nothing.
 *
 * ## What replaces it
 *
 * A street crossing a box crosses a SPECIFIC FACE, and it crosses the faces in a
 * specific ORDER. Registration error moves a crossing along a face; it does not
 * move it to another face and it cannot reorder two crossings of the same face.
 * So ports and crossings are paired by
 *
 *     (road concept, boundary face, order along that face)
 *
 * with a one-way flow-compatibility filter, resolved by a monotone alignment
 * that preserves order and may leave either side unpaired. Distance is a
 * TIE-BREAK inside an already structural class, never the class itself.
 *
 * That closes 14 of 23 ports instead of 9. The remaining 9 are not failures:
 * they are ports whose concept has no procedural crossing of that face at all,
 * because Boston's version of the street never enters the core there. They are
 * TERMINAL by construction, and they are marked `noSnap` so that
 * `RoadNetwork.build()`'s 21 m dangling-endpoint snap cannot adopt them.
 *
 * ## Why `noSnap` is the point of this stage
 *
 * An unjoined port is not inert. Endpoint snapping pulls it onto whatever edge
 * is nearest and SPLITS that edge mid-edge, and `buildPlots` phases lots per
 * EDGE — so a mid-edge split re-phases every lot along the whole edge, hundreds
 * of metres outside the seam. That is the entire 295-parcel leak. Measured on
 * the Stage 2A.2 candidate, the snap targets were all wrong streets: Dartmouth
 * onto Public Alley 442 at 8.06 m, Fairfield onto Public Alley 435 at 17.76 m,
 * Exeter onto Commonwealth Avenue Outbound at 10.57 m, and — the one the brief
 * names explicitly — Commonwealth Outbound onto Commonwealth INBOUND at 16.06 m
 * and Inbound onto Outbound at 14.47 m. The candidate was cross-connecting the
 * two carriageways of a divided boulevard through the seam.
 *
 * `noSnap` is per-endpoint and opt-in from data, so no baseline street carries
 * it and the control world is untouched by construction.
 *
 * ## Inherited from Stage 2A.2, unchanged
 *
 * The lot-boundary phase identity (cut at `p = k*step` and both halves keep
 * `step`), the per-vertex attribute slicing for `median`/`y`/`bridge`, the clip
 * of factual geometry to the core, and the interpolated boundary vertex.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { STREETS } from '../../src/data/boston-geo.js';
import { geo, unGeo } from '../../src/core/Geo.js';
import { BBOX_WORLD as CORE } from '../gis-stage1a/bbox.mjs';

const FIX = JSON.parse(readFileSync(new URL('../gis-stage1e/backbay-roads.json', import.meta.url), 'utf8'));
const r7 = (v) => Math.round(v * 1e7) / 1e7;
const r2 = (v) => Math.round(v * 100) / 100;
const inCore = (p) => p.x >= CORE.x0 && p.x <= CORE.x1 && p.z >= CORE.z0 && p.z <= CORE.z1;
const PER_VERTEX = ['median', 'y', 'bridge'];

/**
 * Which face of the core box a boundary point sits on, and where along the
 * box perimeter it sits. The perimeter coordinate runs once around the box, so
 * "order along a face" is just numeric order of `arcOf` within one face.
 */
const FACE_W = CORE.x1 - CORE.x0, FACE_H = CORE.z1 - CORE.z0;
function faceOf(p) {
  const d = [['x0', Math.abs(p.x - CORE.x0)], ['x1', Math.abs(p.x - CORE.x1)],
             ['z0', Math.abs(p.z - CORE.z0)], ['z1', Math.abs(p.z - CORE.z1)]];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][0];
}
function arcOf(p) {
  switch (faceOf(p)) {
    case 'z0': return p.x - CORE.x0;
    case 'x1': return FACE_W + (p.z - CORE.z0);
    case 'z1': return FACE_W + FACE_H + (CORE.x1 - p.x);
    default:   return 2 * FACE_W + FACE_H + (CORE.z1 - p.z);
  }
}
/** Every crossing of the core boundary by a hand-authored street. */
const crossings = [];

/* ---- baseline junctions: the only legal places to cut -------------------- */
globalThis.location = undefined;
const { buildCurrentWorld } = await import('../gis-stage1a/current-world.mjs');
const baseline = buildCurrentWorld();
const junctions = baseline.net.nodes.filter((n) => n && (n.edges?.length ?? 0) >= 3 && !inCore(n));

/* ---- 1. semantic mapping (unchanged from Stage 2A) ----------------------- */
function normName(s) {
  return (s || '').toLowerCase().replace(/\bno\.?\s+/g, '')
    .replace(/\b(street|st)\b/g, 'st').replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd').replace(/\b(square|sq)\b/g, 'sq')
    .replace(/\b(plaza|plz)\b/g, 'plz').replace(/\b(turnpike|tpke)\b/g, 'tpke')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
const bostonByName = new Map();
for (const s of STREETS) {
  const k = normName(s.name);
  if (!bostonByName.has(k)) bostonByName.set(k, []);
  bostonByName.get(k).push(s);
}
const bostonWorld = new Map(STREETS.map((s) => [s, s.path.map(([la, lo]) => geo(la, lo))]));
const distToStreet = (p, s) => {
  const w = bostonWorld.get(s);
  let best = Infinity;
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1], b = w[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    let t = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
    if (d < best) best = d;
  }
  return best;
};
/** Unit direction of travel along a Boston street, honouring its `oneway` sign. */
function flowDir(st) {
  const w = bostonWorld.get(st);
  const a = w[0], b = w[w.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  const sgn = st.oneway < 0 ? -1 : 1;
  return { x: (dx / L) * sgn, z: (dz / L) * sgn };
}
/**
 * Which Boston road concept does this factual line belong to?
 *
 * Name first; then DIRECTION for a one-way pair, and only then proximity.
 *
 * Proximity alone is wrong for a divided boulevard and was wrong here. Boston's
 * two Commonwealth carriageways sit +/-23 m off the centre while the factual
 * pair sits ~20 m off, so the factual EASTBOUND carriageway came out nearer to
 * Boston's WESTBOUND "Outbound" line. The connector then joined two one-way
 * streets head to head: junction 36 became a sink that could reach 2 nodes out
 * of 428, and the north/south route died. Flow direction is the discriminator a
 * divided boulevard actually has.
 */
function pickConcept(name, pts) {
  const k = normName(name);
  const cands = [];
  for (const [bk, bl] of bostonByName) if (bk === k || bk.startsWith(k + ' ') || k.startsWith(bk + ' ')) cands.push(...bl);
  if (!cands.length) return null;
  if (cands.length === 1) return cands;
  const m = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length };
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  const dir = { x: dx / L, z: dz / L };
  const oneways = cands.filter((c) => c.oneway);
  if (oneways.length > 1) {
    return oneways.map((c) => {
      const f = flowDir(c);
      return { c, align: dir.x * f.x + dir.z * f.z, d: distToStreet(m, c) };
    }).sort((x, y) => y.align - x.align || x.d - y.d || (x.c.name < y.c.name ? -1 : 1)).map((v) => v.c)
      .concat(cands.filter((c) => !c.oneway));
  }
  return cands.map((c) => ({ c, d: distToStreet(m, c) }))
    .sort((x, y) => x.d - y.d || (x.c.name < y.c.name ? -1 : 1)).map((v) => v.c);
}

/* ---- 2. the factual population, CLIPPED TO THE CORE ---------------------- */
const isSurface = (f) => (f.zlev?.[0] ?? 0) >= 0 && (f.zlev?.[1] ?? 0) >= 0 && f.cfcc !== 'A71';
/** Split a polyline into the runs that lie inside the core, cutting on the boundary. */
function clipToCore(pts) {
  const runs = [];
  let cur = [];
  const cut = (a, b) => {                       // parametric crossing of the box edge
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * m, z: a.z + (b.z - a.z) * m };
      if (inCore(p) === inCore(a)) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inCore(p)) {
      if (i > 0 && !inCore(pts[i - 1])) cur.push(cut(pts[i - 1], p));
      cur.push(p);
    } else {
      if (i > 0 && inCore(pts[i - 1])) { cur.push(cut(pts[i - 1], p)); if (cur.length >= 2) runs.push(cur); cur = []; }
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

const surface = FIX.features.filter(isSurface).sort((a, b) => a.segmentId - b.segmentId);
const excluded = FIX.features.filter((f) => !isSurface(f))
  .map((f) => ({ segmentId: f.segmentId, name: f.name || null, zlev: f.zlev, cfcc: f.cfcc,
                 reason: f.cfcc === 'A71' ? 'walkway/plaza (CFCC A71)' : 'grade-separated (ZLEV < 0)' }));

const emitted = [], mapping = [];
let clippedFactualRuns = 0;
for (const f of surface) {
  for (const raw of f.paths) {
    const full = raw.map(([x, z]) => ({ x, z }));
    for (const pts of clipToCore(full)) {
      clippedFactualRuns++;
      const list = pickConcept(f.name, pts);
      const concept = list ? list[0] : null;
      const fallback = f.cfcc === 'A73' ? { type: 'alley', lanes: 1 }
        : f.cfcc === 'A25' || f.cfcc === 'A31' ? { type: 'arterial', lanes: 4 } : { type: 'street', lanes: 2 };
      emitted.push({
        samSegmentId: f.segmentId, samName: f.name, samCfcc: f.cfcc, samZlev: f.zlev,
        name: concept ? concept.name : f.name,
        type: concept ? concept.type : fallback.type,
        lanes: concept ? concept.lanes : fallback.lanes,
        // One-way is Boston's call, not SAM's. SAM marks essentially every
        // Back Bay segment `ONEWAY: FT`, which is its digitisation sense rather
        // than a blanket restriction; consuming it literally made Boylston,
        // Dartmouth, Huntington, Blagden and Ring Road one-way and broke both
        // the north/south and the Commonwealth routes outright. So the
        // RESTRICTION comes from Boston's own concept — preserving current
        // gameplay traffic rules, as the brief prefers — and SAM supplies only
        // the DIRECTION relative to the factual path's own vertex order, which
        // Boston's flag cannot express because it refers to Boston's path.
        oneway: concept?.oneway ? (f.oneway === 'TF' ? -1 : 1) : 0,
        mall: concept?.mall ?? false, surfaceKind: concept?.surface,
        path: pts.map((p) => { const g = unGeo(p.x, p.z); return [r7(g.lat), r7(g.lon)]; }),
      });
      mapping.push({ sam: f.name, boston: concept ? concept.name : '(none)', type: emitted[emitted.length - 1].type,
                     lanes: emitted[emitted.length - 1].lanes, source: concept ? 'boston-concept' : 'source-class-fallback' });
    }
  }
}

/* ---- 3. cut the hand-authored streets ON THE LOT GRID -------------------- */
const { ZONING } = (await import('../../src/world/RoadNetwork.js')).default;
const arcLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return L; };
/** World point at arc position `t` along a polyline. */
function atArcOf(pts, t) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + d >= t || i === pts.length - 1) {
      const f = d < 1e-9 ? 0 : (t - acc) / d;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f };
    }
    acc += d;
  }
  return pts[pts.length - 1];
}
/** Arc position of the point on the polyline nearest `p`. */
function arcAt(pts, p) {
  let acc = 0, best = { d: Infinity, t: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1, L = Math.sqrt(L2);
    let f = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const d = Math.hypot(p.x - (a.x + ex * f), p.z - (a.z + ez * f));
    if (d < best.d) best = { d, t: acc + f * L };
    acc += L;
  }
  return best;
}
/**
 * The lot-grid cut for one core-boundary crossing.
 *
 * Finds the baseline edge carrying the crossing, reproduces `buildPlots`'
 * subdivision of it, and returns the nearest lot boundary lying OUTSIDE the
 * core. Cutting there leaves every outside lot exactly where the baseline put
 * it. Falls back to the crossing itself when no baseline edge can be matched.
 */
/**
 * `buildPlots` lays lots along the FRONTAGE LINE, not the centreline.
 *
 * Stage 2A.2 cut on the centreline grid, which is exact only while the two are
 * the same length. Back Bay's streets are straight, so they are — for 15 of the
 * 17 crossings the centreline and both frontages agree to the millimetre. But
 * Huntington Avenue bends: its centreline edge is 472.98 m and its two frontages
 * are 471.61 m and 474.34 m, which round to 60 lots on one side and 61 on the
 * other. A cut on the centreline grid is then a lot boundary on NEITHER side,
 * `step` shifts by ~0.13 m, and the drift accumulates over 33 lots to 4.3 m —
 * 121 parcels, more than half the whole residual.
 *
 * So the candidate cut positions come from the frontage grids themselves, and
 * the one chosen is the position whose WORST side is least out of phase. On a
 * straight edge every candidate coincides and this reduces exactly to Stage
 * 2A.2's behaviour; on a bent edge it picks the best available compromise,
 * which is all that exists when the two sides disagree about the lot count.
 */
function sideGrid(e, side, crossing) {
  const line = baseline.net._frontageLine(e, side);
  let acc = 0; const segs = [];
  for (let i = 1; i < line.length; i++) {
    const L = Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    segs.push({ a: line[i - 1], b: line[i], L, s: acc }); acc += L;
  }
  if (acc < 6) return null;
  const probe = baseline.net._along(segs, acc / 2, acc);
  const dist = baseline.districts.districtAt(probe.x, probe.z);
  const cfg = (dist && dist in ZONING) ? ZONING[dist] : ZONING.southEnd;
  if (!cfg) return null;
  const n = Math.max(1, Math.round(acc / cfg.w));
  return { line, acc, n, step: acc / n, dist, t: arcAt(line, crossing).t };
}
function lotGridCut(name, crossing) {
  let best = null;
  for (const e of baseline.net.edges) {
    if (e.name !== name) continue;
    const a = arcAt(e.pts, crossing);
    if (!best || a.d < best.a.d) best = { e, a };
  }
  if (!best || best.a.d > 5) return null;
  const pts = best.e.pts, acc = arcLen(pts);
  const grids = [-1, 1].map((side) => sideGrid(best.e, side, crossing)).filter(Boolean);
  if (!grids.length) return null;
  const outwardIsStart = !inCore(pts[0]);
  /** Phase error this cut point would leave on one side. */
  const errOn = (g, p) => {
    const t = arcAt(g.line, p).t;
    const kept = outwardIsStart ? t : g.acc - t;
    return Math.abs(kept - Math.round(kept / g.step) * g.step);
  };
  // Candidates: every lot boundary of every side, mapped onto the centreline,
  // plus the centreline's own grid so a degenerate frontage still has options.
  const cand = [];
  for (const g of grids) {
    for (let k = 0; k <= g.n; k++) {
      const p = baseline.net._along(g.line.slice(1).map((q, i) => ({ a: g.line[i], b: q,
        L: Math.hypot(q.x - g.line[i].x, q.z - g.line[i].z), s: 0 })), k * g.step, g.acc);
      cand.push(atArcOf(pts, arcAt(pts, p).t));
    }
  }
  const nC = Math.max(1, Math.round(acc / (grids[0].acc / grids[0].n)));
  for (let k = 0; k <= nC; k++) cand.push(atArcOf(pts, (k * acc) / nC));
  // Keep only positions OUTSIDE the core — so the kept run is wholly outside —
  // and within ONE LOT of the crossing, which is what "the nearest lot boundary"
  // means. Without that bound the search wanders: on a bent edge a lot boundary
  // 250 m away can be marginally better in phase, and the seam is no longer a
  // seam.
  const maxStep = Math.max(...grids.map((g) => g.step));
  const usable = cand.filter((p) => !inCore(p) && Math.hypot(p.x - crossing.x, p.z - crossing.z) <= maxStep + 1e-6);
  if (!usable.length) return null;
  let pick = null;
  for (const p of usable) {
    const worst = Math.max(...grids.map((g) => errOn(g, p)));
    const off = Math.hypot(p.x - crossing.x, p.z - crossing.z);
    if (!pick || worst < pick.worst - 1e-6 || (Math.abs(worst - pick.worst) <= 1e-6 && off < pick.off)) {
      pick = { p, worst, off };
    }
  }
  const g0 = grids[0];
  return { point: pick.p, stepM: r2(g0.step), lots: g0.n, offsetFromCrossingM: r2(pick.off),
           phaseErrorM: r2(pick.worst), edgeLengthM: r2(acc), district: g0.dist,
           sideLots: grids.map((g) => g.n) };
}

/* ---- 3. cut the hand-authored streets AT JUNCTION ANCHORS ---------------- */
/** Nearest baseline junction outside the core to a world point. */
function anchorFor(p) {
  let best = null;
  for (const n of junctions) {
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (!best || d < best.d) best = { d, n };
  }
  return best;
}
const clipped = [];
const anchors = [];
const lotCuts = [];
let maxSeamM = 0;
for (let si = 0; si < STREETS.length; si++) {
  const s = STREETS[si];
  const w = s.path.map(([la, lo]) => geo(la, lo));
  if (!w.some(inCore)) continue;
  // Outside runs, cut on the LOT GRID just beyond the core boundary.
  //
  // Stage 2A.1 cut exactly on the core boundary, which is an arbitrary arc
  // position: `acc` changed for the outside half, so `step` changed, so every
  // lot on it moved. Landing the cut on a baseline lot boundary instead keeps
  // `step` identical and the outside lots exactly where they were.
  const runs = [];
  let cur = [];
  const cutAt = (ai, bi) => {
    const a = w[ai], b = w[bi];
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      const p = { x: a.x + (b.x - a.x) * m, z: a.z + (b.z - a.z) * m };
      if (inCore(p) === inCore(a)) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    const crossing = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    const outIdx = inCore(a) ? bi : ai;
    const g = lotGridCut(s.name, crossing);
    const pt = g ? g.point : crossing;
    if (g) lotCuts.push({ street: s.name, ...g, point: { x: r2(g.point.x), z: r2(g.point.z) } });
    const ll = unGeo(pt.x, pt.z);
    const v = { ll: [r7(ll.lat), r7(ll.lon)], from: outIdx };
    // The cut stub end IS the connector's target, so hold the very same `ll`
    // array: the connector then shares the vertex bit for bit and no residual
    // sub-millimetre gap is left for endpoint snapping to find.
    crossings.push({ street: s.name, oneway: !!s.oneway, face: faceOf(crossing),
                     arc: arcOf(crossing), dir: inCore(a) ? 'out' : 'in',
                     at: { x: crossing.x, z: crossing.z }, cut: pt, ll: v.ll,
                     cutOffsetM: g ? g.offsetFromCrossingM : null, paired: null });
    return v;
  };
  for (let i = 0; i < w.length; i++) {
    if (!inCore(w[i])) {
      if (i > 0 && inCore(w[i - 1])) cur.push(cutAt(i - 1, i));
      cur.push({ idx: i });
    } else if (i > 0 && !inCore(w[i - 1])) {
      cur.push(cutAt(i - 1, i));
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  const kept = [];
  for (const run of runs) {
    // The end of this run that faces the core is the one to pull back.
    const endIdx = (v) => (v.idx !== undefined ? v.idx : null);
    const innerV = endIdx(run[0]) === 0 ? run[run.length - 1] : run[0];
    const innerPt = innerV.idx !== undefined ? w[innerV.idx] : geo(innerV.ll[0], innerV.ll[1]);
    const a = anchorFor(innerPt);
    if (a) {
      anchors.push({ street: s.name, at: { x: r2(innerPt.x), z: r2(innerPt.z) },
                     anchor: { x: r2(a.n.x), z: r2(a.n.z) }, distM: r2(a.d),
                     beyondCoreM: r2(Math.hypot(Math.max(CORE.x0 - a.n.x, 0, a.n.x - CORE.x1),
                                                Math.max(CORE.z0 - a.n.z, 0, a.n.z - CORE.z1))) });
      maxSeamM = Math.max(maxSeamM, anchors[anchors.length - 1].beyondCoreM);
    }
    // Keep the run's vertices, carrying the matching slice of every per-vertex
    // array. An interpolated boundary vertex takes its values from the outside
    // vertex it was derived from.
    if (run.length >= 2) kept.push(run.slice());
  }
  clipped.push({
    name: s.name, index: si,
    runs: kept.map((run) => ({
      path: run.map((v) => (v.idx !== undefined ? s.path[v.idx] : v.ll)),
      ...Object.fromEntries(PER_VERTEX.filter((p) => Array.isArray(s[p]))
        .map((p) => [p, run.map((v) => s[p][v.idx !== undefined ? v.idx : v.from])])),
    })),
  });
}

/* ---- 3b. TRANSITION CONNECTORS: structural port closure ------------------ */
/**
 * A factual street clipped at the core boundary ends in mid-air, and Boston's
 * own street crosses that same boundary somewhere nearby. The join is made
 * EXPLICIT — a connector is SYNTHETIC, is labelled `transitionConnector`, is not
 * SAM geometry, and lives entirely in the seam between a factual port and the
 * lot-grid cut stub of the same road concept.
 *
 * The pairing is structural. See the file header for why distance is not.
 */
const ports = [];
for (const e of emitted) {
  for (const idx of [0, e.path.length - 1]) {
    const g = geo(e.path[idx][0], e.path[idx][1]);
    // A port is an endpoint sitting on the core boundary, not an interior end.
    const onEdge = Math.min(Math.abs(g.x - CORE.x0), Math.abs(g.x - CORE.x1),
                            Math.abs(g.z - CORE.z0), Math.abs(g.z - CORE.z1));
    if (onEdge < 0.5) ports.push({ e, idx, g, ll: e.path[idx], face: faceOf(g), arc: arcOf(g),
                                   dir: idx === 0 ? 'in' : 'out', oneway: !!e.oneway, paired: null });
  }
}

/**
 * Order-preserving alignment of two sequences.
 *
 * Maximises the number of compatible pairs first and minimises total cost
 * second, and may leave either side unpaired. Order preservation is the whole
 * point: two crossings of one face by one street occur in the same order in
 * both worlds, because registration error slides a crossing along a face — it
 * cannot swap two of them.
 */
function alignMonotone(A, B, compat, cost) {
  const n = A.length, m = B.length;
  const best = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  best[0][0] = { pairs: 0, cost: 0, back: null };
  const better = (c, o) => !o || c.pairs > o.pairs || (c.pairs === o.pairs && c.cost < o.cost);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = best[i][j]; if (!cur) continue;
      if (i < n && better({ ...cur }, best[i + 1][j])) best[i + 1][j] = { ...cur, back: [i, j, null] };
      if (j < m && better({ ...cur }, best[i][j + 1])) best[i][j + 1] = { ...cur, back: [i, j, null] };
      if (i < n && j < m && compat(A[i], B[j])) {
        const c = { pairs: cur.pairs + 1, cost: cur.cost + cost(A[i], B[j]), back: [i, j, [i, j]] };
        if (better(c, best[i + 1][j + 1])) best[i + 1][j + 1] = c;
      }
    }
  }
  const out = [];
  let i = n, j = m;
  while (best[i][j] && best[i][j].back) {
    const [pi, pj, pair] = best[i][j].back;
    if (pair) out.push([A[pair[0]], B[pair[1]]]);
    i = pi; j = pj;
  }
  return out.reverse();
}

/**
 * Is this handover LOCAL?
 *
 * A connector asserts that two lines are the same street meeting. The assertion
 * is only defensible when the join is local — when the connector reaches its
 * counterpart without passing THROUGH other roads on the way. A 12 m jog across
 * a registration offset crosses nothing. A 169 m run along the core's north
 * face crosses every cross-street in Back Bay, and what it draws is not a
 * transition but a new street that has never existed.
 *
 * This is the validity test, and it is deliberately not a length threshold: no
 * length threshold exists, because the same 30 m registration error produces a
 * 30 m connector where a street meets the boundary square and a 94 m one where
 * it meets it at Back Bay's 18.5-degree grid angle. Crossing count measures the
 * thing that actually matters and needs no constant.
 */
/**
 * A connector's own ends are junctions by construction, so a road that merely
 * MEETS one of them there is not something the connector cuts through. Segments
 * incident to either end are skipped, within the same 5 cm Stage 2A.2 uses for
 * geometry identity — an order of magnitude above the ~1.1 cm that storing a
 * vertex as lat/lon at 7 decimals costs on the round trip.
 *
 * Without that, Exeter read as crossing Commonwealth Avenue Outbound: Exeter's
 * lot-grid cut lands exactly on their authored junction, so the two lines share
 * that vertex, and after the round trip they part by 4 cm — enough for a
 * parametric test to call the shared corner a crossing.
 */
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
/**
 * Every polyline the seam must not be threaded through, as world segments.
 *
 * This must include EVERY hand-authored street, not only the ones that cross the
 * core. A connector runs outside the core, where the streets it can cut through
 * are mostly streets that never enter it — Dartmouth, Public Alley 428, Saint
 * James — and a connector that crosses one of those splits it mid-edge exactly
 * as endpoint snapping would.
 */
function seamObstacles() {
  const out = [];
  for (const e of emitted) out.push({ owner: e, kind: 'factual', pts: e.path.map(([la, lo]) => geo(la, lo)) });
  for (const c of clipped) for (const run of c.runs) {
    out.push({ owner: c, kind: 'clipped', name: c.name, pts: run.path.map(([la, lo]) => geo(la, lo)) });
  }
  const clippedNames = new Set(clipped.map((c) => c.name));
  for (const st of STREETS) {
    if (clippedNames.has(st.name)) continue;              // already present, correctly clipped
    out.push({ owner: st, kind: 'baseline', name: st.name, pts: bostonWorld.get(st) });
  }
  return out;
}

const connectors = [];
const connStats = { ports: ports.length, joined: 0, unjoined: 0, lengths: [] };
const FACES = ['x0', 'x1', 'z0', 'z1'];
const concepts = [...new Set([...crossings.map((c) => c.street), ...ports.map((p) => p.e.name)])].sort();
const candidates = [];
for (const name of concepts) {
  for (const face of FACES) {
    const A = crossings.filter((c) => c.street === name && c.face === face).sort((u, v) => u.arc - v.arc);
    const B = ports.filter((p) => p.e.name === name && p.face === face).sort((u, v) => u.arc - v.arc);
    if (!A.length || !B.length) continue;
    // A one-way street must hand over in the direction it flows. Two-way
    // streets carry no usable direction here: Boston and SAM authored their
    // paths in whichever order they liked, and on Boylston's x0 crossing — the
    // two lines are 0.2 m apart, unambiguously the same crossing — the labels
    // already disagree.
    const compat = (c, p) => !(c.oneway && p.oneway) || c.dir === p.dir;
    const cost = (c, p) => Math.abs(c.arc - p.arc);
    for (const [c, p] of alignMonotone(A, B, compat, cost)) candidates.push({ c, p, face });
  }
}

/* Validate every candidate together, so a connector is also tested against the
 * other connectors it would be built alongside. Rejects are re-tested after
 * each removal — dropping one can make a neighbour legal — worst first. */
const obstacles = seamObstacles();
const rejected = [];
for (;;) {
  let worst = null;
  for (const k of candidates) {
    if (k.dead) continue;
    // Use the coordinates that will actually be WRITTEN, not the raw ones: the
    // lat/lon round trip moves a vertex by about a centimetre, and the check
    // must be made on the geometry the runtime will see.
    const a0 = geo(k.c.ll[0], k.c.ll[1]), a1 = geo(k.p.ll[0], k.p.ll[1]);
    let n = 0;
    const hits = [];
    for (const o of obstacles) {
      if (o.owner === k.p.e || (o.kind === 'clipped' && o.name === k.c.street)) continue;
      for (let i = 1; i < o.pts.length; i++) {
        if (properlyCrosses(a0, a1, o.pts[i - 1], o.pts[i])) { n++; hits.push(o.name || o.owner.name); break; }
      }
    }
    for (const j of candidates) {
      if (j === k || j.dead) continue;
      if (properlyCrosses(a0, a1, geo(j.c.ll[0], j.c.ll[1]), geo(j.p.ll[0], j.p.ll[1]))) { n++; hits.push(`connector:${j.p.e.name}`); }
    }
    k.crossings = n; k.hits = [...new Set(hits)];
    if (n > 0 && (!worst || n > worst.crossings ||
        (n === worst.crossings && Math.hypot(a1.x - a0.x, a1.z - a0.z) >
                                  Math.hypot(worst.p.g.x - worst.c.cut.x, worst.p.g.z - worst.c.cut.z)))) worst = k;
  }
  if (!worst) break;
  worst.dead = true;
  rejected.push({ street: worst.p.e.name, face: worst.face,
                  lengthM: r2(Math.hypot(worst.p.g.x - worst.c.cut.x, worst.p.g.z - worst.c.cut.z)),
                  crossings: worst.crossings, through: worst.hits });
}

for (const { c, p, face } of candidates) {
  if (c.paired) continue;
  const k = candidates.find((q) => q.c === c && q.p === p);
  if (k.dead) continue;
  c.paired = p; p.paired = c;
  const d = Math.hypot(c.cut.x - p.g.x, c.cut.z - p.g.z);
  if (d <= 0.05) { connStats.joined++; connStats.lengths.push(0); continue; }  // already coincident
  // Orient so a one-way street keeps flowing: the stub feeds the core when
  // the port is a path start, the core feeds the stub when it is a path end.
  connectors.push({ name: p.e.name, type: p.e.type, lanes: p.e.lanes,
    ...(p.e.oneway ? { oneway: p.e.oneway } : {}),
    transitionConnector: true, lengthM: r2(d), face,
    path: p.idx === 0 ? [c.ll, p.ll] : [p.ll, c.ll] });
  connStats.joined++; connStats.lengths.push(r2(d));
}

/**
 * Ports with no structural counterpart are TERMINAL, and are protected.
 *
 * `RoadNetwork.build()` would otherwise snap each one onto whatever edge lies
 * within 21 m and split that edge mid-edge, re-phasing its lots for its whole
 * length. `noSnap` lists the endpoint indices of THIS street that generic
 * endpoint snapping must leave alone; real crossings (pass 1) are unaffected,
 * and no hand-authored street carries the field, so the control world cannot
 * change.
 */
const portLedger = [];
for (const p of ports) {
  const hasConcept = crossings.some((c) => c.street === p.e.name);
  const sameFace = crossings.some((c) => c.street === p.e.name && c.face === p.face);
  const ownership = p.paired ? 'CONNECTED'
    : !hasConcept ? 'TERMINAL_NO_PROCEDURAL_COUNTERPART'
    : !sameFace ? 'TERMINAL_COUNTERPART_CROSSES_ANOTHER_FACE'
    : candidates.some((k) => k.p === p && k.dead) ? 'TERMINAL_HANDOVER_NOT_LOCAL'
    : 'TERMINAL_COUNTERPART_ALREADY_PAIRED';
  if (!p.paired) {
    const ends = (p.e.noSnap ||= []);
    if (!ends.includes(p.idx === 0 ? 0 : 1)) ends.push(p.idx === 0 ? 0 : 1);
    connStats.unjoined++;
  }
  portLedger.push({ street: p.e.name, samSegmentId: p.e.samSegmentId, face: p.face, dir: p.dir,
                    oneway: p.e.oneway, x: r2(p.g.x), z: r2(p.g.z), ownership,
                    pairedTo: p.paired ? { face: p.paired.face, x: r2(p.paired.cut.x), z: r2(p.paired.cut.z),
                                           connectorM: r2(Math.hypot(p.paired.cut.x - p.g.x, p.paired.cut.z - p.g.z)) } : null });
}
/**
 * Cut stubs with no factual counterpart: the mirror case, protected the same way.
 *
 * An orphan stub dangles at its cut exactly as an unjoined port does, and
 * endpoint snapping treats it the same — it reaches 21 m for anything and
 * splits it. Here the nearest thing is FACTUAL geometry just inside the core,
 * so an unprotected orphan stub reaches into the frozen core and re-splits it.
 * `noSnap` on the stub's cut end leaves its far end — out in the real city,
 * where its junctions are genuine — completely alone.
 */
const orphanCuts = crossings.filter((c) => !c.paired)
  .map((c) => ({ street: c.street, face: c.face, dir: c.dir, x: r2(c.cut.x), z: r2(c.cut.z) }));
for (const c of clipped) {
  for (const run of c.runs) {
    for (const idx of [0, run.path.length - 1]) {
      const o = crossings.find((q) => !q.paired && q.street === c.name && q.ll === run.path[idx]);
      if (!o) continue;
      (run.noSnap ||= []).push(idx === 0 ? 0 : 1);
    }
  }
}

connStats.lengths.sort((a, b) => a - b);
connStats.maxLengthM = connStats.lengths.length ? connStats.lengths[connStats.lengths.length - 1] : 0;
connStats.medianLengthM = connStats.lengths.length ? connStats.lengths[Math.floor(connStats.lengths.length / 2)] : 0;

/* ---- 4. emit ------------------------------------------------------------- */
const header = `/**
 * Back Bay factual road centrelines — GENERATED, do not hand-edit.
 *
 *   node research/gis-stage2a3/build-candidate.mjs
 *
 * Stage 2A.3 prototype data. DEFAULT OFF: nothing imports this unless
 * \`?gisRoads=1\` is present. See \`src/world/GisRoads.js\`.
 *
 * Source      Boston Street Segments (SAM System), Boston Maps, City of Boston
 * Licence     ODC-PDDL-1.0 — https://data.boston.gov/dataset/boston-street-segments-sam-system
 * Service     ${FIX.source.service}
 * Layer       ${FIX.source.layerName}
 * Retrieved   ${FIX.source.retrieved}
 * Raw sha256  ${FIX.source.rawSha256}
 * Projection  service EPSG:4326, then production src/core/Geo.js geo()
 *
 * SEMANTICS. Addressing / routing centrelines, not surveyed pavement centrelines,
 * and SAM carries no authoritative width. Only centreline geometry, street
 * identity, ZLEV and one-way sense are factual. Width, lanes, class, footway,
 * kerb and parking stay procedural, inherited from Boston's own entry for the
 * street of that name.
 *
 * CONTAINMENT (Stage 2A.3). Factual geometry is CLIPPED TO THE CORE so it cannot
 * create junctions outside it, and Boston's own streets are cut ON THE LOT GRID
 * just beyond the core — never mid-edge — so \`buildPlots\`' per-edge lot phase is
 * preserved and every lot outside the seam regenerates where the baseline put
 * it. Clipped streets carry the matching slice of every per-vertex array
 * (\`median\`, \`y\`, \`bridge\`); Stage 2A kept them whole, which misaligned
 * Huntington's median and caused the \`nuniv\` station section to be refused.
 *
 * SEAM PORTS. Each factual endpoint on the core boundary is paired with the
 * hand-authored crossing of the SAME concept, the SAME boundary face and the
 * same order along that face, and joined by a synthetic \`transitionConnector\`
 * to that crossing's lot-grid cut stub. A port with no such counterpart is
 * TERMINAL and carries \`noSnap\`, listing the endpoint indices that
 * \`RoadNetwork.build()\`'s 21 m dangling-endpoint snap must leave alone —
 * without it the port is adopted by whatever edge is nearest and splits it
 * mid-edge, re-phasing that edge's lots for its whole length.
 *
 * EXCLUSIONS. Grade-separated features are dropped, not flattened: the Turnpike
 * runs under Back Bay at ZLEV -1 and its ramps at -2..0. \`Exeter PLZ\` is a
 * pedestrian plaza (CFCC A71).
 */
`;
const body = header +
  `export const GIS_ROADS_SOURCE = ${JSON.stringify({
    dataset: FIX.source.dataset, publisher: FIX.source.publisher, licence: 'ODC-PDDL-1.0',
    catalog: FIX.source.catalog, service: FIX.source.service, layer: FIX.source.layerName,
    retrieved: FIX.source.retrieved, rawSha256: FIX.source.rawSha256, semantics: FIX.source.semantics,
    core: { x0: r7(CORE.x0), x1: r7(CORE.x1), z0: r7(CORE.z0), z1: r7(CORE.z1) },
    surfaceFilter: FIX.surfaceFilter, excludedFeatures: excluded.length,
    containment: 'factual geometry clipped to the core; Boston streets cut on the lot grid just beyond it; seam ports paired by (concept, boundary face, order along face)',
    seamMaxBeyondCoreM: r2(maxSeamM),
  }, null, 1)};\n\n` +
  `/** Factual surface streets, clipped to the core, in the STREETS shape. */\n` +
  `export const GIS_ROADS = ${JSON.stringify(emitted.map((e) => ({
    name: e.name, type: e.type, lanes: e.lanes,
    ...(e.oneway ? { oneway: e.oneway } : {}), ...(e.mall ? { mall: true } : {}),
    ...(e.surfaceKind ? { surface: e.surfaceKind } : {}),
    ...(e.noSnap?.length ? { noSnap: e.noSnap.slice().sort() } : {}),
    path: e.path,
    sam: { segmentId: e.samSegmentId, name: e.samName, cfcc: e.samCfcc, zlev: e.samZlev },
  })), null, 1)};\n\n` +
  `/** Boston streets, clipped to the parts outside the core, per-vertex arrays sliced to match. */\n` +
  `export const GIS_ROADS_CLIPPED = ${JSON.stringify(clipped, null, 1)};\n\n` +
  `/** SYNTHETIC seam joins. NOT factual SAM geometry; they exist only in the transition seam. */\n` +
  `export const GIS_ROADS_CONNECTORS = ${JSON.stringify(connectors, null, 1)};\n`;

writeFileSync(new URL('../../src/data/gis-backbay-roads.js', import.meta.url), body);
const outHash = createHash('sha256').update(body).digest('hex');
const manifest = {
  schemaVersion: 'boston-gis-stage2a3/candidate/0.3.0', source: { ...FIX.source }, core: CORE,
  emittedStreets: emitted.length, clippedFactualRuns, excludedFeatures: excluded,
  connectors: connStats,
  clippedStreets: clipped.map((c) => ({ name: c.name, runs: c.runs.length,
    perVertexArrays: PER_VERTEX.filter((p) => c.runs.some((r) => Array.isArray(r[p]))) })),
  seamAnchors: anchors, seamMaxBeyondCoreM: r2(maxSeamM), lotCuts, mapping,
  portLedger, orphanCuts, rejectedConnectors: rejected,
  connectorWorld: connectors.flatMap((k) => k.path.map(([la, lo]) => { const g = geo(la, lo); return { x: r2(g.x), z: r2(g.z) }; })),
  // FINAL SEAM, declared here and not by the measurement: the furthest any
  // vertex this generator places outside the core reaches beyond it. It covers
  // every lot-grid cut AND every connector vertex, so no generated geometry can
  // sit outside the region the containment contract is tested against.
  finalSeam: (() => {
    const dOut = (q) => Math.hypot(Math.max(CORE.x0 - q.x, 0, q.x - CORE.x1), Math.max(CORE.z0 - q.z, 0, q.z - CORE.z1));
    const pts = [...crossings.map((c) => c.cut)];
    for (const k of connectors) for (const [la, lo] of k.path) pts.push(geo(la, lo));
    const ds = pts.map(dOut).sort((a, b) => a - b);
    return { extentM: r2(ds[ds.length - 1]), vertices: ds.length,
             medianM: r2(ds[Math.floor(ds.length / 2)]),
             from: 'max distance beyond the core over all lot-grid cuts and connector vertices' };
  })(),
  outputBytes: body.length, outputSha256: outHash,
};
writeFileSync(new URL('./candidate-manifest.json', import.meta.url), JSON.stringify(manifest, null, 1) + '\n');
console.log(`factual: ${emitted.length} entries from ${surface.length} surface features (${clippedFactualRuns} core-clipped runs)`);
console.log(`clipped: ${clipped.length} Boston streets; per-vertex arrays carried on ${clipped.filter((c) => c.runs.some((r) => PER_VERTEX.some((p) => Array.isArray(r[p])))).map((c) => c.name).join(', ') || 'none'}`);
const own = {};
for (const e of portLedger) own[e.ownership] = (own[e.ownership] || 0) + 1;
console.log(`ports: ${ports.length} — ` + Object.entries(own).map(([k, v]) => `${v} ${k}`).join(', '));
if (rejected.length) console.log(`rejected as non-local: ` +
  rejected.map((r) => `${r.street}/${r.face} ${r.lengthM}m crosses ${r.crossings}`).join('; '));
console.log(`orphan cut stubs (no factual counterpart): ${orphanCuts.length}` +
  (orphanCuts.length ? ` — ${orphanCuts.map((o) => `${o.street}/${o.face}`).join(', ')}` : ''));
const offs = lotCuts.map((c) => c.offsetFromCrossingM).sort((a, b) => a - b);
console.log(`lot-grid cuts: ${lotCuts.length}, offset from the core crossing min ${offs[0]} m median ${offs[Math.floor(offs.length / 2)]} m max ${offs[offs.length - 1]} m`);
console.log(`(junction anchors, for reference only: ${anchors.length}, furthest ${r2(maxSeamM)} m)`);
console.log(`connectors: ${connStats.joined} of ${connStats.ports} ports joined (${connStats.unjoined} left open), median ${connStats.medianLengthM} m, max ${connStats.maxLengthM} m`);
console.log(`src/data/gis-backbay-roads.js  ${body.length} bytes  sha256 ${outHash.slice(0, 16)}`);
