/**
 * Stage 1C phases 4–5 — classify faces, find candidate runs, rank them.
 *
 *   node research/gis-stage1c/classify.mjs
 *
 * Still gate-free: the agreement tolerance is SWEPT here so the gate in
 * `src/data/gis-backbay-streetwall.js` can be chosen from a measured structure
 * rather than from a number that felt about right.
 *
 * A run is a maximal contiguous stretch of the frontage where both sources see
 * a wall and agree about where it is. Runs are ranked by how much coherent
 * frontage they cover and how far the factual wall sits from the current one —
 * a run the eye cannot see moving is not worth testing.
 */
import { writeFileSync } from 'node:fs';
import { buildEnvelopes, wallSlopeDeg, PROFILE } from './envelope.mjs';
import { isReserved } from '../../src/data/landmarks.js';
import { centroid } from '../../src/world/GisAssociate.js';

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
/** Median absolute deviation — spread that a few bay windows cannot inflate. */
const mad = (a) => { const m = q(a, 0.5); return m === null ? null : q(a.map((v) => Math.abs(v - m)), 0.5); };

/** Maximal contiguous stretches of samples satisfying `ok`. */
function runsOf(samples, ok, minSamples) {
  const out = [];
  let cur = [];
  for (const s of samples) {
    if (ok(s)) cur.push(s);
    else { if (cur.length >= minSamples) out.push(cur); cur = []; }
  }
  if (cur.length >= minSamples) out.push(cur);
  return out;
}

