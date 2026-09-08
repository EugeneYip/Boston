/**
 * Generates `src/data/neu-walks.js` from the cached Sidewalk Centerline layer.
 *
 *   node tools/neu-walks/fetch.mjs && node tools/neu-walks/build.mjs
 *
 * Emits ONLY the ways named in `config.SELECTED`, projected to world metres and
 * validated against the geometry that already exists: no shipped way may cross a
 * hero footprint, enter the Huntington carriageway, or run inside the Krentzman
 * octagon (the park pipeline owns that ground and already has circulation there).
 * A way that fails validation is dropped with a reason rather than adjusted —
 * moving survey geometry to make it fit is how a factual path stops being one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geo } from '../../src/core/Geo.js';
import { NEU_HERO_PARTS } from '../../src/data/neu-hero.js';
import { PARKS, STREETS } from '../../src/data/boston-geo.js';
import { LAYER, SELECTED, ANCHOR_ONLY, KRENTZMAN } from './config.mjs';
import { FILE } from './fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'src', 'data', 'neu-walks.js');

const inPoly = (x, z, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
const segDist = (px, pz, line) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    let t = L2 ? ((px - a.x) * dx + (pz - a.z) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
};

const raw = JSON.parse(readFileSync(FILE, 'utf8'));

/**
 * Entrance evidence, from a public-domain source.
 *
 * A `PWALK-CL` private walk that DEAD-ENDS at a building face is prima facie
 * evidence of a door: paths lead to doors. That inference is worth making because
 * the alternative sources are both unusable. The university's own ArcGIS layer
 * publishes 82 accessible entrances at confidence A, but its terms are not
 * separately verified, so it stays REFERENCE ONLY and none of its coordinates may
 * enter runtime. And an authored guess is worse: tested against that reference, a
 * rule placing the door on the part edge nearest a shipped walk agreed on only
 * 1 of 5 buildings.
 *
 * Measured agreement of THIS rule against the same reference: 24 of 91
 * terminations (26%) fall within 15 m of an accessible entrance, and the
 * best-agreeing termination per building lands 1-22 m away on nine of twelve. 26%
 * is weak as a predictor of THE accessible door and that is expected — the
 * reference is accessible entrances only, roughly one per building, while a real
 * building has many doors. It is strong enough for "a door is somewhere along this
 * face", which is all a cue claims.
 *
 * One cue per part, at the termination closest to the face. NOT all 91: ninety-one
 * doorways would be the signage scene the brief forbids.
 */
const ENTRANCE_MAX_FACE_M = 2.0;   // a genuine dead-end at the wall, not a passer-by
const footprints = NEU_HERO_PARTS.map(p => p.outline.map(([x, z]) => ({ x, z })));
const octagon = PARKS.find(p => p.name === 'Krentzman Quadrangle').ring.map(([la, lo]) => geo(la, lo));
const huntington = STREETS.find(s => s.name === 'Huntington Avenue').path.map(([la, lo]) => geo(la, lo));
const HALF_CARRIAGEWAY = 7.0;

const byId = new Map();
for (const f of raw.features) {
  for (const path of (f.geometry?.paths || [])) {
    const pts = path.map(([lon, lat]) => geo(lat, lon));
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const prev = byId.get(f.attributes.OBJECTID);
    // A multipart way keeps its longest part; none of the selected ways is multipart.
    if (!prev || len > prev.len) {
      byId.set(f.attributes.OBJECTID, { id: f.attributes.OBJECTID, type: f.attributes.TYPE, pts, len });
    }
  }
}

const rejected = [];
function validate(w) {
  const crossesBuilding = w.pts.some(p => footprints.some(r => inPoly(p.x, p.z, r)));
  if (crossesBuilding) return 'crosses a hero footprint';
  const inCarriageway = w.pts.some(p => segDist(p.x, p.z, huntington) < HALF_CARRIAGEWAY);
  if (inCarriageway) return 'enters the Huntington carriageway';
  const inside = w.pts.filter(p => inPoly(p.x, p.z, octagon)).length;
  // Touching the boundary is the point of an arrival connector; running THROUGH
  // the quadrangle would duplicate the park circulation already there.
  if (inside > Math.max(1, w.pts.length * 0.25)) return 'runs inside the Krentzman octagon';
  return null;
}

const groups = {};
let shipped = 0, metres = 0;
for (const [role, ids] of Object.entries(SELECTED)) {
  groups[role] = [];
  for (const id of ids) {
    const w = byId.get(id);
    if (!w) { rejected.push({ id, role, why: 'not present in the layer extract' }); continue; }
    const why = validate(w);
    if (why) { rejected.push({ id, role, type: w.type, why }); continue; }
    groups[role].push(w);
    shipped++; metres += w.len;
  }
}

const num = (n) => Number(n.toFixed(2));

/** Nearest point on a closed ring, with the edge index. */
function nearestOnRing(x, z, ring) {
  let best = { d: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    let t = L2 ? ((x - a.x) * dx + (z - a.z) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * dx, qz = a.z + t * dz;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best.d) best = { d, x: qx, z: qz, edge: i, t, edgeLen: Math.hypot(dx, dz) };
  }
  return best;
}

const openRing = (ring) => {
  const o = ring.slice();
  const f = o[0], l = o[o.length - 1];
  if (o.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.z - l.z) < 1e-6) o.pop();
  return o;
};

