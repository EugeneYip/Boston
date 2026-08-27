import * as THREE from 'three';
import {
  RAIN_VERT, RAIN_FRAG, SNOW_VERT, SNOW_FRAG, SPLASH_VERT, SPLASH_FRAG,
} from '../shaders/sky/precip.glsl.js';

const TRANSITION = 20;      // seconds for a full state change — never a hard cut
const RAIN_MAX = 90000;
const SNOW_MAX = 40000;
const SPLASH_MAX = 2600;

/**
 * Weather states. Every number here is linearly blended toward over
 * TRANSITION seconds, so the sky, clouds, fog, precipitation, wind and
 * wetness all move together.
 *
 * `hazeSigma` is the aerosol extinction per metre and is what carries aerial
 * perspective. Calibrated by reading depth-bucketed transmittance out of the
 * composite rather than by eye: `clear` puts ~10% sky into geometry at 300 m
 * and ~29% at 1 km, which is the ramp that makes the skyline read as
 * kilometres deep instead of a few hundred metres of boxes.
 *
 * Boston-specific: `storm` is a nor'easter — cumulonimbus to 8 km, wind out of
 * the north-east at 18 m/s and near-horizontal rain. `fog` is harbour sea fog,
 * a shallow 60 m layer that swallows the skyline but leaves the towers'
 * crowns in clear air. `snow` is heavy wet Atlantic snow: big slow flakes.
 */
const PRESETS = {
  clear: {
    coverage: 0.42, cloudType: 0.40, density: 1, extinction: 0.018, detail: 0.35,
    cloudBottom: 1550, cloudTop: 3700, anvil: 0.0, ambient: 1.0, cloudShadow: 0.85,
    turbidity: 1.25, hazeSigma: 0.00034, hazeH: 1300, hazeY0: 0, fogAlbedo: 0.0,
    rayleigh: 1.0, shaft: 0.85, horizonHaze: 0.20, skyMul: 1.0, aerial: 4.5e-05,
    rain: 0, snow: 0, wind: 5, windDir: 235, lightning: 0, wetness: 0.0,
    fogTint: '#c9d3de',
  },
  overcast: {
    coverage: 1, cloudType: 0.10, density: 1.15, extinction: 0.024, detail: 0.24,
    cloudBottom: 750, cloudTop: 2000, anvil: 0.0, ambient: 1.35, cloudShadow: 2.2,
    turbidity: 2.30, hazeSigma: 0.00058, hazeH: 1000, hazeY0: 0, fogAlbedo: 0.15,
    rayleigh: 1.0, shaft: 0.35, horizonHaze: 0.45, skyMul: 1.0, aerial: 8e-05,
    rain: 0, snow: 0, wind: 7, windDir: 250, lightning: 0, wetness: 0.10,
    fogTint: '#b9c2cc',
  },
  rain: {
    coverage: 1, cloudType: 0.20, density: 1.25, extinction: 0.028, detail: 0.2,
    cloudBottom: 520, cloudTop: 2700, anvil: 0.1, ambient: 1.25, cloudShadow: 3.0,
    turbidity: 3.00, hazeSigma: 0.0007, hazeH: 900, hazeY0: 0, fogAlbedo: 0.35,
    rayleigh: 1.0, shaft: 0.25, horizonHaze: 0.62, skyMul: 1.0, aerial: 0.00012,
    rain: 0.72, snow: 0, wind: 9, windDir: 60, lightning: 0.0, wetness: 0.90,
    fogTint: '#9aa5b0',
  },
  storm: {
    coverage: 1, cloudType: 0.92, density: 1.4, extinction: 0.034, detail: 0.18,
    cloudBottom: 430, cloudTop: 8000, anvil: 1.0, ambient: 1.10, cloudShadow: 4.0,
    turbidity: 3.60, hazeSigma: 0.00095, hazeH: 800, hazeY0: 0, fogAlbedo: 0.45,
    rayleigh: 1.0, shaft: 0.18, horizonHaze: 0.75, skyMul: 1.0, aerial: 0.00016,
    rain: 1.0, snow: 0, wind: 18, windDir: 45, lightning: 0.30, wetness: 1.0,
    fogTint: '#7e8894',
  },
  fog: {
    coverage: 0.78, cloudType: 0.06, density: 1, extinction: 0.022, detail: 0.26,
    cloudBottom: 420, cloudTop: 1500, anvil: 0.0, ambient: 1.30, cloudShadow: 1.4,
    turbidity: 4.20, hazeSigma: 0.006, hazeH: 70, hazeY0: 0, fogAlbedo: 0.88,
    rayleigh: 1.0, shaft: 1.5, horizonHaze: 0.85, skyMul: 1.0, aerial: 9e-05,
    rain: 0, snow: 0, wind: 3, windDir: 100, lightning: 0, wetness: 0.30,
    fogTint: '#c8ced4',
  },
  snow: {
    coverage: 1, cloudType: 0.14, density: 1.15, extinction: 0.026, detail: 0.22,
    cloudBottom: 620, cloudTop: 2700, anvil: 0.0, ambient: 1.45, cloudShadow: 2.6,
    turbidity: 2.80, hazeSigma: 0.001, hazeH: 700, hazeY0: 0, fogAlbedo: 0.55,
    rayleigh: 1.0, shaft: 0.30, horizonHaze: 0.70, skyMul: 1.0, aerial: 0.00013,
    rain: 0, snow: 0.9, wind: 8, windDir: 55, lightning: 0, wetness: 0.35,
    fogTint: '#d2d8de',
  },
};

