/**
 * BOSTON — canonical world-sweep viewpoints.
 *
 * The hand-picked shot list in `CaptureHarness` grew to thirteen cameras and
 * every one of them now passes. That is a problem, not a result: five straight
 * passes ended with "suspicious visual -> investigation -> already correct",
 * which is what a saturated instrument looks like. This generates a broad,
 * stratified, DETERMINISTIC sample of the authored world instead, so a systemic
 * defect can no longer hide in the 99.9% of Boston nobody points a camera at.
 *
 * Every viewpoint is derived from production geometry -- a road midpoint, a
 * junction node, a park walk, a shoreline, a district centroid -- never typed
 * by hand. Positions therefore move with the world instead of going stale, and
 * the same seed reproduces the same sweep after any commit.
 *
 * Headless. Node only, no WebGL. Writes `viewpoints.json` for the browser half.
 *
 *   node tools/world-sweep/viewpoints.mjs > tools/world-sweep/viewpoints.json
 */
import { buildWorld } from '../model-lab/world.js';
import { buildParkPaths } from '../../src/world/ParkPaths.js';

/** xorshift32 — deterministic, and independent per category so one category's
 *  sample size cannot shift another's. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const EYE = 1.65;                 // standing eye height, metres
const MIN_SEP = 140;              // keep two viewpoints of a category apart

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

/** Point on an edge's own polyline at fraction `t`, with its unit tangent. */
function edgeAt(e, t) {
  const target = (e.length || 0) * Math.min(1, Math.max(0, t));
  const c = e.cum;
  let i = 1;
  while (i < c.length - 1 && c[i] < target) i++;
  const span = c[i] - c[i - 1] || 1;
  const u = (target - c[i - 1]) / span;
  const a = e.pts[i - 1], b = e.pts[i];
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u,
           tx: (b.x - a.x) / L, tz: (b.z - a.z) / L };
}

/* -------------------------------------------------------------------------- */