export function analyse(tolM) {
  const { F, faces, byFace, provenance } = buildEnvelopes();
  const perFace = [], allRuns = [];
  for (const rec of byFace) {
    const f = rec.face;
    const len = f.cum[f.cum.length - 1];
    const both = rec.samples.filter((s) => s.pd !== null && s.md !== null);
    const agree = both.filter((s) => s.dis <= tolM);
    const d = agree.map((s) => (s.pd + s.md) / 2);
    const sp = wallSlopeDeg(rec.samples, 'pd', 0, len), sm = wallSlopeDeg(rec.samples, 'md', 0, len);
    // A corner sample is one where the two sources name different buildings even
    // though they agree on the wall — or where the first-hit building changes
    // more often than the parcel count can explain.
    const switches = rec.samples.filter((s, i) => i && s.pOid !== rec.samples[i - 1].pOid).length;
    const face = {
      key: f.key, street: f.street, edgeId: f.edgeId, side: f.side,
      frontageM: r2(len), parcels: f.nParcels, contiguous: f.contiguous,
      samples: rec.samples.length, bothPct: r2(100 * both.length / rec.samples.length),
      agreePct: r2(100 * agree.length / rec.samples.length),
      dMedian: r2(q(d, 0.5)), dMad: r2(mad(d)), dP10: r2(q(d, 0.1)), dP90: r2(q(d, 0.9)),
      slopeDisagreeDeg: sp !== null && sm !== null ? r2(Math.abs(sp - sm)) : null,
      firstHitSwitches: switches,
    };
    perFace.push(face);
    // Candidate runs inside this face.
    for (const r of runsOf(rec.samples, (s) => s.pd !== null && s.md !== null && s.dis <= tolM, 8)) {
      const rd = r.map((s) => (s.pd + s.md) / 2);
      const s0 = r[0].s, s1 = r[r.length - 1].s;
      // Which procedural parcels does this stretch cover, and are any reserved?
      const members = f.members.filter((p, i) => {
        const a = f.cum[i], b = f.cum[i + 1];
        return Math.min(b, s1) - Math.max(a, s0) > 0.5 * (b - a);   // majority of the parcel inside the run
      });
      const heroHit = members.some((p) => { const c = centroid(p.polygon); return isReserved(c.x, c.z); });
      allRuns.push({
        faceKey: f.key, street: f.street, s0: r2(s0), s1: r2(s1), lengthM: r2(s1 - s0),
        parcels: members.length, parcelIds: members.map((p) => p.id),
        dMedian: r2(q(rd, 0.5)), dMad: r2(mad(rd)), dP10: r2(q(rd, 0.1)), dP90: r2(q(rd, 0.9)),
        slopeDeg: r2(wallSlopeDeg(r, 'pd', s0, s1)),
        disMax: r2(Math.max(...r.map((s) => s.dis))), heroOrReserved: heroHit,
      });
    }
  }
  return { F, faces, perFace, allRuns, provenance };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('tol(m) | agreeing samples | runs>=8m | best run: street / len / parcels / dMedian / dMad');
  const sweep = [];
  let keep = null;
  for (const tol of [0.25, 0.5, 1.0, 2.0]) {
    const a = analyse(tol);
    const usable = a.allRuns.filter((r) => !r.heroOrReserved && Math.abs(r.dMedian) >= 1.0 && r.dMad <= 2.0);
    usable.sort((x, y) => (y.lengthM * Math.min(4, Math.abs(y.dMedian))) - (x.lengthM * Math.min(4, Math.abs(x.dMedian))));
    const b = usable[0];
    const agreeing = a.perFace.reduce((s, f) => s + f.agreePct * f.samples / 100, 0);
    sweep.push({ tol, agreeingSamples: Math.round(agreeing), runs: a.allRuns.length, usable: usable.length,
                 best: b ? { street: b.street, lengthM: b.lengthM, parcels: b.parcels, dMedian: b.dMedian, dMad: b.dMad } : null });
    console.log(`${tol.toFixed(2).padStart(6)} | ${String(Math.round(agreeing)).padStart(16)} | ${String(a.allRuns.length).padStart(8)} | ` +
      (b ? `${b.street} / ${b.lengthM} m / ${b.parcels} / ${b.dMedian} m / ${b.dMad}` : '—'));
    if (tol === 0.5) keep = a;
  }
  console.log('\n=== per-face, tol 0.5 m, sorted by agreeing frontage ===');
  console.log('street                        key     front  parc  both%  agree%  dMed   dMad  slopeDis  switches');
  for (const f of keep.perFace.slice().sort((a, b) => b.agreePct * b.frontageM - a.agreePct * a.frontageM).slice(0, 16))
    console.log(`${f.street.padEnd(29)} ${f.key.padEnd(7)} ${String(f.frontageM).padStart(6)} ${String(f.parcels).padStart(5)} ` +
      `${String(f.bothPct).padStart(6)} ${String(f.agreePct).padStart(7)} ${String(f.dMedian).padStart(6)} ${String(f.dMad).padStart(6)} ` +
      `${String(f.slopeDisagreeDeg).padStart(9)} ${String(f.firstHitSwitches).padStart(9)}`);
  console.log('\n=== top candidate runs, tol 0.5 m (no hero, |dMedian|>=1 m, dMad<=2 m) ===');
  const usable = keep.allRuns.filter((r) => !r.heroOrReserved && Math.abs(r.dMedian) >= 1.0 && r.dMad <= 2.0);
  usable.sort((x, y) => (y.lengthM * Math.min(4, Math.abs(y.dMedian))) - (x.lengthM * Math.min(4, Math.abs(x.dMedian))));
  console.log('street                        face    s0     s1    len  parc  dMed  dMad   dP10   dP90  slope disMax');
  for (const r of usable.slice(0, 12))
    console.log(`${r.street.padEnd(29)} ${r.faceKey.padEnd(7)} ${String(r.s0).padStart(5)} ${String(r.s1).padStart(6)} ${String(r.lengthM).padStart(6)} ` +
      `${String(r.parcels).padStart(5)} ${String(r.dMedian).padStart(5)} ${String(r.dMad).padStart(5)} ${String(r.dP10).padStart(6)} ${String(r.dP90).padStart(6)} ` +
      `${String(r.slopeDeg).padStart(6)} ${String(r.disMax).padStart(6)}`);
  writeFileSync(new URL('./classify.json', import.meta.url), JSON.stringify(
    { schemaVersion: 'boston-gis-stage1c/classify/0.1.0', profile: PROFILE, tolSweep: sweep,
      perFace: keep.perFace, runs: keep.allRuns }, null, 1) + '\n');
}
