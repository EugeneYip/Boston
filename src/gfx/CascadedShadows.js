import * as THREE from 'three';

/**
 * Cascaded shadow maps for the sun, plus the one global shader integration point
 * the whole lighting stack hangs off.
 *
 * WHY A GLOBAL SHADER PATCH
 * Three.js has no notion of cascades: it treats each DirectionalLight's shadow as
 * covering the entire scene, and returns "lit" for anything outside the map. Four
 * lights would therefore each wash out the other three's shadows. Real CSM needs
 * the fragment shader to pick exactly one cascade by view depth, so we patch two
 * ShaderChunks once, at module load, before any system builds a material. Doing it
 * at the chunk level (rather than per material) means every material in the game —
 * including ones streamed in later by systems that know nothing about lighting —
 * gets correct cascade selection with zero registration and zero per-frame cost.
 *
 * Uniform delivery uses Material.prototype.onBeforeCompile: three clones
 * ShaderLib uniforms per material, so we inject *the same* uniform objects by
 * reference into every material's uniform map. One write here updates every shader.
 */

const MAX_CASCADES = 4;

/** Shadow map size per cascade, as a function of the quality base size. */
const CASCADE_RES = [
  (m) => m,
  (m) => m,
  (m) => Math.max(1024, Math.round(m * 0.75) & ~63),
  (m) => Math.max(1024, m >> 1),
];

/* -------------------------------------------------------------------------- */
/* Shared uniforms                                                            */
/* -------------------------------------------------------------------------- */

/** Injected by reference into every material. Mutate `.value`, never reassign. */
export const bostonUniforms = {
  bostonCsmCount:    { value: 0 },                            // 0 disables CSM
  bostonCsmSplits:   { value: new Float32Array(MAX_CASCADES) }, // far view-depth of cascade i
  bostonCsmBands:    { value: new Float32Array(MAX_CASCADES) }, // blend band width at that split
  bostonCsmTexel:    { value: new Float32Array(MAX_CASCADES) }, // world metres per shadow texel
  bostonCsmDepth:    { value: new Float32Array(MAX_CASCADES) }, // world metres across near..far
  bostonCsmFadeA:    { value: 1e6 },
  bostonCsmFadeB:    { value: 1e6 },
  bostonPcfTaps:     { value: 12 },
  bostonPcss:        { value: 1 },
  bostonSunAngular:  { value: 0.0047 },   // tan of the sun's angular radius; Lighting drives it
  bostonProbeTex:    { value: null },
  bostonProbeOrigin: { value: new THREE.Vector3() },
  bostonProbeInvExt: { value: new THREE.Vector3(1, 1, 1) },
  bostonProbeMix:    { value: 0 },
  bostonProbeBounce: { value: 1 },
  // Occlusion is applied at two strengths on purpose. The hemisphere/ambient term
  // is the floor that keeps shadow detail alive, so the probe may only take a
  // fraction of it; the sky IBL is genuinely directional, so it may take most.
  // Letting either go to zero is what produces flat-black shadow, which reads as
  // broken rather than dark.
  // Driven from the clock by `Lighting._update` — see DAY_SKY_OCC / NIGHT_SKY_OCC.
  bostonSkyOcc:      { value: 0.55 },
  // The environment's SPECULAR half turned out to be the largest single thing
  // filling a daylight shadow once its diffuse half was cut: measured inside the
  // Hanover St 09:30 umbra, killing `environmentIntensity` outright took 12.5 of
  // 50.7 mean luminance while killing only its diffuse contribution took 3.9 —
  // so ~8.6 was broad rough-specular sky sitting in the shade. Occluding it
  // harder by real sky visibility is the physical fix.
  bostonIblOcc:      { value: 0.90 },
  /**
   * Extra scale on the *diffuse* sky IBL only.
   *
   * `scene.environmentIntensity` scales both `getIBLIrradiance` (diffuse) and
   * `getIBLRadiance` (specular), and the two want opposite things here: the
   * specular is what puts a sky in wet asphalt and glass and should stay strong,
   * while the diffuse is the same skylight the HemisphereLight already delivers,
   * so counting it at full strength lights every shadow twice. Measured at
   * Hanover St 09:30, mean output luminance inside the shadow mask: 60.4 with
   * everything on, 47.7 with the environment off and 56.3 with the hemisphere
   * off — i.e. the *diffuse* environment was three times the hemisphere and the
   * single largest thing filling shadows back in.
   */
  bostonIblDiffuse:  { value: 1 },
};

