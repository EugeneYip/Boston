import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Velocity-buffer motion blur with a tile-max dilation pass.
 *
 * The naive version — gather along this pixel's own velocity — cannot blur a fast
 * object *outward* past its own silhouette, so cars look sharp-edged and stamped on.
 * The fix (McGuire et al.) is a two-level max-velocity pyramid: every pixel searches
 * the largest velocity in its 20px tile and its neighbouring tiles, and reconstructs
 * along that, weighting each tap by whether the sample could plausibly have covered
 * this pixel during the shutter interval.
 *
 * Shutter is expressed as an angle, so 180 degrees means the blur spans half a frame —
 * the film convention, and the reason game motion blur usually looks over-cooked when
 * it is authored as an arbitrary strength slider.
 */
export default class MotionBlurPass extends Pass {
  constructor(velocityPass) {
    super('MotionBlurPass');
    this.needsSwap = true;
    this.velocityPass = velocityPass;

    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.tileRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.neighbourRT = new THREE.WebGLRenderTarget(1, 1, opts);

    this.tileSize = 20;
    this.shutterAngle = 180;     // degrees
    this.maxBlurPixels = 48;
    this.samples = 12;

    const base = { depthTest: false, depthWrite: false, blending: THREE.NoBlending,
                   vertexShader: VERT };

    this.tileMat = new THREE.ShaderMaterial({
      ...base, name: 'MotionBlur.TileMax', fragmentShader: TILE_FRAG,
      uniforms: {
        velocityBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        tileSize: { value: 20 },
      },
    });
    this.neighbourMat = new THREE.ShaderMaterial({
      ...base, name: 'MotionBlur.NeighbourMax', fragmentShader: NEIGHBOUR_FRAG,
      uniforms: {
        tileBuffer: { value: null },
        tileTexel: { value: new THREE.Vector2() },
      },
    });
    this.blurMat = new THREE.ShaderMaterial({
      ...base, name: 'MotionBlur.Reconstruct', fragmentShader: BLUR_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        velocityBuffer: { value: null },
        neighbourBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        // x: shutter scale, y: max blur px, z: sample count, w: frame jitter
        blurParams: { value: new THREE.Vector4(0.5, 48, 12, 0) },
      },
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.blurMat);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._orthoCam = new THREE.OrthographicCamera();
    this._frame = 0;
  }

