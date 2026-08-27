import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass,
  SMAAEffect, ToneMappingEffect, ToneMappingMode,
  EffectAttribute,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

import ColorGrade from './ColorGrade.js';
import AutoExposurePass from './effects/AutoExposurePass.js';
import ExposureEffect from './effects/ExposureEffect.js';
import GradeEffect from './effects/GradeEffect.js';
import FilmGrainEffect from './effects/FilmGrainEffect.js';
import LensFinalEffect from './effects/LensFinalEffect.js';
import LensPass from './effects/LensPass.js';
import LensCompositeEffect from './effects/LensCompositeEffect.js';
import BokehDofPass from './effects/BokehDofPass.js';
import FrameStatePass from './effects/FrameStatePass.js';
import VelocityPass from './effects/VelocityPass.js';
import TAAPass from './effects/TAAPass.js';
import MotionBlurPass from './effects/MotionBlurPass.js';
import SSRPass from './effects/SSRPass.js';
import GpuTimer from './effects/GpuTimer.js';

/**
 * What each quality preset is actually allowed to run, and how hard.
 *
 * Measured on Apple Silicon at 1920x1080, this is what fits: TAA + DOF + motion blur
 * is roughly 6 ms of post, which leaves the scene ~10 ms. Adding SSR costs another
 * 6-10 ms in the rain, which is why it lives on `ultra` only regardless of what
 * Settings.js asks for. `low` is deliberately post-free apart from bloom and the
 * grade, both of which are close to free and are what make the frame look authored.
 */
const BUDGET = {
  low: {
    pixels: 1280 * 720,   // 0.92 Mpx internal resolution
    ao: false, taa: false, dof: false, motionBlur: false, ssr: false,
    aoSamples: 8, aoDenoise: 2, bloomLevels: 4, streaks: false,
    dofRings: 2, dofMaxCoC: 8, mbSamples: 6,
    ssrSteps: 12, ssrRefine: 3, ssrDistance: 60,
  },
  medium: {
    pixels: 1600 * 900,   // 1.44 Mpx internal resolution
    ao: true, taa: false, dof: false, motionBlur: false, ssr: false,
    aoSamples: 8, aoDenoise: 4, bloomLevels: 5, streaks: true,
    dofRings: 2, dofMaxCoC: 8, mbSamples: 6,
    ssrSteps: 14, ssrRefine: 3, ssrDistance: 80,
  },
  high: {
    pixels: 1920 * 1080,   // 2.07 Mpx internal resolution
    ao: true, taa: true, dof: true, motionBlur: true, ssr: false,
    aoSamples: 12, aoDenoise: 6, bloomLevels: 6, streaks: true,
    dofRings: 3, dofMaxCoC: 10, mbSamples: 8,
    ssrSteps: 16, ssrRefine: 4, ssrDistance: 110,
  },
  ultra: {
    pixels: 2560 * 1440,   // 3.69 Mpx internal resolution
    ao: true, taa: true, dof: true, motionBlur: true, ssr: true,
    aoSamples: 16, aoDenoise: 8, bloomLevels: 6, streaks: true,
    dofRings: 4, dofMaxCoC: 13, mbSamples: 14,
    ssrSteps: 24, ssrRefine: 5, ssrDistance: 150,
  },
};

/**
 * Owns the WebGL renderer and the entire HDR post stack.
 * NOTHING else in the codebase may call renderer.render().
 *
 * Chain:
 *   FrameState -> Render -> N8AO -> AutoExposure -> [Velocity] -> [SSR] -> [TAA]
 *              -> [MotionBlur] -> [DOF] -> [Lens/bloom]
 *              -> [LensComposite, Exposure, AGX ToneMap, Grade, Grain]
 *              -> [SMAA] -> [CA + Sharpen]
 *
 * postprocessing's own SSAOEffect is deliberately NOT used: at city scale it reports
 * full occlusion and, MULTIPLY-blended, takes the whole frame to black.
 */
export default class RenderPipeline {
  static id = 'render';
  static label = 'Render pipeline';
  static deps = [];

