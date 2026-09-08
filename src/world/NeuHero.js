import * as THREE from 'three';
import {
  MeshBuf, GlassBuf, SURF, buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial, polyCentroid, hash2,
} from './BuildingKit.js';
import { frontStorey, edgeFrame } from './Facades.js';
import { NEU_HERO_PARTS, NEU_HERO_BUILDINGS, NEU_HERO_SOURCE } from '../data/neu-hero.js';
import { NEU_WALK_ARRIVAL, NEU_WALK_CONTINUATION, NEU_WALK_SOURCE,
         NEU_ENTRANCE_CUES } from '../data/neu-walks.js';
import { DISTRICTS, PARKS, STREETS } from '../data/boston-geo.js';
import { corridorHalf } from './RoadNetwork.js';
import { geo } from '../core/Geo.js';
import { GROUP, groups } from '../physics/PhysicsWorld.js';

/**
 * Northeastern's Krentzman / Huntington opening cluster, massed from survey data.
 *
 * Every volume here is a PDDL roof-break polygon from the City of Boston,
 * extruded to its own recorded height. Nothing is drawn by eye and nothing is
 * imported as a mesh — `src/data/neu-hero.js` carries the outlines, this file
 * turns them into geometry.
 *
 * It is deliberately built the way `Landmarks` is, not the way `Buildings` is:
 * one merged opaque mesh sharing the city facade material, so the whole cluster
 * costs ONE draw call, and one trimesh collider per part cut out of that same
 * merged buffer. There is no streaming and no chunking because there is nothing
 * to stream — 18 parts and roughly 3k triangles is far below the point where
 * culling pays for itself, and a resident mesh cannot develop the ghost-collider
 * problem that a streamed one can.
 *
 * The procedural generator is kept off this ground by
 * `Districts.inHeroFootprint` (plot generation) and `Buildings.heroOverlap`
 * (exact parcel overlap). Both run at init, so a wrong building is never built
 * rather than built and hidden.
 */

/* -------------------------------------------------------------------------- */
/* Material language                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A small shared family, chosen by DOCUMENTED CONSTRUCTION YEAR rather than by
 * anyone's impression of a building, so it is reproducible and arguable from
 * evidence. Years come from the university's own inventory
 * (docs/neu/BUILDING_INVENTORY.json).
 *
 *   pre-1960   the collegiate core — Ryder and Hastings 1913, Richards 1938,
 *              Mugar 1941, Ell 1947, Dodge 1952, Cabot 1954, Hayden 1956
 *   1960-1979  Curry 1964, Dana 1966
 *   1980+      Snell 1984/88, Shillman 1995, Egan 1996
 *
 * This is a broad era cue, NOT a claim about any specific wall: `yearBuilt` does
 * not distinguish an original fabric from a re-clad one, and Mugar in particular
 * reads as later than its 1941 date. Being consistently wrong from a stated rule
 * is worth more than being unevenly right from memory, and it is one line to
 * change when façade evidence arrives.
 */
const ERA = [
  { before: 1960, body: 'brick_red',   base: 'granite',   roof: 'roof_tar' },
  { before: 1980, body: 'concrete',    base: 'granite',   roof: 'roof_gravel' },
  { before: 9999, body: 'brick_brown', base: 'limestone', roof: 'roof_gravel' },
];

/** Documented year built, by building name. */
const YEAR = {
  'Ryder Hall': 1913, 'Hastings Hall': 1913, 'Richards Hall': 1938,
  'Mugar Life Sciences Building': 1941, 'Ell Hall': 1947, 'Dodge Hall': 1952,
  'Cabot Center (& Barletta Natatorium)': 1954, 'Hayden Hall': 1956,
  'Curry Student Center': 1964, 'Dana Research Center': 1966,
  'Shillman Hall': 1995, 'Egan Engineering/Science Research Center': 1996,
};

const COL = {
  brick_red:   [0.74, 0.46, 0.38],
  brick_brown: [0.66, 0.52, 0.44],
  concrete:    [0.72, 0.70, 0.66],
  granite:     [0.62, 0.61, 0.60],
  limestone:   [0.80, 0.78, 0.72],
  roof_tar:    [0.30, 0.30, 0.31],
  roof_gravel: [0.42, 0.41, 0.39],
};

/** Height of the stone base course. A real one is a storey or less. */
const BASE_H = 1.6;

/**
 * A part shared by two named buildings takes the EARLIER year: 661061 is the
 * dominant mass of both Ell (1947) and Curry (1964), and the mass originated
 * with Ell. Saying so explicitly beats depending on array order.
 */
