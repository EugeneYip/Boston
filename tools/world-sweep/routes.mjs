/**
 * BOSTON — canonical traversal routes.
 *
 * The static sweep waits for a settled world and then looks at it. That is the
 * right way to find a missing facade and the wrong way to find a LOD pop, a
 * streaming hole or a camera that drops through a kerb, because every one of
 * those only exists WHILE THE CAMERA IS MOVING. 126 settled views found nothing
 * new last pass; this is the other axis.
 *
 * Routes are derived from production geography and named by it, exactly as the
 * viewpoints are. A route is a ground-plane polyline plus an eye height; the
 * runner resolves elevation against the current world, so a route survives a
 * terrain change instead of drifting under it.
 *
 * Headless. Node only, no WebGL.
 *
 *   node tools/world-sweep/routes.mjs > tools/world-sweep/routes.json
 */
import { buildWorld } from '../model-lab/world.js';
import { buildParkPaths } from '../../src/world/ParkPaths.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Walking is 1.4 m/s; sampling every 2 m is roughly 0.7 Hz of world motion and
 *  is dense enough that a LOD swap cannot hide between two samples. Driving
 *  samples coarser because the interesting distances are longer. */
const WALK_STEP = 2.0;
const DRIVE_STEP = 6.0;
const EYE_WALK = 1.65;
const EYE_DRIVE = 1.35;

/**
 * Metres per second the route is meant to be travelled at. The runner turns
 * this into frames-per-sample, and it is load-bearing.
 *
 * The first version stepped a flat 2 frames per sample, which on a 6 m drive
 * step is 3 m per frame — 648 km/h. At that speed `Buildings` is behind for
 * 82.5% of a route and the sweep reports a streaming crisis. The same route at
 * 26 frames per sample, 0.23 m per frame, 50 km/h, is behind for 10%. The
 * backlog was the instrument, not the world.
 */
const WALK_MPS = 1.5;      // brisk walk
const DRIVE_MPS = 14;      // ~50 km/h, an arterial in traffic

/* -------------------------------------------------------------------------- */