/* -------------------------------------------------------------------------- */
/* GLSL                                                                        */
/* -------------------------------------------------------------------------- */

const PARS_DECL = /* glsl */`
uniform float bostonCsmCount;
uniform float bostonCsmSplits[ 4 ];
uniform float bostonCsmBands[ 4 ];
uniform float bostonCsmTexel[ 4 ];
uniform float bostonCsmDepth[ 4 ];
uniform float bostonCsmFadeA;
uniform float bostonCsmFadeB;
uniform float bostonPcfTaps;
uniform float bostonPcss;
uniform float bostonSunAngular;
uniform sampler3D bostonProbeTex;
uniform vec3 bostonProbeOrigin;
uniform vec3 bostonProbeInvExt;
uniform float bostonProbeMix;
uniform float bostonProbeBounce;
uniform float bostonSkyOcc;
uniform float bostonIblOcc;
uniform float bostonIblDiffuse;

const vec2 bostonPoisson[ 16 ] = vec2[ 16 ](
	vec2( -0.6116, 0.5288 ), vec2( 0.1449, 0.8556 ), vec2( -0.1108, 0.1730 ), vec2( 0.6994, 0.4677 ),
	vec2( -0.9101, -0.0512 ), vec2( 0.3410, -0.2456 ), vec2( -0.3665, -0.6220 ), vec2( 0.8608, -0.2727 ),
	vec2( 0.0524, -0.8402 ), vec2( -0.7266, -0.5405 ), vec2( 0.4989, 0.8218 ), vec2( -0.2450, 0.9143 ),
	vec2( 0.9463, 0.1149 ), vec2( -0.5136, 0.1289 ), vec2( 0.2757, 0.2865 ), vec2( 0.6023, -0.6821 )
);

// Cascade energy weight. Adjacent cascades cross-fade over bostonCsmBands so the
// sum stays exactly 1.0 across a seam; anything that is not a cascade returns 1.0.
float bostonCascadeWeight( const in float idx, const in float depth ) {

	if ( idx >= bostonCsmCount ) return 1.0;

	int ci = int( idx );
	float w = 1.0;

	if ( ci > 0 ) {
		float e = bostonCsmSplits[ ci - 1 ];
		w *= smoothstep( e - bostonCsmBands[ ci - 1 ], e, depth );
	}
	if ( idx < bostonCsmCount - 1.0 ) {
		float e = bostonCsmSplits[ ci ];
		w *= 1.0 - smoothstep( e - bostonCsmBands[ ci ], e, depth );
	}
	return w;

}

/** Fade the shadow term (not the light) out at the far edge so nothing pops. */
float bostonShadowFade( const in float depth ) {
	return 1.0 - smoothstep( bostonCsmFadeA, bostonCsmFadeB, depth );
}

vec4 bostonProbeSample( const in vec3 wp ) {

	vec3 uvw = ( wp - bostonProbeOrigin ) * bostonProbeInvExt;
	vec3 c = clamp( uvw, vec3( 0.0 ), vec3( 1.0 ) );
	vec4 p = texture( bostonProbeTex, c );
	// Outside the volume there is nothing occluding anything: fall back to open sky.
	vec3 d = abs( uvw - 0.5 );
	float inside = 1.0 - smoothstep( 0.42, 0.5, max( d.x, max( d.y, d.z ) ) );
	return mix( vec4( 0.0, 0.0, 0.0, 1.0 ), p, inside );

}
`;

