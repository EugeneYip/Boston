import * as THREE from 'three';
import { bostonUniforms } from './CascadedShadows.js';

/**
 * Irradiance volume — the "why isn't that alley pure black" system.
 *
 * N8AO gives contact occlusion at pixel scale and the PMREM sky gives a single
 * environment for the whole city, which means a courtyard, a tunnel and an open
 * plaza all receive identical skylight. That is the single loudest tell of a
 * hobby renderer. This builds a camera-centred grid of probes storing
 *
 *   rgb = local bounce irradiance (ground + wall), a = cosine-weighted sky visibility
 *
 * into one RGBA16F 3D texture that every lit material samples (see
 * CascadedShadows.js for the shader side). Sky visibility multiplies the sky IBL
 * and its specular; the bounce term is added, weighted toward downward-facing and
 * vertical surfaces the way real ground bounce behaves.
 *
 * Occlusion comes from a coarse city height field rasterised from mesh bounds, and
 * a horizon scan per probe column. No ray tracing, no render targets, ~0.3 ms/frame.
 */

const HF_CELL = 8;                 // metres per height-field cell
const HF_N = 800;                  // 6.4 km square, comfortably past the play area
const HF_HALF = (HF_N * HF_CELL) / 2;

const AZIMUTHS = 6;
const RADII = [10, 22, 46, 95, 190];
const LOCAL_R2 = 25;    // the column's own occluder is treated as 5 m away
const MIN_VIS = 0.08;   // even a sealed room gets a little light in a game
const BOX_CELLS = 10;   // an AABB wider than ~80 m is a merged chunk, not a building
const MAX_VERTS_PER_MESH = 24000;

const PRESETS = {
  ultra:  { gx: 40, gy: 10, gz: 40, sx: 17, sy: 11, budget: 52 },
  high:   { gx: 32, gy: 10, gz: 32, sx: 19, sy: 11, budget: 40 },
  medium: { gx: 24, gy: 8, gz: 24, sx: 24, sy: 14, budget: 26 },
  low:    null,
};

const FOLIAGE_RE = /tree|foliage|canopy|leaf|leaves|shrub|bush|hedge|vegetation|grass|ivy|planting/i;

/**
 * Foliage must not enter the occlusion field.
 *
 * A canopy is porous and, more importantly, the sun shadow map already resolves it
 * at centimetre scale. Stamping a tree's bounding box into a 19 m probe grid tells
 * every probe underneath that it is sealed inside a building, so dappled shade
 * turns into flat black — the worst artefact this system can produce. Buildings and
 * terrain are what this field is for.
 */
function isFoliage(o) {
  if (o.userData.foliage || o.userData.isFoliage) return true;
  if (FOLIAGE_RE.test(o.name)) return true;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  if (m && (m.alphaTest > 0 || (m.transparent && m.side === THREE.DoubleSide))) return true;
  return false;
}

const _box = new THREE.Box3();
const _mat = new THREE.Matrix4();

export default class LightProbes {
  constructor() {
    this.enabled = false;
    this.heights = null;
    this._cursor = 0;
    this._built = false;
    this._lastChildren = -1;
    this._checkTimer = 0;
    this._hz = new Float32Array(AZIMUTHS * RADII.length);
    this._cosA = new Float32Array(AZIMUTHS);
    this._sinA = new Float32Array(AZIMUTHS);
    for (let a = 0; a < AZIMUTHS; a++) {
      const t = (a / AZIMUTHS) * Math.PI * 2;
      this._cosA[a] = Math.cos(t);
      this._sinA[a] = Math.sin(t);
    }
    // Boston reads as brick, granite and asphalt: a warm-neutral bounce, not grey.
    // Color already converts sRGB into the linear working space on construction, so
    // these must NOT be converted again. Doing so darkened all bounce by ~8x, which
    // is what turned every shadowed surface into a flat black hole.
    this.groundAlbedo = new THREE.Color('#6b6257');
    this.wallAlbedo = new THREE.Color('#7d6a5c');
    this.sodium = new THREE.Color('#ff9c46');
  }

  init(ctx) {
    this.ctx = ctx;
    this._configure(ctx.settings.preset);
    ctx.bus.on('lighting:rebuild', () => { this._built = false; });
  }

