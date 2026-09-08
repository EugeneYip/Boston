import * as THREE from 'three';
import { geo, WORLD } from '../core/Geo.js';
import { DISTRICTS, PARKS } from '../data/boston-geo.js';
import { NEU_HERO_PARTS } from '../data/neu-hero.js';

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

const KERB_W = 0.30;                              // granite edging width, metres
const KERB_H = 0.10;                              // and how far it stands over the lawn
/** Runs that carry a kerb: the primary circulation, not the connectors. */
const EDGED = new Set(['loop', 'spine', 'diagonal', 'shore']);

const RES = 20;                                   // district raster cell, metres
const PAD = 300;
const MINX = WORLD.minX - PAD, MINZ = WORLD.minZ - PAD;
const SPAN = (WORLD.maxX - WORLD.minX) + PAD * 2;
const N = Math.round(SPAN / RES) + 1;

/** Contract order. Index 0 is "nothing in particular". */
// Every id a district polygon can carry. `bake` stores `IDS.indexOf(id) + 1`, so
// an id missing from this list rasterises as 0 — which reads back as `null`, the
// same answer as unclaimed ground. A new district that forgets to register here
// therefore fails silently and looks exactly like the bug it was added to fix.
const IDS = ['financial', 'backBay', 'beaconHill', 'northEnd', 'fenway', 'seaport',
             'southEnd', 'charlestown', 'cambridge', 'northeastern', 'park', 'water'];

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
    /** Factual Northeastern footprints. No-build, and not open space either. */
    this.heroPolys = [];
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
    // Northeastern's factual footprints are held out of the parcel generator the
    // same way a park is, but they are NOT parks: they must not raster as
    // `park`, must not grow grass, and must not attract park paths or planting.
    // Keeping them in their own list rather than pushing them into `parkPolys`
    // as another `reserveOnly` ring is what buys that — every consumer of
    // `parkPolys` would otherwise have to learn a new exception.
    for (const part of NEU_HERO_PARTS) {
      const pts = part.outline.map(([x, z]) => ({ x, z }));
      this.heroPolys.push({ id: part.id, polygon: pts, ...bounds(pts) });
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
   * True where the baked raster actually has an answer.
   *
   * The raster is a nearest-neighbour lookup, so it covers half a cell beyond
   * the outermost sample: `x, z ∈ [MINX - RES/2, MINX + (N-1)*RES + RES/2)`,
   * which for the current constants is ±3310 m. Outside that, `districtAt`
   * knows nothing at all; inside it, a `null` answer means "surveyed, and no
   * neighbourhood claims this point". Callers that need to tell those two
   * apart — a HUD saying "unknown" versus "open ground" — ask this. Uses the
   * exact same arithmetic as `districtAt` so the two can never disagree.
   * @param {number} x @param {number} z @returns {boolean}
   */
  inRaster(x, z) {
    const i = Math.round((x - MINX) / RES), j = Math.round((z - MINZ) / RES);
    return i >= 0 && j >= 0 && i < N && j < N;
  }

  /**
   * Neighbourhood at a world point, or `null` where there is no neighbourhood.
   *
   * `null` is returned in two cases, and both are truthful:
   *   - the point is outside the raster (see `inRaster`), i.e. out past ±3310 m;
   *   - the point is inside the raster but on ground no district polygon
   *     claims — the harbour approaches, the far bank, the land past Fenway.
   *     That is 44,855 of 109,561 cells, 41% of the raster.
   *
   * This used to answer `'financial'` in *both* cases. Neither was an index
   * bug: the bounds test below was always correct, and grid value 0 has always
   * meant "nothing in particular". The defect was that two distinct
   * don't-know answers were spelled as a real, central, high-rise district, so
   * nothing downstream could see the difference. The Financial District
   * polygon spans x ∈ [102, 1320], z ∈ [-714, 754]; every one of the 37,376
   * off-raster probes in a ±12 km sweep, and all 10,039 unclaimed cells in the
   * 3000–3240 m band, still called themselves Financial District. That is what
   * painted the terrain rings as urban dirt out to the horizon and forced
   * `Terrain.build` to pass `surf = null` for the far ring to dodge it.
   *
   * Do not reintroduce a fallback here. A caller that needs one — road
   * zoning wants a default parcel size, props want a default street dressing —
   * must spell it at its own call site, where the choice is visible and can be
   * right for that caller. Hiding it in here makes every caller wrong at once.
   *
   * NaN in gives `null` out: `!(NaN >= 0)` is true, so the guard catches it
   * before it can index the grid.
   *
   * @param {number} x @param {number} z
   * @returns {'backBay'|'beaconHill'|'northEnd'|'financial'|'fenway'|'seaport'
   *           |'southEnd'|'charlestown'|'cambridge'|'northeastern'|'water'
   *           |'park'|null}
   */
  districtAt(x, z) {
    const i = Math.round((x - MINX) / RES), j = Math.round((z - MINZ) / RES);
    if (!(i >= 0) || !(j >= 0) || i >= N || j >= N) return null;
    const v = this.grid[j * N + i];
    return v ? IDS[v - 1] : null;
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

  /**
   * Exact point-in-footprint test for the Northeastern hero cluster.
   *
   * `NeuHero` builds these masses itself from PDDL survey outlines, so the
   * procedural generator must not also claim the ground. Suppressing here — at
   * plot generation — is what makes it durable: the parcel is never created, so
   * there is no spec, no mesh, no collider, no frontage and no frontage-driven
   * prop to go stale later. A `mesh.visible = false` would survive neither a
   * chunk refresh nor an LOD change.
   */
  inHeroFootprint(x, z) {
    for (const p of this.heroPolys) {
      if (x < p.minx || x > p.maxx || z < p.minz || z > p.maxz) continue;
      if (inPoly(p.polygon, x, z)) return true;
    }
    return false;
  }

  /** True where a building must not be placed. */
  isReserved(x, z) {
    if (this.inPark(x, z)) return true;
    if (this.inHeroFootprint(x, z)) return true;
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

  build(scene, materials, net, parkPaths = null) {
    const T = this.terrain;
    const lawnIdx = new Map();          // park name -> the lawn surface, for paths
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
      // Keep the surface the paths have to sit on. Sampling `groundHeight` for
      // them instead is wrong by up to 0.66 m: the lawn is a chord across up to
      // 26 m of ground, so over a rise it floats, and 45% of a path's length
      // would have been buried under the grass it is drawn on.
      lawnIdx.set(park.name, { verts: m.verts, tris: m.tris,
                               ys: m.verts.map(([x, z]) => T.groundHeight(x, z) + 0.05) });
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
        // Registry variant, not a bare clone: a clone never reaches
        // `Assets.setWetness`, so these surfaces stayed dry in rain while the
        // roads beside them did not. See `Assets.variant`.
        mat = materials.assets.variant(`park_surface_${kind}`, src, (x) => {
          x.vertexColors = true;
          x.color.setRGB(1, 1, 1);
          });
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
      if (!src) this._owned.push(mat);          // registry variants: Assets frees them
    }

    if (parkPaths?.length) this._buildPaths(scene, materials, parkPaths, lawnIdx);
    return this;
  }

  /**
   * Height of the lawn a park path is drawn on, or null off the lawn.
   * Barycentric on the same triangles `build` just emitted, so a path is on the
   * grass by construction rather than by a lift chosen to cover the worst case.
   */
  static _lawnY(idx, x, z) {
    if (!idx) return null;
    const { verts: V, tris, ys } = idx;
    for (let k = 0; k < tris.length; k++) {
      const t = tris[k], a = V[t[0]], b = V[t[1]], c = V[t[2]];
      const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(den) < 1e-12) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / den;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / den;
      if (v < -1e-6) continue;
      const w = 1 - u - v;
      if (w < -1e-6) continue;
      return u * ys[t[0]] + v * ys[t[1]] + w * ys[t[2]];
    }
    return null;
  }

  /**
   * A granite kerb along a run of PRIMARY circulation, and nothing along a
   * secondary connector. That is the hierarchy: the loop, the spine, the
   * diagonals and the promenade are built streets inside the park; a spur to a
   * gate or a 20 m cross link is a way through the grass.
   *
   * Two quads per side per span -- a chamfered top from the walk surface out to
   * the kerb line, and the face down to the lawn. Spans are decimated where the
   * walk is locally straight, so the eight Comm Ave Mall blocks cost almost
   * nothing and the Public Garden's lagoon curve keeps its resolution.
   */
  _kerb(path, pathIndex, frame, out, onOtherWalk) {
    const n = frame.length;
    if (n < 2) return;
    const half = path.width / 2;

    // Keep a vertex when the walk has turned since the last kept one, or when
    // the run since then is long enough that a straight chord would start to
    // cut the corner.
    const keep = [0];
    let turn = 0, run = 0;
    for (let i = 1; i < n - 1; i++) {
      const a = frame[i - 1], b = frame[i], c2 = frame[i + 1];
      const d0 = Math.atan2(b.z - a.z, b.x - a.x);
      const d1 = Math.atan2(c2.z - b.z, c2.x - b.x);
      let dt = d1 - d0;
      while (dt > Math.PI) dt -= 2 * Math.PI;
      while (dt < -Math.PI) dt += 2 * Math.PI;
      turn += Math.abs(dt);
      run += Math.hypot(b.x - a.x, b.z - a.z);
      if (turn > 0.045 || run > 12) { keep.push(i); turn = 0; run = 0; }
    }
    keep.push(n - 1);

    const pos = [], nrm = [], uv = [], col = [], idx = [];
    const c = new THREE.Color();
    const up = { x: 0, y: 1, z: 0 };
    for (const side of [-1, 1]) {
      let prev = null;
      for (const i of keep) {
        const f = frame[i];
        const ix = f.x + f.mx * half * side, iz = f.z + f.mz * half * side;
        const ox = f.x + f.mx * (half + KERB_W) * side;
        const oz = f.z + f.mz * (half + KERB_W) * side;
        // A kerb may not run across another walk, and may not leave the lawn.
        if (onOtherWalk(ox, oz, pathIndex) || onOtherWalk(ix, iz, pathIndex)) { prev = null; continue; }
        const top = f.lawnY + KERB_H;
        const base = pos.length / 3;
        const w = hash2(Math.floor(f.x / 3) + 907, Math.floor(f.z / 3) - 331);
        c.setRGB(0.315 + w * 0.055, 0.310 + w * 0.05, 0.300 + w * 0.05);
        // inner (at the walk), top of kerb, foot on the lawn
        pos.push(ix, f.y, iz, ox, top, oz, ox, f.lawnY, oz);
        nrm.push(up.x, up.y, up.z, up.x, up.y, up.z,
                 f.mx * side, 0.35, f.mz * side);
        uv.push(ix / 2.4, iz / 2.4, ox / 2.4, oz / 2.4, ox / 2.4, oz / 2.4 + 0.1);
        for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
        if (prev !== null) {
          // chamfered top, then the face
          idx.push(prev, prev + 1, base, prev + 1, base + 1, base);
          idx.push(prev + 1, prev + 2, base + 1, prev + 2, base + 2, base + 1);
        }
        prev = base;
      }
    }
    if (idx.length) out.push({ pos, nrm, uv, col, idx });
  }

  /**
   * Mesh the park walks. Two merged meshes for the whole city — the paved walks
   * of the Common and the Esplanade, and the stone dust of the Public Garden
   * and the Comm Ave Mall — on materials the city already builds, so nineteen
   * parks' worth of circulation costs two draw calls and no new texture.
   */
  _buildPaths(scene, materials, paths, lawnIdx) {
    const T = this.terrain;
    const groups = { paved: [], stone: [], edge: [] };
    const c = new THREE.Color();

    // Every walk as segments on a coarse hash, so a kerb can be suppressed
    // where it would run across ANOTHER walk. Boston Common's diagonals cross
    // its loop and each other; a kerb through those is a wall across the path.
    const XC = 24, xhash = new Map();
    paths.forEach((path, pi) => {
      const q = path.pts || [];
      for (let i = 1; i < q.length; i++) {
        const a = q[i - 1], b = q[i], pad = path.width / 2 + 1;
        const x0 = Math.floor((Math.min(a.x, b.x) - pad) / XC);
        const x1 = Math.floor((Math.max(a.x, b.x) + pad) / XC);
        const z0 = Math.floor((Math.min(a.z, b.z) - pad) / XC);
        const z1 = Math.floor((Math.max(a.z, b.z) + pad) / XC);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const k = `${cx},${cz}`;
            let l = xhash.get(k);
            if (!l) xhash.set(k, l = []);
            l.push(pi, a.x, a.z, b.x, b.z, path.width / 2);
          }
        }
      }
    });
    const onOtherWalk = (x, z, self) => {
      const l = xhash.get(`${Math.floor(x / XC)},${Math.floor(z / XC)}`);
      if (!l) return false;
      for (let i = 0; i < l.length; i += 6) {
        if (l[i] === self) continue;
        const ax = l[i + 1], az = l[i + 2], bx = l[i + 3], bz = l[i + 4];
        const r = l[i + 5] + 0.25;
        const dx = bx - ax, dz = bz - az;
        const len = dx * dx + dz * dz;
        let t = len > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        if (qx * qx + qz * qz < r * r) return true;
      }
      return false;
    };

    paths.forEach((path, pathIndex) => {
      const pts = path.pts;
      if (!pts || pts.length < 2) return;
      const g = groups[path.surface === 'stone' ? 'stone' : 'paved'];
      if (!g) return;
      const idxSrc = lawnIdx.get(path.park);
      const half = path.width / 2;
      const pos = [], nrm = [], uv = [], col = [], idx = [];
      const frame = [];
      const tile = path.surface === 'stone' ? 3.0 : 2.4;

      // Offset frame per vertex, mitred so a bend keeps its width instead of
      // pinching. The centrelines are resampled and smoothed upstream, so the
      // mitre never has to survive a hairpin; the clamp is a guard, not a mode.
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        let dx = b.x - a.x, dz = b.z - a.z;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        let mx = -dz, mz = dx;
        if (i > 0 && i < n - 1) {
          const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
          const l0 = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
          const l1 = Math.hypot(p2.x - p1.x, p2.z - p1.z) || 1;
          const n0x = -(p1.z - p0.z) / l0, n0z = (p1.x - p0.x) / l0;
          const n1x = -(p2.z - p1.z) / l1, n1z = (p2.x - p1.x) / l1;
          let sx = n0x + n1x, sz = n0z + n1z;
          const sl = Math.hypot(sx, sz);
          if (sl > 1e-4) {
            sx /= sl; sz /= sl;
            const k = Math.min(2.5, 1 / Math.max(0.4, sx * n1x + sz * n1z));
            mx = sx * k; mz = sz * k;
          }
        }
        const lawnY = Districts._lawnY(idxSrc, p.x, p.z) ?? (T.groundHeight(p.x, p.z) + 0.05);
        const y = lawnY + 0.02;
        const nv = T.normalAt(p.x, p.z);
        frame.push({ x: p.x, z: p.z, mx, mz, y, lawnY });
        // Wear: the middle of a walk is swept clean, the margins collect grit.
        const w = hash2(Math.floor(p.x / 5) + 41, Math.floor(p.z / 5) - 17);
        for (const side of [-1, 1]) {
          const x = p.x + mx * half * side, z = p.z + mz * half * side;
          pos.push(x, y, z);
          nrm.push(nv.x, nv.y, nv.z);
          uv.push(x / tile, z / tile);
          if (path.surface === 'stone') c.setRGB(0.355 + w * 0.05, 0.330 + w * 0.045, 0.288 + w * 0.04);
          else c.setRGB(0.300 + w * 0.045, 0.297 + w * 0.045, 0.292 + w * 0.045);
          c.multiplyScalar(0.86);
          col.push(c.r, c.g, c.b);
        }
      }
      // Both ends of a run get the same treatment; the centre line is a strip.
      for (let i = 1; i < n; i++) {
        const a = (i - 1) * 2, b = i * 2;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
      g.push({ pos, nrm, uv, col, idx });

      if (EDGED.has(path.role)) this._kerb(path, pathIndex, frame, groups.edge, onOtherWalk);
    });

    for (const [surface, list] of Object.entries(groups)) {
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

      const src = materials?.get?.(
        surface === 'stone' ? 'dirt' : surface === 'edge' ? 'granite' : 'sidewalk');
      let mat;
      if (src) {
        mat = materials.assets.variant(`park_path_${surface}`, src, (x) => {
          x.vertexColors = true;
          x.color.setRGB(1, 1, 1);
          });
      } else {
        mat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.95, metalness: 0,
        });
      }
      // Two centimetres over the lawn is a real kerb, not a z-fighting margin,
      // but the lawn is already offset against the terrain and the path has to
      // beat both.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -6;
      mat.polygonOffsetUnits = -12;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'park_path_' + surface;
      recenter(geom, mesh);
      scene.add(mesh);
      this.meshes.push(mesh);
      this._owned = this._owned || [];
      if (!src) this._owned.push(mat);          // registry variants: Assets frees them
    }
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.parent?.remove(m); }
    for (const m of this._owned || []) m.dispose();
    this.meshes.length = 0;
  }
}

/**
 * Where the raster actually has data, in world metres. Published so callers can
 * decide *before* they probe — the terrain rings, for one, want to know which
 * of their vertices are even inside the surveyed area rather than discovering
 * it one `null` at a time. `half` is the nearest-neighbour half-cell margin
 * included: the raster answers for `x, z ∈ [-half, half)`.
 */
Districts.RASTER = {
  res: RES, n: N, minX: MINX, minZ: MINZ,
  maxX: MINX + (N - 1) * RES, maxZ: MINZ + (N - 1) * RES,
  half: MINX + (N - 1) * RES + RES / 2,      // 3310 m
};

export { IDS as DISTRICT_IDS };
