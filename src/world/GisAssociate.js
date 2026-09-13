/**
 * Stage 1B.1 — factual-building ↔ procedural-parcel association.
 *
 * **Measurement first, gate second.** Everything above `classify()` computes
 * geometry and nothing else: no threshold, no acceptance, no opinion. The gate
 * is a separate, frozen constant at the bottom, chosen only after the Back Bay
 * distributions were measured (see
 * `research/GIS_HYBRID_WORLD_STAGE1B1_MULTI_PARCEL_RUNTIME_2026-09-12.md` §H).
 *
 * Used by the runtime adapter (`GisBackBay.js`) and by the headless research
 * harness, so the numbers in the report and the numbers in the browser come
 * from the same code rather than from two implementations that agree by luck.
 *
 * Coordinates are Boston world metres, X east / Z north-negative, the frame
 * `RoadNetwork` already publishes. No projection happens here.
 */

/* ---- geometry kernel ---------------------------------------------------- */

/** Signed-area magnitude of a simple polygon, m². */
export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    s += poly[i].x * poly[j].z - poly[j].x * poly[i].z;
  }
  return Math.abs(s) * 0.5;
}

/** Area-weighted centroid, falling back to the vertex mean on a degenerate ring. */
export function centroid(poly) {
  let A = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const cr = poly[i].x * poly[j].z - poly[j].x * poly[i].z;
    A += cr; cx += (poly[i].x + poly[j].x) * cr; cz += (poly[i].z + poly[j].z) * cr;
  }
  A *= 0.5;
  if (Math.abs(A) < 1e-9) {
    return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
             z: poly.reduce((s, p) => s + p.z, 0) / poly.length };
  }
  return { x: cx / (6 * A), z: cz / (6 * A) };
}

/**
 * Sutherland–Hodgman: clip `subject` (any simple polygon) to the interior of
 * `clip` (**must be convex**).
 *
 * Convexity of the clip polygon is not an assumption to be checked at runtime,
 * it is a property of what Boston publishes: `RoadNetwork.buildPlots` emits
 * `[p0, p1, p1+out*depth, p0+out*depth]` — a parallelogram — and
 * `Buildings._fuse` emits the same shape over a collinear run. Both are convex
 * by construction. The factual ring is the subject precisely because it is not.
 */
export function clipConvex(subject, clip) {
  let out = subject;
  const n = clip.length;
  // Orientation of the clip polygon decides which half-plane is "inside".
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s2 += clip[i].x * clip[j].z - clip[j].x * clip[i].z;
  }
  const ccw = s2 > 0;
  for (let i = 0; i < n && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % n];
    const ex = b.x - a.x, ez = b.z - a.z;
    // inside(p) > 0 for points left of a->b when the ring is CCW.
    const inside = (p) => {
      const c = ex * (p.z - a.z) - ez * (p.x - a.x);
      return ccw ? c : -c;
    };
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const dp = inside(p), dq = inside(q);
      if (dp >= 0) next.push(p);
      if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
        const t = dp / (dp - dq);
        next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
      }
    }
    out = next;
  }
  return out;
}

/** Overlap area of an arbitrary ring with a convex parcel, m². */
export function intersectionArea(ring, convexParcel) {
  const cut = clipConvex(ring, convexParcel);
  return cut.length < 3 ? 0 : polyArea(cut);
}

/* ---- procedural-parcel topology ----------------------------------------- */

/**
 * Boston's own adjacency relation, not a new one.
 *
 * `Buildings._superblocks` already walks runs of lots by exact frontage-endpoint
 * identity — `byStart.get(ptKey(p.frontage.b))` — bucketed by `edgeId` and
 * `side`. That relation is what makes a row of Back Bay lots a row rather than a
 * cloud of neighbours, it is already load-bearing in production, and reusing it
 * means Stage 1B.1 introduces no topology of its own. Centroid proximity is
 * deliberately not used: two lots across an alley are near each other and are
 * not a run.
 */
const ptKey = (q) => `${Math.round(q.x * 100)}_${Math.round(q.z * 100)}`;