  _configure(preset) {
    const p = PRESETS[preset] ?? PRESETS.high;
    this._dispose();
    if (!p) {
      this.enabled = false;
      bostonUniforms.bostonProbeMix.value = 0;
      return;
    }
    Object.assign(this, p);
    this.sz = this.sx;
    this.originY = -8;

    const n = this.gx * this.gy * this.gz;
    this.data = new Uint16Array(n * 4);
    // Zeroed data means "no sky visible anywhere", i.e. a black world for however
    // many frames the first sweep takes. Start from fully open sky instead.
    const one = THREE.DataUtils.toHalfFloat(1);
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = one;
    this.tex = new THREE.Data3DTexture(this.data, this.gx, this.gy, this.gz);
    this.tex.format = THREE.RGBAFormat;
    this.tex.type = THREE.HalfFloatType;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = this.tex.wrapR = THREE.ClampToEdgeWrapping;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;

    if (!this.heights) this.heights = new Float32Array(HF_N * HF_N);

    this.originX = NaN; this.originZ = NaN;
    this._cursor = 0;
    this._solvedOnce = false;
    this.enabled = true;

    bostonUniforms.bostonProbeTex.value = this.tex;
    bostonUniforms.bostonProbeInvExt.value.set(
      1 / (this.gx * this.sx), 1 / (this.gy * this.sy), 1 / (this.gz * this.sz));
  }

  setQuality(preset) { this._configure(preset); }

  /* ------------------------------------------------------------ heightfield */

  /**
   * Rasterise every shadow-casting mesh's world AABB into a coarse height field.
   * Cheap, conservative, and good enough: what we need is "how much of the sky can
   * this point see", and a building's silhouette from above is its footprint.
   */
  buildHeightField(scene) {
    const H = this.heights;
    H.fill(-1e4);
    let budget = 500000;

    scene.traverseVisible((o) => {
      if (budget <= 0) return;
      if (!o.isMesh || !o.castShadow || o.userData.noOcclusion) return;
      if (isFoliage(o)) return;
      const geo = o.geometry;
      if (!geo) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return;

      if (o.isInstancedMesh) {
        // Instances are individual objects, so their own AABB is a fair footprint.
        const count = Math.min(o.count, 30000);
        for (let i = 0; i < count && budget > 0; i++) {
          o.getMatrixAt(i, _mat);
          _mat.premultiply(o.matrixWorld);
          _box.copy(geo.boundingBox).applyMatrix4(_mat);
          budget -= this._stamp(H, _box);
        }
        return;
      }

      _box.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
      const w = (_box.max.x - _box.min.x) / HF_CELL;
      const d = (_box.max.z - _box.min.z) / HF_CELL;
      if (w <= BOX_CELLS && d <= BOX_CELLS) {
        budget -= this._stamp(H, _box);
      } else {
        // A merged chunk covers a whole block, most of which is street. Stamping
        // its AABB solid would tell every probe on that street it is indoors, so
        // sample the actual vertices instead and stamp only where geometry is.
        budget -= this._stampVertices(H, o);
      }
    });
    this._built = true;
  }

