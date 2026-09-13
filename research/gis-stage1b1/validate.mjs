/**
 * Stage 1B.1 — invariant proof, through the real `_buildSpecs`.
 *
 *   node research/gis-stage1b1/validate.mjs
 *
 * Drives `Buildings._collectPlots` + `_buildSpecs` twice — flag off, then flag
 * on — by setting `globalThis.location`, which is the only thing `isEnabled()`
 * reads. So this exercises the production code path the browser would, not a
 * copy of it.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { makeBuilder } from './pipeline.mjs';
import { GIS_BACKBAY_SOURCE, GIS_BACKBAY_CANDIDATES } from '../../src/data/gis-backbay-candidate.js';

const W = GIS_BACKBAY_SOURCE.bboxWorld;
const inBox = (s) => s.cx >= W.x0 && s.cx <= W.x1 && s.cz >= W.z0 && s.cz <= W.z1;

function build(world, search) {
  globalThis.location = search === null ? undefined : { search };
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._buildSpecs(ctx);
  return b;
}
/** Stable fingerprint of the emitted city: geometry + the rolls that dress it. */
function fingerprint(specs) {
  const h = createHash('sha256');
  for (const s of specs) {
    h.update(`${s.cx.toFixed(3)},${s.cz.toFixed(3)},${s.h.toFixed(3)},${s.storeys},${s.style},${s.district},${s.seed},${s.poly.length};`);
  }
  return h.digest('hex').slice(0, 16);
}

const world = buildCurrentWorld();
const off = build(world, null);
const offQ = build(world, '?quality=high');          // a flag that is not ours
const on = build(world, '?gisBackBay=1');
const onTrue = build(world, '?gisBackBay=true');

const offBox = off.specs.filter(inBox), onBox = on.specs.filter(inBox);
const L = on.gisLedger;
const supSet = new Set(L.suppressedPlotIds);
const fromReplaced = L.replaced.flatMap((r) => r.suppressedPlotIds);

const hist = (a) => a.reduce((m, s) => (m[s.poly.length] = (m[s.poly.length] || 0) + 1, m), {});
const candidateKeys = [...new Set(GIS_BACKBAY_CANDIDATES.flatMap((c) => Object.keys(c)))].sort();
const src = ['GisBackBay.js', 'GisAssociate.js'].map((f) => readFileSync(new URL(`../../src/world/${f}`, import.meta.url), 'utf8')).join('\n')
          + readFileSync(new URL('../../src/data/gis-backbay-candidate.js', import.meta.url), 'utf8');

const checks = {
  // --- default-off parity ---------------------------------------------------
  'flag absent ⇒ ledger null': off.gisLedger === null,
  'unrelated flag ⇒ ledger null': offQ.gisLedger === null,
  'flag absent ⇒ citywide spec count unchanged': off.specs.length === 10278,
  'flag absent ⇒ city fingerprint matches no-location build': fingerprint(off.specs) === fingerprint(offQ.specs),
  'flag absent ⇒ every in-box building is a procedural quad':
    Object.keys(hist(offBox)).length === 1 && hist(offBox)['4'] === offBox.length,
  '?gisBackBay=true is accepted too': onTrue.gisLedger !== null && onTrue.gisLedger.replaced.length === L.replaced.length,
  // --- transactional invariants --------------------------------------------
  'every accepted replacement materialised a spec':
    L.replaced.length === on.specs.filter((s) => s.gisCandidateId).length,
  'no suppression without a replacement': supSet.size === fromReplaced.length,
  'no parcel suppressed by two replacements': new Set(fromReplaced).size === fromReplaced.length,
  'no duplicate factual replacement': new Set(L.replaced.map((r) => r.id)).size === L.replaced.length,
  'every candidate lands in exactly one bucket': L.replaced.length + L.fallback.length === L.candidates,
  'no candidate appears in both buckets':
    L.replaced.every((r) => !L.fallback.some((f) => f.id === r.id)),
  'ledger self-reconciles': L.audit.reconciles === true,
  'building-count identity holds': offBox.length - L.suppressedVisuals + L.replaced.length === onBox.length,
  'zero materialization failures after the gate':
    !L.fallback.some((f) => f.reason === 'materialization-failed'),
  // --- ownership -----------------------------------------------------------
  'factual buildings are the only non-quads in the box':
    onBox.filter((s) => s.poly.length !== 4).length === L.replaced.length,
  'every non-quad carries a ledger id':
    onBox.filter((s) => s.poly.length !== 4).every((s) => !!s.gisCandidateId),
  'no factual building rendered outside the prototype box':
    on.specs.filter((s) => s.gisCandidateId).every(inBox),
  // --- scope ---------------------------------------------------------------
  'nothing outside Back Bay changed':
    fingerprint(off.specs.filter((s) => !inBox(s))) === fingerprint(on.specs.filter((s) => !inBox(s))),
  'no network call in the runtime GIS path': !/\bfetch\s*\(|XMLHttpRequest|import\s*\(/.test(src),
  // Assert the DATA, not the prose. A regex over source text was the first
  // form of these two checks and it failed on the comments that say the
  // feature is absent — which proves only that the file discusses it.
  // The candidate records carry five fields and there is no height, no
  // elevation and no assessing attribute among them to consume.
  'candidate records carry geometry and identity only':
    candidateKeys.length === 5 && ['areaM2', 'id', 'localId', 'parts', 'ring'].every((k) => candidateKeys.includes(k)),
  'no GIS height, elevation or assessing attribute exists to consume':
    !candidateKeys.some((k) => /height|elev|stor|floor|assess|doit|parcel_?id|pid/i.test(k)),
  'factual buildings take height from makeSpec like every other building':
    on.specs.filter((s) => s.gisCandidateId).every((s) => s.h > 0 && s.storeys >= 1 && s.storeyH > 0),
};

const failed = Object.entries(checks).filter(([, v]) => !v);
const out = {
  schemaVersion: 'boston-gis-stage1b1/validate/0.1.0',
  control: { flag: 'absent', gisLedger: off.gisLedger, citySpecs: off.specs.length, boxSpecs: offBox.length,
             boxVertexHistogram: hist(offBox), fingerprint: fingerprint(off.specs), clipStats: off._clipStats },
  candidate: { flag: '?gisBackBay=1', citySpecs: on.specs.length, boxSpecs: onBox.length,
               boxVertexHistogram: hist(onBox), nonQuadInBox: onBox.filter((s) => s.poly.length !== 4).length,
               fingerprint: fingerprint(on.specs), clipStats: on._clipStats,
               replaced: L.replaced.length, suppressedParcels: supSet.size, suppressedVisuals: L.suppressedVisuals,
               audit: L.audit },
  candidateKeys,
  checks, failed: failed.map(([k]) => k), pass: failed.length === 0,
};
writeFileSync(new URL('./validate.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
for (const [k, v] of Object.entries(checks)) console.log(`${v ? ' ok ' : 'FAIL'}  ${k}`);
console.log(`\n${failed.length ? `${failed.length} FAILED` : 'all ' + Object.keys(checks).length + ' invariants hold'}`);
console.log(`control  ${out.control.citySpecs} specs / ${out.control.boxSpecs} in box / ${JSON.stringify(out.control.boxVertexHistogram)} / ${out.control.fingerprint}`);
console.log(`candidate ${out.candidate.citySpecs} specs / ${out.candidate.boxSpecs} in box / ${JSON.stringify(out.candidate.boxVertexHistogram)} / ${out.candidate.fingerprint}`);