function polySdf(pts, x, z) {
  let best = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = dx * dx + dz * dz;
    let t = L > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + dx * t - x, qz = a.z + dz * t - z;
    const d2 = qx * qx + qz * qz;
    if (d2 < best) best = d2;
    if ((b.z > z) !== (a.z > z) && x < (a.x - b.x) * (z - b.z) / (a.z - b.z) + b.x) inside = !inside;
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

/** Resample a polyline at a fixed spacing. */
function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / step));
  const out = [];
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const span = cum[seg] - cum[seg - 1] || 1;
    const t = (d - cum[seg - 1]) / span;
    const a = pts[seg - 1], b = pts[seg];
    out.push([+(a[0] + (b[0] - a[0]) * t).toFixed(1), +(a[1] + (b[1] - a[1]) * t).toFixed(1)]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */

export function buildRoutes() {
  const W = buildWorld();
  const { net, terrain, districts, plots } = W;
  const parkPaths = buildParkPaths({ parks: districts.parkPolys, net, water: terrain.bodies }).paths;

  const PC = 80, pg = new Map();
  for (const p of plots) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of p.polygon) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
    }
    for (let cx = Math.floor(x0 / PC); cx <= Math.floor(x1 / PC); cx++) {
      for (let cz = Math.floor(z0 / PC); cz <= Math.floor(z1 / PC); cz++) {
        const k = `${cx},${cz}`;
        let l = pg.get(k); if (!l) pg.set(k, l = []);
        l.push(p.polygon);
      }
    }
  }
  const inParcel = (x, z) => {
    for (const poly of (pg.get(`${Math.floor(x / PC)},${Math.floor(z / PC)}`) || [])) {
      if (polySdf(poly, x, z) > 0) return true;
    }
    return false;
  };
  const inWater = (x, z) => {
    for (const b of terrain.bodies) {
      if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
      if (polySdf(b.pts, x, z) > 0) return true;
    }
    return false;
  };
  const districtOf = (x, z) => districts.districtAt(x, z) || 'none';

  const out = [];

  /**
   * A route is rejected outright rather than producing false bugs later. The
   * checks are the ones a bad route actually fails: through a building, over
   * water, or with a discontinuity that would read as a teleport.
   */
  const accept = (r) => {
    if (r.pts.length < 8) return false;
    // A 1.5 km route at 2 m is 734 samples and tells you nothing the first 300
    // did not. Cap it so the whole sweep stays inside a few minutes.
    if (r.pts.length > 300) { r.truncatedFrom = r.pts.length; r.pts = r.pts.slice(0, 300); }
    let bad = 0, maxGap = 0;
    for (let i = 0; i < r.pts.length; i++) {
      const [x, z] = r.pts[i];
      if (inParcel(x, z) || inWater(x, z)) bad++;
      if (i) maxGap = Math.max(maxGap, Math.hypot(x - r.pts[i - 1][0], z - r.pts[i - 1][1]));
    }
    // A couple of samples clipping a parcel corner is a kerb, not a wall.
    if (bad > r.pts.length * 0.06) return false;
    if (maxGap > r.step * 2.5) return false;               // no teleport inside the run
    out.push(r);
    return true;
  };

  const edgePolyline = (e) => e.pts.map(p => [p.x, p.z]);

  /** Offset a road polyline sideways, for a pavement walk. */
  const offsetLine = (e, off, side) => {
    const src = e.pts;
    const o = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[Math.max(0, i - 1)], b = src[Math.min(src.length - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / L * side, nz = (b.x - a.x) / L * side;
      o.push([src[i].x + nx * off, src[i].z + nz * off]);
    }
    return o;
  };

  /* --- WALK: pavements, one per residential/urban district ---------------- */
  {
    const byD = new Map();
    for (const e of net.edges) {
      if (!(e.walk >= 0.3) || e.type === 'alley' || e.type === 'highway') continue;
      if (e.length < 150) continue;
      const mid = e.pts[(e.pts.length / 2) | 0];
      const d = districtOf(mid.x, mid.z);
      if (!byD.has(d)) byD.set(d, []);
      byD.get(d).push(e);
    }
    for (const [, l] of byD) l.sort((a, b) => b.length - a.length);
    for (const d of [...byD.keys()].sort()) {
      if (out.filter(r => r.cat === 'walk-sidewalk').length >= 6) break;
      const e = byD.get(d)[0];
      if (!e) continue;
      accept({
        id: `walk:sidewalk:e${e.id}`, kind: 'walk', cat: 'walk-sidewalk',
        district: d, note: `${e.name || e.type} pavement, ${e.length | 0} m`,
        why: 'longest public street with a footway in this district',
        eye: EYE_WALK, step: WALK_STEP, mps: WALK_MPS,
        pts: resample(offsetLine(e, e.halfRoad + 0.16 + e.walk * 0.5, 1), WALK_STEP),
      });
    }
  }

  /* --- WALK: park circulation and the promenade --------------------------- */
  {
    const want = [['Boston Common', 'diagonal'], ['Public Garden', 'loop'],
                  ['Commonwealth Avenue Mall 4', 'spine'], ['Charles River Esplanade', 'shore'],
                  ['Rose Kennedy Greenway', 'spine']];
    for (const [park, role] of want) {
      const p = parkPaths.filter(q => q.park === park && q.role === role)
        .sort((a, b) => b.length - a.length)[0];
      if (!p) continue;
      accept({
        id: `walk:park:${slug(park)}:${role}`, kind: 'walk',
        cat: role === 'shore' ? 'walk-promenade' : 'walk-park',
        district: districtOf(p.pts[0].x, p.pts[0].z),
        note: `${park} ${role}, ${p.length | 0} m`,
        why: 'a generated park walk, which is guaranteed clear of planting',
        eye: EYE_WALK, step: WALK_STEP, mps: WALK_MPS,
        pts: resample(p.pts.map(q => [q.x, q.z]), WALK_STEP),
      });
    }
  }

  /* --- DRIVE: arterials, curves, grades, bridges -------------------------- */
  const driveLine = (e) => {
    // Right-hand lane centre, so the camera sits where a car does.
    const off = Math.max(1.8, e.halfRoad * 0.5);
    return offsetLine(e, off, 1);
  };
  // One drive route per edge. `drive:junctions:e398` was otherwise byte-identical
  // to `drive:arterial:e398` — the same line driven twice under two names.
  const drivenEdges = new Set();
  const pushDrive = (id, cat, e, note, why) => {
    if (drivenEdges.has(e.id)) return false;
    const ok = accept({
      id, kind: 'drive', cat, district: districtOf(e.pts[0].x, e.pts[0].z),
      note, why, eye: EYE_DRIVE, step: DRIVE_STEP, mps: DRIVE_MPS,
      pts: resample(driveLine(e), DRIVE_STEP),
    });
    if (ok) drivenEdges.add(e.id);
    return ok;
  };

  {
    const art = net.edges.filter(e => e.type === 'arterial' && e.walk >= 0.3 && !e.bridged
                                   && e.length > 260).sort((a, b) => b.length - a.length);
    let n = 0;
    const seen = new Set();
    for (const e of art) {
      if (n >= 4) break;
      const d = districtOf(e.pts[0].x, e.pts[0].z);
      if (seen.has(d)) continue;
      if (pushDrive(`drive:arterial:e${e.id}`, 'drive-arterial', e,
                    `${e.name || 'arterial'}, ${e.length | 0} m`,
                    'longest straight arterial per district, right lane centre')) { seen.add(d); n++; }
    }
  }
  {
    // Sharpest bend by turn rate — the same measure the static `curve` views use.
    const curvy = [];
    for (const e of net.edges) {
      if (e.pts.length < 3 || e.length < 120 || !(e.walk >= 0.3) || e.bridged) continue;
      let worst = 0;
      for (let i = 1; i < e.pts.length - 1; i++) {
        const a = e.pts[i - 1], b = e.pts[i], c = e.pts[i + 1];
        const l0 = Math.hypot(b.x - a.x, b.z - a.z) || 1, l1 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
        let dt = Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x);
        while (dt > Math.PI) dt -= 2 * Math.PI;
        while (dt < -Math.PI) dt += 2 * Math.PI;
        worst = Math.max(worst, Math.abs(dt) / ((l0 + l1) * 0.5));
      }
      if (worst > 0.015) curvy.push({ e, worst });
    }
    curvy.sort((a, b) => b.worst - a.worst);
    let n = 0;
    for (const q of curvy) {
      if (n >= 2) break;
      if (pushDrive(`drive:curve:e${q.e.id}`, 'drive-curve', q.e,
                    `${q.e.name || 'street'}, ${(q.worst * 1000) | 0} mrad/m`,
                    'sharpest bend: kerbside placement and LOD both change fast here')) n++;
    }
  }
  {
    // Steepest grade — Charlestown's drumlin, where the road stamp works hardest.
    const graded = [];
    for (const e of net.edges) {
      if (e.bridged || e.length < 120 || !(e.walk >= 0.3)) continue;
      let rise = 0;
      for (let i = 1; i < e.pts.length; i++) rise = Math.max(rise, Math.abs(e.pts[i].y - e.pts[i - 1].y));
      const drop = Math.abs(e.pts[e.pts.length - 1].y - e.pts[0].y);
      if (drop > 8) graded.push({ e, drop, rise });
    }
    graded.sort((a, b) => b.drop - a.drop);
    let n = 0;
    for (const q of graded) {
      if (n >= 2) break;
      if (pushDrive(`drive:grade:e${q.e.id}`, 'drive-grade', q.e,
                    `${q.e.name || 'street'}, ${q.drop | 0} m of fall`,
                    'steepest graded road: terrain follow and road shelf show here first')) n++;
    }
  }
  {
    const seen = new Map();
    let n = 0;
    for (const e of net.edges) {
      if (!e.bridged || e.length < 80) continue;
      const nm = e.name || 'bridge';
      if ((seen.get(nm) || 0) >= 1) continue;
      if (n >= 2) break;
      if (pushDrive(`drive:bridge:e${e.id}`, 'drive-bridge', e,
                    `${nm} deck, ${e.length | 0} m`,
                    'a bridged edge: deck, approach and the drop to the water below')) {
        seen.set(nm, 1); n++;
      }
    }
  }
  {
    // A chain through consecutive junctions on one street: signals, corner
    // furniture and crossings arriving and leaving in sequence.
    const cand = net.edges.filter(e => e.walk >= 0.3 && e.type !== 'alley' && e.type !== 'highway'
                                    && e.length > 180 && !e.bridged)
      .sort((a, b) => (b.length) - (a.length));
    let n = 0;
    for (const e of cand) {
      if (n >= 2) break;
      const arms = [e.a, e.b].map(id => net.nodes[id]).filter(Boolean)
        .reduce((a, nd) => a + nd.edges.length, 0);
      if (arms < 6) continue;
      if (pushDrive(`drive:junctions:e${e.id}`, 'drive-junctions', e,
                    `${e.name || 'street'}, ${arms} arms at its ends`,
                    'a street whose ends are busy junctions, driven end to end')) n++;
    }
  }

  return { generated: new Date().toISOString().slice(0, 10), count: out.length, routes: out };
}

if (process.argv[1] && process.argv[1].endsWith('routes.mjs')) {
  const r = buildRoutes();
  process.stderr.write(`[routes] ${r.count} routes\n`);
  process.stdout.write(JSON.stringify(r));
}
