import * as THREE from 'three';
import GpuTimer from '../gfx/effects/GpuTimer.js';

/**
 * Whole-engine profiler.
 *
 * The frame budget in ARCHITECTURE.md is a *system* budget, but every tool we had
 * reported a single aggregate number: `renderer.info` cannot tell you which subtree
 * spent the triangles, and `perf.ms` cannot tell you which `update()` spent the
 * milliseconds. This closes both gaps without any other file having to cooperate:
 *
 *  - **CPU per system.** `engine.order` is fully populated before any `init()` runs,
 *    so we walk it and wrap each instance's `update`/`fixedUpdate`/`lateUpdate` in
 *    place. Nobody has to register, and nobody's source changes.
 *  - **Shadow-map cost.** `WebGLRenderer.render()` renders the shadow maps inline, so
 *    `RenderPass` timing hides them. Wrapping `renderer.shadowMap.render` and reading
 *    `renderer.info.render` either side gives the exact shadow draw calls, triangles
 *    and CPU time, separated from the camera pass.
 *  - **Draw calls / triangles per subtree.** A frustum walk that reproduces
 *    `WebGLRenderer.projectObject` + `WebGLRenderList.push` semantics exactly
 *    (one draw per geometry group when the material is an array, instance-scaled
 *    triangle counts, `InstancedMesh.boundingSphere` culling).
 *  - **GPU per pass.** Reuses `RenderPipeline`'s `GpuTimer` instance when there is one,
 *    joining its round-robin so we never have two TIME_ELAPSED queries in flight.
 *    Chrome withholds `EXT_disjoint_timer_query_webgl2` by default, so the practical
 *    path is the A/B sync bisector below.
 *
 * The per-frame path writes into preallocated records and allocates nothing. The
 * expensive parts (scene walk, A/B bisection) are on-demand only, which is why this
 * is safe to leave registered permanently.
 *
 * From an automation context:
 *   await window.__boston.capture({ shot: 'street_level' })
 *   await window.__boston.profile()              // full structured report
 *   window.__boston.profileFast()                // cheap, no GPU sync
 *
 * LOADING. `main.js` builds its system list from `import.meta.glob` over
 * `gfx/world/ai/gameplay/ui/audio` only, so nothing in `src/core/` is auto-registered.
 * Until the core owner adds `'./core/*.js'` to that glob and `'./core/Profiler.js'`
 * to `OPTIONAL`, attach it after boot instead — `Profiler.attach()` is idempotent and
 * does the whole job:
 *
 *   const { default: Profiler } = await import('/src/core/Profiler.js');
 *   await Profiler.attach(window.engine);
 */

/** Frustum-walk scratch. Module scope so the walk allocates nothing. */
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/** Systems whose cost is measured but which are not part of the game's frame. */
const SELF = 'profiler';

export default class Profiler {
  static id = SELF;
  static label = 'Profiler';
  static deps = ['render'];

  constructor() {
    /** Time systems every Nth frame. 1 is already <10us/frame; raise it if paranoid. */
    this.sampleEvery = 1;
    /** Exponential smoothing for the per-frame numbers reported by snapshot(). */
    this.smoothing = 0.1;
    /** id -> { id, sys, update, fixedUpdate, lateUpdate, muted, orig{} } */
    this.records = new Map();
    this.enabled = true;

    this._frame = 0;
    this._installed = false;
    this._shadow = { ms: 0, calls: 0, tris: 0, msSm: 0, callsSm: 0, trisSm: 0 };
    this._frameMs = 0;
    this._syncShadow = false;
    this._shadowSyncMs = 0;
    this._probeNames = ['ShadowMaps'];
    // Reused by walkScene() so a per-frame graph sample never allocates.
    this._subtrees = new Map();
    this._heavy = [];
  }

  /**
   * Register and initialise against an already-booted engine. Idempotent, so it is
   * safe to call from a console, a hotkey or a harness step at any point.
   *
   * @param {import('./Engine.js').default} engine
   * @return {Promise<Profiler>}
   */
  static async attach(engine) {
    const existing = engine.systems.get(SELF);
    if (existing) return existing;
    const p = new Profiler();
    engine.systems.set(SELF, p);
    engine.order.push(p);
    await p.init(engine.ctx);
    p._exposeApi();
    return p;
  }

  /* --------------------------------------------------------------- install -- */

  async init(ctx) {
    this.ctx = ctx;
    this.engine = ctx.engine;
    this.renderer = ctx.renderer;
    this.pipeline = ctx.get('render') || null;

    // Prefer the render pipeline's timer: one TIME_ELAPSED query may be active at a
    // time per context, and joining its round-robin is the only way to guarantee that.
    this.gpuTimer = this.pipeline?.gpuTimer || new GpuTimer(this.renderer);
    this._ownsTimer = !this.pipeline?.gpuTimer;

    // The lighting agent's shared uniform block, used as recompile-free A/B toggles.
    // Dynamic so a missing or renamed lighting module degrades instead of breaking
    // the whole profiler.
    try {
      const m = await import('../gfx/CascadedShadows.js');
      this._uniforms = m.bostonUniforms || null;
    } catch (e) {
      this._uniforms = null;
    }

    this._install();
    ctx.bus.on('engine:ready', () => {
      this._install();          // idempotent; catches systems that rebind in init()
      this._exposeApi();
    });
  }

