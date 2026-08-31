import * as THREE from 'three';
import CascadedShadows, { installLightingShaders, bostonUniforms } from './CascadedShadows.js';
import LightManager from './LightManager.js';
import LightProbes from './LightProbes.js';

// Patch the shared ShaderChunks before any system builds a material.
installLightingShaders();

/**
 * The lighting system: sun, sky, cascaded shadows, the city's artificial lights and
 * the irradiance volume that keeps the dark parts from being flat black.
 *
 * Everything is driven from `ctx.time.timeOfDay` and the sun direction the
 * Atmosphere agent publishes on `ctx.get('sky').sunDir`.
 *
 * Radiometry: intensities are in three's physical mode, where a DirectionalLight's
 * intensity is beam illuminance (the N.L term is applied by the shader). Noon sun
 * is pinned to SUN_PEAK and everything else is derived from a Kasten-Young air mass
 * so the sun/sky ratio is right at every hour: ~6:1 at noon, inverting at dusk.
 */

/**
 * Sun and sky irradiance at their respective peaks.
 *
 * These two numbers are a RATIO before they are levels: together with the sky
 * IBL they decide how deep a cast shadow is, which is the single strongest cue
 * that a frame is lit at all. Measured at Hanover St 09:30 (1920-wide readback,
 * shadow map toggled with a forced recompile, ratio taken over every pixel the
 * toggle changed) the shadowed/lit median was 0.62 — 0.69 stops. Real asphalt in
 * sun against asphalt in shade is 2-3 stops. Everything read as an ambient wash
 * because the ambient WAS most of the light.
 *
 * The fix is a ratio change, not a level change: the sun goes to the top of the
 * band ARCHITECTURE allows and the ambient comes down to meet it, so the mean
 * frame level barely moves (which matters while `AutoExposurePass` is still
 * pinned and cannot compensate) but the contrast between lit and shadowed
 * roughly triples. See also `bostonIblDiffuse`, which does the same job for the
 * environment map's diffuse half — the largest of the three ambient terms.
 */
const SUN_PEAK = 6.0;      // ARCHITECTURE: sun sits in the 3-6 band
const SKY_PEAK = 0.72;

/**
 * Night levels, in the same irradiance units as SUN_PEAK / SKY_PEAK.
 *
 * These are compressed, not physical: a moonless city night is about five orders of
 * magnitude below noon and full moonlight is ~1/400,000 of sunlight, which no display
 * and no tone curve can carry. What matters is that night keeps a *key* (the moon,
 * so surfaces still have shape and cast shadows), a *fill* (skyglow off low cloud,
 * which is the dominant real term and is warm rather than blue) and enough separation
 * from the artificial lights that a lamp still reads as hot.
 *
 * NIGHT_SKY is the effective irradiance, not a number that then gets multiplied by a
 * near-black sky colour — see the note in `_update`.
 */
const MOON_PEAK = 0.42;
/**
 * Night skyglow floor.
 *
 * This was 0.9 — far above a physical skyglow — because `AutoExposurePass` used to
 * pin the adapted log-luminance at -3.6 at every hour, so raising scene light was
 * the only way to make night readable. **The meter now adapts** (measured on the
 * Hanover St framing: adapted -3.64 at noon against -4.58 at 21:30), so the
 * compensation is no longer needed and the floor comes back down.
 *
 * It does not come all the way down to the 0.15-0.25 the old note guessed at,
 * because the meter turns out to compensate very little here — a night street is
 * metered mostly off its lamps and emissives, not its ambient. Swept at 21:30,
 * stepping 45 frames between samples so the meter settles:
 *
 *   floor  adapted   mean   p50   % below lum 2
 *   0.90    -4.58    44.8   35.8      2.2%
 *   0.60    -4.58    39.5   31.3      3.7%
 *   0.45    -4.64    37.8   29.8      4.7%
 *   0.30    -4.77    36.7   28.9      5.7%
 *   0.20    -4.88    36.0   28.1      6.5%
 *
 * i.e. a 2.2-stop ambient cut buys 0.3 stops of metering back and costs a
 * quadrupling of near-black pixels, and "pure black with no detail" is an
 * automatic fail on the critic's rubric. 0.50 takes night from 44% of noon's
 * median to 37% while keeping the bottom of the histogram alive. Revisit
 * alongside `toeParams` / the black point rather than on its own.
 */
const NIGHT_SKY = 0.5;
/** Extra environment (IBL) at night: wet asphalt and glass reflecting the skyglow. */
const NIGHT_ENV = 0.30;

/**
 * Twilight key.
 *
 * Between sunset and moonrise there was NO shadow-casting directional light at
 * all: measured at tod 19.5 the sun's term is already 0 (it dies at an altitude
 * of -0.9 deg) and the moon ramp has not started (it opens at -2.6 deg), so the
 * whole dusk band was lit by ambient alone and nothing in the city had a lit
 * side and a shadow side. The same hole exists in the small hours whenever the
 * moon is below the horizon — measured at tod 03:00, sun 0, castShadow false.
 *
 * The post-sunset sky is not isotropic: the western horizon is orders of
 * magnitude brighter than the eastern one for the best part of an hour, so a
 * dim warm key on the sunset azimuth is the right approximation rather than a
 * cheat. It is deliberately weak enough to shape a facade without reading as a
 * second sun.
 */
const TWILIGHT_PEAK = 0.46;
/**
 * Floor on the key's altitude, as sin(alt).
 *
 * Shadow cost scales as 1/|dir.y| — `CascadedShadows.casterHeadroom` divides by
 * it — so a key left lying on the horizon submits the better part of a kilometre
 * of extra casters to every cascade. 0.17 is about 10 deg: still a long raking
 * shadow, still bounded.
 */
