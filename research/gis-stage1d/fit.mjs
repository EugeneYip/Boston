/**
 * Stage 1D — diagnostic model fits. READ-ONLY: nothing here is applied.
 *
 * Every model displaces the PROCEDURAL FRONT LINE and asks what is left of the
 * gap to the factual wall. Because a sample's residual is the gap measured
 * along the outward normal `u`, each model is LINEAR in its parameters:
 *
 *   residual = d - (Δp · u)
 *
 * so a translation contributes `t·u`, a small rotation about centre c
 * contributes `θ * (perp(p-c) · u)` with `perp(v) = (-v.z, v.x)`, and a change
 * `δw` to `corridorHalf` contributes `+δw` because the front line is offset
 * from the centreline by exactly that quantity, outward.
 *
 * Fits are TRIMMED least squares: fit, drop the worst 20% by |residual|, refit.
 * The raw `d` distribution has a long tail of samples where the first factual
 * hit is a distant building across a gap, and an untrimmed fit would chase it.
 * Residual statistics are always reported over ALL samples, using the trimmed
 * coefficients, so the trimming cannot flatter the result.
 */

/** Solve a small symmetric normal-equation system by Gaussian elimination. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // `row[i]` IS the pivot after full Gauss-Jordan elimination; the first cut
  // of this wrote `row[i][i]`, indexing into a scalar, and every model but the
  // null one came back NaN.
  return M.map((row, i) => row[n] / row[i]);
}

function lsq(rows, target) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let p = 0; p < n; p++) {
      b[p] += rows[i][p] * target[i];
      for (let q = 0; q < n; q++) A[p][q] += rows[i][p] * rows[i][q];
    }
  }
  return solve(A, b);
}

/** Trimmed least squares. Returns coefficients fitted on the inlier 80%. */
export function trimmedFit(rows, target, trim = 0.2) {
  let beta = lsq(rows, target);
  if (!beta) return null;
  const res = rows.map((r, i) => target[i] - r.reduce((s, v, k) => s + v * beta[k], 0));
  const keep = res.map((v, i) => [Math.abs(v), i]).sort((a, b) => a[0] - b[0])
    .slice(0, Math.max(rows[0].length + 2, Math.floor(rows.length * (1 - trim)))).map((p) => p[1]);
  const b2 = lsq(keep.map((i) => rows[i]), keep.map((i) => target[i]));
  return b2 || beta;
}

export const perp = (vx, vz) => ({ x: -vz, z: vx });

/** Design-matrix builders. `c` is the rotation/affine centre. */
export const MODELS = {
  G0: { name: 'G0 no correction', cols: () => [], },
  G1: { name: 'G1 global translation', cols: (s) => [s.ux, s.uz] },
  G2: { name: 'G2 rigid (translation + rotation)',
        cols: (s, c) => { const v = perp(s.x - c.x, s.z - c.z); return [s.ux, s.uz, v.x * s.ux + v.z * s.uz]; } },
  G3: { name: 'G3 affine', cols: (s, c) => {
          const dx = s.x - c.x, dz = s.z - c.z;
          return [s.ux, s.uz, dx * s.ux, dz * s.ux, dx * s.uz, dz * s.uz]; } },
  W:  { name: 'W  street-section width only (per road type)', cols: (s, c, g) => g.typeCols(s) },
  G2W:{ name: 'G2+W rigid + width', cols: (s, c, g) => {
          const v = perp(s.x - c.x, s.z - c.z);
          return [s.ux, s.uz, v.x * s.ux + v.z * s.uz, ...g.typeCols(s)]; } },
  // A per-edge column of +1 contributes +delta along `u` on BOTH sides of the
  // street, and `u` is outward on each side — so it widens the section rather
  // than shifting it. That is PSW. A genuine lateral shift must flip sign with
  // the side, which is PSL. The first cut of this file had only the +1 form and
  // called it "per-street lateral offset"; it was measuring width all along.
  //
  // The two are exactly separable in the admissibility algebra:
  //   widthErr = r0 + r1   is moved by PSW and untouched by PSL
  //   shift    = (r0-r1)/2 is moved by PSL and untouched by PSW
  PSW: { name: 'PSW per-street section-width correction', cols: (s, c, g) => g.edgeCols(s) },
  PSL: { name: 'PSL per-street lateral shift', cols: (s, c, g) => g.edgeCols(s).map((v) => v * (s.side ? -1 : 1)) },
  // Lateral columns exist only for roads measured on BOTH sides. On a one-sided
  // road the lateral and width columns are the same vector up to sign, the
  // normal equations are singular, and the solver returns null.
  PSLW: { name: 'PSL+PSW per-street lateral + width', cols: (s, c, g) =>
            [...g.twoSidedEdgeCols(s).map((v) => v * (s.side ? -1 : 1)), ...g.edgeCols(s)] },
};