/** One entrance cue per massed part, from PWALK-CL dead-ends. */
function entranceCues() {
  const parts = NEU_HERO_PARTS.map((p) => ({
    id: p.id, buildings: p.buildings, tier: p.tier,
    ring: openRing(p.outline.map(([x, z]) => ({ x, z }))),
  }));
  const best = new Map();
  for (const f of raw.features) {
    if (f.attributes.TYPE !== 'PWALK-CL') continue;
    for (const path of (f.geometry?.paths || [])) {
      if (path.length < 2) continue;
      for (const idx of [0, path.length - 1]) {
        const [lon, lat] = path[idx];
        const w = geo(lat, lon);
        for (const part of parts) {
          const n = nearestOnRing(w.x, w.z, part.ring);
          if (n.d > ENTRANCE_MAX_FACE_M || n.edgeLen < 5) continue;
          const prev = best.get(part.id);
          if (!prev || n.d < prev.faceDistM) {
            // Clamp off the corners HERE, and emit the clamped POSITION. A walk
            // commonly meets a building at a quoin, so half the raw terminations
            // land at t = 0 or 1; storing the clamped t but the raw x/z put the
            // point on the corner, and the runtime — which resolves from x/z —
            // then found an edge END and rejected the cue for want of width.
            // Measured: 6 of 8 cues silently emitted nothing.
            const t = Math.max(0.18, Math.min(0.82, n.t));
            const a = part.ring[n.edge], b = part.ring[(n.edge + 1) % part.ring.length];
            best.set(part.id, {
              part: part.id, buildings: part.buildings, tier: part.tier,
              x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
              edge: n.edge, t, edgeLenM: n.edgeLen,
              faceDistM: n.d, fromWay: f.attributes.OBJECTID,
            });
          }
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => a.part - b.part);
}
const wsrc = (w) => `    { id: ${w.id}, cls: '${w.type}', lengthM: ${num(w.len)},
      pts: [${w.pts.map(p => `[${num(p.x)},${num(p.z)}]`).join(', ')}] },`;

const src = `/**
 * Northeastern hero district — factual public-realm paths. GENERATED, do not hand-edit.
 *
 *   node tools/neu-walks/fetch.mjs && node tools/neu-walks/build.mjs
 *
 * Source:  City of Boston — Sidewalk Centerline (OpenData MapServer layer 5)
 * Licence: PDDL (Open Data Commons Public Domain Dedication and Licence)
 * Vintage: created 2011, last updated 2011
 * Service: ${LAYER}
 *
 * PDDL is a public-domain dedication — no attribution condition, no share-alike —
 * which is the whole reason this is the public-realm source. The OSM footway
 * extract in \`docs/neu/PUBLIC_REALM.json\` is ODbL and confidence C; committing it
 * as runtime geometry would attach share-alike obligations to the game. Do not
 * substitute it.
 *
 * **This is a deliberate SELECTION, not the network.** 11,439 m of centreline
 * exists inside the \`northeastern\` district; ${num(metres)} m ships. Every way here
 * was validated against the geometry that already exists — none crosses a hero
 * footprint, none enters the Huntington carriageway, none runs through the
 * Krentzman octagon, where the park pipeline already owns the circulation.
 *
 * Points are [x, z] in world metres, already projected through \`Geo.geo()\`.
 * Endpoints are shared between consecutive ways, so the route is genuinely
 * connected rather than a bundle of near-misses.
 */

/** Huntington public sidewalk -> the Krentzman octagon boundary. */
export const NEU_WALK_ARRIVAL = [
${groups.arrival.map(wsrc).join('\n')}
];

/** One continuation, westward off the quadrangle mouth. */
export const NEU_WALK_CONTINUATION = [
${groups.continuation.map(wsrc).join('\n')}
];

/**
 * The Huntington pavement itself. NOT drawn — \`Roads\` already builds that
 * sidewalk, and a second surface on top of it is a z-fighting seam along the most
 * important frontage in the district. Recorded because it is what the arrival
 * connector is anchored TO.
 */
export const NEU_WALK_ANCHOR_IDS = ${JSON.stringify(ANCHOR_ONLY)};

/**
 * One entrance cue per massed part, positioned ON that part's own outline at the
 * point where a PDDL private walk dead-ends against it. \`edge\` and \`t\` locate it
 * along the outline, so the runtime places geometry on its own footprint rather
 * than at an imported coordinate.
 */
export const NEU_ENTRANCE_CUES = ${JSON.stringify(entranceCues().map((c) => ({
  part: c.part, buildings: c.buildings, edge: c.edge, t: num(c.t),
  x: num(c.x), z: num(c.z), edgeLenM: num(c.edgeLenM), faceDistM: num(c.faceDistM),
  fromWay: c.fromWay,
})), null, 2)};

export const NEU_WALK_SOURCE = {
  dataset: 'Sidewalk Centerline',
  publisher: 'City of Boston (Analyze Boston / gisportal.boston.gov)',
  licence: 'PDDL (odc-pddl)',
  vintage: '2011 snapshot, last updated 2011',
  service: ${JSON.stringify(LAYER)},
  classes: { 'SWALK-CL': 'public sidewalk', 'PWALK-CL': 'private walk', 'CWALK-CL': 'crosswalk' },
  districtTotalM: 11439,
  shippedM: ${num(metres)},
  shippedWays: ${shipped},
  krentzman: ${JSON.stringify(KRENTZMAN)},
};

/** Ways named in config but dropped by validation, with the reason. */
export const NEU_WALK_REJECTED = ${JSON.stringify(rejected, null, 2)};
`;

writeFileSync(OUT, src);
console.log(`wrote ${OUT}`);
console.log(`  ${shipped} ways, ${metres.toFixed(0)} m shipped of 11,439 m available`);
for (const [role, ws] of Object.entries(groups)) {
  console.log(`  ${role}: ${ws.map(w => w.id + '(' + w.type + ',' + w.len.toFixed(0) + 'm)').join(' ')}`);
}
if (rejected.length) for (const r of rejected) console.log(`  DROPPED ${r.id} [${r.role}]: ${r.why}`);
