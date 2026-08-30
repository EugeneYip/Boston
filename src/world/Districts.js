import * as THREE from 'three';
import { geo, WORLD } from '../core/Geo.js';
import { DISTRICTS, PARKS } from '../data/boston-geo.js';

/**
 * Neighbourhood lookup and the big central parks.
 *
 * `districtAt` is asked thousands of times a frame by prop placement, lighting,
 * audio and the HUD, so the polygons are rasterised once into a byte grid and
 * everything after that is an array index. Parks are merged into a single mesh
 * per surface type — Boston Common, the Public Garden, the Comm Ave Mall, the
 * Esplanade and the Greenway are collectively enormous and cannot each cost a
 * draw call.
 */

const RES = 20;                                   // district raster cell, metres
const PAD = 300;
const MINX = WORLD.minX - PAD, MINZ = WORLD.minZ - PAD;
const SPAN = (WORLD.maxX - WORLD.minX) + PAD * 2;
const N = Math.round(SPAN / RES) + 1;

/** Contract order. Index 0 is "nothing in particular". */
const IDS = ['financial', 'backBay', 'beaconHill', 'northEnd', 'fenway', 'seaport',
             'southEnd', 'charlestown', 'cambridge', 'park', 'water'];

/** 2-D integer hash. A 1-D hash fed `x*31 + z*17` aliases into visible diagonal
 *  streaks across a lawn the size of Boston Common; mixing the axes separately
 *  does not. */
const hash2 = (x, y) => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function toWorld(ring) { return ring.map(([la, lo]) => geo(la, lo)); }

/**
 * Give a world-space merged mesh a meaningful sort key.
 *
 * three's opaque sort projects each mesh's *origin* to clip space. Geometry
 * baked in world space on a mesh left at (0,0,0) therefore projects to the same
 * point as every other such mesh, the sort falls through to creation order, and
 * front-to-back ordering is lost across the whole frame — which is the worst
 * case for overdraw on a tile-based GPU. Re-centre the geometry on its own
 * bounding box and put that centre on the mesh instead.
 */
function recenter(geometry, mesh) {
  geometry.computeBoundingBox();
  const c = new THREE.Vector3();
  geometry.boundingBox.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.computeBoundingSphere();
  mesh.position.copy(c);
  mesh.updateMatrix();            // matrixAutoUpdate is off on all of these
  geometry.userData.origin = c;
  return c;
}


function inPoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].z > z) !== (pts[j].z > z) &&
        x < (pts[j].x - pts[i].x) * (z - pts[i].z) / (pts[j].z - pts[i].z) + pts[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

function bounds(pts) {
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const p of pts) {
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
  }
  return { minx, minz, maxx, maxz };
}

export default class Districts {
  constructor(terrain) {
    this.terrain = terrain;
    this.grid = new Uint8Array(N * N);
    this.meshes = [];
    this.polys = [];        // districts, world space, for the minimap
    this.parkPolys = [];
  }

  bake() {
    for (const d of DISTRICTS) {
      const pts = toWorld(d.ring);
      this.polys.push({ id: d.id, polygon: pts, points: pts, name: d.id, ...bounds(pts) });
    }
    for (const p of PARKS) {
      const pts = toWorld(p.ring);
      this.parkPolys.push({ name: p.name, kind: p.kind, reserveOnly: !!p.reserveOnly,
                            polygon: pts, points: pts, ...bounds(pts) });
    }

    const T = this.terrain;
    for (let j = 0; j < N; j++) {
      const z = MINZ + j * RES;
      for (let i = 0; i < N; i++) {
        const x = MINX + i * RES;
        let v = 0;
        if (T.waterAt(x, z) !== null && T.groundHeight(x, z) < T.waterAt(x, z)) {
          v = IDS.indexOf('water') + 1;
        } else {
          for (const p of this.parkPolys) {
            if (x < p.minx || x > p.maxx || z < p.minz || z > p.maxz) continue;
            if (inPoly(p.polygon, x, z)) { v = IDS.indexOf('park') + 1; break; }
          }
          if (!v) {
            for (const d of this.polys) {
              if (x < d.minx || x > d.maxx || z < d.minz || z > d.maxz) continue;
              if (inPoly(d.polygon, x, z)) { v = IDS.indexOf(d.id) + 1; break; }
            }
          }
        }
        this.grid[j * N + i] = v;
      }
    }
    return this;
  }

  /**
   * @param {number} x @param {number} z
   * @returns {'backBay'|'beaconHill'|'northEnd'|'financial'|'fenway'|'seaport'
   *           |'southEnd'|'charlestown'|'cambridge'|'water'|'park'}
   */
  districtAt(x, z) {
    const i = Math.round((x - MINX) / RES), j = Math.round((z - MINZ) / RES);
    if (i < 0 || j < 0 || i >= N || j >= N) return 'financial';
    const v = this.grid[j * N + i];
    return v ? IDS[v - 1] : 'financial';
  }

  /**
   * Exact point-in-park test. The district raster is 20 m and the Comm Ave Mall
   * is only 24 m wide, so raster rounding let parcels — and therefore
   * buildings — land on the grass. Parcel building asks this a few thousand
   * times at init, which easily affords the real polygon test.
   */
  inPark(x, z) {
    for (const p of this.parkPolys) {
      if (x < p.minx || x > p.maxx || z < p.minz || z > p.maxz) continue;
      if (inPoly(p.polygon, x, z)) return true;
    }
    return false;
  }

  /** True where a building must not be placed. */
  isReserved(x, z) {
    if (this.inPark(x, z)) return true;
    const w = this.terrain.waterAt(x, z);
    if (w !== null && this.terrain.groundHeight(x, z) < w + 0.6) return true;
    return this.districtAt(x, z) === 'water';
  }

