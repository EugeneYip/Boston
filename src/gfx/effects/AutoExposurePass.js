import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Physically-parameterised eye adaptation.
 *
 * Frame 1: the HDR scene is reduced to a 128x128 buffer holding
 *          (log2(luminance) * meterWeight, meterWeight). Mipmaps of that buffer give a
 *          weighted *geometric* mean, which is far more stable than an arithmetic mean —
 *          a single specular highlight cannot yank the whole exposure.
 * Frame 2: a 1x1 ping-pong buffer integrates that value over time with separate
 *          brighten / darken rates, clamped to a min/max EV100 window.
 *
 * Nothing is ever read back to the CPU on the hot path, so there is no pipeline stall.
 * The result stays on the GPU and is sampled by ExposureEffect, the bloom prefilter and
 * the grain effect, which is what keeps them all consistent with each other.
 */
export default class AutoExposurePass extends Pass {
  constructor() {
    super('AutoExposurePass');
    this.needsSwap = false;

    const rtOpts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      depthBuffer: false, stencilBuffer: false,
    };

    // 128x128 => 7 mip levels down to 1x1.
    this.lumRT = new THREE.WebGLRenderTarget(128, 128, {
      ...rtOpts,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.lumRT.texture.generateMipmaps = true;
    this.lumRT.texture.name = 'AutoExposure.Luminance';

    this.adaptRT = [
      new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    ];
    for (const rt of this.adaptRT) rt.texture.generateMipmaps = false;
    this._ping = 0;

    this.lumMaterial = new THREE.ShaderMaterial({
      name: 'AutoExposure.Reduce',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        inputBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        meterBias: { value: 0.28 },   // how hard the frame edges are discounted
      },
      vertexShader: VERT,
      fragmentShader: REDUCE_FRAG,
    });

    this.adaptMaterial = new THREE.ShaderMaterial({
      name: 'AutoExposure.Adapt',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        lumBuffer: { value: this.lumRT.texture },
        prevBuffer: { value: null },
        // x: dt, y: rate up, z: rate down, w: reset flag
        params: { value: new THREE.Vector4(0.016, 3.4, 1.1, 1) },
        // x: min log2 luminance, y: max log2 luminance
        range: { value: new THREE.Vector2(-6, 12) },
      },
      vertexShader: VERT,
      fragmentShader: ADAPT_FRAG,
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.lumMaterial);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);