  setSize(width, height) {
    this._w = width; this._h = height;
    const tw = Math.max(1, Math.ceil(width / this.tileSize));
    const th = Math.max(1, Math.ceil(height / this.tileSize));
    this.tileRT.setSize(tw, th);
    this.neighbourRT.setSize(tw, th);
    this.tileMat.uniforms.texelSize.value.set(1 / width, 1 / height);
    this.tileMat.uniforms.tileSize.value = this.tileSize;
    this.neighbourMat.uniforms.tileTexel.value.set(1 / tw, 1 / th);
    this.blurMat.uniforms.texelSize.value.set(1 / width, 1 / height);
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this._orthoCam);
  }

  render(renderer, inputBuffer, outputBuffer) {
    const vel = this.velocityPass.texture;

    this.tileMat.uniforms.velocityBuffer.value = vel;
    this._draw(renderer, this.tileMat, this.tileRT);

    this.neighbourMat.uniforms.tileBuffer.value = this.tileRT.texture;
    this._draw(renderer, this.neighbourMat, this.neighbourRT);

    const u = this.blurMat.uniforms;
    u.inputBuffer.value = inputBuffer.texture;
    u.velocityBuffer.value = vel;
    u.neighbourBuffer.value = this.neighbourRT.texture;
    u.blurParams.value.set(
      Math.max(this.shutterAngle, 0) / 360,
      this.maxBlurPixels,
      this.samples,
      (this._frame++ % 16) / 16);
    this._draw(renderer, this.blurMat, this.renderToScreen ? null : outputBuffer);
  }

  dispose() {
    this.tileRT.dispose(); this.neighbourRT.dispose();
    this.tileMat.dispose(); this.neighbourMat.dispose(); this.blurMat.dispose();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const TILE_FRAG = /* glsl */`
uniform sampler2D velocityBuffer;
uniform vec2 texelSize;
uniform float tileSize;
varying vec2 vUv;
void main() {
  vec2 best = vec2(0.0);
  float bestLen = 0.0;
  // Fixed 10x10 stride over the tile: enough to catch the dominant motion without
  // reading every texel of a 20px tile.
  for (int y = 0; y < 10; y++) {
    for (int x = 0; x < 10; x++) {
      vec2 o = (vec2(float(x), float(y)) + 0.5) * (tileSize / 10.0) - tileSize * 0.5;
      vec2 v = texture2D(velocityBuffer, vUv + o * texelSize).xy;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}`;

const NEIGHBOUR_FRAG = /* glsl */`
uniform sampler2D tileBuffer;
uniform vec2 tileTexel;
varying vec2 vUv;
void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texture2D(tileBuffer, vUv + vec2(float(x), float(y)) * tileTexel).xy;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D velocityBuffer;
uniform sampler2D neighbourBuffer;
uniform vec2 texelSize;
uniform vec4 blurParams;
varying vec2 vUv;

float softDepthCompare(float a, float b) {
  // Velocity .z is a linear distance in metres, so the tolerance has to scale with
  // range: 2 cm matters at arm's length, 2 m does not matter across the harbour.
  float tol = max(0.05, 0.02 * min(a, b));
  return clamp(1.0 - (a - b) / tol, 0.0, 1.0);
}
float cone(float dist, float len) { return clamp(1.0 - dist / max(len, 1e-5), 0.0, 1.0); }
float cylinder(float dist, float len) { return 1.0 - smoothstep(0.95 * len, 1.05 * len, dist); }

void main() {
  vec2 pxSize = texelSize;
  vec3 centre = texture2D(velocityBuffer, vUv).xyz;
  vec2 nMax = texture2D(neighbourBuffer, vUv).xy;

  float nLenPx = length(nMax / pxSize) * blurParams.x;
  if (nLenPx < 1.0) {
    gl_FragColor = texture2D(inputBuffer, vUv);
    return;
  }
  float scale = min(1.0, blurParams.y / max(nLenPx, 1e-4));
  vec2 nStep = nMax * blurParams.x * scale;
  vec2 cStep = centre.xy * blurParams.x * scale;
  float cLenPx = max(length(cStep / pxSize), 0.5);
  float nLenClamped = max(length(nStep / pxSize), 0.5);

  float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453) + blurParams.w;

  vec4 sum = vec4(0.0);
  const int MAX_SAMPLES = 16;
  int n = int(blurParams.z);
  for (int i = 0; i < MAX_SAMPLES; i++) {
    if (i >= n) break;
    float t = (float(i) + jitter) / float(n) - 0.5;     // -0.5 .. 0.5 across the shutter
    // Alternate between the tile-max direction and this pixel's own direction so
    // both "object smears over background" and "background smears" are reconstructed.
    vec2 dir = (mod(float(i), 2.0) < 1.0) ? nStep : cStep;
    vec2 uv = vUv + dir * t;
    vec3 s = texture2D(velocityBuffer, uv).xyz;
    float sLenPx = max(length(s.xy * blurParams.x * scale / pxSize), 0.5);
    float distPx = abs(t) * ((mod(float(i), 2.0) < 1.0) ? nLenClamped : cLenPx);

    float fg = softDepthCompare(centre.z, s.z);         // sample is in front of us
    float bg = softDepthCompare(s.z, centre.z);         // we are in front of sample
    float w = fg * cone(distPx, sLenPx)                 // blurry sample covers us
            + bg * cone(distPx, cLenPx)                 // we blur over the sample
            + cylinder(distPx, sLenPx) * cylinder(distPx, cLenPx) * 2.0;

    sum += vec4(texture2D(inputBuffer, uv).rgb, 1.0) * w;
  }

  vec4 base = texture2D(inputBuffer, vUv);
  vec3 result = (sum.a > 1e-4) ? sum.rgb / sum.a : base.rgb;
  gl_FragColor = vec4(result, base.a);
}`;
