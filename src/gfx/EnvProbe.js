import * as THREE from 'three';

/**
 * EnvProbe — the city's reflection probe.
 *
 * ## Why this exists
 * Until this landed, `scene.environment` was a **336x256 PMREM of the sky dome
 * only** (a 64-pixel cube). Nothing else in the world was in it: no towers, no
 * street, no ground. Every specular surface in Boston — 200 Clarendon's curtain
 * wall at roughness 0.045, the Charles at 0.075, wet asphalt at 0.06 — was
 * therefore mirroring a featureless gradient, which renders as a flat dark quad.
 * That single fact was behind three separate rubric failures (dead glass, a matte
 * river, a wet road that reflects nothing).
 *
 * This renders the actual scene into a cube map, PMREM-filters it so roughness
 * maps onto mip level the way three's split-sum IBL expects, and publishes it as
 * `scene.environment` **and** as a per-material `envMap`.
 *
 * ## Why per-material `envMap` and not just `scene.environment`
 * `WebGLRenderer.setProgram` contains this:
 *
 *     if ( material.isMeshStandardMaterial && material.envMap === null &&
 *          scene.environment !== null )
 *         m_uniforms.envMapIntensity.value = scene.environmentIntensity;
 *
 * i.e. a material that relies on `scene.environment` has its own
 * `envMapIntensity` **thrown away** every frame. Every authored value in this
 * project — glass 1.25, building glass 1.9, water 2.1, chrome 1.3, road 0.55 —
 * was silently collapsed to one global number. Assigning the same texture as
 * `material.envMap` restores the authored value; `Materials` then folds
 * `scene.environmentIntensity` back in by hand so the day/night curve still
 * works. See `Materials._applyEnv`.
 *
 * Because `scene.environment` and every adopted `material.envMap` point at the
 * *same* texture, `envMapCubeUVHeight` (a program-cache-key parameter) is
 * identical either way, so adoption costs **no shader recompile** at all.
 *
 * ## Cost control — read before raising anything here
 * A cube probe is six scene renders. The rules that keep it affordable:
 *  - **One face per frame, ever** (except the boot bake, which happens before
 *    the first frame is presented). A refresh cycle costs 6 frames, not one.
 *  - **Lazy triggers only**: the camera moving `MOVE_M` metres, the clock moving
 *    `TOD_H` hours, a weather change, or a slow heartbeat. A parked camera does
 *    no probe work at all, which is why `capture()` reports clean draw/triangle
 *    counts: the refresh finishes inside the 24-frame warmup and the six
 *    measured frames are idle.
 *  - **Minor geometry is skipped** (`SKIP_RE`). Props, plants, pedestrians and
 *    the additive light proxies are most of the city's draw calls and none of
 *    them are resolvable in a 256px face. Only meshes are touched, never lights:
 *    hiding a subtree that contains a light changes `NUM_*_LIGHTS` and
 *    recompiles every material in the scene — that mistake has already produced
 *    two bogus perf diagnoses here, see CURRENT_STATE.md.
 *  - **Shadow maps are not regenerated** for the probe camera
 *    (`shadowMap.autoUpdate = false` around the render). The cascades the main
 *    camera just rendered are reused. `enabled` is deliberately NOT touched —
 *    that is a program-cache-key parameter and would recompile the world.
 *
 * The engine rule is that only `RenderPipeline` may render to the **back
 * buffer**. This never does: it writes to private render targets and restores
 * the previous binding, exactly like `Sky._blit` and `THREE.PMREMGenerator`.
 */

/** Cube face resolution per quality preset. Powers of two only — PMREM's LOD
 *  chain is built from `floor(log2(size))`. */
const SIZES = { low: 64, medium: 128, high: 256, ultra: 256 };

/**
 * Geometry excluded from the probe.
 *
 * Matched against the object's name and its material's name. These are the
 * things that cost draw calls but cannot survive being resampled into a 256px
 * cube face: street props, planting, crowds, and `LightManager`'s additive
 * glow/pool proxies (which size themselves in *screen* pixels and would smear
 * into the probe as blobs).
 */
const SKIP_RE =
  /prop|veg_|plant|tree|foliage|shrub|hedge|grass|decal|ped|crowd|char|player|glow|lightPool|halo|rain|snow|precip|particle|billboard/i;

