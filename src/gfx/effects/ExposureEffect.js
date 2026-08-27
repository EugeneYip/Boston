import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * Scene-referred sensor stage: eye adaptation, exposure compensation, white balance and
 * natural (cos^4) lens vignetting. Runs *before* the tone mapper, which is the only place
 * these operations are physically meaningful — white balancing after a tone curve bends
 * the highlight roll-off and produces the classic "coloured mud" look.
 *
 * The adapted luminance arrives as a 1x1 texture from AutoExposurePass so no GPU->CPU
 * readback is needed.
 */
export default class ExposureEffect extends Effect {
  constructor() {
    super('ExposureEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['adaptedLuminance', new THREE.Uniform(null)],
        // x: key value (target middle grey), y: manual exposure, z: EV bias, w: auto blend
        ['exposureParams', new THREE.Uniform(new THREE.Vector4(0.20, 1.0, 0.0, 1.0))],
        ['wbGains', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        // x: vignette strength, y: falloff, z: highlight desaturation
        ['lensParams', new THREE.Uniform(new THREE.Vector3(0.55, 0.42, 0.14))],
        // x: shadow contrast (1 = untouched), y: toe width in stops
        ['toeParams', new THREE.Uniform(new THREE.Vector2(1.0, 7.0))],
      ]),
    });
  }

  set luminanceTexture(t) { this.uniforms.get('adaptedLuminance').value = t; }

  /**
   * @param {number} key - target middle grey the metered scene is mapped to
   * @param {number} manual - user exposure multiplier (ctx.settings.exposure)
   * @param {number} evBias - look-driven EV compensation
   * @param {number} autoBlend - 0 = fully manual, 1 = fully automatic
   */
  setExposure(key, manual, evBias, autoBlend) {
    const v = this.uniforms.get('exposureParams').value;
    v.set(key, manual, evBias, autoBlend);
  }

  setWhiteBalance(r, g, b) { this.uniforms.get('wbGains').value.set(r, g, b); }

  setLens(vignette, falloff, highlightDesat) {
    this.uniforms.get('lensParams').value.set(vignette, falloff, highlightDesat);
  }

  /**
   * Shadow recovery, applied in log-luminance space *before* the tone curve.
   *
   * AgX clips to zero at roughly 5.5 stops below the metered key, so anything deeper
   * than that becomes flat black no matter what the grade does afterwards. Rather than
   * lifting the black point — which turns black into flat grey and destroys what
   * little separation is left — this compresses the shadow range toward the key, the
   * way a shadow-recovery slider does: a pixel 7 stops down at contrast 0.8 lands 5.6
   * stops down and survives the curve with its ordering intact.
   *
   * @param {number} contrast - 1 = off, < 1 recovers shadows
   * @param {number} widthStops - how far below the key the effect ramps in over
   */
  setShadowRecovery(contrast, widthStops = 7) {
    this.uniforms.get('toeParams').value.set(contrast, Math.max(widthStops, 0.5));
  }
}

const FRAG = /* glsl */`
uniform sampler2D adaptedLuminance;
uniform vec4 exposureParams;
uniform vec3 wbGains;
uniform vec3 lensParams;
uniform vec2 toeParams;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float avgLog = texture2D(adaptedLuminance, vec2(0.5)).r;
  float autoExposure = exposureParams.x / max(exp2(avgLog), 1e-5);
  float exposure = mix(1.0, autoExposure, exposureParams.w)
                 * exposureParams.y * exp2(exposureParams.z);

  vec3 c = max(inputColor.rgb, vec3(0.0)) * exposure;
  c *= wbGains;

  // Shadow recovery in log space. Scales all three channels by one factor so hue is
  // untouched, and ramps in smoothly so there is no kink at the key.
  if (toeParams.x < 0.999) {
    float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
    float d = log2(L) - log2(max(exposureParams.x, 1e-4));   // stops below middle grey
    if (d < 0.0) {
      float t = clamp(-d / toeParams.y, 0.0, 1.0);
      float w = t * t * (3.0 - 2.0 * t);
      c *= exp2(d * mix(1.0, toeParams.x, w) - d);
    }
  }

  // Natural vignetting: irradiance at the sensor falls off with cos^4 of the field
  // angle. Cheap approximation, and unlike an LDR overlay it darkens light rather
  // than painting grey on top, so bright sources still punch through the corners.
  vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
  float cosTerm = 1.0 / (1.0 + dot(d, d) * lensParams.y * 4.0);
  cosTerm *= cosTerm;
  c *= mix(1.0, cosTerm, lensParams.x);

  // Film-like highlight desaturation: very hot values drift toward the white point
  // before the tone mapper sees them, which stops saturated emissives clipping to
  // pure primaries.
  float m = max(c.r, max(c.g, c.b));
  float w = smoothstep(1.0, 8.0, m) * lensParams.z;
  c = mix(c, vec3(m), w);

  outputColor = vec4(c, inputColor.a);
}`;
