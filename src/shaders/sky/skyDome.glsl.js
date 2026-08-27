import { MATH, ATMOSPHERE } from './common.glsl.js';

export const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  // The dome is a unit sphere, uniformly scaled and translated to the camera,
  // so object-space position is already the world-space view direction.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Equirect variant used to bake the environment map for IBL. */
export const DOME_EQUIRECT_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const DOME_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}

uniform sampler2D uSkyView;
uniform sampler2D uTransLut;
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform float uViewHeightKm;
uniform float uSkyIntensity;
uniform float uSunDisk;
uniform float uMoonLight;
uniform float uStarIntensity;
uniform vec3  uNightGlow;
uniform float uTime;
uniform float uLightning;
uniform vec3  uLightningColor;
uniform float uHorizonHaze;
uniform vec3  uGroundColor;
uniform float uMaxRadiance;

#ifdef EQUIRECT
varying vec2 vUv;
#else
varying vec3 vDir;
#endif

// ---------------------------------------------------------------- stars ----
vec3 starCell(vec3 rd, float nx, float ny, float seed, float sizeMul, float thresh) {
  float az = atan(rd.z, rd.x);
  float u = az * (0.5 / ATM_PI) + 0.5;
  float v = rd.y * 0.5 + 0.5;                 // equal-area in elevation
  vec2 g = vec2(u * nx, v * ny);
  vec2 id = floor(g);
  vec2 fr = fract(g) - 0.5;
  vec3 h = hash32(id + seed);
  if (h.z < thresh) return vec3(0.0);

  float cosEl = sqrt(max(1.0 - rd.y * rd.y, 1e-3));
  vec2 off = fr + (h.xy - 0.5) * 0.72;
  vec2 ang = vec2(off.x * (2.0 * ATM_PI / nx) * cosEl,
                  off.y * (2.0 / ny) / cosEl);
  float d2 = dot(ang, ang);

  float lot = (h.z - thresh) / max(1.0 - thresh, 1e-4);
  float mag = pow(lot, 2.4);                  // few bright, many faint
  float sig = 0.00042 * sizeMul * (0.75 + mag * 0.85);
  float core = exp(-d2 / (2.0 * sig * sig));
  float halo = mag * 0.10 * sig * sig / (sig * sig + d2 * 5.0);

  float tw = 1.0 + 0.34 * sin(uTime * (2.4 + h.y * 6.0) + h.x * 41.0)
                 * (1.0 - satf(rd.y * 1.6));
  vec3 col = mix(vec3(0.68, 0.76, 1.0), vec3(1.0, 0.80, 0.58), pow(h.y, 1.4));
  col = mix(col, vec3(1.0), 0.35);
  return col * ((core * (0.10 + mag * 1.9) + halo) * tw);
}

vec3 milkyWay(vec3 rd) {
  vec3 pole = vec3(0.1219, 0.6704, -0.7318);  // arbitrary but plausible tilt
  float b = dot(rd, pole);
  float band = exp(-b * b * 42.0);
  if (band < 0.006) return vec3(0.0);
  float n  = fbm3(rd * 8.0 + 13.0, 64.0, 3);
  float n2 = fbm3(rd * 26.0 + 51.0, 64.0, 2);
  float dust = smoothstep(0.34, 0.70, n2);
  float d = band * (0.28 + 0.95 * n) * (1.0 - 0.78 * dust);
  return d * vec3(0.42, 0.47, 0.72);
}

// ----------------------------------------------------------------- moon ----
vec3 moonSurface(vec3 n, vec3 sunDir) {
  float ndl = satf(dot(n, sunDir));
  // Maria: broad dark basalt patches, plus fine crater speckle.
  float maria = smoothstep(0.42, 0.62, fbm3(n * 3.1 + 7.0, 64.0, 3));
  float craters = fbm3(n * 26.0 + 2.0, 64.0, 2);
  float albedo = mix(0.15, 0.085, maria) * (0.82 + craters * 0.42);
  // Lunar surfaces are strongly backscattering — nearly flat across the disk.
  float lommel = ndl / max(ndl + 0.34, 1e-3);
  return vec3(albedo) * (lommel * 3.4 + 0.02);
}

