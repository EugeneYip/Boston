import * as THREE from 'three';
import { QUAD_VERT } from '../shaders/sky/luts.glsl.js';
import { BASE_NOISE_FRAG, DETAIL_NOISE_FRAG, WEATHER_FRAG } from '../shaders/sky/cloudNoise.glsl.js';
import { CLOUD_FRAG } from '../shaders/sky/clouds.glsl.js';

const BASE_RES = 128;      // 128^3 shape volume, ~8 MB
const DETAIL_RES = 32;     // 32^3 erosion volume
const WEATHER_RES = 512;
const BASE_TILE = 5120;    // metres per wrap of the shape volume
const DETAIL_TILE = 320;   // metres per wrap of the erosion volume (5120 / 16)

const QUALITY = {
  low:    { scale: 0.14, steps: 16, light: 3, march: 11000 },
  medium: { scale: 0.18, steps: 26, light: 4, march: 16000 },
  high:   { scale: 0.22, steps: 36, light: 5, march: 22000 },
  ultra:  { scale: 0.30, steps: 52, light: 6, march: 30000 },
};

/**
 * Raymarched volumetric clouds.
 *
 * Owned and driven by SkySystem; rendered by the atmosphere pass into a
 * quarter-resolution RGBA16F buffer (rgb = in-scattered radiance, a =
 * transmittance) which the composite upsamples over sky pixels only.
 *
 * Cost control, in order of importance:
 *  1. a four-tap depth test kills the march entirely on pixels covered by
 *     geometry — street-level frames are close to free,
 *  2. quarter resolution,
 *  3. a cheap silhouette-only density gates the expensive detail sample,
 *  4. temporal blending against the rotation-reprojected previous frame lets
 *     the per-pixel blue-noise jitter do the work of extra steps.
 */
export default class Clouds {
  static id = 'clouds';
  static label = 'Volumetric clouds';
  static deps = ['sky'];

  constructor() {
    this._wind = new THREE.Vector3();
    this._detail = new THREE.Vector3();
    this._weatherScroll = new THREE.Vector2();
    this._windVec = new THREE.Vector3(4, 0, -2);
    this._prevVP = new THREE.Matrix4();
    this._flip = false;
    this._hasHistory = 0;
    this.skip = false;          // profiling hook
  }

  async init(ctx) {
    const sky = ctx.get('sky');
    this.ctx = ctx;
    this.sky = sky;
    sky.clouds = this;
    const renderer = ctx.renderer;
    const u = sky.u;

    // ---- cloud shape parameters, lerped by the weather system ------------
    this.p = {
      uCoverage:       { value: 0.42 },
      uCloudType:      { value: 0.40 },
      uDensity:        { value: 1.0 },
      uExtinction:     { value: 0.018 },
      uDetailStrength: { value: 0.35 },
      uShapeLo:        { value: 0.16 },
      uShapeHi:        { value: 0.86 },
      uCloudBottom:    { value: 1500 },
      uCloudTop:       { value: 3600 },
      uAnvil:          { value: 0.0 },
      uAmbientScale:   { value: 1.0 },
      uAerial:         { value: 0.000055 },
      uWeatherScale:   { value: 1 / 50000 },
      uCloudShadow:    { value: 1.1 },
    };

    // ---- procedural volumes ---------------------------------------------
    this.baseRT = new THREE.WebGL3DRenderTarget(BASE_RES, BASE_RES, BASE_RES, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.detailRT = new THREE.WebGL3DRenderTarget(DETAIL_RES, DETAIL_RES, DETAIL_RES, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    for (const rt of [this.baseRT, this.detailRT]) {
      rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
    }
    this.weatherRT = new THREE.WebGLRenderTarget(WEATHER_RES, WEATHER_RES, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });

    const sliceMat = (frag) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: frag,
      uniforms: { uSlice: { value: 0 } }, depthTest: false, depthWrite: false,
    });
    const mBase = sliceMat(BASE_NOISE_FRAG);
    const mDetail = sliceMat(DETAIL_NOISE_FRAG);
    const mWeather = sliceMat(WEATHER_FRAG);
    this._bakeVolume(renderer, mBase, this.baseRT, BASE_RES);
    this._bakeVolume(renderer, mDetail, this.detailRT, DETAIL_RES);
    sky._blit(renderer, mWeather, this.weatherRT);
    mBase.dispose(); mDetail.dispose(); mWeather.dispose();

