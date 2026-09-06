/**
 * Model Lab — geometry analysis.
 *
 * Turns a built `MeshBuf` back into per-footprint-edge facts, so a modeling
 * claim ("this wall is flat", "the corner's second street face is blank") can
 * be a number instead of an impression.
 *
 * The attribution is geometric, not instrumented. `buildBuilding` emits one
 * unbroken index stream and offers no per-edge hook, and adding one would mean
 * editing the generator to measure the generator. Instead every triangle is
 * assigned to the footprint edge whose plane it sits closest to, which needs no
 * source change and stays correct if the walk order is ever reorganised.
 *
 * The metric that matters is RELIEF: the spread of triangle offsets measured
 * perpendicular to the edge, outward-positive. A flat wall is a quad on the
 * footprint line and scores 0.000. A real Boston facade has reveals cut 0.18 m
 * in and sills projecting 0.06 m out, so it scores a few centimetres. Triangle
 * count alone cannot tell those apart -- a wall subdivided into a hundred
 * coplanar quads is still flat -- which is exactly the failure mode this lab
 * exists to catch.
 *
 * Node AND browser. No THREE, no renderer.
 */

/** Outward frame of footprint edge `i`, matching `Facades.edgeFrame`. */
export function edgeFrames(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1e-6;
    out.push({
      i, ax: a.x, az: a.z, L,
      dx: dx / L, dz: dz / L,      // along
      nx: dz / L, nz: -dx / L,     // outward
    });
  }
  return out;
}

/**
 * Attribute every triangle in `mb` to a footprint edge and summarise each.
 *
 * @param {object} spec  the building spec (for `poly`, `front`, `base`, `h`)
 * @param {object} mb    a built MeshBuf (positions in world space)
 * @param {object} [o]
 * @param {number} [o.band=3.0]   max |perpendicular offset| still counted as
 *   belonging to the edge. Wide enough for a 0.9 m bay window and a fire
 *   escape, narrow enough to leave the roof and the opposite wall out.
 * @param {number} [o.overhang=0.6] how far past each end of the edge a
 *   triangle may sit and still count -- quoins and cornice returns wrap the
 *   corner slightly.
 * @param {number} [o.eave=0.1] metres above `base + h` at which the wall stops.
 *   Without this the roof deck, parapet clutter, chimneys, water tanks and mech
 *   housings all land inside the 3 m band of whichever edge they happen to sit
 *   near, and inflate that edge's relief to ~0.9 m -- i.e. exactly the number
 *   that would otherwise be read as "this party wall is richly modelled".
 * @returns {{edges:Array<object>, assigned:number, unassigned:number, tris:number}}
 */
export function edgeReport(spec, mb, o = {}) {
  const band = o.band ?? 3.0;
  const overhang = o.overhang ?? 0.6;
  const yTop = spec.base + spec.h + (o.eave ?? 0.1);
  const poly = spec.poly;
  const frames = edgeFrames(poly);
  const acc = frames.map((e) => ({
    i: e.i, L: e.L, nx: e.nx, nz: e.nz,
    front: spec.front.has(e.i),
    tris: 0, offs: [], yMin: Infinity, yMax: -Infinity,
  }));

  const p = mb.p, idx = mb.idx;
  let assigned = 0;
  const nTri = mb.ni / 3;
  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const cx = (p[a] + p[b] + p[c]) / 3;
    const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (cy > yTop) continue;                  // roof, not wall

    let best = -1, bestOff = 0, bestAbs = Infinity;
    for (const e of frames) {
      const rx = cx - e.ax, rz = cz - e.az;
      const along = rx * e.dx + rz * e.dz;
      if (along < -overhang || along > e.L + overhang) continue;
      const off = rx * e.nx + rz * e.nz;      // outward-positive
      const abs = Math.abs(off);
      if (abs > band || abs >= bestAbs) continue;
      best = e.i; bestOff = off; bestAbs = abs;
    }
    if (best < 0) continue;
    const s = acc[best];
    s.tris++; s.offs.push(bestOff);
    if (cy < s.yMin) s.yMin = cy;
    if (cy > s.yMax) s.yMax = cy;
    assigned++;
  }

  for (const s of acc) {
    s.height = s.tris ? Math.max(0, s.yMax - s.yMin) : 0;
    s.area = s.L * (s.height || 1e-6);
    s.triPerM2 = s.tris / (s.area || 1e-6);
    s.relief = spread(s.offs);
    s.reliefP95 = pct(s.offs, 0.95) - pct(s.offs, 0.05);
    s.offs = undefined;                        // keep the report small
  }
  return { edges: acc, assigned, unassigned: nTri - assigned, tris: nTri };
}

/** Population standard deviation. 0.000 means every triangle is coplanar. */
function spread(v) {
  const n = v.length;
  if (n < 2) return 0;
  let m = 0;
  for (const x of v) m += x;
  m /= n;
  let s = 0;
  for (const x of v) s += (x - m) * (x - m);
  return Math.sqrt(s / n);
}

function pct(v, q) {
  if (!v.length) return 0;
  const s = Float64Array.from(v).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** Axis-aligned bounds of a built MeshBuf, in world space. */
export function bounds(mb) {
  const p = mb.p;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0, n = mb.v * 3; i < n; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, y0, z0, x1, y1, z1,
           cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
           w: x1 - x0, h: y1 - y0, d: z1 - z0 };
}