const NUM_KEYS = Object.keys(PRESETS.clear).filter((k) => typeof PRESETS.clear[k] === 'number');
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();

/**
 * Weather state machine + all precipitation.
 *
 * Owned by SkySystem. Listens on `weather:set` and emits `thunder` with the
 * strike distance so the audio system can delay the clap correctly.
 */
export default class Weather {
  static id = 'weather';
  static label = 'Weather';
  static deps = ['sky', 'clouds', 'fog'];

  constructor() {
    this.state = 'clear';
    this.from = { ...PRESETS.clear };
    this.target = { ...PRESETS.clear };
    this.cur = { ...PRESETS.clear };
    this._blend = 1;
    this._wet = 0;
    this._appliedWet = -1;
    this._t = 0;
    this._flashT = null;
    this._flashSeq = [];
    this._thunderDone = true;
    this._strikeDist = 3000;
    this._nextStrike = 4;
    this._wind = new THREE.Vector3();
    this._groundY = 0;
  }

  async init(ctx) {
    const sky = ctx.get('sky');
    this.ctx = ctx;
    this.sky = sky;
    sky.weather = this;

    const quad = new THREE.PlaneGeometry(1, 1);
    this.rain = this._makeLayer(quad, RAIN_MAX, RAIN_VERT, RAIN_FRAG, {
      uBox: { value: new THREE.Vector3(95, 62, 95) },
      uBoxOffset: { value: new THREE.Vector3(0, 14, 0) },
      uWind: { value: new THREE.Vector3() },
      uFall: { value: 9.2 },
      uStreak: { value: 0.075 },
      uWidth: { value: 0.028 },
      uFadeR: { value: 46 },
      uColor: { value: new THREE.Color().setStyle('#c2cfe0') },
      uOpacity: { value: 0.45 },
    }, THREE.NormalBlending);

    this.snow = this._makeLayer(quad, SNOW_MAX, SNOW_VERT, SNOW_FRAG, {
      uBox: { value: new THREE.Vector3(120, 74, 120) },
      uBoxOffset: { value: new THREE.Vector3(0, 16, 0) },
      uWind: { value: new THREE.Vector3() },
      uFall: { value: 1.35 },
      uSize: { value: 0.075 },
      uFadeR: { value: 58 },
      uColor: { value: new THREE.Color().setStyle('#eef3f8') },
      uOpacity: { value: 0.9 },
    }, THREE.NormalBlending);

    this.splash = this._makeLayer(quad, SPLASH_MAX, SPLASH_VERT, SPLASH_FRAG, {
      uRadius: { value: 27 },
      uSize: { value: 0.30 },
      uColor: { value: new THREE.Color().setStyle('#b9cadd') },
      uOpacity: { value: 0.55 },
    }, THREE.AdditiveBlending);
    quad.dispose();

    // Lightning fill light. No shadows: a strike lasts three frames and a
    // shadow pass at that moment would cost more than the whole flash.
    // It stays `visible` forever — toggling a light's visibility changes the
    // light count and recompiles every material in the scene.
    this.bolt = new THREE.DirectionalLight(0xd6e4ff, 0);
    this.bolt.position.set(300, 900, -300);
    this.bolt.castShadow = false;
    ctx.scene.add(this.bolt, this.bolt.target);

    ctx.bus.on('weather:set', (w) => this.set(w));
    const initial = ctx.settings.weather || 'clear';
    this.set(initial);
    this._blend = 1;
    this._apply(ctx);
  }

  _makeLayer(quad, count, vert, frag, extraUniforms, blending) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = 0;

    const uniforms = {
      uCamPos: this.sky.u.uCamPos,
      uTime: { value: 0 },
      uGroundY: { value: 0 },
      ...extraUniforms,
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, uniforms,
      transparent: true, depthWrite: false, depthTest: true,
      blending, side: THREE.DoubleSide, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 12;
    mesh.visible = false;
    this.ctx.scene.add(mesh);
    return { mesh, geo, mat, uniforms, count };
  }

