import { MATH } from './common.glsl.js';

/** Tileable gradient + Worley noise used to bake the cloud volume textures. */
const NOISE_LIB = /* glsl */`
${MATH}

/** Tileable Perlin-style gradient noise. 'period' is in cell units. */
float gnoise3(vec3 p, float period) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float r = 0.0;
  for (int dz = 0; dz < 2; dz++)
  for (int dy = 0; dy < 2; dy++)
  for (int dx = 0; dx < 2; dx++) {
    vec3 o = vec3(float(dx), float(dy), float(dz));
    vec3 g = hash33(mod(i + o, vec3(period))) * 2.0 - 1.0;
    float v = dot(g, f - o);
    r += v * mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
  }
  return satf(r * 0.78 + 0.5);
}

float gfbm3(vec3 p, float freq, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise3(p * freq, freq);
    n += a; a *= 0.5; freq *= 2.0;
  }
  return s / max(n, 1e-5);
}

/** Tileable Worley (cellular) noise. Returns 1 - distance, so 1 == cell centre. */
float worley3(vec3 p, float freq) {
  vec3 pf = p * freq;
  vec3 id = floor(pf);
  vec3 fr = fract(pf);
  float md = 1.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 pt = o + hash33(mod(id + o, vec3(freq))) - fr;
    md = min(md, dot(pt, pt));
  }
  return 1.0 - satf(sqrt(md));
}
`;

/**
 * 128^3 base shape volume, baked one Z-slice per draw.
 *   R = Perlin-Worley (the cloud silhouette)
 *   G/B/A = Worley at 3 rising frequencies (erosion FBM)
 */
export const BASE_NOISE_FRAG = /* glsl */`
${NOISE_LIB}
uniform float uSlice;      // 0..1 through the volume
varying vec2 vUv;

void main() {
  vec3 p = vec3(vUv, uSlice);
  float w4  = worley3(p, 4.0);
  float w8  = worley3(p, 8.0);
  float w16 = worley3(p, 16.0);
  float wfbm = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;

  float perlin = gfbm3(p, 4.0, 5);
  // Perlin-Worley: billowy where Worley is dense, wispy where Perlin is.
  float pw = remapv(perlin, wfbm - 1.0, 1.0, 0.0, 1.0);

  gl_FragColor = vec4(satf(pw), w4, w8, w16);
}
`;

/** 32^3 high-frequency erosion volume. */
export const DETAIL_NOISE_FRAG = /* glsl */`
${NOISE_LIB}
uniform float uSlice;
varying vec2 vUv;

void main() {
  vec3 p = vec3(vUv, uSlice);
  gl_FragColor = vec4(worley3(p, 4.0), worley3(p, 8.0), worley3(p, 16.0), 1.0);
}
`;

/**
 * 512^2 weather map — the large-scale "where is the weather" field.
 *   R = coverage
 *   G = cloud type (0 stratus .. 1 cumulonimbus)
 *   B = precipitation / anvil bias
 *   A = slow large-scale modulation, used to break up scrolling repetition
 */
export const WEATHER_FRAG = /* glsl */`
${NOISE_LIB}
varying vec2 vUv;

void main() {
  vec3 p = vec3(vUv, 0.31);
  // Domain warp so cells look like real synoptic weather, not fbm mush.
  vec2 w = vec2(gfbm3(vec3(vUv, 0.71), 3.0, 3), gfbm3(vec3(vUv, 5.13), 3.0, 3)) - 0.5;
  vec3 pw = vec3(vUv + w * 0.28, 0.31);

  float cov  = gfbm3(pw, 4.0, 5);
  cov = satf(remapv(cov, 0.28, 0.86, 0.0, 1.0));

  float type = gfbm3(vec3(vUv * 1.0, 2.4), 3.0, 4);
  type = satf(remapv(type, 0.3, 0.75, 0.0, 1.0));

  float precip = satf(remapv(gfbm3(vec3(vUv, 8.8), 2.0, 3), 0.42, 0.8, 0.0, 1.0));
  float large  = gfbm3(vec3(vUv, 3.9), 2.0, 2);

  gl_FragColor = vec4(cov, type, precip, large);
}
`;
