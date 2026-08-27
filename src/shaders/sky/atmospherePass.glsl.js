import { MATH, ATMOSPHERE } from './common.glsl.js';

/** Shared ray/depth reconstruction for the screen-space atmosphere passes. */
const RECON = /* glsl */`
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform vec3 uCamPos;

vec3 viewRay(vec2 uv) {
  vec4 c = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  return normalize((uInvView * vec4(c.xyz / c.w, 0.0)).xyz);
}
float sceneDist(vec2 uv, float d) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return length(v.xyz / v.w);
}

/**
 * Optical path through an exponential height layer.
 * density(y) = exp(-(y - y0) / H), integrated from the camera along rd for dist.
 */
float heightPath(float camY, float dy, float dist, float H, float y0) {
  float base = exp(-(camY - y0) / H);
  if (abs(dy) < 1e-4) return base * dist;
  return base * (H / dy) * (1.0 - exp(-dy * dist / H));
}
`;

/**
 * Volumetric light shafts, marched at quarter resolution.
 * Occlusion comes from the sun's shadow map when the lighting system exposes
 * one, and always from the cloud deck (crepuscular rays through cloud gaps).
 */
export const VOLUME_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}
${RECON}

uniform sampler2D uDepth;
uniform sampler2D uWeather;
uniform sampler2D uShadowMap;
uniform sampler2D uTransLut;
uniform mat4  uShadowMatrix;
uniform float uHasShadow;
uniform vec3  uSunDir;
uniform vec3  uSunIrradiance;
uniform float uFrame;
uniform float uSteps;
uniform float uMaxShaft;
uniform float uHazeSigma;
uniform float uHazeH;
uniform float uHazeY0;
uniform float uShaftStrength;
uniform float uCoverage;
uniform float uCloudBottom;
uniform float uWeatherScale;
uniform float uCloudShadow;
uniform vec2  uWeatherOffset;
uniform float uTime;
varying vec2 vUv;

const float UnpackDownscale = 255.0 / 256.0;
const vec3  PackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
const vec4  UnpackFactors = UnpackDownscale / vec4(PackFactors, 1.0);
float unpackDepth(vec4 v) { return dot(v, UnpackFactors); }

float sunShadow(vec3 p) {
  if (uHasShadow < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  sc.xyz /= max(sc.w, 1e-6);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  return step(sc.z - 0.0022, unpackDepth(texture2D(uShadowMap, sc.xy)));
}

float cloudShadow(vec3 p) {
  if (uCloudShadow < 0.01 || uSunDir.y < 0.03) return 1.0;
  float tt = (uCloudBottom + 250.0 - p.y) / max(uSunDir.y, 0.05);
  vec3 cp = p + uSunDir * tt;
  vec4 wm = texture2D(uWeather, cp.xz * uWeatherScale + uWeatherOffset);
  float cov = satf(wm.r * 1.25 + uCoverage * 1.55 - 0.62);
  return exp(-cov * uCloudShadow);
}

void main() {
  float d = texture2D(uDepth, vUv).x;
  vec3 rd = viewRay(vUv);
  float dist = (d > 0.99999) ? uMaxShaft : min(sceneDist(vUv, d), uMaxShaft);
  if (dist < 1.0 || uSunDir.y < -0.06) { gl_FragColor = vec4(0.0); return; }

  int N = int(uSteps);
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588238);
  float dt = dist / float(N);
  float phase = miePhase(0.62, dot(rd, uSunDir)) * 4.0 * ATM_PI;

  vec3 sunCol = atmTransmittance(uTransLut, ATM_GROUND + 0.05, max(uSunDir.y, 0.0))
              * uSunIrradiance * smoothstep(-0.05, 0.04, uSunDir.y);

  vec3 acc = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 32; i++) {
    if (i >= N) break;
    float t = (float(i) + jitter) * dt;
    vec3 p = uCamPos + rd * t;
    float dens = uHazeSigma * exp(-(p.y - uHazeY0) / uHazeH);
    if (dens > 1e-7) {
      float vis = sunShadow(p) * cloudShadow(p);
      acc += T * vis * dens * dt * sunCol;
      T *= exp(-dens * dt);
    }
  }
  gl_FragColor = vec4(acc * phase * uShaftStrength, 1.0);
}
`;

/**
 * Final composite: cloud over sky, aerial perspective + height fog on
 * geometry, light shafts on everything, lightning flash.
 */
export const COMPOSITE_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}
${RECON}

uniform sampler2D inputBuffer;
uniform sampler2D uDepth;
uniform sampler2D uCloud;
uniform sampler2D uVolume;
uniform mat4  uCloudViewProj;
uniform float uCloudRayScale;
uniform sampler2D uSkyView;
uniform vec3  uSunDir;
uniform float uSkyIntensity;
uniform float uHazeSigma;
uniform float uHazeH;
uniform float uHazeY0;
uniform float uRayleighScale;
uniform float uFogAlbedo;
uniform vec3  uFogTint;
uniform float uUseVolume;
uniform float uLightning;
uniform vec3  uLightningColor;
uniform float uFlashScreen;
uniform float uMaxRadiance;
varying vec2 vUv;

vec3 skyLut(vec3 rd) {
  float r = ATM_GROUND + max(uCamPos.y, 0.0) * 0.001;
  return texture2D(uSkyView, atmSkyViewUv(rd, vec3(0.0, 1.0, 0.0), uSunDir, r)).rgb * uSkyIntensity;
}

void main() {
  vec3 col = texture2D(inputBuffer, vUv).rgb;
  float d = texture2D(uDepth, vUv).x;
  vec3 rd = viewRay(vUv);

  if (d > 0.99999) {
    // The cloud buffer is only re-marched every few frames and is rendered
    // with a wider frustum than the camera, so it is sampled through the
    // view-projection it was actually marched with rather than through vUv.
    vec4 cp = uCloudViewProj * vec4(rd, 0.0);
    if (cp.w > 0.0) {
      vec2 cuv = (cp.xy / cp.w) / uCloudRayScale * 0.5 + 0.5;
      vec4 cl = texture2D(uCloud, clamp(cuv, vec2(0.0015), vec2(0.9985)));
      col = col * cl.a + cl.rgb;
    }
  } else {
    float dist = sceneDist(vUv, d);

    // Rayleigh gives the blue shift; the aerosol layer gives the desaturation
    // and is what actually makes a city read as kilometres deep.
    float pathHaze = heightPath(uCamPos.y, rd.y, dist, uHazeH, uHazeY0);
    float pathRay  = heightPath(uCamPos.y, rd.y, dist, 8000.0, 0.0);
    vec3 od = ATM_RAY_S * 1e-3 * uRayleighScale * pathRay + vec3(uHazeSigma) * pathHaze;
    vec3 T = exp(-od);

    vec3 inscat = skyLut(normalize(vec3(rd.x, max(rd.y, -0.02), rd.z)));
    // Thick fog is a local white medium, not a window onto the sky.
    inscat = mix(inscat, uFogTint * (0.35 + 0.65 * dot(inscat, vec3(0.33))), uFogAlbedo);

    col = col * T + inscat * (vec3(1.0) - T);
  }

  if (uUseVolume > 0.5) col += texture2D(uVolume, vUv).rgb;
  col += uLightningColor * (uLightning * uFlashScreen);

  gl_FragColor = vec4(min(col, vec3(uMaxRadiance)), 1.0);
}
`;
