/**
 * Stage 1C phases 2–3 — factual street-facing envelope, and source agreement.
 *
 *   node research/gis-stage1c/envelope.mjs
 *
 * **This does not assume the road-facing edge of a polygon is the ground
 * facade.** It measures a road-facing *envelope* and then asks whether the two
 * allowed sources agree about it. Whether that envelope deserves to be called a
 * streetwall is decided by the agreement distribution, not asserted here.
 *
 * The measurement is a FIRST-HIT PROFILE: from each point along the current
 * procedural frontage, walk outward (away from the carriageway) and record the
 * first factual polygon boundary you meet.
 *
 * The first cut of this file instead picked each polygon's widest street-facing
 * edge within a normal band. That was wrong in a way worth recording: for a
 * building on the FAR side of the block, its rear wall's outward normal points
 * back toward this face, so it scored as perfectly "street-facing" here. The
 * median current-to-factual displacement came out at +15.6 m — a whole building
 * depth — because half the measurements were of the backs of other people's
 * houses. A first-hit ray cannot make that mistake: something is in the way.
 *
 * Sign convention: `d > 0` is outward, away from the street (behind the current
 * procedural wall); `d < 0` is toward the carriageway, in front of it.
 */
import { writeFileSync } from 'node:fs';
import { buildFrames } from './frames.mjs';
import { loadSources } from './sources.mjs';
import { bbox } from '../../src/world/GisAssociate.js';

export const PROFILE = { step: 1.0, dMin: -15, dMax: 45 };

/** Cumulative arc length of a polyline. */
export function arc(poly) {
  const c = [0];
  for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
  return c;
}

/** Point on a face's frontage polyline at arc position `s`, with its frame. */
export function atArc(face, cum, s) {
  let i = 0;
  while (i + 2 < cum.length && cum[i + 1] < s) i++;
  const a = face.polyline[i], b = face.polyline[i + 1];
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / seg;
  const u = face.outward[Math.min(i, face.outward.length - 1)];
  return { p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, u, seg: i };
}

/** First crossing of any edge of `ring` by the ray p + u*t, for t in [tMin,tMax]. */
function firstHit(p, u, ring, tMin, tMax) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x, ez = b.z - a.z;
    const den = u.x * ez - u.z * ex;
    if (Math.abs(den) < 1e-12) continue;
    const qx = a.x - p.x, qz = a.z - p.z;
    const t = (qx * ez - qz * ex) / den;          // along the ray
    const w = (qx * u.z - qz * u.x) / -den;       // along the edge, 0..1
    if (w < 0 || w > 1) continue;
    if (t < tMin || t > tMax) continue;
    if (t < best) best = t;
  }
  return best;
}

/** First-hit depth profile for one source along one face. */
export function profileFor(face, cum, polys) {
  const n = Math.max(2, Math.floor(cum[cum.length - 1] / PROFILE.step));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * cum[cum.length - 1];
    const { p, u } = atArc(face, cum, s);
    let best = Infinity, who = null;
    for (const g of polys) {
      const t = firstHit(p, u, g.ring, PROFILE.dMin, PROFILE.dMax);
      if (t < best) { best = t; who = g; }
    }
    out.push({ s, d: Number.isFinite(best) ? best : null, oid: who?.oid ?? null, localId: who?.localId ?? null });
  }
  return out;
}

export function buildEnvelopes() {
  const F = buildFrames();
  const { pddl, massgis, provenance } = loadSources();
  const faces = F.faces.map((f) => ({ ...f, cum: arc(f.polyline) }));
  const byFace = [];
  for (const f of faces) {
    const fb = bbox(f.polyline);
    const near = (set) => set.filter((g) => {
      const gb = bbox(g.ring);
      return !(gb.x1 < fb.x0 - 60 || gb.x0 > fb.x1 + 60 || gb.z1 < fb.z0 - 60 || gb.z0 > fb.z1 + 60);
    });
    const pProf = profileFor(f, f.cum, near(pddl));
    const mProf = profileFor(f, f.cum, near(massgis));
    // Per-sample agreement, only where BOTH sources see something.
    const samples = pProf.map((p, i) => ({ s: p.s, pd: p.d, md: mProf[i].d, pOid: p.oid, mOid: mProf[i].oid,
      dis: p.d !== null && mProf[i].d !== null ? Math.abs(p.d - mProf[i].d) : null }));
    byFace.push({ face: f, pProf, mProf, samples });
  }
  return { F, faces, byFace, provenance };
}