const CSM_SHADOW_FN = /* glsl */`
	// Interleaved-gradient noise: stable per pixel, so the PCF disc rotation reads as
	// film grain instead of crawling when the camera moves.
	float bostonIGN( const in vec2 p ) {
		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
	}

	float bostonCsmShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, vec4 shadowCoord, float cascade ) {

		shadowCoord.xyz /= shadowCoord.w;
		if ( shadowCoord.z > 1.0 || shadowCoord.z < 0.0 ) return 1.0;
		if ( any( bvec4( shadowCoord.x < 0.0, shadowCoord.x > 1.0, shadowCoord.y < 0.0, shadowCoord.y > 1.0 ) ) ) return 1.0;

		int ci = int( cascade );
		vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
		float z = shadowCoord.z + shadowBias;

		float a = bostonIGN( gl_FragCoord.xy ) * 6.28318531;
		vec2 sc = vec2( cos( a ), sin( a ) );
		mat2 rot = mat2( sc.x, sc.y, - sc.y, sc.x );

		float radius = 1.4;

		// Contact hardening: search for blockers, then size the filter from the sun's
		// real angular diameter. Cheap enough for the two near cascades only.
		if ( bostonPcss > 0.5 && cascade < 1.5 ) {

			float blockerSum = 0.0;
			float blockerN = 0.0;
			for ( int k = 0; k < 8; k ++ ) {
				vec2 o = rot * bostonPoisson[ k ] * texelSize * 7.0;
				float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) );
				if ( d < z ) { blockerSum += d; blockerN += 1.0; }
			}
			if ( blockerN > 0.0 ) {
				float sep = ( z - blockerSum / blockerN ) * bostonCsmDepth[ ci ];
				radius = clamp( sep * bostonSunAngular / max( bostonCsmTexel[ ci ], 1e-4 ), 1.0, 7.0 );
			}

		}

		float sum = 0.0;
		float taps = bostonPcfTaps;
		for ( int k = 0; k < 16; k ++ ) {
			if ( float( k ) >= taps ) break;
			vec2 o = rot * bostonPoisson[ k ] * texelSize * radius;
			sum += step( z, unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) ) );
		}

		// Soften the map border so the cascade box never shows as a hard edge.
		vec2 fu = smoothstep( vec2( 0.0 ), vec2( 0.04 ), shadowCoord.xy ) *
		          ( 1.0 - smoothstep( vec2( 0.96 ), vec2( 1.0 ), shadowCoord.xy ) );

		return mix( 1.0, sum / taps, fu.x * fu.y );

	}

`;

/* -------------------------------------------------------------------------- */
/* Chunk patching                                                              */
/* -------------------------------------------------------------------------- */

let _installed = false;
let _ok = false;

/**
 * Patch the shared ShaderChunks and hook uniform injection. Idempotent.
 * Returns false (and leaves three untouched) if the chunk text is not the shape
 * we expect, so a three upgrade degrades to a plain single-shadow sun instead of
 * a black screen.
 */
