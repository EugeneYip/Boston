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
 * Poses are stored TERRAIN-INDEPENDENT: an `at` in the ground plane plus an
 * `eye` height above whatever the ground turns out to be, resolved at capture
 * time. Storing an absolute Y instead made the canonical set drift under the
 * world — the embankment fix moved ten of the first forty-nine cameras, one of
 * them by 11.3 m — and a regression baseline whose cameras move is not a
 * baseline. Terrain change now shows up as a METRIC (`groundY`) rather than as
 * a silently relocated viewpoint.
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

/** Stable, filename-safe key for a named source object. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const EYE = 1.65;                 // standing eye height, metres
const MIN_SEP = 140;              // keep two viewpoints of a category apart

/**
 * How many of each. Stratified by the context a player is in, not by area: the
 * outer world is most of the box and almost none of the game.
 */
const QUOTA = {
  street: 35, junction: 22, local: 15, traffic: 12,
  park: 14, water: 10, skyline: 10, special: 10,
};

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
  const { net, terrain, districts, plots, specs } = W;
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

  /**
   * Is there anything to look AT? Marches the aim direction and rejects a pose
   * whose view runs straight into a parcel within `reach`. `unstick` catches
   * this at capture time by retreating the camera, which silently relocates the
   * viewpoint -- one park camera in a 0.41 ha square was moved 50 m because its
   * loop aimed at a tower 17 m away. Better to never accept it.
   */
  const viewClear = (x, z, lookX, lookZ, reach = 26) => {
    const dx = lookX - x, dz = lookZ - z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3) return false;
    for (let d = 3; d <= reach; d += 2.5) {
      const px = x + (dx / L) * d, pz = z + (dz / L) * d;
      if (inParcel(px, pz, 0)) return false;
    }
    return true;
  };

  const out = [];
  const spaced = (cat, x, z, sep = MIN_SEP) =>
    !out.some(v => v.cat === cat && Math.hypot(v.at[0] - x, v.at[1] - z) < sep);

  /**
   * `srcId` is the view's IDENTITY and must be derived from the world, never
   * from position in this list. `street_05` meant "the sixth street view in
   * whatever set was generated", so changing a quota renamed everything and a
   * per-view baseline silently stopped matching. A road edge id does not move
   * when a quota does, so a surviving view keeps its name, a removed one is
   * detectable by absence, and a new one by being unknown.
   */
  const push = (cat, srcId, district, x, z, height, lookAt, note, why) => {
    // Elevated cameras look over the roofs; the ground-plane march does not
    // apply to them.
    if (height < 12 && !viewClear(x, z, lookAt[0], lookAt[2])) return false;
    out.push({
      id: srcId,
      ord: `${cat}_${out.filter(v => v.cat === cat).length.toString().padStart(2, '0')}`,
      cat, district, note, why,
      at: [+x.toFixed(1), +z.toFixed(1)],
      eye: +height.toFixed(2),
      aim: [+lookAt[0].toFixed(1), +lookAt[2].toFixed(1)],
      aimEye: +(lookAt[1] - terrain.groundHeight(lookAt[0], lookAt[2])).toFixed(2),
    });
    return true;
  };
  const count = (cat) => out.filter(v => v.cat === cat).length;

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
      const t = 0.42 + r() * 0.16;
      const f = edgeAt(e, t);
      const side = r() < 0.5 ? 1 : -1;
      const off = e.halfRoad + 0.16 + e.walk * 0.5;
      const nx = -f.tz * side, nz = f.tx * side;
      const x = f.x + nx * off, z = f.z + nz * off;
      if (inParcel(x, z, 0.5) || inWater(x, z, 1) || onCarriageway(x, z)) continue;
      const ahead = edgeAt(e, Math.min(1, 0.42 + 40 / e.length));
      cand.push({ x, z, d: districtOf(x, z), len: e.length, eid: e.id, t, side,
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
    for (let round = 0; round < 200 && count('street') < QUOTA.street; round++) {
      for (const k of keys) {
        if (count('street') >= QUOTA.street) break;
        const list = byD.get(k);
        const c = list[round];
        if (!c || !spaced('street', c.x, c.z, 110)) continue;
        push('street', `street:e${c.eid}@${c.t.toFixed(2)}:${c.side > 0 ? 'R' : 'L'}`,
             c.d, c.x, c.z, EYE, c.look, 'pavement, looking along the street',
             'on the footway of a public street >= 55 m, clear of parcel, water and carriageway');
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
      cand.push({ x, z, d: districtOf(x, z), arms: arms.length, nid: n.id, eid: e.id,
                  look: [n.x, terrain.groundHeight(n.x, n.z) + 1.3, n.z] });
    }
    cand.sort((a, b) => b.arms - a.arms || a.x - b.x);
    const byD = new Map();
    for (const c of cand) {
      if (!byD.has(c.d)) byD.set(c.d, []);
      byD.get(c.d).push(c);
    }
    const keys = [...byD.keys()].sort();
    for (let round = 0; round < 200 && count('junction') < QUOTA.junction; round++) {
      for (const k of keys) {
        if (count('junction') >= QUOTA.junction) break;
        const c = byD.get(k)[round];
        if (!c || !spaced('junction', c.x, c.z, 130)) continue;
        push('junction', `junction:n${c.nid}:e${c.eid}`,
             c.d, c.x, c.z, EYE, c.look, `${c.arms}-arm junction`,
             'corner footway of a 3+ arm junction, looking into the node');
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
    // One pass gives every park a view; later passes take the next-longest walk
    // in the biggest parks, so the Common is not represented by one camera.
    for (let round = 0; round < 6 && count('park') < QUOTA.park; round++) {
      for (const name of names) {
        if (count('park') >= QUOTA.park) break;
        const list = byPark.get(name).sort((a, b) => b.length - a.length);
        const p = list[round];
        if (!p) continue;
        const i = Math.floor(p.pts.length * 0.3);
        const a = p.pts[i], b = p.pts[Math.min(p.pts.length - 1, i + 14)];
        if (!a || !b || !spaced('park', a.x, a.z, 90)) continue;
        push('park', `park:${slug(name)}:${p.role}#${round}`,
             districtOf(a.x, a.z), a.x, a.z, EYE,
             [b.x, terrain.groundHeight(b.x, b.z) + 1.3, b.z], `${name} (${p.role})`,
             'standing on a park walk, which is guaranteed clear of planting');
      }
    }
  }

  /* --- waterfront --------------------------------------------------------- */
  {
    const r = rng(0x5EED04);
    for (const body of terrain.bodies) {
      if (count('water') >= QUOTA.water) break;
      const n = body.pts.length;
      for (let k = 0; k < n; k++) {
        if (count('water') >= QUOTA.water) break;
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
        if (!found || !spaced('water', found.x, found.z, 190)) continue;
        // Look ALONG the shore, not straight out to sea. A camera pointed at
        // open water puts half its frame in sky and half in a flat plane, which
        // reads as "empty waterfront" no matter what is on the bank behind it —
        // the first sweep flagged four such views as the least-detailed in the
        // world and the bank they were standing on was already the thing to fix.
        const ax = q.x - p.x, az = q.z - p.z;
        const al = Math.hypot(ax, az) || 1;
        push('water', `water:${slug(body.name)}:v${i}`,
             districtOf(found.x, found.z), found.x, found.z, EYE,
             [found.x + (ax / al) * 60 - gx * 6, terrain.groundHeight(found.x, found.z) + 1.2,
              found.z + (az / al) * 60 - gz * 6], `${body.name} shore, along the bank`,
             'first legal point 6-40 m inland of the ring, aimed along the shore not out to sea');
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
      cand.push({ x, z, lanes: e.lanes || 2, d: districtOf(x, z), eid: e.id,
                  look: [ahead.x, terrain.groundHeight(ahead.x, ahead.z) + 1.2, ahead.z] });
    }
    cand.sort((a, b) => b.lanes - a.lanes);
    for (const c of cand) {
      if (count('traffic') >= QUOTA.traffic) break;
      if (!spaced('traffic', c.x, c.z, 190)) continue;
      push('traffic', `traffic:e${c.eid}@0.50:L`,
           c.d, c.x, c.z, EYE, c.look, `${c.lanes}-lane arterial`,
           'kerb of an arterial >= 90 m, looking down the corridor');
    }
  }

  /* --- residential / local streets ---------------------------------------- */
  // A narrow two-lane street in a residential district is most of Boston and
  // almost none of the old shot list. Kept separate from `street` so a wide
  // arterial cannot stand in for a Beacon Hill mews.
  {
    const RES = new Set(['backBay', 'beaconHill', 'southEnd', 'northEnd', 'charlestown']);
    const r = rng(0x5EED05);
    const cand = [];
    for (const e of net.edges) {
      if (e.type !== 'street' || !(e.walk >= 0.3)) continue;
      if ((e.lanes || 2) > 2 || e.halfRoad > 6.5) continue;
      if (e.length < 40) continue;
      const t = 0.35 + r() * 0.3;
      const f = edgeAt(e, t);
      const d = districtOf(f.x, f.z);
      if (!RES.has(d)) continue;
      const side = r() < 0.5 ? 1 : -1;
      const off = e.halfRoad + 0.16 + e.walk * 0.5;
      const nx = -f.tz * side, nz = f.tx * side;
      const x = f.x + nx * off, z = f.z + nz * off;
      if (inParcel(x, z, 0.5) || inWater(x, z, 1) || onCarriageway(x, z)) continue;
      const ahead = edgeAt(e, Math.min(1, 0.35 + 32 / e.length));
      cand.push({ x, z, d, len: e.length, eid: e.id, t, side,
                  look: [ahead.x + nx * off * 0.5, terrain.groundHeight(ahead.x, ahead.z) + 1.4,
                         ahead.z + nz * off * 0.5] });
    }
    const byD = new Map();
    for (const c of cand) {
      if (!byD.has(c.d)) byD.set(c.d, []);
      byD.get(c.d).push(c);
    }
    for (const [, l] of byD) l.sort((a, b) => b.len - a.len);
    const keys = [...byD.keys()].sort();
    for (let round = 0; round < 200 && count('local') < QUOTA.local; round++) {
      for (const k of keys) {
        if (count('local') >= QUOTA.local) break;
        const c = byD.get(k)[round];
        if (!c || !spaced('local', c.x, c.z, 90)) continue;
        push('local', `local:e${c.eid}@${c.t.toFixed(2)}:${c.side > 0 ? 'R' : 'L'}`,
             c.d, c.x, c.z, EYE, c.look, 'residential street',
             'footway of a <=2-lane residential street in a named neighbourhood');
      }
    }
  }

  /* --- special structures -------------------------------------------------- */
  // The places the world is doing something unusual, and therefore the places a
  // rule is most likely to be wrong. Charlestown's road shelves were found from
  // exactly one such camera.
  {
    // Returns 'full' when the quota is met and the caller should stop, 'skip'
    // when only this candidate failed. Conflating the two let one spacing
    // rejection abort a whole sub-category: `steep` produced a single view.
    const add = (sub, srcId, x, z, eye, look, note, why) => {
      if (count('special') >= QUOTA.special) return 'full';
      if (inWater(x, z, 1)) return 'skip';
      if (!spaced('special', x, z, 120)) return 'skip';
      if (!push('special', srcId, districtOf(x, z), x, z, eye, look, `${sub}: ${note}`, why)) return 'skip';
      return 'ok';
    };
    const sub = (kind) => out.filter(v => v.cat === 'special' && v.note.startsWith(kind)).length;

    // Bridge decks — the camera stands ON the deck, so its eye is measured from
    // the road profile, not from the water underneath.
    const bridgeSeen = new Map();
    for (const e of net.edges) {
      if (!e.bridged || e.length < 60) continue;
      const nm = e.name || 'bridge';
      if ((bridgeSeen.get(nm) || 0) >= 2) continue;   // spread across bridges, not along one
      const f = edgeAt(e, 0.5);
      const off = e.halfRoad + 0.16 + Math.max(e.walk, 1.2) * 0.5;
      const x = f.x - f.tz * off, z = f.z + f.tx * off;
      const ahead = edgeAt(e, Math.min(1, 0.5 + 70 / e.length));
      const deckY = f.y !== undefined ? f.y : terrain.groundHeight(x, z);
      const eye = deckY - terrain.groundHeight(x, z) + EYE;
      const rc = add('bridge', `special:bridge:e${e.id}`, x, z, eye, [ahead.x, deckY + 1.3, ahead.z], nm,
                     'on a bridged edge, eye measured from the deck profile');
      if (rc === 'full') break;
      if (rc === 'ok') bridgeSeen.set(nm, (bridgeSeen.get(nm) || 0) + 1);
      if (sub('bridge') >= 3) break;
    }

    // Steep ground: the largest terrain fall within 40 m of a road.
    {
      const steep = [];
      for (const e of net.edges) {
        if (e.bridged || e.length < 50) continue;
        const f = edgeAt(e, 0.5);
        const g0 = terrain.groundHeight(f.x, f.z);
        let drop = 0;
        for (const d of [25, 40]) {
          for (const sgn of [1, -1]) {
            drop = Math.max(drop, Math.abs(g0 - terrain.groundHeight(f.x - f.tz * d * sgn, f.z + f.tx * d * sgn)));
          }
        }
        if (drop > 6) steep.push({ e, f, drop });
      }
      steep.sort((a, b) => b.drop - a.drop);
      for (const q of steep) {
        const off = q.e.halfRoad + 0.16 + q.e.walk * 0.5;
        const x = q.f.x - q.f.tz * off, z = q.f.z + q.f.tx * off;
        if (inParcel(x, z, 0.5) || onCarriageway(x, z)) continue;
        const ah = edgeAt(q.e, Math.min(1, 0.5 + 45 / q.e.length));
        const rc = add('steep', `special:steep:e${q.e.id}`, x, z, EYE, [ah.x, terrain.groundHeight(ah.x, ah.z) + 1.3, ah.z],
                       `${q.drop.toFixed(0)} m of fall within 40 m`,
                       'steepest ground beside a road: where a terrain rule breaks first');
        if (rc === 'full' || sub('steep') >= 3) break;
      }
    }

    // Sharp curves: the largest deviation of a polyline from its own chord.
    {
      // Sharpest BEND per metre, not deviation from a chord: a road that loops
      // back has a meaningless chord and reported "184 m off its chord", which
      // is a ring road, not a sharp corner.
      const curvy = [];
      for (const e of net.edges) {
        if (e.pts.length < 3 || e.length < 60 || !(e.walk >= 0.3)) continue;
        let worst = 0, at = 0.5;
        for (let i = 1; i < e.pts.length - 1; i++) {
          const a = e.pts[i - 1], b = e.pts[i], c = e.pts[i + 1];
          const l0 = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const l1 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
          let dt = Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x);
          while (dt > Math.PI) dt -= 2 * Math.PI;
          while (dt < -Math.PI) dt += 2 * Math.PI;
          const rate = Math.abs(dt) / ((l0 + l1) * 0.5);      // radians per metre
          if (rate > worst) { worst = rate; at = e.cum[i] / e.length; }
        }
        if (worst > 0.02) curvy.push({ e, mx: worst, at });
      }
      curvy.sort((a, b) => b.mx - a.mx);
      for (const q of curvy) {
        const f = edgeAt(q.e, Math.max(0.12, q.at - 0.12));
        const off = q.e.halfRoad + 0.16 + q.e.walk * 0.5;
        const x = f.x - f.tz * off, z = f.z + f.tx * off;
        if (inParcel(x, z, 0.5) || onCarriageway(x, z)) continue;
        const ah = edgeAt(q.e, Math.min(0.95, q.at + 0.16));
        const rc = add('curve', `special:curve:e${q.e.id}`, x, z, EYE, [ah.x, terrain.groundHeight(ah.x, ah.z) + 1.3, ah.z],
                       `${(q.mx * 1000).toFixed(0)} mrad/m bend`,
                       'sharpest bend on a street: kerbside placement is a chord/polyline trap here');
        if (rc === 'full' || sub('curve') >= 3) break;
      }
    }

    // A setback tower, seen from its own footway looking up the massing.
    {
      const towers = specs.filter(b => b.setbacks && b.setbacks.length && b.cx !== undefined)
        .sort((a, b) => (b.h || 0) - (a.h || 0));
      for (const b of towers) {
        const ang = (b.seed || 1) % 6.283;
        const rad = 34;
        const x = b.cx + Math.cos(ang) * rad, z = b.cz + Math.sin(ang) * rad;
        if (inParcel(x, z, 0.5) || onCarriageway(x, z)) continue;
        const rc = add('tower', `special:tower:x${Math.round(b.cx)}z${Math.round(b.cz)}`, x, z, EYE, [b.cx, (b.base || 0) + (b.h || 60) * 0.55, b.cz],
                       `${(b.h || 0).toFixed(0)} m setback tower`,
                       'footway beside the tallest setback towers, aimed up the massing');
        if (rc === 'full' || sub('tower') >= 3) break;
      }
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
    const targets = [[220, 40, -180], [560, 60, -320], [-500, 30, 60], [900, 50, -700]];
    let ti = 0;
    const ranked = [...byD.entries()].sort((p, q) => q[1].n - p[1].n).filter(e => e[1].n >= 60);
    for (let round = 0; round < 3 && count('skyline') < QUOTA.skyline; round++) {
      for (const [d, a] of ranked) {
        if (count('skyline') >= QUOTA.skyline) break;
        const cx = a.x / a.n + (round - 1) * 190, cz = a.z / a.n + (round - 1) * 150;
        const h = 70 + (count('skyline') % 3) * 35;
        const t = targets[ti++ % targets.length];
        if (inWater(cx, cz, 5) || !spaced('skyline', cx, cz, 220)) continue;
        push('skyline', `skyline:${d}:h${h}:r${round}`,
             d, cx, cz, h, t, `${d} built centroid, ${h} m up`,
             'above a district built centroid; roofs are half the frame from here');
      }
    }
  }

  return { generated: new Date().toISOString().slice(0, 10), count: out.length, views: out };
}

if (process.argv[1] && process.argv[1].endsWith('viewpoints.mjs')) {
  const v = buildViewpoints();
  process.stderr.write(`[sweep] ${v.count} viewpoints\n`);
  process.stdout.write(JSON.stringify(v, null, 1));
}
