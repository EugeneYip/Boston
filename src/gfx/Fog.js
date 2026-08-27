import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { QUAD_VERT } from '../shaders/sky/luts.glsl.js';
import { VOLUME_FRAG, COMPOSITE_FRAG } from '../shaders/sky/atmospherePass.glsl.js';

const VOL_QUALITY = {
  low:    { scale: 0.0,  steps: 0 },
  medium: { scale: 0.14, steps: 10 },
  high:   { scale: 0.17, steps: 14 },
  ultra:  { scale: 0.24, steps: 20 },
};

/**
 * Screen-space atmospheric depth: aerial perspective, height fog, volumetric
 * light shafts, and the cloud composite.
 *
 * This runs as one EffectComposer pass inserted straight after ambient
 * occlusion, so distant geometry desaturates into whatever colour the sky
 * actually is in that direction — the single biggest cue that a city is
 * kilometres deep rather than a few hundred metres of boxes.
 *
 * Sun occlusion for the shafts uses the lighting system's shadow map when one
 * is exposed (feature-detected every frame, so a later switch to cascades
 * degrades instead of crashing) and always uses the cloud deck, which is what
 * produces crepuscular rays through gaps.
 */
export default class AtmosphereFog {
  static id = 'fog';
  static label = 'Aerial perspective';
  static deps = ['sky', 'clouds', 'render'];