  /** Wrap the engine frame, every system's tick methods, and the shadow map. */
  _install() {
    if (this._installed) { this._wrapSystems(); return; }
    this._installed = true;

    const engine = this.engine;
    const renderer = this.renderer;

    // --- whole frame + the render half of it ------------------------------
    this._origFrame = engine.frame.bind(engine);
    const self = this;
    engine.frame = function () {
      const t0 = performance.now();
      self._frame++;
      self._shadow.ms = 0; self._shadow.calls = 0; self._shadow.tris = 0;
      self._origFrame();
      self._frameMs += (performance.now() - t0 - self._frameMs) * self.smoothing;
      const sh = self._shadow;
      sh.msSm += (sh.ms - sh.msSm) * self.smoothing;
      sh.callsSm += (sh.calls - sh.callsSm) * self.smoothing;
      sh.trisSm += (sh.tris - sh.trisSm) * self.smoothing;
    };

    // --- shadow maps ------------------------------------------------------
    // renderer.info accumulates (RenderPipeline pins autoReset off), so a delta
    // around this call is exactly what the cascades cost in the camera-less passes.
    const sm = renderer.shadowMap;
    if (sm && !sm.__bostonProfiled) {
      sm.__bostonProfiled = true;
      const origShadow = sm.render.bind(sm);
      const info = renderer.info.render;
      sm.render = function (lights, scene, camera) {
        if (!self.enabled) return origShadow(lights, scene, camera);
        const c0 = info.calls, t0i = info.triangles;
        const timed = self.gpuTimer.begin('ShadowMaps');
        if (self._syncShadow) self._sync();
        const t0 = performance.now();
        origShadow(lights, scene, camera);
        if (self._syncShadow) { self._sync(); self._shadowSyncMs += performance.now() - t0; }
        self._shadow.ms += performance.now() - t0;
        if (timed) self.gpuTimer.end();
        self._shadow.calls += info.calls - c0;
        self._shadow.tris += info.triangles - t0i;
      };
      this._restoreShadow = () => { sm.render = origShadow; sm.__bostonProfiled = false; };
    }

    // --- let our probes ride the pipeline's timer round-robin --------------
    const gt = this.gpuTimer;
    if (gt.available && !gt.__bostonProbes) {
      gt.__bostonProbes = this._probeNames;
      const origBegin = gt.beginFrame.bind(gt);
      this._probeAll = [];
      gt.beginFrame = (names) => {
        const all = this._probeAll;
        all.length = 0;
        for (let i = 0; i < names.length; i++) all.push(names[i]);
        for (let i = 0; i < this._probeNames.length; i++) all.push(this._probeNames[i]);
        origBegin(all);
      };
    }

    this._wrapSystems();
  }

  /**
   * Wrap every registered system's tick methods. Idempotent, and safe to call again
   * after a system is added: already-wrapped methods carry a marker.
   */
  _wrapSystems() {
    const self = this;
    for (const sys of this.engine.order) {
      const id = sys.constructor.id;
      if (id === SELF) continue;
      let rec = this.records.get(id);
      if (!rec) {
        rec = {
          id, sys, muted: false,
          update: 0, fixedUpdate: 0, lateUpdate: 0,          // this frame, ms
          uSm: 0, fSm: 0, lSm: 0,                            // smoothed, ms
          calls: 0, orig: {},
        };
        this.records.set(id, rec);
      }
      for (const phase of ['fixedUpdate', 'update', 'lateUpdate']) {
        const fn = sys[phase];
        if (typeof fn !== 'function' || fn.__bostonWrapped) continue;
        rec.orig[phase] = fn;
        const wrapped = function (a, b) {
          if (rec.muted) return;
          if (!self.enabled || (self._frame % self.sampleEvery)) return fn.call(this, a, b);
          const t = performance.now();
          const r = fn.call(this, a, b);
          rec[phase] += performance.now() - t;
          return r;
        };
        wrapped.__bostonWrapped = true;
        sys[phase] = wrapped;
      }
    }
  }

  /** Publish onto the capture harness so automation can reach everything. */
  _exposeApi() {
    const api = window.__boston;
    if (!api) return;
    // RenderPipeline publishes a pass-only profiler under the same name. Keep it
    // reachable and fold its output into the full report rather than shadowing it.
    if (api.profile && !api.profilePasses) api.profilePasses = api.profile;
    api.profiler = this;
    api.profile = (o) => this.profile(o);
    api.profileFast = () => this.snapshot();
    api.sceneCost = (o) => this.walkScene(o);
    api.systemCost = () => this.systemCost();
    api.bisect = (o) => this.bisect(o);
    api.passCost = (n) => this.measurePasses(n);
    api.cascadeCost = (n) => this.measureCascades(n);
    api.prefixCost = (o) => this.measurePrefix(o);
    api.initCost = (id, m) => this.profileInit(id, m);
    api.loopFps = (s) => this.measureLoopFps(s);
  }

  /* ------------------------------------------------------------------ tick -- */

  /** Roll this frame's per-system samples into the smoothed values, then zero them. */
  lateUpdate() {
    const k = this.smoothing;
    for (const r of this.records.values()) {
      r.uSm += (r.update - r.uSm) * k;
      r.fSm += (r.fixedUpdate - r.fSm) * k;
      r.lSm += (r.lateUpdate - r.lSm) * k;
      r.update = 0; r.fixedUpdate = 0; r.lateUpdate = 0;
    }
  }