/**
 * @returns {{next: Map<string,string>, prev: Map<string,string>}} parcel-id
 *          successor / predecessor along each frontage.
 */
export function frontageChain(parcels) {
  const byStart = new Map();   // "edgeId|side|ptKey(a)" -> parcel id
  const key = (p, q) => `${p.edgeId}|${p.side > 0 ? 1 : 0}|${ptKey(q)}`;
  for (const p of parcels) {
    if (!p?.frontage?.a || !Number.isFinite(p.edgeId)) continue;
    byStart.set(key(p, p.frontage.a), p.id);
  }
  const next = new Map(), prev = new Map();
  for (const p of parcels) {
    if (!p?.frontage?.b || !Number.isFinite(p.edgeId)) continue;
    const nid = byStart.get(key(p, p.frontage.b));
    if (nid !== undefined && nid !== p.id) { next.set(p.id, nid); prev.set(nid, p.id); }
  }
  return { next, prev };
}

/**
 * Is `ids` exactly one unbroken run of the frontage chain?
 *
 * A set is contiguous when it has a single member with no predecessor inside
 * the set, and walking `next` from it visits every member. A set spanning two
 * frontages — a building that reaches from Newbury through to the alley behind
 * it — has two such heads and is rejected, which is the intent: suppressing
 * across a block interior is not a streetwall replacement.
 */
export function isContiguousRun(ids, chain) {
  if (ids.length <= 1) return true;
  const set = new Set(ids);
  const heads = ids.filter((id) => !set.has(chain.prev.get(id)));
  if (heads.length !== 1) return false;
  let n = 0;
  for (let id = heads[0]; id !== undefined && set.has(id); id = chain.next.get(id)) {
    if (++n > ids.length) return false;
  }
  return n === ids.length;
}

/* ---- overlap graph ------------------------------------------------------ */

/**
 * Every (candidate, parcel) pair with non-zero overlap. No threshold is applied
 * here — the caller decides what counts, and the report quotes the raw
 * distribution this produces.
 *
 * @param {Array<{id:string, ring:Array<[number,number]>}>} candidates
 * @param {Array<object>} parcels post-superblock procedural visual units
 * @returns {Array<object>} one record per candidate
 */
export function overlapGraph(candidates, parcels) {
  const pm = parcels.map((p) => ({
    p,
    poly: p.polygon,
    area: polyArea(p.polygon),
    c: centroid(p.polygon),
    b: bbox(p.polygon),
  }));
  const out = [];
  for (const cand of candidates) {
    const ring = cand.ring.map(([x, z]) => ({ x, z }));
    const fa = polyArea(ring);
    const rb = bbox(ring);
    const edges = [];
    for (const m of pm) {
      if (m.b.x1 < rb.x0 || m.b.x0 > rb.x1 || m.b.z1 < rb.z0 || m.b.z0 > rb.z1) continue;
      const ia = intersectionArea(ring, m.poly);
      if (ia <= 0) continue;
      edges.push({
        plotId: m.p.id,
        parcelArea: m.area,
        interArea: ia,
        ofFactual: ia / fa,        // how much of the real building this parcel holds
        ofParcel: ia / m.area,     // how much of this parcel the real building holds
        outsideArea: m.area - ia,  // parcel mass that suppression would erase unreplaced
      });
    }
    edges.sort((a, b) => b.ofParcel - a.ofParcel);
    out.push({ id: cand.id, localId: cand.localId, factualArea: fa,
               ringVertices: cand.ring.length, centroid: centroid(ring), edges });
  }
  return out;
}