  /** Public API + `weather:set` handler. */
  set(name) {
    if (!PRESETS[name] || name === this.state) return;
    this.from = { ...this.cur };
    this.target = { ...PRESETS[name] };
    this.state = name;
    this._blend = 0;
    this.ctx.settings.weather = name;
    this.sky.markEnvDirty();
  }

  get rainIntensity() { return this.cur.rain; }
  get snowIntensity() { return this.cur.snow; }
  get wetness() { return this._wet; }

  update(dt, ctx) {
    this._t += dt;
    // The capture harness freezes the clock and steps frames by hand; a 20 s
    // ramp would never land, so a deterministic capture snaps instead.
    const deterministic = ctx.settings.timeScale === 0 || ctx.engine?._running === false;
    this._deterministic = deterministic;
    this._blend = deterministic ? 1 : Math.min(1, this._blend + dt / TRANSITION);
    const k = this._blend * this._blend * (3 - 2 * this._blend);

    for (const key of NUM_KEYS) {
      this.cur[key] = this.from[key] + (this.target[key] - this.from[key]) * k;
    }
    _c0.setStyle(this.from.fogTint);
    _c1.setStyle(this.target.fogTint);
    this.sky.fog.p.uFogTint.value.copy(_c0).lerp(_c1, k);

    this._updateLightning(dt, ctx);
    this._apply(ctx);
  }

  lateUpdate(dt, ctx) {
    const cam = ctx.camera;
    const city = ctx.get('city');
    const gy = city?.groundHeight ? city.groundHeight(cam.position.x, cam.position.z) : 0;
    this._groundY = Number.isFinite(gy) ? gy : 0;

    const t = this._t;
    const day = THREE.MathUtils.smoothstep(this.sky.sunDir.y, -0.16, 0.12);
    const lit = 0.35 + 2.6 * day + this.sky.u.uLightning.value * 3.0;

    // --- rain ---
    const r = this.cur.rain;
    this.rain.mesh.visible = r > 0.01;
    if (this.rain.mesh.visible) {
      this.rain.geo.instanceCount = Math.round(RAIN_MAX * Math.min(1, r * r * 1.15));
      this.rain.uniforms.uTime.value = t;
      this.rain.uniforms.uGroundY.value = this._groundY;
      this.rain.uniforms.uWind.value.set(this._wind.x, 0, this._wind.z);
      this.rain.uniforms.uFall.value = 8.0 + 4.0 * r;
      this.rain.uniforms.uOpacity.value = 0.20 + 0.34 * r;
      this.rain.uniforms.uColor.value.setRGB(0.62 * lit, 0.68 * lit, 0.80 * lit);
    }

    // --- snow ---
    const s = this.cur.snow;
    this.snow.mesh.visible = s > 0.01;
    if (this.snow.mesh.visible) {
      this.snow.geo.instanceCount = Math.round(SNOW_MAX * Math.min(1, s * 1.1));
      this.snow.uniforms.uTime.value = t;
      this.snow.uniforms.uGroundY.value = this._groundY;
      this.snow.uniforms.uWind.value.set(this._wind.x * 0.55, 0, this._wind.z * 0.55);
      this.snow.uniforms.uOpacity.value = 0.55 + 0.4 * s;
      const sl = 0.30 + 1.5 * day;
      this.snow.uniforms.uColor.value.setRGB(sl, sl * 1.01, sl * 1.05);
    }

    // --- ground ripples: rain on wet asphalt ---
    const sp = this.cur.rain * this._wet;
    this.splash.mesh.visible = sp > 0.02 && cam.position.y - this._groundY < 26;
    if (this.splash.mesh.visible) {
      this.splash.geo.instanceCount = Math.round(SPLASH_MAX * Math.min(1, sp));
      this.splash.uniforms.uTime.value = t;
      this.splash.uniforms.uGroundY.value = this._groundY;
      this.splash.uniforms.uOpacity.value = (0.14 + 0.5 * sp) * (0.35 + 1.6 * day);
    }
  }