  async init(ctx) {
    const sky = ctx.get('sky');
    this.ctx = ctx;
    this.sky = sky;
    sky.fog = this;
    const u = sky.u;

    // Weather-driven cells; the weather system lerps these.
    this.p = {
      uHazeSigma:     { value: 8.5e-5 },   // ~46 km visual range on a clear day
      uHazeH:         { value: 1300 },
      uHazeY0:        { value: 0 },
      uRayleighScale: { value: 1.0 },
      uFogAlbedo:     { value: 0.0 },
      uFogTint:       { value: new THREE.Color().setStyle('#c3ccd6') },
      uShaftStrength: { value: 1.0 },
      uFlashScreen:   { value: 0.0 },
    };

    this._dummyShadow = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._dummyShadow.needsUpdate = true;
    this._shadowMatrix = new THREE.Matrix4();

    this.volUniforms = {
      uDepth:       { value: null },
      uWeather:     { value: sky.clouds.weatherRT.texture },
      uShadowMap:   { value: this._dummyShadow },
      uTransLut:    u.uTransLut,
      uShadowMatrix:{ value: this._shadowMatrix },
      uHasShadow:   { value: 0 },
      uSunDir:      u.uSunDir,
      uSunIrradiance: { value: new THREE.Vector3(1, 1, 1) },
      uFrame:       u.uFrame,
      uTime:        u.uTime,
      uSteps:       { value: 20 },
      uMaxShaft:    { value: 1500 },
      uCoverage:    sky.clouds.p.uCoverage,
      uCloudBottom: sky.clouds.p.uCloudBottom,
      uWeatherScale: sky.clouds.p.uWeatherScale,
      uCloudShadow: sky.clouds.p.uCloudShadow,
      uWeatherOffset: { value: sky.clouds._weatherScroll },
      uInvProj:     u.uInvProj,
      uInvView:     u.uInvView,
      uCamPos:      u.uCamPos,
      uTurbidity:   u.uTurbidity,
      uMieG:        u.uMieG,
      uHazeSigma:   this.p.uHazeSigma,
      uHazeH:       this.p.uHazeH,
      uHazeY0:      this.p.uHazeY0,
      uShaftStrength: this.p.uShaftStrength,
    };
    this.volMaterial = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: VOLUME_FRAG,
      uniforms: this.volUniforms, depthTest: false, depthWrite: false,
    });

    this.compUniforms = {
      inputBuffer:  { value: null },
      uDepth:       { value: null },
      uCloud:       { value: null },
      uCloudViewProj: { value: sky.clouds.viewProj },
      uCloudRayScale: { value: sky.clouds.rayScale },
      uVolume:      { value: this._dummyShadow },
      uSkyView:     u.uSkyView,
      uSunDir:      u.uSunDir,
      uSkyIntensity: u.uSkyIntensity,
      uLightning:   u.uLightning,
      uLightningColor: u.uLightningColor,
      uMaxRadiance: u.uMaxRadiance,
      uInvProj:     u.uInvProj,
      uInvView:     u.uInvView,
      uCamPos:      u.uCamPos,
      uTurbidity:   u.uTurbidity,
      uMieG:        u.uMieG,
      uUseVolume:   { value: 0 },
      uHazeSigma:   this.p.uHazeSigma,
      uHazeH:       this.p.uHazeH,
      uHazeY0:      this.p.uHazeY0,
      uRayleighScale: this.p.uRayleighScale,
      uFogAlbedo:   this.p.uFogAlbedo,
      uFogTint:     this.p.uFogTint,
      uFlashScreen: this.p.uFlashScreen,
    };
    this.compMaterial = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: this.compUniforms, depthTest: false, depthWrite: false,
    });

    this.volRT = null;
    this._size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pass = new AtmospherePass(this);
    this._applyQuality();
    this._attach();

    ctx.bus.on('quality:changed', () => { this._applyQuality(); this._attach(); });
  }

  _applyQuality() {
    const q = VOL_QUALITY[this.ctx.settings.preset] || VOL_QUALITY.high;
    this._volQ = q;
    this.volUniforms.uSteps.value = q.steps;
    this.enabled = q.scale > 0 && this.ctx.settings.volumetrics !== false;
    this.compUniforms.uUseVolume.value = this.enabled ? 1 : 0;
    this.setSize(this._size.x, this._size.y);
  }

  /** Insert into the composer just after the AO pass, and re-insert if the
   *  render pipeline rebuilds its chain on a quality change. */
  _attach() {
    const composer = this.ctx.composer;
    if (!composer || composer.passes.includes(this.pass)) return;
    // Straight after the scene render and AO, before auto-exposure meters the
    // frame — the fog changes scene luminance far too much to meter without it.
    const rp = this.ctx.get('render');
    const passes = composer.passes;
    const idx = Math.max(1, passes.indexOf(rp?.renderPass) + 1, passes.indexOf(rp?.ao) + 1);
    composer.addPass(this.pass, Math.min(idx, passes.length));
  }

  setSize(w, h) {
    if (w > 1) this._size.set(w, h);
    w = this._size.x; h = this._size.y;
    this.sky.clouds.setSize(w, h);
    const s = this._volQ?.scale ?? 0;
    if (s <= 0 || !this.enabled) return;
    const vw = Math.max(8, Math.round(w * s)), vh = Math.max(8, Math.round(h * s));
    if (this.volRT && this.volRT.width === vw && this.volRT.height === vh) return;
    this.volRT?.dispose();
    this.volRT = new THREE.WebGLRenderTarget(vw, vh, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.compUniforms.uVolume.value = this.volRT.texture;
  }

  update(dt, ctx) {
    // Feature-detect the sun's shadow map every frame. The lighting system runs
    // cascades, so prefer the widest cascade that still has a map — a near
    // cascade would only shadow the first few metres of every shaft.
    const lighting = ctx.get('lighting');
    let src = null, reach = 1500;
    const csm = lighting?.shadows;
    if (csm?.lights?.length) {
      for (let i = csm.lights.length - 1; i >= 0; i--) {
        const l = csm.lights[i];
        if (l.castShadow && l.visible && l.shadow?.map?.texture) { src = l; break; }
      }
      reach = csm.maxDistance || reach;
    }
    const sun = lighting?.sun;
    if (!src && sun?.castShadow && sun.visible && sun.shadow?.map?.texture) src = sun;

    this.volUniforms.uSunIrradiance.value.setScalar(
      this.sky.u.uSkyIntensity.value * this.sky.shaftGain);

    if (src) {
      this.volUniforms.uShadowMap.value = src.shadow.map.texture;
      this._shadowMatrix.copy(src.shadow.matrix);
      this.volUniforms.uHasShadow.value = 1;
      this.volUniforms.uMaxShaft.value = Math.min(1500, reach);
    } else {
      this.volUniforms.uShadowMap.value = this._dummyShadow;
      this.volUniforms.uHasShadow.value = 0;
      this.volUniforms.uMaxShaft.value = 1500;
    }
  }

  setDepth(tex) {
    this.volUniforms.uDepth.value = tex;
    this.compUniforms.uDepth.value = tex;
    this._depth = tex;
  }

  /** Runs inside the composer. */
  renderPass(renderer, inputBuffer, outputBuffer, toScreen) {
    const sky = this.sky;
    // Refresh here, not in lateUpdate: the temporal stack jitters the camera
    // projection from inside the composer, so this is the first point where the
    // matrices match what the geometry was actually rasterised with.
    const cam = this.ctx.camera;
    sky.u.uInvProj.value.copy(cam.projectionMatrixInverse);
    sky.u.uInvView.value.copy(cam.matrixWorld);
    sky.clouds.render(renderer, this._depth);

    if (this.enabled && this.volRT) {
      sky._blit(renderer, this.volMaterial, this.volRT);
    }
    this.compUniforms.inputBuffer.value = inputBuffer.texture;
    this.compUniforms.uCloud.value = sky.clouds.texture;
    sky._blit(renderer, this.compMaterial, toScreen ? null : outputBuffer);
  }

  dispose() {
    this.ctx?.composer?.removePass?.(this.pass);
    this.volMaterial?.dispose();
    this.compMaterial?.dispose();
    this.volRT?.dispose();
    this._dummyShadow?.dispose();
  }
}

/** Thin adapter so the composer owns the call into AtmosphereFog. */
class AtmospherePass extends Pass {
  constructor(fog) {
    super('atmosphere');
    this.fog = fog;
    this.needsDepthTexture = true;
    this.needsSwap = true;
    this._depth = null;
  }
  getDepthTexture() { return this._depth; }
  setDepthTexture(t) { this._depth = t; this.fog.setDepth(t); }
  setSize(w, h) { this.fog.setSize(w, h); }
  render(renderer, inputBuffer, outputBuffer) {
    this.fog.renderPass(renderer, inputBuffer, outputBuffer, this.renderToScreen);
  }
  dispose() { /* AtmosphereFog owns every resource this pass touches */ }
}
