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

/**
 * Rain.
 *
 * What this replaced, and why, because every number below is a reaction to a
 * measurement rather than a taste call. The previous streak was a quad 0.77 to
 * 1.57 m long and 28 mm wide -- 40:1 on screen, median 39 px and up to 175 px
 * of a 1080-line frame -- drawn for every drop in a 95 x 62 x 95 m box. Two
 * consequences, both measured at 'rain_street':
 *
 *  - 70% of the on-screen drops sat 30-50 m away and still drew at full
 *    strength -- mean alpha per drop was flat at 0.30-0.43 all the way out --
 *    so the layer marked 6.83% of the frame by more than 3/255, 0.81% of it by
 *    more than 100/255, peaking at 215. That is the "drawn over sky, brick,
 *    trunk and car alike" the critic kept describing.
 *  - Every drop shared one velocity but for a 0.82-1.18 scatter on fall speed,
 *    so every streak shared one world azimuth exactly. What angle variation
 *    the screen showed was perspective, not weather.
 *
 * So: length is now a shutter time (speed x uStreak) rather than a free
 * constant, which is what makes a distant drop a short dash instead of a long
 * one; density falls off with distance by dropping instances rather than by
 * dimming them; each drop carries its own turbulent velocity; and the quad is
 * shaded as a soft spindle instead of a flat-ended ribbon.
 */
export const RAIN_VERT = /* glsl */`
${MATH}
${LATTICE}
uniform vec3  uWind;
uniform float uFall;
uniform float uStreak;    // shutter, seconds: streak length is speed * this
uniform float uWidth;     // drop width, metres
uniform float uMinPx;     // narrowest quad allowed on screen, pixels
uniform float uMaxPx;     // longest streak allowed on screen, pixels
uniform float uJitter;    // per-drop turbulence, m/s
uniform float uNear;      // radius inside which density is full
uniform float uGroundY;
uniform float uFadeR;
uniform vec2  uViewport;

attribute vec3 aSeed;
varying vec2  vLocal;
varying float vAlpha;

void main() {
  // Per-drop turbulence. Without it every drop shares one velocity, so every
  // streak shares one world-space angle and the layer combs like geometry.
  vec3 t = hash33(aSeed + 0.137);
  float gust = 1.0 + 0.16 * (t.z - 0.5);
  vec3 vel = vec3(uWind.x * gust + (t.x - 0.5) * uJitter,
                  -uFall * (0.70 + aSeed.z * 0.62),
                  uWind.z * gust + (t.y - 0.5) * uJitter);

  vec3 world = latticeWrap(aSeed * uBox + vel * uTime);

  vec3 toCam = uCamPos - world;
  float dist = length(toCam);
  toCam /= max(dist, 1e-4);

  // Density, not brightness, falls off with distance: past uNear a drop is
  // stochastically dropped altogether. Dimming the far field uniformly leaves
  // the same number of streaks over the same pixels; thinning it does not.
  float keep = 1.0 - smoothstep(uNear, uFadeR, dist);
  float roll = hash11(aSeed.x * 31.7 + aSeed.y * 17.31 + aSeed.z * 7.93);
  if (roll > keep) {
    vAlpha = 0.0;
    vLocal = vec2(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // behind the far plane; clipped
    return;
  }

  vec3 dir = normalize(vel);
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-5));

  // Pixels per metre at this drop, straight out of the projection.
  float scale = projectionMatrix[1][1] * uViewport.y * 0.5 / max(dist, 0.05);

  float len = length(vel) * uStreak * (0.55 + aSeed.x * 0.95);
  len = min(len, uMaxPx / max(scale, 1e-3));

  // Widen a sub-pixel streak to uMinPx and dim it in proportion. Below a pixel
  // a quad stops getting thinner and starts flickering instead; spreading the
  // same ink over the minimum width is what keeps a far drop a faint mark.
  float grow = max(1.0, uMinPx / max(uWidth * scale, 1e-4));

  vec3 offs = side * (position.x * uWidth * grow) + dir * (position.y * len);

  // The ground fade used to span 2.9 m, which left a rain-free band a chest
  // height deep over the carriageway -- look down at the road in front of you
  // and it was dry. Depth testing already hides anything under the surface, so
  // this only needs to be wide enough to soften the intersection.
  vAlpha = smoothstep(1.1, 3.4, dist)
         * (1.0 - smoothstep(uFadeR * 0.55, uFadeR, dist))
         * smoothstep(uGroundY - 0.25, uGroundY + 0.45, world.y)
         / grow;
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
  float x = vLocal.x * 2.0;      // -1..1 across the streak
  float y = vLocal.y * 2.0;      // -1..1 along it; +1 is the leading end
  float ay = abs(y);

  // A spindle, not a quad. The half-width closes towards both ends, so the
  // silhouette comes to a point instead of the flat cut a billboard gives --
  // that flat cut is what read as "film-scratch damage".
  float hw = mix(sqrt(max(0.0, 1.0 - ay * ay)), 1.0, 0.28);

  // Gaussian across, so there is no hard edge anywhere to read as an edge of
  // geometry. Half-maximum lands at 45% of the quad width, which is why the
  // quad is authored wider than the drop it draws.
  float a = exp(-3.4 * x * x / max(hw * hw, 1e-4));

  // Soft ends, and a leading end denser than the trailing wake. The asymmetry
  // is small but it is what makes a streak read as travel rather than ribbon.
  a *= smoothstep(1.0, 0.28, ay);
  a *= 0.52 + 0.48 * smoothstep(-0.85, 0.95, y);

  a *= vAlpha * uOpacity;
  if (a < 0.003) discard;
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

/**
 * Ground impacts.
 *
 * `aSurf` carries what Weather.js looked up for this impact point on the CPU:
 * x is how hard the surface is (asphalt 1, pavement 0.65, anything unpaved 0)
 * and y is that point's true world height. Before it existed there was no
 * surface test of any kind and one flat height taken from under the camera, so
 * at 'rain_street' 50.9% of the visible ripples were ringing on grass and the
 * rest sat up to 0.65 m off the surface they were supposed to be on.
 *
 * Half the instances draw the ring; the other half stand a short camera-facing
 * plume of spray on the same impact, which is the part that was missing.
 */
export const SPLASH_VERT = /* glsl */`
${MATH}
uniform vec3  uCamPos;
uniform float uTime;
uniform float uGroundY;
uniform float uRadius;
uniform float uSize;

