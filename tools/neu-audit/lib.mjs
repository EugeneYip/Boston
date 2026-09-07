/**
 * Shared geometry for the Northeastern factual audit.
 *
 * Everything here works in BOSTON world metres, obtained by pushing real
 * lat/lon through the game's own `geo()`. That is deliberate: the audit must
 * measure the world the way the game builds it, not through a second
 * projection of its own that could disagree.
 */
import { geo } from '../../src/core/Geo.js';

export { geo };

/** Perpendicular distance from p to segment ab, in metres. */
export function segDist(p, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const L2 = vx * vx + vz * vz;
  let t = L2 ? ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * vx), p.z - (a.z + t * vz));
}

/** Nearest distance from p to any vertex-pair of any polyline in `lines`. */
export function nearestOn(p, lines) {
  let best = Infinity;
  for (const line of lines)
    for (let i = 1; i < line.length; i++) {
      const d = segDist(p, line[i - 1], line[i]);
      if (d < best) best = d;
    }
  return best;
}

/** Even-odd point-in-polygon over world-space points. */
export function inPoly(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
    if (((zi > p.z) !== (zj > p.z)) && (p.x < (xj - xi) * (p.z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Area-weighted centroid of a world-space ring.
 *
 * Weighting areally rather than by vertex matters here: OSM and the university's
 * own footprints both carry far more vertices along a detailed street frontage
 * than across a plain back wall, so a plain vertex mean walks the centroid
 * toward the street and quietly inflates every anchor error measured against it.
 */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    a += f; cx += (ring[j].x + ring[i].x) * f; cz += (ring[j].z + ring[i].z) * f;
  }
  if (Math.abs(a) < 1e-9) {                    // degenerate ring: fall back to the mean
    const n = ring.length || 1;
    return { x: ring.reduce((s, q) => s + q.x, 0) / n, z: ring.reduce((s, q) => s + q.z, 0) / n, area: 0 };
  }
  a /= 2;
  return { x: cx / (6 * a), z: cz / (6 * a), area: Math.abs(a) };
}

/** OSM `out geom` element -> world ring (way) or outer-weighted centroid (relation). */
export function osmRing(e) {
  return e.geometry ? e.geometry.map(q => geo(q.lat, q.lon)) : null;
}
export function osmCentroid(e) {
  const ring = osmRing(e);
  if (ring) return ringCentroid(ring);
  if (!e.members) return null;
  const parts = e.members
    .filter(m => m.role !== 'inner' && m.geometry)
    .map(m => ringCentroid(m.geometry.map(q => geo(q.lat, q.lon))))
    .filter(c => c.area > 0);
  if (!parts.length) return null;
  const A = parts.reduce((s, c) => s + c.area, 0);
  return { x: parts.reduce((s, c) => s + c.x * c.area, 0) / A,
           z: parts.reduce((s, c) => s + c.z * c.area, 0) / A, area: A };
}

/** ArcGIS esriGeometryPolygon rings ([lon,lat] pairs) -> world centroid. */
export function esriCentroid(g) {
  if (!g?.rings?.length) return null;
  return ringCentroid(g.rings[0].map(([lon, lat]) => geo(lat, lon)));
}

/** Resample a world polyline every `step` metres. */
export function resample(pts, step = 20) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * (k / n), z: a.z + (b.z - a.z) * (k / n) });
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

export function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const q = p => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return { n: s.length, min: +s[0].toFixed(1), median: +q(0.5).toFixed(1),
           p90: +q(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1),
           mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
}
