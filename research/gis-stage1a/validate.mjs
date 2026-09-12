/**
 * Stage 1A structural validation. Deterministic, no network, no browser.
 *   node research/gis-stage1a/validate.mjs
 * Exits non-zero on any hard failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { area2, selfIntersects } from './normalize.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const R = { schemaVersion: fx.schemaVersion, checks: {}, failures: [], warnings: [] };
const fail = (k, m) => { R.failures.push(`${k}: ${m}`); };
const warn = (k, m) => { R.warnings.push(`${k}: ${m}`); };

const ids = new Set(), srcIds = new Set();
let nonFinite = 0, under3 = 0, zeroArea = 0, badWindOuter = 0, badWindHole = 0;
let selfInt = 0, selfIntSkipped = 0, multiRing = 0, verts = 0, minV = Infinity, maxV = 0;
for (const f of fx.features) {
  if (ids.has(f.id)) fail('duplicate-id', f.id); ids.add(f.id);
  if (srcIds.has(f.sourceId)) fail('duplicate-sourceId', f.sourceId); srcIds.add(f.sourceId);
  const rings = f.derived.rings;
  if (rings.length > 1) multiRing++;
  rings.forEach((ring, i) => {
    verts += ring.length;
    if (i === 0) { minV = Math.min(minV, ring.length); maxV = Math.max(maxV, ring.length); }
    if (ring.length < 3) under3++;
    for (const [x, z] of ring) if (!Number.isFinite(x) || !Number.isFinite(z)) nonFinite++;
    const A = area2(ring) / 2;
    if (Math.abs(A) < 1.0) zeroArea++;
    if (i === 0 && A < 0) badWindOuter++;
    if (i > 0 && A > 0) badWindHole++;
    const si = selfIntersects(ring);
    if (si === null) selfIntSkipped++; else if (si) selfInt++;
  });
  // Height identity (roof - ground === height) is a SOURCE-consistency question,
  // so it is measured by M1 and only WARNED about here. This file's job is the
  // structural integrity of OUR OWN output; whether the City's elevation fields
  // agree with each other is not something the normalizer can fix, and failing
  // the structural gate on it would conflate two different questions.
  const { heightFt: h, groundElevFt: g, roofElevFt: rf } = f.fact;
  if (h != null && g != null && rf != null && Math.abs((rf - g) - h) > 0.01) {
    warn('source-height-identity', `${f.id} roof-ground=${(rf - g).toFixed(3)} vs height=${h} — see M1`);
  }
  if (f.derived.heightM != null && f.derived.heightM <= 0) fail('non-positive-height', f.id);
}
R.checks = {
  features: fx.features.length, sourceFeatures: fx.counts.source, rejected: fx.counts.rejected,
  uniqueIds: ids.size, uniqueSourceIds: srcIds.size,
  ringVertices: verts, outerRingVertices: { min: minV, max: maxV, mean: +(verts / fx.features.length).toFixed(2) },
  multiRingFeatures: multiRing,
  nonFiniteCoords: nonFinite, ringsUnder3Vertices: under3, ringsUnder1m2: zeroArea,
  outerRingsWrongWinding: badWindOuter, holeRingsWrongWinding: badWindHole,
  selfIntersectingRings: selfInt, selfIntersectionChecksSkipped: selfIntSkipped,
};
if (nonFinite) fail('non-finite', String(nonFinite));
if (under3) fail('degenerate-ring', String(under3));
if (zeroArea) fail('zero-area-ring', String(zeroArea));
if (badWindOuter || badWindHole) fail('winding', `${badWindOuter} outer / ${badWindHole} hole`);
if (ids.size !== fx.features.length) fail('id-uniqueness', 'ids collapsed');
if (selfInt) warn('self-intersection', `${selfInt} ring(s) self-intersect — reported, not rejected`);
// deterministic ordering
const sorted = [...fx.features].map(f => f.sourceId)
  .sort((p, q) => (p.length - q.length) || p.localeCompare(q));
if (JSON.stringify(sorted) !== JSON.stringify(fx.features.map(f => f.sourceId))) fail('ordering', 'not sorted');

R.result = R.failures.length ? 'FAIL' : (R.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS');
writeFileSync(new URL('./validation-report.json', import.meta.url), JSON.stringify(R, null, 1) + '\n');
console.log(JSON.stringify(R, null, 1));
process.exit(R.failures.length ? 1 : 0);