export function installLightingShaders() {
  if (_installed) return _ok;
  _installed = true;

  const C = THREE.ShaderChunk;
  const begin = C.lights_fragment_begin;
  const end = C.lights_fragment_end;
  const pars = C.shadowmap_pars_fragment;

  const GEOM = `vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );`;
  const GET_SHADOW = `float getShadow( sampler2D shadowMap,`;
  // Locate the directional block by its unique first and last lines: the shipped
  // three build strips blank lines, so matching the whole block verbatim is brittle.
  const DIR_HEAD = `#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )`;
  const DIR_TAIL = `RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );`;
  const h = begin.indexOf(DIR_HEAD);
  const t = h < 0 ? -1 : begin.indexOf(DIR_TAIL, h);
  const DIR_BLOCK = h >= 0 && t >= 0 ? begin.slice(h, t + DIR_TAIL.length) : null;

  const need = [
    begin.includes(GEOM), !!DIR_BLOCK,
    pars.includes(GET_SHADOW), end.includes('RE_IndirectDiffuse( irradiance'),
  ];
  if (need.some(v => !v)) {
    console.warn('[lighting] ShaderChunk layout unrecognised (three ' + THREE.REVISION +
      ') — cascaded shadows and light probes disabled.', need);
    return (_ok = false);
  }

  // --- pars: declarations + probe sampler, then the CSM shadow filter -------
  C.shadowmap_pars_fragment = PARS_DECL + pars.replace(GET_SHADOW, CSM_SHADOW_FN + GET_SHADOW);

  /*
   * --- skip the BRDF for lights that are provably black -------------------
   *
   * `LightManager` keeps a FIXED pool of real Point/SpotLights, because changing
   * the count recompiles every lit material in the scene. Fixed means the shader
   * unrolls all of them at every fragment for ever — and since the pool is now
   * clock-gated, all fifteen sit at intensity 0 for the twelve daylight hours.
   * Three has no early-out: `getPointLightInfo` computes `directLight.visible`
   * and then calls `RE_Direct` regardless, so every building fragment in a noon
   * frame was evaluating fifteen full GGX + Lambert BRDFs against `vec3(0.0)`.
   *
   * `visible` is `color * distanceAttenuation != 0`, so it is false both for a
   * light that is switched off (the whole pool, all day) and for any fragment
   * outside a lit lamp's `distance` (most of the frame, all night). In daylight
   * the branch is uniform across the entire draw, so there is no divergence at
   * all; at night it is coherent over large regions.
   *
   * SAFETY. Non-uniform control flow around a derivative or an implicit-LOD
   * `texture()` is undefined in GLSL ES 3.0, and this driver returns garbage for
   * it with no GL fault and no console error — see the note on `OPAQUE_NORMAL_F`
   * in the buildings agent's work. That is why the guard wraps ONLY `RE_Direct`,
   * which is pure ALU for physical, phong and lambert materials, and why TOON is
   * excluded: `RE_Direct_Toon` samples `gradientMap` through
   * `getGradientIrradiance`. The spot-light-map `texture2D` earlier in the loop
   * stays outside the branch, in uniform flow, untouched.
   */
  const RE_DIRECT = DIR_TAIL;
  const guardBlock = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return src;
    const j = src.indexOf(RE_DIRECT, i);
    if (j < 0) return src;
    const guarded = /* glsl */`
		#if defined( TOON )
			${RE_DIRECT}
		#else
			if ( directLight.visible ) { ${RE_DIRECT} }
		#endif
`;
    return src.slice(0, j) + guarded + src.slice(j + RE_DIRECT.length);
  };

  // --- begin: derive world position/normal, cascade-select, probe irradiance -
  let b = begin.replace(GEOM, GEOM + /* glsl */`

// --- BOSTON lighting ---
float bostonViewDepth = - geometryPosition.z;
vec3 bostonWorldPos = cameraPosition + geometryPosition * mat3( viewMatrix );
vec3 bostonWorldNrm = geometryNormal * mat3( viewMatrix );
float bostonSkyVis = 1.0;
vec3 bostonBounce = vec3( 0.0 );
float bostonDirW = 1.0;
float bostonDirSh = 1.0;

// Sample the irradiance volume here, where the world position is in hand, but
// APPLY it in lights_fragment_end -- see the note there.
if ( bostonProbeMix > 0.0 ) {
	vec4 bProbe = bostonProbeSample( bostonWorldPos );
	bostonSkyVis = mix( 1.0, bProbe.a, bostonProbeMix );
	// Ground/wall bounce: strongest on downward-facing and vertical surfaces.
	bostonBounce = bProbe.rgb * bostonProbeBounce *
		( 0.45 + 0.55 * ( 1.0 - max( bostonWorldNrm.y, 0.0 ) ) ) * bostonProbeMix;
}`);

  /*
   * `UNROLLED_LOOP_INDEX` is the light's index in `directionalLights[]`, NOT a
   * cascade number, so this only works while cascade i lands at index i.
   *
   * That holds because `WebGLLights.setup` sorts the light array with
   * `shadowCastingAndTexturingLightsFirst` before assigning indices, and
   * Array.prototype.sort is stable — so every shadow-casting light precedes every
   * non-casting one, and our cascades keep their relative order. Verified live by
   * reading the uploaded `directionalLights[i].color` cache off a linked program:
   * indices 0/1/2 carry the sun colour with the 2048/2048/1536 maps in order, and
   * Weather's always-resident lightning `DirectionalLight` (intensity 0, so
   * colour (0,0,0)) lands at index 3 even though it sits at `scene.children[5]`,
   * ahead of the `csm` group at [7]. An index past `bostonCsmCount` gets weight
   * 1.0 and no cascade shadow, which is the correct treatment for a genuine
   * non-cascade directional light.
   *
   * Two things would break it, both worth knowing before adding a light:
   *  - another *shadow-casting* DirectionalLight registered before the cascades;
   *  - `setCastShadows(false)`, which makes the sort a no-op among equals and
   *    lets a non-casting light sort ahead of the cascades. Harmless today only
   *    because that path is gated on the key light being essentially black.
   */
  // Both point and spot blocks sit ahead of the directional one in the chunk, so
  // guarding them leaves DIR_BLOCK matchable verbatim.
  b = guardBlock(b, `#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )`);
  b = guardBlock(b, `#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )`);

  b = b.replace(DIR_BLOCK, /* glsl */`		bostonDirW = bostonCascadeWeight( float( UNROLLED_LOOP_INDEX ), bostonViewDepth );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		if ( bostonDirW > 0.0 ) {
			bostonDirSh = 1.0;
			if ( directLight.visible && receiveShadow ) {
				if ( float( UNROLLED_LOOP_INDEX ) < bostonCsmCount ) {
					bostonDirSh = bostonCsmShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, vDirectionalShadowCoord[ i ], float( UNROLLED_LOOP_INDEX ) );
					bostonDirSh = mix( 1.0, bostonDirSh, bostonShadowFade( bostonViewDepth ) * directionalLightShadow.shadowIntensity );
				} else {
					bostonDirSh = getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] );
				}
			}
			directLight.color *= bostonDirW * bostonDirSh;
		}
		#else
		directLight.color *= bostonDirW;
		#endif

		if ( bostonDirW > 0.0 ) {
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}`);

  C.lights_fragment_begin = b;

  /*
   * --- end: occlude the indirect terms, then add the bounce -----------------
   *
   * This MUST happen here and not next to `getAmbientLightIrradiance`, which is
   * where it used to live. Three builds `irradiance` in three steps inside
   * lights_fragment_begin:
   *
   *     vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );  <-- old anchor
   *     irradiance += getLightProbeIrradiance( ... );
   *     for ( hemisphere lights ) irradiance += getHemisphereLightIrradiance( ... );
   *
   * The old injection sat on the first line, so `bostonSkyOcc` only ever scaled
   * the AmbientLight term -- and this game has no AmbientLight, so the whole
   * uniform was a measured no-op while reading 0.45 in the dev overlay. The
   * HemisphereLight, which is the entire controlled ambient, was never occluded
   * at all: a courtyard, a tunnel and an open plaza all received identical
   * skylight, which is exactly the flat-ambient wash the volume exists to stop.
   *
   * By lights_fragment_end, `irradiance` carries ambient + light probe +
   * hemisphere + lightmap, and `iblIrradiance` carries the environment. Occlude
   * first, then add the bounce -- the bounce is the *fill* for occluded points
   * and must not be occluded by its own visibility term.
   */
  C.lights_fragment_end = /* glsl */`
#if defined( RE_IndirectDiffuse )
	irradiance *= mix( 1.0, bostonSkyVis, bostonSkyOcc );
	irradiance += bostonBounce;
	iblIrradiance *= bostonIblDiffuse * mix( 1.0, bostonSkyVis, bostonIblOcc );
#endif
#if defined( RE_IndirectSpecular )
	radiance *= mix( 1.0, bostonSkyVis, bostonIblOcc * 0.9 );
	clearcoatRadiance *= mix( 1.0, bostonSkyVis, bostonIblOcc * 0.9 );
#endif
` + end;

  // --- uniform injection ----------------------------------------------------
  const HOOK = '__bostonHook';
  const USER = '__bostonUser';
  const proto = THREE.Material.prototype;

  const inject = function (parameters) {
    const u = parameters && parameters.uniforms;
    if (!u) return;
    for (const k in bostonUniforms) if (u[k] === undefined) u[k] = bostonUniforms[k];
  };

  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    enumerable: false,
    get() { return this[HOOK] || inject; },
    set(fn) {
      Object.defineProperty(this, USER, { value: fn, writable: true, configurable: true });
      Object.defineProperty(this, HOOK, {
        writable: true, configurable: true,
        value: function (p, r) { inject(p, r); fn.call(this, p, r); },
      });
    },
  });
  // Default cache key is onBeforeCompile.toString(); our wrapper is identical for
  // every material, so key off the material's own hook instead or two different
  // custom shaders would share one program.
  proto.customProgramCacheKey = function () {
    const f = this[USER];
    return 'bstn|' + (f ? f.toString() : '');
  };

  return (_ok = true);
}

