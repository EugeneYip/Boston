import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Lens response: veiling glare, anamorphic streaking and dirt.
 *
 * A real lens does not smear bright pixels uniformly. Its point spread function is a
 * tight, bright core sitting inside a very wide, very dim halo — that is why a street
 * light at night has a hard glow and *also* lifts the whole side of the frame. This pass
 * builds both lobes separately:
 *
 *   core  = prefiltered image, one small blur           (tight, high weight)
 *   wide  = full mip pyramid, progressive tent upsample (huge extent, low weight)
 *
 * plus an optional horizontal streak chain for the anamorphic flare that only very
 * bright sources produce.
 *
 * The threshold is expressed in *post-exposure* units by sampling the same adapted
 * luminance texture the exposure stage uses, so the bloom does not explode when eye
 * adaptation opens up in a dark alley.
 */
export default class LensPass extends Pass {
  /**
   * @param {Object} [options]
   * @param {number} [options.levels=6] - mip pyramid depth
   * @param {boolean} [options.streaks=true]
   */
  constructor({ levels = 6, streaks = true } = {}) {
    super('LensPass');
    this.needsSwap = false;
    this._levels = levels;
    this._activeLevels = levels;
    this._streaksEnabled = streaks;

    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this._opts = opts;

    this.prefilterRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.coreRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.coreTmpRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.mips = [];
    for (let i = 0; i < levels; i++) this.mips.push(new THREE.WebGLRenderTarget(1, 1, opts));
    this.streakRT = [new THREE.WebGLRenderTarget(1, 1, opts),
                     new THREE.WebGLRenderTarget(1, 1, opts)];

    const base = {
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      vertexShader: VERT,
    };

    this.prefilterMat = new THREE.ShaderMaterial({
      ...base, name: 'Lens.Prefilter', fragmentShader: PREFILTER_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        adaptedLuminance: { value: null },
        texelSize: { value: new THREE.Vector2() },
        // x: threshold, y: soft knee, z: clamp, w: unused
        filterParams: { value: new THREE.Vector4(1.0, 0.6, 40.0, 0) },
        // mirrors ExposureEffect: key, manual, evBias, autoBlend
        exposureParams: { value: new THREE.Vector4(0.20, 1, 0, 1) },
      },
    });

    this.downMat = new THREE.ShaderMaterial({
      ...base, name: 'Lens.Down', fragmentShader: DOWN_FRAG,
      uniforms: { inputBuffer: { value: null }, texelSize: { value: new THREE.Vector2() } },
    });