const KEY_MIN_Y = 0.17;
/**
 * Deep-night key floor.
 *
 * Keeps a trace of directional shaping (and, incidentally, a stable
 * `NUM_DIR_LIGHT_SHADOWS`, so the whole scene no longer recompiles its shaders
 * twice a day as `castShadow` toggles) on a moonless night. At this level
 * against the night ambient it is shape, not shadow.
 */
const NIGHT_KEY = 0.14;
/**
 * Daylight scale on the DIFFUSE half of the sky IBL. See `bostonIblDiffuse` in
 * CascadedShadows.js for why the two halves are separated at all.
 */
const DAY_IBL_DIFFUSE = 0.34;
/**
 * How much of the hemisphere fill the irradiance volume is allowed to take away.
 *
 * Until now this was a no-op — it was applied to the AmbientLight term, and this
 * game has no AmbientLight (see the note in `CascadedShadows.installLightingShaders`)
 * — so every value it has ever held is untested. It is therefore introduced gently
 * at night: the night ambient is authored against a pinned exposure and is not
 * ours to re-tune until `AutoExposurePass` is fixed, so the night figure is set to
 * cost an open street only about 10% of its fill while still making a courtyard
 * read as enclosed. Daylight, where the whole flat-wash problem lives, gets the
 * full strength.
 */
const DAY_SKY_OCC = 0.62;
const NIGHT_SKY_OCC = 0.25;

const WEATHER = {
  clear:    { sun: 1.00, sky: 1.00, soft: 1.0, tint: 1.00 },
  overcast: { sun: 0.13, sky: 1.55, soft: 4.5, tint: 0.55 },
  rain:     { sun: 0.10, sky: 1.40, soft: 5.0, tint: 0.48 },
  storm:    { sun: 0.05, sky: 1.05, soft: 6.0, tint: 0.40 },
  fog:      { sun: 0.28, sky: 1.60, soft: 3.5, tint: 0.62 },
  snow:     { sun: 0.35, sky: 1.70, soft: 3.0, tint: 0.75 },
};

const _toSun = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();
const _key = new THREE.Vector3(0, 1, 0);
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();

/* Sky and bounce reference colours, authored in sRGB. */
const SKY_DAY = new THREE.Color('#8ab4ee');
const SKY_DUSK = new THREE.Color('#c08a6e');
// Night is authored at a moderate saturation on purpose. These colours are now
// normalised to unit luminance before they reach the hemisphere light, and a deep
// navy normalises to a 6:1 blue-to-red ratio — which painted the whole night city
// cyan once the floor was raised. A city's night sky is skyglow scattered off low
// cloud, which is a desaturated slate, not the navy of a rural sky.
const SKY_NIGHT = new THREE.Color('#2d3341');
const GND_DAY = new THREE.Color('#5b5348');
const GND_DUSK = new THREE.Color('#4a382c');
const GND_NIGHT = new THREE.Color('#34271c');   // sodium skyglow off low cloud
const MOON_COL = new THREE.Color('#9fb6de');
/**
 * Post-sunset western sky. Warm, but not the 1850 K of the sun's last minutes:
 * once the disc is down what is left is scattered light, which is oranger than
 * daylight and paler than the disc was.
 */
const TWILIGHT_COL = kelvinToColor(2450, new THREE.Color());

const NEON = ['#ff2d55', '#00e5ff', '#ff9500', '#39ff88', '#ff36f0', '#ffd21e', '#4d6bff'];

/**
 * Emissive radiance of a lit window pane.
 *
 * A window seen from the street is bright but it is not a light source you look
 * into: it has a frame, a ceiling glow and a dark half. Authored at 4.2 it cleared
 * the tone curve's shoulder by two stops, so every pane clipped to flat white, the
 * mullions between them bloomed shut and a whole facade read as one glowing slab —
 * measured: 6.7% of a night street frame pinned at 255. At 1.5 the panes stay hot
 * enough to bloom and to read as the brightest thing in the shot while keeping their
 * grid, their colour and their variation.
 */
const WIN_BRIGHT = 1.5;

/* -------------------------------------------------------------------------- */
/* Window emissive injection                                                   */
/* -------------------------------------------------------------------------- */

const WIN_PARS = /* glsl */`
uniform float uWinNight;
uniform float uWinLit;
uniform float uWinTime;
uniform vec2 uWinCell;
uniform float uWinBright;
float bostonHash21( vec2 p ) {
	p = fract( p * vec2( 233.34, 851.73 ) );
	p += dot( p, p + 23.45 );
	return fract( p.x * p.y );
}
`;

/**
 * Runs on every facade fragment, so it is written as a funnel rather than as a
 * straight-line block: each stage is gated on the cheapest test that can still
 * prove the fragment contributes nothing.
 *
 *   uWinNight  — uniform, so the daytime branch is coherent across a whole draw
 *   bwNrm.y    — roofs and soffits have no windows
 *   shape      — mullions are ~45% of a facade's area and are never lit
 *   lit        — roughly half the remaining windows are dark at any hour
 *
 * Only fragments that survive all four pay for the second and third hashes and the
 * television flicker. The output is identical to evaluating everything up front.
 */