    this.speedUp = 3.4;      // EV/s when the world gets brighter (pupil closes fast)
    this.speedDown = 1.1;    // EV/s when it gets darker (rods take their time)
    this.setEVRange(-1.5, 15.5);
    this.reset();
  }

  /**
   * Clamp window for the metered scene luminance, expressed as EV100.
   * L = 0.125 * 2^EV100 (K = 12.5 reflected-light meter calibration).
   */
  setEVRange(minEV, maxEV) {
    this.minEV = minEV; this.maxEV = maxEV;
    const r = this.adaptMaterial.uniforms.range.value;
    r.x = Math.log2(0.125 * Math.pow(2, minEV));
    r.y = Math.log2(0.125 * Math.pow(2, maxEV));
  }

  /** Snap the adaptation to whatever the next frame measures (teleports, cuts). */
  reset() { this._reset = 2; }

  /** The 1x1 texture holding the adapted log2 luminance in .r — sample at (0.5, 0.5). */
  get texture() { return this.adaptRT[this._ping].texture; }

  setSize(width, height) {
    this.lumMaterial.uniforms.texelSize.value.set(1 / Math.max(width, 1), 1 / Math.max(height, 1));
  }

  render(renderer, inputBuffer) {
    // --- reduce ---
    this.lumMaterial.uniforms.inputBuffer.value = inputBuffer.texture;
    this._quad.material = this.lumMaterial;
    renderer.setRenderTarget(this.lumRT);
    renderer.render(this.scene, this.camera);

    // --- adapt (ping-pong so we can read the previous value) ---
    const prev = this.adaptRT[this._ping];
    const next = this.adaptRT[this._ping ^ 1];
    const u = this.adaptMaterial.uniforms;
    u.prevBuffer.value = prev.texture;
    u.params.value.y = this.speedUp;
    u.params.value.z = this.speedDown;
    u.params.value.w = this._reset > 0 ? 1 : 0;
    this._quad.material = this.adaptMaterial;
    renderer.setRenderTarget(next);
    renderer.render(this.scene, this.camera);
    this._ping ^= 1;
    if (this._reset > 0) this._reset--;
  }

  /**
   * Read the pre-exposure scene luminance back to the CPU, as log2 values.
   *
   * Diagnostic only — it stalls the pipeline, so never call it per frame. It exists
   * because "the shadows are crushed" has two completely different causes (a tone
   * curve throwing away detail, versus detail that was never rendered) and this is
   * the only way to tell them apart without guessing.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @return {{ width:number, height:number, logLum:Float32Array, adapted:number }}
   */
  probeLuminance(renderer) {
    const w = this.lumRT.width, h = this.lumRT.height;
    const raw = new Uint16Array(w * h * 4);
    renderer.readRenderTargetPixels(this.lumRT, 0, 0, w, h, raw);
    const logLum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const sum = half2float(raw[i * 4]);
      const weight = half2float(raw[i * 4 + 1]);
      logLum[i] = weight > 1e-4 ? sum / weight : -20;
    }
    const a = new Uint16Array(4);
    renderer.readRenderTargetPixels(this.adaptRT[this._ping], 0, 0, 1, 1, a);
    return { width: w, height: h, logLum, adapted: half2float(a[0]) };
  }

  /** Called by the pipeline with the real frame delta before render(). */
  setDeltaTime(dt) {
    this.adaptMaterial.uniforms.params.value.x = Math.min(Math.max(dt, 1e-4), 0.25);
  }

  dispose() {
    this.lumRT.dispose();
    this.adaptRT[0].dispose(); this.adaptRT[1].dispose();
    this.lumMaterial.dispose(); this.adaptMaterial.dispose();
  }
}

/** IEEE 754 binary16 -> Number. Only used by the diagnostic readback. */
function half2float(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const REDUCE_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 texelSize;
uniform float meterBias;
varying vec2 vUv;

void main() {
  // 2x2 rotated-grid tap so the reduction does not alias badly on thin bright geometry.
  vec2 o = texelSize * 1.5;
  vec3 c = texture2D(inputBuffer, vUv + vec2( o.x,  o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2(-o.x,  o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2( o.x, -o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2(-o.x, -o.y) * 0.5).rgb;
  c *= 0.25;

  float lum = dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
  // Centre-weighted metering, biased slightly below centre so a bright sky in the
  // top third does not stop the street down into silhouette.
  vec2 d = (vUv - vec2(0.5, 0.42)) * vec2(1.0, 1.25);
  float w = mix(meterBias, 1.0, exp(-dot(d, d) * 3.2));

  float logLum = log2(max(lum, 1e-5));
  gl_FragColor = vec4(logLum * w, w, 0.0, 1.0);
}`;

const ADAPT_FRAG = /* glsl */`
uniform sampler2D lumBuffer;
uniform sampler2D prevBuffer;
uniform vec4 params;   // dt, rateUp, rateDown, reset
uniform vec2 range;    // min/max log2 luminance
varying vec2 vUv;

void main() {
  vec4 s = texture2DLodEXT(lumBuffer, vec2(0.5), 7.0);
  float target = clamp(s.x / max(s.y, 1e-4), range.x, range.y);
  float prev = texture2D(prevBuffer, vec2(0.5)).r;
  if (params.w > 0.5 || prev != prev) {
    gl_FragColor = vec4(target, 0.0, 0.0, 1.0);
    return;
  }
  // Exponential approach in log space => constant EV/s, which is what the eye does.
  float rate = (target > prev) ? params.y : params.z;
  float k = 1.0 - exp(-params.x * rate);
  gl_FragColor = vec4(mix(prev, target, clamp(k, 0.0, 1.0)), 0.0, 0.0, 1.0);
}`;
