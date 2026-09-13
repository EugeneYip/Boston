/**
 * Stage 1E — the bounded Back Bay registration probe.
 *
 *   node research/gis-stage1e/probe.mjs
 *
 * Applies ONE test, symmetrically, to Boston's hand-authored streets and to
 * each factual road candidate: walk along the road reference line and, at each
 * sample, cast a ray out each side until it meets factual building geometry.
 *
 * That yields three semantically careful quantities per sample:
 *
 *   dL, dR         distance from the road line to the first factual wall on
 *                  each side. Wall distances, not carriageway widths.
 *   midlineOffset  (dR - dL) / 2 — how far the road line sits from the middle
 *                  of the factual street section. NOT a claim that the true
 *                  centreline is the wall midpoint; real setbacks are
 *                  asymmetric. It is a registration diagnostic.
 *   wallToWall     dL + dR — the factual building-to-building section.
 *
 * And one width-independent pathology: is the road reference line itself
 * INSIDE a factual building? A line that runs through houses is misregistered
 * whatever width you wrap around it, and no width assumption is needed to say so.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { loadSources } from '../gis-stage1c/sources.mjs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { BBOX_WORLD as W } from '../gis-stage1a/bbox.mjs';
import { bbox, polyArea } from '../../src/world/GisAssociate.js';

const STEP = 2.0, REACH = 60, PAD = 0;
const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const inBox = (p) => p.x >= W.x0 - PAD && p.x <= W.x1 + PAD && p.z >= W.z0 - PAD && p.z <= W.z1 + PAD;

const inRing = (px, pz, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (((r[i].z > pz) !== (r[j].z > pz)) &&
        (px < (r[j].x - r[i].x) * (pz - r[i].z) / (r[j].z - r[i].z) + r[i].x)) c = !c;
  return c;
};
/** First crossing of a polygon boundary by the ray p + n*t, t in (0, REACH]. */
function firstHit(p, n, polys) {
  let best = Infinity;
  const x1 = p.x + n.x * REACH, z1 = p.z + n.z * REACH;
  const rb = { x0: Math.min(p.x, x1), x1: Math.max(p.x, x1), z0: Math.min(p.z, z1), z1: Math.max(p.z, z1) };
  for (const g of polys) {
    const b = g.b;
    if (b.x1 < rb.x0 || b.x0 > rb.x1 || b.z1 < rb.z0 || b.z0 > rb.z1) continue;
    const r = g.ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      const ex = c.x - a.x, ez = c.z - a.z;
      const den = n.x * ez - n.z * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = a.x - p.x, qz = a.z - p.z;
      const t = (qx * ez - qz * ex) / den;
      const w = (qx * n.z - qz * n.x) / -den;
      if (w < 0 || w > 1 || t <= 0.05 || t > REACH) continue;
      if (t < best) best = t;
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** Sample one road network against one factual building set. */
function probe(lines, polys) {
  const s = { samples: 0, inBuilding: 0, bothSides: 0, oneSide: 0, neither: 0,
              mid: [], wall: [], byStreet: new Map() };
  for (const { name, pts } of lines) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const ux = dx / L, uz = dz / L;
      const n = { x: -uz, z: ux };
      for (let t = 0; t <= L; t += STEP) {
        const p = { x: a.x + ux * t, z: a.z + uz * t };
        if (!inBox(p)) continue;
        s.samples++;
        let inside = false;
        for (const g of polys) {
          if (p.x < g.b.x0 || p.x > g.b.x1 || p.z < g.b.z0 || p.z > g.b.z1) continue;
          if (inRing(p.x, p.z, g.ring)) { inside = true; break; }
        }
        if (inside) { s.inBuilding++; continue; }
        const dR = firstHit(p, n, polys);
        const dL = firstHit(p, { x: -n.x, z: -n.z }, polys);
        if (dR !== null && dL !== null) {
          s.bothSides++;
          const m = (dR - dL) / 2, ww = dR + dL;
          s.mid.push(m); s.wall.push(ww);
          let e = s.byStreet.get(name);
          if (!e) s.byStreet.set(name, e = { mid: [], wall: [], n: 0, inBuilding: 0 });
          e.mid.push(m); e.wall.push(ww); e.n++;
        } else if (dR !== null || dL !== null) s.oneSide++;
        else s.neither++;
      }
    }
  }
  return s;
}
const summarise = (s) => ({
  samples: s.samples,
  pctRoadLineInsideBuilding: r2(100 * s.inBuilding / s.samples),
  pctBothSides: r2(100 * s.bothSides / s.samples),
  absMidlineOffsetM: { p50: r2(q(s.mid.map(Math.abs), .5)), p75: r2(q(s.mid.map(Math.abs), .75)),
                       p90: r2(q(s.mid.map(Math.abs), .9)), max: r2(q(s.mid.map(Math.abs), 1)) },
  signedMidlineOffsetM: { p50: r2(q(s.mid, .5)) },
  wallToWallM: { p10: r2(q(s.wall, .1)), p50: r2(q(s.wall, .5)), p90: r2(q(s.wall, .9)) },
});

