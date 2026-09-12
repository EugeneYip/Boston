/** Stage 1A.1 — emit building fixture, schema, validation and metrics reports. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildUnits, measure, stats, FRONT_BAND } from './building-metrics.mjs';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { group } from './group.mjs';

const units = buildUnits();
const world = buildCurrentWorld();
const rows = measure(units, world);
const { assigned } = group();
const byPart = new Map(assigned.map(a => [a.partId, a]));

/* ---------------- validation (Phase 7) ---------------- */
const V = { failures: [], warnings: [], checks: {} };
const seen = new Set(); let partsSeen = 0, badWind = 0, nonFinite = 0, zero = 0, dangling = 0;
for (const u of units) {
  if (seen.has(u.id)) V.failures.push(`duplicate unit id ${u.id}`); seen.add(u.id);
  partsSeen += u.parts.length;
  if (!u.boundary.length) V.failures.push(`empty boundary ${u.id}`);
  for (const [A, B] of u.boundary) {
    if (![A[0], A[1], B[0], B[1]].every(Number.isFinite)) nonFinite++;
  }
  if (!(u.areaM2 > 0)) zero++;
  // boundary must form closed loops: every vertex has even degree
  const deg = new Map();
  for (const [A, B] of u.boundary) {
    for (const p of [A, B]) { const k = p[0].toFixed(2) + ',' + p[1].toFixed(2); deg.set(k, (deg.get(k) || 0) + 1); }
  }
  for (const [, d] of deg) if (d % 2 !== 0) { dangling++; break; }
}
const allParts = new Set(units.flatMap(u => u.parts.map(p => p.id)));
V.checks = {
  units: units.length, partsInput: 218, partsPreserved: partsSeen,
  everyPartAssignedToExactlyOneUnit: partsSeen === 218 && allParts.size === 218,
  singletons: units.filter(u => u.parts.length === 1).length,
  multiPart: units.filter(u => u.parts.length > 1).length,
  multipartGeometry: units.filter(u => u.parts.some(p => p.derived.rings.length > 1)).length,
  nonFiniteBoundaryCoords: nonFinite, zeroAreaUnits: zero,
  unitsWithOpenBoundary: dangling,
  areaConserved: Math.abs(units.reduce((s, u) => s + u.areaM2, 0) -
    JSON.parse(readFileSync(new URL('../gis-stage1a/fixture.json', import.meta.url), 'utf8'))
      .features.reduce((s, f) => s + f.derived.areaM2, 0)) < 0.05,
};
if (partsSeen !== 218) V.failures.push(`part count ${partsSeen} != 218`);
if (nonFinite) V.failures.push(`non-finite boundary coords: ${nonFinite}`);
if (dangling) V.warnings.push(`${dangling} unit(s) have an odd-degree boundary vertex (touching-at-a-point geometry)`);
V.result = V.failures.length ? 'FAIL' : (V.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS');

/* ---------------- M1 at both levels (Phase 10) ---------------- */
const fx = JSON.parse(readFileSync(new URL('../gis-stage1a/fixture.json', import.meta.url), 'utf8'));
let full = 0, ident = 0; const fails = [];
for (const f of fx.features) {
  const { heightFt: h, groundElevFt: g, roofElevFt: r } = f.fact;
  if (h == null || g == null || r == null) continue;
  full++;
  if (Math.abs((r - g) - h) <= 0.01) ident++; else fails.push({ id: f.id, deltaFt: +((r - g) - h).toFixed(3) });
}
const m1part = { level: 'ROOF_PART', tripletPresent: full, identityHolds: ident,
                 identityFails: fails.length, failures: fails, rate: +(100 * ident / full).toFixed(2) };
let uFull = 0, uConsistent = 0; const uFail = [];
for (const u of units) {
  const ps = u.parts.filter(p => p.fact.heightFt != null && p.fact.groundElevFt != null && p.fact.roofElevFt != null);
  if (!ps.length) continue;
  uFull++;
  const bad = ps.filter(p => Math.abs((p.fact.roofElevFt - p.fact.groundElevFt) - p.fact.heightFt) > 0.01);
  if (bad.length) uFail.push({ unit: u.id, badParts: bad.length, of: ps.length }); else uConsistent++;
}
const m1bld = { level: 'BUILDING',
  definition: 'a building is consistent when EVERY constituent part satisfies roof-ground=height. The identity is a part-level property; at building level it is an all-parts conjunction, which is why the two rates differ.',
  unitsWithElevations: uFull, allPartsConsistent: uConsistent, unitsWithAnInconsistentPart: uFail.length,
  failures: uFail, rate: +(100 * uConsistent / uFull).toFixed(2) };

/* ---------------- M2 / M3 ---------------- */
const pr = rows.filter(r => r.bucket === 'PRIMARY' && Number.isFinite(r.m2));
const co = rows.filter(r => r.bucket === 'CORNER' && Number.isFinite(r.m2));
const nc = pr.filter(r => !/Commonwealth/.test(r.street || ''));
const comm = pr.filter(r => /Commonwealth/.test(r.street || ''));
const near = new Map();
for (const r of pr) { const k = `${r.edgeId}:${r.side}`; if (!near.has(k) || r.facing < near.get(k)) near.set(k, r.facing); }
const fr = pr.filter(r => r.facing <= near.get(`${r.edgeId}:${r.side}`) + FRONT_BAND);
let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
for (const r of fr) { const [nx, nz] = r.normal; a11 += nx * nx; a12 += nx * nz; a22 += nz * nz; b1 += r.m2 * nx; b2 += r.m2 * nz; }
const det = a11 * a22 - a12 * a12, tx = (b1 * a22 - b2 * a12) / det, tz = (a11 * b2 - a12 * b1) / det;
const res = fr.map(r => r.m2 - (tx * r.normal[0] + tz * r.normal[1]));
const byStreet = {};
for (const r of pr) (byStreet[r.street || '(unnamed)'] ??= []).push(r.m2);
for (const k of Object.keys(byStreet)) byStreet[k] = stats(byStreet[k]);

const metrics = {
  generated: '2026-09-12', level: 'BUILDING',
  m1RoofPart: m1part, m1Building: m1bld,
  m2: {
    buckets: rows.reduce((a, r) => (a[r.bucket] = (a[r.bucket] || 0) + 1, a), {}),
    unmatchedReasons: rows.filter(r => r.bucket === 'UNMATCHED').reduce((a, r) => (a[r.reason] = (a[r.reason] || 0) + 1, a), {}),
    primarySigned: stats(pr.map(r => r.m2)), primaryAbs: stats(pr.map(r => Math.abs(r.m2))),
    primaryExclCommonwealthSigned: stats(nc.map(r => r.m2)), primaryExclCommonwealthAbs: stats(nc.map(r => Math.abs(r.m2))),
    commonwealthOnlySigned: stats(comm.map(r => r.m2)),
    cornerAbs: stats(co.map(r => Math.abs(r.m2))), byStreet,
  },
  m3: { bestFit: { dx: +tx.toFixed(3), dz: +tz.toFixed(3), magnitudeM: +Math.hypot(tx, tz).toFixed(3) },
        frontRankN: fr.length, residualSigned: stats(res), residualAbs: stats(res.map(Math.abs)) },
  rows: rows.map(r => ({ id: r.id, bucket: r.bucket, parts: r.parts, basis: r.basis ?? null,
                         street: r.street ?? null, m2: r.m2 ?? null, reason: r.reason ?? null })),
};

/* ---------------- fixture (Phase 16) ---------------- */
const pick = [];
const add = (u, why) => { if (u && !pick.some(p => p.u.id === u.id)) pick.push({ u, why }); };
const sorted = [...units].sort((a, b) => b.parts.length - a.parts.length);
add(sorted.find(u => u.parts.length === 28), 'largest multi-part unit: MassGIS carries 34 roofprints under one City LOCAL_ID');
add(sorted.find(u => u.parts.length === 8), 'multi-roof-part building');
add(sorted.find(u => u.parts.length === 3), 'small multi-part building');
add(units.find(u => u.parts.length === 1 && u.basis === 'massgis-local-id'), 'singleton with an authoritative parent');
add(units.find(u => u.basis === 'ungrouped-ambiguous'), 'AMBIGUOUS: straddles two MassGIS structures, deliberately left ungrouped');
add(units.find(u => u.parts.some(p => p.derived.rings.length > 1)), 'multipart geometry (interior ring preserved)');
add(units.find(u => u.parts.length > 1 && u.heightM && u.heightM.max - u.heightM.min > 3), 'stepped massing: constituent parts differ in height');
// two adjacent Newbury units kept separate
const newbury = rows.filter(r => r.street === 'Newbury Street' && r.bucket === 'PRIMARY').slice(0, 2);
for (const r of newbury) add(units.find(u => u.id === r.id), 'party-wall neighbour on Newbury Street, kept separate');

const fixture = {
  schemaVersion: 'boston-gis-stage1a1/schema-v0.1-building-candidate/0.1.0',
  adapterVersion: 'research/gis-stage1a1/emit.mjs@0.1.0',
  note: 'SELECTED CASES, not the whole block. Regenerate every unit with building-metrics.mjs buildUnits().',
  identity: {
    source: 'MassGIS Building Structures (2-D), LOCAL_ID',
    service: 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Building_Structures/FeatureServer/0',
    licence: 'MassGIS public record — freely redistributable including derivative works',
    attribution: 'MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS; layer copyrightText "MassGIS, City of Boston"',
    tier: 'DERIVED — grouping follows an authoritative identifier, not a heuristic',
  },
  geometry: { source: 'City of Boston Buildings with Roof Breaks', licence: 'ODC-PDDL-1.0',
              frame: 'boston-local metres via src/core/Geo.js geo() — UNCHANGED' },
  counts: { unitsTotal: units.length, partsTotal: 218, casesInFixture: pick.length },
  cases: pick.map(({ u, why }) => ({
    id: u.id, why, localId: u.localId, basis: u.basis, confidence: u.confidence,
    partCount: u.parts.length, areaM2: u.areaM2, centroid: u.centroid,
    heightM: u.heightM,
    heightsByPartFt: u.parts.map(p => ({ part: p.id, heightFt: p.fact.heightFt,
                                         groundElevFt: p.fact.groundElevFt, roofElevFt: p.fact.roofElevFt })),
    partIds: u.parts.map(p => p.id),
    assignment: u.parts.map(p => { const a = byPart.get(p.id); return { part: p.id, coverage: a?.coverage ?? null, margin: a?.margin ?? null, confidence: a?.confidence ?? null }; }),
    boundaryEdgeCount: u.boundary.length,
    parts: u.parts.map(p => ({ id: p.id, sourceId: p.sourceId, rings: p.derived.rings, fact: p.fact })),
  })),
};
const j = (o) => JSON.stringify(o, null, 1) + '\n';
writeFileSync(new URL('./validation-report.json', import.meta.url), j(V));
writeFileSync(new URL('./metrics-report.json', import.meta.url), j(metrics));
const fj = '{\n' + Object.entries(fixture).map(([k, v]) =>
  k === 'cases' ? ' "cases": [\n' + v.map(c => '  ' + JSON.stringify(c)).join(',\n') + '\n ]'
                : ' ' + JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n}\n';
writeFileSync(new URL('./building-fixture.json', import.meta.url), fj);
console.log('[emit] units', units.length, 'validation', V.result);
console.log('[emit] fixture cases', pick.length, (fj.length / 1024).toFixed(1), 'KiB  sha256', createHash('sha256').update(fj).digest('hex').slice(0, 16));
console.log('[emit] metrics sha256', createHash('sha256').update(j(metrics)).digest('hex').slice(0, 16));