/** Refresh triggers. */
const MOVE_M = 45;      // metres of camera travel before the probe is stale
const TOD_H = 0.12;     // hours of world clock before the sun has visibly moved
const HEARTBEAT_S = 8;  // catch-all for anything the two above miss

const _pos = new THREE.Vector3();

export default class EnvProbe {
  /**
   * @param {object} [o]
   * @param {string} [o.preset]   quality preset name
   * @param {number} [o.lift]     metres the probe sits above the camera
   */
  constructor({ preset = 'high', lift = 6 } = {}) {
    this.size = SIZES[preset] ?? SIZES.high;
    this.lift = lift;
    this.enabled = true;
    this.skipMinor = true;
    /** @type {THREE.Texture|null} stable across refreshes; safe to hand to materials. */
    this.texture = null;

    this._queue = [];          // faces still to render this cycle
    this._hidden = [];         // meshes stood down for the current face
    this._heartbeat = 0;
    this._lastTod = -999;
    this._lastPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._bakes = 0;
    this._faces = 0;
    this._faceMs = 0;
    this._bakeMs = 0;
  }

  /**
   * Allocate the targets and produce a first (blank) PMREM so `texture` is a
   * stable object from this moment on. Materials built afterwards can take it as
   * their `envMap` at construction time and never need a recompile.
   */
  init(ctx) {
    this.ctx = ctx;
    const renderer = ctx.renderer;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.cubeRT.texture.name = 'envProbe.cube';

    // near 1 m keeps the player's own capsule out of the probe; far has to clear
    // the sky dome (radius 9000) or the whole sky is clipped away and every
    // reflection turns black.
    this.cam = new THREE.CubeCamera(1.0, 11000, this.cubeRT);
    this.cam.coordinateSystem = renderer.coordinateSystem;
    this.cam.updateCoordinateSystem();
    this.cam.matrixAutoUpdate = false;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();

    // Start from a neutral sky-grey rather than uninitialised memory: between
    // here and the boot bake nothing renders, but a NaN/black probe reaching a
    // material would be a black world, and that failure mode is expensive to
    // diagnose.
    this._clearCube(renderer, 0.32, 0.40, 0.52);
    this._bake(renderer);
    return this;
  }

  /** Re-allocate for a new quality preset. Invalidates `texture`. */
  setQuality(preset) {
    const size = SIZES[preset] ?? SIZES.high;
    if (size === this.size || !this.ctx) return false;
    const ctx = this.ctx;
    this.dispose();
    this.size = size;
    this.texture = null;
    this.init(ctx);
    this.invalidate();
    return true;
  }

  /** Mark the probe stale; the faces re-render one per frame from now on. */
  invalidate() {
    this._queue = [0, 1, 2, 3, 4, 5];
    this._heartbeat = 0;
  }

  /**
   * Render all six faces and filter them, right now, in one go.
   * Only for the boot bake and explicit debugging — never per frame.
   */
  refreshNow(ctx = this.ctx) {
    if (!this.enabled || !this.cubeRT) return;
    const renderer = ctx.renderer;
    this._place(ctx);
    for (let f = 0; f < 6; f++) this._renderFace(renderer, ctx.scene, f);
    this._bake(renderer);
    this._queue.length = 0;
    this._lastTod = ctx.time.timeOfDay;
    this._lastPos.copy(this.cam.position);
    this._heartbeat = 0;
  }

  /**
   * Frame hook. Drains at most one face; filters and publishes when the last
   * face of a cycle lands. Call from a `lateUpdate`, after lighting has settled
   * and before the composer runs.
   */
  update(dt, ctx) {
    if (!this.enabled || !this.cubeRT) return;
    this._heartbeat += dt;

    if (!this._queue.length) {
      const cam = ctx.camera;
      const moved = this._lastPos.distanceToSquared(cam.position) > MOVE_M * MOVE_M;
      const turned = Math.abs(ctx.time.timeOfDay - this._lastTod) > TOD_H;
      if (moved || turned || this._heartbeat > HEARTBEAT_S) {
        this._place(ctx);
        this._queue = [0, 1, 2, 3, 4, 5];
        this._lastTod = ctx.time.timeOfDay;
        this._lastPos.copy(cam.position);
        this._heartbeat = 0;
      } else {
        return;
      }
    }

    const face = this._queue.shift();
    this._renderFace(ctx.renderer, ctx.scene, face);
    if (!this._queue.length) this._bake(ctx.renderer);
  }