  /** Stride-sampled vertex rasterisation for merged/large meshes. */
  _stampVertices(H, mesh) {
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return 0;
    const n = pos.count;
    const stride = Math.max(1, Math.ceil(n / MAX_VERTS_PER_MESH));
    const m = mesh.matrixWorld.elements;
    let done = 0;
    for (let i = 0; i < n; i += stride) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const ci = ((wx + HF_HALF) / HF_CELL) | 0;
      const cj = ((wz + HF_HALF) / HF_CELL) | 0;
      if (ci < 0 || cj < 0 || ci >= HF_N || cj >= HF_N) continue;
      const k = cj * HF_N + ci;
      if (H[k] < wy) H[k] = wy;
      done++;
    }
    return done;
  }

  _stamp(H, box) {
    // Flat things (roads, ground, decals) occlude nothing worth modelling.
    if (box.max.y - box.min.y < 2.5) return 0;
    const i0 = Math.floor((box.min.x + HF_HALF) / HF_CELL);
    const i1 = Math.floor((box.max.x + HF_HALF) / HF_CELL);
    const j0 = Math.floor((box.min.z + HF_HALF) / HF_CELL);
    const j1 = Math.floor((box.max.z + HF_HALF) / HF_CELL);
    if (i1 < 0 || j1 < 0 || i0 >= HF_N || j0 >= HF_N) return 0;
    if (i1 - i0 > BOX_CELLS || j1 - j0 > BOX_CELLS) return 0;
    const top = box.max.y;
    let n = 0;
    for (let j = Math.max(0, j0); j <= Math.min(HF_N - 1, j1); j++) {
      const row = j * HF_N;
      for (let i = Math.max(0, i0); i <= Math.min(HF_N - 1, i1); i++) {
        if (H[row + i] < top) H[row + i] = top;
        n++;
      }
    }
    return n;
  }

  heightAt(x, z) {
    const i = ((x + HF_HALF) / HF_CELL) | 0;
    const j = ((z + HF_HALF) / HF_CELL) | 0;
    if (i < 0 || j < 0 || i >= HF_N || j >= HF_N) return -1e4;
    return this.heights[j * HF_N + i];
  }

  /* ----------------------------------------------------------------- frame */

  /**
   * @param {object} sun { dirY, color: THREE.Color, intensity, skyColor, skyIntensity, night }
   */
  update(dt, ctx, sun) {
    if (!this.enabled) return;

    if (!this._built) { this.buildHeightField(ctx.scene); this._forceFull = true; }
    // Streamed-in geometry changes the skyline; re-stamp occasionally, not per frame.
    this._checkTimer += dt;
    if (this._checkTimer > 3) {
      this._checkTimer = 0;
      const n = ctx.scene.children.length;
      if (n !== this._lastChildren) { this._lastChildren = n; this._built = false; }
    }

    const cam = ctx.camera;
    const ox = Math.round((cam.position.x - this.gx * this.sx * 0.5) / this.sx) * this.sx;
    const oz = Math.round((cam.position.z - this.gz * this.sz * 0.5) / this.sz) * this.sz;
    const cols = this.gx * this.gz;
    let jumped = false;
    if (ox !== this.originX || oz !== this.originZ) {
      // A jump of more than a couple of cells (teleport, capture harness, fast
      // travel) invalidates the whole volume: solve it outright rather than
      // showing a frame of stale occlusion, which reads as black smearing.
      jumped = !isFinite(this.originX) ||
        Math.abs(ox - this.originX) > this.sx * 2.5 ||
        Math.abs(oz - this.originZ) > this.sz * 2.5;
      this.originX = ox; this.originZ = oz;
      bostonUniforms.bostonProbeOrigin.value.set(ox, this.originY, oz);
    }
    if (this._forceFull) { jumped = true; this._forceFull = false; }

    // Refresh columns round-robin. A full sweep takes ~0.4 s, well inside how fast
    // either the sun or the skyline can change.
    let n = jumped ? cols : Math.min(this.budget, cols);
    while (n-- > 0) {
      this._solveColumn(this._cursor % cols, sun);
      this._cursor = (this._cursor + 1) % cols;
    }
    this.tex.needsUpdate = true;
    // Only let the volume influence shading once it has been fully solved at least
    // once for this origin. An unsolved volume reads as "no sky anywhere", which
    // would black out every shadow.
    if (jumped || this._cursor === 0) this._solvedOnce = true;
    bostonUniforms.bostonProbeMix.value =
      (this._solvedOnce && bostonUniforms.bostonProbeTex.value) ? 1 : 0;
  }

  /** Solve every layer of one XZ column at once: the horizon scan is shared. */
  _solveColumn(c, sun) {
    const ix = c % this.gx;
    const iz = (c / this.gx) | 0;
    const wx = this.originX + (ix + 0.5) * this.sx;
    const wz = this.originZ + (iz + 0.5) * this.sz;

    const hz = this._hz;
    for (let a = 0; a < AZIMUTHS; a++) {
      const ca = this._cosA[a], sa = this._sinA[a];
      for (let r = 0; r < RADII.length; r++) {
        const d = RADII[r];
        hz[a * RADII.length + r] = this.heightAt(wx + ca * d, wz + sa * d);
      }
    }
    const local = this.heightAt(wx, wz);

    // Ground-level visibility drives how much light the street itself receives, and
    // therefore how much it can bounce back up onto the facades.
    const gv = this._visibility(hz, 1.5, local);
    const openSun = gv > 0.25 ? 1 : gv * 4;

    const sunUp = Math.max(sun.dirY, 0);
    const sr = sun.color.r * sun.intensity * sunUp;
    const sg = sun.color.g * sun.intensity * sunUp;
    const sb = sun.color.b * sun.intensity * sunUp;
    const kr = sun.skyColor.r * sun.skyIntensity;
    const kg = sun.skyColor.g * sun.skyIntensity;
    const kb = sun.skyColor.b * sun.skyIntensity;

    const ga = this.groundAlbedo, wa = this.wallAlbedo, na = this.sodium;
    const base = this.gy;

    for (let iy = 0; iy < base; iy++) {
      const y = this.originY + (iy + 0.5) * this.sy;
      const vis = this._visibility(hz, y, local);

      // Ground bounce: direct sun and skylight off the street, seen from up here.
      const gr = (sr * openSun + kr * gv) * 0.42;
      const gg = (sg * openSun + kg * gv) * 0.42;
      const gb = (sb * openSun + kb * gv) * 0.42;
      // Wall bounce: the more enclosed a point is, the more of its fill comes off
      // brick and stone rather than straight down from the sky.
      const enc = 1 - vis;
      // Street lamps light the underside of a city at night from below.
      const nf = sun.night * (y < 16 ? 1 : Math.max(0, 1 - (y - 16) / 26)) * 0.06 * gv;

      const r = ga.r * gr + wa.r * kr * enc * 0.26 + na.r * nf;
      const g = ga.g * gg + wa.g * kg * enc * 0.26 + na.g * nf;
      const b = ga.b * gb + wa.b * kb * enc * 0.26 + na.b * nf;

      const o = (ix + this.gx * (iy + this.gy * iz)) * 4;
      const d = this.data;
      d[o] = THREE.DataUtils.toHalfFloat(r);
      d[o + 1] = THREE.DataUtils.toHalfFloat(g);
      d[o + 2] = THREE.DataUtils.toHalfFloat(b);
      d[o + 3] = THREE.DataUtils.toHalfFloat(vis);
    }
  }

  /**
   * Cosine-weighted fraction of the hemisphere that is open sky. For a horizon at
   * elevation t in one azimuth slice, the visible cosine-weighted fraction is
   * cos^2(t) = 1 - sin^2(t), which is why only the sine is ever needed.
   *
   * The column's own height is folded in as an occluder at ~5 m rather than as an
   * "indoors" flag. That distinction matters: a tree canopy 4 m overhead should
   * halve the skylight, not extinguish it, while a point 40 m below a roofline
   * still resolves to a properly dark interior. Treating the two the same is what
   * turns every patch of shade into flat black.
   */
  _visibility(hz, y, local) {
    let over = 0;
    const dl = local - y;
    if (dl > 0) over = dl / Math.sqrt(dl * dl + LOCAL_R2);

    let sum = 0;
    for (let a = 0; a < AZIMUTHS; a++) {
      let mx = over;
      const o = a * RADII.length;
      for (let r = 0; r < RADII.length; r++) {
        const dh = hz[o + r] - y;
        if (dh <= 0) continue;
        const d = RADII[r];
        const s = dh / Math.sqrt(dh * dh + d * d);
        if (s > mx) mx = s;
      }
      sum += 1 - mx * mx;
    }
    const v = sum / AZIMUTHS;
    return v < MIN_VIS ? MIN_VIS : v;
  }

  /** Decode the probe nearest a world point — debugging and the dev overlay. */
  sampleVisibility(p) {
    if (!this.enabled || !this.data) return null;
    const ix = THREE.MathUtils.clamp(Math.floor((p.x - this.originX) / this.sx), 0, this.gx - 1);
    const iy = THREE.MathUtils.clamp(Math.floor((p.y - this.originY) / this.sy), 0, this.gy - 1);
    const iz = THREE.MathUtils.clamp(Math.floor((p.z - this.originZ) / this.sz), 0, this.gz - 1);
    const o = (ix + this.gx * (iy + this.gy * iz)) * 4;
    const f = (h) => {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
      return e === 31 ? NaN : s * Math.pow(2, e - 15) * (1 + m / 1024);
    };
    return {
      skyVis: +f(this.data[o + 3]).toFixed(3),
      bounce: [f(this.data[o]), f(this.data[o + 1]), f(this.data[o + 2])].map(v => +v.toFixed(3)),
    };
  }

  _dispose() {
    this.tex?.dispose();
    this.tex = null;
    this.data = null;
  }

  dispose() {
    this._dispose();
    this.heights = null;
    bostonUniforms.bostonProbeMix.value = 0;
    bostonUniforms.bostonProbeTex.value = null;
  }
}