/* ---- inputs -------------------------------------------------------------- */
const { pddl, massgis } = loadSources();
const prep = (set) => set.map((g) => ({ ring: g.ring, b: bbox(g.ring) }))
  .filter((g) => !(g.b.x1 < W.x0 - 80 || g.b.x0 > W.x1 + 80 || g.b.z1 < W.z0 - 80 || g.b.z0 > W.z1 + 80));
const PD = prep(pddl), MS = prep(massgis);

// Read the committed fixture, NOT the gitignored network cache: the analysis
// must be reproducible offline and byte-identical on rerun.
const FIX = JSON.parse(readFileSync(new URL('./backbay-roads.json', import.meta.url), 'utf8'));
const un = (paths) => paths.map((p) => p.map(([x, z]) => ({ x, z })));
const samLines = FIX.features.flatMap((f) => un(f.paths).map((pts) => ({ name: f.name, pts, surface: f.surface })));
const managedLines = FIX.secondary.features.flatMap((f) => un(f.paths).map((pts) => ({ name: f.name, pts })));
const world = buildCurrentWorld();
const bostonLines = [];
for (const e of world.net.edges) {
  if (!e.pts.some((p) => inBox(p))) continue;
  bostonLines.push({ name: e.name || `edge${e.id}`, pts: e.pts.map((p) => ({ x: p.x, z: p.z })) });
}
/**
 * SAM's surface-street subset, selected by the source's OWN attributes.
 *
 * Unfiltered SAM shows an 8.84% "road line inside a building" rate, and every
 * bit of it is correct data rather than error: `Massachusetts TPKE W` carries
 * `F_ZLEV = T_ZLEV = -1` because the Turnpike runs in a TUNNEL under Back Bay,
 * its unnamed ramp carries `[0, -1]`, and `Exeter PLZ` is `CFCC A71`, a
 * pedestrian plaza rather than a road. The layer describes its own exceptions.
 * This filter is therefore not a fudge and not an address exception list — it is
 * two published attributes, applied generically.
 */
const networks = {
  boston: { label: "Boston hand-authored STREETS (boston-geo.js)", lines: bostonLines },
  sam: { label: FIX.source.dataset, lines: samLines },
  samSurface: { label: 'SAM, surface streets only (ZLEV >= 0, CFCC != A71)', lines: samLines.filter((l) => l.surface) },
  managed: { label: FIX.secondary.dataset, lines: managedLines },
};

/* ---- run ----------------------------------------------------------------- */
const results = {};
console.log('network                                            samples  inBuilding%  both%  |midOffset| p50/p90   wallToWall p50');
for (const [k, v] of Object.entries(networks)) {
  const s = probe(v.lines, PD);
  const sm = summarise(s);
  results[k] = { label: v.label, vsPDDL: sm, byStreet: [...s.byStreet].sort().map(([name, e]) => ({
    name, samples: e.n, absMidP50: r2(q(e.mid.map(Math.abs), .5)), absMidP90: r2(q(e.mid.map(Math.abs), .9)),
    wallToWallP50: r2(q(e.wall, .5)) })) };
  // cross-check against the second accepted factual source
  results[k].vsMassGIS = summarise(probe(v.lines, MS));
  console.log(`${v.label.slice(0, 48).padEnd(50)} ${String(sm.samples).padStart(7)} ${String(sm.pctRoadLineInsideBuilding).padStart(12)} ` +
    `${String(sm.pctBothSides).padStart(6)} ${String(sm.absMidlineOffsetM.p50).padStart(11)} / ${String(sm.absMidlineOffsetM.p90).padStart(6)} ` +
    `${String(sm.wallToWallM.p50).padStart(15)}`);
}