  async init(ctx) {
    const s = ctx.settings;
    const renderer = new THREE.WebGLRenderer({
      antialias: false,               // AA runs in the composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;   // the composer tonemaps
    renderer.toneMappingExposure = 1.0;           // exposure lives in ExposureEffect
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;              // reset manually, once per frame
    ctx.engine.container.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    ctx.engine.renderer = renderer;
    this.renderer = renderer;
    this._applyResolution(ctx);

    const composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    ctx.engine.composer = composer;
    this.composer = composer;

    const scene = ctx.scene, camera = ctx.camera;
    this.renderPass = new RenderPass(scene, camera);

    // --- Ambient occlusion (N8AO handles large outdoor scenes correctly) ---
    this.ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
    const ao = this.ao.configuration;
    ao.aoRadius = 2.6;              // metres — tuned for street-level geometry
    ao.distanceFalloff = 1.1;
    ao.intensity = 2.8;
    ao.aoSamples = 16;
    ao.denoiseSamples = 8;
    ao.denoiseRadius = 12;
    ao.screenSpaceRadius = false;
    ao.halfRes = true;
    ao.color = new THREE.Color(0x0a1018);

    // --- Grading ---
    this.grade = new ColorGrade();
    this.autoExposure = new AutoExposurePass();
    this.exposure = new ExposureEffect();
    this.gradeEffect = new GradeEffect();
    this.grain = new FilmGrainEffect();
    this.lensFinal = new LensFinalEffect();
    this.exposure.luminanceTexture = this.autoExposure.texture;
    this.grain.luminanceTexture = this.autoExposure.texture;
    this.lensFinal.luminanceTexture = this.autoExposure.texture;

    // --- Lens response ---
    this.lens = new LensPass({ levels: 6, streaks: true });
    this.lens.threshold = 1.0;
    this.lens.softKnee = 0.62;
    this.lens.radius = 0.85;
    this.lensComposite = new LensCompositeEffect();

    // --- Temporal stack ---
    this.frameState = new FrameStatePass(camera);
    this.velocity = new VelocityPass(camera, this.frameState);
    this.taa = new TAAPass(camera, this.frameState, this.velocity);
    this.motionBlur = new MotionBlurPass(this.velocity);
    this.ssr = new SSRPass(camera, this.frameState, this.velocity);
    this.gpuTimer = new GpuTimer(renderer);
    this._instrumented = new WeakSet();

    // --- Effects ---
    this.dof = new BokehDofPass(camera);
    this.tone = new ToneMappingEffect({
      mode: ToneMappingMode.AGX, whitePoint: 6.0, middleGrey: 0.45,
    });
    this.smaa = new SMAAEffect();

    /** Tunables the rest of the pipeline reads every frame. */
    this.options = {
      exposureKey: 0.20,      // metered scene luminance is mapped to this middle grey
      autoExposure: true,
      minEV: -0.6,
      maxEV: 15.5,
      vignette: 0.55,
      // Shadow recovery: 1.0 = off. Raised only if the HDR probe shows real detail
      // sitting below the point where the tone curve clips it.
      shadowContrast: 1.0,
      shadowToeStops: 7.0,
      grain: 0.015,
      aberration: 1.15,
      sharpen: 0.0,
      bloomCore: 0.42,        // tight PSF lobe
      bloomWide: 0.55,        // broad veiling glare
      streak: 0.10,
      dirt: 0.5,
      taa: true,              // overridden per preset in _rebuild
      shutterAngle: 180,
      motionBlurMax: 40,
      ssrIntensity: 1.0,
      // Dry surfaces get no screen-space reflection. A Fresnel-only sheen on dry brick
      // is barely visible and would force every non-sky pixel to march a ray, which is
      // the single most expensive thing this stage can do. Rain is what SSR is for.
      dryGloss: 0.0,
    };

    this._rebuild(ctx);
    this._lastTod = ctx.time.timeOfDay;

    ctx.bus.on('resize', ({ w, h }) => {
      this._applyResolution(ctx, w, h);
      composer.setSize(w, h);
      // Do NOT call ao.setSize here: EffectComposer.setSize already forwards the
      // drawing-buffer size to every pass. Passing CSS pixels afterwards would make
      // N8AO render at the wrong resolution.
    });
    ctx.bus.on('quality:changed', () => {
      this._applyResolution(ctx);
      this.composer.setSize(this._cssW, this._cssH);
      this._rebuild(ctx);
      this.autoExposure.reset();
    });
    // Expose the dev handles on the capture harness once it exists, so the visual
    // critic loop can profile and A/B the grade without reaching into the engine.
    ctx.bus.on('engine:ready', () => {
      const api = window.__boston;
      if (!api) return;
      api.render = this;
      api.profile = (n) => this.profile(n);
      api.gpuTimings = () => this.gpuTimer.report();
      api.gradeIntensity = (v) => { this.grade.intensity = v; };
      api.probeLuminance = () => this.autoExposure.probeLuminance(this.renderer);
    });
    ctx.bus.on('weather:set', () => { this.autoExposure.reset(); this.taa.reset(); });
  }

  /**
   * Rebuild the pass list for the current quality settings. postprocessing merges
   * non-convolution effects into one pass; each convolution effect needs its own.
   */
  _rebuild(ctx) {
    const s = ctx.settings;
    // Other systems (the atmosphere stage, for one) insert their own HDR passes into
    // this composer. A rebuild must not silently delete them, so remember anything we
    // do not own and re-insert it in the scene stage where it was.
    const mine = new Set([this.frameState, this.renderPass, this.ao, this.autoExposure,
      this.velocity, this.ssr, this.taa, this.motionBlur, this.dof, this.lens,
      ...(this._owned || [])]);
    const foreign = this.composer.passes.filter((p) => !mine.has(p));
    for (const p of [...this.composer.passes]) this.composer.removePass(p);
    for (const p of this._owned || []) this._releasePass(p);
    this._owned = [];

    const isConv = (e) => (e.getAttributes() & EffectAttribute.CONVOLUTION) !== 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const pass = new EffectPass(ctx.camera, ...batch);
      this.composer.addPass(pass);
      this._owned.push(pass);
      batch = [];
    };
    /** Queue an effect; convolution effects are isolated into their own pass. */
    const fx = (e) => {
      // A convolution effect samples the *pass input*, not the running result, so it
      // must start a new pass. Non-convolution effects can ride along behind it —
      // that is what lets grain sit after anti-aliasing for free.
      if (isConv(e)) flush();
      batch.push(e);
    };
    /** Insert a standalone pass, closing any effect batch first so order is preserved. */
    const pass = (p) => { flush(); this.composer.addPass(p); };

    const q = BUDGET[s.preset] || BUDGET.high;

    // The preset flags in Settings.js are a request, not a promise. This stage owns
    // the frame budget, so it may only ever *narrow* them — SSR is the clearest case:
    // Settings asks for it on `high`, but a half-res march plus refinement does not
    // fit inside 16.6 ms alongside TAA, DOF and motion blur, so it is held back to
    // `ultra`. Nothing here can turn a feature the user disabled back on.
    this._taaOn = (s.taa ?? true) && q.taa;
    this._motionBlurOn = !!s.motionBlur && q.motionBlur;
    this._ssrOn = !!s.ssr && q.ssr;
    this._dofOn = !!s.dof && q.dof;
    this._bloomOn = !!s.bloom;
    this._aoOn = !!s.ssao && q.ao;

    this.frameState.enabledJitter = this._taaOn;
    if (!this._taaOn) this.frameState.clearJitter();

    pass(this.frameState);
    pass(this.renderPass);
    if (this._aoOn) {
      const ao = this.ao.configuration;
      ao.aoSamples = q.aoSamples;
      ao.denoiseSamples = q.aoDenoise;
      ao.denoiseRadius = q.aoDenoise * 1.5;
      pass(this.ao);
    }
    // Foreign scene-stage passes (aerial perspective, volumetrics) belong here: on
    // the HDR scene, before anything temporal or optical touches it.
    for (const p of foreign) pass(p);
    pass(this.autoExposure);

    if (this._taaOn || this._motionBlurOn || this._ssrOn) pass(this.velocity);
    if (this._ssrOn) {
      this.ssr.steps = q.ssrSteps;
      this.ssr.refineSteps = q.ssrRefine;
      this.ssr.maxDistance = q.ssrDistance;
      this.ssr.reset();
      pass(this.ssr);
    }
    if (this._taaOn) { this.taa.reset(); pass(this.taa); }
    if (this._motionBlurOn) {
      this.motionBlur.samples = q.mbSamples;
      pass(this.motionBlur);
    }

    if (this._dofOn) {
      // The gather is the expensive part, so the ring count is the dial that matters.
      this.dof.maxCoC = q.dofMaxCoC;
      this.dof.rings = q.dofRings;
      pass(this.dof);
    }

    if (this._bloomOn) {
      this.lens.streaksEnabled = q.streaks;
      this.lens.activeLevels = q.bloomLevels;
      pass(this.lens);
      fx(this.lensComposite);
    }

    fx(this.exposure); fx(this.tone); fx(this.gradeEffect);
    // TAA already resolves edges; stacking SMAA on top only costs two passes and
    // softens the result further. Recover the temporal softness with the sharpener
    // in the final pass instead.
    if (!this._taaOn) fx(this.smaa);
    this.options.sharpen = this._taaOn ? 0.34 : 0.0;
    fx(this.lensFinal); fx(this.grain);
    flush();

    // The A/B profiler disables passes to measure them; make sure a rebuild always
    // leaves everything armed.
    for (const p of this.composer.passes) p.enabled = true;
    this._passNames = this.composer.passes.map((p) => p.name || p.constructor.name);
    for (const p of this.composer.passes) this._instrument(p);
    console.info('[render] ' + this._passNames.join(' -> '));
  }

  /**
   * Free an EffectPass without destroying the effects inside it.
   *
   * EffectPass.dispose() also disposes every effect it holds, which would tear down
   * shared, long-lived instances (SMAA lookup textures, bloom mip chains) every time
   * the quality preset changes. Drop the change listeners and free only the pass's own
   * material instead.
   */
  _releasePass(pass) {
    if (pass.effects && pass.listener) {
      for (const e of pass.effects) e.removeEventListener('change', pass.listener);
    }
    pass.fullscreenMaterial?.dispose();
  }

  /**
   * Pick the device pixel ratio from a *pixel budget*, not just a ratio cap.
   *
   * This is the single biggest lever in the whole stage. `pixelRatioCap: 1.5` sounds
   * modest until the window is already 1920x1080, at which point it silently renders
   * 2880x1620 — 2.25x the pixels the 60 fps budget was written against, and every
   * full-screen pass pays for all of them. Deriving the ratio from a target pixel
   * count instead means the internal resolution is the same on a small window and a
   * large one, which is what makes the budget mean anything.
   *
   * @param {object} ctx
   * @param {number} [w] - CSS width; defaults to the container
   * @param {number} [h] - CSS height
   */
  _applyResolution(ctx, w, h) {
    const c = ctx.engine.container;
    w = w || c.clientWidth || window.innerWidth;
    h = h || c.clientHeight || window.innerHeight;
    this._cssW = w; this._cssH = h;
    const q = BUDGET[ctx.settings.preset] || BUDGET.high;
    const byBudget = Math.sqrt(q.pixels / Math.max(w * h, 1));
    const r = Math.max(0.5, Math.min(window.devicePixelRatio, ctx.settings.pixelRatioCap, byBudget));
    this.renderer.setPixelRatio(r);
    this.pixelRatio = r;
  }

  /**
   * Lock focus to a specific distance, in metres. Pass -1 (the default) to return to
   * autofocus on whatever is in the centre of frame. The gameplay agent should call
   * this with the distance to the player's aim target.
   *
   * @param {number} metres
   */
  setFocusTarget(metres) { this.dof.focusOverride = metres; }

  /** Wrap a pass's render() so the GPU timer can bracket it. Idempotent. */
  _instrument(pass) {
    if (!this.gpuTimer.available || this._instrumented.has(pass)) return;
    this._instrumented.add(pass);
    const name = pass.name || pass.constructor.name;
    const original = pass.render.bind(pass);
    const timer = this.gpuTimer;
    pass.render = function (...args) {
      const timed = timer.begin(name);
      original(...args);
      if (timed) timer.end();
    };
  }

  /**
   * Cost of every stage, in milliseconds.
   *
   * Prefers real GPU timer queries. Chrome usually withholds
   * EXT_disjoint_timer_query_webgl2, so the fallback disables one pass at a time and
   * measures the difference in wall-clock frame time with a hard GPU sync either side.
   * That is intrusive — call it from a dev tool, never per frame.
   *
   * @param {number} [frames=20] - frames averaged per measurement
   * @return {Promise<Object>} { total, <passName>: ms, ... }
   */
  async profile(frames = 20) {
    if (this.gpuTimer.available) {
      const t = this.gpuTimer.report();
      t.total = Object.values(t).reduce((a, b) => a + b, 0);
      t.source = 'timer-query';
      return t;
    }
    const gl = this.renderer.getContext();
    const composer = this.composer;
    const measure = () => {
      for (let i = 0; i < 4; i++) composer.render(1 / 60);
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) composer.render(1 / 60);
      gl.finish();
      return (performance.now() - t0) / frames;
    };
    const base = measure();
    const out = { total: +base.toFixed(3), source: 'ab-sync' };
    for (const p of [...composer.passes]) {
      if (p === this.renderPass || p === this.frameState) continue;
      p.enabled = false;
      const without = measure();
      p.enabled = true;
      out[p.name || p.constructor.name] = +Math.max(0, base - without).toFixed(3);
    }
    measure();   // leave the buffers in a consistent state
    return out;
  }

