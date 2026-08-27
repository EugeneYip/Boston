import { MATH } from './common.glsl.js';

/**
 * Precipitation is entirely GPU-resident: one instanced draw call each for
 * rain, snow and ground ripples. Positions are derived from a per-instance
 * seed and the clock, then wrapped onto a world-space lattice around the
 * camera, so drops have real parallax and nothing is ever written from the CPU.
 * Intensity is a change to `geometry.instanceCount`, not a per-vertex test.
 */

const LATTICE = /* glsl */`
uniform vec3  uBox;
uniform vec3  uBoxOffset;
uniform vec3  uCamPos;
uniform float uTime;

/** Nearest lattice copy of a drop to the camera. */
vec3 latticeWrap(vec3 p) {
  vec3 c = uCamPos + uBoxOffset;
  vec3 rel = p - c;
  rel -= uBox * floor(rel / uBox + 0.5);
  return c + rel;
}
`;

export const RAIN_VERT = /* glsl */`
${MATH}
${LATTICE}
uniform vec3  uWind;
uniform float uFall;
uniform float uStreak;
uniform float uWidth;
uniform float uGroundY;
uniform float uFadeR;

attribute vec3 aSeed;
varying vec2  vLocal;
varying float vAlpha;

void main() {
  vec3 vel = vec3(uWind.x, -uFall * (0.82 + aSeed.z * 0.36), uWind.z);
  vec3 world = latticeWrap(aSeed * uBox + vel * uTime);

  vec3 toCam = uCamPos - world;
  float dist = length(toCam);
  toCam /= max(dist, 1e-4);

  vec3 dir = normalize(vel);
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-5));
  float len = length(vel) * uStreak * (0.7 + aSeed.x * 0.7);
  vec3 offs = side * (position.x * uWidth) + dir * (position.y * len);

  vAlpha = smoothstep(0.7, 3.5, dist)
         * (1.0 - smoothstep(uFadeR * 0.62, uFadeR, dist))
         * smoothstep(uGroundY - 0.4, uGroundY + 2.5, world.y);
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(world + offs, 1.0);
}
`;

export const RAIN_FRAG = /* glsl */`
${MATH}
uniform vec3  uColor;
uniform float uOpacity;
varying vec2  vLocal;
varying float vAlpha;

void main() {
  float across = 1.0 - abs(vLocal.x) * 2.0;
  float along  = 1.0 - abs(vLocal.y) * 2.0;
  float a = pow(satf(across), 1.4) * smoothstep(0.0, 0.5, along);
  a *= vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export const SNOW_VERT = /* glsl */`
${MATH}
${LATTICE}
uniform vec3  uWind;
uniform float uFall;
uniform float uSize;
uniform float uGroundY;
uniform float uFadeR;

attribute vec3 aSeed;
varying vec2  vLocal;
varying float vAlpha;
varying float vSpin;

void main() {
  float ph = aSeed.x * 43.0 + aSeed.y * 17.0;
  float fall = uFall * (0.6 + aSeed.z * 0.8);
  // Flakes tumble: they drift sideways on a slow lissajous as they fall.
  vec3 drift = vec3(sin(uTime * (0.45 + aSeed.y * 0.5) + ph) * 1.9,
                    0.0,
                    cos(uTime * (0.38 + aSeed.x * 0.5) + ph * 1.3) * 1.9);
  vec3 world = latticeWrap(aSeed * uBox + vec3(uWind.x, -fall, uWind.z) * uTime) + drift;

  float dist = length(uCamPos - world);
  float sz = uSize * (0.45 + aSeed.x * 1.05);

  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float rot = uTime * (0.8 + aSeed.y * 2.4) + ph;
  float cr = cos(rot), sr = sin(rot);
  vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);

  vAlpha = smoothstep(0.5, 2.2, dist)
         * (1.0 - smoothstep(uFadeR * 0.60, uFadeR, dist))
         * smoothstep(uGroundY - 0.2, uGroundY + 1.4, world.y);
  vLocal = position.xy;
  vSpin = aSeed.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world + (right * q.x + up * q.y) * sz, 1.0);
}
`;

export const SNOW_FRAG = /* glsl */`
${MATH}
uniform vec3  uColor;
uniform float uOpacity;
varying vec2  vLocal;
varying float vAlpha;
varying float vSpin;

void main() {
  float r = length(vLocal) * 2.0;
  // Soft blob with a faint six-armed hint — heavy wet Boston snow, not glitter.
  float ang = atan(vLocal.y, vLocal.x);
  float arms = 0.82 + 0.18 * cos(ang * 6.0 + vSpin * 20.0);
  float a = smoothstep(1.0, 0.15, r / max(arms, 0.4));
  a *= vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export const SPLASH_VERT = /* glsl */`
${MATH}
uniform vec3  uCamPos;
uniform float uTime;
uniform float uGroundY;
uniform float uRadius;
uniform float uSize;

attribute vec3 aSeed;
varying vec2  vLocal;
varying float vAge;
varying float vAlpha;

void main() {
  // Static lattice of impact points; each cycles through its own ripple phase.
  float span = uRadius * 2.0;
  vec2 c = (aSeed.xy - 0.5) * span;
  c -= span * floor((c - uCamPos.xz) / span + 0.5);

  float rate = 1.6 + aSeed.z * 2.4;
  float age = fract(uTime * rate + aSeed.x * 7.31 + aSeed.y * 3.17);
  float sz = uSize * (0.35 + age * 1.5) * (0.6 + aSeed.z * 0.8);

  vec3 world = vec3(c.x, uGroundY + 0.02, c.y);
  vec3 offs = vec3(position.x * sz, 0.0, position.y * sz);

  float dist = length(uCamPos.xz - c);
  vAlpha = (1.0 - smoothstep(uRadius * 0.55, uRadius * 0.95, dist)) * smoothstep(0.8, 2.6, dist);
  vAge = age;
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(world + offs, 1.0);
}
`;

export const SPLASH_FRAG = /* glsl */`
${MATH}
uniform vec3  uColor;
uniform float uOpacity;
varying vec2  vLocal;
varying float vAge;
varying float vAlpha;

void main() {
  float r = length(vLocal) * 2.0;
  float ring = smoothstep(0.62, 0.86, r) * (1.0 - smoothstep(0.88, 1.0, r));
  float crown = (1.0 - smoothstep(0.0, 0.42, r)) * (1.0 - smoothstep(0.0, 0.22, vAge));
  float a = (ring * (1.0 - vAge) + crown * 0.8) * vAlpha * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);   // additive blend multiplies by a
}
`;
