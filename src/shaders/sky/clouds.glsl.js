import { MATH, ATMOSPHERE } from './common.glsl.js';

/**
 * Raymarched volumetric clouds.
 *
 * Rendered into a small RGBA16F target (rgb = in-scattered light, a =
 * transmittance) which the composite reprojects and upsamples over sky pixels.
 *
 * Four things keep this inside a ~2 ms budget at 1080p:
 *
 *  1. **Amortisation.** The buffer is only re-marched every Nth frame. Clouds
 *     are effectively at infinity, so a stale buffer stays correct under camera
 *     rotation as long as it is sampled through the view-projection it was
 *     rendered with - which is what uRayScale and the composite's
 *     uCloudViewProj are for. The buffer is rendered with a wider frustum than
 *     the camera so a fast turn cannot pull in texels that were never marched.
 *  2. **Empty-space skipping.** Coarse strides until the cheap silhouette
 *     density reports a hit, then rewind once and refine.
 *  3. **A shadow ray that never touches the weather map.** Coverage and cloud
 *     type barely change over the ~2 km the light march covers, so they are
 *     passed in from the primary sample instead of re-fetched six times.
 *  4. **Quarter-ish resolution** with a blue-noise offset and a temporal blend
 *     against the reprojected previous buffer.
 *
 * The shell uses a deliberately small "earth" radius (~900 km). A real 6371 km
 * radius blows out float32 precision in the quadratic and pushes the cloud
 * horizon out to 140 km, which we would then have to march.
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
uniform float uRayScale;
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
uniform float uShapeSpan;
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
uniform vec3  uCityGlow;
uniform float uCityGlowGain;

varying vec2 vUv;

const vec3 CONE[6] = vec3[6](
  vec3( 0.38,  0.21,  0.55), vec3(-0.47,  0.62, -0.19),
  vec3( 0.19, -0.53,  0.44), vec3(-0.62, -0.28, -0.51),
  vec3( 0.71,  0.44, -0.32), vec3(-0.12,  0.83,  0.27)
);

/** Camera NDC for this texel. Outside [-1,1] is the reprojection guard band. */
vec2 texelNdc(vec2 uv) { return (uv * 2.0 - 1.0) * uRayScale; }

vec3 viewRay(vec2 ndc) {
  vec4 c = uInvProj * vec4(ndc, -1.0, 1.0);
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
  return mix(mix(st, cu, satf(type * 2.0)), cb, satf(type * 2.0 - 1.0));
}

/**
 * Silhouette density, given a coverage/type already fetched from the weather
 * map. Coverage drives a threshold on the noise: at 0 only the densest cores
 * survive, at 1 the deck is solid. Keeping it an explicit lerp is what makes
 * the relationship between a weather preset and what you see predictable.
 */
float shapeDensity(vec3 p, float h, float cov, float type) {
  if (h < 0.0 || h > 1.0) return 0.0;
  float grad = heightGradient(h, type);
  // Cumulonimbus flare out into an anvil near the top.
  grad *= mix(1.0, 1.0 + uAnvil * remap01(h, 0.60, 1.0) * 1.6, satf(type * 1.4 - 0.4));
  if (grad <= 0.002) return 0.0;

  vec4 n = texture(uBaseNoise, (p + uWindOffset) * uBaseScale);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = satf(n.r * 0.62 + fbm * 0.38);

  // uShapeLo / uShapeHi are the measured 2nd and 99.5th percentiles of shape
  // over the baked volume, so coverage 0 really is a clear sky and coverage 1
  // really is a solid deck, whatever the noise happened to bake out as.
  // The gradient biases the silhouette before the threshold (narrower near the
  // top and bottom of the deck) and fades it after.
  float thr = mix(uShapeHi, uShapeLo, cov);
  return remap01(shape * (0.45 + 0.55 * grad), thr, thr + uShapeSpan)
       * grad * (0.40 + 0.60 * cov);
}

/** Weather-map lookup + silhouette. One per primary sample. */
float densityLow(vec3 p, float h, out float cov, out float type) {
  cov = 0.0; type = 0.5;
  if (h < 0.0 || h > 1.0) return 0.0;
  vec4 wm = texture2D(uWeather, p.xz * uWeatherScale + uWeatherOffset);
  cov = satf(uCoverage * (0.62 + 0.80 * wm.r));
  if (cov <= 0.004) return 0.0;
  type = satf(wm.g * 0.5 + uCloudType);
  return shapeDensity(p, h, cov, type);
}