const WIN_BODY = /* glsl */`
	if ( uWinNight > 0.002 ) {
		vec3 bwNrm = normal * mat3( viewMatrix );
		if ( abs( bwNrm.y ) < 0.45 ) {
			vec3 bwPos = cameraPosition + ( - vViewPosition ) * mat3( viewMatrix );
			float u = abs( bwNrm.x ) > abs( bwNrm.z ) ? bwPos.z : bwPos.x;
			vec2 cell = vec2( u / uWinCell.x, ( bwPos.y - 1.3 ) / uWinCell.y );
			vec2 fr = fract( cell );
			vec2 pane = smoothstep( vec2( 0.13 ), vec2( 0.25 ), fr ) *
				( 1.0 - smoothstep( vec2( 0.75 ), vec2( 0.87 ), fr ) );
			float shape = pane.x * pane.y;
			if ( shape > 0.0 ) {
				vec2 id = floor( cell );
				float h1 = bostonHash21( id );
				// Occupancy is per window and biased per floor, so a tower lights up in
				// clumps the way a real one does rather than as uniform static.
				float lit = step( h1, uWinLit * ( 0.45 + 1.05 * bostonHash21( vec2( id.y, 3.0 ) ) ) );
				if ( lit > 0.0 ) {
					float h2 = bostonHash21( id + 37.7 );
					float h3 = bostonHash21( id * 1.73 + 11.3 );
					vec3 c = mix( vec3( 1.0, 0.60, 0.28 ), vec3( 0.70, 0.81, 1.0 ), step( 0.60, h2 ) );
					float flick = 1.0;
					if ( h2 > 0.90 ) {                       // televisions
						c = vec3( 0.26, 0.46, 1.0 );
						flick = 0.5 + 0.5 * abs( sin( uWinTime * 6.1 + h3 * 41.0 ) *
							sin( uWinTime * 1.9 + h1 * 23.0 ) );
					}
					totalEmissiveRadiance += c * ( shape * flick * uWinBright *
						uWinNight * ( 0.5 + h3 * 0.9 ) );
				}
			}
		}
	}
`;

/* -------------------------------------------------------------------------- */

export default class Lighting {
  static id = 'lighting';
  static label = 'Lighting';
  static deps = ['sky', 'render'];

  constructor() {
    /** @type {THREE.Vector3} normalised, points FROM the sun toward the origin. */
    this.sunDir = new THREE.Vector3(0, -1, 0);
    /** @type {THREE.Vector3} normalised, points from the origin TOWARD the sun. */
    this.toSun = new THREE.Vector3(0, 1, 0);
    this.night = 0;
    this.sunIntensity = 0;
    this.skyIntensity = 0;
    this.sunColor = new THREE.Color(1, 1, 1);
    this.skyColor = new THREE.Color(1, 1, 1);
    this._winMats = [];
    this._winPatched = new WeakSet();
    this._swapped = [];
    this._probeState = {
      dirY: 0, color: new THREE.Color(), intensity: 0,
      skyColor: new THREE.Color(), skyIntensity: 0, night: 0,
    };
  }

  async init(ctx) {
    this.ctx = ctx;
    const s = ctx.settings;
    // Exposed so tooling reads the *live* uniform objects. Vite serves HMR-updated
    // modules under a versioned URL, so a console `import()` can hand back a second
    // copy of the module with pristine defaults and quietly lie about the state.
    this.uniforms = bostonUniforms;

    this.shadows = new CascadedShadows({
      cascades: this._cascadeCount(s),
      mapSize: this._shadowMapSize(s),
      maxDistance: this._shadowDistance(s),
    });
    this.shadows.addTo(ctx.scene);
    /** @type {THREE.DirectionalLight} contract: `lighting.sun` */
    this.sun = this.shadows.primary;
    bostonUniforms.bostonPcfTaps.value = s.preset === 'low' ? 6 : s.preset === 'medium' ? 10 : 14;
    bostonUniforms.bostonPcss.value = s.preset === 'low' ? 0 : 1;

    // Hemisphere fill is the *controlled* part of the ambient; the probe volume adds
    // the local variation on top and the PMREM sky supplies the specular.
    this.hemi = new THREE.HemisphereLight(SKY_DAY, GND_DAY, 0.6);
    ctx.scene.add(this.hemi);

    this.manager = new LightManager();
    await this.manager.init(ctx);

    this.probes = new LightProbes();
    this.probes.init(ctx);

    this.weather = WEATHER[s.weather] || WEATHER.clear;
    ctx.bus.on('weather:set', (w) => { this.weather = WEATHER[w] || WEATHER.clear; });
    ctx.bus.on('quality:changed', () => this._applyQuality(ctx));
    // Populate from update(), not from engine:ready: if any other system throws
    // during init the event never fires, and the city would silently go unlit.
    ctx.bus.on('engine:ready', () => this._populate(ctx));
    for (const e of ['props:rebuilt', 'city:rebuilt', 'city:ready', 'world:rebuilt']) {
      ctx.bus.on(e, () => this._repopulate(ctx));
    }

    this._update(0, ctx);   // never let frame 0 render with an unlit scene
  }

  /** City content lands after us, so wire into it once everything has initialised. */
  /** Re-light after another agent republishes the world (roads, props, buildings). */
  _repopulate(ctx) {
    if (!this._populated) return;
    this.manager.clearStreetLights();
    this._populated = false;
    this._populate(ctx);
  }

  _populate(ctx) {
    if (this._populated) return;
    this._populated = true;
    const n = this.manager.buildStreetLights(ctx);
    this._buildShopfronts(ctx);
    this._adoptBuildings(ctx);
    ctx.bus.emit('lighting:rebuild');
    console.info(`[lighting] ${n} street lamps, ${this.manager.stats().glows} emissive sources, ` +
      `${this.shadows.count} cascades @ ${this.shadows.debugInfo().maps.join('/')}`);
  }

  /**
   * Shadow reach. Every metre here costs triangles four times over (once per
   * cascade), so it is the single most expensive lighting number in the game.
   * 380 m still puts shadows on everything the player reads as "nearby"; past that
   * aerial perspective and the last cascade's fade do the work.
   */
  _shadowDistance(s) {
    return s.preset === 'low' ? 190 : s.preset === 'medium' ? 280 : 380;
  }

