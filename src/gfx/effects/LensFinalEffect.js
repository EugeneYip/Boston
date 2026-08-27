import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';

/**
 * Final optical stage: lateral chromatic aberration plus a contrast-adaptive sharpen.
 *
 * The aberration is radial (zero on axis, growing toward the corners) like a real lens,
 * and scales with the aperture the exposure stage is implying — a dark scene means a
 * wide-open aperture, which means visibly more colour fringing. Constant CA is a tell.
 *
 * The sharpen is an AMD-CAS-style adaptive filter. It exists mostly to claw back the
 * softness TAA introduces; with TAA off it is dialled down to almost nothing.
 *
 * Samples the input buffer at offsets, so this is a CONVOLUTION effect and always gets
 * its own pass.
 */
export default class LensFinalEffect extends Effect {
  constructor() {
    super('LensFinalEffect', FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['adaptedLuminance', new THREE.Uniform(null)],
        // x: base CA in pixels, y: ISO/aperture scale, z: radial power, w: sharpness
        ['finalParams', new THREE.Uniform(new THREE.Vector4(1.15, 0.22, 2.0, 0.0))],
        // Ceiling on the aperture term. This used to be unbounded, which was harmless
        // only because the metering clamp had `adaptedLuminance` frozen at -3.6 in
        // every shot: the aperture scale was a constant 1.87 and nobody noticed it was
        // a free variable. With the clamp fixed the meter runs down to about -8 at
        // night, which drove the same expression to 2.8 and put nearly 3 px of
        // fringing on every corner of a night frame. 1.9 keeps the day look identical
        // and stops night running away.
        ['apertureMax', new THREE.Uniform(1.9)],
      ]),
    });
  }

  set luminanceTexture(t) { this.uniforms.get('adaptedLuminance').value = t; }
  set sharpness(v) { this.uniforms.get('finalParams').value.w = v; }
  get sharpness() { return this.uniforms.get('finalParams').value.w; }
  /** @param {number} px - fringe width in pixels at the frame corner */
  set aberration(px) { this.uniforms.get('finalParams').value.x = px; }
  /** @param {number} v - ceiling on the low-light aperture multiplier (>= 1) */
  set apertureMax(v) { this.uniforms.get('apertureMax').value = Math.max(1, v); }
}

const FRAG = /* glsl */`
uniform sampler2D adaptedLuminance;
uniform vec4 finalParams;
uniform float apertureMax;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;

  // --- contrast adaptive sharpen -------------------------------------------------
  if (finalParams.w > 0.001) {
    vec3 n = texture2D(inputBuffer, uv + vec2(0.0,  texelSize.y)).rgb;
    vec3 s = texture2D(inputBuffer, uv - vec2(0.0,  texelSize.y)).rgb;
    vec3 e = texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
    vec3 w = texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb;
    vec3 mn = min(min(n, s), min(e, w));
    vec3 mx = max(max(n, s), max(e, w));
    // Sharpen less where the neighbourhood is already high contrast: no ringing.
    vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
    amp = sqrt(amp) * finalParams.w;
    vec3 sharpened = c + amp * (4.0 * c - n - s - e - w);
    // Hard clamp to the local range kills halos at silhouette edges.
    c = clamp(sharpened, min(mn, c), max(mx, c));
  }

  // --- lateral chromatic aberration ----------------------------------------------
  float avgLog = texture2D(adaptedLuminance, vec2(0.5)).r;
  float stopsUnder = clamp(0.35 - avgLog, 0.0, 8.0);
  float apertureScale = min(1.0 + stopsUnder * finalParams.y, apertureMax);

  vec2 d = uv - 0.5;
  float r = length(d * vec2(aspect, 1.0)) * 1.4142;
  float mag = pow(clamp(r, 0.0, 1.0), finalParams.z) * finalParams.x * apertureScale;
  vec2 off = normalize(d + vec2(1e-6)) * mag * texelSize;

  float cr = texture2D(inputBuffer, uv + off).r;
  float cb = texture2D(inputBuffer, uv - off).b;
  // Blend in, rather than replacing, so the sharpen result survives on the green axis.
  vec3 fringed = vec3(cr, c.g, cb);
  outputColor = vec4(mix(c, fringed, step(0.0001, mag)), inputColor.a);
}`;