    this.upMat = new THREE.ShaderMaterial({
      ...base, name: 'Lens.Up', fragmentShader: UP_FRAG,
      uniforms: {
        inputBuffer: { value: null }, supportBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() }, radius: { value: 0.85 },
      },
    });

    this.blurMat = new THREE.ShaderMaterial({
      ...base, name: 'Lens.Blur', fragmentShader: BLUR_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        direction: { value: new THREE.Vector2(1, 0) },
        texelSize: { value: new THREE.Vector2() },
        stride: { value: 1 },
        decay: { value: 0.92 },
      },
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.prefilterMat);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._size = new THREE.Vector2(1, 1);
  }

  get coreTexture() { return this.coreRT.texture; }
  get wideTexture() { return this.mips[0].texture; }
  get streakTexture() { return this.streakRT[this._streakOut || 0].texture; }

  /** Push the exposure state so the threshold tracks eye adaptation. */
  setExposure(key, manual, evBias, autoBlend, luminanceTexture) {
    this.prefilterMat.uniforms.exposureParams.value.set(key, manual, evBias, autoBlend);
    this.prefilterMat.uniforms.adaptedLuminance.value = luminanceTexture;
  }

  /** @param {number} t - luminance above which a pixel starts to glare (post-exposure) */
  set threshold(t) { this.prefilterMat.uniforms.filterParams.value.x = t; }
  set softKnee(k) { this.prefilterMat.uniforms.filterParams.value.y = k; }
  set radius(r) { this.upMat.uniforms.radius.value = r; }
  set streaksEnabled(v) { this._streaksEnabled = v; }
  /** Trim the pyramid on cheaper presets. Fewer levels = a tighter, cheaper halo. */
  set activeLevels(n) { this._activeLevels = Math.max(2, Math.min(this._levels, n | 0)); }
  get activeLevels() { return this._activeLevels; }

  setSize(width, height) {
    this._size.set(width, height);
    let w = Math.max(1, Math.round(width * 0.5));
    let h = Math.max(1, Math.round(height * 0.5));
    this.prefilterRT.setSize(w, h);
    this.coreRT.setSize(w, h);
    this.coreTmpRT.setSize(w, h);
    for (let i = 0; i < this.mips.length; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      this.mips[i].setSize(w, h);
    }
    const sw = Math.max(1, Math.round(width * 0.25));
    const sh = Math.max(1, Math.round(height * 0.25));
    this.streakRT[0].setSize(sw, sh);
    this.streakRT[1].setSize(sw, sh);
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  render(renderer, inputBuffer) {
    const q = this.prefilterMat.uniforms;
    q.inputBuffer.value = inputBuffer.texture;
    q.texelSize.value.set(1 / inputBuffer.width, 1 / inputBuffer.height);
    this._draw(renderer, this.prefilterMat, this.prefilterRT);

    // --- tight core: separable 5-tap blur of the prefiltered image ---
    const b = this.blurMat.uniforms;
    b.texelSize.value.set(1 / this.prefilterRT.width, 1 / this.prefilterRT.height);
    b.stride.value = 1;
    b.decay.value = 1.0;
    b.inputBuffer.value = this.prefilterRT.texture;
    b.direction.value.set(1, 0);
    this._draw(renderer, this.blurMat, this.coreTmpRT);
    b.inputBuffer.value = this.coreTmpRT.texture;
    b.direction.value.set(0, 1);
    this._draw(renderer, this.blurMat, this.coreRT);

    // --- wide halo: downsample pyramid ---
    const d = this.downMat.uniforms;
    const levels = this._activeLevels;
    let src = this.prefilterRT;
    for (let i = 0; i < levels; i++) {
      d.inputBuffer.value = src.texture;
      d.texelSize.value.set(1 / src.width, 1 / src.height);
      this._draw(renderer, this.downMat, this.mips[i]);
      src = this.mips[i];
    }
    // --- progressive tent upsample, accumulating back into mips[0] ---
    const u = this.upMat.uniforms;
    for (let i = levels - 1; i > 0; i--) {
      u.inputBuffer.value = this.mips[i].texture;
      u.supportBuffer.value = this.mips[i - 1].texture;
      u.texelSize.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
      this._draw(renderer, this.upMat, this.mips[i - 1]);
    }

    // --- anamorphic streak: horizontal-only chain at quarter res ---
    if (this._streaksEnabled) {
      b.inputBuffer.value = this.prefilterRT.texture;
      b.texelSize.value.set(1 / this.streakRT[0].width, 1 / this.streakRT[0].height);
      b.direction.value.set(1, 0);
      b.decay.value = 0.88;
      let dst = 1;
      for (let i = 0; i < 3; i++) {
        b.stride.value = Math.pow(4, i);
        this._draw(renderer, this.blurMat, this.streakRT[dst]);
        b.inputBuffer.value = this.streakRT[dst].texture;
        dst ^= 1;
      }
      this._streakOut = dst ^ 1;
    }
  }

  dispose() {
    this.prefilterRT.dispose(); this.coreRT.dispose(); this.coreTmpRT.dispose();
    for (const m of this.mips) m.dispose();
    this.streakRT[0].dispose(); this.streakRT[1].dispose();
    this.prefilterMat.dispose(); this.downMat.dispose();
    this.upMat.dispose(); this.blurMat.dispose();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const PREFILTER_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D adaptedLuminance;
uniform vec2 texelSize;
uniform vec4 filterParams;
uniform vec4 exposureParams;
varying vec2 vUv;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 t = texelSize;
  // 4 bilinear taps at the corners of the source quad, Karis-averaged so a single
  // fireflying pixel cannot dominate the whole mip chain.
  vec3 a = texture2D(inputBuffer, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 b = texture2D(inputBuffer, vUv + vec2( t.x, -t.y)).rgb;
  vec3 c = texture2D(inputBuffer, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 d = texture2D(inputBuffer, vUv + vec2( t.x,  t.y)).rgb;

  float avgLog = texture2D(adaptedLuminance, vec2(0.5)).r;
  float autoExp = exposureParams.x / max(exp2(avgLog), 1e-5);
  float exposure = mix(1.0, autoExp, exposureParams.w)
                 * exposureParams.y * exp2(exposureParams.z);

  float wa = 1.0 / (1.0 + lum(a) * exposure);
  float wb = 1.0 / (1.0 + lum(b) * exposure);
  float wc = 1.0 / (1.0 + lum(c) * exposure);
  float wd = 1.0 / (1.0 + lum(d) * exposure);
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-5);
  col = min(col, vec3(filterParams.z));

  float l = lum(col) * exposure;
  float knee = filterParams.x * filterParams.y + 1e-4;
  float soft = clamp(l - filterParams.x + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, l - filterParams.x) / max(l, 1e-5);

  gl_FragColor = vec4(col * contribution, 1.0);
}`;

// 13-tap Jimenez/COD downsample: partial-Karis weighted, no pulsing on motion.
const DOWN_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 texelSize;
varying vec2 vUv;
void main() {
  vec2 t = texelSize;
  vec3 a = texture2D(inputBuffer, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture2D(inputBuffer, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture2D(inputBuffer, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture2D(inputBuffer, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(inputBuffer, vUv).rgb;
  vec3 f = texture2D(inputBuffer, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(inputBuffer, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(inputBuffer, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(inputBuffer, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture2D(inputBuffer, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture2D(inputBuffer, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(inputBuffer, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(inputBuffer, vUv + t * vec2( 1.0, -1.0)).rgb;
  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}`;

// 9-tap tent upsample, added on top of the finer level.
const UP_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D supportBuffer;
uniform vec2 texelSize;
uniform float radius;
varying vec2 vUv;
void main() {
  vec2 t = texelSize * radius;
  vec3 col = texture2D(inputBuffer, vUv + t * vec2(-1.0,  1.0)).rgb * 0.0625;
  col += texture2D(inputBuffer, vUv + t * vec2( 0.0,  1.0)).rgb * 0.125;
  col += texture2D(inputBuffer, vUv + t * vec2( 1.0,  1.0)).rgb * 0.0625;
  col += texture2D(inputBuffer, vUv + t * vec2(-1.0,  0.0)).rgb * 0.125;
  col += texture2D(inputBuffer, vUv).rgb * 0.25;
  col += texture2D(inputBuffer, vUv + t * vec2( 1.0,  0.0)).rgb * 0.125;
  col += texture2D(inputBuffer, vUv + t * vec2(-1.0, -1.0)).rgb * 0.0625;
  col += texture2D(inputBuffer, vUv + t * vec2( 0.0, -1.0)).rgb * 0.125;
  col += texture2D(inputBuffer, vUv + t * vec2( 1.0, -1.0)).rgb * 0.0625;
  gl_FragColor = vec4(texture2D(supportBuffer, vUv).rgb + col, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 direction;
uniform vec2 texelSize;
uniform float stride;
uniform float decay;
varying vec2 vUv;
void main() {
  vec2 step = direction * texelSize * max(stride, 0.0);
  vec3 col = texture2D(inputBuffer, vUv).rgb * 0.2270270270;
  float w1 = 0.3162162162 * decay;
  float w2 = 0.0702702703 * decay * decay;
  col += texture2D(inputBuffer, vUv + step * 1.3846153846).rgb * w1;
  col += texture2D(inputBuffer, vUv - step * 1.3846153846).rgb * w1;
  col += texture2D(inputBuffer, vUv + step * 3.2307692308).rgb * w2;
  col += texture2D(inputBuffer, vUv - step * 3.2307692308).rgb * w2;
  gl_FragColor = vec4(col, 1.0);
}`;