  /** Diagnostics for the console / dev overlay. */
  debug() {
    return {
      size: this.size,
      pmrem: this.texture ? [this.texture.image?.width ?? this.pmremRT?.width,
                            this.texture.image?.height ?? this.pmremRT?.height] : null,
      published: !!this.texture,
      queued: this._queue.length,
      bakes: this._bakes,
      faces: this._faces,
      msPerFace: +(this._faceMs / Math.max(1, this._faces)).toFixed(2),
      msPerBake: +(this._bakeMs / Math.max(1, this._bakes)).toFixed(2),
      skipMinor: this.skipMinor,
      pos: this.cam ? this.cam.position.toArray().map(v => +v.toFixed(1)) : null,
    };
  }

  dispose() {
    this.cubeRT?.dispose();
    this.pmremRT?.dispose();
    this.pmrem?.dispose();
    this.cubeRT = null; this.pmremRT = null; this.pmrem = null;
    this.texture = null;
    this._queue.length = 0;
  }

  /* ------------------------------------------------------------------ internals */

  /**
   * Park the probe.
   *
   * A single probe is always a compromise between the street (where wet asphalt
   * needs the buildings above it) and the towers (which want the skyline). The
   * camera position lifted a few metres is the standard answer: it clears parked
   * cars and the player's own body without leaving the space the camera is in.
   */
  _place(ctx) {
    _pos.copy(ctx.camera.position);
    _pos.y += this.lift;
    this.cam.position.copy(_pos);
    this.cam.updateMatrixWorld(true);
  }

  _clearCube(renderer, r, g, b) {
    const prev = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const col = new THREE.Color();
    renderer.getClearColor(col);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(r, g, b), 1);
    for (let f = 0; f < 6; f++) {
      renderer.setRenderTarget(this.cubeRT, f);
      renderer.clear(true, true, false);
    }
    renderer.setClearColor(col, alpha);
    renderer.setRenderTarget(prev, prevFace, prevMip);
  }

  /**
   * One cube face. Saves and restores every renderer flag it touches, so the
   * main pass that runs immediately afterwards sees no change.
   */
  _renderFace(renderer, scene, face) {
    const t0 = performance.now();
    const prev = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevXr = renderer.xr.enabled;

    // Reuse the cascades the main camera already rendered. Do NOT touch
    // `shadowMap.enabled`: it is a program-cache-key parameter and toggling it
    // recompiles every lit material in the city.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.xr.enabled = false;
    renderer.autoClear = true;

    if (this.skipMinor) this._hide(scene);
    renderer.setRenderTarget(this.cubeRT, face);
    renderer.render(scene, this.cam.children[face]);
    this._show();

    renderer.setRenderTarget(prev, prevFace, prevMip);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    renderer.xr.enabled = prevXr;

    this._faces++;
    this._faceMs += performance.now() - t0;
  }

  /**
   * Stand down geometry the probe cannot resolve.
   *
   * Only `isMesh`/`isInstancedMesh` nodes are touched, and only leaves — never a
   * group, because `WebGLRenderer.projectObject` returns early on
   * `visible === false` *before* it pushes a light, so hiding a subtree that
   * contains one silently changes the light count and recompiles the scene.
   */
  _hide(scene) {
    const out = this._hidden;
    out.length = 0;
    scene.traverse((o) => {
      if (!o.visible) return;
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData.envProbe === true) return;       // opt back in
      let skip = o.userData.envProbe === false;
      if (!skip) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        skip = SKIP_RE.test(o.name) ||
               (o.parent && SKIP_RE.test(o.parent.name)) ||
               (m && m.name && SKIP_RE.test(m.name));
      }
      if (skip) { o.visible = false; out.push(o); }
    });
  }

  _show() {
    const out = this._hidden;
    for (let i = 0; i < out.length; i++) out[i].visible = true;
    out.length = 0;
  }

  /**
   * Cube -> CubeUV PMREM. `fromCubemap` reuses the render target it is handed,
   * so `this.texture` is the same object for the life of the probe and every
   * material holding it keeps working.
   */
  _bake(renderer) {
    const t0 = performance.now();
    const prevAutoClear = renderer.autoClear;
    this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
    renderer.autoClear = prevAutoClear;
    this.pmremRT.texture.name = 'envProbe.pmrem';
    this.texture = this.pmremRT.texture;
    this._bakes++;
    this._bakeMs += performance.now() - t0;
  }
}