float densityFull(vec3 p, float h, float dLow) {
  vec3 dn = texture(uDetailNoise, (p + uWindOffset + uDetailOffset) * uDetailScale).rgb;
  float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  float mod_ = mix(1.0 - dfbm, dfbm, satf(h * 3.0));
  // Erode the edges only; a dense core must stay a dense core or the whole
  // cloud dissolves into noise.
  float e = uDetailStrength * (1.0 - satf(dLow * 1.7));
  return satf(dLow - mod_ * e) * uDensity;
}

float lightOpticalDepth(vec3 p, vec3 ld, float cov, float type) {
  float od = 0.0;
  float st = 110.0;
  vec3 sp = p;
  int n = int(uLightSteps);
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    sp += ld * st + CONE[i] * st * 0.34;
    float h = heightFrac(sp);
    if (h > 1.02) break;
    od += shapeDensity(sp, h, cov, type) * uDensity * st;
    if (od * uExtinction > 6.0) break;    // already opaque; more steps buy nothing
    st *= 1.62;
  }
  return od;
}

bool cloudShell(float camY, float dy, out float t0, out float t1) {
  float R = uEarthR;
  float horizonDy = -sqrt(2.0 * max(camY, 0.0) / R) - 0.0005;
  if (dy < horizonDy) return false;

  float b  = (R + camY) * dy;
  // |o|^2 - r^2 in factored form: the direct difference loses all precision.
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
  vec2 ndc = texelNdc(vUv);

  // Skip entirely when geometry covers the whole texel. Texels in the guard
  // band have no depth information, so they always march.
  if (abs(ndc.x) < 0.999 && abs(ndc.y) < 0.999) {
    vec2 duv = ndc * 0.5 + 0.5;
    vec2 dt = uRayScale / uResolution;
    float dmax = max(max(texture2D(uDepth, duv + vec2(-dt.x, -dt.y)).x,
                         texture2D(uDepth, duv + vec2( dt.x, -dt.y)).x),
                     max(texture2D(uDepth, duv + vec2(-dt.x,  dt.y)).x,
                         texture2D(uDepth, duv + vec2( dt.x,  dt.y)).x));
    // All four taps are geometry, so nothing of the deck is visible here.
    // Exact, not epsilon: with '< 0.99999' this kept marching over geometry
    // beyond 8.1 km, which is both wasted work and the opposite half of the
    // aerial-perspective seam — the composite has to agree with this test
    // about which pixels are sky.
    if (dmax < 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  }

  vec3 rd = viewRay(ndc);
  float camY = max(uCamPos.y, 0.5);

  float t0, t1;
  if (!cloudShell(camY, rd.y, t0, t1)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, t0 + uMaxMarch);

  int steps = int(uSteps);
  float span = t1 - t0;
  float dtFine = clamp(span / float(steps), 26.0, 900.0) * 0.6;
  float dtCoarse = dtFine * 3.0;
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588238);

  float cosT = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);

  // Sun/moon colour after atmospheric extinction down to the cloud deck.
  float midKm = (uCloudBottom + uCloudTop) * 0.0005;
  vec3 sunCol = atmTransmittance(uTransLut, ATM_GROUND + midKm, max(uSunDir.y, -0.02))
              * uSunIrradiance * smoothstep(-0.09, 0.0, uSunDir.y);
  vec3 moonCol = uMoonIrradiance * smoothstep(-0.05, 0.03, uMoonDir.y);

  vec3 ambTop = skyLut(vec3(0.0, 1.0, 0.0)) * uAmbientScale;
  vec3 ambBot = skyLut(normalize(vec3(rd.x, -0.12, rd.z))) * uAmbientScale * 0.55;

  // City light reaching the cloud base from below. Once the sun is down this is
  // the *only* light on the deck — sunCol and the sky-view ambient are both
  // zero and the moon contributes ~1e-4 — so without it every cloud at night is
  // a hole of exact black punched in the star field. Scaled by the deck's own
  // depth: a solid overcast traps and re-emits far more of the city than a few
  // fair-weather cumulus do.
  // The 4x over the dome's glow is not a fudge: the dome term is the fraction of
  // the city's upward flux that the clear-air aerosol scatters back down, while
  // a cloud base intercepts and re-emits most of it. Get this the wrong way
  // round and the clouds read as black holes cut out of a glowing sky.
  vec3 cityBase = uCityGlow * (4.0 * uCityGlowGain
                * smoothstep(0.05, -0.13, uSunDir.y));

  vec3 scat = vec3(0.0);
  float T = 1.0;
  float distAcc = 0.0, wAcc = 0.0;
  float step_ = dtCoarse;
  float t = t0 + jitter * dtCoarse;
  int miss = 0;
  // Budget of *advancing* steps. A rewind moves backwards and must not spend
  // one, or a march that enters a cloud late in the span pays for the refine
  // twice: once in distance and once in budget.
  float used = 0.0;

  for (int i = 0; i < 96; i++) {
    if (used >= float(steps) || T < 0.03 || t > t1) break;
    vec3 p = uCamPos + rd * t;
    float h = heightFrac(p);
    float cov, type;
    float dLow = densityLow(p, h, cov, type);

    if (dLow > 0.001) {
      if (step_ > dtFine * 1.5) {
        // First hit inside a coarse stride: rewind once, then refine.
        //
        // 'miss' MUST be cleared here. Leaving it set is what made this march
        // livelock: the rewound sample is by definition empty (the coarse
        // stride passed through it), so a stale miss count immediately trips
        // the back-to-coarse rule below, the next stride lands exactly back
        // on the sample we rewound from, and that rewinds again. The march
        // then oscillates between two points until it runs out of steps and
        // densityFull() is never once evaluated — a completely transparent
        // cloud buffer at every hour and every weather state.
        t = max(t - step_, t0);
        step_ = dtFine;
        miss = 0;
        continue;
      }
      miss = 0;
      float dens = densityFull(p, h, dLow);
      if (dens > 0.001) {
        float od = lightOpticalDepth(p, uSunDir, cov, type);
        // Wrenninge multi-scatter octaves: the forward lobe survives deep into
        // the cloud, the wide lobe fills the shadowed side. This is the silver
        // lining, and the glow through thin edges.
        vec3 lightE = vec3(0.0);
        float a = 1.0, bw = 1.0, c = 1.0;
        for (int o = 0; o < 3; o++) {
          float ph = mix(hgPhase(0.78 * c, cosT), hgPhase(-0.32 * c, cosT), 0.30);
          lightE += bw * ph * exp(-od * uExtinction * a);
          a *= 0.52; bw *= 0.46; c *= 0.58;
        }
        lightE *= mix(1.0, (1.0 - exp(-dens * 34.0)) * 2.0, 0.62);   // powder

        vec3 amb = mix(ambBot, ambTop, satf(h * 0.85 + 0.15)) * (0.35 + 0.65 * satf(1.2 - cov));
        // Lit from below, so it falls off through the deck rather than rising
        // with altitude the way sky ambient does.
        amb += cityBase * (0.30 + 0.70 * cov) * (0.15 + 0.85 * (1.0 - satf(h)));
        vec3 moonE = moonCol * hgPhase(0.55, cosM) * exp(-od * uExtinction * 0.55) * 4.0;

        vec3 S = sunCol * lightE + amb + moonE;
        S += uLightningColor * uLightning * (0.35 + 0.65 * (1.0 - satf(h))) * 26.0;

        // Cloud droplets scatter almost conservatively (albedo ~ 1), so the
        // energy gained over a step is just S * (1 - transmittance).
        float sT = exp(-dens * uExtinction * step_);
        scat += T * S * (1.0 - sT);
        T *= sT;
        distAcc += t * dens; wAcc += dens;
      }
    } else {
      // Only give up on the fine stride after enough consecutive empty fine
      // samples to have re-crossed the coarse stride we rewound over
      // (dtCoarse == 3 * dtFine), otherwise the revert leaps straight past the
      // density that triggered the refine in the first place.
      miss++;
      if (miss > 5) { step_ = dtCoarse; miss = 0; }
    }
    t += step_;
    used += 1.0;
  }

  // Aerial perspective on the deck itself: distant towers of cloud desaturate
  // into the horizon exactly as distant buildings do.
  if (wAcc > 0.0) {
    float f = satf(1.0 - exp(-(distAcc / wAcc) * uAerial));
    vec3 hz = skyLut(normalize(vec3(rd.x, max(rd.y, 0.008), rd.z)));
    scat = mix(scat, hz * (1.0 - T), f);
  }

  vec4 cur = vec4(scat, T);

  // Temporal blend against the previous buffer, reprojected by camera rotation.
  vec4 pc = uPrevViewProj * vec4(rd, 0.0);
  vec2 puv = (pc.xy / max(pc.w, 1e-6)) / uRayScale * 0.5 + 0.5;
  if (uHasHistory > 0.5 && pc.w > 0.0 &&
      puv.x > 0.002 && puv.x < 0.998 && puv.y > 0.002 && puv.y < 0.998) {
    cur = mix(texture2D(uPrevCloud, puv), cur, uBlend);
  }
  gl_FragColor = cur;
}
`;