  /**
   * Cascade count by preset.
   *
   * NOTE, because this has now been reported twice as a bug: `Settings.PRESETS`
   * ASKS for 4 cascades on `high` and `ultra` and this deliberately refuses,
   * running 3. It is a budget ceiling, not an oversight — every cascade is a
   * complete second submission of every caster in its range, and the frame is
   * currently 17x under its fps budget. Four cascades at the declared 3072 base
   * would be 26.5 M shadow texels against today's 10.8 M *and* a fourth geometry
   * pass. `lighting.debug().csm` and the `[lighting]` boot line both report what
   * is actually running, so the two can always be compared.
   *
   * If `Settings.js` is ever edited, `high` should declare `shadowCascades: 3,
   * shadowMap: 2048` so the declaration matches — that file is not ours.
   */
  _cascadeCount(s) {
    return Math.min(s.shadowCascades ?? 4, s.preset === 'low' ? 2 : 3);
  }

  /** Base shadow map size. Cascade 0 covers ~26 m, so 2048 is ~1.3 cm per texel. */
  _shadowMapSize(s) {
    return Math.min(s.shadowMap ?? 2048, s.preset === 'ultra' ? 3072 : 2048);
  }

  _applyQuality(ctx) {
    const s = ctx.settings;
    this.shadows.setQuality({
      cascades: this._cascadeCount(s), mapSize: this._shadowMapSize(s),
      maxDistance: this._shadowDistance(s),
      pcfTaps: s.preset === 'low' ? 6 : s.preset === 'medium' ? 10 : 14,
      pcss: s.preset !== 'low',
    });
    this.probes.setQuality(s.preset);
    this.sun = this.shadows.primary;
  }

  /* ------------------------------------------------------------- contract -- */

  /**
   * Register an artificial light. See LightManager#register.
   * @param {THREE.Object3D|null} obj3d
   * @param {{type:'street'|'headlight'|'sign'|'tail'|'window', range?:number, intensity?:number}} opts
   */
  registerLight(obj3d, opts) { return this.manager.register(obj3d, opts); }

  /**
   * Attach a matched headlight/tail-light rig to a vehicle. The Vehicle agent owns
   * `Vehicle.headlightsOn`; call `rig.setEnabled(v.headlightsOn)` when it changes,
   * or leave it alone and the lights follow the world clock.
   *
   * `root` must already be at the vehicle's transform: registration samples the
   * anchors' world matrices, so a rig built on an unplaced root spends its first
   * frame throwing a headlight pool wherever that root happened to be.
   *
   * The setters are latched, so driving them from a per-frame loop is free.
   * **The caller MUST call `rig.release()` when the vehicle goes away** — the slot,
   * pool and halo arrays are fixed at 6000/6000/8000 and a rig that is dropped
   * rather than released holds its four of them forever.
   * @param {THREE.Object3D} root vehicle mesh; lamps are placed in its local space
   * @param {{front?:number[][], rear?:number[][], range?:number}} [opts] lamp
   *        positions in `root`'s local space; defaults are sedan-shaped, so a bus
   *        or a truck should pass its own (`getVehicleGeometry(t).anchors`).
   */
  registerVehicleLights(root, { front = [[-0.68, 0.62, -2.05], [0.68, 0.62, -2.05]],
    rear = [[-0.7, 0.72, 2.2], [0.7, 0.72, 2.2]], range = 46 } = {}) {
    const rig = { heads: [], tails: [], nodes: [] };
    // A lamp never moves in the car's frame, so its local matrix is composed once
    // and then frozen. `LightManager._refreshDynamic` calls `updateWorldMatrix` on
    // every anchor every frame; with a city's worth of traffic that is ~500 needless
    // position/quaternion/scale composes a frame, and this removes all of them.
    const anchor = (p) => {
      const n = new THREE.Object3D();
      n.position.set(p[0], p[1], p[2]);
      root.add(n);
      n.updateMatrix();
      n.matrixAutoUpdate = false;
      rig.nodes.push(n);
      return n;
    };
    for (const p of front) {
      const n = anchor(p);
      rig.heads.push(this.manager.register(n, {
        type: 'headlight', color: '#f4f2ff', range, intensity: 62,
        poolRadius: 3.4, poolLength: 16, haloSize: 0.28, dynamic: true, cone: 0.55,
      }));
    }
    for (const p of rear) {
      const n = anchor(p);
      rig.tails.push(this.manager.register(n, {
        type: 'tail', color: '#ff2410', range: 9, intensity: 7,
        poolRadius: 0, haloSize: 0.22, dynamic: true,
      }));
    }
    // Latched, because every setter writes an instance colour and flags the whole
    // pool/glow buffer for re-upload. The natural caller is a per-frame presentation
    // loop over every car in the city, so a setter that did the write unconditionally
    // would dirty both buffers on every frame regardless of whether anything changed.
    let heads = null, tails = null, braking = null;
    rig.setEnabled = (on) => {
      if (on === heads) return;
      heads = on;
      for (const h of rig.heads) h.setEnabled(on);
    };
    rig.setTailEnabled = (on) => {
      if (on === tails) return;
      tails = on;
      for (const t of rig.tails) t.setEnabled(on);
    };
    rig.setBraking = (on) => {
      if (on === braking) return;
      braking = on;
      for (const t of rig.tails) t.setIntensity(on ? 22 : 7);
    };
    rig.release = () => {
      for (const h of rig.heads) h.release();
      for (const t of rig.tails) t.release();
      for (const n of rig.nodes) n.parent?.remove(n);
      rig.heads.length = 0; rig.tails.length = 0; rig.nodes.length = 0;
    };
    return rig;
  }