const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round((a.length - 1) * f)] : null);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

export function fitModel(key, samples, centre) {
  const types = [...new Set(samples.map((s) => s.type))].sort();
  const edges = [...new Set(samples.map((s) => s.edgeId))].sort((a, b) => a - b);
  const sidesOf = new Map();
  for (const s of samples) {
    let a = sidesOf.get(s.edgeId); if (!a) sidesOf.set(s.edgeId, a = new Set());
    a.add(s.side);
  }
  const twoSided = edges.filter((e) => sidesOf.get(e).size === 2);
  const helper = {
    typeCols: (s) => types.map((t) => (s.type === t ? 1 : 0)),
    edgeCols: (s) => edges.map((e) => (s.edgeId === e ? 1 : 0)),
    twoSidedEdgeCols: (s) => twoSided.map((e) => (s.edgeId === e ? 1 : 0)),
    edges, twoSided,
  };
  const M = MODELS[key];
  const rows = samples.map((s) => M.cols(s, centre, helper));
  const target = samples.map((s) => s.d);
  let beta = rows[0].length ? trimmedFit(rows, target) : [];
  const resid = rows.map((r, i) => target[i] - r.reduce((s, v, k) => s + v * (beta[k] ?? 0), 0));
  const abs = resid.map(Math.abs);
  return {
    key, name: M.name, params: rows[0].length, beta: beta.map((v) => r2(v)), twoSided,
    types, edges: rows[0].length && key === 'PS' ? edges : undefined,
    residual: { median: r2(q(abs, 0.5)), p75: r2(q(abs, 0.75)), p90: r2(q(abs, 0.9)), max: r2(q(abs, 1)),
                rms: r2(Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length)) },
    resid,
  };
}

/** Apply Stage 1C's frozen admissibility clauses to a set of residuals. */
export function admissibility(samples, resid, faces) {
  const byFace = new Map();
  samples.forEach((s, i) => {
    let a = byFace.get(s.faceKey); if (!a) byFace.set(s.faceKey, a = []);
    a.push(resid[i]);
  });
  const med = new Map([...byFace].map(([k, a]) => [k, q(a, 0.5)]));
  const byEdge = new Map();
  for (const f of faces) {
    const m = med.get(f.key);
    if (m === undefined) continue;
    let e = byEdge.get(f.edgeId); if (!e) byEdge.set(f.edgeId, e = { edgeId: f.edgeId, street: f.street });
    e[f.side ? 'r1' : 'r0'] = m;
    e[f.side ? 'f1' : 'f0'] = f.frontageM;
  }
  let okFront = 0, allFront = 0, okEdges = 0, nEdges = 0;
  const detail = [];
  for (const e of [...byEdge.values()].sort((a, b) => a.edgeId - b.edgeId)) {
    const front = (e.f0 || 0) + (e.f1 || 0);
    allFront += front;
    if (e.r0 === undefined || e.r1 === undefined) { detail.push({ ...e, admissible: false, why: 'one-sided' }); continue; }
    nEdges++;
    const widthErr = e.r0 + e.r1;               // procedural minus factual wall-to-wall, after the model
    const shift = (e.r0 - e.r1) / 2;
    const ok = Math.abs(widthErr) <= 4 && Math.abs(shift) <= 2;
    if (ok) { okFront += front; okEdges++; }
    detail.push({ edgeId: e.edgeId, street: e.street, r0: r2(e.r0), r1: r2(e.r1),
                  widthErrM: r2(widthErr), shiftM: r2(shift), frontageM: r2(front), admissible: ok });
  }
  return { admissibleFrontageM: r2(okFront), twoSidedFrontageM: r2(allFront),
           admissibleEdges: okEdges, twoSidedEdges: nEdges, detail };
}
