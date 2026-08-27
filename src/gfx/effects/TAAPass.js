import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Temporal anti-aliasing.
 *
 * SMAA is a morphological filter: it can only reason about the edges it can see in one
 * frame, which is exactly the wrong tool for a city full of railings, wires and window
 * mullions that are thinner than a pixel. TAA integrates a jittered sample per frame
 * instead, so sub-pixel geometry resolves properly and stops crawling.
 *
 * The parts that make it not ghost:
 *  - **Velocity dilation.** Each pixel adopts the velocity of the closest-depth sample
 *    in a 3x3 neighbourhood, so silhouettes reproject with the foreground's motion
 *    rather than the background's.
 *  - **Catmull-Rom history resampling.** Bilinear resampling of the history is what
 *    makes most TAA implementations look like vaseline; a 9-tap Catmull-Rom keeps it
 *    sharp.
 *  - **YCoCg variance clipping.** The history is clipped to an ellipsoid around the
 *    local colour distribution, which rejects the stale colour of anything that just
 *    became visible.
 *  - **Disocclusion + off-screen rejection**, and a velocity-scaled feedback floor so
 *    fast-moving vehicles converge in a couple of frames instead of trailing.
 */
export default class TAAPass extends Pass {
  constructor(camera, frameState, velocityPass) {
    super('TAAPass');
    this.needsSwap = true;
    this.camera = camera;
    this.frameState = frameState;
    this.velocityPass = velocityPass;

    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.history = [
      new THREE.WebGLRenderTarget(1, 1, opts),
      new THREE.WebGLRenderTarget(1, 1, opts),
    ];
    this._ping = 0;
    this._valid = false;

    this.material = new THREE.ShaderMaterial({
      name: 'TAA.Resolve',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        inputBuffer: { value: null },
        historyBuffer: { value: null },
        velocityBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        // x: min feedback, y: max feedback, z: variance gamma, w: history valid
        taaParams: { value: new THREE.Vector4(0.86, 0.97, 1.25, 0) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'TAA.Copy',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { inputBuffer: { value: null } },
      vertexShader: VERT,
      fragmentShader: COPY_FRAG,
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.material);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._orthoCam = new THREE.OrthographicCamera();
  }

  /** Drop the history — call after a camera cut or a resolution change. */
  reset() { this._valid = false; }

  setSize(width, height) {
    this.history[0].setSize(width, height);
    this.history[1].setSize(width, height);
    this.material.uniforms.texelSize.value.set(1 / width, 1 / height);
    this._valid = false;
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this._orthoCam);
  }

  render(renderer, inputBuffer, outputBuffer) {
    const u = this.material.uniforms;
    u.inputBuffer.value = inputBuffer.texture;
    u.historyBuffer.value = this.history[this._ping].texture;
    u.velocityBuffer.value = this.velocityPass.texture;
    u.taaParams.value.w = this._valid ? 1 : 0;

    const next = this.history[this._ping ^ 1];
    this._draw(renderer, this.material, next);
    this._ping ^= 1;
    this._valid = true;

    // Blit the resolved frame onward. The history buffer must stay untouched by the
    // rest of the chain, so it cannot simply be handed over as the output buffer.
    this.copyMaterial.uniforms.inputBuffer.value = next.texture;
    this._draw(renderer, this.copyMaterial, this.renderToScreen ? null : outputBuffer);
  }

  dispose() {
    this.history[0].dispose(); this.history[1].dispose();
    this.material.dispose(); this.copyMaterial.dispose();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const COPY_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(inputBuffer, vUv); }`;

const FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D historyBuffer;
uniform sampler2D velocityBuffer;
uniform vec2 texelSize;
uniform vec4 taaParams;
varying vec2 vUv;

/**
 * Reversible range compression. Neighbourhood statistics computed on raw HDR are
 * dominated by whatever the brightest sample in the 3x3 happens to be, which makes the
 * clip box useless. Compressing first, clipping, then expanding fixes that.
 */
vec3 tonemapTAA(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 untonemapTAA(vec3 c) { return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4); }

vec3 rgb2ycocg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5 * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycocg2rgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** Catmull-Rom history fetch: 5 bilinear taps approximating the 4x4 kernel. */
vec4 sampleHistory(vec2 uv) {
  vec2 texSize = 1.0 / texelSize;
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) * texelSize;
  vec2 texPos3 = (texPos1 + 2.0) * texelSize;
  vec2 texPos12 = (texPos1 + offset12) * texelSize;

  vec4 result = vec4(0.0);
  result += texture2D(historyBuffer, vec2(texPos12.x, texPos0.y)) * w12.x * w0.y;
  result += texture2D(historyBuffer, vec2(texPos0.x, texPos12.y)) * w0.x * w12.y;
  result += texture2D(historyBuffer, texPos12) * w12.x * w12.y;
  result += texture2D(historyBuffer, vec2(texPos3.x, texPos12.y)) * w3.x * w12.y;
  result += texture2D(historyBuffer, vec2(texPos12.x, texPos3.y)) * w12.x * w3.y;
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return result / max(wsum, 1e-5);
}

void main() {
  vec4 current = texture2D(inputBuffer, vUv);

  if (taaParams.w < 0.5) {
    gl_FragColor = current;
    return;
  }

  // --- velocity dilation: adopt the nearest surface's motion ---
  vec2 bestVel = texture2D(velocityBuffer, vUv).xy;
  float bestDepth = texture2D(velocityBuffer, vUv).z;
  for (int i = 0; i < 4; i++) {
    vec2 o = (i == 0) ? vec2(-1.0, -1.0) :
             (i == 1) ? vec2( 1.0, -1.0) :
             (i == 2) ? vec2(-1.0,  1.0) : vec2(1.0, 1.0);
    vec3 s = texture2D(velocityBuffer, vUv + o * texelSize).xyz;
    if (s.z < bestDepth) { bestDepth = s.z; bestVel = s.xy; }
  }

  vec2 prevUv = vUv - bestVel;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    gl_FragColor = current;
    return;
  }

  // --- neighbourhood statistics in YCoCg ---
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 nMin = vec3(1e9), nMax = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = rgb2ycocg(tonemapTAA(max(
        texture2D(inputBuffer, vUv + vec2(float(x), float(y)) * texelSize).rgb, vec3(0.0))));
      m1 += c; m2 += c * c;
      nMin = min(nMin, c); nMax = max(nMax, c);
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
  vec3 lo = max(mean - taaParams.z * sigma, nMin);
  vec3 hi = min(mean + taaParams.z * sigma, nMax);

  vec4 hist = sampleHistory(prevUv);
  vec3 histY = rgb2ycocg(tonemapTAA(max(hist.rgb, vec3(0.0))));

  // Clip toward the neighbourhood centre rather than clamping per channel: clamping
  // shifts hue on rejection, clipping does not.
  vec3 centre = 0.5 * (lo + hi);
  vec3 extent = max(0.5 * (hi - lo), vec3(1e-5));
  vec3 delta = histY - centre;
  vec3 unit = abs(delta / extent);
  float maxUnit = max(unit.x, max(unit.y, unit.z));
  float clipAmount = 0.0;
  if (maxUnit > 1.0) { histY = centre + delta / maxUnit; clipAmount = 1.0; }

  vec3 histRgb = untonemapTAA(clamp(ycocg2rgb(histY), vec3(0.0), vec3(0.999)));

  // Feedback: high when still (max convergence), low when moving fast or when the
  // history had to be clipped hard (disocclusion) so trailing cannot build up.
  float speed = length(bestVel / texelSize);            // pixels per frame
  float feedback = mix(taaParams.y, taaParams.x, clamp(speed / 24.0, 0.0, 1.0));
  feedback = mix(feedback, taaParams.x, clipAmount * 0.6);

  // Tone-mapped weighting: keeps a single very bright sample from dominating the
  // temporal average and flickering.
  float wc = 1.0 / (1.0 + dot(current.rgb, vec3(0.2126, 0.7152, 0.0722)));
  float wh = 1.0 / (1.0 + dot(histRgb, vec3(0.2126, 0.7152, 0.0722)));
  float a = feedback * wh;
  float b = (1.0 - feedback) * wc;
  vec3 outColor = (histRgb * a + current.rgb * b) / max(a + b, 1e-5);

  gl_FragColor = vec4(outColor, current.a);
}`;