  // ------------------------------------------------------------------------
  _apply(ctx) {
    const c = this.cur, sky = this.sky, cl = sky.clouds, fg = sky.fog;

    cl.p.uCoverage.value = c.coverage;
    cl.p.uCloudType.value = c.cloudType;
    cl.p.uDensity.value = c.density;
    cl.p.uExtinction.value = c.extinction;
    cl.p.uDetailStrength.value = c.detail;
    cl.p.uCloudBottom.value = c.cloudBottom;
    cl.p.uCloudTop.value = c.cloudTop;
    cl.p.uAnvil.value = c.anvil;
    cl.p.uAmbientScale.value = c.ambient;
    cl.p.uAerial.value = c.aerial;
    cl.p.uCloudShadow.value = c.cloudShadow;

    fg.p.uHazeSigma.value = c.hazeSigma;
    fg.p.uHazeH.value = c.hazeH;
    fg.p.uHazeY0.value = c.hazeY0;
    fg.p.uFogAlbedo.value = c.fogAlbedo;
    fg.p.uRayleighScale.value = c.rayleigh;
    fg.p.uShaftStrength.value = c.shaft;

    sky.u.uTurbidity.value = c.turbidity;
    sky.u.uHorizonHaze.value = c.horizonHaze;

    // Wind: direction is meteorological (degrees the wind blows *from*).
    const rad = (c.windDir + 180) * Math.PI / 180;
    const gust = 1 + 0.22 * Math.sin(this._t * 0.37) + 0.11 * Math.sin(this._t * 1.13);
    const spd = c.wind * gust;
    this._wind.set(Math.sin(rad) * spd, 0, -Math.cos(rad) * spd);
    cl._windVec.copy(this._wind).multiplyScalar(1.8);   // cloud deck runs faster

    // Wetness: soaks in over ~8 s, dries over ~50 s.
    //
    // The soak/dry ramp is wall-clock, and a deterministic capture only advances
    // ~30 frames, so without the snap a `rain` screenshot is taken on roads that
    // are still 87% dry. Snap for the same reason the preset blend snaps.
    const target = Math.max(c.wetness, this.cur.rain * 0.9);
    if (this._deterministic) {
      this._wet = target;
    } else {
      const rate = target > this._wet ? 1 / 8 : 1 / 50;
      const step = rate * (ctx.time.dt || 1 / 60);
      this._wet += THREE.MathUtils.clamp(target - this._wet, -step, step);
    }
    if (Math.abs(this._wet - this._appliedWet) > 0.004) {
      ctx.assets?.setWetness?.(this._wet);
      // The colour-grade pass reads assets.wetness; publish it alongside.
      if (ctx.assets) ctx.assets.wetness = this._wet;
      this._appliedWet = this._wet;
    }
  }

  _updateLightning(dt, ctx) {
    const rate = this.cur.lightning;
    if (rate > 0.002) {
      this._nextStrike -= dt;
      if (this._nextStrike <= 0) {
        this._strike();
        this._nextStrike = (0.5 + Math.random() * 2.2) / Math.max(rate, 0.01);
      }
    }

    if (this._flashT === null) {
      this.sky.u.uLightning.value = 0;
      this.sky.fog.p.uFlashScreen.value = 0;
      this.bolt.intensity = 0;
      return;
    }

    this._flashT += dt;
    let amp = 0;
    for (let i = 0; i < this._flashSeq.length; i++) {
      const f = this._flashSeq[i];
      if (this._flashT >= f.t) amp = Math.max(amp, f.a * Math.exp(-(this._flashT - f.t) * f.k));
    }
    // Far strikes light the cloud base but barely reach the street.
    const atten = 1 / (1 + this._strikeDist * this._strikeDist * 2.4e-7);
    this.sky.u.uLightning.value = amp * atten * 0.55;
    this.sky.fog.p.uFlashScreen.value = 0.55;
    this.bolt.intensity = amp * atten * 26;

    if (!this._thunderDone && this._flashT >= this._strikeDist / 343) {
      this._thunderDone = true;
      ctx.bus.emit('thunder', { distance: this._strikeDist });
    }
    if (this._flashT > Math.max(2.5, this._strikeDist / 343 + 0.5)) this._flashT = null;
  }

  _strike() {
    this._flashT = 0;
    this._thunderDone = false;
    this._strikeDist = 400 + Math.random() * 7000;
    const n = 2 + (Math.random() * 3 | 0);
    this._flashSeq.length = 0;
    for (let i = 0; i < n; i++) {
      this._flashSeq.push({
        t: i * (0.04 + Math.random() * 0.09),
        a: (i === 0 ? 1.0 : 0.35 + Math.random() * 0.5),
        k: 10 + Math.random() * 16,
      });
    }
    const a = Math.random() * Math.PI * 2;
    this.bolt.position.set(Math.cos(a) * 900, 1400, Math.sin(a) * 900);
    this.bolt.target.position.set(0, 0, 0);
    this.bolt.target.updateMatrixWorld();
  }

  dispose() {
    for (const l of [this.rain, this.snow, this.splash]) {
      if (!l) continue;
      this.ctx.scene.remove(l.mesh);
      l.geo.dispose(); l.mat.dispose();
    }
    if (this.bolt) this.ctx.scene.remove(this.bolt, this.bolt.target);
  }
}
