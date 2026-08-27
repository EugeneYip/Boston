import { MATH, ATMOSPHERE } from './common.glsl.js';

/**
 * Raymarched volumetric clouds.
 *
 * Rendered into a quarter-resolution RGBA16F target (rgb = in-scattered light,
 * a = transmittance) and temporally blended against the previous frame,
 * reprojected by camera rotation. Clouds are effectively at infinity relative
 * to the camera's per-frame translation, so a rotation-only reprojection is
 * exact enough and costs one matrix multiply.
 *
 * The shell uses a deliberately small "earth" radius (~900 km). A real 6371 km
 * radius blows out float32 precision in the quadratic and pushes the cloud
 * horizon to 140 km, which we would have to march anyway.
 */
export const CLOUD_FRAG = /* glsl */`
precision highp sampler3D;
${MATH}
${ATMOSPHERE}

uniform sampler3D uBaseNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeather;
uniform sampler2D uSkyView;
uniform sampler2D uTransLut;
uniform sampler2D uPrevCloud;
uniform sampler2D uDepth;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunIrradiance;
uniform vec3  uMoonIrradiance;
uniform float uSkyIntensity;
uniform vec3  uCamPos;
uniform mat4  uInvProj;
uniform mat4  uInvView;
uniform mat4  uPrevViewProj;
uniform vec2  uResolution;
uniform vec2  uDepthTexel;
uniform float uFrame;
uniform float uHasHistory;
uniform float uBlend;

uniform float uEarthR;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCoverage;
uniform float uCloudType;
uniform float uDensity;
uniform float uExtinction;
uniform float uDetailStrength;
uniform float uShapeLo;
uniform float uShapeHi;
uniform vec3  uWindOffset;
uniform vec3  uDetailOffset;
uniform vec2  uWeatherOffset;
uniform float uWeatherScale;
uniform float uBaseScale;
uniform float uDetailScale;
uniform float uAnvil;
uniform float uSteps;
uniform float uLightSteps;
uniform float uMaxMarch;
uniform float uLightning;
uniform vec3  uLightningColor;
uniform float uAmbientScale;
uniform float uAerial;

varying vec2 vUv;

const vec3 CONE[6] = vec3[6](
  vec3( 0.38,  0.21,  0.55), vec3(-0.47,  0.62, -0.19),
  vec3( 0.19, -0.53,  0.44), vec3(-0.62, -0.28, -0.51),
  vec3( 0.71,  0.44, -0.32), vec3(-0.12,  0.83,  0.27)
);

vec3 viewRay(vec2 uv) {
  vec4 c = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  return normalize((uInvView * vec4(c.xyz / c.w, 0.0)).xyz);
}

/** Altitude above the (curved) cloud deck, normalised to 0..1. */
float heightFrac(vec3 p) {
  vec2 d = p.xz - uCamPos.xz;
  float alt = p.y - dot(d, d) / (2.0 * uEarthR);
  return (alt - uCloudBottom) / max(uCloudTop - uCloudBottom, 1.0);
}

/** Vertical density profile. type: 0 = stratus, 0.5 = cumulus, 1 = cumulonimbus. */
float heightGradient(float h, float type) {
  float st = remap01(h, 0.0, 0.09) * (1.0 - remap01(h, 0.16, 0.34));
  float cu = remap01(h, 0.0, 0.16) * (1.0 - remap01(h, 0.50, 0.94));
  float cb = remap01(h, 0.0, 0.10) * (1.0 - remap01(h, 0.72, 1.0));
  float a = satf(type * 2.0);
  float b = satf(type * 2.0 - 1.0);
  return mix(mix(st, cu, a), cb, b);
}

/** Cheap silhouette-only density — used for the first hit test and shadow rays. */
float densityLow(vec3 p, float h, out float cov, out float type) {
  cov = 0.0; type = 0.5;
  if (h < 0.0 || h > 1.0) return 0.0;

  vec4 wm = texture2D(uWeather, p.xz * uWeatherScale + uWeatherOffset);
  // The weather map modulates the requested coverage by roughly +/- 35%; the
  // global setting stays the thing that actually decides how much sky is cloud.
  cov = satf(uCoverage * (0.62 + 0.80 * wm.r));
  if (cov <= 0.004) return 0.0;
  type = satf(wm.g * 0.5 + uCloudType);

  float grad = heightGradient(h, type);
  // Cumulonimbus flare out into an anvil near the top.
  grad *= mix(1.0, 1.0 + uAnvil * remap01(h, 0.60, 1.0) * 1.6, satf(type * 1.4 - 0.4));
  if (grad <= 0.002) return 0.0;

  vec4 n = texture(uBaseNoise, (p + uWindOffset) * uBaseScale);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = satf(n.r * 0.62 + fbm * 0.38);

  // Coverage drives a threshold on the silhouette: at 0 only the densest cores
  // survive, at 1 the deck is solid. Keeping it an explicit lerp makes the
  // relationship between the weather preset and what you see predictable.
  float thr = mix(uShapeHi, uShapeLo, cov);
  float d = remap01(shape * grad, thr, min(thr + 0.30, 1.0));
  return d * (0.40 + 0.60 * cov);
}

float densityFull(vec3 p, float h, float dLow) {
  vec3 dn = texture(uDetailNoise, (p + uWindOffset + uDetailOffset) * uDetailScale).rgb;
  float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  // Wispy at the base, billowy at the top.
  float mod_ = mix(1.0 - dfbm, dfbm, satf(h * 3.0));
  // Erode the edges only; a dense core must stay a dense core or the whole
  // cloud dissolves into noise.
  float e = uDetailStrength * (1.0 - satf(dLow * 1.7));
  return satf(dLow - mod_ * e) * uDensity;
}

float lightOpticalDepth(vec3 p, vec3 ld) {
  float od = 0.0;
  float st = 90.0;
  vec3 sp = p;
  int n = int(uLightSteps);
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    sp += ld * st + CONE[i] * st * 0.34;
    float h = heightFrac(sp);
    if (h > 1.02) break;
    float cv, ty;
    od += densityLow(sp, h, cv, ty) * uDensity * st;
    if (od * uExtinction > 6.0) break;      // already opaque; more steps buy nothing
    st *= 1.52;
  }
  return od;
}

bool cloudShell(float camY, float dy, out float t0, out float t1) {
  float R = uEarthR;
  float horizonDy = -sqrt(2.0 * max(camY, 0.0) / R) - 0.0005;
  if (dy < horizonDy) return false;

  float b  = (R + camY) * dy;
  float cB = (camY - uCloudBottom) * (2.0 * R + camY + uCloudBottom);
  float cT = (camY - uCloudTop) * (2.0 * R + camY + uCloudTop);
  float dT = b * b - cT;
  if (dT < 0.0) return false;
  float sT = sqrt(dT);
  float dB = b * b - cB;

  if (camY < uCloudBottom) {
    if (dB < 0.0) return false;
    t0 = -b + sqrt(dB);
    t1 = -b + sT;
  } else if (camY < uCloudTop) {
    t0 = 0.0;
    float tb = (dB >= 0.0) ? (-b - sqrt(dB)) : -1.0;
    t1 = (tb > 0.0) ? tb : (-b + sT);
  } else {
    t0 = max(-b - sT, 0.0);
    float tb = (dB >= 0.0) ? (-b - sqrt(dB)) : -1.0;
    t1 = (tb > t0) ? tb : (-b + sT);
  }
  t0 = max(t0, 0.0);
  return t1 > t0;
}

vec3 skyLut(vec3 rd) {
  float r = ATM_GROUND + max(uCamPos.y, 0.0) * 0.001;
  return texture2D(uSkyView, atmSkyViewUv(rd, vec3(0.0, 1.0, 0.0), uSunDir, r)).rgb * uSkyIntensity;
}

void main() {
  // Skip entirely when the whole low-res texel is covered by geometry.
  vec2 dt = uDepthTexel;
  float dmax = max(max(texture2D(uDepth, vUv + vec2(-dt.x, -dt.y)).x,
                       texture2D(uDepth, vUv + vec2( dt.x, -dt.y)).x),
                   max(texture2D(uDepth, vUv + vec2(-dt.x,  dt.y)).x,
                       texture2D(uDepth, vUv + vec2( dt.x,  dt.y)).x));
  if (dmax < 0.99999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 rd = viewRay(vUv);
  float camY = max(uCamPos.y, 0.5);

  float t0, t1;
  if (!cloudShell(camY, rd.y, t0, t1)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, t0 + uMaxMarch);

  int steps = int(uSteps);
  float span = t1 - t0;
  float dts = clamp(span / float(steps), 26.0, 900.0);
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588238);

  float cosT = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);

  // Sun/moon colour after atmospheric extinction down to the cloud deck.
  float midKm = (uCloudBottom + uCloudTop) * 0.0005;
  vec3 sunCol  = atmTransmittance(uTransLut, ATM_GROUND + midKm, max(uSunDir.y, -0.02)) * uSunIrradiance;
  sunCol *= smoothstep(-0.09, 0.0, uSunDir.y);
  vec3 moonCol = uMoonIrradiance * smoothstep(-0.05, 0.03, uMoonDir.y);

  vec3 ambTop = skyLut(vec3(0.0, 1.0, 0.0)) * uAmbientScale;
  vec3 ambBot = skyLut(normalize(vec3(rd.x, -0.12, rd.z))) * uAmbientScale * 0.55;

  vec3 scat = vec3(0.0);
  float T = 1.0;
  float distAcc = 0.0, wAcc = 0.0;
  float t = t0 + jitter * dts;

  for (int i = 0; i < 96; i++) {
    if (i >= steps || T < 0.015 || t > t1) break;
    vec3 p = uCamPos + rd * t;
    float h = heightFrac(p);
    float cv, ty;
    float dLow = densityLow(p, h, cv, ty);
    if (dLow > 0.0005) {
      float dens = densityFull(p, h, dLow);
      if (dens > 0.0005) {
        float od = lightOpticalDepth(p, uSunDir);
        // Wrenninge multi-scatter octaves: forward lobe survives deep, the
        // wide lobe fills the shadowed side. This is the silver lining.
        vec3 lightE = vec3(0.0);
        float a = 1.0, bw = 1.0, c = 1.0;
        for (int o = 0; o < 3; o++) {
          float ph = mix(hgPhase(0.78 * c, cosT), hgPhase(-0.32 * c, cosT), 0.30);
          lightE += bw * ph * exp(-od * uExtinction * a);
          a *= 0.52; bw *= 0.46; c *= 0.58;
        }
        float powder = 1.0 - exp(-dens * 34.0);
        lightE *= mix(1.0, powder * 2.0, 0.62);

        vec3 amb = mix(ambBot, ambTop, satf(h * 0.85 + 0.15)) * (0.35 + 0.65 * satf(1.2 - cv));
        vec3 moonE = moonCol * hgPhase(0.55, cosM) * exp(-od * uExtinction * 0.55) * 4.0;

        vec3 S = sunCol * lightE + amb + moonE;
        S += uLightningColor * uLightning * (0.35 + 0.65 * (1.0 - satf(h))) * 26.0;

        // Cloud droplets scatter almost conservatively (albedo ~ 1), so the
        // in-scattered energy over a step is just S * (1 - transmittance).
        float sT = exp(-dens * uExtinction * dts);
        scat += T * S * (1.0 - sT);
        T *= sT;
        distAcc += t * dens; wAcc += dens;
      }
    }
    t += dts;
  }

  // Aerial perspective on the cloud deck itself: distant towers of cloud
  // desaturate into the horizon just like distant buildings do.
  if (wAcc > 0.0) {
    float md = distAcc / wAcc;
    float f = 1.0 - exp(-md * uAerial);
    vec3 hz = skyLut(normalize(vec3(rd.x, max(rd.y, 0.008), rd.z)));
    scat = mix(scat, hz * (1.0 - T), satf(f));
  }

  vec4 cur = vec4(scat, T);

  // Temporal blend against the rotation-reprojected previous frame.
  vec4 pc = uPrevViewProj * vec4(rd, 0.0);
  vec2 puv = pc.xy / max(pc.w, 1e-6) * 0.5 + 0.5;
  if (uHasHistory > 0.5 && pc.w > 0.0 &&
      puv.x > 0.002 && puv.x < 0.998 && puv.y > 0.002 && puv.y < 0.998) {
    vec4 prev = texture2D(uPrevCloud, puv);
    cur = mix(prev, cur, uBlend);
  }
  gl_FragColor = cur;
}
`;
