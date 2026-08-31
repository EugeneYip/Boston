import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Forward+ style light manager.
 *
 * A night city has thousands of light sources; three.js recompiles every shader in
 * the scene when the light count changes and evaluates every light for every
 * fragment, so "just add lights" dies at about twenty. Instead:
 *
 *  - every source is registered into flat typed arrays (no objects, no GC),
 *  - a small FIXED pool of real THREE lights is re-aimed each frame at the N most
 *    visually important sources near the camera (fixed size => zero recompiles),
 *  - every other source is represented by additive proxy geometry: a ground light
 *    pool and a camera-facing halo, both instanced, both resident, both driven
 *    entirely on the GPU so a street of 400 lamps costs two draw calls.
 *
 * The proxies are what sells it. A real point light 200 m away contributes almost
 * nothing to a pixel, but the pool of light it throws on the road is the single
 * strongest cue that a street is lit.
 */

const T_STREET = 0, T_HEADLIGHT = 1, T_SIGN = 2, T_TAIL = 3, T_WINDOW = 4;
const TYPES = { street: T_STREET, headlight: T_HEADLIGHT, sign: T_SIGN, tail: T_TAIL, window: T_WINDOW };

const F_ENABLED = 1, F_DYNAMIC = 2, F_SPOT = 4, F_AUTONIGHT = 8, F_POOL = 16, F_GLOW = 32;

/** How far a moving ground pool may travel before it re-asks for the surface. */
const GROUND_RESAMPLE = 1.0;

const MAX_LIGHTS = 6000;
const MAX_POOLS = 6000;
const MAX_GLOWS = 8000;

/**
 * On-screen floor for a halo, in pixels of half-extent.
 *
 * A lamp two kilometres away is geometrically sub-pixel, and letting it shrink turns
 * a lit skyline into grey mush, so the size is clamped. But every pixel of that clamp
 * is additive overdraw multiplied by a few thousand instances, and the old constant
 * (0.0016) was authored against one particular viewport: it meant 1.4 px at 1080p,
 * 2.9 px at 540p and 1.9 px at 1440p. Deriving it from the live viewport instead
 * makes the cost predictable and the look resolution-independent.
 */
const GLOW_MIN_PX = 1.1;
/** Metres of slack in the glow bounds for that on-screen minimum at maximum reach. */
const GLOW_BOUND_SLACK = 6;
/**
 * Halos dimmer than this cannot survive 8-bit quantisation after exposure, so they
 * are pure overdraw. Cheap per-instance test in the vertex shader.
 */
const MIN_EMIT = 0.004;

/**
 * Additive gain of a street lamp's ground pool.
 *
 * The proxy exists to stand in for the real Point/SpotLight that the fixed pool
 * cannot afford to spend on this lamp, so its one correctness criterion is that
 * it lands the same light on the road that the real light would. It did not: it
 * landed an eighth of it, which is why 2,235 lamps produced no measurable pool
 * while the fifteen that hold a real light produce an obvious one.
 *
 * Calibrated rather than guessed. At `night_neon`, road luminance averaged over
 * the carriageway width in a +/-2.5 m band under the two nearest lamp stations,
 * converted to linear, with the pool quads already lifted onto the drawn surface:
 *
 *   real pooled lights only (proxies hidden)   0.02566
 *   proxies only (street lamp power zeroed)    0.00312   <- at the old 1.5
 *   neither (ambient alone)                    baseline
 *
 * i.e. the proxy was **8.23x** short. 1.5 x 8.23 = 12.3 at the old 1.45 x h
 * radius, and 12.3 x 0.47 = **5.8** at the 1.8 x h radius that replaced it
 * (`buildStreetLights`) — a wider quad delivers the same road luminance from a
 * lower peak, and delivering it that way measures better (see there).
 *
 * This is a gain on an additive quad, not a physical intensity: `POOL_FRAG`
 * writes radiance straight into the HDR buffer, so it never went through the
 * same falloff, BRDF and unit chain as `_power`, and there was nothing keeping
 * the two in step. The measurement above is that missing link. Re-measure it if
 * the pool radius, the falloff in `POOL_FRAG` or the exposure key changes —
 * energy per pool scales with the area, so widening the quad dilutes this.
 */
const POOL_STREET_GAIN = 5.8;

/**
 * How many of the real-light slots are reserved for sources that are NOT vehicle
 * headlights, before headlights are allowed to compete for what is left.
 *
 * `_select` gives a headlight a 2.4x score bonus so it reads as motion. That is
 * right for one car on a dark street and wrong for a city: with ~80 cars lit at
 * 22:00 the bonus plus sheer proximity took 11-12 of the 15 slots, static
 * allocation collapsed from 5 to 2, and 11.88% of the frame measured DARKER with
 * headlights on than off -- street lamps losing their promotion. The pool decals
 * are unaffected either way, so what was being lost is specifically the handful
 * of lamps that get a real light.
 *
 * A floor rather than a cap, because the failure is starvation and not excess:
 * if there are fewer than this many static candidates in range the remainder
 * still goes to headlights, so nothing is wasted on an empty street.
 */
const STATIC_FLOOR = 6;
/*
 * Swept in ONE page load (traffic spawns differently per load, so a cross-load
 * comparison of the vehicle-light signal is invalid -- the same floor read +0.003
 * on one load and -0.212 on the next). night_neon, actors frozen, 3 averaged
 * frames per state, 32,400 blocks of 8x8:
 *
 *   floor  headlights  static  darker  maxDarken  mean signal
 *     0        12        2     13.28%    178.2      +0.357
 *     4         9        4      5.75%     23.7      -0.243
 *     6         7        6      5.49%     16.4      -0.244
 *     8         6        8      6.60%     19.2      -0.261
 *
 * 6 is the knee: static allocation is restored, darker blocks and peak darkening
 * both bottom out, and 8 buys nothing. Note the mean signal INVERTS at any floor
 * above 0 and stays flat thereafter -- a street lamp's real light is worth more
 * mean luminance than the headlight that displaces it, because it is broad and
 * high while a headlight is a narrow cone down the road. Vehicle lights still
 * move ~2,600 blocks (8% of frame); what they no longer do is net-brighten it.
 */

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _col = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _obj = new THREE.Object3D();
const _size = new THREE.Vector2();

const NULL_HANDLE = {
  id: -1, setEnabled() {}, setIntensity() {}, setColor() {}, release() {},
};

