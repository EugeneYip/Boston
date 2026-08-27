// Shared GLSL building blocks for the atmosphere stack.
//
// Everything below is written against three's ShaderMaterial, which always
// compiles as `#version 300 es` with GLSL1 compatibility defines. That means
// `varying` / `gl_FragColor` / `texture2D` all still work AND we get sampler3D,
// which the volumetric clouds need.

/** Small math helpers + hashes. No dependencies. */
export const MATH = /* glsl */`
#ifndef ATM_PI
#define ATM_PI 3.141592653589793
#endif

float satf(float x) { return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 x)  { return clamp(x, vec3(0.0), vec3(1.0)); }

float remap01(float v, float lo, float hi) {
  return satf((v - lo) / max(hi - lo, 1e-6));
}
float remapv(float v, float lo, float hi, float nlo, float nhi) {
  return nlo + (v - lo) * (nhi - nlo) / max(hi - lo, 1e-6);
}

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/** Interleaved gradient noise — the cheapest good per-pixel dither. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Gradient-free 3D value noise, tileable on 'period'. */
float vnoise3(vec3 x, float period) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec3 i0 = mod(i, period), i1 = mod(i + 1.0, period);
  float n000 = hash13(vec3(i0.x, i0.y, i0.z));
  float n100 = hash13(vec3(i1.x, i0.y, i0.z));
  float n010 = hash13(vec3(i0.x, i1.y, i0.z));
  float n110 = hash13(vec3(i1.x, i1.y, i0.z));
  float n001 = hash13(vec3(i0.x, i0.y, i1.z));
  float n101 = hash13(vec3(i1.x, i0.y, i1.z));
  float n011 = hash13(vec3(i0.x, i1.y, i1.z));
  float n111 = hash13(vec3(i1.x, i1.y, i1.z));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm3(vec3 p, float period, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * vnoise3(p, period);
    n += a; a *= 0.5; p *= 2.0; period *= 2.0;
  }
  return s / max(n, 1e-5);
}

/** Nearest positive hit of a ray with a sphere centred on the origin. */
float raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d, t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return (t0 < 0.0) ? t1 : t0;
}
`;

/**
 * Physically based atmosphere: Rayleigh + Mie + ozone, with the LUT
 * parametrisations from Bruneton 2017 / Hillaire 2020. Distances are in km,
 * radiance is normalised so that solar illuminance == 1.
 */
