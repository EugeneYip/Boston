import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';

/**
 * Final optical stage: lateral chromatic aberration plus a contrast-adaptive sharpen.
 *
 * The aberration is radial (zero on axis, growing toward the corners) like a real lens,
 * and scales with the aperture the exposure stage is implying — a dark scene means a
 * wide-open aperture, which means visibly more colour fringing. Constant CA is a tell.
 *
 * ## How strong it is allowed to be
 *
 * A real fast prime at 1080p puts well under a pixel of lateral colour on the corner
 * and nothing measurable in the middle third. This effect used to put **1.73 px per
 * channel (3.51 px red-to-blue) at the frame edge in daylight and 2.19 px (4.3-5.0 px
 * measured red-to-blue) across the whole outer band at night** — enough to turn every
 * cable, pole and body crease into a magenta/cyan sandwich and the Zakim stays into a
 * dashed rainbow. It read as a browser demo, and it was an automatic fail.
 *
 * Two separate faults, both fixed below: the radial term saturated at maximum from 62%
 * of the way out to the corner instead of peaking only at the corner, and the base
 * offset was ~3x what a lens does. The dial that matters is `finalParams.x`, which is
 * now defined as *the offset at the corner*, in pixels; treat anything above ~0.6 as a
 * stylistic choice rather than an optical one.
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
        // x: CA in pixels AT THE CORNER, y: aperture coupling, z: radial power,
        // w: sharpness
        ['finalParams', new THREE.Uniform(new THREE.Vector4(0.35, 0.10, 3.0, 0.0))],
        // Ceiling on the aperture term. This used to be unbounded, which was harmless
        // only because the metering clamp had `adaptedLuminance` frozen at -3.6 in
        // every shot: the aperture scale was a constant 1.87 and nobody noticed it was
        // a free variable. With the clamp fixed the meter runs down to about -8 at
        // night, which drove the same expression to 2.8 and put nearly 3 px of
        // fringing on every corner of a night frame. Capping it at 1.9 stopped the
        // runaway but left the *daylight* value — which was the real problem — alone.
        // 1.3 keeps the night/day difference visible without doubling the fringe.
        ['apertureMax', new THREE.Uniform(1.3)],
      ]),
    });
  }

  set luminanceTexture(t) { this.uniforms.get('adaptedLuminance').value = t; }
  set sharpness(v) { this.uniforms.get('finalParams').value.w = v; }
  get sharpness() { return this.uniforms.get('finalParams').value.w; }
  /** @param {number} px - per-channel radial offset in pixels AT THE FRAME CORNER */
  set aberration(px) { this.uniforms.get('finalParams').value.x = px; }
  get aberration() { return this.uniforms.get('finalParams').value.x; }
  /** @param {number} v - how sharply CA falls off toward the centre (>= 1) */
  set aberrationFalloff(v) { this.uniforms.get('finalParams').value.z = Math.max(1, v); }
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
  // r is 0 on axis and EXACTLY 1 at the corner. The old normalisation was
  // 'length(d * vec2(aspect,1.0)) * 1.4142', which on a 16:9 frame reaches 1.0 at
  // uv.x = 0.898 — so 'clamp(r, 0, 1)' flattened the profile to its maximum across the
  // whole outer ~20% of the frame and both frame edge and corner carried the identical
  // offset. That is the opposite of a lens: measured, it put 1.73 px per channel
  // (3.51 px red-to-blue) on the horizontal edge midway up the frame at 'bridge', and
  // 2.19 px per channel across the entire outer band at night. Dividing by the true
  // corner radius removes the plateau; 'finalParams.z' then decides how fast it decays
  // inward, and at 3.0 the offset is under a tenth of a pixel inside half-radius.
  float rCorner = 0.5 * sqrt(aspect * aspect + 1.0);
  float r = length(d * vec2(aspect, 1.0)) / rCorner;
  float mag = pow(clamp(r, 0.0, 1.0), finalParams.z) * finalParams.x * apertureScale;
  // Below a twentieth of a pixel the bilinear tap is indistinguishable from no tap at
  // all, so skip the fringe entirely rather than paying for a no-op on most of the frame.
  if (mag < 0.05) { outputColor = vec4(c, inputColor.a); return; }
  vec2 off = normalize(d + vec2(1e-6)) * mag * texelSize;

  // Safe under the branch above: the composer's buffers are LinearFilter with no
  // mipmaps, so there is no implicit LOD for non-uniform control flow to make
  // undefined — the tap is a plain bilinear fetch either way.
  float cr = texture2D(inputBuffer, uv + off).r;
  float cb = texture2D(inputBuffer, uv - off).b;
  // Green is left on the sharpened result, so the sharpen survives on the luma axis.
  outputColor = vec4(cr, c.g, cb, inputColor.a);
}`;
