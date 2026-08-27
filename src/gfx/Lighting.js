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

const SUN_PEAK = 5.2;      // ARCHITECTURE: sun sits in the 3-6 band
const SKY_PEAK = 1.05;
const MOON_PEAK = 0.075;

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
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/* Sky and bounce reference colours, authored in sRGB. */
const SKY_DAY = new THREE.Color('#8ab4ee');
const SKY_DUSK = new THREE.Color('#c08a6e');
const SKY_NIGHT = new THREE.Color('#16233f');
const GND_DAY = new THREE.Color('#5b5348');
const GND_DUSK = new THREE.Color('#4a382c');
const GND_NIGHT = new THREE.Color('#241a12');   // sodium skyglow off low cloud
const MOON_COL = new THREE.Color('#9fb6de');

const NEON = ['#ff2d55', '#00e5ff', '#ff9500', '#39ff88', '#ff36f0', '#ffd21e', '#4d6bff'];

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

const WIN_BODY = /* glsl */`
	if ( uWinNight > 0.002 ) {
		vec3 bwPos = cameraPosition + ( - vViewPosition ) * mat3( viewMatrix );
		vec3 bwNrm = normal * mat3( viewMatrix );
		if ( abs( bwNrm.y ) < 0.45 ) {
			float u = abs( bwNrm.x ) > abs( bwNrm.z ) ? bwPos.z : bwPos.x;
			vec2 cell = vec2( u / uWinCell.x, ( bwPos.y - 1.3 ) / uWinCell.y );
			vec2 id = floor( cell );
			vec2 fr = fract( cell );
			vec2 pane = smoothstep( vec2( 0.13 ), vec2( 0.25 ), fr ) *
				( 1.0 - smoothstep( vec2( 0.75 ), vec2( 0.87 ), fr ) );
			float shape = pane.x * pane.y;
			float h1 = bostonHash21( id );
			float h2 = bostonHash21( id + 37.7 );
			float h3 = bostonHash21( id * 1.73 + 11.3 );
			// Occupancy is per window and biased per floor, so a tower lights up in
			// clumps the way a real one does rather than as uniform static.
			float lit = step( h1, uWinLit * ( 0.45 + 1.05 * bostonHash21( vec2( id.y, 3.0 ) ) ) );
			vec3 c = mix( vec3( 1.0, 0.60, 0.28 ), vec3( 0.70, 0.81, 1.0 ), step( 0.60, h2 ) );
			float flick = 1.0;
			if ( h2 > 0.90 ) {                       // televisions
				c = vec3( 0.26, 0.46, 1.0 );
				flick = 0.5 + 0.5 * abs( sin( uWinTime * 6.1 + h3 * 41.0 ) *
					sin( uWinTime * 1.9 + h1 * 23.0 ) );
			}
			totalEmissiveRadiance += c * ( shape * lit * flick * uWinBright *
				uWinNight * ( 0.5 + h3 * 0.9 ) );
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

  /** Cascade count by preset — the brief's 3-4, budgeted rather than assumed. */
  _cascadeCount(s) {
    return Math.min(s.shadowCascades ?? 4, s.preset === 'low' ? 2 : 3);
  }

  /** Base shadow map size. Cascade 0 covers ~30 m, so 2048 is ~1.5 cm per texel. */
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
   * @param {THREE.Object3D} root vehicle mesh; lamps are placed in its local space
   */
  registerVehicleLights(root, { front = [[-0.68, 0.62, -2.05], [0.68, 0.62, -2.05]],
    rear = [[-0.7, 0.72, 2.2], [0.7, 0.72, 2.2]], range = 46 } = {}) {
    const rig = { heads: [], tails: [], nodes: [] };
    for (const p of front) {
      const n = new THREE.Object3D();
      n.position.set(p[0], p[1], p[2]);
      root.add(n); rig.nodes.push(n);
      rig.heads.push(this.manager.register(n, {
        type: 'headlight', color: '#f4f2ff', range, intensity: 62,
        poolRadius: 3.4, poolLength: 16, haloSize: 0.28, dynamic: true, cone: 0.55,
      }));
    }
    for (const p of rear) {
      const n = new THREE.Object3D();
      n.position.set(p[0], p[1], p[2]);
      root.add(n); rig.nodes.push(n);
      rig.tails.push(this.manager.register(n, {
        type: 'tail', color: '#ff2410', range: 9, intensity: 7,
        poolRadius: 0, haloSize: 0.22, dynamic: true,
      }));
    }
    rig.setEnabled = (on) => { for (const h of rig.heads) h.setEnabled(on); };
    rig.setBraking = (on) => { for (const t of rig.tails) t.setIntensity(on ? 22 : 7); };
    rig.release = () => {
      for (const h of rig.heads) h.release();
      for (const t of rig.tails) t.release();
      for (const n of rig.nodes) n.parent?.remove(n);
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
        uWinBright: { value: o.brightness ?? 3.6 },
      };
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + WIN_PARS)
          .replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n' + WIN_BODY);
      };
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
  _adoptBuildings(ctx) {
    const city = ctx.get('city');
    if (!city || city.roads) return;
    const mesh = city.blocks;
    if (!mesh?.isMesh || !mesh.material?.isMeshStandardMaterial) return;
    const clone = mesh.material.clone();
    this._swapped.push({ mesh, original: mesh.material, clone });
    mesh.material = clone;
    this.applyWindowLights(clone, { floorHeight: 3.6, windowWidth: 3.2, brightness: 3.8 });
  }

  /** Shopfront neon at street level. Real signs should come from the City agent. */
  _buildShopfronts(ctx) {
    const city = ctx.get('city');
    if (city?.roads) return;                    // real content exists; not our job
    const PITCH = 90, HALF_BLOCK = 26, SPAN = 560;
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let bx = -6; bx <= 6; bx++) {
      for (let bz = -6; bz <= 6; bz++) {
        const cx = bx * PITCH, cz = bz * PITCH;
        if (Math.abs(cx) > SPAN || Math.abs(cz) > SPAN) continue;
        if (Math.abs(bx) < 2 && Math.abs(bz) < 2) continue;   // no block there
        for (let f = 0; f < 4; f++) {
          if (rnd() > 0.55) continue;
          const ang = f * Math.PI * 0.5;
          const nx = Math.cos(ang), nz = Math.sin(ang);
          const t = (rnd() - 0.5) * HALF_BLOCK * 1.5;
          const x = cx + nx * (HALF_BLOCK + 0.6) - nz * t;
          const z = cz + nz * (HALF_BLOCK + 0.6) + nx * t;
          const col = NEON[(rnd() * NEON.length) | 0];
          const g = city?.groundHeight ? city.groundHeight(x, z) : 0;
          this.manager.register(null, {
            type: 'sign',
            position: [x + nx * 0.9, g + 3.4 + rnd() * 1.6, z + nz * 0.9],
            groundY: g,
            color: col,
            range: 13, intensity: 16,
            poolRadius: 4.4, haloSize: 0.75 + rnd() * 0.5,
          });
        }
      }
    }
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

    // --- night: the same cascades carry the moon, so night still has shadows --
    this.night = 1 - THREE.MathUtils.smoothstep(altSin, -0.035, 0.105);
    const moon = THREE.MathUtils.smoothstep(-altSin, 0.045, 0.16);
    let dir = _toSun;
    if (moon > 0.001 && sunI < MOON_PEAK * 1.4) {
      this._moonDir(ctx.time.timeOfDay, _tmp);
      if (_tmp.y > 0.05) {
        dir = _tmp;
        sunI = MOON_PEAK * moon * w.sun * (0.4 + 0.6 * _tmp.y);
        this.sunColor.copy(MOON_COL);
      } else sunI = Math.max(sunI, 0);
    }

    this.toSun.copy(dir);
    this.sunDir.copy(dir).negate();
    this.sunIntensity = sunI;
    this.shadows.setSun(this.sunColor, sunI);
    this.shadows.setCastShadows(sunI > 0.012);

    // --- skylight ---------------------------------------------------------
    const skyCurve = Math.pow(Math.max(0, (altSin + 0.16) / 1.16), 0.9);
    const dusk = THREE.MathUtils.smoothstep(altDeg, 14, -3) *
      THREE.MathUtils.smoothstep(altDeg, -9, -1);
    this.skyColor.copy(SKY_DAY).lerp(SKY_DUSK, dusk * 0.85).lerp(SKY_NIGHT, this.night);
    _c2.copy(GND_DAY).lerp(GND_DUSK, dusk * 0.8).lerp(GND_NIGHT, this.night);
    // Night floor: moonlight plus the city's own glow bouncing off the air.
    this.skyIntensity = SKY_PEAK * skyCurve * w.sky + this.night * 0.055;
    this.hemi.color.copy(this.skyColor);
    this.hemi.groundColor.copy(_c2);
    this.hemi.intensity = this.skyIntensity;

    // The PMREM sky is a second, uncontrolled ambient source; keep the total honest.
    ctx.scene.environmentIntensity = 0.16 + 0.62 * skyCurve * w.tint;

    // Softer sun under cloud: the disc becomes the whole sky.
    bostonUniforms.bostonSunAngular.value = 0.0093 * w.soft;

    // --- artificial ---------------------------------------------------------
    this.manager.update(dt, ctx, this.night);
    this._updateWindows(ctx);

    const ps = this._probeState;
    ps.dirY = this.toSun.y;
    ps.color.copy(this.sunColor);
    ps.intensity = this.sunIntensity;
    ps.skyColor.copy(this.skyColor);
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
    return {
      tod: +this.ctx.time.timeOfDay.toFixed(2),
      sun: +this.sunIntensity.toFixed(3),
      sky: +this.skyIntensity.toFixed(3),
      night: +this.night.toFixed(2),
      alt: +(Math.asin(THREE.MathUtils.clamp(this.toSun.y, -1, 1)) * 57.3).toFixed(1),
      csm: this.shadows.debugInfo(),
      lights: this.manager.stats(),
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