  update(dt, ctx) {
    const s = ctx.settings;
    const o = this.options;

    // A hard cut in the world clock (capture harness, fast-forward) must not be
    // smoothed through — snap the adaptation instead of crossfading for 10 seconds.
    const tod = ctx.time.timeOfDay;
    let cut = Math.abs(tod - this._lastTod) > 0.35;
    this._lastTod = tod;

    // A camera teleport (capture harness, cutscene, fast travel) invalidates every
    // temporal buffer at once. 20 m in a single frame is far beyond anything a
    // vehicle can do at 60 fps, so this cannot false-trigger during normal driving.
    const cp = ctx.camera.position;
    if (this._lastCam) {
      const dx = cp.x - this._lastCam.x, dy = cp.y - this._lastCam.y, dz = cp.z - this._lastCam.z;
      if (dx * dx + dy * dy + dz * dz > 400) cut = true;
    }
    (this._lastCam ||= new THREE.Vector3()).copy(cp);
    if (cut) {
      this.autoExposure.reset(); this.dof.reset();
      this.taa.reset(); this.ssr.reset();
    }
    this.dof.setDeltaTime(dt);
    if (this._motionBlurOn) {
      this.motionBlur.shutterAngle = o.shutterAngle;
      this.motionBlur.maxBlurPixels = o.motionBlurMax;
    }
    if (this._ssrOn) {
      const wet = ctx.assets?.wetness ?? 0;
      this.ssr.wetness = wet;
      this.ssr.baseGloss = o.dryGloss;
      this.ssr.intensity = o.ssrIntensity;
      // Nothing reflective in frame means nothing to trace. Skipping the whole pass
      // makes SSR cost literally zero in clear weather instead of paying for a march
      // that every pixel discards.
      const worthIt = wet * o.ssrIntensity > 0.02 || o.dryGloss > 0.02;
      if (this.ssr.enabled !== worthIt) {
        this.ssr.enabled = worthIt;
        if (worthIt) this.ssr.reset();
      }
    }
    this.gpuTimer.beginFrame(this._passNames);

    const look = this.grade.evaluate(tod, s.weather, ctx.assets?.wetness ?? 0);

    this.autoExposure.setDeltaTime(dt);
    this.autoExposure.setEVRange(o.minEV, o.maxEV);
    const lumTex = this.autoExposure.texture;
    this.exposure.luminanceTexture = lumTex;
    this.grain.luminanceTexture = lumTex;
    this.lensFinal.luminanceTexture = lumTex;

    this.exposure.setExposure(o.exposureKey, s.exposure, look.exposureEV,
      o.autoExposure ? 1 : 0);
    const wb = this.grade.wbGains;
    this.exposure.setWhiteBalance(wb[0], wb[1], wb[2]);
    this.exposure.setLens(o.vignette * look.vignette, 0.42, 0.14);
    this.exposure.setShadowRecovery(o.shadowContrast, o.shadowToeStops);

    this.gradeEffect.applyLook(look);
    this.grain.setAmount(o.grain * look.grain);
    this.lensFinal.aberration = o.aberration;
    this.lensFinal.sharpness = o.sharpen;

    if (this._bloomOn) {
      this.lens.setExposure(o.exposureKey, s.exposure, look.exposureEV,
        o.autoExposure ? 1 : 0, lumTex);
      this.lensComposite.setTextures(
        this.lens.coreTexture, this.lens.wideTexture, this.lens.streakTexture);
      this.lensComposite.setWeights(
        o.bloomCore * look.bloomScale,
        o.bloomWide * look.bloomScale,
        this.lens._streaksEnabled ? o.streak * look.streakScale : 0,
        o.dirt);
      this.lensComposite.setTints(look.bloomTint, look.streakTint);
    }
  }

  dispose() {
    for (const p of this._owned || []) p.dispose?.();
    for (const e of [this.exposure, this.gradeEffect, this.grain, this.lensFinal,
                     this.lensComposite]) e?.dispose?.();
    this.autoExposure?.dispose();
    this.lens?.dispose();
    this.dof?.dispose();
    this.taa?.dispose();
    this.motionBlur?.dispose();
    this.velocity?.dispose();
    this.ssr?.dispose();
    this.gpuTimer?.dispose();
    this.ao?.dispose?.();
    this.composer?.dispose();
    this.renderer?.dispose();
  }
}
