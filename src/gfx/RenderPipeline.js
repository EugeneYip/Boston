import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass,
  SMAAEffect, ToneMappingEffect, ToneMappingMode, Pass,
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
 * Measured at 1920x1080 on Apple Silicon, street_level. Two things dominate and both
 * are counter-intuitive:
 *
 *  1. On this tile-based driver the *number of render-target binds* costs more than
 *     the shading inside them — roughly 0.2-0.3 ms each. So the lever that matters is
 *     pass count, not sample count. That is why bloom builds its pyramid from quarter
 *     resolution and why the anamorphic streak chain is an `ultra` luxury.
 *  2. The scene render itself is well over the whole 16.6 ms frame budget, so post has
 *     to fit in what is left rather than in a fair share. `high` is therefore the
 *     cheapest arrangement that still looks authored: temporal AA, a graded image and
 *     a lens response. Depth of field, motion blur and screen-space reflections are
 *     real features, they are just not 60 fps features on this hardware yet, so they
 *     live on `ultra` until the scene comes down.
 *
 * Settings.js asks for SSR, DOF and motion blur on `high`; this table narrows that.
 * It can only ever take features away, never add them back.
 */
const BUDGET = {
  low: {
    pixels: 1280 * 720,
    ao: false, taa: false, dof: false, motionBlur: false, ssr: false,
    aoSamples: 4, aoDenoise: 2, bloomLevels: 3, streaks: false,
    dofRings: 2, dofMaxCoC: 8, mbSamples: 6,
    ssrSteps: 12, ssrRefine: 3, ssrDistance: 60,
  },
  medium: {
    pixels: 1600 * 900,
    ao: true, taa: false, dof: false, motionBlur: false, ssr: false,
    aoSamples: 6, aoDenoise: 2, bloomLevels: 4, streaks: false,
    dofRings: 2, dofMaxCoC: 8, mbSamples: 6,
    ssrSteps: 14, ssrRefine: 3, ssrDistance: 80,
  },
  high: {
    pixels: 1920 * 1080,
    ao: true, taa: true, dof: false, motionBlur: false, ssr: false,
    // AO is the one place on `high` where sample count still buys measurable time
    // (PERF_REPORT §9 row 7). 6/3 keeps contact shadows at street level — the AO is
    // half-res and denoised, so the sample count mostly controls noise, not extent.
    aoSamples: 6, aoDenoise: 3, bloomLevels: 4, streaks: false,
    dofRings: 3, dofMaxCoC: 10, mbSamples: 8,
    ssrSteps: 16, ssrRefine: 4, ssrDistance: 110,
  },
  ultra: {
    pixels: 2560 * 1440,
    ao: true, taa: true, dof: true, motionBlur: true, ssr: true,
    aoSamples: 12, aoDenoise: 6, bloomLevels: 5, streaks: true,
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
    // It inherits postprocessing's base name, "Pass", which is useless in a profile.
    this.ao.name = 'N8AOPostPass';
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
      // Clamp window for the *metered* scene luminance, in EV100
      // (AutoExposurePass converts: log2(L) = EV100 - 3).
      //
      // This used to be -0.6, which put the floor at log2(L) = -3.6 — brighter than
      // most of the game. Measured metered log2 luminance across all eight review
      // shots: overcast_wide -1.45, hero_skyline -2.01, bridge -2.28, downtown_dusk
      // -4.30, street_level -4.74, golden_hour -4.89, rain_street -5.71, night_neon
      // -8.20. Everything from dusk downwards sat on the floor, so the adaptation had
      // nothing to integrate and exposure was pinned at 0.20/2^-3.6 = 2.42 at every
      // hour of the day. That is why night read as near-black: the metering could not
      // see it, so nothing opened up.
      //
      // -8.5 puts the floor at log2(L) = -11.5, about 3.3 stops below the darkest shot
      // in the game, so it still guards against a fully black frame opening the
      // aperture to infinity without ever clamping a real scene.
      minEV: -8.5,
      maxEV: 15.5,
      // --- partial adaptation ---------------------------------------------------
      // With the clamp fixed the meter adapts over the full 4+ stop day/night range,
      // and a meter with unit gain maps every one of those hours onto the same middle
      // grey. Measured after the clamp fix and before this: `night_neon` at 22:00 came
      // out at frame p50 100/255 — the same value as `street_level` at 09:30. Correct
      // metering, wrong picture.
      //
      // `meterGainDown` is how many stops of exposure the meter is allowed to open per
      // stop the scene darkens *below* `meterPivot`. Above the pivot the gain is 1, so
      // a bright sky still stops all the way down and cannot clip.
      //
      // 0.55 puts night_neon ~1.9 stops below its fully-adapted exposure while moving
      // the four daylight shots by less than a quarter of a stop.
      //
      // The second reason this matters: at unit gain the exposure stage exactly cancels
      // anything the lighting stage does, so `NIGHT_SKY` and friends have no visible
      // effect and get pushed to non-physical values chasing one. At 0.55 a two-stop
      // change in scene light still moves the frame by ~0.9 stops.
      meterPivot: -2.2,       // metered log2 luminance exposed exactly on key
      meterGainDown: 0.55,    // 1.0 = fully adapting (the old behaviour)
      vignette: 0.55,
      // Shadow recovery: 1.0 = off, lower recovers more. This was off on the grounds
      // that the HDR probe showed nothing below the clip point. It was off because the
      // *probe* was reading a frozen meter: with the clamp fixed, `probeLuminance()` at
      // dusk reports scene p05 at -7.36 against an adapted key of -3.11, i.e. **4.2
      // stops of real, rendered detail** sitting under a curve that clips at ~5.5.
      //
      // Measured on the dusk downtown framing, same frame, toe off vs 0.70:
      //   pure-black pixels 7.45% -> 2.6%, p05 0.4 -> 4.1,
      //   while p50/p90/p99 move by less than 1.5/255 each.
      // That is the whole point of a toe rather than a lifted black point: the streets
      // between the towers come back without the highlights going milky.
      //
      // `shadowToeStops` is a *width*, not a depth: widening it to 9 spreads the same
      // compression over more stops and therefore lifts the deepest shadows **less**
      // (night_neon pure-black 5.4% at 7 stops, 8.9% at 9). Tune the contrast, not the
      // width.
      shadowContrast: 0.62,
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
      // Every temporal buffer just changed shape or scale. The capture harness steps
      // only a handful of frames after a resize, so anything that needs to converge
      // has to be snapped, not eased, or every agent's screenshot reads as broken.
      this.autoExposure.reset();
      this.dof.reset();
      this.taa.reset();
      this.ssr.reset();
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
      api.validate = () => this.validate();
      api.gpuProfile = (on) => this.gpuTimer.setEnabled(on !== false);
      // Give the other systems a beat to finish inserting their own passes, then
      // prove the chain still produces an image.
      setTimeout(() => {
        const v = this.validate();
        if (v.ok) console.info('[render] chain validated, no black-out passes');
      }, 1500);
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
      // Every EffectPass otherwise reports as the string "EffectPass". GpuTimer keys
      // its round-robin on the pass name, so two identically-named passes fold into a
      // single averaged entry and the most expensive stage in the frame becomes
      // unattributable. Name them after what they contain.
      pass.name = 'FX[' + batch.map((e) => e.name.replace(/Effect$/, '')).join('+') + ']';
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
      this._adoptAoBeautyTarget();
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
    this._syncPassList();
    console.info('[render] ' + this._passNames.join(' -> '));
  }

  /**
   * Re-read the composer's pass list, name it and arm the GPU timer on it.
   *
   * Other systems add their own passes *after* init — the atmosphere stage inserts
   * `atmosphere` once its LUTs are up — so a list captured at rebuild time is already
   * out of date by the time the first frame renders. That list is what `GpuTimer`
   * round-robins over, and `_instrument` is what lets a pass be timed at all, so a
   * late-arriving pass was invisible to the profiler: `atmosphere` reported no cost at
   * all, not a small one. Called every frame; it does nothing unless the chain changed.
   */
  _syncPassList() {
    const passes = this.composer.passes;
    this._passNames = passes.map((p) => p.name || p.constructor.name);
    this._passCount = passes.length;
    for (const p of passes) this._instrument(p);
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
   * Stop N8AO from rendering the entire city a second time.
   *
   * N8AOPostPass is built to be used standalone: it ignores the `readBuffer` the
   * composer hands it and instead fills its own `beautyRenderTarget` by calling
   * renderer.render(scene, camera) every frame. Dropped into a chain that already has
   * a RenderPass, that means the whole world is drawn twice — measured at 19.5 ms of a
   * 16.6 ms budget on the street_level shot, by far the most expensive thing in the
   * stage.
   *
   * The pass only ever *reads* `beautyRenderTarget.texture` and `.depthTexture`, so
   * pointing it at the composer's input buffer (which already holds exactly that, and
   * carries a depth texture because the pass declares needsDepthTexture) gives it the
   * same data for free.
   */
  _adoptAoBeautyTarget() {
    const input = this.composer.inputBuffer;
    if (!input?.depthTexture) return;            // no depth attached: leave it alone
    if (this.ao.beautyRenderTarget !== input) {
      // Free the target it allocated for itself, once.
      if (!this._aoBeautyReplaced) {
        this.ao.beautyRenderTarget?.dispose();
        this._aoBeautyReplaced = true;
      }
      this.ao.beautyRenderTarget = input;
    }
    this.ao.configuration.autoRenderBeauty = false;
  }

  /**
   * One-shot self-test: prove that no pass in the chain zeroes the frame.
   *
   * This stage is the shared output for every other agent's work, and other systems
   * insert their own passes into this composer. A single pass that returns black takes
   * the entire game down with it and looks, from the outside, exactly like a bug in
   * here. So: render every prefix of the chain into a 32x32 probe target, read it back,
   * and find the first pass whose output collapses to zero. The offender is disabled
   * and named loudly rather than being allowed to black out the build.
   *
   * Runs once after boot and on demand. Never on the hot path — it reads back.
   *
   * @return {{ ok:boolean, culprit:(string|null), means:Array }}
   */
  validate() {
    const r = this.renderer, c = this.composer;
    if (!c.passes.length) return { ok: true, culprit: null, means: [] };

    const probe = this._probeRT || (this._probeRT = new THREE.WebGLRenderTarget(32, 32, {
      type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    }));
    const px = this._probePixels || (this._probePixels = new Uint8Array(32 * 32 * 4));
    if (!this._probeQuad) {
      const mat = new THREE.ShaderMaterial({
        name: 'Render.Probe',
        depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        uniforms: { inputBuffer: { value: null } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5;' +
          ' gl_Position = vec4(position.xy, 1.0, 1.0); }',
        fragmentShader: 'uniform sampler2D inputBuffer; varying vec2 vUv;' +
          ' void main(){ gl_FragColor = vec4(texture2D(inputBuffer, vUv).rgb, 1.0); }',
      });
      this._probeQuad = new THREE.Mesh(Pass.fullscreenGeometry, mat);
      this._probeQuad.frustumCulled = false;
      this._probeScene = new THREE.Scene();
      this._probeScene.add(this._probeQuad);
      this._probeCam = new THREE.OrthographicCamera();
    }

    const meanAfter = (k) => {
      let inp = c.inputBuffer, out = c.outputBuffer, tmp;
      for (let i = 0; i <= k; i++) {
        const p = c.passes[i];
        if (!p.enabled) continue;
        const rts = p.renderToScreen;
        p.renderToScreen = false;
        p.render(r, inp, out, 1 / 60, false);
        p.renderToScreen = rts;
        if (p.needsDepthBlit && c.depthRenderTarget) c.blitDepthBuffer(inp);
        if (p.needsSwap) { tmp = inp; inp = out; out = tmp; }
      }
      // NOT composer.copyPass: postprocessing's CopyPass ignores the outputBuffer
      // argument entirely and always writes to its own private render target, so
      // using it here silently reads an empty buffer and reports a false black.
      this._probeQuad.material.uniforms.inputBuffer.value = inp.texture;
      r.setRenderTarget(probe);
      r.render(this._probeScene, this._probeCam);
      r.readRenderTargetPixels(probe, 0, 0, 32, 32, px);
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        sum += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
      }
      return sum / (px.length / 4);
    };

    const means = [];
    let culprit = null;
    let prev = 0;
    for (let k = 0; k < c.passes.length; k++) {
      const p = c.passes[k];
      const name = p.name || p.constructor.name;
      const m = meanAfter(k);
      means.push({ k, name, mean: +m.toFixed(2) });
      // A pass that turns a frame with real content into nothing is the offender.
      // The 1.5/255 floor keeps a legitimately near-black night frame from tripping it.
      if (!culprit && p !== this.renderPass && prev > 1.5 && m < prev * 0.02) {
        culprit = name;
        p.enabled = false;
        console.error(`[render] pass "${name}" collapsed the frame to black ` +
          `(mean ${prev.toFixed(1)} -> ${m.toFixed(2)}). Disabled to keep the build ` +
          `visible; re-enable with __boston.render.revalidate() once it is fixed.`);
      }
      prev = Math.max(prev, m);
    }

    // The probe run left temporal buffers holding nonsense.
    this.autoExposure.reset(); this.taa.reset(); this.ssr.reset(); this.dof.reset();
    return { ok: !culprit, culprit, means };
  }

  /** Re-arm every pass and run the self-test again. */
  revalidate() {
    for (const p of this.composer.passes) p.enabled = true;
    return this.validate();
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
    // EffectComposer.setSize() skips renderer.setSize() when the CSS size is
    // unchanged, so a changed pixel ratio (quality switch at a fixed window size)
    // would never reach the drawing buffer. Apply it explicitly.
    //
    // updateStyle MUST stay true. three writes an inline width/height on the canvas
    // the first time setSize runs, and an inline style beats the `canvas{width:100%}`
    // rule in index.html forever after. Passing false here leaves the element pinned
    // at its boot-time CSS box while the drawing buffer follows the window, so the
    // game renders into the top-left corner of a black page on every resize.
    this.renderer.setSize(w, h, true);
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
    // Wrapping is unconditional so profiling can be armed later without a rebuild;
    // the timer itself no-ops until it is explicitly enabled.
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
    if (this.composer.passes.length !== this._passCount) this._syncPassList();
    this.gpuTimer.beginFrame(this._passNames);

    const look = this.grade.evaluate(tod, s.weather, ctx.assets?.wetness ?? 0);

    this.autoExposure.setDeltaTime(dt);
    this.autoExposure.setEVRange(o.minEV, o.maxEV);
    this.autoExposure.setResponse(o.meterPivot, o.meterGainDown);
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
    this._probeRT?.dispose();
    this._probeQuad?.material.dispose();
    this.ao?.dispose?.();
    this.composer?.dispose();
    this.renderer?.dispose();
  }
}