function eraFor(part) {
  let year = 9999;
  for (const name of part.buildings) {
    const y = YEAR[name];
    if (y && y < year) year = y;
  }
  return ERA.find(e => year < e.before) ?? ERA[ERA.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Facade typology                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Three typologies, because one rhythm across the cluster would be a lie.
 *
 * Windows come from `Facades.frontStorey` — the same primitive the generated city
 * uses, so the panes are the same shader, the reveals are the same geometry and
 * everything lands in the same two buffers. What differs here is that the bay
 * rhythm is chosen per typology instead of rolled from a district style mix, and
 * the storey count comes from recorded evidence rather than from a style's
 * `storeys` range.
 *
 * The target is typological credibility at pedestrian distance, NOT architectural
 * reconstruction: floor rhythm, bay spacing, solid-to-glass ratio and a base /
 * body / top separation. No sash counts, no carving, no signage.
 */
const TYPO = {
  /**
   * The pre-1960 collegiate core: Ryder, Hastings, Richards, Mugar, Ell/Curry,
   * Dodge, Hayden. Deliberately ONE composition — same window kind, same reveal
   * depth, stone ground storey under a masonry body, modest cornice. Only bay
   * width and window proportion vary, and they vary from each part's own seed so
   * the four quadrangle halls relate without being identical.
   */
  collegiate: {
    bayW: 2.95, winW: 1.34, winH: 2.18, sillH: 0.95, reveal: 0.20, winKind: 1,
    cornice: 0.36, corniceOut: 0.16, plinth: 0.40, stoneGround: true,
  },
  /**
   * 1960+ research: Dana, Egan, Shillman. Wider bays, shallower reveal, squarer
   * opening — a frame building rather than a load-bearing masonry one.
   */
  research: {
    bayW: 3.60, winW: 2.26, winH: 1.96, sillH: 0.88, reveal: 0.15, winKind: 2,
    cornice: 0.22, corniceOut: 0.10, plinth: 0.35, stoneGround: false,
  },
  /**
   * Large-span athletic: Cabot. A field house is not five storeys of windows, so
   * it does NOT get a storey rhythm. One high clerestory band on wide piers over
   * a mostly solid wall, which is what the building actually is, and what keeps
   * it reading wide and low against the word "arena".
   */
  largeSpan: {
    bayW: 9.00, winW: 5.20, winH: 2.40, sillH: 0.45, reveal: 0.14, winKind: 1,
    cornice: 0.30, corniceOut: 0.12, plinth: 0.45, stoneGround: false,
    clerestoryAt: 0.58,
  },
};

/** Building -> typology. Everything unlisted is collegiate. */
const TYPO_OF = {
  'Cabot Center (& Barletta Natatorium)': 'largeSpan',
  'Dana Research Center': 'research',
  'Egan Engineering/Science Research Center': 'research',
  'Shillman Hall': 'research',
};

const BUILDING = new Map(NEU_HERO_BUILDINGS.map(b => [b.name, b]));

/**
 * Which typology a PART belongs to, and on whose evidence.
 *
 * A shared part takes the EARLIEST-year claimant, exactly as the material family
 * does: 661061 is the dominant mass of both Ell (1947) and Curry (1964), so it is
 * collegiate on Ell's evidence rather than research on Curry's.
 */
function typoFor(part) {
  let best = null;
  for (const name of part.buildings) {
    const b = BUILDING.get(name);
    if (!b) continue;
    if (!best || (b.yearBuilt ?? 9999) < (best.yearBuilt ?? 9999)) best = b;
  }
  const key = best ? (TYPO_OF[best.name] || 'collegiate') : 'collegiate';
  return { key, T: TYPO[key], owner: best };
}

/**
 * Storey courses for a part, from the parent building's recorded course height.
 *
 * A wing must step in the SAME courses as the mass it belongs to, so the course
 * comes from the parent and the floor count from this part's own height. Ryder's
 * 12.36 m lower wing at Ryder's 4.33 m course is 3 storeys, not the 3.25 that
 * dividing by a nominal 3.8 would give.
 */
function coursesFor(part, owner, spanM) {
  const course = owner?.courseM || 3.8;
  const n = Math.max(1, Math.round(spanM / course));
  return { n, course: spanM / n, courseSource: owner?.storeyConfidence || 'DERIVED' };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Roof caps must be properly triangulated, not fanned.
 *
 * `MeshBuf.cap` fans from vertex 0, which is correct for the convex-ish plans
 * `Landmarks` feeds it and WRONG here: these are survey outlines, and Ell's is
 * 95 vertices of courtyard and wing. A fan across a concave ring lays triangles
 * outside the building. Emitting one 3-vertex `cap` per triangle keeps the
 * shared code path and is always right; the duplicated corner vertices cost
 * nothing at this scale.
 */
function capPoly(mb, ring, y, surf, col) {
  const v2 = ring.map(p => new THREE.Vector2(p.x, p.z));
  if (THREE.ShapeUtils.area(v2) < 0) v2.reverse();
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { tris = null; }
  if (!tris?.length) { mb.cap(ring, y, surf, col, true); return 0; }
  for (const t of tris) {
    mb.cap([{ x: v2[t[0]].x, z: v2[t[0]].y },
            { x: v2[t[1]].x, z: v2[t[1]].y },
            { x: v2[t[2]].x, z: v2[t[2]].y }], y, surf, col, true);
  }
  return tris.length;
}

/** Outward-facing walls need consistent winding; `MeshBuf.wall` takes the
 *  normal from the edge direction, so a reversed ring lights from inside. */
function orientRing(ring) {
  const v2 = ring.map(p => new THREE.Vector2(p.x, p.z));
  return THREE.ShapeUtils.area(v2) > 0 ? ring.slice().reverse() : ring;
}

/* -------------------------------------------------------------------------- */
/* Campus ground                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Local surface ownership around the opening cluster.
 *
 * Wave 3A left the Krentzman lawn stopping dead at the reservation octagon, with
 * bare terrain beyond it — so the octagon, which is an APPROXIMATION (recorded
 * area about a recorded centre, not a surveyed boundary), had become the visible
 * edge of campus. This surface exists to take that job away from it. The octagon
 * keeps its lawn; it just stops being the edge of anything.
 *
 * The shape is not authored. A generous contour is derived from the factual
 * footprints and then CONSTRAINED, so the boundary is decided by evidence rather
 * than by taste:
 *
 *   contour  convex hull of the opening cluster's footprints, dilated radially
 *            (radial dilation of a convex hull cannot self-intersect)
 *   holes    the Krentzman octagon and every footprint inside the contour, so
 *            building-to-ground edges are exact rather than jagged
 *   rejected any triangle whose centroid falls outside the `northeastern`
 *            district, inside the Huntington corridor, or inside a procedural
 *            building — the last is essential: procedural fabric still stands on
 *            this ground and lawn under a brownstone is worse than bare dirt
 *
 * Terrain is untouched. This is a surface laid ON it, with the same
 * `polygonOffset` the park surfaces use, and NO collider — the player keeps
 * walking on the terrain heightfield, which is what kept Wave 3A's max vertical
 * snap inside the quad at 12 mm.
 */
const GROUND = {
  near: 110,        // m from the quad centre: which footprints define the contour
  dilate: 24,       // m of ground beyond the hull
  maxEdge: 7,       // m — subdivision, so the surface follows the ground
  // Road keep-out is taken from the ROAD, not guessed: `corridorHalf` is
  // `halfRoad + KERB + walk`, which for Huntington (arterial, 4 lanes) is
  // 7.0 + 0.16 + 3.6 = 10.76 m — and the PDDL sidewalk centreline there measures
  // 10.8 m, so the city's own footway sits exactly on that edge. A fixed 11 m
  // keep-out would therefore have laid campus ground ON the Huntington pavement:
  // two coplanar surfaces z-fighting along the most important frontage in the
  // district. `verge` is the strip left between the two.
  verge: 1.2,       // m of terrain left between the city footway and campus ground
  roadKeepFallback: 12,   // m, used only if the road network is unavailable
  walkHalf: 2.2,    // m — paved corridor either side of a factual centreline
  // The ground is mostly a BAND between buildings, so a generous apron eats it:
  // at 3.5 m the surface came out 50% paved, which reads as a service yard rather
  // than a campus. 2.2 m is a walk against a wall, and lawn stays dominant.
  apron: 2.2,       // m of paved ground against a building face
  /**
   * How far maintained ground reaches from the built form.
   *
   * The contour is a hull dilated RADIALLY from its own centroid, and the hull of
   * this cluster is elongated — so the dilation overshoots at the extremes. It put
   * lawn 150 m east of the nearest hero building, ending in a hard straight line
   * against bare terrain: exactly the visible "game zone" edge the brief forbids.
   * Measured from directly overhead, that edge was unmistakable.
   *
   * Rejecting by distance to the nearest building FACE instead makes the boundary
   * follow the built form, so it reads as a campus verge rather than a zone edge,
   * and it costs one test rather than a new envelope.
   */
  reach: 30,        // m from the nearest hero footprint edge
  walkReach: 8,     // m either side of a shipped walk, so paths keep their ground
};

const _cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && _cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && _cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}
function pointInRing(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
function distToPolyline(x, z, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    let t = L2 ? ((x - a.x) * dx + (z - a.z) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}
/** Strip a closed ring's duplicated last vertex. */
function openRing(ring) {
  const out = ring.slice();
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.z - l.z) < 1e-6) out.pop();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entrance cues                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One doorway per building, where a PDDL private walk dead-ends against its face.
 *
 * The claim is "people enter along here", not "this is the main entrance" — the
 * audit established an urban campus with several gateway conditions and no single
 * authoritative principal door, and the university's own accessible-entrance layer
 * places NONE of its 82 points on the Krentzman quadrangle frontage or the
 * Huntington-facing frontage of the arrival composition. So this is deliberately
 * modest: a recess, a darker opening, a threshold, and a slightly taller head.
 * No signage, no canopy that evidence does not support, no ceremonial gate.
 *
 * It is emitted into the SAME buffers as the facade, so it adds no material and no
 * draw call, and collision is unaffected because that comes from a separate plain
 * -prism buffer — a doorway cannot add per-door collision here even by accident.
 */
const ENTRANCE = {
  width: 2.6,       // m — a pair of doors
  height: 2.75,     // m to the head
  reveal: 0.40,     // m of recess; deep enough to shadow, shallow enough not to clip
  threshold: 0.12,  // m step proud of the ground
  surround: 0.34,   // m of stone reveal either side
};

/**
 * Emit one entrance cue on an edge, at `u` along it.
 *
 * `spec` is the part's facade spec, so the surround takes the building's own trim
 * surface and the recess its wall surface — an entrance that belongs to the
 * building rather than being applied to it.
 */
function entranceCue(mb, gb, e, u, y0, spec) {
  const E = ENTRANCE;
  const half = E.width / 2;
  const u0 = Math.max(0.2, u - half), u1 = Math.min(e.L - 0.2, u + half);
  if (u1 - u0 < 1.4) return 0;                    // no room on this edge
  const top = y0 + E.height;
  const before = mb.ni;

  // Jambs and head soffit, cut back into the wall.
  const dep = E.reveal;
  const uvJ = [0, 0, dep, 0, dep, E.height, 0, E.height];
  mb.quadAuto(P2(e, u0, y0, 0), P2(e, u0, y0, -dep), P2(e, u0, top, -dep), P2(e, u0, top, 0),
    e.dx, 0, e.dz, uvJ, spec.trimCol, spec.trimSurf);
  mb.quadAuto(P2(e, u1, y0, 0), P2(e, u1, y0, -dep), P2(e, u1, top, -dep), P2(e, u1, top, 0),
    -e.dx, 0, -e.dz, uvJ, spec.trimCol, spec.trimSurf);
  const uvH = [0, 0, u1 - u0, 0, u1 - u0, dep, 0, dep];
  mb.quadAuto(P2(e, u0, top, 0), P2(e, u1, top, 0), P2(e, u1, top, -dep), P2(e, u0, top, -dep),
    0, -1, 0, uvH, spec.trimCol, spec.trimSurf);

  // The opening itself: a dark glazed leaf set at the back of the reveal. Uses the
  // same pane path as every window, so it lights at night with the rest.
  const a = P2(e, u0 + 0.06, y0 + E.threshold, -dep);
  const b = P2(e, u1 - 0.06, y0 + E.threshold, -dep);
  const c = P2(e, u1 - 0.06, top - 0.06, -dep);
  const d = P2(e, u0 + 0.06, top - 0.06, -dep);
  gb.pane(a, b, c, d, [e.nx, 0, e.nz], [e.dx, 0, e.dz],
    Math.max(0.6, u1 - u0), Math.max(0.6, E.height), 3.4,
    hash2(spec.seed, 4241), spec.lit, spec.S.winKind, [0.22, 0.23, 0.25]);

  // Threshold, and a stone surround that reads as a slightly stronger bay.
  const mu = (u0 + u1) * 0.5;
  const mp = P2(e, mu, 0, 0);
  const rot = Math.atan2(e.nx, e.nz);
  mb.box(mp[0] + e.nx * 0.16, y0 + E.threshold * 0.5, mp[2] + e.nz * 0.16,
    (u1 - u0) + 0.5, E.threshold, 0.34, rot, spec.trimSurf, spec.trimCol);
  mb.box(mp[0] + e.nx * 0.07, top + 0.14, mp[2] + e.nz * 0.07,
    (u1 - u0) + E.surround * 2, 0.28, 0.20, rot, spec.trimSurf, spec.trimCol);
  return mb.ni - before;
}

/** `Facades.P` is module-private, so the frame maths is repeated here. */
function P2(e, u, y, off) {
  return [e.ax + e.dx * u + e.nx * (off || 0), y, e.az + e.dz * u + e.nz * (off || 0)];
}

export default class NeuHero {
  static id = 'neuHero';
  static label = 'Northeastern hero cluster';
  static deps = ['assets'];

  constructor() {
    this.meshes = [];
    this.parts = [];
    this.body = null;
    this.stats = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = 'neu_hero';
    ctx.scene.add(root);
    this.root = root;

    // Share the city's facade material. A separate material here would cost a
    // second shader program and a second draw call for eighteen boxes.
    const b = ctx.get('buildings');
    if (b?.matOpaque && b?.matGlass) {
      this.matOpaque = b.matOpaque;
      this.matGlass = b.matGlass;
      this._ownsMaterial = false;
    } else {
      const assets = ctx.assets;
      const atlas = buildAtlas();
      const rooms = assets ? assets.texture('bk_rooms', buildRoomAtlas) : buildRoomAtlas();
      const macro = assets ? assets.texture('bk_macro', buildMacroNoise) : buildMacroNoise();
      this.matOpaque = makeOpaqueMaterial(atlas, rooms, macro);
      this.matGlass = makeGlassMaterial(rooms);
      this._ownsMaterial = true;
    }

    const city = ctx.get('city');
    const groundAt = (city && typeof city.groundHeight === 'function')
      ? (x, z) => city.groundHeight(x, z) : () => 0;

    const mb = new MeshBuf(65536);            // visible shell + facade
    const gb = new GlassBuf(16384);           // window panes
    // Collision is built from its OWN plain prisms, never from the facade.
    // The brief is building-volume collision, and a trimesh cut from the visible
    // buffer would now include every jamb, sill and lintel — per-window
    // collision by accident, at ten times the collider triangles, for a surface
    // the player can never touch. This buffer is disposed the moment Rapier has
    // copied it.
    const cb = new MeshBuf(8192);
    let capTris = 0, bays = 0, storeysEmitted = 0, entranceTris = 0, entranceCount = 0;
    for (const part of NEU_HERO_PARTS) {
      // Outlines are closed rings; the duplicated last vertex would emit a
      // zero-length wall and a degenerate cap triangle.
      let ring = part.outline.map(([x, z]) => ({ x, z }));
      const f = ring[0], l = ring[ring.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.z - l.z) < 1e-6) ring.pop();
      if (ring.length < 3) continue;
      ring = orientRing(ring);

      // Sit on the GAME terrain, not on the source's GRND_ELEV_2010: the two
      // datums agree only by luck, and a building that floats is a worse error
      // than one whose plinth is 300 mm out. The floor goes to the lowest
      // ground under the outline so no gap can open on a slope; the roof is
      // measured from the ground at the centroid, which is what the source's
      // single per-part ground elevation actually represents.
      const c = polyCentroid(ring);
      let gMin = Infinity;
      for (const p of ring) { const g = groundAt(p.x, p.z); if (g < gMin) gMin = g; }
      const gRef = groundAt(c.x, c.z);
      if (!Number.isFinite(gMin) || !Number.isFinite(gRef)) continue;
      const floor = gMin - 0.5;
      const top = gRef + part.heightM;

      const era = eraFor(part);
      const bodyCol = COL[era.body], baseCol = COL[era.base], roofCol = COL[era.roof];
      const { key: typoKey, T, owner } = typoFor(part);

      // ---- collision: one plain prism, exactly what Wave 2C shipped ---------
      const ci0 = cb.ni;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], d = ring[(i + 1) % ring.length];
        cb.wall(a.x, a.z, d.x, d.z, floor, top, era.body, bodyCol, 0, 0);
      }
      capPoly(cb, ring, top, era.roof, roofCol);
      const ci1 = cb.ni;

      // ---- visible shell ---------------------------------------------------
      const plinthTop = Math.min(gRef + T.plinth, top - 0.4);
      const corniceBot = Math.max(plinthTop + 0.6, top - T.cornice);
      // A part this short is a link, a canopy or a loggia. Fenestrating it would
      // put a storey of windows into 2 m of wall; it stays a plain mass.
      const fenestrate = (corniceBot - plinthTop) >= 4.2;

      // Per-part variation, seeded so it is stable across reboots: the four
      // quadrangle halls should relate, not match.
      const jit = hash2(part.id, 7717);
      const bayW = T.bayW * (0.94 + jit * 0.12);
      const spec = {
        S: { ...T, bayW },
        wallSurf: era.body, wallCol: bodyCol,
        trimSurf: era.base, trimCol: baseCol,
        uOff: (part.id % 97) * 0.13,
        seed: part.id, base: gRef, lit: 0.26 + jit * 0.34,
        arched: false, purpleGlass: false, shutters: false,
      };
      const stoneSpec = { ...spec, wallSurf: era.base, wallCol: baseCol };

      // Resolve this part's entrance cue against the ORIENTED ring by position,
      // not by the stored edge index: `orientRing` reverses a ring whose signed
      // area comes out positive, which would renumber every edge.
      const cueSrc = NEU_ENTRANCE_CUES.find((q) => q.part === part.id);
      let cue = null;
      if (cueSrc) {
        let best = { d: Infinity };
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b2 = ring[(i + 1) % ring.length];
          const dx = b2.x - a.x, dz = b2.z - a.z, L2 = dx * dx + dz * dz;
          let t = L2 ? ((cueSrc.x - a.x) * dx + (cueSrc.z - a.z) * dz) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(cueSrc.x - (a.x + t * dx), cueSrc.z - (a.z + t * dz));
          if (d < best.d) best = { d, edge: i, u: t * Math.sqrt(L2) };
        }
        if (best.d < 2.5) cue = best;
      }

      const i0 = mb.ni;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], d = ring[(i + 1) % ring.length];
        const e = edgeFrame(a, d);
        if (e.L < 0.05) continue;
        // plinth: the ground contact, always solid
        mb.wall(a.x, a.z, d.x, d.z, floor, plinthTop, era.base, baseCol, i * 2.7, 0);
        if (!fenestrate) {
          mb.wall(a.x, a.z, d.x, d.z, plinthTop, corniceBot, era.body, bodyCol, i * 3.1, 0);
        } else if (typoKey === 'largeSpan') {
          // One clerestory band high on a mostly solid wall.
          const cs = gRef + part.heightM * T.clerestoryAt;
          const ce = Math.min(cs + T.sillH + T.winH + 0.5, corniceBot);
          mb.wall(a.x, a.z, d.x, d.z, plinthTop, cs, era.body, bodyCol, i * 3.1, 0);
          frontStorey(mb, gb, e, 0, e.L, cs, ce, spec, 0, 0);
          mb.wall(a.x, a.z, d.x, d.z, ce, corniceBot, era.body, bodyCol, i * 3.1, 0);
          bays += Math.max(1, Math.round(e.L / bayW));
          if (i === 0) storeysEmitted += 1;
        } else {
          const { n, course } = coursesFor(part, owner, corniceBot - plinthTop);
          for (let k = 0; k < n; k++) {
            const y0 = plinthTop + k * course, y1 = y0 + course;
            // A stone ground storey IS the collegiate base/body hierarchy, and
            // it is cheaper and reads better than a 1.6 m band cutting across
            // the first-floor windows.
            const sp = (k === 0 && T.stoneGround) ? stoneSpec : spec;
            // LOD 0 only at the storey a pedestrian stands in front of; the
            // sills and lintels above are sub-pixel from the quad and cost 3x.
            frontStorey(mb, gb, e, 0, e.L, y0, y1, sp, k, k === 0 ? 0 : 1);
            bays += Math.max(1, Math.round(e.L / bayW));
          }
          if (i === 0) storeysEmitted += n;
        }
        // The entrance cue sits in the ground storey of its own edge, after the
        // bays are laid, so it overrides the window rhythm locally rather than
        // fighting it.
        if (cue && cue.edge === i && fenestrate) {
          entranceTris += entranceCue(mb, gb, e, cue.u, plinthTop, spec);
          entranceCount++;
        }
        // Cornice: a projecting course per edge. Boxes rather than an offset
        // ring — offsetting a 95-vertex concave outline self-intersects, and a
        // box per edge cannot.
        const mid = [(a.x + d.x) * 0.5, (a.z + d.z) * 0.5];
        const rot = Math.atan2(e.nx, e.nz);
        mb.box(mid[0] + e.nx * T.corniceOut * 0.5, (corniceBot + top) * 0.5,
          mid[1] + e.nz * T.corniceOut * 0.5,
          e.L, top - corniceBot, 0.22 + T.corniceOut, rot, era.base, baseCol);
      }
      capTris += capPoly(mb, ring, top, era.roof, roofCol);

      this.parts.push({
        id: part.id, tier: part.tier, buildings: part.buildings,
        heightM: part.heightM, areaM2: part.areaM2, typo: typoKey,
        storeys: fenestrate && typoKey !== 'largeSpan'
          ? coursesFor(part, owner, corniceBot - plinthTop).n : 0,
        courseConfidence: owner?.storeyConfidence ?? 'DERIVED',
        fenestrated: fenestrate,
        top, floor, cx: c.x, cz: c.z, i0, i1: mb.ni, ci0, ci1,
      });
    }

    let tris = 0, glassTris = 0;
    const geom = mb.build();
    if (geom) {
      const m = new THREE.Mesh(geom, this.matOpaque);
      m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'neu_hero_opaque';
      root.add(m); this.meshes.push(m);
      tris = geom.index.count / 3;
    }
    const gg = gb.build();
    if (gg) {
      const m = new THREE.Mesh(gg, this.matGlass);
      m.castShadow = false; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'neu_hero_glass';
      root.add(m); this.meshes.push(m);
      glassTris = gg.index.count / 3;
    }
    // Colliders come from the plain prism buffer, which is then thrown away.
    const cgeom = cb.build();
    if (cgeom) { this._addColliders(ctx, cgeom); cgeom.dispose(); }

    this.ground = this._buildGround(ctx, groundAt);

    this.stats = {
      parts: this.parts.length, tris, glassTris, capTris,
      draws: this.meshes.length,
      bays, storeysEmitted,
      entrances: entranceCount, entranceTris,
      fenestrated: this.parts.filter(p => p.fenestrated).length,
      colliders: this._colliderCount | 0,
      colliderTris: this._colliderTris | 0,
      source: NEU_HERO_SOURCE.dataset,
      ground: this.ground,
    };
    console.info(`[neuHero] ${this.parts.length} parts, ${tris | 0} opaque + ` +
      `${glassTris | 0} glass tris, ${bays} bays, ${this.meshes.length} draws, ` +
      `${this._colliderCount | 0} colliders (${this._colliderTris | 0} tris), ` +
      `${(performance.now() - t0) | 0}ms`);
  }

  /**
   * Build the campus ground surface. See the `GROUND` note above for why the
   * shape is constrained rather than authored.
   *
   * Three zones, all decided per triangle from evidence: a paved corridor along
   * the factual PDDL walk centrelines, a paved apron against building faces, and
   * maintained lawn everywhere else. Two materials, both registry variants of
   * surfaces the city already builds, so this adds no new material system.
   */
  _buildGround(ctx, groundAt) {
    const K = NEU_WALK_SOURCE.krentzman;
    // -- contour: the dilated hull of the opening cluster's footprints ---------
    const near = NEU_HERO_PARTS.filter((p) => {
      const n = p.outline.length;
      let cx = 0, cz = 0;
      for (const [x, z] of p.outline) { cx += x / n; cz += z / n; }
      return Math.hypot(cx - K.x, cz - K.z) < GROUND.near;
    });
    if (!near.length) return null;
    const pts = [];
    for (const p of near) for (const [x, z] of p.outline) pts.push({ x, z });
    const hull = convexHull(pts);
    if (hull.length < 3) return null;
    let hx = 0, hz = 0;
    for (const p of hull) { hx += p.x / hull.length; hz += p.z / hull.length; }
    const contour = hull.map((p) => {
      const dx = p.x - hx, dz = p.z - hz, L = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dx / L) * GROUND.dilate, z: p.z + (dz / L) * GROUND.dilate };
    });

    // -- holes: the octagon, and every footprint that lies inside the contour --
    const octPark = PARKS.find((q) => q.name === 'Krentzman Quadrangle');
    const cand = [];
    if (octPark) cand.push(openRing(octPark.ring.map(([la, lo]) => geo(la, lo))));
    for (const p of NEU_HERO_PARTS) cand.push(openRing(p.outline.map(([x, z]) => ({ x, z }))));
    const holes = cand.filter((r) => r.length >= 3 && r.every((q) => pointInRing(q.x, q.z, contour)));

    // -- triangulate, with the holes cut out -----------------------------------
    const C = contour.map((p) => new THREE.Vector2(p.x, p.z));
    if (THREE.ShapeUtils.area(C) < 0) C.reverse();
    const H = holes.map((r) => {
      const v = r.map((p) => new THREE.Vector2(p.x, p.z));
      if (THREE.ShapeUtils.area(v) > 0) v.reverse();
      return v;
    });
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(C, H); } catch (e) {
      console.warn('[neuHero] ground triangulation failed:', e.message);
      return null;
    }
    if (!faces?.length) return null;
    const verts = [...C, ...H.flat()].map((v) => ({ x: v.x, z: v.y }));
    let tris = faces.map((f) => [f[0], f[1], f[2]]);

    // -- subdivide so the surface follows the ground and rejection is fine ------
    const mid = new Map();
    for (let pass = 0; pass < 7; pass++) {
      const next = []; let split = false;
      for (const t of tris) {
        const e = [0, 1, 2].map((i) => {
          const a = verts[t[i]], b = verts[t[(i + 1) % 3]];
          return Math.hypot(b.x - a.x, b.z - a.z);
        });
        const L = e[0] > e[1] ? (e[0] > e[2] ? 0 : 2) : (e[1] > e[2] ? 1 : 2);
        if (e[L] < GROUND.maxEdge) { next.push(t); continue; }
        split = true;
        const i0 = t[L], i1 = t[(L + 1) % 3], i2 = t[(L + 2) % 3];
        const k = i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`;
        let m = mid.get(k);
        if (m === undefined) {
          m = verts.length;
          verts.push({ x: (verts[i0].x + verts[i1].x) / 2, z: (verts[i0].z + verts[i1].z) / 2 });
          mid.set(k, m);
        }
        next.push([i0, m, i2], [m, i1, i2]);
      }
      tris = next;
      if (!split) break;
    }

    // -- constraints -----------------------------------------------------------
    const neuRing = (DISTRICTS.find((d) => d.id === 'northeastern')?.ring || [])
      .map(([la, lo]) => geo(la, lo));
    // Every road edge whose corridor could reach the contour, with its own width.
    const cityNet = ctx.get('city')?.net;
    const roads = [];
    for (const e of (cityNet?.edges || [])) {
      if (!e?.pts?.length || e.pts.length < 2) continue;
      const half = corridorHalf(e) + GROUND.verge;
      let touches = false;
      for (const q of e.pts) {
        if (Math.hypot(q.x - K.x, q.z - K.z) < GROUND.near + GROUND.dilate + half + 60) {
          touches = true; break;
        }
      }
      if (touches) roads.push({ pts: e.pts, keep: half });
    }
    const huntFallback = roads.length ? null
      : (STREETS.find((r) => r.name === 'Huntington Avenue')?.path || [])
        .map(([la, lo]) => geo(la, lo));
    // Procedural fabric still stands on this ground. `Buildings` already dropped
    // the parcels that overlap a hero footprint, but the rest are real buildings
    // and lawn must not run under them.
    const proc = (ctx.get('buildings')?.plots || [])
      .filter((q) => q?.polygon?.length >= 3)
      .map((q) => q.polygon)
      .filter((poly) => poly.some((v) => Math.hypot(v.x - K.x, v.z - K.z) < 260));
    const walks = [...NEU_WALK_ARRIVAL, ...NEU_WALK_CONTINUATION]
      .map((w) => w.pts.map(([x, z]) => ({ x, z })));
    const footEdges = NEU_HERO_PARTS.map((p) => openRing(p.outline.map(([x, z]) => ({ x, z }))));

    const zones = { lawn: [], paved: [] };
    let dropped = { district: 0, road: 0, procedural: 0, footprint: 0, reach: 0 };
    for (const t of tris) {
      const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
      const cx2 = (a.x + b.x + c.x) / 3, cz2 = (a.z + b.z + c.z) / 3;
      if (neuRing.length && !pointInRing(cx2, cz2, neuRing)) { dropped.district++; continue; }
      // The road test is on EVERY VERTEX, not the centroid. A centroid test leaks:
      // with a 7 m max edge a vertex sits up to ~4 m inboard of the centroid, and
      // measured that put the nearest ground vertex 10.23 m from the Huntington
      // centreline against a 13.56 m corridor — 3.3 m onto the city footway, which
      // is the coplanar z-fight this keep-out exists to prevent. Corners are what
      // touch the road, so corners are what get tested.
      const nearRoad = roads.length
        ? roads.some((r) => [a, b, c].some((v) => distToPolyline(v.x, v.z, r.pts) < r.keep))
        : (huntFallback && [a, b, c].some((v) => distToPolyline(v.x, v.z, huntFallback) < GROUND.roadKeepFallback));
      if (nearRoad) { dropped.road++; continue; }
      if (proc.some((poly) => pointInRing(cx2, cz2, poly))) { dropped.procedural++; continue; }
      // Belt and braces over the holes. `holes` only punches footprints that lie
      // ENTIRELY inside the contour, so a part straddling the boundary — Cabot
      // and the Richards/Hayden link both do — leaves its overlap triangulated,
      // and lawn under a hero building is the same defect as lawn under a
      // brownstone. Measured before this test: 58 such triangles.
      if (footEdges.some((r) => pointInRing(cx2, cz2, r))) { dropped.footprint++; continue; }
      // Distance to the built form and to the shipped paths, computed once.
      let dFoot = Infinity;
      for (const r of footEdges) {
        const d = distToPolyline(cx2, cz2, [...r, r[0]]);
        if (d < dFoot) dFoot = d;
      }
      let dWalk = Infinity;
      for (const w of walks) {
        const d = distToPolyline(cx2, cz2, w);
        if (d < dWalk) dWalk = d;
      }
      if (dFoot > GROUND.reach && dWalk > GROUND.walkReach) { dropped.reach++; continue; }
      const onWalk = dWalk < GROUND.walkHalf;
      const onApron = !onWalk && dFoot < GROUND.apron;
      zones[(onWalk || onApron) ? 'paved' : 'lawn'].push(t);
    }

    // -- emit ------------------------------------------------------------------
    const materials = ctx.get('materials');
    const made = [];
    for (const [zone, list] of Object.entries(zones)) {
      if (!list.length) continue;
      const pos = [], nrm = [], uv = [], col = [], idx = [];
      const remap = new Map();
      const tile = zone === 'paved' ? 4 : 6;
      for (const t of list) {
        const tri = [];
        for (const vi of t) {
          let m = remap.get(vi);
          if (m === undefined) {
            const v = verts[vi];
            m = pos.length / 3;
            remap.set(vi, m);
            pos.push(v.x, groundAt(v.x, v.z) + 0.02, v.z);
            nrm.push(0, 1, 0);
            uv.push(v.x / tile, v.z / tile);
            // A flat tint break per 9 m keeps a big surface from reading as one
            // painted sheet; the park lawns do the same thing.
            const s = 0.92 + 0.08 * ((hash2(Math.floor(v.x / 9), Math.floor(v.z / 9)) * 2) % 1);
            col.push(s, s, s);
          }
          tri.push(m);
        }
        idx.push(tri[0], tri[1], tri[2]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();

      const src = materials?.get?.(zone === 'paved' ? 'concrete' : 'grass');
      let mat;
      if (src) {
        // Registry variant, not a clone: a clone never reaches `Assets.setWetness`
        // and would stay dry in rain while the park beside it wets. Same trap
        // `Districts` documents for its own park surfaces.
        mat = materials.assets.variant(`neu_ground_${zone}`, src, (x) => {
          x.vertexColors = true;
          x.color.setRGB(1, 1, 1);
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: zone === 'paved' ? 0.9 : 0.98, metalness: 0,
        });
      }
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -3;
      mat.polygonOffsetUnits = -6;
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      mesh.name = `neu_ground_${zone}`;
      this.root.add(mesh);
      this.meshes.push(mesh);
      made.push({ zone, tris: list.length, material: `neu_ground_${zone}` });
    }
    return {
      contourVertices: contour.length, holes: holes.length,
      trianglesAfterSubdivision: tris.length,
      lawnTris: zones.lawn.length, pavedTris: zones.paved.length,
      dropped, zones: made, roadEdgesConsidered: roads.length,
      walkMetres: NEU_WALK_SOURCE.shippedM, walkWays: NEU_WALK_SOURCE.shippedWays,
      colliders: 0,
    };
  }

  /**
   * One trimesh collider per part, cut from the merged mesh — the same technique
   * `Landmarks._addColliders` uses, and for the same reason: the rendered
   * triangles are the only description of the shape, so they are what collides.
   *
   * A prism has no overhang and no interior, so this IS building-volume
   * collision; there is no façade detail here to collide with. Cabot's 7,926 m2
   * outline is 55 edges, which is 112 wall triangles — an order cheaper than the
   * heightfield it stands on.
   */
  _addColliders(ctx, geom) {
    const p = ctx.physics;
    if (!p?.world || !this.parts.length) return;
    const R = p.RAPIER;
    const pos = geom.attributes.position.array;
    const idx = geom.index.array;
    const body = p.world.createRigidBody(R.RigidBodyDesc.fixed());
    const remap = new Map();
    let made = 0, ctris = 0;
    for (const part of this.parts) {
      const n = part.ci1 - part.ci0;
      if (n < 12) continue;
      remap.clear();
      const verts = [];
      const tri = new Uint32Array(n);
      for (let k = 0; k < n; k++) {
        const vi = idx[part.ci0 + k];
        let m = remap.get(vi);
        if (m === undefined) {
          m = verts.length / 3;
          remap.set(vi, m);
          verts.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        }
        tri[k] = m;
      }
      const cd = R.ColliderDesc.trimesh(new Float32Array(verts), tri)
        .setCollisionGroups(groups(GROUP.STATIC, 0xFFFF))
        .setFriction(0.9);
      p.world.createCollider(cd, body);
      made++; ctris += n / 3;
    }
    if (made) { this.body = body; this._colliderCount = made; this._colliderTris = ctris; }
    else { p.world.removeRigidBody(body); this.body = null; this._colliderCount = 0; }
  }

  /** Evidence surface for QA: what was built, from what, at what height. */
  report() {
    return {
      source: NEU_HERO_SOURCE,
      stats: this.stats,
      buildings: NEU_HERO_BUILDINGS.map(b => ({
        name: b.name, status: b.status, headlineHeightM: b.headlineHeightM,
        rendered: this.parts.filter(p => p.buildings.includes(b.name))
          .map(p => ({ id: p.id, tier: p.tier, heightM: p.heightM, areaM2: p.areaM2 })),
      })),
      parts: this.parts.map(p => ({
        id: p.id, tier: p.tier, heightM: p.heightM, areaM2: p.areaM2,
        topY: +p.top.toFixed(2), floorY: +p.floor.toFixed(2),
        buildings: p.buildings,
      })),
    };
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.root?.remove(m);
    }
    this.meshes.length = 0;
    this.parts.length = 0;
    if (this._ownsMaterial) { this.matOpaque?.dispose(); this.matGlass?.dispose(); }
    if (this.body) this.ctx?.physics?.world?.removeRigidBody(this.body);
    this.body = null;
    if (this.root) { this.ctx?.scene?.remove(this.root); this.root = null; }
  }
}