attribute vec3 aSeed;
attribute vec2 aSurf;

varying vec2  vLocal;
varying float vAge;
varying float vAlpha;
varying float vSpray;

void main() {
  // Static lattice of impact points; each cycles through its own ripple phase.
  float span = uRadius * 2.0;
  vec2 c = (aSeed.xy - 0.5) * span;
  c -= span * floor((c - uCamPos.xz) / span + 0.5);

  // Rain rings on something hard. Grass, soil and planting swallow the drop.
  float hard = aSurf.x;
  if (hard < 0.15) {
    vAlpha = 0.0; vAge = 0.0; vSpray = 0.0; vLocal = vec2(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // behind the far plane; clipped
    return;
  }

  float rate = 1.6 + aSeed.z * 2.4;
  float age = fract(uTime * rate + aSeed.x * 7.31 + aSeed.y * 3.17);
  float spray = step(0.55, hash11(aSeed.z * 53.17 + aSeed.x * 11.31));

  vec3 world = vec3(c.x, aSurf.y + 0.02, c.y);
  vec3 offs;
  if (spray > 0.5) {
    // Crown of spray standing on the impact, camera-facing, lifting as it dies.
    // Taller than the ring is wide: a splash crown throws up further than out.
    float hgt = uSize * (0.9 + aSeed.z * 1.3);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    offs = right * (position.x * hgt * 0.8)
         + vec3(0.0, (position.y + 0.5) * hgt * (0.35 + age * 1.4), 0.0);
  } else {
    float sz = uSize * (0.35 + age * 1.7) * (0.6 + aSeed.z * 0.8);
    offs = vec3(position.x * sz, 0.0, position.y * sz);
  }

  float dist = length(uCamPos.xz - c);
  vAlpha = (1.0 - smoothstep(uRadius * 0.55, uRadius * 0.95, dist))
         * smoothstep(0.6, 2.2, dist) * hard;
  vAge = age;
  vSpray = spray;
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
varying float vSpray;

void main() {
  float a;
  if (vSpray > 0.5) {
    // Spray: a narrow plume, densest at the base, gone by a third of the cycle.
    float up = vLocal.y + 0.5;                    // 0 on the ground, 1 at the top
    float w = satf(1.0 - abs(vLocal.x) * 2.0);
    a = w * w * (1.0 - up) * (1.0 - smoothstep(0.0, 0.30, vAge)) * 1.3;
  } else {
    float r = length(vLocal) * 2.0;
    // The impact itself carries most of the weight and the ring only hints,
    // because a road under rain wears a film rather than a pond: a full-strength
    // annulus reads as a hoop painted on the pavement. Many faint ones beat a
    // few legible ones.
    float ring = smoothstep(0.55, 0.84, r) * (1.0 - smoothstep(0.86, 1.0, r));
    float crown = (1.0 - smoothstep(0.0, 0.34, r)) * (1.0 - smoothstep(0.0, 0.18, vAge));
    float fade = 1.0 - vAge;
    a = ring * fade * fade * 0.34 + crown * 0.55;
  }
  a *= vAlpha * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);   // additive blend multiplies by a
}
`;