  /**
   * Give a facade procedural lit windows. Safe to call on a shared material — the
   * injection is idempotent and driven entirely from uniforms.
   * @param {THREE.Mesh|THREE.Material} target
   * @param {{floorHeight?:number, windowWidth?:number, brightness?:number}} [o]
   */
  applyWindowLights(target, o = {}) {
    const mats = target.isMaterial ? [target]
      : Array.isArray(target.material) ? target.material : [target.material];
    for (const m of mats) {
      if (!m || this._winPatched.has(m)) continue;
      this._winPatched.add(m);
      const u = {
        uWinNight: { value: 0 },
        uWinLit: { value: 0.35 },
        uWinTime: { value: 0 },
        uWinCell: { value: new THREE.Vector2(o.windowWidth ?? 3.1, o.floorHeight ?? 3.55) },
        uWinBright: { value: o.brightness ?? WIN_BRIGHT },
      };
      // Compose, never replace: the facade agent already hooks onBeforeCompile for
      // its own soot and macro-variation code, and clobbering it would silently
      // delete their work.
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = function (shader, renderer) {
        if (typeof prev === 'function') prev.call(this, shader, renderer);
        Object.assign(shader.uniforms, u);
        // Guard per shader object as well as per material: a chained patcher can
        // call us more than once for one program, and a second injection would
        // redefine WIN_PARS and break compilation.
        if (shader._bkWindowLights) return;
        shader._bkWindowLights = true;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + WIN_PARS)
          .replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n' + WIN_BODY);
      };
      m.userData.bostonWindowLights = true;
      m.needsUpdate = true;
      this._winMats.push(u);
    }
  }

  /* ------------------------------------------------------------ placeholder */

  /**
   * Until the Buildings agent lands, light the placeholder blocks so night can be
   * evaluated. Self-disabling: the moment a real road graph exists we assume the
   * facade owner is calling applyWindowLights itself.
   */
  /**
   * Lit windows.
   *
   * If the facade owner already publishes a night emissive (Materials tags those
   * with `userData.nightEmissive`, and an emissiveMap means the interior is
   * authored), leave it alone — two window grids on one wall is worse than none.
   * Otherwise a procedural grid is what stops a night city reading as a cliff face.
   */
  _adoptBuildings(ctx) {
    const seen = new Set();
    let n = 0;
    ctx.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || seen.has(m) || !m.isMeshStandardMaterial) continue;
        seen.add(m);
        if (!/facade|building|brownstone|brick|tower/i.test(m.name || '')) continue;
        if (m.userData.nightEmissive || m.emissiveMap) continue;   // already handled
        if (m.emissive && m.emissive.getHex() !== 0) continue;
        this.applyWindowLights(m, { floorHeight: 3.6, windowWidth: 3.15 });
        n++;
      }
    });
    // Placeholder city: light the stand-in blocks so night is testable pre-Buildings.
    const city = ctx.get('city');
    if (!n && city && !city.roads && city.blocks?.isMesh &&
        city.blocks.material?.isMeshStandardMaterial) {
      const mesh = city.blocks;
      const clone = mesh.material.clone();
      this._swapped.push({ mesh, original: mesh.material, clone });
      mesh.material = clone;
      this.applyWindowLights(clone, { floorHeight: 3.6, windowWidth: 3.2 });
      n = 1;
    }
    return n;
  }

  /**
   * Shopfront and sign spill.
   *
   * Nobody else publishes sign data, and an unlit shopfront is the difference
   * between a night street and a night car park. Signs sit on the building line,
   * throw a saturated pool onto the pavement, and read as a bloom source.
   */
  _buildShopfronts(ctx) {
    const city = ctx.get('city');
    const R = city?.roads;
    if (R?.edges?.length && R.sample) return this._signsFromRoads(ctx, city, R);
    return this._signsPlaceholder(ctx, city);
  }

  _signsFromRoads(ctx, city, R) {
    const COMMERCIAL = new Set(['financial', 'backBay', 'northEnd', 'southEnd', 'seaport', 'fenway']);
    let seed = 90210;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let n = 0;
    for (const e of R.edges) {
      if (n > 900) break;
      if (e.type === 'highway') continue;
      const halfW = (e.width || (e.lanes || 2) * 3.5) * 0.5;
      // Step along the edge in world metres; edges vary wildly in length.
      const a = R.sample(e.id, 0), b = R.sample(e.id, 1);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 25) continue;
      const steps = Math.max(1, Math.round(len / 38));
      for (let i = 0; i < steps && n < 900; i++) {
        const t = (i + 0.5) / steps;
        const s0 = R.sample(e.id, t);
        const s1 = R.sample(e.id, Math.min(1, t + 0.02));
        if (!s0 || !s1) continue;
        let tx = s1.x - s0.x, tz = s1.z - s0.z;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const side = rnd() < 0.5 ? 1 : -1;
        const off = halfW + 3.4;
        const x = s0.x + -tz * off * side;
        const z = s0.z + tx * off * side;
        const dist = city.districtAt ? city.districtAt(x, z) : 'financial';
        if (!COMMERCIAL.has(dist)) continue;
        if (rnd() > (dist === 'financial' || dist === 'northEnd' ? 0.55 : 0.34)) continue;
        // Drawn surface, not the terrain raster: `groundHeight` is stamped
        // 0.4-0.75 m below the carriageway, which put every sign's ground pool
        // under the pavement it was meant to light. See `LightManager._groundAt`.
        const g = city.surfaceHeight ? city.surfaceHeight(x, z) : city.groundHeight(x, z);
        this.manager.register(null, {
          type: 'sign',
          position: [x, g + 3.3 + rnd() * 1.9, z],
          groundY: g,
          color: NEON[(rnd() * NEON.length) | 0],
          range: 14, intensity: 22,
          poolRadius: 4.6, haloSize: 0.7 + rnd() * 0.55,
        });
        n++;
      }
    }
    return n;
  }

  /** Placeholder-city fallback: neon on the block faces so night is testable. */
  _signsPlaceholder(ctx, city) {
    const PITCH = 90, HALF_BLOCK = 26, SPAN = 560;
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let n = 0;
    for (let bx = -6; bx <= 6; bx++) {
      for (let bz = -6; bz <= 6; bz++) {
        const cx = bx * PITCH, cz = bz * PITCH;
        if (Math.abs(cx) > SPAN || Math.abs(cz) > SPAN) continue;
        if (Math.abs(bx) < 2 && Math.abs(bz) < 2) continue;
        for (let f = 0; f < 4; f++) {
          if (rnd() > 0.55) continue;
          const ang = f * Math.PI * 0.5;
          const nx = Math.cos(ang), nz = Math.sin(ang);
          const t = (rnd() - 0.5) * HALF_BLOCK * 1.5;
          const x = cx + nx * (HALF_BLOCK + 0.6) - nz * t;
          const z = cz + nz * (HALF_BLOCK + 0.6) + nx * t;
          const g = city?.surfaceHeight ? city.surfaceHeight(x, z)
            : city?.groundHeight ? city.groundHeight(x, z) : 0;
          this.manager.register(null, {
            type: 'sign',
            position: [x + nx * 0.9, g + 3.4 + rnd() * 1.6, z + nz * 0.9],
            groundY: g,
            color: NEON[(rnd() * NEON.length) | 0],
            range: 13, intensity: 20,
            poolRadius: 4.4, haloSize: 0.75 + rnd() * 0.5,
          });
          n++;
        }
      }
    }
    return n;
  }

  /** Dev helper: drop N moving headlight rigs to sanity-check the vehicle path. */
  spawnTestHeadlights(n = 8) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = new THREE.Object3D();
      o.position.set(45 + ((i * 90) % 540) - 270, 0.75, (i & 1 ? 1 : -1) * (40 + i * 55));
      o.rotation.y = (i & 1) ? 0 : Math.PI;
      this.ctx.scene.add(o);
      out.push(this.registerVehicleLights(o));
    }
    return out;
  }

  /* ------------------------------------------------------------------ tick -- */

  update(dt, ctx) { this._update(dt, ctx); }

  /** Shadows must be fitted after the camera rig has solved, or they lag a frame. */
  lateUpdate(dt, ctx) {
    this.shadows.update(ctx.camera, this.toSun);
  }

  _update(dt, ctx) {
    if (!this._populated && (this._popFrames = (this._popFrames || 0) + 1) > 2) {
      try { this._populate(ctx); } catch (e) { console.warn('[lighting] populate failed', e); }
    }
    const sky = ctx.get('sky');
    if (sky?.sunDir) _toSun.copy(sky.sunDir);
    if (_toSun.lengthSq() < 1e-6) _toSun.set(0, 1, 0);
    _toSun.normalize();

    const w = this.weather;
    const altSin = THREE.MathUtils.clamp(_toSun.y, -1, 1);
    const altDeg = Math.asin(altSin) * 57.29578;

    // --- direct sun -------------------------------------------------------
    const above = THREE.MathUtils.smoothstep(altDeg, -0.9, 1.3);
    const t = this._transmittance(altSin, altDeg);
    let sunI = SUN_PEAK * (t / this._peakT()) * above * w.sun;

    // Colour temperature: 1900 K at the horizon through to daylight overhead.
    const kelvin = 1850 + 4050 * THREE.MathUtils.smoothstep(altDeg, -1, 26);
    kelvinToColor(kelvin, this.sunColor);
    if (w.tint < 1) this.sunColor.lerp(_c1.setRGB(0.86, 0.89, 0.95), 1 - w.tint);

    // --- key light: sun -> twilight -> moon, with no gap between them --------
    //
    // Everything below is ADDITIVE in intensity and a weighted blend in
    // direction and colour, so the key never jumps. The previous code switched
    // outright from the sun to the moon and left a hole wherever neither
    // qualified — the measured dusk dead zone at tod 19.5, and the whole of the
    // small hours whenever the moon path is below the horizon.
    this.night = 1 - THREE.MathUtils.smoothstep(altSin, -0.035, 0.105);
    const moon = THREE.MathUtils.smoothstep(-altSin, 0.045, 0.16);

    // Twilight: opens as the sun's own term dies at -0.9 deg, closed again by
    // -11 deg where the moon (if there is one) has taken over.
    const twi = (1 - THREE.MathUtils.smoothstep(altDeg, -1.5, 2.5)) *
      THREE.MathUtils.smoothstep(altDeg, -11, -4);
    const twiI = TWILIGHT_PEAK * twi * w.sun;

    // Moon. `_moonDir` prefers the Atmosphere agent's if it publishes one.
    let moonI = 0;
    if (moon > 0.001) {
      this._moonDir(ctx.time.timeOfDay, _tmp);
      moonI = _tmp.y > 0.02
        ? MOON_PEAK * moon * w.sun * (0.4 + 0.6 * _tmp.y)
        // Below the horizon there is no moon, but a city at 03:00 still needs a
        // key or every surface flattens. Lift its own azimuth and dim it hard.
        : NIGHT_KEY * moon * w.sun;
    }

    // Direction: the sun's azimuth, lifted off the horizon by however much
    // twilight is in play, then blended toward the moon by its share of the
    // total. Lifting continuously (rather than switching) is what keeps the
    // shadow direction from snapping at sunset.
    _liftDir(_toSun, THREE.MathUtils.lerp(_toSun.y, KEY_MIN_Y, twi), _key);
    const nightI = twiI + moonI;
    if (nightI > 1e-5) {
      const share = moonI / nightI;
      if (share > 0) {
        _liftDir(_tmp, Math.max(_tmp.y, KEY_MIN_Y), _tmp);
        _key.lerp(_tmp, share).normalize();
      }
      _c3.copy(TWILIGHT_COL).lerp(MOON_COL, share);
      // The sun still owns the colour while it is the stronger term.
      this.sunColor.lerp(_c3, nightI / (nightI + sunI));
      sunI += nightI;
    }

    this.toSun.copy(_key);
    this.sunDir.copy(_key).negate();
    this.sunIntensity = sunI;
    this.shadows.setSun(this.sunColor, sunI);
    this.shadows.setCastShadows(sunI > 0.012);

    // --- skylight ---------------------------------------------------------
    const skyCurve = Math.pow(Math.max(0, (altSin + 0.16) / 1.16), 0.9);
    // `THREE.MathUtils.smoothstep(x, min, max)` returns 0 for x <= min BEFORE it
    // tests max, so calling it with min > max does not reverse the ramp — it
    // degenerates into `x > min ? 1 : 0`. `smoothstep(altDeg, 14, -3)` was
    // therefore 1 only when the sun was ABOVE 14 deg and 0 everywhere else, so
    // this term ran exactly backwards: the hemisphere light was 85% of the warm
    // dusk colour at noon and pure blue day colour at sunset. Measured on the
    // live hemisphere: #fff0e7 (warm cream) at tod 6, 7, 12, 15 and 18, flipping
    // to #c8ffff (cyan) at 18.5 — which is a fair share of "the daylight is a
    // milky wash and the ground tint disagrees with the sky".
    const dusk = (1 - THREE.MathUtils.smoothstep(altDeg, -3, 14)) *
      THREE.MathUtils.smoothstep(altDeg, -9, -1);
    this.skyColor.copy(SKY_DAY).lerp(SKY_DUSK, dusk * 0.85).lerp(SKY_NIGHT, this.night);
    _c2.copy(GND_DAY).lerp(GND_DUSK, dusk * 0.8).lerp(GND_NIGHT, this.night);

    // A HemisphereLight's irradiance is colour x intensity, so an authored colour
    // quietly scales the level by its own luminance. SKY_NIGHT is a very dark blue
    // (linear luminance 0.017), so the authored night floor was arriving at the
    // shader ~58x weaker than the number said — that, not the tone mapper, is why
    // night rendered near-black.
    //
    // Split the two concerns: the colours carry hue, `skyIntensity` carries level.
    // Both hemisphere colours are divided by the *sky* luminance, which preserves
    // the sky/ground brightness ratio the authored pair encodes, and the same
    // luminance is folded back into the daylight term so daylight is unchanged to
    // the last bit. Only the night floor changes meaning, and it now means what it
    // says.
    const skyLum = Math.max(luminance(this.skyColor), 1e-4);
    const inv = 1 / skyLum;
    this.hemi.color.copy(this.skyColor).multiplyScalar(inv);
    this.hemi.groundColor.copy(_c2).multiplyScalar(inv);
    this.skyIntensity = SKY_PEAK * skyCurve * w.sky * skyLum + this.night * NIGHT_SKY * w.sky;
    this.hemi.intensity = this.skyIntensity;

    // The PMREM sky is a second, uncontrolled ambient source; keep the total honest.
    // At night it is the only thing that puts skyglow into wet asphalt and glass, so
    // it gets its own floor rather than decaying to the daylight base.
    ctx.scene.environmentIntensity =
      0.16 + 0.62 * skyCurve * w.tint + this.night * NIGHT_ENV * w.tint;
    // ...but only its SPECULAR half is wanted at full strength. Its diffuse half
    // is the same skylight the hemisphere light already delivers, and counting it
    // twice is what filled every daylight shadow back in. Cut in daylight, left
    // alone at night, where it is a real and separately authored fill rather than
    // a duplicate (see NIGHT_ENV, and the note on NIGHT_SKY about the pinned
    // exposure — nothing here changes the night level).
    bostonUniforms.bostonIblDiffuse.value =
      THREE.MathUtils.lerp(DAY_IBL_DIFFUSE, 1, this.night);
    bostonUniforms.bostonSkyOcc.value =
      THREE.MathUtils.lerp(DAY_SKY_OCC, NIGHT_SKY_OCC, this.night);

    // Softer sun under cloud: the disc becomes the whole sky.
    // Penumbra width. This was 0.0093 — twice the sun's real angular radius,
    // "for softness" — and the critic measured the result as a tree shadow soft
    // over ~40 px at 5 m. Doubling it does not read as a softer sun, it reads as
    // an out-of-focus shadow map, and it costs shadow depth: everything inside
    // the penumbra is a partially-lit pixel. Swept at Hanover St 09:30, median
    // shadowed/lit over every pixel the shadow map changes:
    //   0.0093 -> 0.98 stops   0.0062 -> 1.04   0.0047 -> 1.10   0.0033 -> 1.16
    // 0.0047 is the physical figure (tan of the sun's 0.266 deg angular radius),
    // so that is where it stops. `w.soft` still opens it 3-6x under cloud, which
    // is where a genuinely soft shadow belongs.
    bostonUniforms.bostonSunAngular.value = 0.0047 * w.soft;

    // --- artificial ---------------------------------------------------------
    this.manager.update(dt, ctx, this.night);
    this._updateWindows(ctx);

    const ps = this._probeState;
    ps.dirY = this.toSun.y;
    ps.color.copy(this.sunColor);
    ps.intensity = this.sunIntensity;
    // Hue-only colour + honest level, exactly as the hemisphere light gets it, so
    // the bounce the probe volume bakes matches the ambient the shader applies.
    ps.skyColor.copy(this.hemi.color);
    ps.skyIntensity = this.skyIntensity;
    ps.night = this.night;
    this.probes.update(dt, ctx, ps);
  }

  /** Broadband atmospheric transmittance from Kasten-Young relative air mass. */
  _transmittance(altSin, altDeg) {
    const denom = altSin + 0.50572 * Math.pow(Math.max(altDeg, -5) + 6.07995, -1.6364);
    const m = THREE.MathUtils.clamp(1 / Math.max(denom, 1e-3), 1, 40);
    return Math.exp(-0.11 * (m - 1)) * 0.86;
  }
  _peakT() {
    if (this._pt === undefined) this._pt = this._transmittance(0.862, 59.6);
    return this._pt;
  }

  /**
   * Moon direction. Uses the Atmosphere agent's if it publishes one, otherwise a
   * plausible near-antisolar path so night has a key light and cast shadows.
   */
  _moonDir(hour, out) {
    const sky = this.ctx.get('sky');
    if (sky?.moonDir) return out.copy(sky.moonDir).normalize();
    const lat = 42.355 * Math.PI / 180;
    const decl = -6 * Math.PI / 180;
    const H = ((hour + 12.35) % 24 - 12) * 15 * Math.PI / 180;
    const alt = Math.asin(Math.sin(lat) * Math.sin(decl) +
      Math.cos(lat) * Math.cos(decl) * Math.cos(H));
    const az = Math.atan2(Math.sin(H),
      Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
    return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), Math.cos(az) * Math.cos(alt))
      .normalize();
  }

  /** Windows switch on across the evening and off again through the small hours. */
  _updateWindows(ctx) {
    if (!this._winMats.length) return;
    const h = ctx.time.timeOfDay;
    let lit;
    if (h < 4.5) lit = THREE.MathUtils.lerp(0.30, 0.10, (h + 24 - 22) / 6.5);
    else if (h < 7.5) lit = THREE.MathUtils.lerp(0.10, 0.34, (h - 4.5) / 3);
    else if (h < 16) lit = 0.16;
    else if (h < 19) lit = THREE.MathUtils.lerp(0.16, 0.46, (h - 16) / 3);
    else if (h < 22) lit = THREE.MathUtils.lerp(0.46, 0.58, (h - 19) / 3);
    else lit = THREE.MathUtils.lerp(0.58, 0.30, (h - 22) / 2.5);
    const el = ctx.time.elapsed;
    for (const u of this._winMats) {
      u.uWinNight.value = this.night;
      u.uWinLit.value = lit;
      u.uWinTime.value = el;
    }
  }

  /* ------------------------------------------------------------------ misc -- */

  debug() {
    const P = this.probes;
    return {
      tod: +this.ctx.time.timeOfDay.toFixed(2),
      sun: +this.sunIntensity.toFixed(3),
      sky: +this.skyIntensity.toFixed(3),
      env: +(this.ctx.scene.environmentIntensity ?? 1).toFixed(3),
      iblDiffuse: +bostonUniforms.bostonIblDiffuse.value.toFixed(3),
      keyY: +this.toSun.y.toFixed(3),
      casts: this.shadows.primary.castShadow,
      night: +this.night.toFixed(2),
      alt: +(Math.asin(THREE.MathUtils.clamp(this.toSun.y, -1, 1)) * 57.3).toFixed(1),
      csm: this.shadows.debugInfo(),
      lights: this.manager.stats(),
      probes: {
        on: +bostonUniforms.bostonProbeMix.value,
        enabled: P.enabled, solved: !!P._solvedOnce,
        grid: P.enabled ? [P.gx, P.gy, P.gz] : null,
        skyOcc: bostonUniforms.bostonSkyOcc.value,
        iblOcc: bostonUniforms.bostonIblOcc.value,
        vis: P.enabled ? P.sampleVisibility(this.ctx.camera.position) : null,
      },
    };
  }

  dispose() {
    for (const s of this._swapped) { s.mesh.material = s.original; s.clone.dispose(); }
    this._swapped.length = 0;
    this.shadows?.dispose();
    this.manager?.dispose();
    this.probes?.dispose();
    this.hemi?.parent?.remove(this.hemi);
    this.hemi?.dispose();
    this._winMats.length = 0;
  }
}

/** Rec.709 luminance of a colour that is already in the linear working space. */
function luminance(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

/**
 * Re-point a unit direction at a given altitude without moving its azimuth.
 * Safe to call with `src === out`.
 * @param {THREE.Vector3} src unit vector
 * @param {number} y target sin(altitude)
 * @param {THREE.Vector3} out
 */
function _liftDir(src, y, out) {
  const hx = src.x, hz = src.z;
  const h = Math.hypot(hx, hz);
  const ny = THREE.MathUtils.clamp(y, -1, 1);
  if (h < 1e-5) return out.set(0, ny >= 0 ? 1 : -1, 0);
  const s = Math.sqrt(Math.max(0, 1 - ny * ny)) / h;
  return out.set(hx * s, ny, hz * s);
}

/**
 * Tanner Helland's blackbody approximation, good to a few percent over 1000-10000 K.
 * Results are sRGB, so let Color do the conversion into the linear working space.
 */
function kelvinToColor(k, out) {
  const t = THREE.MathUtils.clamp(k, 1000, 12000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
  return out;
}