export function bbox(poly) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of poly) {
    const x = p.x ?? p[0], z = p.z ?? p[1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

/* ---- set algebra on footprints ------------------------------------------ */

/**
 * Union and difference areas are RASTERISED rather than summed.
 *
 * Summing looked safe and is not: `RoadNetwork.buildPlots` emits a parcel per
 * road frontage, so where two streets meet the parcels published for each
 * street physically overlap. Measured on the real Back Bay parcels, candidate
 * `bb-Bos_0501341000_B0` sums to **165% of its own footprint** across five
 * parcels. A sum would have over-counted precisely the corner cases where
 * suppression is most dangerous.
 *
 * 0.5 m cells: 0.25 m² of quantisation against areas in the thousands, and a
 * few hundred KiB of scratch for a Back Bay-sized claim.
 */
export const CELL = 0.5;

function rasterFor(polys) {
  let b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of polys) {
    const q = bbox(p);
    if (q.x0 < b.x0) b.x0 = q.x0; if (q.x1 > b.x1) b.x1 = q.x1;
    if (q.z0 < b.z0) b.z0 = q.z0; if (q.z1 > b.z1) b.z1 = q.z1;
  }
  const nx = Math.ceil((b.x1 - b.x0) / CELL) + 2;
  const nz = Math.ceil((b.z1 - b.z0) / CELL) + 2;
  return { b, nx, nz };
}

/** Scanline-fill one polygon into a raster, cell-centre sampling. */
function fill(grid, r, poly) {
  const q = bbox(poly);
  const j0 = Math.max(0, Math.floor((q.z0 - r.b.z0) / CELL));
  const j1 = Math.min(r.nz - 1, Math.ceil((q.z1 - r.b.z0) / CELL));
  for (let j = j0; j <= j1; j++) {
    const z = r.b.z0 + (j + 0.5) * CELL;
    const xs = [];
    for (let k = 0, l = poly.length - 1; k < poly.length; l = k++) {
      const a = poly[l], c = poly[k];
      if ((a.z > z) !== (c.z > z)) xs.push(a.x + (z - a.z) * (c.x - a.x) / (c.z - a.z));
    }
    xs.sort((u, v) => u - v);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - r.b.x0) / CELL - 0.5));
      const i1 = Math.min(r.nx - 1, Math.floor((xs[s + 1] - r.b.x0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * r.nx + i] = 1;
    }
  }
}

/** Area covered by at least one of `polys`, m². */
export function unionArea(polys) {
  if (!polys.length) return 0;
  const r = rasterFor(polys);
  const g = new Uint8Array(r.nx * r.nz);
  for (const p of polys) fill(g, r, p);
  let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i]) n++;
  return n * CELL * CELL;
}

/**
 * Ground covered by `a` and by none of `b` — the mass that suppression would
 * actually take off the screen.
 *
 * `near` optionally splits the answer by distance to a set of frontage lines,
 * because a void at the back of a Back Bay lot is behind the building and a
 * void on the frontage is a notch in the streetwall. They are not the same
 * defect and must not be reported as one number.
 *
 * @returns {{area:number, nearArea:number}} total, and the part within
 *          `near.within` metres of any `near.lines` segment.
 */
export function differenceArea(a, b, near = null) {
  if (!a.length) return { area: 0, nearArea: 0 };
  const r = rasterFor(a.concat(b));
  const A = new Uint8Array(r.nx * r.nz), B = new Uint8Array(r.nx * r.nz);
  for (const p of a) fill(A, r, p);
  for (const p of b) fill(B, r, p);
  let n = 0, nn = 0;
  for (let j = 0; j < r.nz; j++) {
    for (let i = 0; i < r.nx; i++) {
      const k = j * r.nx + i;
      if (!A[k] || B[k]) continue;
      n++;
      if (!near) continue;
      const x = r.b.x0 + (i + 0.5) * CELL, z = r.b.z0 + (j + 0.5) * CELL;
      for (const L of near.lines) {
        const ex = L.b.x - L.a.x, ez = L.b.z - L.a.z;
        const l2 = ex * ex + ez * ez || 1;
        let t = ((x - L.a.x) * ex + (z - L.a.z) * ez) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (L.a.x + ex * t), dz = z - (L.a.z + ez * t);
        if (dx * dx + dz * dz <= near.within * near.within) { nn++; break; }
      }
    }
  }
  return { area: n * CELL * CELL, nearArea: nn * CELL * CELL };
}
