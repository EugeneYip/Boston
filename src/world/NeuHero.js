import * as THREE from 'three';
import {
  MeshBuf, SURF, buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, polyCentroid,
} from './BuildingKit.js';
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
    if (b?.matOpaque) {
      this.matOpaque = b.matOpaque;
      this._ownsMaterial = false;
    } else {
      const assets = ctx.assets;
      const atlas = buildAtlas();
      const rooms = assets ? assets.texture('bk_rooms', buildRoomAtlas) : buildRoomAtlas();
      const macro = assets ? assets.texture('bk_macro', buildMacroNoise) : buildMacroNoise();
      this.matOpaque = makeOpaqueMaterial(atlas, rooms, macro);
      this._ownsMaterial = true;
    }

    const city = ctx.get('city');
    const groundAt = (city && typeof city.groundHeight === 'function')
      ? (x, z) => city.groundHeight(x, z) : () => 0;

    const mb = new MeshBuf(8192);
    let capTris = 0;
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
      const baseTop = Math.min(floor + 0.5 + BASE_H, top - 0.5);

      const era = eraFor(part);
      const bodyCol = COL[era.body], baseCol = COL[era.base], roofCol = COL[era.roof];

      const i0 = mb.ni;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], d = ring[(i + 1) % ring.length];
        // Base / body hierarchy: a stone course under a masonry body is the
        // cue that makes a mass read as a building at eye level, and it is
        // massing rather than ornament, so it belongs in this wave.
        mb.wall(a.x, a.z, d.x, d.z, floor, baseTop, era.base, baseCol, i * 2.7, 0);
        mb.wall(a.x, a.z, d.x, d.z, baseTop, top, era.body, bodyCol, i * 3.1, 0);
      }
      capTris += capPoly(mb, ring, top, era.roof, roofCol);

      this.parts.push({
        id: part.id, tier: part.tier, buildings: part.buildings,
        heightM: part.heightM, areaM2: part.areaM2,
        top, floor, cx: c.x, cz: c.z, i0, i1: mb.ni,
      });
    }

    let tris = 0;
    const geom = mb.build();
    if (geom) {
      const m = new THREE.Mesh(geom, this.matOpaque);
      m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'neu_hero_opaque';
      root.add(m); this.meshes.push(m);
      tris = geom.index.count / 3;
      this._addColliders(ctx, geom);
    }

    this.stats = {
      parts: this.parts.length, tris,
      draws: this.meshes.length, capTris,
      colliders: this._colliderCount | 0,
      source: NEU_HERO_SOURCE.dataset,
    };
    console.info(`[neuHero] ${this.parts.length} parts, ${tris | 0} tris, ` +
      `${this.meshes.length} draw, ${this._colliderCount | 0} colliders, ` +
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
      const n = part.i1 - part.i0;
      if (n < 12) continue;
      remap.clear();
      const verts = [];
      const tri = new Uint32Array(n);
      for (let k = 0; k < n; k++) {
        const vi = idx[part.i0 + k];
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
    if (this._ownsMaterial) this.matOpaque?.dispose();
    if (this.body) this.ctx?.physics?.world?.removeRigidBody(this.body);
    this.body = null;
    if (this.root) { this.ctx?.scene?.remove(this.root); this.root = null; }
  }
}