/* ---- width-sensitivity sweep --------------------------------------------- */
// Stage 1C measured factual building area inside Boston's corridors. A
// centreline source carries no authoritative width, so the honest form is a
// sweep: for a range of DIAGNOSTIC half-widths, how much factual building area
// would a corridor of that size swallow? None of these widths is a truth claim.
const CELL = 1.0;
function areaInsideCorridor(lines, polys, halfWidths) {
  const segs = [];
  for (const { pts } of lines) for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L > 1e-6) segs.push({ ax: a.x, az: a.z, ux: dx / L, uz: dz / L, len: L });
  }
  const counts = halfWidths.map(() => 0);
  let total = 0;
  for (const g of polys) {
    for (let z = g.b.z0; z <= g.b.z1; z += CELL) {
      for (let x = g.b.x0; x <= g.b.x1; x += CELL) {
        if (x < W.x0 || x > W.x1 || z < W.z0 || z > W.z1) continue;
        if (!inRing(x, z, g.ring)) continue;
        total++;
        let best = Infinity;
        for (const s of segs) {
          let t = (x - s.ax) * s.ux + (z - s.az) * s.uz;
          t = t < 0 ? 0 : t > s.len ? s.len : t;
          const d = Math.hypot(x - (s.ax + s.ux * t), z - (s.az + s.uz * t));
          if (d < best) best = d;
        }
        halfWidths.forEach((h, i) => { if (best < h) counts[i]++; });
      }
    }
  }
  return { totalAreaM2: total * CELL * CELL, pct: halfWidths.map((h, i) => ({ halfWidthM: h, pctAreaInside: r2(100 * counts[i] / total) })) };
}
const HW = [3, 4, 5, 6, 7, 8, 9, 10];
console.log('\nwidth-sensitivity sweep — % of factual (PDDL) building area inside a corridor of the given DIAGNOSTIC half-width');
console.log('network                                     ' + HW.map((h) => `${h}m`.padStart(6)).join(''));
for (const [k, v] of Object.entries(networks)) {
  const r = areaInsideCorridor(v.lines, PD, HW);
  results[k].widthSweep = r;
  console.log(`${v.label.slice(0, 42).padEnd(44)}` + r.pct.map((p) => String(p.pctAreaInside).padStart(6)).join(''));
}

/* ---- pairwise: SAM surface vs Managed ------------------------------------ */
// Nearest-line lateral disagreement, sampled from SAM-surface onto Managed.
function nearestLine(p, lines) {
  let best = Infinity;
  for (const { pts } of lines) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      let t = ((p.x - a.x) * ex + (p.z - a.z) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
      if (d < best) best = d;
    }
  }
  return best;
}
const pairSamples = [];
for (const { pts } of networks.samSurface.lines) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    for (let t = 0; t <= L; t += STEP) {
      const p = { x: a.x + dx / L * t, z: a.z + dz / L * t };
      if (!inBox(p)) continue;
      pairSamples.push(nearestLine(p, networks.managed.lines));
    }
  }
}
const bostonToSam = [];
for (const { pts } of networks.boston.lines) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    for (let t = 0; t <= L; t += STEP) {
      const p = { x: a.x + dx / L * t, z: a.z + dz / L * t };
      if (!inBox(p)) continue;
      bostonToSam.push(nearestLine(p, networks.samSurface.lines));
    }
  }
}
const pairwise = {
  samSurfaceToManagedM: { n: pairSamples.length, p50: r2(q(pairSamples, .5)), p75: r2(q(pairSamples, .75)), p90: r2(q(pairSamples, .9)), max: r2(q(pairSamples, 1)) },
  bostonToSamSurfaceM: { n: bostonToSam.length, p50: r2(q(bostonToSam, .5)), p75: r2(q(bostonToSam, .75)), p90: r2(q(bostonToSam, .9)), max: r2(q(bostonToSam, 1)) },
};
console.log(`\npairwise nearest-line separation:`);
console.log(`  SAM(surface) -> Managed   p50 ${pairwise.samSurfaceToManagedM.p50} m  p90 ${pairwise.samSurfaceToManagedM.p90} m  max ${pairwise.samSurfaceToManagedM.max} m   (the two factual sources agree)`);
console.log(`  Boston       -> SAM       p50 ${pairwise.bostonToSamSurfaceM.p50} m  p90 ${pairwise.bostonToSamSurfaceM.p90} m  max ${pairwise.bostonToSamSurfaceM.max} m   (how far the hand-authored city sits from the factual one)`);

writeFileSync(new URL('./probe.json', import.meta.url), JSON.stringify({
  schemaVersion: 'boston-gis-stage1e/probe/0.2.0',
  fixture: { primary: FIX.primary, rawSha256: FIX.source.rawSha256, retrieved: FIX.source.retrieved },
  pairwise,
  method: { stepM: STEP, reachM: REACH, cellM: CELL, bbox: W,
            factualPDDLPolys: PD.length, factualMassGISPolys: MS.length },
  results,
}, null, 1) + '\n');
console.log('\nwrote research/gis-stage1e/probe.json');