    // ---- raymarch material ----------------------------------------------
    this.uniforms = {
      uBaseNoise:   { value: this.baseRT.texture },
      uDetailNoise: { value: this.detailRT.texture },
      uWeather:     { value: this.weatherRT.texture },
      uSkyView:     u.uSkyView,
      uTransLut:    u.uTransLut,
      uPrevCloud:   { value: null },
      uDepth:       { value: null },
      uSunDir:      u.uSunDir,
      uMoonDir:     u.uMoonDir,
      uSunIrradiance:  u.uSunIrradiance,
      uMoonIrradiance: u.uMoonIrradiance,
      uSkyIntensity: u.uSkyIntensity,
      uCamPos:      u.uCamPos,
      uInvProj:     u.uInvProj,
      uInvView:     u.uInvView,
      uPrevViewProj: { value: this._prevVP },
      uResolution:  { value: new THREE.Vector2(1, 1) },
      uDepthTexel:  { value: new THREE.Vector2(0.001, 0.001) },
      uFrame:       u.uFrame,
      uHasHistory:  { value: 0 },
      uBlend:       { value: 0.28 },
      uTurbidity:   u.uTurbidity,
      uMieG:        u.uMieG,
      uLightning:   u.uLightning,
      uLightningColor: u.uLightningColor,
      uEarthR:      { value: 900000 },
      uWindOffset:  { value: this._wind },
      uDetailOffset:{ value: this._detail },
      uWeatherOffset: { value: this._weatherScroll },
      uBaseScale:   { value: 1 / BASE_TILE },
      uDetailScale: { value: 1 / DETAIL_TILE },
      uSteps:       { value: 48 },
      uLightSteps:  { value: 6 },
      uMaxMarch:    { value: 26000 },
      ...this.p,
    };
    // uCloudShadow lives on the volumetric pass, not the raymarch.
    delete this.uniforms.uCloudShadow;

    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: CLOUD_FRAG,
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
    });

    this.rtA = null; this.rtB = null;
    this.applyQuality(ctx);
    ctx.bus.on('quality:changed', () => this.applyQuality(ctx));
  }

  /** Current cloud buffer for the composite. */
  get texture() { return (this._flip ? this.rtB : this.rtA)?.texture ?? null; }

  applyQuality(ctx) {
    const q = QUALITY[ctx.settings.preset] || QUALITY.high;
    this._q = q;
    this.uniforms.uSteps.value = q.steps;
    this.uniforms.uLightSteps.value = q.light;
    this.uniforms.uMaxMarch.value = q.march;
    const w = ctx.renderer.domElement.width, h = ctx.renderer.domElement.height;
    this.setSize(w, h);
  }

  setSize(w, h) {
    const s = this._q?.scale ?? 0.25;
    const cw = Math.max(8, Math.round(w * s)), ch = Math.max(8, Math.round(h * s));
    if (this.rtA && this.rtA.width === cw && this.rtA.height === ch) return;
    this.rtA?.dispose(); this.rtB?.dispose();
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(cw, ch, opts);
    this.rtB = new THREE.WebGLRenderTarget(cw, ch, opts);
    this.uniforms.uResolution.value.set(cw, ch);
    // Half a low-res texel, expressed in the full-res depth texture's uv.
    this.uniforms.uDepthTexel.value.set(0.5 / cw, 0.5 / ch);
    this._hasHistory = 0;
  }

  update(dt, ctx) {
    // Wind advection. Offsets wrap on the noise tile so long sessions never
    // lose float precision.
    const w = this._windVec;
    this._wind.x = wrap(this._wind.x - w.x * dt, BASE_TILE);
    this._wind.y = wrap(this._wind.y - w.y * dt, BASE_TILE);
    this._wind.z = wrap(this._wind.z - w.z * dt, BASE_TILE);
    this._detail.x = wrap(this._detail.x - w.x * 0.55 * dt, DETAIL_TILE);
    this._detail.y = wrap(this._detail.y + 1.2 * dt, DETAIL_TILE);
    this._detail.z = wrap(this._detail.z - w.z * 0.55 * dt, DETAIL_TILE);
    const ws = this.p.uWeatherScale.value * 0.35;
    this._weatherScroll.x = wrap(this._weatherScroll.x - w.x * ws * dt, 1);
    this._weatherScroll.y = wrap(this._weatherScroll.y - w.z * ws * dt, 1);
  }

  lateUpdate() {}

  /** Called from the atmosphere pass, inside the composer's render. */
  render(renderer, depthTexture) {
    if (!this.rtA || this.skip) return;
    const src = this._flip ? this.rtB : this.rtA;
    const dst = this._flip ? this.rtA : this.rtB;
    this.uniforms.uDepth.value = depthTexture;
    this.uniforms.uPrevCloud.value = src.texture;
    this.uniforms.uHasHistory.value = this._hasHistory;
    this.sky._blit(renderer, this.material, dst);
    this._flip = !this._flip;
    this._hasHistory = 1;
    const cam = this.ctx.camera;
    this._prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  _bakeVolume(renderer, material, rt, depth) {
    for (let z = 0; z < depth; z++) {
      material.uniforms.uSlice.value = (z + 0.5) / depth;
      this.sky._blit(renderer, material, rt, z);
    }
  }

  dispose() {
    this.material?.dispose();
    this.baseRT?.dispose(); this.detailRT?.dispose(); this.weatherRT?.dispose();
    this.rtA?.dispose(); this.rtB?.dispose();
  }
}

function wrap(v, period) {
  return v - period * Math.floor(v / period);
}
