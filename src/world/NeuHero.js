import * as THREE from 'three';
import {
  MeshBuf, GlassBuf, SURF, buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial, polyCentroid, hash2,
} from './BuildingKit.js';
import { frontStorey, edgeFrame } from './Facades.js';
import { NEU_HERO_PARTS, NEU_HERO_BUILDINGS, NEU_HERO_SOURCE } from '../data/neu-hero.js';
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
    let capTris = 0, bays = 0, storeysEmitted = 0;
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

    this.stats = {
      parts: this.parts.length, tris, glassTris, capTris,
      draws: this.meshes.length,
      bays, storeysEmitted,
      fenestrated: this.parts.filter(p => p.fenestrated).length,
      colliders: this._colliderCount | 0,
      colliderTris: this._colliderTris | 0,
      source: NEU_HERO_SOURCE.dataset,
    };
    console.info(`[neuHero] ${this.parts.length} parts, ${tris | 0} opaque + ` +
      `${glassTris | 0} glass tris, ${bays} bays, ${this.meshes.length} draws, ` +
      `${this._colliderCount | 0} colliders (${this._colliderTris | 0} tris), ` +
      `${(performance.now() - t0) | 0}ms`);
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