export const ATMOSPHERE = /* glsl */`
#define ATM_GROUND 6360.0
#define ATM_TOP    6460.0

// Sea-level coefficients, km^-1. Values from Hillaire 2020 (mid-latitude clear).
const vec3  ATM_RAY_S = vec3(0.005802, 0.013558, 0.033100);
const float ATM_RAY_H = 8.0;
const float ATM_MIE_S = 0.003996;
const float ATM_MIE_E = 0.008436;   // scattering + absorption
const float ATM_MIE_H = 1.2;
const vec3  ATM_OZO_A = vec3(0.000650, 0.001881, 0.000085);

uniform float uTurbidity;     // aerosol multiplier: 1 = clean day, 6 = thick haze
uniform float uMieG;          // Mie anisotropy

/** Scattering / extinction coefficients at altitude h (km above sea level). */
void atmMedium(float h, out vec3 rayS, out float mieS, out vec3 sigmaS, out vec3 sigmaE) {
  float hp = max(h, 0.0);
  float rd = exp(-hp / ATM_RAY_H);
  float md = exp(-hp / ATM_MIE_H);
  float od = max(0.0, 1.0 - abs(hp - 25.0) / 15.0);
  rayS   = ATM_RAY_S * rd;
  mieS   = ATM_MIE_S * uTurbidity * md;
  sigmaS = rayS + vec3(mieS);
  sigmaE = rayS + vec3(ATM_MIE_E * uTurbidity * md) + ATM_OZO_A * od;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }

/** Cornette-Shanks — better forward lobe than plain Henyey-Greenstein. */
float miePhase(float g, float c) {
  float g2 = g * g;
  float num = 3.0 * (1.0 - g2) * (1.0 + c * c);
  float den = 8.0 * ATM_PI * (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
  return num / den;
}

float hgPhase(float g, float c) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * c, 1e-4);
  return (1.0 - g2) / (4.0 * ATM_PI * d * sqrt(d));
}

// ---- transmittance LUT parametrisation -------------------------------------
vec2 atmTransUv(float r, float mu) {
  float H   = sqrt(max(ATM_TOP * ATM_TOP - ATM_GROUND * ATM_GROUND, 0.0));
  float rho = sqrt(max(r * r - ATM_GROUND * ATM_GROUND, 0.0));
  float disc = r * r * (mu * mu - 1.0) + ATM_TOP * ATM_TOP;
  float d    = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = ATM_TOP - r;
  float dMax = rho + H;
  return vec2(satf((d - dMin) / max(dMax - dMin, 1e-6)), satf(rho / H));
}
void atmTransParams(vec2 uv, out float r, out float mu) {
  float H   = sqrt(ATM_TOP * ATM_TOP - ATM_GROUND * ATM_GROUND);
  float rho = H * uv.y;
  r = sqrt(rho * rho + ATM_GROUND * ATM_GROUND);
  float dMin = ATM_TOP - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = (d < 1e-6) ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
}
vec3 atmTransmittance(sampler2D lut, float r, float mu) {
  return texture2D(lut, atmTransUv(clamp(r, ATM_GROUND, ATM_TOP), mu)).rgb;
}

/** Keeps bilinear taps off the LUT border (Hillaire's FromUnitToSubUvs). */
float subUv(float u, float res) { return (u + 0.5 / res) * (res / (res + 1.0)); }

vec3 atmMultiScatter(sampler2D lut, float r, float muS) {
  vec2 uv = vec2(muS * 0.5 + 0.5, satf((r - ATM_GROUND) / (ATM_TOP - ATM_GROUND)));
  return texture2D(lut, vec2(subUv(uv.x, 32.0), subUv(uv.y, 32.0))).rgb;
}

// ---- sky-view LUT parametrisation ------------------------------------------
// Non-linear in zenith so the horizon (where the sunset gradient lives) gets
// most of the texels.
vec2 atmSkyViewUv(vec3 rd, vec3 up, vec3 sunDir, float viewHeight) {
  float vHorizon = sqrt(max(viewHeight * viewHeight - ATM_GROUND * ATM_GROUND, 1.0));
  float beta = acos(clamp(vHorizon / viewHeight, -1.0, 1.0));
  float zenithHorizon = ATM_PI - beta;

  float cosVZ = clamp(dot(rd, up), -1.0, 1.0);
  float vza = acos(cosVZ);

  vec3 vH = rd - up * cosVZ;
  vec3 sH = sunDir - up * dot(sunDir, up);
  float l2 = dot(vH, vH), s2 = dot(sH, sH);
  float clv = (l2 > 1e-9 && s2 > 1e-9) ? clamp(dot(vH, sH) * inversesqrt(l2 * s2), -1.0, 1.0) : 0.0;

  float uy;
  if (vza < zenithHorizon) {
    float c = vza / max(zenithHorizon, 1e-5);
    uy = 0.5 * (1.0 - sqrt(max(1.0 - c, 0.0)));
  } else {
    float c = (vza - zenithHorizon) / max(beta, 1e-5);
    uy = 0.5 + 0.5 * sqrt(satf(c));
  }
  return vec2(sqrt(satf(0.5 - 0.5 * clv)), uy);
}

void atmSkyViewParams(vec2 uv, float viewHeight, out vec3 rd, out float cosLightView) {
  float vHorizon = sqrt(max(viewHeight * viewHeight - ATM_GROUND * ATM_GROUND, 1.0));
  float beta = acos(clamp(vHorizon / viewHeight, -1.0, 1.0));
  float zenithHorizon = ATM_PI - beta;

  float vza;
  if (uv.y < 0.5) {
    float c = 2.0 * uv.y;
    c = 1.0 - c;
    vza = zenithHorizon * (1.0 - c * c);
  } else {
    float c = 2.0 * uv.y - 1.0;
    vza = zenithHorizon + beta * c * c;
  }
  cosLightView = 1.0 - 2.0 * uv.x * uv.x;
  float sinLV = sqrt(satf(1.0 - cosLightView * cosLightView));
  float cv = cos(vza), sv = sin(vza);
  rd = vec3(sv * cosLightView, cv, sv * sinLV);
}
`;