/* Expand-only instance bounds, kept as six numbers so growing costs no allocation. */
function newBox() {
  return { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
}
function growBox(b, x, y, z, r) {
  if (x - r < b.x0) b.x0 = x - r;
  if (y - r < b.y0) b.y0 = y - r;
  if (z - r < b.z0) b.z0 = z - r;
  if (x + r > b.x1) b.x1 = x + r;
  if (y + r > b.y1) b.y1 = y + r;
  if (z + r > b.z1) b.z1 = z + r;
}
/** @returns {boolean} true when the sphere describes a real, non-empty set. */
function boxToSphere(b, sphere) {
  if (!(b.x0 <= b.x1)) return false;
  sphere.center.set((b.x0 + b.x1) * 0.5, (b.y0 + b.y1) * 0.5, (b.z0 + b.z1) * 0.5);
  sphere.radius = 0.5 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
  return true;
}

/** Boston runs warm sodium on the older streets and cool LED on the rebuilt ones. */
const SODIUM = new THREE.Color('#ffb15c');
const LED = new THREE.Color('#cfe0ff');
const MERCURY = new THREE.Color('#dfe9d8');
const OLD_DISTRICTS = new Set(['northEnd', 'beaconHill', 'southEnd', 'charlestown']);

/* -------------------------------------------------------------------------- */
/* Proxy shaders                                                              */
/* -------------------------------------------------------------------------- */

const POOL_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iAxis;    // xy = forward in XZ, z = half length, w = half width
attribute vec4 iColor;   // rgb = HDR linear colour, |a| = gain, a < 0 = not clock-driven
uniform float uFade0;
uniform float uFade1;
uniform float uNight;
varying vec2 vQ;
varying vec3 vC;
void main() {
  vQ = position.xy;
  float gain = abs( iColor.a ) * ( iColor.a < 0.0 ? 1.0 : uNight );
  vec3 f = vec3( iAxis.x, 0.0, iAxis.y );
  vec3 r = vec3( -iAxis.y, 0.0, iAxis.x );
  vec3 wp = iPos + r * ( position.x * iAxis.w ) + f * ( position.y * iAxis.z );
  vec4 mv = modelViewMatrix * vec4( wp, 1.0 );
  float d = -mv.z;
  gain *= 1.0 - smoothstep( uFade0, uFade1, d );
  vC = iColor.rgb * gain;
  // Cull dead instances outright rather than rasterising transparent black.
  gl_Position = gain <= 0.0009 ? vec4( 2.0, 2.0, 2.0, 1.0 ) : projectionMatrix * mv;
}
`;

const POOL_FRAG = /* glsl */`
varying vec2 vQ;
varying vec3 vC;
void main() {
  // Forward-biased falloff: the throw of a luminaire is not a clean disc.
  float r = length( vQ );
  float f = max( 1.0 - r, 0.0 );
  f = f * f * ( 0.55 + 0.45 * f );
  gl_FragColor = vec4( vC * f, 1.0 );
}
`;

const GLOW_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec4 iColor;
uniform float uFade0;
uniform float uFade1;
uniform float uNight;
uniform float uMinPx;    // view-space metres per screen pixel, per metre of depth
uniform float uMinEmit;  // below this the halo cannot survive quantisation: skip it
varying vec2 vQ;
varying vec3 vC;
void main() {
  vQ = position.xy;
  float gain = abs( iColor.a ) * ( iColor.a < 0.0 ? 1.0 : uNight );
  vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
  float d = max( -mv.z, 0.01 );
  gain *= 1.0 - smoothstep( uFade0, uFade1, d );
  // Never let a lamp shrink below about a pixel; a receding lit street has to stay a
  // chain of points, not fade into mush. uMinPx is derived from the real viewport
  // each frame, so this is a *pixel* floor rather than a constant that silently
  // becomes three pixels at half resolution and one at 4K.
  vec2 sz = max( iSize, vec2( d * uMinPx ) );
  mv.xy += position.xy * sz;
  // Spreading a fixed amount of light over a larger quad has to dim it, or a distant
  // street reads brighter than a near one.
  vC = iColor.rgb * gain * ( iSize.x * iSize.y ) / max( sz.x * sz.y, 1e-5 );
  // Cull outright rather than rasterising something that rounds to black. Both tests
  // are per-instance, so the whole quad is skipped at the vertex stage.
  bool dead = gain <= 0.0009 || max( vC.r, max( vC.g, vC.b ) ) < uMinEmit;
  gl_Position = dead ? vec4( 2.0, 2.0, 2.0, 1.0 ) : projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */`
varying vec2 vQ;
varying vec3 vC;
void main() {
  float r = length( vQ );
  float core = exp( -r * r * 7.0 );
  float halo = max( 1.0 - r, 0.0 );
  halo = halo * halo * halo;
  gl_FragColor = vec4( vC * ( core * 2.2 + halo * 0.55 ), 1.0 );
}
`;

const HEAD_VERT = /* glsl */`
attribute vec3 iColor;
varying vec3 vC;
void main() {
  vC = iColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;

const HEAD_FRAG = /* glsl */`
uniform float uNight;
uniform vec3 uOff;
varying vec3 vC;
void main() {
  gl_FragColor = vec4( mix( uOff, vC, uNight ), 1.0 );
}
`;

/* -------------------------------------------------------------------------- */

export default class LightManager {
  constructor() {
    const n = MAX_LIGHTS;
    this._px = new Float32Array(n); this._py = new Float32Array(n); this._pz = new Float32Array(n);
    this._dx = new Float32Array(n); this._dy = new Float32Array(n); this._dz = new Float32Array(n);
    this._cr = new Float32Array(n); this._cg = new Float32Array(n); this._cb = new Float32Array(n);
    this._range = new Float32Array(n);
    this._power = new Float32Array(n);
    this._gain = new Float32Array(n);
    this._cone = new Float32Array(n);
    this._type = new Uint8Array(n);
    this._flags = new Uint8Array(n);
    this._poolIdx = new Int16Array(n).fill(-1);
    this._glowIdx = new Int16Array(n).fill(-1);
    this._pscale = new Float32Array(n).fill(1);
    this._obj = new Array(n).fill(null);
    this._count = 0;
    this._free = [];

    // Selection scratch (never reallocated).
    this._selIdx = new Int32Array(32);
    this._selScore = new Float32Array(32);
    this._selN = 0;
    this._assigned = new Int32Array(32).fill(-1);
    this._assignFade = new Float32Array(32);

    this._poolCount = 0;
    this._glowCount = 0;
    this._poolFree = [];
    this._glowFree = [];
    this._poolDirty = false;
    this._glowDirty = false;
    this._lampIds = [];
    // Instance bounds, grown as sources are registered or move. Expand-only: a
    // conservative sphere is always correct for culling, and the set converges on
    // the city's own extent within a few seconds of a vehicle driving about.
    this._poolBox = newBox();
    this._glowBox = newBox();
    this._boundsDirty = true;

    this.night = 0;
    this.group = new THREE.Group();
    this.group.name = 'lights';
    this._disposables = [];
    this._lampCount = 0;
  }

  /* ---------------------------------------------------------------- setup -- */

  async init(ctx) {
    this.ctx = ctx;
    this._buildPools(ctx);
    this._buildProxies(ctx);
    ctx.scene.add(this.group);
  }

  /** Fixed-size pool of real lights. Size never changes => no shader recompiles. */
  _buildPools(ctx) {
    const q = ctx.settings.preset;
    const nPoint = q === 'low' ? 4 : q === 'medium' ? 7 : 10;
    const nSpot = q === 'low' ? 2 : q === 'medium' ? 3 : 5;

    this.pointPool = [];
    this.spotPool = [];
    for (let i = 0; i < nPoint; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2);
      l.castShadow = false;
      l.visible = true;                 // must stay visible: hiding changes the count
      this.group.add(l);
      this.pointPool.push(l);
    }
    for (let i = 0; i < nSpot; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 40, 0.62, 0.55, 2);
      l.castShadow = false;
      l.visible = true;
      l.target.position.set(0, 0, -1);
      this.group.add(l, l.target);
      this.spotPool.push(l);
    }
    this.poolSize = nPoint + nSpot;
  }

  _buildProxies(ctx) {
    // Separate base quads: two geometries must not share buffers they will both dispose.
    const quad = new THREE.PlaneGeometry(2, 2);
    const quad2 = new THREE.PlaneGeometry(2, 2);

    // --- ground light pools -------------------------------------------------
    const pg = new THREE.InstancedBufferGeometry();
    pg.index = quad.index;
    pg.setAttribute('position', quad.getAttribute('position'));
    this._poolPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 3), 3);
    this._poolAxis = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 4), 4);
    this._poolCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 4), 4);
    // Where each pool slot last asked the city for a surface height, so a moving
    // pool can reuse the answer until it has actually gone somewhere. See
    // `_poolGroundAt`.
    /**
     * Runtime override for `STATIC_FLOOR`, so the reservation can be swept inside
     * ONE page load. It has to be: traffic spawns to different positions on every
     * load, so how many cars sit near the camera varies and a cross-load
     * comparison of the vehicle-light signal is not valid. Measured that the hard
     * way -- the same floor read +0.003 on one load and -0.212 on the next.
     */
    this.staticFloor = STATIC_FLOOR;
    this._poolGX = new Float32Array(MAX_POOLS);
    this._poolGZ = new Float32Array(MAX_POOLS);
    this._poolGY = new Float32Array(MAX_POOLS);
    this._poolGSet = new Uint8Array(MAX_POOLS);
    this._poolPos.setUsage(THREE.DynamicDrawUsage);
    this._poolAxis.setUsage(THREE.DynamicDrawUsage);
    this._poolCol.setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('iPos', this._poolPos);
    pg.setAttribute('iAxis', this._poolAxis);
    pg.setAttribute('iColor', this._poolCol);
    pg.instanceCount = 0;

    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      uniforms: { uFade0: { value: 190 }, uFade1: { value: 340 }, uNight: { value: 0 } },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      toneMapped: true, fog: false,
    });
    this.poolMesh = new THREE.Mesh(pg, this.poolMat);
    // Both proxy meshes place their instances entirely in the vertex shader, so
    // three's computeBoundingSphere would measure the 2x2 base quad and cull the
    // whole city away. We track the real instance bounds ourselves (see _flush) —
    // which is what makes frustum culling safe, and it is worth having: looking away
    // from downtown should not rasterise downtown's halos.
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.poolMesh.frustumCulled = true;
    this.poolMesh.renderOrder = 6;
    this.poolMesh.name = 'lightPools';
    this.group.add(this.poolMesh);
    this._disposables.push(pg, this.poolMat);

    // --- bulbs / halos ------------------------------------------------------
    const gg = new THREE.InstancedBufferGeometry();
    gg.index = quad2.index;
    gg.setAttribute('position', quad2.getAttribute('position'));
    this._glowPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLOWS * 3), 3);
    this._glowSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLOWS * 2), 2);
    this._glowCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GLOWS * 4), 4);
    this._glowPos.setUsage(THREE.DynamicDrawUsage);
    this._glowSize.setUsage(THREE.DynamicDrawUsage);
    this._glowCol.setUsage(THREE.DynamicDrawUsage);
    gg.setAttribute('iPos', this._glowPos);
    gg.setAttribute('iSize', this._glowSize);
    gg.setAttribute('iColor', this._glowCol);
    gg.instanceCount = 0;

    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      uniforms: {
        uFade0: { value: 700 }, uFade1: { value: 1600 },
        uNight: { value: 0 }, uMinPx: { value: 0.0016 },
        uMinEmit: { value: MIN_EMIT },
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true,
      toneMapped: true, fog: false,
    });
    this.glowMesh = new THREE.Mesh(gg, this.glowMat);
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.glowMesh.frustumCulled = true;
    this.glowMesh.renderOrder = 7;
    this.glowMesh.name = 'lightGlows';
    this.group.add(this.glowMesh);
    this._disposables.push(gg, this.glowMat);
  }

  /* ------------------------------------------------------------- register -- */

  /**
   * Register a light source. Cheap: no THREE.Light is created.
   * @param {THREE.Object3D|null} obj3d anchor; if it moves, pass `dynamic: true`.
   *        The beam of a spot/headlight points along the object's local -Z.
   * @param {object} o
   * @param {'street'|'headlight'|'sign'|'tail'|'window'} o.type
   * @param {number} [o.range]      metres at which the source stops mattering
   * @param {number} [o.intensity]  candela-ish; matches ARCHITECTURE's 20-80 range
   * @param {THREE.Color|number|string} [o.color]
   * @param {number[]} [o.position] world position when there is no obj3d
   * @param {number} [o.groundY]    y of the surface the pool lands on
   * @param {number} [o.poolRadius] 0 disables the ground pool
   * @param {number} [o.poolLength] for beams; defaults to poolRadius
   * @param {number} [o.haloSize]   0 disables the halo
   * @returns {{id:number, setEnabled:Function, setIntensity:Function, setColor:Function, release:Function}}
   */
  register(obj3d, o = {}) {
    if (!this._free.length && this._count >= MAX_LIGHTS) return NULL_HANDLE;
    const id = this._free.length ? this._free.pop() : this._count++;

    const type = TYPES[o.type] ?? T_STREET;
    this._type[id] = type;
    this._obj[id] = obj3d || null;

    _col.set(o.color !== undefined ? o.color : (type === T_TAIL ? '#ff2a12' : '#ffffff'));
    this._cr[id] = _col.r; this._cg[id] = _col.g; this._cb[id] = _col.b;

    this._range[id] = o.range ?? (type === T_HEADLIGHT ? 42 : type === T_TAIL ? 9 : 26);
    this._power[id] = o.intensity ?? (type === T_HEADLIGHT ? 150 : type === T_TAIL ? 9 : 110);
    this._cone[id] = Math.cos(o.cone ?? 0.62);
    this._gain[id] = 1;

    let f = F_ENABLED;
    // Anything anchored to an Object3D is assumed to move unless told otherwise:
    // other agents pool their own anchors and would otherwise be left at the origin.
    if (o.dynamic !== false && obj3d) f |= F_DYNAMIC;
    if (type === T_HEADLIGHT || o.spot) f |= F_SPOT;
    if (o.autoNight !== false) f |= F_AUTONIGHT;

    if (obj3d) {
      obj3d.updateWorldMatrix(true, false);
      _v.setFromMatrixPosition(obj3d.matrixWorld);
    } else if (o.position) {
      _v.set(o.position[0], o.position[1], o.position[2]);
    } else _v.set(0, 0, 0);
    this._px[id] = _v.x; this._py[id] = _v.y; this._pz[id] = _v.z;
    this._dx[id] = 0; this._dy[id] = -1; this._dz[id] = 0;
    if (obj3d) this._readDirection(id, obj3d);

    // Proxy slots. Allocated once and never moved, so the buffers stay static
    // unless a light actually changes. A caller that supplies its own moving anchor
    // for a fixed fitting (another system pooling its lamps) gets no proxy: it
    // already has the geometry, and a pool sliding down the street looks wrong.
    const anchored = !!obj3d && (type === T_STREET || type === T_WINDOW);
    const groundY = o.groundY ?? this._groundAt(_v.x, _v.z, _v.y);
    const pr = o.poolRadius ?? (anchored ? 0 : type === T_HEADLIGHT ? 4.2 : type === T_TAIL ? 0 :
      type === T_SIGN ? 3.6 : Math.max(4, (_v.y - groundY) * 1.15));
    if (pr > 0 && (this._poolFree.length || this._poolCount < MAX_POOLS)) {
      const pi = this._poolFree.length ? this._poolFree.pop() : this._poolCount++;
      this._poolIdx[id] = pi;
      f |= F_POOL;
      this._poolPos.setXYZ(pi, _v.x, groundY + 0.035, _v.z);
      const len = o.poolLength ?? (type === T_HEADLIGHT ? 15 : pr);
      this._poolAxis.setXYZW(pi, 0, 1, len, pr);
      growBox(this._poolBox, _v.x, groundY + 0.035, _v.z, Math.max(len, pr));
      this._poolDirty = true;
      this._boundsDirty = true;
    }
    const hs = o.haloSize ?? (anchored ? 0 : type === T_HEADLIGHT ? 0.55 :
      type === T_TAIL ? 0.34 : type === T_SIGN ? 0.8 : 0.62);
    if (hs > 0 && (this._glowFree.length || this._glowCount < MAX_GLOWS)) {
      const gi = this._glowFree.length ? this._glowFree.pop() : this._glowCount++;
      this._glowIdx[id] = gi;
      f |= F_GLOW;
      this._glowPos.setXYZ(gi, _v.x, _v.y, _v.z);
      this._glowSize.setXY(gi, hs, hs);
      // Slack covers the on-screen minimum size, which grows the quad with distance.
      growBox(this._glowBox, _v.x, _v.y, _v.z, hs + GLOW_BOUND_SLACK);
      this._glowDirty = true;
      this._boundsDirty = true;
    }
    this._flags[id] = f;
    this._writeProxyColour(id);

    const self = this;
    return {
      id,
      setEnabled(on) { self.setEnabled(id, on); },
      setIntensity(v) { self._power[id] = v; self._writeProxyColour(id); },
      setColor(c) { _col.set(c); self._cr[id] = _col.r; self._cg[id] = _col.g; self._cb[id] = _col.b; self._writeProxyColour(id); },
      release() { self.unregister(id); },
    };
  }

  unregister(id) {
    if (id < 0 || id >= this._count || this._free.includes(id)) return;
    this._flags[id] = 0;
    this._obj[id] = null;
    this._gain[id] = 0;
    this._writeProxyColour(id);          // zeroes the instances before releasing them
    if (this._poolIdx[id] >= 0) {
      // The next owner of this slot is somewhere else entirely; drop the memo.
      this._poolGSet[this._poolIdx[id]] = 0;
      this._poolFree.push(this._poolIdx[id]); this._poolIdx[id] = -1;
    }
    if (this._glowIdx[id] >= 0) { this._glowFree.push(this._glowIdx[id]); this._glowIdx[id] = -1; }
    this._pscale[id] = 1;
    this._free.push(id);
  }

  /** Drop every lamp we placed, so a city rebuild can re-light from scratch. */
  clearStreetLights() {
    for (const id of this._lampIds) this.unregister(id);
    this._lampIds.length = 0;
    for (const m of [this._poleShort, this._poleTall, this._headMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose?.();
    }
    this._poleShort = this._poleTall = this._headMesh = null;
    this._lampCount = 0;
  }

  setEnabled(id, on) {
    if (id < 0) return;
    if (on) this._flags[id] |= F_ENABLED; else this._flags[id] &= ~F_ENABLED;
    this._flags[id] &= ~F_AUTONIGHT;      // an explicit call takes over from the clock
    this._writeProxyColour(id);
  }

  /* --------------------------------------------------------------- street -- */

  /**
   * Light the city's street lamps.
   *
   * Preference order:
   *  1. the Props agent's lamp sites — it owns the posts, we own the light,
   *  2. the City agent's road graph — we place and build posts ourselves,
   *  3. the placeholder block grid, so night is testable before either lands.
   */
  buildStreetLights(ctx) {
    const city = ctx.get('city');
    const lamps = this._lampScratch || (this._lampScratch = []);
    lamps.length = 0;

    const sites = this._propLampSites(ctx);
    let ownFixtures = true;
    if (sites) { this._lampsFromSites(ctx, sites, lamps); ownFixtures = false; }
    else if (city?.roads?.edges?.length && city.roads.sample) this._lampsFromRoads(city, lamps);
    else this._lampsFallback(ctx, lamps);

    if (!lamps.length) return 0;
    if (ownFixtures) this._buildLampFixtures(ctx, lamps);

    for (const L of lamps) {
      const h = this.register(null, {
        type: 'street',
        position: [L.x, L.y, L.z],
        groundY: L.g,
        color: L.led ? LED : L.mercury ? MERCURY : SODIUM,
        range: L.h * 3.4,
        intensity: L.led ? 130 : 108,
        // 1.45 -> 1.8 x the mounting height. A luminaire's useful throw is about
        // twice its height; at 1.45 the quad stopped short of the far side of the
        // carriageway, and since the pool is centred under the post — on the
        // pavement, ~6.6 m off the centreline on this street — that left the
        // middle of the road outside every pool.
        //
        // Swept at the graded `night_neon` framing, road luminance averaged across
        // the carriageway in +/-2.5 m bands, gain compensated each time to hold the
        // frame mean (under lamp / between lamps / ratio):
        //   no pools      54.2 / 35.2 / 1.54     1.8x h   71.9 / 36.5 / **1.97**
        //   1.45x h       65.2 / 35.5 / 1.84     2.0x h   76.2 / 39.2 / 1.94
        //                                        2.3x h   81.7 / 43.0 / 1.90
        // Past 1.8 the pools start merging and the ratio turns over — the light
        // arrives, but between the lamps as well, which is the wash this is meant
        // to replace. Fill cost of the whole sweep is 0.2 ms of a 3.1 ms frame.
        poolRadius: L.h * 1.8,
        haloSize: L.led ? 0.5 : 0.62,
      });
      if (h.id >= 0) this._lampIds.push(h.id);
    }
    this._lampCount = lamps.length;
    return lamps.length;
  }

  /** Whoever builds the posts publishes their luminaire positions here. */
  _propLampSites(ctx) {
    for (const id of ['props', 'streetFurniture', 'streetProps']) {
      const s = ctx.get(id);
      const a = s?.lampSites || s?._lampSites;
      if (Array.isArray(a) && a.length) return a;
    }
    return null;
  }

  /**
   * A luminaire's height tells you what it is: a 9 m cobra head is an arterial LED
   * or high-pressure sodium; a 4 m acorn or twin globe is heritage, and Boston runs
   * those warm.
   */
  _lampsFromSites(ctx, sites, out) {
    const city = ctx.get('city');
    // Thin uniformly rather than truncating, so a huge city still lights evenly
    // instead of going dark past some arbitrary index.
    const stride = Math.max(1, Math.ceil(sites.length / (MAX_POOLS - 400)));
    for (let si = 0; si < sites.length; si += stride) {
      const s = sites[si];
      if (!isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z)) continue;
      // The DRAWN surface, not the terrain raster (see `_groundAt`). This is also
      // what makes `h` the real mounting height: against `groundHeight` it read
      // 4.46 m for a 3.85 m heritage acorn, which oversized both the pool and the
      // range by the same 14%.
      const g = this._groundAt(s.x, s.z, s.y);
      const h = Math.max(2.5, s.y - g);
      const heritage = h < 6;
      const dist = city?.districtAt ? city.districtAt(s.x, s.z) : 'financial';
      out.push({
        x: s.x, z: s.z, g, y: s.y, h,
        led: !heritage && !OLD_DISTRICTS.has(dist),
        mercury: false,
        armX: 1, armZ: 0,
      });
    }
  }

  _lampsFromRoads(city, out) {
    const R = city.roads;
    const nodes = new Map();
    for (const n of R.nodes) nodes.set(n.id, n);
    for (const e of R.edges) {
      if (e.type === 'alley') continue;
      const a = nodes.get(e.a), b = nodes.get(e.b);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 12) continue;

      const arterial = e.type === 'highway' || e.type === 'arterial';
      const h = e.type === 'highway' ? 12 : arterial ? 9.2 : 7.2;
      const spacing = e.type === 'highway' ? 45 : arterial ? 34 : 28;
      const off = (e.width || (e.lanes || 2) * 3.5) * 0.5 + 0.9;
      const n = Math.max(1, Math.round(len / spacing));

      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const s = R.sample(e.id, t);
        // Derive the tangent from two samples: no assumption about which convention
        // the City agent used for `heading`.
        const s2 = R.sample(e.id, t < 0.99 ? t + 0.01 : t - 0.01);
        if (!s || !s2 || !isFinite(s.x) || !isFinite(s2.x)) continue;
        let tx = (s2.x - s.x) * (t < 0.99 ? 1 : -1);
        let tz = (s2.z - s.z) * (t < 0.99 ? 1 : -1);
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const side = (i & 1) ? 1 : -1;
        const px = s.x + -tz * off * side;
        const pz = s.z + tx * off * side;
        const g = this._groundAt(px, pz, s.y);
        const dist = city.districtAt ? city.districtAt(px, pz) : 'financial';
        out.push({
          x: px, z: pz, g, y: g + h, h,
          led: arterial || !OLD_DISTRICTS.has(dist),
          mercury: dist === 'charlestown',
          // Arm points back across the carriageway, away from the kerb.
          armX: tz * side, armZ: -tx * side,
        });
      }
    }
  }

  /** Placeholder-city fallback: a lit grid so night is testable pre-City-agent. */
  _lampsFallback(ctx, out) {
    const PITCH = 90, HALF = 45, KERB = 15, SPAN = 620, STEP = 34;
    const gh = (x, z) => this._groundAt(x, z, undefined);
    const kn = Math.floor(SPAN / PITCH), jn = Math.floor(SPAN / STEP);
    for (let k = -kn; k <= kn; k++) {
      const line = k * PITCH + HALF;
      const led = ((k * 2654435761) >>> 0) % 3 !== 0;
      const h = led ? 9.2 : 7.2;
      for (let j = -jn; j <= jn; j++) {
        const along = j * STEP;
        const s = (j & 1) ? 1 : -1;
        const kerb = KERB * s;
        // One lamp line running north-south, one running east-west. Arms point in
        // toward the centre of the carriageway.
        out.push({ x: line + kerb, z: along, g: gh(line + kerb, along), y: gh(line + kerb, along) + h,
          h, led, mercury: false, armX: -s, armZ: 0 });
        out.push({ x: along, z: line + kerb, g: gh(along, line + kerb), y: gh(along, line + kerb) + h,
          h, led, mercury: false, armX: 0, armZ: -s });
      }
    }
  }

  /** Merged pole+arm geometry, instanced. Two height classes, one head mesh. */
  _buildLampFixtures(ctx, lamps) {
    const mats = ctx.get('materials');
    const poleMat = mats?.get?.('metal_painted') || new THREE.MeshStandardMaterial({
      color: 0x2b2e33, roughness: 0.52, metalness: 0.75,
    });
    if (!mats?.get) this._disposables.push(poleMat);

    // Low-poly on purpose: these get drawn once per cascade as well as once for the
    // camera, so a lamp post has to cost about 50 triangles, not 500.
    const mk = (h) => {
      const parts = [];
      const pole = new THREE.CylinderGeometry(0.085, 0.13, h, 6, 1, true);
      pole.translate(0, h * 0.5, 0);
      parts.push(pole);
      // Cobra-head arm: two segments approximating the sweep out over the road.
      const armLen = h * 0.24;
      for (let i = 0; i < 2; i++) {
        const t = i / 2;
        const seg = new THREE.CylinderGeometry(0.065, 0.075, armLen * 0.62, 5, 1, true);
        seg.rotateZ(-Math.PI / 2 + (1 - t) * 0.5);
        seg.translate(armLen * (t * 0.55 + 0.24), h + t * 0.34 - 0.02, 0);
        parts.push(seg);
      }
      const g = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      return g;
    };

    const gShort = mk(7.2), gTall = mk(9.2);
    const head = new THREE.BoxGeometry(0.8, 0.19, 0.4);
    head.translate(0, -0.07, 0);

    let nShort = 0, nTall = 0;
    for (const L of lamps) (L.led ? nTall++ : nShort++);

    // Every caster is redrawn per cascade; past a few thousand posts the shadow of a
    // 9 cm pole is not worth the draw budget.
    const cast = lamps.length <= 2600;
    const mkInst = (geo, count) => {
      if (!count) return null;
      const m = new THREE.InstancedMesh(geo, poleMat, count);
      m.castShadow = cast; m.receiveShadow = true;
      m.name = 'streetLampPoles';
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      this.group.add(m);
      this._disposables.push(geo);
      return m;
    };
    this._poleShort = mkInst(gShort, nShort);
    this._poleTall = mkInst(gTall, nTall);

    this.headMat = new THREE.ShaderMaterial({
      vertexShader: HEAD_VERT, fragmentShader: HEAD_FRAG,
      uniforms: { uNight: { value: 0 }, uOff: { value: new THREE.Color(0x26282c) } },
      toneMapped: true, fog: false,
    });
    const headMesh = new THREE.InstancedMesh(head, this.headMat, lamps.length);
    headMesh.name = 'streetLampHeads';
    headMesh.frustumCulled = false;
    const headCol = new THREE.InstancedBufferAttribute(new Float32Array(lamps.length * 3), 3);
    head.setAttribute('iColor', headCol);
    this.group.add(headMesh);
    this._headMesh = headMesh;
    this._disposables.push(head, this.headMat);

    let si = 0, ti = 0;
    for (let i = 0; i < lamps.length; i++) {
      const L = lamps[i];
      const arm = L.h * 0.24 * 0.79 + 0.17;
      // The geometry's arm runs along +X, so yaw the post until +X lines up with the
      // direction the arm should reach across the carriageway.
      const rot = Math.atan2(-(L.armZ || 0), L.armX || 1);
      _q.setFromAxisAngle(_v.set(0, 1, 0), rot);
      _obj.position.set(L.x, L.g, L.z);
      _obj.quaternion.copy(_q);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      (L.led ? this._poleTall : this._poleShort)?.setMatrixAt(L.led ? ti++ : si++, _obj.matrix);

      _obj.position.set(L.x + (L.armX || 1) * arm, L.y, L.z + (L.armZ || 0) * arm);
      _obj.updateMatrix();
      headMesh.setMatrixAt(i, _obj.matrix);
      // Fixtures are the bloom source: author them well above 1.0.
      _col.copy(L.led ? LED : L.mercury ? MERCURY : SODIUM).multiplyScalar(L.led ? 5.5 : 4.4);
      headCol.setXYZ(i, _col.r, _col.g, _col.b);

      // Move the registered light to the luminaire, not the pole.
      L.x = _obj.position.x; L.z = _obj.position.z;
    }
    if (this._poleShort) this._poleShort.instanceMatrix.needsUpdate = true;
    if (this._poleTall) this._poleTall.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    headCol.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- frame -- */

  update(dt, ctx, night) {
    this.night = night;
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(_camFwd);

    this.poolMat.uniforms.uNight.value = night;
    this.glowMat.uniforms.uNight.value = night;
    if (this.headMat) this.headMat.uniforms.uNight.value = night;
    const dd = ctx.settings.drawDist;
    this.poolMat.uniforms.uFade0.value = Math.min(220, dd * 0.12);
    this.poolMat.uniforms.uFade1.value = Math.min(420, dd * 0.24);
    this.glowMat.uniforms.uFade1.value = dd;
    this.glowMat.uniforms.uFade0.value = dd * 0.55;
    this.glowMat.uniforms.uMinPx.value = this._minPx(ctx);

    this._refreshDynamic();
    this._select(_camPos, _camFwd, ctx.settings.drawDist);
    this._applyPools(dt, night);
    this._flush();
  }

  /**
   * View-space metres per screen pixel, per metre of depth — i.e. multiply by the
   * distance to a point to get the size of one pixel there. That is exactly the unit
   * GLOW_VERT's minimum-size clamp needs, so the halo floor is a fixed number of
   * pixels at any resolution, FOV or quality preset.
   */
  _minPx(ctx) {
    const cam = ctx.camera;
    const h = ctx.renderer?.getDrawingBufferSize
      ? ctx.renderer.getDrawingBufferSize(_size).y
      : (ctx.renderer?.domElement?.height || 1080);
    if (!cam.isPerspectiveCamera || !(h > 0)) return 0.0016;
    return GLOW_MIN_PX * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) / h;
  }

  _refreshDynamic() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      if (!(this._flags[i] & F_DYNAMIC)) continue;
      const o = this._obj[i];
      if (!o || !o.parent) continue;
      o.updateWorldMatrix(true, false);
      _v.setFromMatrixPosition(o.matrixWorld);
      if (_v.x === this._px[i] && _v.y === this._py[i] && _v.z === this._pz[i]) continue;
      this._px[i] = _v.x; this._py[i] = _v.y; this._pz[i] = _v.z;
      this._readDirection(i, o);

      const gi = this._glowIdx[i];
      if (gi >= 0) {
        this._glowPos.setXYZ(gi, _v.x, _v.y, _v.z);
        growBox(this._glowBox, _v.x, _v.y, _v.z,
          this._glowSize.getX(gi) + GLOW_BOUND_SLACK);
        this._glowDirty = true;
        this._boundsDirty = true;
      }
      const pi = this._poolIdx[i];
      if (pi >= 0) {
        const dx = this._dx[i], dz = this._dz[i];
        const l = Math.hypot(dx, dz) || 1;
        const throwLen = this._type[i] === T_HEADLIGHT ? 11 : 0;
        const px = _v.x + (dx / l) * throwLen, pz = _v.z + (dz / l) * throwLen;
        const g = this._poolGroundAt(pi, px, pz, _v.y);
        this._poolPos.setXYZ(pi, px, g + 0.035, pz);
        this._poolAxis.setXYZW(pi, dx / l, dz / l,
          this._poolAxis.getZ(pi), this._poolAxis.getW(pi));
        growBox(this._poolBox, px, g + 0.035, pz,
          Math.max(this._poolAxis.getZ(pi), this._poolAxis.getW(pi)));
        this._poolDirty = true;
        this._boundsDirty = true;
      }
    }
  }

  /**
   * World-space beam direction: the object's local -Z.
   *
   * Read straight off `matrixWorld`'s third basis column rather than through
   * `getWorldQuaternion`, which walks the whole parent chain a second time and
   * then decomposes the matrix. Both callers have just updated `matrixWorld`, and
   * the negated third column IS the world -Z axis up to scale, which normalising
   * removes. Measured with a city's worth of vehicle lights registered: 0.63 ms
   * per frame over 515 calls, against 0.03 ms for this.
   */
  _readDirection(i, o) {
    const e = o.matrixWorld.elements;
    const x = -e[8], y = -e[9], z = -e[10];
    const l = Math.hypot(x, y, z) || 1;
    this._dx[i] = x / l; this._dy[i] = y / l; this._dz[i] = z / l;
  }

  /**
   * Pick the N most important sources near the camera. O(count) per pass.
   *
   * Two passes, because one pass starves street lighting. The first reserves
   * `STATIC_FLOOR` slots for everything that is not a vehicle headlight; the
   * second lets every source, headlights included, compete for the rest. Pass two
   * may not evict a reservation, so the floor holds -- but if pass one cannot
   * fill it, pass two takes the remainder and no slot is wasted.
   */
  _select(camPos, camFwd, drawDist) {
    const K = this.poolSize;
    const cull = Math.min(drawDist * 0.25, 190);
    const cull2 = cull * cull;
    const dayOff = this.night < 0.02;
    const floor = Math.min(this.staticFloor, K);
    this._selN = 0;
    this._scan(camPos, camFwd, cull2, dayOff, floor, 0, true);
    const locked = this._selN;
    this._scan(camPos, camFwd, cull2, dayOff, K, locked, false);
  }

  /**
   * Score every candidate and keep the best, filling `_selIdx`/`_selScore` up to
   * `limit` entries. Slots below `locked` are reservations from an earlier pass
   * and are never evicted. `staticOnly` excludes vehicle headlights.
   */
  _scan(camPos, camFwd, cull2, dayOff, limit, locked, staticOnly) {
    let selN = this._selN;
    let worst = selN >= limit ? this._minScoreFrom(locked, selN) : 0;
    for (let i = 0, n = this._count; i < n; i++) {
      const fl = this._flags[i];
      if (!(fl & F_ENABLED)) continue;
      // A clock-driven source contributes nothing in daylight, so it must not
      // hold one of the fifteen pool slots either — otherwise the whole pool is
      // occupied by dark street lamps and a headlight that was switched on by
      // hand gets no real light.
      if (dayOff && (fl & F_AUTONIGHT)) continue;
      // Pass one reserves the floor for non-headlights; pass two must not pick
      // anything pass one already reserved.
      // STATIC, not merely non-headlight. The first attempt reserved anything that
      // was not a headlight, which let tail lamps and the other ~20 dynamic
      // sources eat the reservation: static allocation still only moved 2 -> 3 at
      // a floor of 7. Street-lamp promotion is the thing being protected, so the
      // predicate is the dynamic flag.
      if (staticOnly) { if (fl & F_DYNAMIC) continue; }
      else { let dup = false;
        for (let k = 0; k < locked; k++) if (this._selIdx[k] === i) { dup = true; break; }
        if (dup) continue; }
      const g = this._gain[i];
      if (g <= 0.01) continue;

      const dx = this._px[i] - camPos.x, dy = this._py[i] - camPos.y, dz = this._pz[i] - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cull2) continue;

      const r = this._range[i];
      let s = this._power[i] * g / (1 + d2 / (r * r));
      // Behind the camera still matters (it lights what you can see) but less.
      const facing = (dx * camFwd.x + dy * camFwd.y + dz * camFwd.z);
      if (facing < 0 && d2 > 100) s *= 0.22;
      if (this._type[i] === T_HEADLIGHT) s *= 2.4;      // headlights read as motion
      if (this._assignedSet(i)) s *= 1.35;              // hysteresis: avoid churn

      if (selN < limit) {
        this._selIdx[selN] = i; this._selScore[selN] = s; selN++;
        if (selN === limit) { worst = this._minScoreFrom(locked, selN); }
      } else if (s > worst) {
        // Only entries at or above `locked` may be evicted; below that they are
        // this pass's reservations from the previous one.
        let wi = locked;
        for (let k = locked + 1; k < limit; k++) if (this._selScore[k] < this._selScore[wi]) wi = k;
        this._selIdx[wi] = i; this._selScore[wi] = s;
        worst = this._minScoreFrom(locked, limit);
      }
    }
    this._selN = selN;
  }

  _minScoreFrom(from, n) {
    let m = Infinity;
    for (let k = from; k < n; k++) if (this._selScore[k] < m) m = this._selScore[k];
    return m;
  }

  _assignedSet(i) {
    const a = this._assigned;
    for (let k = 0, n = this.poolSize; k < n; k++) if (a[k] === i) return true;
    return false;
  }

  _applyPools(dt, night) {
    const nP = this.pointPool.length, nS = this.spotPool.length;
    let pi = 0, si = 0;
    const prev = this._assigned;
    const was = this._wasAssigned || (this._wasAssigned = new Int32Array(32).fill(-1));
    for (let k = 0; k < prev.length; k++) was[k] = prev[k];

    for (let k = 0; k < this._selN; k++) {
      const i = this._selIdx[k];
      const spot = (this._flags[i] & F_SPOT) !== 0;
      let light = null, slot = -1;
      if (spot && si < nS) { light = this.spotPool[si]; slot = nP + si; si++; }
      else if (pi < nP) { light = this.pointPool[pi]; slot = pi; pi++; }
      else if (si < nS) { light = this.spotPool[si]; slot = nP + si; si++; }
      if (!light) break;

      light.position.set(this._px[i], this._py[i], this._pz[i]);
      light.color.setRGB(this._cr[i], this._cg[i], this._cb[i]);
      light.distance = this._range[i];
      // Clock gate. The additive proxies have always done this — POOL_VERT and
      // GLOW_VERT multiply the instance gain by `uNight` unless the source opted
      // out (iColor.a < 0) — but the real pooled lights did not, so the fifteen
      // Point/SpotLights burned at a summed intensity of ~1010 at EVERY hour.
      // Measured identical at 03:00, 09:00, noon, 15:00, 19:30 and 22:00: sodium
      // street lamps 7-8 m over the carriageway lighting the road at high noon,
      // worth +6.1 mean output luminance inside the shadow mask at 09:30 — more
      // than the entire hemisphere fill, spent making daylight flatter and
      // tinting it orange. F_AUTONIGHT is cleared the moment an owner calls
      // setEnabled(), so a light that is driven by hand is unaffected.
      const clock = (this._flags[i] & F_AUTONIGHT) ? night : 1;
      const target = this._power[i] * this._gain[i] * clock;
      light.intensity += (target - light.intensity) * Math.min(1, dt * 9);
      if (light.isSpotLight) {
        light.target.position.set(
          this._px[i] + this._dx[i] * 10, this._py[i] + this._dy[i] * 10, this._pz[i] + this._dz[i] * 10);
        light.target.updateMatrixWorld();
        light.angle = Math.acos(THREE.MathUtils.clamp(this._cone[i], -1, 1));
      }
      prev[slot] = i;
    }
    for (let k = pi; k < nP; k++) { this.pointPool[k].intensity *= 0.72; prev[k] = -1; }
    for (let k = si; k < nS; k++) { this.spotPool[k].intensity *= 0.72; prev[nP + k] = -1; }

    // A source backed by a real light no longer needs its full fake pool, or the
    // road under the nearest lamps reads twice as bright as the rest of the street.
    // Only the delta is touched, so this is a handful of writes even when churning.
    for (let k = 0; k < prev.length; k++) {
      if (was[k] === prev[k]) continue;
      if (was[k] >= 0 && !this._assignedSet(was[k])) this._setProxyScale(was[k], 1);
      if (prev[k] >= 0) this._setProxyScale(prev[k], 0.4);
    }
  }

  _setProxyScale(i, v) {
    if (this._pscale[i] === v) return;
    this._pscale[i] = v;
    this._writeProxyColour(i);
  }

  _writeProxyColour(id) {
    const on = (this._flags[id] & F_ENABLED) ? 1 : 0;
    const scale = this._pscale[id];
    const clock = (this._flags[id] & F_AUTONIGHT) ? 1 : -1;
    const g = this._gain[id] * on;
    const t = this._type[id];
    const pi = this._poolIdx[id];
    if (pi >= 0) {
      const k = (t === T_HEADLIGHT ? 1.7 : t === T_SIGN ? 1.15 : POOL_STREET_GAIN) * g * scale;
      this._poolCol.setXYZW(pi, this._cr[id], this._cg[id], this._cb[id], k * clock);
      this._poolDirty = true;
    }
    const gi = this._glowIdx[id];
    if (gi >= 0) {
      const k = (t === T_TAIL ? 2.8 : t === T_HEADLIGHT ? 6.0 : t === T_SIGN ? 5.5 : 4.6) * g;
      this._glowCol.setXYZW(gi, this._cr[id], this._cg[id], this._cb[id], k * clock);
      this._glowDirty = true;
    }
  }

  _flush() {
    if (this._poolDirty) {
      this.poolMesh.geometry.instanceCount = this._poolCount;
      this._poolPos.needsUpdate = true;
      this._poolAxis.needsUpdate = true;
      this._poolCol.needsUpdate = true;
      this._poolDirty = false;
    }
    if (this._glowDirty) {
      this.glowMesh.geometry.instanceCount = this._glowCount;
      this._glowPos.needsUpdate = true;
      this._glowSize.needsUpdate = true;
      this._glowCol.needsUpdate = true;
      this._glowDirty = false;
    }
    if (this._boundsDirty) {
      this._boundsDirty = false;
      // An empty set keeps the infinite sphere, so a mesh with no instances yet is
      // never culled into a state it cannot recover from.
      boxToSphere(this._poolBox, this.poolMesh.geometry.boundingSphere);
      boxToSphere(this._glowBox, this.glowMesh.geometry.boundingSphere);
    }
  }

  /**
   * Height of the surface a light pool lands on.
   *
   * This used `city.groundHeight()`, and that is the single reason a city with
   * 2,876 registered ground pools had none you could see. `City.groundHeight` is
   * the TERRAIN raster, which `Terrain` deliberately stamps below the carriageway
   * so the ground can never poke through asphalt — `City.js` says so in as many
   * words and publishes `surfaceHeight()` as the thing to stand objects on.
   *
   * Measured at `night_neon`, raycasting the drawn mesh under the seven nearest
   * lamps: road surface y 4.31-4.44, `groundHeight` 3.38-3.86. Every pool quad
   * was therefore authored **0.45-0.98 m under the tarmac** and depth-rejected.
   * Confirmed by ablation: multiplying every pool's gain by 20 moved the frame
   * by 0.05/255 against an A/A floor of 0.83, while `depthTest = false` on the
   * same frame moved it by 138 at peak. The light was being drawn; the road was
   * in front of it.
   *
   * `nearY` disambiguates a flyover deck from the ground beneath it, which is
   * why every caller passes the light's own height.
   */
  _groundAt(x, z, nearY) {
    const c = this.ctx?.get('city');
    if (c?.surfaceHeight) return c.surfaceHeight(x, z, nearY);
    return c?.groundHeight ? c.groundHeight(x, z) : 0;
  }

  /**
   * `_groundAt` for a pool that moves, memoised on how far it has moved.
   *
   * The surface query is a road-mesh lookup, and asking it once per headlight
   * pool per frame is the single most expensive thing about a city full of
   * moving lights: measured at 1.7-4.6 ms per frame over 248 calls, well over
   * half of `_refreshDynamic`'s whole cost and most of the game's CPU budget.
   *
   * A carriageway does not rise by anything you can see in a metre — the pool is
   * a 3.4 m decal floated 3.5 cm off the surface — so re-ask only once the pool
   * has travelled `GROUND_RESAMPLE`. At urban speeds that is roughly seven
   * lookups a second per pool instead of sixty.
   */
  _poolGroundAt(pi, x, z, nearY) {
    if (this._poolGSet[pi]) {
      const dx = x - this._poolGX[pi], dz = z - this._poolGZ[pi];
      if (dx * dx + dz * dz < GROUND_RESAMPLE * GROUND_RESAMPLE) return this._poolGY[pi];
    }
    const y = this._groundAt(x, z, nearY);
    this._poolGX[pi] = x; this._poolGZ[pi] = z; this._poolGY[pi] = y;
    this._poolGSet[pi] = 1;
    return y;
  }

  stats() {
    return {
      registered: this._count - this._free.length,
      pools: this._poolCount, glows: this._glowCount,
      realLights: this.poolSize, lamps: this._lampCount,
    };
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    for (const m of [this._poleShort, this._poleTall, this._headMesh]) m?.dispose?.();
    this.group.parent?.remove(this.group);
    this._obj.fill(null);
  }
}