// ------------------------------------------------------------------ sky ----
vec3 skyColor(vec3 rd) {
  float r = ATM_GROUND + max(uViewHeightKm, 0.0005);
  vec3 up = vec3(0.0, 1.0, 0.0);

  vec3 L = texture2D(uSkyView, atmSkyViewUv(rd, up, uSunDir, r)).rgb * uSkyIntensity;

  // Below the horizon the LUT is a plausible haze already; nudge it toward
  // ground colour so the far shore doesn't read as sky.
  float below = smoothstep(0.0, -0.055, rd.y);
  L = mix(L, L * uGroundColor, below * 0.55);

  float muV = max(rd.y, 0.0);
  vec3 viewT = atmTransmittance(uTransLut, r, muV);

  // --- sun disk ---
  float cosSun = dot(rd, uSunDir);
  float angSun = acos(clamp(cosSun, -1.0, 1.0));
  const float SUN_R = 0.004654;                     // 0.2666 deg
  float aa = max(fwidth(angSun), 1e-5);
  float disk = 1.0 - smoothstep(SUN_R - aa, SUN_R + aa, angSun);
  if (disk > 0.0) {
    float x = satf(angSun / SUN_R);
    float mu = sqrt(max(1.0 - x * x, 0.0));
    vec3 limb = vec3(1.0) - vec3(0.397, 0.503, 0.652) * (1.0 - mu);
    vec3 sunT = atmTransmittance(uTransLut, r, max(uSunDir.y, 0.0));
    float setFade = smoothstep(-0.019, -0.001, uSunDir.y);
    L += disk * limb * sunT * uSunDisk * setFade;
  }
  // Forward-scatter bloom right around the sun (aureole).
  float aur = pow(satf(cosSun), 900.0) * 0.55 + pow(satf(cosSun), 90.0) * 0.045;
  L += aur * uSunDisk * 0.0009 * atmTransmittance(uTransLut, r, max(uSunDir.y, 0.0))
       * smoothstep(-0.03, 0.01, uSunDir.y);

  // --- moon ---
  float cosMoon = dot(rd, uMoonDir);
  float angMoon = acos(clamp(cosMoon, -1.0, 1.0));
  const float MOON_R = 0.004720;
  float moonFade = smoothstep(-0.02, 0.02, uMoonDir.y) * uMoonLight;
  if (moonFade > 0.001) {
    float aam = max(fwidth(angMoon), 1e-5);
    float md = 1.0 - smoothstep(MOON_R - aam, MOON_R + aam, angMoon);
    if (md > 0.0) {
      // Rebuild the surface normal from the offset within the disk.
      vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0001)));
      vec3 t2 = cross(uMoonDir, t1);
      vec2 p = vec2(dot(rd, t1), dot(rd, t2)) / MOON_R;
      float pl = min(length(p), 0.9999);
      vec3 n = normalize(t1 * p.x + t2 * p.y + uMoonDir * sqrt(1.0 - pl * pl));
      vec3 surf = moonSurface(n, uSunDir);
      // Earthshine on the unlit limb.
      surf += vec3(0.011, 0.013, 0.020) * satf(-dot(n, uSunDir) * 0.6 + 0.6);
      L += md * surf * viewT * moonFade;
    }
    // Halo through haze.
    L += (pow(satf(cosMoon), 2600.0) * 0.30 + pow(satf(cosMoon), 210.0) * 0.020)
         * vec3(0.72, 0.78, 1.0) * moonFade * viewT;
  }

  // --- night sky ---
  if (uStarIntensity > 0.002) {
    vec3 night = vec3(0.0);
    night += starCell(rd, 900.0, 450.0, 3.17, 1.0, 0.9560);
    night += starCell(rd, 1700.0, 850.0, 71.3, 0.72, 0.9770) * 0.55;
    night += milkyWay(rd) * 0.55;
    float airmass = 1.0 / max(rd.y * 0.92 + 0.10, 0.12);
    night *= exp(-(airmass - 1.0) * 0.34);       // horizon extinction
    night *= smoothstep(-0.03, 0.06, rd.y);
    L += night * uStarIntensity * viewT;
    L += uNightGlow * uStarIntensity * (0.35 + 0.65 * satf(rd.y));
  }

  // --- lightning: a real luminance spike in the sky itself ---
  L += uLightningColor * uLightning * (0.25 + 0.75 * exp(-abs(rd.y) * 2.0));

  // Extra ground haze near the horizon line (sea fog / city smog).
  float hz = exp(-abs(rd.y) * 24.0);
  L = mix(L, mix(L, vec3(dot(L, vec3(0.33))) * uGroundColor * 1.4, 0.55), hz * uHorizonHaze);

  return min(L, vec3(uMaxRadiance));
}

void main() {
#ifdef EQUIRECT
  float phi   = (vUv.x - 0.5) * 2.0 * ATM_PI;
  float theta = (vUv.y - 0.5) * ATM_PI;
  float ct = cos(theta);
  vec3 rd = vec3(ct * cos(phi), sin(theta), ct * sin(phi));
#else
  vec3 rd = normalize(vDir);
#endif
  gl_FragColor = vec4(skyColor(rd), 1.0);
}
`;
