import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * Film/sensor grain that responds to exposure the way a real camera does: the darker the
 * metered scene, the higher the ISO the "camera" is running at, and the coarser and
 * stronger the grain becomes. A constant-amplitude noise overlay is one of the fastest
 * ways to make a frame read as a tech demo, so this samples the same adapted-luminance
 * texture the exposure stage uses and derives an ISO from it.
 *
 * Grain amplitude also follows the classic film response — near zero in clipped whites
 * and deep blacks, strongest through the midtones.
 */
export default class FilmGrainEffect extends Effect {
  constructor() {
    super('FilmGrainEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['adaptedLuminance', new THREE.Uniform(null)],
        // x: base amount, y: reference log-luminance (ISO 100 point), z: chroma amount,
        // w: max ISO boost
        ['grainParams', new THREE.Uniform(new THREE.Vector4(0.015, 0.35, 0.35, 1.85))],
        ['grainTime', new THREE.Uniform(0)],
      ]),
    });
  }

  set luminanceTexture(t) { this.uniforms.get('adaptedLuminance').value = t; }

  /** @param {number} amount - look-scaled base grain amplitude */
  setAmount(amount) { this.uniforms.get('grainParams').value.x = amount; }

  update(renderer, inputBuffer, deltaTime) {
    // Wrap so the hash never loses precision during a long session.
    const u = this.uniforms.get('grainTime');
    u.value = (u.value + deltaTime) % 100;
  }
}

const FRAG = /* glsl */`
uniform sampler2D adaptedLuminance;
uniform vec4 grainParams;
uniform float grainTime;

// Cheap 3D hash. Deliberately not a texture: grain must not tile.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float avgLog = texture2D(adaptedLuminance, vec2(0.5)).r;
  // Every stop below the reference doubles the "ISO"; grain grows with its square root.
  float stopsUnder = clamp(grainParams.y - avgLog, 0.0, 8.0);
  float isoBoost = min(1.0 + stopsUnder * 0.26, grainParams.w);

  vec2 p = uv * resolution;
  float t = floor(grainTime * 24.0);              // 24 fps grain, not per-frame fizz
  float n = hash13(vec3(p, t)) - 0.5;
  float nc = hash13(vec3(p.yx + 17.3, t + 3.7)) - 0.5;

  float luma = dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Film grain response: nothing in the clipped whites, little in the deep toe.
  float response = 4.0 * luma * (1.0 - luma);
  response = mix(0.35, 1.0, response);

  float amp = grainParams.x * isoBoost * response;
  vec3 grain = vec3(n) + vec3(nc, -nc, nc * 0.5) * grainParams.z;
  outputColor = vec4(inputColor.rgb + grain * amp, inputColor.a);
}`;