/* -------------------------------------------------------------------------- */
/* Cascaded shadow maps                                                        */
/* -------------------------------------------------------------------------- */

const _fwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _center = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);

export default class CascadedShadows {
  /**
   * @param {object} o
   * @param {number} o.cascades      2..4
   * @param {number} o.mapSize       base shadow map resolution (cascade 0)
   * @param {number} o.maxDistance   metres; beyond this the sun casts no shadow
   * @param {number} o.lambda        0 = uniform splits, 1 = logarithmic
   */
  constructor({ cascades = 4, mapSize = 2048, maxDistance = 600, lambda = 0.9 } = {}) {
    this.enabled = installLightingShaders();
    this.count = THREE.MathUtils.clamp(cascades, 1, MAX_CASCADES);
    this.mapSize = mapSize;
    this.maxDistance = maxDistance;
    this.lambda = lambda;
    this.splitNear = 3.0;         // splits are computed from here, not camera.near
    this.blendFraction = 0.14;    // of each cascade's own depth range
    /**
     * Metres of caster kept up-sun of each cascade.
     *
     * This is not a slack figure, it is a geometric one: a caster of height h
     * casts into a receiver from at most `h / sin(altitude)` away measured along
     * the light axis, so `back = r + casterHeadroom / |toSun.y|` is exactly right
     * when `casterHeadroom` is the tallest thing in the city. Boston's is 200
     * Clarendon at 241 m, so 260 has ~8% of headroom and there is nothing to
     * reclaim here — checked, because it looks like a tunable and is not.
     */
    this.casterHeadroom = 260;

    this.group = new THREE.Group();
    this.group.name = 'csm';
    this.group.matrixAutoUpdate = false;

    this.lights = [];
    this._splits = new Float32Array(MAX_CASCADES);
    this._radius = new Float32Array(MAX_CASCADES);
    this._interval = new Uint8Array([1, 2, 3, 4]);   // render cascade i every n frames
    this._dir = new THREE.Vector3(0, 1, 0);
    this._lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._frame = 0;
    this._dirty = true;

    this._build();
  }