/** Orientation of a source's wall along a face: slope of d against s, in degrees. */
export function wallSlopeDeg(samples, key, s0, s1) {
  const pts = samples.filter((q) => q[key] !== null && q.s >= s0 && q.s <= s1);
  if (pts.length < 3) return null;
  const n = pts.length;
  const ms = pts.reduce((a, q) => a + q.s, 0) / n, md = pts.reduce((a, q) => a + q[key], 0) / n;
  let num = 0, den = 0;
  for (const q of pts) { num += (q.s - ms) * (q[key] - md); den += (q.s - ms) ** 2; }
  return den < 1e-9 ? null : Math.atan(num / den) * 180 / Math.PI;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { faces, byFace, provenance } = buildEnvelopes();
  const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
  const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
  const dis = [], cur = [], pOnly = [], mOnly = [], ori = [];
  let nBoth = 0, nAny = 0, nNone = 0, total = 0;
  for (const rec of byFace) {
    for (const q2 of rec.samples) {
      total++;
      if (q2.pd !== null && q2.md !== null) { nBoth++; dis.push(q2.dis); cur.push((q2.pd + q2.md) / 2); }
      else if (q2.pd !== null || q2.md !== null) nAny++;
      else nNone++;
      if (q2.pd !== null) pOnly.push(q2.pd);
      if (q2.md !== null) mOnly.push(q2.md);
    }
    const sp = wallSlopeDeg(rec.samples, 'pd', 0, rec.face.cum[rec.face.cum.length - 1]);
    const sm = wallSlopeDeg(rec.samples, 'md', 0, rec.face.cum[rec.face.cum.length - 1]);
    if (sp !== null && sm !== null) ori.push(Math.abs(sp - sm));
  }
  const show = (n, a) => console.log(`${n.padEnd(44)} n=${String(a.length).padStart(5)}  p10 ${String(r2(q(a,.1))).padStart(7)}  p50 ${String(r2(q(a,.5))).padStart(7)}  p90 ${String(r2(q(a,.9))).padStart(7)}  max ${String(r2(q(a,1))).padStart(7)}`);
  console.log(`sources: pddl sha ${provenance.pddl.sha256.slice(0,12)}  massgis sha ${provenance.massgis.sha256.slice(0,12)}`);
  console.log(`faces ${faces.length}   profile samples ${total} @ ${PROFILE.step} m over d in [${PROFILE.dMin}, ${PROFILE.dMax}] m`);
  console.log(`both sources hit ${nBoth} (${(100*nBoth/total).toFixed(1)}%)   one only ${nAny}   neither ${nNone}\n`);
  show('|PDDL - MassGIS| first-wall disagreement (m)', dis);
  show('current -> factual displacement (m)', cur);
  show('PDDL first wall vs current wall (m)', pOnly);
  show('MassGIS first wall vs current wall (m)', mOnly);
  show('per-face wall-slope disagreement (deg)', ori);
  const agree = (t) => (100 * dis.filter((v) => v <= t).length / dis.length).toFixed(1);
  console.log(`\nsource agreement within  0.25 m ${agree(0.25)}%   0.5 m ${agree(0.5)}%   1 m ${agree(1)}%   2 m ${agree(2)}%   5 m ${agree(5)}%`);
  const rec = { schemaVersion: 'boston-gis-stage1c/envelope/0.2.0', provenance, profile: PROFILE,
    coverage: { totalSamples: total, bothSources: nBoth, oneSource: nAny, neither: nNone },
    distributions: Object.fromEntries(Object.entries({
      normalDisagreementM: dis, currentToFactualM: cur, pddlDM: pOnly, massgisDM: mOnly, faceSlopeDisagreementDeg: ori,
    }).map(([k, a]) => [k, { n: a.length, p10: r2(q(a,.1)), p25: r2(q(a,.25)), p50: r2(q(a,.5)), p75: r2(q(a,.75)), p90: r2(q(a,.9)), max: r2(q(a,1)) }])),
    agreementWithin: { '0.25m': +agree(0.25), '0.5m': +agree(0.5), '1m': +agree(1), '2m': +agree(2), '5m': +agree(5) } };
  writeFileSync(new URL('./envelope.json', import.meta.url), JSON.stringify(rec, null, 1) + '\n');
}
