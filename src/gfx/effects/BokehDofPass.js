import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Physically-parameterised depth of field with a real aperture.
 *
 * Circle of confusion comes straight from the thin-lens equation:
 *
 *     CoC = (A * f * |d - s|) / (d * (s - f)),   A = f / N
 *
 * with the focal length derived from the live camera FOV and a 24mm sensor height, so
 * zooming in physically deepens the blur instead of needing a magic number. An artistic
 * `bokehScale` sits on top because a 26mm game lens has essentially infinite depth of
 * field and would show nothing at all.
 *
 * Autofocus runs entirely on the GPU in a 1x1 ping-pong buffer — a centre-weighted
 * depth probe smoothed in log space, which is how a real lens travels. No readback, so
 * no pipeline stall.
 *
 * Gather uses the "spread" weighting rule: a tap contributes only if its own circle of
 * confusion actually reaches this pixel, and background taps are additionally gated on
 * the centre pixel being blurry too. That single term is what removes the bright halo
 * around in-focus silhouettes that naive DOF implementations always show.
 */
export default class BokehDofPass extends Pass {
  constructor(camera) {
    super('BokehDofPass');
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.camera = camera;

    const hdr = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.cocRT = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.bokehRT = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.fillRT = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.focusRT = [
      new THREE.WebGLRenderTarget(1, 1, { ...hdr, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      new THREE.WebGLRenderTarget(1, 1, { ...hdr, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    ];
    this._ping = 0;

    const base = { depthTest: false, depthWrite: false, blending: THREE.NoBlending, vertexShader: VERT };

    this.focusMat = new THREE.ShaderMaterial({
      ...base, name: 'DOF.Focus', fragmentShader: FOCUS_FRAG,
      uniforms: {
        depthBuffer: { value: null },
        prevBuffer: { value: null },
        cameraNearFar: { value: new THREE.Vector2(0.25, 12000) },
        // x: dt, y: speed, z: manual override (<=0 = auto), w: reset
        focusParams: { value: new THREE.Vector4(0.016, 6.0, -1, 1) },
        probe: { value: new THREE.Vector2(0.5, 0.5) },
      },
    });

    this.cocMat = new THREE.ShaderMaterial({
      ...base, name: 'DOF.CoC', fragmentShader: COC_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        depthBuffer: { value: null },
        focusBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        cameraNearFar: { value: new THREE.Vector2(0.25, 12000) },
        // x: focal length (m), y: f-number, z: sensor height (m), w: px per metre of sensor
        lens: { value: new THREE.Vector4(0.026, 2.0, 0.024, 45000) },
        // x: max CoC in half-res pixels, y: artistic scale, z: far-field floor
        cocParams: { value: new THREE.Vector3(11.0, 1.6, 0.0) },
      },
    });

    this.bokehMat = new THREE.ShaderMaterial({
      ...base, name: 'DOF.Bokeh', fragmentShader: BOKEH_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        // x: max CoC px, y: aperture blade shaping 0..1, z: blade rotation, w: frame jitter
        bokehParams: { value: new THREE.Vector4(11.0, 0.55, 0.35, 0) },
        rings: { value: 4 },
      },
    });

    this.fillMat = new THREE.ShaderMaterial({
      ...base, name: 'DOF.Fill', fragmentShader: FILL_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
      },
    });

    this.compositeMat = new THREE.ShaderMaterial({
      ...base, name: 'DOF.Composite', fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        bokehBuffer: { value: null },
        cocBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        halfTexelSize: { value: new THREE.Vector2() },
      },
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.cocMat);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._orthoCam = new THREE.OrthographicCamera();

    /** Public, physically meaningful controls. */
    this.fStop = 2.0;
    this.sensorHeight = 0.024;     // metres (full frame)
    this.bokehScale = 1.6;         // artistic multiplier on top of the physical CoC
    this.maxCoC = 11.0;            // half-res pixels
    this.focusSpeed = 6.0;
    this.bladeShape = 0.55;        // 0 = circular aperture, 1 = hard hexagon
    this.rings = 4;                // gather rings: 4 -> 60 taps, 3 -> 36, 2 -> 18
    this.focusOverride = -1;       // > 0 forces a focus distance in metres
    this._frame = 0;
    this._reset = 2;
  }

  /** Snap focus instantly — used after a camera cut. */
  reset() { this._reset = 2; }

  setSize(width, height) {
    this._w = width; this._h = height;
    const hw = Math.max(1, Math.round(width * 0.5));
    const hh = Math.max(1, Math.round(height * 0.5));
    this.cocRT.setSize(hw, hh);
    this.bokehRT.setSize(hw, hh);
    this.fillRT.setSize(hw, hh);
    this.cocMat.uniforms.texelSize.value.set(1 / width, 1 / height);
    this.bokehMat.uniforms.texelSize.value.set(1 / hw, 1 / hh);
    this.fillMat.uniforms.texelSize.value.set(1 / hw, 1 / hh);
    this.compositeMat.uniforms.texelSize.value.set(1 / width, 1 / height);
    this.compositeMat.uniforms.halfTexelSize.value.set(1 / hw, 1 / hh);
  }

  setDepthTexture(depthTexture) {
    this.focusMat.uniforms.depthBuffer.value = depthTexture;
    this.cocMat.uniforms.depthBuffer.value = depthTexture;
  }
  getDepthTexture() { return this.cocMat.uniforms.depthBuffer.value; }

  setDeltaTime(dt) {
    this.focusMat.uniforms.focusParams.value.x = Math.min(Math.max(dt, 1e-4), 0.25);
  }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this._orthoCam);
  }

  render(renderer, inputBuffer, outputBuffer) {
    const cam = this.camera;
    const near = cam.near, far = cam.far;

    // Focal length from the live vertical FOV: f = (h/2) / tan(fov/2).
    const fov = THREE.MathUtils.degToRad(cam.fov);
    const focal = (this.sensorHeight * 0.5) / Math.tan(fov * 0.5);
    const pxPerMetre = this._h / this.sensorHeight;

    // --- autofocus ---
    const fu = this.focusMat.uniforms;
    fu.cameraNearFar.value.set(near, far);
    fu.prevBuffer.value = this.focusRT[this._ping].texture;
    fu.focusParams.value.y = this.focusSpeed;
    fu.focusParams.value.z = this.focusOverride;
    fu.focusParams.value.w = this._reset > 0 ? 1 : 0;
    this._draw(renderer, this.focusMat, this.focusRT[this._ping ^ 1]);
    this._ping ^= 1;
    if (this._reset > 0) this._reset--;

    // --- CoC + half-res downsample ---
    const cu = this.cocMat.uniforms;
    cu.inputBuffer.value = inputBuffer.texture;
    cu.focusBuffer.value = this.focusRT[this._ping].texture;
    cu.cameraNearFar.value.set(near, far);
    cu.lens.value.set(focal, this.fStop, this.sensorHeight, pxPerMetre);
    cu.cocParams.value.set(this.maxCoC, this.bokehScale, 0.0);
    this._draw(renderer, this.cocMat, this.cocRT);

    // --- bokeh gather ---
    const bu = this.bokehMat.uniforms;
    bu.inputBuffer.value = this.cocRT.texture;
    bu.bokehParams.value.set(this.maxCoC, this.bladeShape, 0.35,
      (this._frame++ % 8) * 0.125);
    bu.rings.value = this.rings;
    this._draw(renderer, this.bokehMat, this.bokehRT);

    // --- fill (hides gather undersampling) ---
    this.fillMat.uniforms.inputBuffer.value = this.bokehRT.texture;
    this._draw(renderer, this.fillMat, this.fillRT);

    // --- composite at full res ---
    const pu = this.compositeMat.uniforms;
    pu.inputBuffer.value = inputBuffer.texture;
    pu.bokehBuffer.value = this.fillRT.texture;
    pu.cocBuffer.value = this.cocRT.texture;
    this._draw(renderer, this.compositeMat, this.renderToScreen ? null : outputBuffer);
  }

  dispose() {
    this.cocRT.dispose(); this.bokehRT.dispose(); this.fillRT.dispose();
    this.focusRT[0].dispose(); this.focusRT[1].dispose();
    this.focusMat.dispose(); this.cocMat.dispose(); this.bokehMat.dispose();
    this.fillMat.dispose(); this.compositeMat.dispose();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const DEPTH_HELPERS = /* glsl */`
uniform vec2 cameraNearFar;
float viewDistance(const in float d) {
  // Perspective depth -> positive distance along the view axis, in metres.
  float z = 2.0 * d - 1.0;
  return (2.0 * cameraNearFar.x * cameraNearFar.y)
       / (cameraNearFar.y + cameraNearFar.x - z * (cameraNearFar.y - cameraNearFar.x));
}`;

const FOCUS_FRAG = /* glsl */`
uniform highp sampler2D depthBuffer;
uniform sampler2D prevBuffer;
uniform vec4 focusParams;
uniform vec2 probe;
varying vec2 vUv;
${DEPTH_HELPERS}

void main() {
  float target;
  if (focusParams.z > 0.0) {
    target = focusParams.z;
  } else {
    // Five-point centre probe; take the nearest hit so the lens locks onto the
    // subject rather than the sky behind it.
    float d = viewDistance(texture2D(depthBuffer, probe).r);
    d = min(d, viewDistance(texture2D(depthBuffer, probe + vec2( 0.045, 0.0)).r));
    d = min(d, viewDistance(texture2D(depthBuffer, probe + vec2(-0.045, 0.0)).r));
    d = min(d, viewDistance(texture2D(depthBuffer, probe + vec2(0.0,  0.035)).r));
    d = min(d, viewDistance(texture2D(depthBuffer, probe + vec2(0.0, -0.035)).r));
    target = d;
  }
  target = clamp(target, 0.35, 900.0);

  float prev = texture2D(prevBuffer, vec2(0.5)).r;
  if (focusParams.w > 0.5 || !(prev > 0.0)) {
    gl_FragColor = vec4(target, 0.0, 0.0, 1.0);
    return;
  }
  // Focus travel is perceptually logarithmic: a rack from 2m to 4m feels the same
  // as 20m to 40m, so smooth the log of the distance.
  float k = 1.0 - exp(-focusParams.x * focusParams.y);
  float v = exp2(mix(log2(prev), log2(target), clamp(k, 0.0, 1.0)));
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

const COC_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform highp sampler2D depthBuffer;
uniform sampler2D focusBuffer;
uniform vec2 texelSize;
uniform vec4 lens;        // focal, fNumber, sensorHeight, pixelsPerMetre
uniform vec3 cocParams;   // maxCoC(half-res px), artistic scale, far floor
varying vec2 vUv;
${DEPTH_HELPERS}

float signedCoC(float dist, float focus) {
  float f = lens.x;
  float A = f / max(lens.y, 0.5);
  // Thin lens. Guard the degenerate case where the subject sits at the focal plane.
  float denom = max(dist * (focus - f), 1e-6);
  float coc = A * f * (dist - focus) / denom;   // metres on the sensor, signed
  float px = coc * lens.w * cocParams.y * 0.5;  // -> half-res pixels
  return clamp(px, -cocParams.x, cocParams.x);
}

void main() {
  float focus = texture2D(focusBuffer, vec2(0.5)).r;
  vec2 o = texelSize;
  // Box-average the four full-res texels this half-res texel covers, and take the
  // CoC of the *nearest* of them so thin foreground edges keep their blur.
  vec3 c = texture2D(inputBuffer, vUv + vec2(-o.x, -o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2(o.x, -o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2(-o.x, o.y) * 0.5).rgb;
  c += texture2D(inputBuffer, vUv + vec2(o.x, o.y) * 0.5).rgb;
  c *= 0.25;

  float d0 = viewDistance(texture2D(depthBuffer, vUv + vec2(-o.x, -o.y) * 0.5).r);
  float d1 = viewDistance(texture2D(depthBuffer, vUv + vec2(o.x, -o.y) * 0.5).r);
  float d2 = viewDistance(texture2D(depthBuffer, vUv + vec2(-o.x, o.y) * 0.5).r);
  float d3 = viewDistance(texture2D(depthBuffer, vUv + vec2(o.x, o.y) * 0.5).r);
  float dist = min(min(d0, d1), min(d2, d3));

  float coc = signedCoC(dist, focus);
  gl_FragColor = vec4(c, coc / cocParams.x * 0.5 + 0.5);
}`;

const BOKEH_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 texelSize;
uniform vec4 bokehParams;   // maxCoC, blade shape, blade rotation, frame jitter
uniform float rings;
varying vec2 vUv;

#define MAX_RINGS 4
#define PI 3.14159265359

// Radial extent of a regular hexagon at a given angle (circumradius 1).
float apertureRadius(float ang) {
  float a = mod(ang + bokehParams.z, PI / 3.0) - PI / 6.0;
  float hex = 0.8660254 / cos(a);
  return mix(1.0, hex, bokehParams.y);
}

void main() {
  vec4 centre = texture2D(inputBuffer, vUv);
  float maxCoC = bokehParams.x;
  float centreCoC = (centre.a * 2.0 - 1.0) * maxCoC;

  // Early-out probe. Most of a cinematic frame is in focus, and a 60-tap gather over
  // an in-focus pixel is 60 taps spent proving nothing changed. Four taps at most of
  // the kernel radius catch both "this pixel is sharp" and "nothing near it is
  // spilling onto it", which is the condition the full gather would have to respect
  // anyway. Costs 4 fetches, saves 56 on the majority of the screen.
  {
    float probeR = maxCoC * 0.72;
    float m = abs(centreCoC);
    m = max(m, abs((texture2D(inputBuffer, vUv + vec2( probeR,  probeR) * texelSize).a * 2.0 - 1.0) * maxCoC));
    m = max(m, abs((texture2D(inputBuffer, vUv + vec2(-probeR,  probeR) * texelSize).a * 2.0 - 1.0) * maxCoC));
    m = max(m, abs((texture2D(inputBuffer, vUv + vec2( probeR, -probeR) * texelSize).a * 2.0 - 1.0) * maxCoC));
    m = max(m, abs((texture2D(inputBuffer, vUv + vec2(-probeR, -probeR) * texelSize).a * 2.0 - 1.0) * maxCoC));
    if (m < 1.0) { gl_FragColor = vec4(centre.rgb, 0.0); return; }
  }

  // Seed the background accumulator with this pixel: it always covers itself, and it
  // guarantees the divisor can never reach zero (a black frame is not an option here).
  vec4 bg = vec4(centre.rgb, 1.0);
  vec4 fg = vec4(0.0);

  // Per-pixel angular dither breaks the ring pattern into noise the fill pass eats.
  float dither = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453)
               + bokehParams.w;

  for (int r = 1; r <= MAX_RINGS; r++) {
    if (float(r) > rings) break;
    float rf = float(r) / rings;
    int count = r * 6;
    for (int s = 0; s < 24; s++) {
      if (s >= count) break;
      float ang = (float(s) / float(count) + dither * 0.25) * PI * 2.0;
      vec2 dir = vec2(cos(ang), sin(ang));
      float rad = rf * apertureRadius(ang) * maxCoC;
      vec2 off = dir * rad * texelSize;
      vec4 t = texture2D(inputBuffer, vUv + off);
      float tCoC = (t.a * 2.0 - 1.0) * maxCoC;

      // Background: the tap only reaches us if its own circle covers this pixel AND
      // this pixel is itself defocused. Without the min() term, sharp silhouettes
      // pick up a bright halo from the blurry background behind them.
      float bw = clamp(max(min(centreCoC, tCoC), 0.0) - rad + 1.0, 0.0, 1.0);
      bg += vec4(t.rgb, 1.0) * bw;

      // Foreground: anything in front of the focal plane spreads freely, including
      // over pixels that are perfectly sharp. That is what makes near blur read right.
      float fw = clamp(-tCoC - rad + 1.0, 0.0, 1.0) * step(tCoC, 0.0);
      fg += vec4(t.rgb, 1.0) * fw;
    }
  }

  vec3 bgCol = bg.rgb / max(bg.a, 1e-4);
  vec3 fgCol = fg.rgb / max(fg.a, 1e-4);
  // Coverage: 61 taps over a disc of radius maxCoC; normalise so a fully-covering
  // near-field blur reaches alpha 1 and anything less feathers out.
  float alpha = clamp(fg.a / (rings * 6.0), 0.0, 1.0);
  gl_FragColor = vec4(mix(bgCol, fgCol, alpha), alpha);
}`;

const FILL_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 texelSize;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(inputBuffer, vUv) * 0.25;
  c += texture2D(inputBuffer, vUv + vec2( texelSize.x, 0.0)) * 0.125;
  c += texture2D(inputBuffer, vUv + vec2(-texelSize.x, 0.0)) * 0.125;
  c += texture2D(inputBuffer, vUv + vec2(0.0,  texelSize.y)) * 0.125;
  c += texture2D(inputBuffer, vUv + vec2(0.0, -texelSize.y)) * 0.125;
  c += texture2D(inputBuffer, vUv + texelSize) * 0.0625;
  c += texture2D(inputBuffer, vUv - texelSize) * 0.0625;
  c += texture2D(inputBuffer, vUv + vec2( texelSize.x, -texelSize.y)) * 0.0625;
  c += texture2D(inputBuffer, vUv + vec2(-texelSize.x,  texelSize.y)) * 0.0625;
  gl_FragColor = c;
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D bokehBuffer;
uniform sampler2D cocBuffer;
uniform vec2 texelSize;
uniform vec2 halfTexelSize;
varying vec2 vUv;

void main() {
  vec4 sharp = texture2D(inputBuffer, vUv);
  vec4 blur = texture2D(bokehBuffer, vUv);
  float coc = (texture2D(cocBuffer, vUv).a * 2.0 - 1.0);

  // Far field only starts once the circle of confusion is worth more than a pixel,
  // otherwise the half-res upsample would quietly soften the whole in-focus frame.
  // Near field is driven by the gather's own coverage so it spills over sharp geometry.
  float far = smoothstep(0.06, 0.40, coc);
  float m = max(far, blur.a);
  gl_FragColor = vec4(mix(sharp.rgb, blur.rgb, clamp(m, 0.0, 1.0)), sharp.a);
}`;