  /* ---------------------------------------------------------------- report -- */

  /**
   * Cheap, allocation-light snapshot of the smoothed per-frame numbers. No GPU sync,
   * no scene walk — safe to call every frame from a HUD.
   * @return {object}
   */
  snapshot() {
    const p = this.engine.perf;
    const sh = this._shadow;
    return {
      fps: +p.fps.toFixed(1),
      frameMs: +this._frameMs.toFixed(2),
      cpuSystemsMs: +this.systemTotal().toFixed(2),
      draws: p.drawCalls,
      tris: p.tris,
      shadow: {
        ms: +sh.msSm.toFixed(2),
        draws: Math.round(sh.callsSm),
        tris: Math.round(sh.trisSm),
      },
      systems: this.systemCost(),
    };
  }

  /** @return {number} smoothed CPU ms/frame across every system's three phases. */
  systemTotal() {
    let t = 0;
    for (const r of this.records.values()) t += r.uSm + r.fSm + r.lSm;
    return t;
  }

  /**
   * Smoothed CPU cost of every system, in milliseconds per frame, heaviest first.
   * @return {Array<{id:string, ms:number, update:number, fixed:number, late:number}>}
   */
  systemCost() {
    const out = [];
    for (const r of this.records.values()) {
      const total = r.uSm + r.fSm + r.lSm;
      if (total < 1e-4) continue;
      out.push({
        id: r.id, ms: +total.toFixed(3),
        update: +r.uSm.toFixed(3), fixed: +r.fSm.toFixed(3), late: +r.lSm.toFixed(3),
      });
    }
    out.sort((a, b) => b.ms - a.ms);
    return out;
  }

  /* ------------------------------------------------------------ scene walk -- */

  /**
   * Draw calls and triangles attributable to each top-level scene subtree, for the
   * current camera. Reproduces `WebGLRenderer.projectObject` culling and
   * `WebGLRenderList.push` group splitting, so the totals match `renderer.info`
   * for the camera pass (shadow passes are counted separately — see shadowCost()).
   *
   * @param {{ heavy?:number }} [o] o.heavy = also return the N heaviest single meshes
   * @return {{ total:object, subtrees:Array, heavy:Array }}
   */
  walkScene({ heavy = 12 } = {}) {
    const scene = this.ctx.scene;
    const camera = this.ctx.camera;
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    const subs = this._subtrees;
    for (const s of subs.values()) {
      s.calls = 0; s.tris = 0; s.meshes = 0; s.instances = 0; s.culled = 0; s.nodes = 0;
    }
    const heavyList = this._heavy;
    heavyList.length = 0;

    for (const child of scene.children) {
      const key = child.name || child.type + '#' + child.id;
      let rec = subs.get(key);
      if (!rec) {
        rec = { name: key, calls: 0, tris: 0, meshes: 0, instances: 0, culled: 0, nodes: 0 };
        subs.set(key, rec);
      }
      this._walk(child, rec, heavyList);
    }

    const total = { calls: 0, tris: 0, meshes: 0, instances: 0, nodes: 0 };
    const subtrees = [];
    for (const s of subs.values()) {
      if (!s.nodes) continue;
      total.calls += s.calls; total.tris += s.tris;
      total.meshes += s.meshes; total.instances += s.instances; total.nodes += s.nodes;
      subtrees.push({ ...s });
    }
    subtrees.sort((a, b) => b.tris - a.tris || b.calls - a.calls);
    heavyList.sort((a, b) => b.tris - a.tris);
    return { total, subtrees, heavy: heavyList.slice(0, heavy) };
  }