  _build() {
    for (const l of this.lights) {
      l.shadow.dispose();
      this.group.remove(l, l.target);
    }
    this.lights.length = 0;

    for (let i = 0; i < this.count; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 1);
      l.castShadow = true;
      l.matrixAutoUpdate = true;
      // Near cascades carry the detail; far ones are mostly big soft blobs, and
      // they are the expensive ones (a 600 m cascade re-renders half the city), so
      // they get a quarter of the texels. Power of two: some drivers pad NPOT.
      const res = CASCADE_RES[Math.min(i, 3)](this.mapSize);
      l.shadow.mapSize.set(res, res);
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far = 2000;
      l.shadow.intensity = 1;
      l.shadow.radius = 1;
      l.shadow.autoUpdate = false;    // we drive needsUpdate ourselves
      l.shadow.needsUpdate = true;
      l.target.matrixAutoUpdate = true;
      this.group.add(l, l.target);
      this.lights.push(l);
    }
    bostonUniforms.bostonCsmCount.value = this.enabled ? this.count : 0;
    this._dirty = true;
  }

  /** @returns {THREE.DirectionalLight} the cascade that carries the sun's colour. */
  get primary() { return this.lights[0]; }

  addTo(scene) { scene.add(this.group); return this; }

  /** Rebuild the cascade set — cheap enough to call from a quality change. */
  setQuality({ cascades, mapSize, maxDistance, pcfTaps, pcss }) {
    let rebuild = false;
    if (cascades !== undefined && cascades !== this.count) {
      this.count = THREE.MathUtils.clamp(cascades, 1, MAX_CASCADES); rebuild = true;
    }
    if (mapSize !== undefined && mapSize !== this.mapSize) { this.mapSize = mapSize; rebuild = true; }
    if (maxDistance !== undefined) this.maxDistance = maxDistance;
    if (pcfTaps !== undefined) bostonUniforms.bostonPcfTaps.value = pcfTaps;
    if (pcss !== undefined) bostonUniforms.bostonPcss.value = pcss ? 1 : 0;
    if (rebuild) this._build();
  }

  /** Sun colour and illuminance, shared by every cascade. */
  setSun(color, intensity) {
    for (const l of this.lights) { l.color.copy(color); l.intensity = intensity; }
  }

  setCastShadows(on) {
    for (const l of this.lights) l.castShadow = on;
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} toSun normalised, pointing from the world toward the sun
   */
  update(camera, toSun) {
    if (!this.enabled || !camera.isPerspectiveCamera) return;
    this._frame++;

    // A direction change invalidates every cascade's snap, so force a full refresh.
    if (toSun.dot(this._dir) < 0.99995) { this._dir.copy(toSun); this._dirty = true; }

    camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    // A teleport (capture harness, fast travel) must refresh every cascade at once.
    if (_camPos.distanceToSquared(this._lastCam) > 900) this._dirty = true;
    this._lastCam.copy(_camPos);

    // Light-space basis. Matches Matrix4.lookAt so our snapping lands on the same
    // grid three will use when it builds the shadow camera.
    const up = Math.abs(toSun.y) > 0.98 ? _upAlt : _up;
    _az.copy(toSun);
    _ax.crossVectors(up, _az).normalize();
    _ay.crossVectors(_az, _ax);

    const near = Math.max(camera.near, 0.1);
    const far = Math.min(this.maxDistance, camera.far);
    // A zero-sized canvas (hidden tab, pre-resize) gives aspect 0/0; one NaN here
    // silently poisons every shadow matrix, so clamp rather than trust it.
    const aspect = isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const k = tanV * Math.sqrt(1 + aspect * aspect);
    const kk = k * k;

    // Practical split scheme: logarithmic where it matters, uniform where it does not.
    const sn = Math.max(this.splitNear, near);
    for (let i = 0; i < this.count; i++) {
      const p = (i + 1) / this.count;
      const lg = sn * Math.pow(far / sn, p);
      const un = sn + (far - sn) * p;
      this._splits[i] = i === this.count - 1 ? far : this.lambda * lg + (1 - this.lambda) * un;
    }

    camera.getWorldDirection(_fwd);

    for (let i = 0; i < this.count; i++) {
      const n = i === 0 ? near : this._splits[i - 1];
      const f = this._splits[i];

      // Bounding sphere of the frustum slice: rotation-invariant, so the cascade
      // extent never changes as the player looks around. That is half of shimmer.
      let cz, r;
      if (kk >= (f - n) / (f + n)) { cz = f; r = f * k; }
      else {
        cz = 0.5 * (f + n) * (1 + kk);
        r = 0.5 * Math.sqrt((f - n) * (f - n) + 2 * (f * f + n * n) * kk + (f + n) * (f + n) * kk * kk);
      }
      r = Math.max(r, 1);
      this._radius[i] = r;

      const l = this.lights[i];
      const res = l.shadow.mapSize.x;
      const texel = (2 * r) / res;

      const due = this._dirty || (this._frame % this._interval[i]) === 0;
      if (due) {
        _center.copy(_camPos).addScaledVector(_fwd, cz);

        // Texel snapping in light space: the other half of shimmer. Without this the
        // shadow map slides sub-texel every frame and every edge crawls.
        const px = Math.round(_center.dot(_ax) / texel) * texel;
        const py = Math.round(_center.dot(_ay) / texel) * texel;
        const pz = _center.dot(_az);
        _center.set(0, 0, 0)
          .addScaledVector(_ax, px).addScaledVector(_ay, py).addScaledVector(_az, pz);

        // A low sun needs more headroom (long shadows come from far away); a high
        // one needs almost none. Scaling this is worth real milliseconds, because
        // everything inside the range is submitted to the depth pass.
        const back = r + this.casterHeadroom / Math.max(0.18, Math.abs(toSun.y));
        l.position.copy(_center).addScaledVector(_az, back);
        l.target.position.copy(_center);
        l.target.updateMatrixWorld();

        const cam = l.shadow.camera;
        cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
        cam.near = 0.5;
        cam.far = back + r + 10;
        cam.updateProjectionMatrix();
        l.shadow.needsUpdate = true;
      }

      const depthRange = l.shadow.camera.far - l.shadow.camera.near;
      // Constant bias in world metres, expressed in the cascade's normalised depth.
      const worldBias = 0.012 + texel * 0.9;
      l.shadow.bias = -worldBias / depthRange;
      // Normal offset is the workhorse against acne; keeping it ~1.5 texels means it
      // stays sub-centimetre near the camera, so nothing peter-pans.
      l.shadow.normalBias = texel * 1.5;
      l.shadow.radius = 1;

      bostonUniforms.bostonCsmSplits.value[i] = this._splits[i];
      bostonUniforms.bostonCsmBands.value[i] = (this._splits[i] - n) * this.blendFraction;
      bostonUniforms.bostonCsmTexel.value[i] = texel;
      bostonUniforms.bostonCsmDepth.value[i] = depthRange;
    }

    bostonUniforms.bostonCsmCount.value = this.count;
    bostonUniforms.bostonCsmFadeA.value = far * 0.86;
    bostonUniforms.bostonCsmFadeB.value = far;
    this._dirty = false;
  }

  /**
   * Distance from the camera beyond which an object cannot cast into any
   * cascade, in metres. Published so a system that owns a large always-resident
   * caster set can gate `castShadow` on it per frame instead of guessing.
   *
   * Three culls shadow casters with `_frustum.intersectsObject`, which is a
   * bounding-SPHERE test against the cascade's ortho box. Cascade 0's box is only
   * ~2r wide (56 m at `high`) but `back + r` deep, so any mesh with a large
   * bounding sphere — a merged sector of a city, say — intersects that thin slab
   * almost wherever the camera stands, and is re-submitted in full to every
   * cascade. Distance gating is the cheap way out; a tighter caster granularity
   * is the thorough one.
   *
   * @returns {number}
   */
  shadowReach() {
    return this.maxDistance + this.casterHeadroom / Math.max(0.18, Math.abs(this._dir.y));
  }

  /** Cascade extents in metres — dev overlay / debugging. */
  debugInfo(out = {}) {
    out.count = this.count;
    out.splits = Array.from(this._splits.subarray(0, this.count), v => +v.toFixed(1));
    out.radius = Array.from(this._radius.subarray(0, this.count), v => +v.toFixed(1));
    out.texel = Array.from(bostonUniforms.bostonCsmTexel.value.subarray(0, this.count),
      v => +v.toFixed(3));
    out.maps = this.lights.map(l => l.shadow.mapSize.x);
    return out;
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.dispose();
      l.parent?.remove(l);
      l.target.parent?.remove(l.target);
    }
    this.lights.length = 0;
    this.group.parent?.remove(this.group);
    bostonUniforms.bostonCsmCount.value = 0;
  }
}
