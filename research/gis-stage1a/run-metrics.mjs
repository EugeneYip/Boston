/** Stage 1A — run M1/M2/M3 and write metrics-report.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCurrentWorld } from './current-world.mjs';
import { computeMetrics, stats } from './metrics.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

/* ---- M1: source-internal consistency ---------------------------------- */
const m1 = { definition: 'source-internal consistency of the authoritative extract', checks: {} };
let full = 0, ident = 0, none = 0, partial = 0;
const identFails = [];
const areaDelta = [];
for (const f of fx.features) {
  const { heightFt: h, groundElevFt: g, roofElevFt: r, shapeAreaFt2: sa } = f.fact;
  const have = [h, g, r].filter(v => v != null).length;
  if (have === 3) { full++; const d = (r - g) - h;
    if (Math.abs(d) <= 0.01) ident++; else identFails.push({ id: f.id, deltaFt: +d.toFixed(3) });
  } else if (have === 0) none++; else partial++;
  if (sa != null) {
    const m2a = sa * 0.3048 * 0.3048;             // ft^2 -> m^2 (international foot)
    if (m2a > 0) areaDelta.push((f.derived.areaM2 - m2a) / m2a * 100);
  }
}
const ids = fx.features.map(f => f.sourceId);
m1.checks = {
  features: fx.features.length,
  duplicateSourceIds: ids.length - new Set(ids).size,
  elevationTripletPresent: full, elevationTripletAbsent: none, elevationPartial: partial,
  heightIdentityHolds: ident, heightIdentityFails: identFails.length, identityFailures: identFails,
  heightIdentityRate: +(ident / full * 100).toFixed(2),
  areaAgreementPct: stats(areaDelta),
  multiRingFeatures: fx.features.filter(f => f.derived.rings.length > 1).length,
};
m1.result = identFails.length <= 1 && m1.checks.duplicateSourceIds === 0 ? 'USABLE' : 'REVIEW';

/* ---- M2 / M3 ----------------------------------------------------------- */
const world = buildCurrentWorld();
const rows = computeMetrics(fx, world);
const primary = rows.filter(r => r.bucket === 'PRIMARY' && Number.isFinite(r.m2));
const corner  = rows.filter(r => r.bucket === 'CORNER'  && Number.isFinite(r.m2));
const unmatched = rows.filter(r => r.bucket === 'UNMATCHED');
const outside = rows.filter(r => r.bucket === 'OUTSIDE_BOX');

// FRONT RANK. The full primary set is bimodal: a wall can be unoccluded toward a
// street across a rear courtyard or alley and still not be on that street. For
// each (edgeId, side) keep only the buildings whose facing distance is within
// FRONT_BAND of the nearest one on that same frontage — i.e. the rank that
// actually forms the streetwall. Deterministic, and reported alongside the full
// set rather than instead of it.
const FRONT_BAND = 4.0;
const nearestByWall = new Map();
for (const r of primary) {
  const k = `${r.edgeId}:${r.side}`;
  if (!nearestByWall.has(k) || r.facing < nearestByWall.get(k)) nearestByWall.set(k, r.facing);
}
const frontRank = primary.filter(r => r.facing <= nearestByWall.get(`${r.edgeId}:${r.side}`) + FRONT_BAND);

const m2 = {
  frontRankBandM: FRONT_BAND,
  frontRankSigned: stats(frontRank.map(r => r.m2)),
  frontRankAbs: stats(frontRank.map(r => Math.abs(r.m2))),
  frontRankN: frontRank.length,
  definition: 'signed perpendicular distance, authoritative street-facing edge -> current parcel frontage polyline; + = building inland of Boston streetwall',
  buckets: { primary: primary.length, corner: corner.length, unmatched: unmatched.length, outsideBox: outside.length },
  unmatchedReasons: unmatched.reduce((a, r) => (a[r.reason] = (a[r.reason] || 0) + 1, a), {}),
  primarySigned: stats(primary.map(r => r.m2)),
  primaryAbs: stats(primary.map(r => Math.abs(r.m2))),
  cornerSigned: stats(corner.map(r => r.m2)),
  cornerAbs: stats(corner.map(r => Math.abs(r.m2))),
  byStreet: {},
};
for (const r of frontRank) {
  const k = r.street || '(unnamed)';
  (m2.byStreet[k] ||= []).push(r.m2);
}
for (const k of Object.keys(m2.byStreet)) m2.byStreet[k] = stats(m2.byStreet[k]);
m2.byStreetNote = 'front rank only';

/* ---- M3: ONE rigid translation, no rotation, no scale ------------------ */
// Solve the translation that minimises sum of squared SIGNED residuals. Each
// primary row constrains the translation only along its own outward normal n,
// so this is a least-squares fit of (t . n) = m2 over all rows: a 2x2 normal
// system. Recomputed residual = m2 - (t . n).
import { corridorHalf } from '../../src/world/RoadNetwork.js';
const normals = [];
{
  // recover each primary row's outward normal by re-deriving it from the metric run
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const f of fx.features) {
    const r = byId.get(f.id);
    if (!r || r.bucket !== 'PRIMARY' || !Number.isFinite(r.m2)) continue;
    if (!frontRank.includes(r)) continue;        // M3 fits the streetwall, not set-back blocks
    normals.push(r);
  }
}
let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
for (const r of normals) {
  const [nx, nz] = r.normal;
  a11 += nx * nx; a12 += nx * nz; a22 += nz * nz;
  b1 += r.m2 * nx; b2 += r.m2 * nz;
}
const det = a11 * a22 - a12 * a12;
const tx = det !== 0 ? (b1 * a22 - b2 * a12) / det : 0;
const tz = det !== 0 ? (a11 * b2 - a12 * b1) / det : 0;
const resid = normals.map(r => r.m2 - (tx * r.normal[0] + tz * r.normal[1]));
const m3 = {
  definition: 'residual after ONE best-fit rigid 2D translation. No rotation, no scale, no warp.',
  bestFit: { dx: +tx.toFixed(3), dz: +tz.toFixed(3), magnitudeM: +Math.hypot(tx, tz).toFixed(3) },
  conditioning: { n: normals.length, det: +det.toFixed(3) },
  residualSigned: stats(resid),
  residualAbs: stats(resid.map(Math.abs)),
};

const report = { generated: new Date().toISOString().slice(0, 10), m1, m2, m3,
                 rows: rows.map(r => ({ id: r.id, bucket: r.bucket, street: r.street ?? null,
                                        m2: r.m2 ?? null, fronts: r.fronts ?? null, reason: r.reason ?? null })) };
writeFileSync(new URL('./metrics-report.json', import.meta.url), JSON.stringify(report, null, 1) + '\n');
console.log('=== M1 ==='); console.log(JSON.stringify(m1, null, 1));
console.log('=== M2 ==='); console.log(JSON.stringify({ ...m2, byStreet: m2.byStreet }, null, 1));
console.log('=== M3 ==='); console.log(JSON.stringify(m3, null, 1));