export function buildViewpoints() {
  const W = buildWorld();
  const { net, terrain, districts, plots } = W;
  const parkPaths = buildParkPaths({ parks: districts.parkPolys, net, water: terrain.bodies }).paths;

  // --- validity ------------------------------------------------------------
  // A camera artefact must never become a bug report, so a viewpoint is
  // rejected here rather than explained away later. The browser half applies a
  // second, exact test (`unstick` walks the real building meshes).
  const plotGrid = new Map();
  const PC = 80;
  for (const p of plots) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of p.polygon) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
    }
    for (let cx = Math.floor(x0 / PC); cx <= Math.floor(x1 / PC); cx++) {
      for (let cz = Math.floor(z0 / PC); cz <= Math.floor(z1 / PC); cz++) {
        const k = `${cx},${cz}`;
        let l = plotGrid.get(k);
        if (!l) plotGrid.set(k, l = []);
        l.push(p);
      }
    }
  }
  const inParcel = (x, z, pad = 0) => {
    for (const p of (plotGrid.get(`${Math.floor(x / PC)},${Math.floor(z / PC)}`) || [])) {
      if (polySdf(p.polygon, x, z) > -pad) return true;
    }
    return false;
  };
  const inWater = (x, z, pad = 0) => {
    for (const b of terrain.bodies) {
      if (x < b.minx - pad || x > b.maxx + pad || z < b.minz - pad || z > b.maxz + pad) continue;
      if (polySdf(b.pts, x, z) > -pad) return true;
    }
    return false;
  };
  const onCarriageway = (x, z) => {
    const ne = net.nearestEdge(x, z);
    if (!ne) return false;
    return ne.distance < net.edges[ne.edgeId].halfRoad;
  };

  const out = [];
  const spaced = (cat, x, z, sep = MIN_SEP) =>
    !out.some(v => v.cat === cat && Math.hypot(v.pos[0] - x, v.pos[2] - z) < sep);

  const push = (cat, district, x, z, height, lookAt, note) => {
    const y = terrain.groundHeight(x, z) + height;
    out.push({
      id: `${cat}_${out.filter(v => v.cat === cat).length.toString().padStart(2, '0')}`,
      cat, district, note,
      pos: [+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)],
      look: [+lookAt[0].toFixed(1), +lookAt[1].toFixed(2), +lookAt[2].toFixed(1)],
    });
  };

  const districtOf = (x, z) => districts.districtAt(x, z) || 'none';

  /* --- street-level mid-block ------------------------------------------- */
  // One per district first, then fill by length, so a dense neighbourhood
  // cannot take the whole sample. Camera stands on the pavement and looks along
  // the street, which is where a player spends most of the game.
  {
    const r = rng(0x5EED01);
    const cand = [];
    for (const e of net.edges) {
      if (!(e.walk >= 0.3) || e.type === 'alley' || e.type === 'highway') continue;
      if (e.length < 55) continue;
      const f = edgeAt(e, 0.42 + r() * 0.16);
      const side = r() < 0.5 ? 1 : -1;
      const off = e.halfRoad + 0.16 + e.walk * 0.5;
      const nx = -f.tz * side, nz = f.tx * side;
      const x = f.x + nx * off, z = f.z + nz * off;
      if (inParcel(x, z, 0.5) || inWater(x, z, 1) || onCarriageway(x, z)) continue;
      const ahead = edgeAt(e, Math.min(1, 0.42 + 40 / e.length));
      cand.push({ x, z, d: districtOf(x, z), len: e.length,
                  look: [ahead.x + nx * off * 0.4, terrain.groundHeight(ahead.x, ahead.z) + 1.4,
                         ahead.z + nz * off * 0.4] });
    }
    const byD = new Map();
    for (const c of cand) {
      if (!byD.has(c.d)) byD.set(c.d, []);
      byD.get(c.d).push(c);
    }
    for (const [, list] of byD) list.sort((a, b) => b.len - a.len);
    // Round-robin across districts until the quota is met.
    const keys = [...byD.keys()].sort();
    for (let round = 0; round < 40 && out.filter(v => v.cat === 'street').length < 14; round++) {
      for (const k of keys) {
        if (out.filter(v => v.cat === 'street').length >= 14) break;
        const list = byD.get(k);
        const c = list[round];
        if (!c || !spaced('street', c.x, c.z)) continue;
        push('street', c.d, c.x, c.z, EYE, c.look, 'pavement, looking along the street');
      }
    }
  }

  /* --- intersections ----------------------------------------------------- */
  {
    const r = rng(0x5EED02);
    const cand = [];
    for (const n of net.nodes) {
      const arms = n.edges.map(id => net.edges[id]).filter(e => e && e.walk >= 0.3
        && e.type !== 'alley' && e.type !== 'highway');
      if (arms.length < 3) continue;
      // Stand back on one arm's pavement and look into the node.
      const e = arms[0];
      const fromA = e.a === n.id;
      const f = edgeAt(e, fromA ? Math.min(0.5, 26 / e.length) : Math.max(0.5, 1 - 26 / e.length));
      const side = r() < 0.5 ? 1 : -1;
      const off = e.halfRoad + 0.16 + e.walk * 0.5;
      const x = f.x - f.tz * off * side, z = f.z + f.tx * off * side;
      if (inParcel(x, z, 0.5) || inWater(x, z, 1) || onCarriageway(x, z)) continue;
      cand.push({ x, z, d: districtOf(x, z), arms: arms.length,
                  look: [n.x, terrain.groundHeight(n.x, n.z) + 1.3, n.z] });
    }
    cand.sort((a, b) => b.arms - a.arms || a.x - b.x);
    const byD = new Map();
    for (const c of cand) {
      if (!byD.has(c.d)) byD.set(c.d, []);
      byD.get(c.d).push(c);
    }
    const keys = [...byD.keys()].sort();
    for (let round = 0; round < 40 && out.filter(v => v.cat === 'junction').length < 10; round++) {
      for (const k of keys) {
        if (out.filter(v => v.cat === 'junction').length >= 10) break;
        const c = byD.get(k)[round];
        if (!c || !spaced('junction', c.x, c.z, 180)) continue;
        push('junction', c.d, c.x, c.z, EYE, c.look, `${c.arms}-arm junction`);
      }
    }
  }

  /* --- park / open space -------------------------------------------------- */
  // Standing ON a walk: guaranteed clear of planting, and the one place in a
  // park a player actually is.
  {
    const byPark = new Map();
    for (const p of parkPaths) {
      if (!byPark.has(p.park)) byPark.set(p.park, []);
      byPark.get(p.park).push(p);
    }
    const names = [...byPark.keys()].sort();
    for (const name of names) {
      if (out.filter(v => v.cat === 'park').length >= 8) break;
      const p = byPark.get(name).sort((a, b) => b.length - a.length)[0];
      const i = Math.floor(p.pts.length * 0.3);
      const a = p.pts[i], b = p.pts[Math.min(p.pts.length - 1, i + 14)];
      if (!a || !b || !spaced('park', a.x, a.z, 120)) continue;
      push('park', districtOf(a.x, a.z), a.x, a.z, EYE,
           [b.x, terrain.groundHeight(b.x, b.z) + 1.3, b.z], `${name} (${p.role})`);
    }
  }

  /* --- waterfront --------------------------------------------------------- */
  {
    const r = rng(0x5EED04);
    for (const body of terrain.bodies) {
      if (out.filter(v => v.cat === 'water').length >= 5) break;
      const n = body.pts.length;
      for (let k = 0; k < n; k++) {
        if (out.filter(v => v.cat === 'water').length >= 5) break;
        const i = Math.floor(r() * n);
        const p = body.pts[i], q = body.pts[(i + 1) % n];
        // Outward from the water, on to the bank.
        const e = 1.0;
        let gx = polySdf(body.pts, p.x + e, p.z) - polySdf(body.pts, p.x - e, p.z);
        let gz = polySdf(body.pts, p.x, p.z + e) - polySdf(body.pts, p.x, p.z - e);
        const gl = Math.hypot(gx, gz);
        if (gl < 1e-6) continue;
        gx /= gl; gz /= gl;
        let found = null;
        for (let d = 6; d <= 40; d += 2) {
          const x = p.x - gx * d, z = p.z - gz * d;
          if (inWater(x, z, 0.5) || inParcel(x, z, 1) || onCarriageway(x, z)) continue;
          if (terrain.groundHeight(x, z) < body.level + 0.2) continue;
          found = { x, z };
          break;
        }
        if (!found || !spaced('water', found.x, found.z, 300)) continue;
        // Look ALONG the shore, not straight out to sea. A camera pointed at
        // open water puts half its frame in sky and half in a flat plane, which
        // reads as "empty waterfront" no matter what is on the bank behind it —
        // the first sweep flagged four such views as the least-detailed in the
        // world and the bank they were standing on was already the thing to fix.
        const ax = q.x - p.x, az = q.z - p.z;
        const al = Math.hypot(ax, az) || 1;
        push('water', districtOf(found.x, found.z), found.x, found.z, EYE,
             [found.x + (ax / al) * 60 - gx * 6, terrain.groundHeight(found.x, found.z) + 1.2,
              found.z + (az / al) * 60 - gz * 6], `${body.name} shore, along the bank`);
      }
    }
  }

  /* --- vehicle-heavy corridors -------------------------------------------- */
  {
    const cand = [];
    for (const e of net.edges) {
      if (e.type !== 'arterial' || !(e.walk >= 0.3) || e.length < 90) continue;
      const f = edgeAt(e, 0.5);
      const off = e.halfRoad + 0.16 + e.walk * 0.5;
      const x = f.x - f.tz * off, z = f.z + f.tx * off;
      if (inParcel(x, z, 0.5) || inWater(x, z, 1) || onCarriageway(x, z)) continue;
      const ahead = edgeAt(e, Math.min(1, 0.5 + 60 / e.length));
      cand.push({ x, z, lanes: e.lanes || 2, d: districtOf(x, z),
                  look: [ahead.x, terrain.groundHeight(ahead.x, ahead.z) + 1.2, ahead.z] });
    }
    cand.sort((a, b) => b.lanes - a.lanes);
    for (const c of cand) {
      if (out.filter(v => v.cat === 'traffic').length >= 6) break;
      if (!spaced('traffic', c.x, c.z, 260)) continue;
      push('traffic', c.d, c.x, c.z, EYE, c.look, `${c.lanes}-lane arterial`);
    }
  }

  /* --- elevated / skyline -------------------------------------------------- */
  // Above each authored district's own built centroid, looking at the downtown
  // mass. These are the views where roofs are half the frame.
  {
    const byD = new Map();
    for (const p of plots) {
      const d = p.district || 'none';
      let a = byD.get(d);
      if (!a) byD.set(d, a = { n: 0, x: 0, z: 0 });
      a.n++; a.x += p.polygon[0].x; a.z += p.polygon[0].z;
    }
    const targets = [[220, 40, -180], [560, 60, -320], [-500, 30, 60]];
    let ti = 0;
    for (const [d, a] of [...byD.entries()].sort((p, q) => q[1].n - p[1].n)) {
      if (out.filter(v => v.cat === 'skyline').length >= 6) break;
      if (a.n < 60) continue;
      const cx = a.x / a.n, cz = a.z / a.n;
      const h = 70 + (out.filter(v => v.cat === 'skyline').length % 3) * 35;
      const t = targets[ti++ % targets.length];
      push('skyline', d, cx, cz, h, t, `${d} centroid, ${h} m`);
    }
  }

  return { generated: new Date().toISOString().slice(0, 10), count: out.length, views: out };
}

if (process.argv[1] && process.argv[1].endsWith('viewpoints.mjs')) {
  const v = buildViewpoints();
  process.stderr.write(`[sweep] ${v.count} viewpoints\n`);
  process.stdout.write(JSON.stringify(v, null, 1));
}
