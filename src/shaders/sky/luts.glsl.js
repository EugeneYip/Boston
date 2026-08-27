import { MATH, ATMOSPHERE } from './common.glsl.js';

/** Fullscreen-quad vertex shader shared by every LUT bake (PlaneGeometry(2,2)). */
export const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Transmittance to the top of the atmosphere, parametrised by (altitude,
 * view-zenith). Baked once per turbidity change; 256x64 half-float.
 */
export const TRANSMITTANCE_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}
varying vec2 vUv;

void main() {
  float r, mu;
  atmTransParams(vUv, r, mu);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

  float tG = raySphere(ro, rd, ATM_GROUND);
  float tT = raySphere(ro, rd, ATM_TOP);
  float tMax = (tG > 0.0) ? tG : max(tT, 0.0);

  const int N = 40;
  vec3 od = vec3(0.0);
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    vec3 rayS, sigmaS, sigmaE; float mieS;
    atmMedium(length(p) - ATM_GROUND, rayS, mieS, sigmaS, sigmaE);
    od += sigmaE * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

/**
 * Hillaire's multiple-scattering LUT: the isotropic energy that eventually
 * finds its way to a point after >= 2 bounces. This is what stops the sky
 * from going flat black in the shadowed hemisphere and what gives thick
 * twilight its glow. 32x32, baked once per turbidity change.
 */
export const MULTISCATTER_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}
uniform sampler2D uTransLut;
varying vec2 vUv;

#define MS_DIRS  32
#define MS_STEPS 20

void main() {
  // Undo the sub-uv inset used at lookup time.
  vec2 uv = vec2(vUv.x * 33.0 / 32.0 - 0.5 / 32.0, vUv.y * 33.0 / 32.0 - 0.5 / 32.0);
  uv = clamp(uv, vec2(0.0), vec2(1.0));

  float muS = uv.x * 2.0 - 1.0;
  vec3 sunDir = vec3(0.0, muS, sqrt(satf(1.0 - muS * muS)));
  float r = mix(ATM_GROUND + 0.002, ATM_TOP, uv.y);
  vec3 ro = vec3(0.0, r, 0.0);

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);

  // Fibonacci sphere of directions — uniform, no clumping.
  const float GA = 2.39996322972865332;
  for (int d = 0; d < MS_DIRS; d++) {
    float fi = (float(d) + 0.5) / float(MS_DIRS);
    float cz = 1.0 - 2.0 * fi;
    float sz = sqrt(satf(1.0 - cz * cz));
    float ph = GA * float(d);
    vec3 rd = vec3(sz * cos(ph), cz, sz * sin(ph));

    float tG = raySphere(ro, rd, ATM_GROUND);
    float tT = raySphere(ro, rd, ATM_TOP);
    float tMax = (tG > 0.0) ? tG : max(tT, 0.0);
    if (tMax <= 0.0) continue;

    vec3 L = vec3(0.0), thr = vec3(1.0), msAs1 = vec3(0.0);
    float dt = tMax / float(MS_STEPS);
    const float ISO = 1.0 / (4.0 * ATM_PI);

    for (int i = 0; i < MS_STEPS; i++) {
      vec3 p = ro + rd * (float(i) + 0.5) * dt;
      float pr = length(p);
      vec3 upv = p / pr;
      vec3 rayS, sigmaS, sigmaE; float mieS;
      atmMedium(pr - ATM_GROUND, rayS, mieS, sigmaS, sigmaE);

      vec3 sT = exp(-sigmaE * dt);
      float shadow = (raySphere(p, sunDir, ATM_GROUND) >= 0.0) ? 0.0 : 1.0;
      vec3 tSun = atmTransmittance(uTransLut, pr, dot(upv, sunDir)) * shadow;

      vec3 S  = tSun * sigmaS * ISO;
      vec3 Si = (S - S * sT) / max(sigmaE, vec3(1e-7));
      L += thr * Si;

      vec3 Mi = (sigmaS - sigmaS * sT) / max(sigmaE, vec3(1e-7));
      msAs1 += thr * Mi;
      thr *= sT;
    }

    if (tG > 0.0) {   // diffuse bounce off the planet
      vec3 pg = ro + rd * tG;
      float pr = length(pg);
      vec3 upv = pg / pr;
      float ndl = satf(dot(upv, sunDir));
      L += thr * ndl * atmTransmittance(uTransLut, pr, dot(upv, sunDir)) * 0.28 / ATM_PI;
    }

    lumTotal += L / float(MS_DIRS);
    fmsTotal += msAs1 / float(MS_DIRS);
  }

  // Geometric series over infinite bounces.
  vec3 psi = lumTotal / max(vec3(1.0) - fmsTotal, vec3(1e-4));
  gl_FragColor = vec4(psi, 1.0);
}
`;

/**
 * Sky-view LUT: in-scattered radiance for every direction around the camera.
 * Rebuilt only when the sun / turbidity / camera altitude move enough to see.
 */
export const SKYVIEW_FRAG = /* glsl */`
${MATH}
${ATMOSPHERE}
uniform sampler2D uTransLut;
uniform sampler2D uMsLut;
uniform vec3  uSunDir;
uniform float uViewHeightKm;
varying vec2 vUv;

#define SV_STEPS 32

void main() {
  float viewHeight = ATM_GROUND + max(uViewHeightKm, 0.0005);
  vec3 rd; float clv;
  atmSkyViewParams(vUv, viewHeight, rd, clv);

  // Canonical frame: up = +Y, sun's horizontal projection = +X.
  float cosSZ = clamp(uSunDir.y, -1.0, 1.0);
  float sinSZ = sqrt(max(1.0 - cosSZ * cosSZ, 1e-6));
  vec3 sunDir = vec3(sinSZ, cosSZ, 0.0);

  vec3 ro = vec3(0.0, viewHeight, 0.0);
  float tG = raySphere(ro, rd, ATM_GROUND);
  float tT = raySphere(ro, rd, ATM_TOP);
  float tMax = (tG > 0.0) ? tG : max(tT, 0.0);
  if (tMax <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float cosTheta = dot(rd, sunDir);
  float pR = rayleighPhase(cosTheta);
  float pM = miePhase(uMieG, cosTheta);

  vec3 L = vec3(0.0), thr = vec3(1.0);
  float tPrev = 0.0;
  for (int i = 0; i < SV_STEPS; i++) {
    // Quadratic step distribution: dense near the camera where the air is.
    float x = (float(i) + 1.0) / float(SV_STEPS);
    float tCur = tMax * x * x;
    float dt = tCur - tPrev;
    vec3 p = ro + rd * (tPrev + dt * 0.5);
    tPrev = tCur;

    float pr = length(p);
    vec3 upv = p / pr;
    float muS = dot(upv, sunDir);
    vec3 rayS, sigmaS, sigmaE; float mieS;
    atmMedium(pr - ATM_GROUND, rayS, mieS, sigmaS, sigmaE);

    float shadow = (raySphere(p, sunDir, ATM_GROUND) >= 0.0) ? 0.0 : 1.0;
    vec3 tSun = atmTransmittance(uTransLut, pr, muS) * shadow;

    vec3 single = tSun * (rayS * pR + vec3(mieS) * pM);
    vec3 multi  = atmMultiScatter(uMsLut, pr, muS) * sigmaS;
    vec3 S = single + multi;

    vec3 sT = exp(-sigmaE * dt);
    L += thr * (S - S * sT) / max(sigmaE, vec3(1e-7));
    thr *= sT;
    if (thr.g < 1e-4) break;
  }

  gl_FragColor = vec4(L, 1.0);
}
`;