  _walk(obj, rec, heavyList) {
    if (!obj.visible) return;
    rec.nodes++;
    if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) {
      if (obj.frustumCulled && !this._inFrustum(obj)) {
        rec.culled++;
      } else {
        const n = this._countObject(obj);
        if (n) {
          rec.calls += n.calls; rec.tris += n.tris;
          rec.meshes++; rec.instances += n.instances;
          if (heavyList && n.tris > 2000) {
            heavyList.push({
              name: obj.name || obj.type + '#' + obj.id,
              root: rec.name, tris: n.tris, calls: n.calls, instances: n.instances,
            });
          }
        }
      }
    }
    const kids = obj.children;
    for (let i = 0; i < kids.length; i++) this._walk(kids[i], rec, heavyList);
  }

  /** Frustum test, matching THREE.Frustum.intersectsObject including InstancedMesh. */
  _inFrustum(obj) {
    if (obj.isSprite) return true;
    if (obj.boundingSphere !== undefined) {
      if (obj.boundingSphere === null) obj.computeBoundingSphere?.();
      if (!obj.boundingSphere) return true;
      _sphere.copy(obj.boundingSphere);
    } else {
      const g = obj.geometry;
      if (!g) return true;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      if (!g.boundingSphere) return true;
      _sphere.copy(g.boundingSphere);
    }
    _sphere.applyMatrix4(obj.matrixWorld);
    return _frustum.intersectsSphere(_sphere);
  }

  /**
   * Draw calls and triangles a single object contributes to one render pass.
   * @return {{calls:number, tris:number, instances:number}|null}
   */
  _countObject(obj) {
    const g = obj.geometry;
    const m = obj.material;
    if (!g || !m) return null;
    const instances = obj.isInstancedMesh ? obj.count
      : (g.isInstancedBufferGeometry ? (g.instanceCount === Infinity ? 1 : g.instanceCount) : 1);
    if (instances <= 0) return null;

    const idx = g.index;
    const pos = g.attributes.position;
    const verts = idx ? idx.count : (pos ? pos.count : 0);
    if (!verts) return null;

    // Points and lines are draw calls but contribute no triangles.
    const perVert = obj.isMesh ? 3 : 0;

    let calls = 0, drawn = 0;
    if (Array.isArray(m) && g.groups.length > 0) {
      for (const grp of g.groups) {
        const gm = m[grp.materialIndex];
        if (!gm || gm.visible === false) continue;
        calls++;
        drawn += Math.min(grp.count, verts);
      }
    } else if (!Array.isArray(m)) {
      if (m.visible === false) return null;
      calls = 1;
      drawn = g.drawRange.count === Infinity ? verts : Math.min(g.drawRange.count, verts);
    } else {
      return null;
    }
    if (!calls) return null;
    // Instancing multiplies triangles, not draw calls — that is the whole point of it.
    return {
      calls,
      tris: perVert ? Math.floor(drawn / perVert) * instances : 0,
      instances,
    };
  }

  /* ---------------------------------------------------------------- shadow -- */

  /**
   * Measured shadow-map cost for the last frame, plus the cascade configuration
   * the lighting system is currently running.
   * @return {object}
   */
  shadowCost() {
    const sh = this._shadow;
    const lighting = this.ctx.get('lighting');
    const csm = lighting?.shadows;
    const out = {
      ms: +sh.msSm.toFixed(3),
      draws: Math.round(sh.callsSm),
      tris: Math.round(sh.trisSm),
      enabled: this.renderer.shadowMap.enabled,
      type: this.renderer.shadowMap.type,
    };
    if (csm) {
      out.cascades = csm.count;
      out.maps = csm.lights.map((l) => l.shadow.mapSize.x);
      out.maxDistance = csm.maxDistance;
      out.interval = Array.from(csm._interval || []);
      out.casting = csm.lights.filter((l) => l.castShadow).length;
      if (csm.debugInfo) out.debug = csm.debugInfo({});
    }
    return out;
  }

  /* ------------------------------------------------------------ visibility -- */

  /**
   * Backgrounded tabs throttle `requestAnimationFrame` to zero and the compositor
   * stops presenting, so a hidden tab has produced more than one phantom number on
   * this project already. Every measurement this profiler returns carries the flag,
   * and the rAF-based one refuses outright.
   * @return {{hidden:boolean, warning?:string}}
   */
  visibility() {
    if (typeof document === 'undefined' || !document.hidden) return { hidden: false };
    return {
      hidden: true,
      warning: 'Tab is backgrounded: rAF is throttled and the compositor is not ' +
        'presenting. Front the tab before quoting any number from this report.',
    };
  }

  /**
   * Real frame rate from the natural rAF loop — the only number that includes
   * presentation and vsync back-pressure. Refuses to answer from a hidden tab.
   * @param {number} [seconds=2]
   * @return {Promise<object>}
   */
  async measureLoopFps(seconds = 2) {
    const v = this.visibility();
    if (v.hidden) return { ...v, fps: null };
    const engine = this.engine;
    if (!engine._running) engine.start();
    const f0 = engine.time.frame, t0 = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const frames = engine.time.frame - f0;
    const elapsed = (performance.now() - t0) / 1000;
    const gl = this.renderer.getContext();
    return {
      hidden: false,
      fps: +(frames / elapsed).toFixed(1),
      ms: +(elapsed * 1000 / Math.max(frames, 1)).toFixed(2),
      frames,
      draws: engine.perf.drawCalls,
      tris: engine.perf.tris,
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  }

  /* ------------------------------------------------------------- measuring -- */

  /**
   * Block until the GPU has finished everything submitted so far.
   *
   * `gl.finish()` alone is NOT sufficient on Chrome: measured this way, frame cost
   * came out *lower* at 4K than at 1080p, which is only possible if the CPU was
   * running ahead of a queue that never drained. A one-pixel `readPixels` forces a
   * genuine round trip, and after adding it the numbers scale with pixel count as
   * they must. The active render target is saved and restored so this stays usable
   * between composer passes, where the chain's current target has to survive.
   *
   * A WebGL2 fence would be the textbook answer, but `clientWaitSync` may only be
   * called with a zero timeout from JS, so using one means spinning on a synchronous
   * IPC per poll — that costs more than it measures and can wedge the main thread.
   */
  _sync() {
    const r = this.renderer;
    const gl = r.getContext();
    const prev = r.getRenderTarget();
    r.setRenderTarget(null);
    gl.finish();
    const px = this._px || (this._px = new Uint8Array(4));
    try { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) { /* ignore */ }
    r.setRenderTarget(prev);
  }

  /**
   * GPU-synced milliseconds per composed frame. Renders only — no system updates —
   * so it isolates the render pipeline from gameplay CPU.
   * @param {number} [frames=16]
   * @return {number} ms/frame
   */
  measureRender(frames = 16, warm = 4) {
    const composer = this.engine.composer;
    const dt = 1 / 60;
    if (!composer) {
      const r = this.renderer, s = this.ctx.scene, c = this.ctx.camera;
      for (let i = 0; i < warm; i++) r.render(s, c);
      this._sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) r.render(s, c);
      this._sync();
      return (performance.now() - t0) / frames;
    }
    for (let i = 0; i < warm; i++) composer.render(dt);
    this._sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) composer.render(dt);
    this._sync();
    return (performance.now() - t0) / frames;
  }

  /**
   * GPU-synced milliseconds per *full* frame (systems + render), by stepping the
   * engine by hand. Use this when a suspect costs CPU as well as GPU.
   * @param {number} [frames=16]
   * @return {number} ms/frame
   */
  measureFrame(frames = 16, warm = 4) {
    const engine = this.engine;
    const wasRunning = engine._running;
    engine.stop();
    const realDelta = engine._clock.getDelta;
    engine._clock.getDelta = () => 1 / 60;
    try {
      for (let i = 0; i < warm; i++) engine.frame();
      this._sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) engine.frame();
      this._sync();
      return (performance.now() - t0) / frames;
    } finally {
      // Same hazard as CaptureHarness.step: engine.frame() runs every system, and a
      // throw used to strand the fixed-dt clock and a stopped rAF loop. start() stays
      // conditional on wasRunning so a stopped caller stays stopped.
      engine._clock.getDelta = realDelta;
      if (wasRunning) engine.start();
    }
  }

  /**
   * GPU milliseconds for every composer pass, by hard-syncing either side of each
   * pass's `render()`.
   *
   * WARNING - VALIDATED AS UNRELIABLE ON TILE-BASED GPUs (Apple Silicon).
   * Every mid-chain sync forces a render-pass/tile flush costing tens of ms, which lands
   * on whatever is being bracketed. Measured here: clouds reported 96.9 ms bracketed vs
   * 3.6 ms end-to-end; one cascade reported 1008 ms. Prefer `measurePrefix()`, which pays
   * a single sync per measurement so the overhead cancels in the subtraction.
   *
   * Kept because it is correct on immediate-mode desktop GPUs and when the timer-query
   * extension is present. It beats A/B-disabling passes because
   * it perturbs nothing: disabling TAA or SSR throws away temporal history and
   * changes what every later pass reads, so the difference you measure is not the
   * cost of the pass you removed. The trade is that syncing serialises the GPU, so
   * the per-pass numbers sum to slightly more than an un-synced frame.
   *
   * Shadow-map rendering happens inside `RenderPass`, so it is bracketed separately
   * and reported as its own row, already subtracted from `RenderPass`.
   *
   * @param {number} [frames=8]
   * @return {{ frameMs:number, syncedTotalMs:number, passes:Array }}
   */
  measurePasses(frames = 8, warm = 2) {
    const composer = this.engine.composer;
    if (!composer) return { frameMs: 0, syncedTotalMs: 0, passes: [] };
    const passes = [...composer.passes];
    const names = passes.map((p) => p.name || p.constructor.name);
    const acc = new Float64Array(passes.length);
    const origs = passes.map((p) => p.render);

    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const o = origs[i].bind(p);
      const self = this;
      p.render = function (...a) {
        self._sync();
        const t = performance.now();
        o(...a);
        self._sync();
        acc[i] += performance.now() - t;
      };
    }
    this._syncShadow = true;
    this._shadowSyncMs = 0;

    const dt = 1 / 60;
    for (let i = 0; i < warm; i++) composer.render(dt);
    acc.fill(0); this._shadowSyncMs = 0;
    this._sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      // The cascades only re-render when the lighting system marks them dirty, and
      // `composer.render()` never runs `lateUpdate`. Force them so the shadow row
      // reflects a worst-case frame rather than a stale map.
      this._markShadowsDirty();
      composer.render(dt);
    }
    const wall = (performance.now() - t0) / frames;

    for (let i = 0; i < passes.length; i++) passes[i].render = origs[i];
    this._syncShadow = false;

    const shadowMs = this._shadowSyncMs / frames;
    const out = [];
    let total = 0;
    for (let i = 0; i < passes.length; i++) {
      let ms = acc[i] / frames;
      if (names[i] === 'RenderPass') ms = Math.max(0, ms - shadowMs);
      total += ms;
      out.push({ name: names[i], ms: +ms.toFixed(2) });
    }
    out.push({ name: 'ShadowMaps(in RenderPass)', ms: +shadowMs.toFixed(2) });
    total += shadowMs;
    out.sort((a, b) => b.ms - a.ms);
    return { frameMs: +wall.toFixed(2), syncedTotalMs: +total.toFixed(2), passes: out };
  }

  /**
   * The shared CSM/probe uniform block. Every lit material holds these objects by
   * reference, so writing one changes the whole scene without a recompile — which is
   * what makes them usable as A/B toggles.
   * @return {object|null}
   */
  _csmUniforms() { return this._uniforms || null; }

  /**
   * Per-pass GPU cost by **prefix timing** — the most trustworthy instrument here.
   *
   * Render the chain but stub out every pass after index k, sync once, and time it.
   * The cost of pass k is then T(k) - T(k-1). Because each measurement contains
   * exactly one sync, the sync overhead is a constant that cancels in the
   * subtraction — unlike bracketing every pass, which pays ~13 syncs a frame and
   * inflates cheap passes beyond recognition.
   *
   * It also avoids the trap that makes A/B-disabling useless in this pipeline:
   * `pass.enabled = false` changes postprocessing's ping-pong and `needsSwap`
   * bookkeeping, so removing a pass can legitimately make the frame *slower*.
   * Stubbing `render` leaves the chain's structure and buffer rotation identical.
   *
   * Shadow maps only re-render when something marks `shadow.needsUpdate`, and
   * `composer.render()` never runs `lateUpdate` — so they are excluded by default and
   * measured separately via `shadows: true`.
   *
   * @param {{frames?:number, repeats?:number, shadows?:boolean}} [o]
   * @return {object}
   */
  measurePrefix({ frames = 6, repeats = 3, shadows = true } = {}) {
    const composer = this.engine.composer;
    if (!composer) return { passes: [] };
    const passes = [...composer.passes];
    const names = passes.map((p, i) => (p.name || p.constructor.name) + '#' + i);
    const origs = passes.map((p) => p.render);
    const noop = function () {};

    const stubFrom = (k) => {
      for (let i = 0; i < passes.length; i++) {
        passes[i].render = i <= k ? origs[i] : noop;
      }
    };
    const timeIt = (markShadows) => {
      let best = Infinity;
      for (let r = 0; r < repeats; r++) {
        for (let i = 0; i < 2; i++) { if (markShadows) this._markShadowsDirty(); composer.render(1 / 60); }
        this._sync();
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          if (markShadows) this._markShadowsDirty();
          composer.render(1 / 60);
        }
        this._sync();
        best = Math.min(best, (performance.now() - t0) / frames);
      }
      return best;
    };

    const cum = [];
    for (let k = -1; k < passes.length; k++) { stubFrom(k); cum.push(timeIt(false)); }

    let shadowMs = null;
    if (shadows) {
      // Whole chain, but forcing every cascade to re-render each frame.
      stubFrom(passes.length - 1);
      shadowMs = Math.max(0, timeIt(true) - cum[cum.length - 1]);
    }

    for (let i = 0; i < passes.length; i++) passes[i].render = origs[i];

    const out = [];
    for (let i = 0; i < passes.length; i++) {
      out.push({ name: names[i], ms: +Math.max(0, cum[i + 1] - cum[i]).toFixed(2) });
    }
    if (shadowMs !== null) out.push({ name: 'ShadowMaps(worst-case, every cascade)', ms: +shadowMs.toFixed(2) });
    const total = cum[cum.length - 1];
    out.sort((a, b) => b.ms - a.ms);
    return {
      emptyChainMs: +cum[0].toFixed(2),
      fullChainMs: +total.toFixed(2),
      withShadowsMs: shadowMs === null ? null : +(total + shadowMs).toFixed(2),
      passes: out,
      note: 'Prefix timing: cost(k) = T(k) - T(k-1). One sync per measurement, min of ' +
        repeats + ' repeats x ' + frames + ' frames.',
    };
  }

  /** Force every cascade to re-render on the next frame. */
  _markShadowsDirty() {
    const csm = this.ctx.get('lighting')?.shadows;
    if (!csm) return;
    for (const l of csm.lights) l.shadow.needsUpdate = true;
  }

  /**
   * GPU milliseconds for each individual shadow cascade.
   *
   * WARNING - VALIDATED AS UNRELIABLE ON TILE-BASED GPUs (Apple Silicon).
   * Every mid-chain sync forces a render-pass/tile flush costing tens of ms, which lands
   * on whatever is being bracketed. Measured here: clouds reported 96.9 ms bracketed vs
   * 3.6 ms end-to-end; one cascade reported 1008 ms. Prefer `measurePrefix()`, which pays
   * a single sync per measurement so the overhead cancels in the subtraction.
   *
   * Measured by letting exactly one cascade's `needsUpdate` through per frame, which
   * changes no shader define and therefore triggers no recompile. Toggling
   * `renderer.shadowMap.enabled` or a light's `castShadow` would recompile every
   * material in the scene and make the measurement meaningless.
   *
   * @param {number} [frames=6]
   * @return {{ cascades:Array, totalMs:number }}
   */
  measureCascades(frames = 6) {
    const csm = this.ctx.get('lighting')?.shadows;
    const composer = this.engine.composer;
    if (!csm || !composer) return { cascades: [], totalMs: 0 };
    const dt = 1 / 60;
    const out = [];
    let total = 0;
    this._syncShadow = true;

    for (let i = 0; i < csm.lights.length; i++) {
      // Warm the map so we are not measuring its first allocation.
      csm.lights.forEach((l, j) => { l.shadow.needsUpdate = j === i; });
      composer.render(dt);
      this._shadowSyncMs = 0;
      let draws = 0, tris = 0;
      for (let f = 0; f < frames; f++) {
        csm.lights.forEach((l, j) => { l.shadow.needsUpdate = j === i; });
        const c0 = this.renderer.info.render.calls, t0 = this.renderer.info.render.triangles;
        composer.render(dt);
        draws += this.renderer.info.render.calls - c0;
        tris += this.renderer.info.render.triangles - t0;
      }
      const ms = this._shadowSyncMs / frames;
      total += ms;
      out.push({
        cascade: i,
        mapSize: csm.lights[i].shadow.mapSize.x,
        everyNFrames: csm._interval ? csm._interval[i] : 1,
        radiusM: +(csm._radius ? csm._radius[i] : 0).toFixed(1),
        ms: +ms.toFixed(2),
        amortisedMs: +(ms / (csm._interval ? csm._interval[i] : 1)).toFixed(2),
      });
    }
    this._syncShadow = false;
    for (const l of csm.lights) l.shadow.needsUpdate = true;
    return { cascades: out, totalMs: +total.toFixed(2), amortisedMs: +out.reduce((a, c) => a + c.amortisedMs, 0).toFixed(2) };
  }

  /* ------------------------------------------------------------ init cost -- */

  /**
   * Break down a system's cold-boot cost, method by method.
   *
   * Init has already happened by the time anyone can ask, so re-running it on the
   * live instance is not an option. Instead a *second* instance of the same class is
   * built against a throwaway scene, with the named methods wrapped first. Nothing
   * the live game is using is touched, and the copy is disposed straight after.
   *
   * The wrap is on the instance, so no other agent's source is involved:
   *   await window.__boston.profiler.profileInit('props',
   *     ['_registerTypes', '_buildWires', 'populate'])
   *
   * @param {string} id                system id, as registered on the engine
   * @param {string[]} [methods]       instance methods to time individually
   * @return {Promise<object>} { id, totalMs, methods: {name: ms}, unattributedMs }
   */
  async profileInit(id, methods = []) {
    const live = this.ctx.get(id);
    if (!live) return { id, error: 'system not registered' };
    const Cls = live.constructor;

    const scene = new THREE.Scene();
    const ctx = new Proxy(this.ctx, {
      get: (t, k) => (k === 'scene' ? scene : t[k]),
    });

    const copy = new Cls();
    const times = {};
    for (const name of methods) {
      const fn = copy[name];
      if (typeof fn !== 'function') { times[name] = null; continue; }
      times[name] = 0;
      copy[name] = function (...a) {
        const t0 = performance.now();
        const r = fn.apply(this, a);
        times[name] += performance.now() - t0;
        return r;
      };
    }

    const t0 = performance.now();
    let error = null;
    try { await copy.init?.(ctx); } catch (e) { error = String(e?.message || e); }
    const totalMs = performance.now() - t0;
    let attributed = 0;
    for (const k in times) if (times[k]) attributed += times[k];
    try { copy.dispose?.(); } catch (e) { /* best effort */ }
    scene.clear();

    const out = { id, totalMs: +totalMs.toFixed(0), methods: {}, error };
    for (const k in times) out.methods[k] = times[k] === null ? null : +times[k].toFixed(0);
    out.unattributedMs = +(totalMs - attributed).toFixed(0);
    return out;
  }

  /* --------------------------------------------------------------- bisect -- */

  /**
   * A/B one toggle at a time and report the milliseconds each is worth.
   *
   * Nothing here edits another agent's source: systems are muted through the
   * wrappers this profiler already installed, scene subtrees are hidden with
   * `visible = false`, and composer passes use their own `enabled` flag.
   *
   * @param {object} [o]
   * @param {string[]} [o.systems]  system ids to mute, one at a time
   * @param {string[]} [o.subtrees] top-level `scene.children` names to hide
   * @param {string[]} [o.passes]   composer pass names to disable
   * @param {boolean}  [o.shadows]  also A/B the shadow map as a whole and per cascade
   * @param {number}   [o.frames]   frames averaged per measurement
   * @param {boolean}  [o.full]     measure whole frames instead of render-only
   * @return {Promise<object>}
   */
  async bisect({ systems = [], subtrees = [], passes = [], shadows = false,
    frames = 16, full = false } = {}) {
    const measure = () => (full ? this.measureFrame(frames) : this.measureRender(frames));
    const base = measure();
    const out = { baseMs: +base.toFixed(2), unit: full ? 'full-frame' : 'render-only', items: [] };
    const add = (kind, name, without, extra) => {
      out.items.push({
        kind, name,
        ms: +Math.max(0, base - without).toFixed(2),
        withoutMs: +without.toFixed(2),
        ...extra,
      });
    };

    for (const id of systems) {
      const rec = this.records.get(id);
      if (!rec) continue;
      rec.muted = true;
      add('system', id, measure());
      rec.muted = false;
    }

    for (const name of subtrees) {
      const node = this.ctx.scene.children.find((c) => c.name === name);
      if (!node) continue;
      const was = node.visible;
      node.visible = false;
      add('subtree', name, measure());
      node.visible = was;
    }

    const composer = this.engine.composer;
    if (composer) {
      for (const name of passes) {
        const p = composer.passes.find((q) => (q.name || q.constructor.name) === name);
        if (!p || p.enabled === false) continue;
        p.enabled = false;
        add('pass', name, measure());
        p.enabled = true;
      }
    }

    if (shadows) {
      // NB: `renderer.shadowMap.enabled` and `light.castShadow` are deliberately NOT
      // used as A/B toggles. Both change shader defines, so flipping either recompiles
      // every material in the scene — tens of seconds of stall that lands inside the
      // very measurement it is meant to inform. Shadow render cost comes from the
      // sync-bracketed hook (measureCascades); shadow *sampling* cost is A/B'd here
      // through uniforms only, which never touch the program cache.
      const u = this._csmUniforms();
      if (u) {
        const taps = u.bostonPcfTaps.value, pcss = u.bostonPcss.value;
        u.bostonPcss.value = 0;
        add('shadow', 'pcss:off', measure(), { note: 'contact hardening, cascades 0-1' });
        u.bostonPcss.value = pcss;
        for (const t of [8, 4, 1]) {
          if (t >= taps) continue;
          u.bostonPcfTaps.value = t;
          add('shadow', `pcfTaps:${t}`, measure(), { from: taps });
          u.bostonPcfTaps.value = taps;
        }
        u.bostonPcfTaps.value = 1; u.bostonPcss.value = 0;
        add('shadow', 'filter:minimal', measure(), { note: '1 tap, no PCSS' });
        u.bostonPcfTaps.value = taps; u.bostonPcss.value = pcss;
      }
      const probe = u?.bostonProbeMix;
      if (probe && probe.value > 0) {
        probe.value = 0;
        add('shadow', 'lightProbes:off', measure(), { note: 'irradiance volume sampling' });
        probe.value = 1;
      }
    }

    out.items.sort((a, b) => b.ms - a.ms);
    measure();
    return out;
  }

  /* ---------------------------------------------------------------- report -- */

  /**
   * Full structured report. Safe to `await` from the capture harness after a shot.
   *
   * @param {object} [o]
   * @param {boolean} [o.deep=true]   run the A/B bisector (a second or two)
   * @param {number}  [o.frames=16]   frames averaged per A/B measurement
   * @param {string}  [o.shot]        label carried through into the JSON
   * @return {Promise<object>}
   */
  async profile({ deep = true, frames = 16, shot = null, heavy = 12 } = {}) {
    const engine = this.engine;
    const r = this.renderer;
    const gl = r.getContext();
    const s = engine.settings;
    const composer = engine.composer;

    const scene = this.walkScene({ heavy });
    const shadow = this.shadowCost();

    const vis = this.visibility();
    const report = {
      shot,
      hidden: vis.hidden,
      warning: vis.warning,
      meta: {
        preset: s.preset,
        timeOfDay: +engine.time.timeOfDay.toFixed(2),
        weather: s.weather,
        css: [Math.round(r.domElement.clientWidth), Math.round(r.domElement.clientHeight)],
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        pixelRatio: r.getPixelRatio(),
        pixelRatioCap: s.pixelRatioCap,
        megapixels: +(gl.drawingBufferWidth * gl.drawingBufferHeight / 1e6).toFixed(2),
        drawDist: s.drawDist,
        camera: [+engine.camera.position.x.toFixed(1), +engine.camera.position.y.toFixed(1),
          +engine.camera.position.z.toFixed(1)],
      },
      frame: {
        fps: +engine.perf.fps.toFixed(1),
        loopMs: +engine.perf.ms.toFixed(2),
        wrappedFrameMs: +this._frameMs.toFixed(2),
        cpuSystemsMs: +this.systemTotal().toFixed(3),
      },
      budget: {
        draws: engine.perf.drawCalls, drawsLimit: 1200,
        tris: engine.perf.tris, trisLimit: 3.5e6,
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
        programs: r.info.programs?.length ?? 0,
      },
      cpu: this.systemCost(),
      shadow,
      scene: {
        cameraPass: scene.total,
        subtrees: scene.subtrees,
        heaviestMeshes: scene.heavy,
      },
      passes: composer
        ? composer.passes.map((p) => ({
          name: p.name || p.constructor.name,
          enabled: p.enabled !== false,
        }))
        : [],
      gpu: { source: this.gpuTimer.available ? 'timer-query' : 'unavailable',
        timings: this.gpuTimer.available ? this.gpuTimer.report() : null },
    };

    if (!deep) return report;

    // measureRender() does NOT include the shadow maps: `composer.render()` never runs
    // `lateUpdate`, so nothing re-marks `shadow.needsUpdate` and three skips them.
    // That is exactly why the two numbers are reported separately.
    report.frame.loop = await this.measureLoopFps(1.5);
    report.frame.syncedRenderMs = +this.measureRender(frames).toFixed(2);
    report.frame.syncedFrameMs = +this.measureFrame(frames).toFixed(2);
    report.gpu.passes = this.measurePasses(Math.max(4, frames >> 1));
    report.gpu.cascades = this.measureCascades(Math.max(4, frames >> 2));
    report.bisect = await this.bisect({ frames: Math.max(4, frames >> 1), shadows: true });
    return report;
  }

  /* --------------------------------------------------------------- teardown */

  dispose() {
    for (const r of this.records.values()) {
      for (const phase in r.orig) r.sys[phase] = r.orig[phase];
    }
    this.records.clear();
    if (this._origFrame) this.engine.frame = this._origFrame;
    this._restoreShadow?.();
    if (this._ownsTimer) this.gpuTimer?.dispose();
    this._installed = false;
    const api = window.__boston;
    if (api?.profiler === this) {
      delete api.profiler;
      if (api.profilePasses) { api.profile = api.profilePasses; delete api.profilePasses; }
      delete api.profileFast; delete api.sceneCost;
      delete api.systemCost; delete api.bisect;
    }
  }
}