  // -- park meshes ----------------------------------------------------------

  /** Triangulate a ring and split long edges so it follows the ground. */
  _mesh(pts, maxEdge) {
    const v2 = pts.map(p => new THREE.Vector2(p.x, p.z));
    if (THREE.ShapeUtils.area(v2) < 0) v2.reverse();
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { return null; }
    if (!tris?.length) return null;
    const verts = v2.map(p => [p.x, p.y]);
    const mid = new Map();
    for (let pass = 0; pass < 6; pass++) {
      const next = []; let split = false;
      for (const t of tris) {
        const e = [0, 1, 2].map(i => {
          const a = verts[t[i]], b = verts[t[(i + 1) % 3]];
          return Math.hypot(b[0] - a[0], b[1] - a[1]);
        });
        const L = e[0] > e[1] ? (e[0] > e[2] ? 0 : 2) : (e[1] > e[2] ? 1 : 2);
        if (e[L] < maxEdge) { next.push(t); continue; }
        split = true;
        const i0 = t[L], i1 = t[(L + 1) % 3], i2 = t[(L + 2) % 3];
        const k = i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`;
        let m = mid.get(k);
        if (m === undefined) {
          m = verts.length;
          verts.push([(verts[i0][0] + verts[i1][0]) / 2, (verts[i0][1] + verts[i1][1]) / 2]);
          mid.set(k, m);
        }
        next.push([i0, m, i2], [m, i1, i2]);
      }
      tris = next;
      if (!split) break;
    }
    return { verts, tris };
  }

  build(scene, materials, net) {
    const T = this.terrain;
    const grassTile = materials?.get?.('grass')?.userData?.tileMeters || 4;
    const hardTile = materials?.get?.('concrete')?.userData?.tileMeters || 4;
    const groups = { lawn: [], plaza: [] };
    const c = new THREE.Color();

    for (const park of this.parkPolys) {
      if (park.reserveOnly) continue;      // a no-build corridor, not grass
      const m = this._mesh(park.polygon, park.kind === 'mall' ? 14 : 26);
      if (!m) continue;
      const hard = park.kind === 'plaza';
      const g = groups[hard ? 'plaza' : 'lawn'];
      const base = g.length ? g[g.length - 1].offset : 0;
      const pos = [], nrm = [], uv = [], col = [], idx = [];
      for (const [x, z] of m.verts) {
        const y = T.groundHeight(x, z) + 0.05;
        pos.push(x, y, z);
        const nv = T.normalAt(x, z);
        nrm.push(nv.x, nv.y, nv.z);
        uv.push(x / (hard ? hardTile : grassTile), z / (hard ? hardTile : grassTile));
        // mown grass with wear patches along the desire lines
        const w = hash2(Math.floor(x / 7), Math.floor(z / 7));
        const w2 = hash2(Math.floor(x / 29) + 613, Math.floor(z / 29) - 271);
        if (hard) c.setRGB(0.30 + w * 0.05, 0.295 + w * 0.05, 0.285 + w * 0.05);
        else c.setRGB(0.085 + w * 0.05 + w2 * 0.06, 0.150 + w * 0.07 + w2 * 0.05,
                      0.055 + w * 0.03 + w2 * 0.03);
        col.push(c.r, c.g, c.b);
      }
      // Same 2-D -> XZ handedness flip as the water: reverse the winding or the
      // lawn faces the ground and is culled.
      //
      // Also drop any triangle whose centroid lands on a carriageway. Park
      // outlines are traced by hand and a stray 40 m puts grass across a live
      // junction; this makes that class of mistake impossible rather than
      // relying on every polygon being right.
      for (const t of m.tris) {
        if (net) {
          const cx = (m.verts[t[0]][0] + m.verts[t[1]][0] + m.verts[t[2]][0]) / 3;
          const cz = (m.verts[t[0]][1] + m.verts[t[1]][1] + m.verts[t[2]][1]) / 3;
          const ne = net.nearestEdge(cx, cz);
          if (ne && ne.distance < net.edges[ne.edgeId].halfRoad + 0.3) continue;
        }
        idx.push(t[0], t[2], t[1]);
      }
      if (!idx.length) continue;
      g.push({ pos, nrm, uv, col, idx, offset: base });
    }

    for (const [kind, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const pos = [], nrm = [], uv = [], col = [], idx = [];
      let base = 0;
      for (const p of list) {
        pos.push(...p.pos); nrm.push(...p.nrm); uv.push(...p.uv); col.push(...p.col);
        for (const i of p.idx) idx.push(i + base);
        base += p.pos.length / 3;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geom.setIndex(idx);
      geom.computeBoundingSphere();

      const src = materials?.get?.(kind === 'plaza' ? 'concrete' : 'grass');
      let mat;
      if (src) {
        mat = src.clone();
        mat.vertexColors = true;
        mat.color.setRGB(1, 1, 1);
      } else {
        mat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: kind === 'plaza' ? 0.9 : 0.98, metalness: 0,
        });
      }
      // Parks sit a few centimetres proud of the terrain they replace; a real
      // polygon offset (not a bigger lift) is what keeps that from z-fighting.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -3;
      mat.polygonOffsetUnits = -6;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'park_' + kind;
      recenter(geom, mesh);
      scene.add(mesh);
      this.meshes.push(mesh);
      this._owned = this._owned || [];
      if (!src) this._owned.push(mat); else this._owned.push(mat);
    }
    return this;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.parent?.remove(m); }
    for (const m of this._owned || []) m.dispose();
    this.meshes.length = 0;
  }
}

export { IDS as DISTRICT_IDS };
