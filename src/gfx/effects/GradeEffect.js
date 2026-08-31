import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * Display-referred colour grade. Runs immediately after the tone mapper on linear
 * display values, but does its work in a ~2.2 gamma space because that is where
 * lift/gamma/gain and tone curves behave the way a colourist expects.
 *
 * Order matches a DI grade: black/white point -> contrast about a pivot -> SOP
 * (slope/offset/power, per channel) -> per-channel region curves -> split toning ->
 * saturation / vibrance with a film-style chroma loss in the toe.
 *
 * Parameters come from ColorGrade, which blends authored looks by time of day and
 * weather, so nothing here needs to know about the world state.
 */
export default class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['gBlack', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gWhite', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gContrast', new THREE.Uniform(new THREE.Vector2(1, 0.435))],
        ['gLift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gGammaInv', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gCurveR', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gCurveG', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gCurveB', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gShadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gMidTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gHighTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        // x: saturation, y: vibrance, z: shadow saturation
        ['gSat', new THREE.Uniform(new THREE.Vector3(1, 0, 1))],
        // Highlight shoulder knee. 1.0 = the old hard clamp.
        ['gShoulder', new THREE.Uniform(0.86)],
      ]),
    });
    this._v3 = new THREE.Vector3();
  }

  /**
   * Where the display-referred highlight rolloff starts.
   *
   * The grade's contrast term is a straight line through a pivot, so it has constant
   * gain right up to the moment the output is clamped — and then zero gain. Measured
   * at `st_southend` (11:12 clear): AgX hands this stage a sky that tops out at 0.963
   * with a standard deviation of 25/255 across the sky region, i.e. a properly
   * rolled-off highlight with real structure in it. Contrast 1.131 about pivot 0.435
   * maps everything above 0.930 to >= 1.0, and `clamp()` then flattens the top 7% of
   * AgX's output range onto a single value. Ablating the contrast to 1.0 took the
   * frame's clipped fraction from 1.55% to 0.00% and the sky's from 12.9% to 0.00%,
   * which is what identifies this stage — not the exposure, and not the tone curve —
   * as where the paper-white sky window is created. Only 0.005% of that frame ever
   * reaches AgX's own clip point.
   *
   * So: keep the contrast, and give the top of the range a shoulder instead of a wall.
   * Below the knee nothing changes at all, which is why the look survives; above it,
   * values approach 1.0 asymptotically, so a genuine specular still reaches white
   * while a bright sky lands in the 240s with its gradient intact.
   *
   * @param {number} knee - display value where the rolloff begins; 1 restores the clamp
   */
  setShoulder(knee) {
    this.uniforms.get('gShoulder').value = Math.min(Math.max(knee, 0.1), 1.0);
  }

  /**
   * Push a blended look from ColorGrade into the shader uniforms.
   * Values are clamped so a bad look can never produce a black or blown frame.
   *
   * @param {object} k - a look object (see ColorGrade.NEUTRAL)
   */
  applyLook(k) {
    const u = this.uniforms;
    const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const setV = (name, a, lo, hi) => {
      u.get(name).value.set(cl(a[0], lo, hi), cl(a[1], lo, hi), cl(a[2], lo, hi));
    };

    // Guarantee a usable range: black must stay below white by a healthy margin.
    const b = k.blackPoint, w = k.whitePoint;
    u.get('gBlack').value.set(cl(b[0], -0.1, 0.25), cl(b[1], -0.1, 0.25), cl(b[2], -0.1, 0.25));
    u.get('gWhite').value.set(cl(w[0], 0.5, 1.5), cl(w[1], 0.5, 1.5), cl(w[2], 0.5, 1.5));
    u.get('gContrast').value.set(cl(k.contrast, 0.5, 2.0), cl(k.pivot, 0.2, 0.7));
    setV('gLift', k.lift, -0.15, 0.25);
    const g = k.gamma;
    u.get('gGammaInv').value.set(
      1 / cl(g[0], 0.4, 2.5), 1 / cl(g[1], 0.4, 2.5), 1 / cl(g[2], 0.4, 2.5));
    setV('gGain', k.gain, 0.4, 2.0);
    setV('gCurveR', k.curveR, -0.2, 0.2);
    setV('gCurveG', k.curveG, -0.2, 0.2);
    setV('gCurveB', k.curveB, -0.2, 0.2);
    setV('gShadowTint', k.shadowTint, 0.4, 1.8);
    setV('gMidTint', k.midTint, 0.4, 1.8);
    setV('gHighTint', k.highTint, 0.4, 1.8);
    u.get('gSat').value.set(
      cl(k.saturation, 0, 2.5), cl(k.vibrance, -1, 1.5), cl(k.shadowSat, 0, 1.5));
  }
}

const FRAG = /* glsl */`
uniform vec3 gBlack, gWhite, gLift, gGammaInv, gGain;
uniform vec2 gContrast;
uniform vec3 gCurveR, gCurveG, gCurveB;
uniform vec3 gShadowTint, gMidTint, gHighTint;
uniform vec3 gSat;
uniform float gShoulder;

// Highlight rolloff. Identity below the knee, and above it an exponential approach to
// 1.0 with unit slope at the knee, so the curve is C1-continuous and the look below the
// knee is bit-identical to the old clamp. Nothing can exceed 1.0, so the "clamp" is now
// a limit rather than a wall.
// NOTE the max() on the exponent argument. The obvious mix(x, s, step(k, x)) form
// evaluates s for every pixel, and at knee 1.0 that is 0.0 * exp(+large) = 0 * inf =
// NaN, which mix() then propagates through the untaken branch: measured, it took the
// frame to mean 13.5 with 89.6% of it black. Clamping the exponent to <= 0 keeps the
// expression finite everywhere, and min() does the branch without a select.
vec3 shoulder(vec3 x, float k) {
  float w = max(1.0 - k, 1e-3);
  vec3 t = max(x - k, vec3(0.0));
  return min(x, 1.0 - w * exp(-t / w));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, vec3(0.0));
  c = pow(c, vec3(0.45454545));                       // linear -> ~gamma space

  c = (c - gBlack) / max(gWhite - gBlack, vec3(0.05));
  c = (c - gContrast.y) * gContrast.x + gContrast.y;
  c = c * gGain + gLift;
  c = sign(c) * pow(abs(c), gGammaInv);

  // Tone regions, evaluated per channel so the curves really are per-channel.
  vec3 ws = clamp(1.0 - c * 2.0, 0.0, 1.0); ws *= ws;
  vec3 wh = clamp(c * 2.0 - 1.0, 0.0, 1.0); wh *= wh;
  vec3 wm = max(vec3(0.0), 1.0 - ws - wh);

  c.r += dot(gCurveR, vec3(ws.r, wm.r, wh.r));
  c.g += dot(gCurveG, vec3(ws.g, wm.g, wh.g));
  c.b += dot(gCurveB, vec3(ws.b, wm.b, wh.b));

  c *= gShadowTint * ws + gMidTint * wm + gHighTint * wh;
  // Floor only. The top is left uncompressed until after saturation so the rolloff is
  // applied exactly once, at the end of the chain.
  c = max(c, vec3(0.0));

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  // Vibrance only lifts what is already dull, so skies and skin stay believable.
  float s = gSat.x + gSat.y * (1.0 - chroma) * (1.0 - chroma);
  s *= mix(gSat.z, 1.0, smoothstep(0.0, 0.34, luma));
  c = max(luma + (c - luma) * s, vec3(0.0));

  c = clamp(shoulder(c, gShoulder), 0.0, 1.0);

  outputColor = vec4(pow(c, vec3(2.2)), inputColor.a);
}`;
