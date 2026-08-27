/**
 * AudioEngine.js — the audio system for BOSTON.
 *
 * Owns the AudioContext, the master mix bus, the spatialiser, the voice budget and
 * every event hookup. Everything downstream is procedurally synthesised: there is not
 * a single audio file in the project and nothing is ever downloaded.
 *
 * Browsers refuse to start an AudioContext before a user gesture, and *creating* one
 * early is itself enough to make Chrome log a warning, so the context is not created
 * at init. The game boots and runs silently until the first click or keypress, at
 * which point the whole graph is built and faded in. Every entry point is guarded so
 * a suspended or absent context degrades to silence rather than an exception.
 *
 * Master chain:
 *   engine / ambience / effects / ui / music  ->  master volume
 *     -> compressor (glue) -> limiter -> brickwall shaper -> analyser -> out
 *   with a parallel convolution reverb whose impulse response is generated
 *   procedurally and crossfaded between five spaces.
 */

import {
  kit, disposeKit, warmLazy, warmLazySync, clamp, lerp, setT, gainToDb,
  Voice3D, OneShotPool, dopplerRatio, IR_PRESETS, impulseResponse,
} from './Synth.js';
import { VehicleVoice, VEHICLE_AUDIO, EngineVoice } from './EngineSound.js';
import Ambience from './Ambience.js';
import Impacts from './Impacts.js';

/** Max simultaneous vehicle voices per quality preset. */
const VOICE_BUDGET = { low: 3, medium: 5, high: 8, ultra: 10 };
/** Beyond this a vehicle voice is destroyed outright, not just faded. */
const CULL_IN = 130, CULL_OUT = 165;
/** HRTF convolution is the expensive part of a PannerNode; only the closest get it. */
const HRTF_VOICES = 4;

const WEATHER = {
  clear:    { rain: 0.00, wind: 0.16 },
  overcast: { rain: 0.00, wind: 0.30 },
  fog:      { rain: 0.04, wind: 0.10 },
  rain:     { rain: 0.62, wind: 0.42 },
  storm:    { rain: 1.00, wind: 0.90 },
  snow:     { rain: 0.10, wind: 0.45 },
};

/** Property names a vehicle manager might expose its live list under. */
const VEHICLE_LIST_KEYS = ['active', 'all', 'list', 'vehicles', 'instances'];

/** district id -> tyre surface. Boston's old quarters are genuinely cobbled. */
const DISTRICT_SURFACE = {
  beaconHill: 'cobble', northEnd: 'cobble', park: 'grass', water: 'asphalt',
  financial: 'concrete', seaport: 'concrete', charlestown: 'asphalt',
};

export default class AudioEngine {
  static id = 'audio';
  static label = 'Audio';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    this.actx = null;
    this.enabled = true;
    this.started = false;
    this.voices = [];               // VehicleVoice[]
    this.voiceMap = new Map();      // Vehicle -> VehicleVoice
    this._frame = 0;
    this._offs = [];

    // Persistent, mutated-in-place state passed to Ambience. Never reallocated.
    this._env = {
      x: 0, y: 1.7, z: 0, district: 'backBay', timeOfDay: 9, weather: 'clear',
      rain: 0, wind: 0.16, inVehicle: 0, speed: 0, surface: 'asphalt',
    };
    this._targetRain = 0; this._targetWind = 0.16; this._targetCabin = 0;
    this.environment = 'street';
    this._envA = true;              // which convolver is live
    this._probeAt = 0;
    this._contactAt = 0;
    this._contactBudget = 0;

    // Listener bookkeeping (scalars only — this runs every frame).
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._lvx = 0; this._lvy = 0; this._lvz = 0;
    this._hasL = false;

    // Scratch for the priority pass.
    this._list = [];
    this._score = new Float64Array(512);
    this._order = new Int32Array(512);
    this._probeO = { x: 0, y: 0, z: 0 };
    this._probeD = { x: 0, y: 1, z: 0 };

    this._bindEvents(ctx);
    this._installGesture();

    window.__bostonAudio = {
      sys: this,
      start: (force) => this.start(force),
      state: () => this.state(),
      metrics: () => this.metrics(),
      spectrum: (which) => this.spectrum(which),
      selfTest: (o) => this.selfTest(o),
      demo: (type, seconds) => this.demo(type, seconds),
      setEnvironment: (n) => this.setEnvironment(n),
      setWeather: (w) => this._onWeather(w),
      play: (n, x, y, z, a) => this.play(n, x, y, z, a),
    };
  }

  /* ---------------------------------------------------------- lifecycle ---- */

  _installGesture() {
    const kick = () => {
      this._removeGesture();
      this.start(true);
    };
    this._gesture = kick;
    const opt = { capture: true, passive: true };
    for (const e of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(e, kick, opt);
    }
  }
  _removeGesture() {
    if (!this._gesture) return;
    const opt = { capture: true };
    for (const e of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(e, this._gesture, opt);
    }
    this._gesture = null;
  }

  /**
   * Create the context and build the graph. Safe to call repeatedly.
   * @param {boolean} force build even without a recorded user gesture (used by tests)
   * @returns {boolean} whether audio is now running
   */
  start(force = false) {
    if (this.started) { this._resume(); return true; }
    if (!this.enabled) return false;
    const activated = navigator.userActivation?.hasBeenActive ?? true;
    if (!force && !activated) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.actx = new AC({ latencyHint: 'interactive' });
    } catch {
      this.actx = null; this.enabled = false; return false;
    }
    this._build();
    this.started = true;
    this._resume();
    return true;
  }

  _resume() {
    const a = this.actx;
    if (!a || a.state !== 'suspended') return;
    // Never let a rejected resume() surface as an unhandled rejection.
    a.resume().catch(() => {});
  }

  _build() {
    const a = this.actx;
    const now = a.currentTime;
    this.k = kit(a);
    warmLazy(this.k);

    /* --- master chain, built back to front ---------------------------- */
    this.analyser = a.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.4;
    this._td = new Float32Array(this.analyser.fftSize);
    this._fd = new Float32Array(this.analyser.frequencyBinCount);

    // Guaranteed brickwall. The compressor pair does the musical work; this simply
    // makes it arithmetically impossible for the output to reach 0 dBFS.
    this.brickwall = a.createWaveShaper();
    this.brickwall.curve = AudioEngine._limiterCurve();
    this.brickwall.oversample = '2x';

    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;

    this.comp = a.createDynamicsCompressor();
    this.comp.threshold.value = -20; this.comp.knee.value = 8;
    this.comp.ratio.value = 3; this.comp.attack.value = 0.006;
    this.comp.release.value = 0.22;

    this.masterVol = a.createGain();
    this.masterVol.gain.value = 0;   // faded in below, so the first gesture is silent

    this.dryMix = a.createGain();
    this.dryMix.gain.value = 1;

    this.dryMix.connect(this.masterVol);
    this.masterVol.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.brickwall);
    this.brickwall.connect(this.analyser);
    this.analyser.connect(a.destination);

    /* --- categories ---------------------------------------------------- */
    this.cat = {};
    for (const name of ['engine', 'ambience', 'effects', 'ui', 'music']) {
      const g = a.createGain();
      g.gain.value = name === 'music' ? 0.0 : 1.0;
      g.connect(this.dryMix);
      this.cat[name] = g;
    }
    this.engineAnalyser = a.createAnalyser();
    this.engineAnalyser.fftSize = 8192;
    this.engineAnalyser.smoothingTimeConstant = 0.0;
    this.cat.engine.connect(this.engineAnalyser);

    // Ambience gets a duck stage and a cabin muffle stage in front of its category.
    this.ambDuck = a.createGain(); this.ambDuck.gain.value = 1;
    this.ambDuck.connect(this.cat.ambience);
    this.cabinLP = a.createBiquadFilter();
    this.cabinLP.type = 'lowpass'; this.cabinLP.frequency.value = 20000; this.cabinLP.Q.value = 0.6;
    this.cabinLP.connect(this.ambDuck);
    // Vehicles other than yours are also heard through the glass.
    this.worldCabinLP = a.createBiquadFilter();
    this.worldCabinLP.type = 'lowpass'; this.worldCabinLP.frequency.value = 20000;
    this.worldCabinLP.Q.value = 0.6;
    this.worldCabinLP.connect(this.cat.engine);

    /* --- reverb: two convolvers, crossfaded on environment change ------ */
    this.reverbIn = a.createGain(); this.reverbIn.gain.value = 1;
    this.revPre = a.createBiquadFilter();
    this.revPre.type = 'highpass'; this.revPre.frequency.value = 140; this.revPre.Q.value = 0.5;
    this.revDamp = a.createBiquadFilter();
    this.revDamp.type = 'lowpass'; this.revDamp.frequency.value = 7000; this.revDamp.Q.value = 0.6;
    this.convA = a.createConvolver(); this.convA.normalize = false;
    this.convB = a.createConvolver(); this.convB.normalize = false;
    this.gRevA = a.createGain(); this.gRevA.gain.value = 1;
    this.gRevB = a.createGain(); this.gRevB.gain.value = 0;
    this.revReturn = a.createGain(); this.revReturn.gain.value = 0.9;
    this.reverbIn.connect(this.revPre);
    this.revPre.connect(this.convA); this.revPre.connect(this.convB);
    this.convA.connect(this.gRevA); this.convB.connect(this.gRevB);
    this.gRevA.connect(this.revDamp); this.gRevB.connect(this.revDamp);
    this.revDamp.connect(this.revReturn);
    this.revReturn.connect(this.dryMix);
    // Start on a cheap short IR so the reverb is live immediately; warmLazy swaps in
    // the full set a few frames later.
    this.convA.buffer = impulseResponse(a, IR_PRESETS.street);
    this._irReady = false;

    /* --- shared services ------------------------------------------------ */
    this.pool = new OneShotPool(a, this.cat.effects, this.reverbIn, 24,
      { refDistance: 4, rolloff: 1.3, maxDistance: 600 });
    this.impacts = new Impacts(a, {
      pool: this.pool, dry: this.cat.effects, send: this.reverbIn, ui: this.cat.ui,
      duck: (amt, sec) => this.duck(amt, sec),
    }, { now });
    this.ambience = new Ambience(a, {
      dry: this.cabinLP, direct: this.ambDuck, send: this.reverbIn, pool: this.pool,
    }, { now });

    // Fade the whole mix in so the first gesture is not a click.
    setT(this.masterVol.gain, this.ctx.settings.masterVolume ?? 0.8, now, 0.35);
    this._lastVol = this.ctx.settings.masterVolume ?? 0.8;
  }

  /** Static, so the offline self-test can build the same brickwall. */
  static _limiterCurve(n = 2048, knee = 0.72) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a < knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
      c[i] = Math.sign(x) * Math.min(y, 0.985);
    }
    return c;
  }

  /* ------------------------------------------------------------- events ---- */

  _bindEvents(ctx) {
    const on = (e, fn) => this._offs.push(ctx.bus.on(e, fn));

    on('weather:set', (w) => this._onWeather(w));
    on('weather:rain', (v) => { this._targetRain = clamp(Number(v) || 0, 0, 1); });
    on('thunder', (p) => {
      if (!this.actx) return;
      const d = Number(p?.distance ?? p) || 1200;
      this.ambience?.thunder(d, this.actx.currentTime);
      if (d < 900) this.duck(0.4, 1.6);
    });

    on('player:enterVehicle', (v) => {
      this._targetCabin = 1;
      this._playerVehicle = v || null;
      this._rebindPlayerVoice(v, true);
    });
    on('player:exitVehicle', (v) => {
      this._targetCabin = 0;
      this._rebindPlayerVoice(v, false);
      this._playerVehicle = null;
    });

    on('vehicle:collision', (p) => {
      if (!this.actx || !p) return;
      const pt = p.point || p.vehicle?.position;
      const now = this.actx.currentTime;
      this.impacts.collision(p.impulse ?? 0, pt?.x ?? this._lx, pt?.y ?? this._ly,
        pt?.z ?? this._lz, now, { hard: p.hard ?? 0 });
    });

    on('physics:contact', (p) => this._onContact(p));

    on('key:down', (code) => {
      if (!this.actx) return;
      if (code === 'KeyH') this.hornPlayer();
    });

    on('ui:click', () => this.click());
    on('ui:hover', () => this.actx && this.impacts.hover(this.actx.currentTime));
    on('ui:notify', (kind) => this.actx &&
      this.impacts.notify(this.actx.currentTime, typeof kind === 'string' ? kind : 'info'));
    on('player:wanted', (lvl) => {
      if (!this.actx || !(lvl > 0)) return;
      this.impacts.notify(this.actx.currentTime, 'bad');
    });
    on('quality:changed', () => { this._budget = null; });
  }

  _onWeather(w) {
    const p = WEATHER[w] || WEATHER.clear;
    this._targetRain = p.rain;
    this._targetWind = p.wind;
    this._env.weather = w;
  }

  /**
   * Generic physics contacts give us collider handles only, so the position has to be
   * looked up through Rapier. Heavily rate-limited: hundreds of contacts a second are
   * normal in a city full of props, and none of them individually matter.
   */
  _onContact(p) {
    if (!this.actx || !p?.started) return;
    const now = this.actx.currentTime;
    if (now < this._contactAt) return;
    const phys = this.ctx.physics;
    if (!phys?.world?.getCollider) return;
    let col, body;
    try {
      col = phys.world.getCollider(p.h1);
      body = col?.parent?.();
      if (!body) { col = phys.world.getCollider(p.h2); body = col?.parent?.(); }
    } catch { return; }
    if (!body) return;
    // Only bodies that are actually moving are worth a sound.
    let sp = 0, t = null;
    try {
      const lv = body.linvel?.();
      if (lv) sp = Math.hypot(lv.x, lv.y, lv.z);
      t = body.translation?.();
    } catch { return; }
    if (!t || sp < 0.7) return;
    const d = Math.hypot(t.x - this._lx, t.y - this._ly, t.z - this._lz);
    if (d > 60) return;
    this._contactAt = now + 0.055;
    this.impacts.thump(clamp(sp / 9, 0.04, 0.7), t.x, t.y, t.z, now, 0.5);
  }

  /* ------------------------------------------------------- public API ---- */

  /** Category gain, 0..1+. name: engine|ambience|effects|ui|music */
  setCategory(name, v) {
    const g = this.cat?.[name];
    if (g) setT(g.gain, clamp(v, 0, 4), this.actx.currentTime, 0.05);
  }

  /** Momentarily pull the ambience and music down so an important sound lands. */
  duck(amount = 0.5, seconds = 0.8) {
    if (!this.actx) return;
    const now = this.actx.currentTime;
    const g = this.ambDuck.gain;
    const to = clamp(1 - amount * 0.72, 0.12, 1);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + 0.045);
    g.linearRampToValueAtTime(1, now + Math.max(seconds, 0.2));
  }

  /** Switch the convolution space. name: open|street|alley|tunnel|indoor */
  setEnvironment(name) {
    if (!this.actx || name === this.environment) return;
    const buf = this.k.lazy.ir?.[name];
    if (!buf) { this.environment = name; return; }   // retried once warmLazy lands
    const now = this.actx.currentTime;
    const inactive = this._envA ? this.convB : this.convA;
    const gIn = this._envA ? this.gRevB : this.gRevA;
    const gOut = this._envA ? this.gRevA : this.gRevB;
    inactive.buffer = buf;
    setT(gIn.gain, 1, now, 0.25);
    setT(gOut.gain, 0, now, 0.25);
    // Narrow spaces are darker and closer; open ones are brighter and further back.
    const damp = { open: 8500, street: 7000, alley: 4800, tunnel: 3200, indoor: 5200 };
    setT(this.revDamp.frequency, damp[name] ?? 7000, now, 0.4);
    setT(this.revReturn.gain,
      name === 'tunnel' ? 1.5 : name === 'alley' ? 1.25 : name === 'indoor' ? 0.55 : 0.9,
      now, 0.4);
    this._envA = !this._envA;
    this.environment = name;
  }

  /** Fire a named one-shot. Used by other systems through ctx.get('audio'). */
  play(name, x = this._lx, y = this._ly, z = this._lz, amount = 0.6) {
    if (!this.actx) return;
    const now = this.actx.currentTime;
    switch (name) {
      case 'click': this.impacts.click(now); break;
      case 'hover': this.impacts.hover(now); break;
      case 'notify': this.impacts.notify(now, 'info'); break;
      case 'notifyGood': this.impacts.notify(now, 'good'); break;
      case 'notifyBad': this.impacts.notify(now, 'bad'); break;
      case 'crash': this.impacts.collision(amount, x, y, z, now); break;
      case 'glass': this.impacts.glass(amount, x, y, z, now); break;
      case 'thump': this.impacts.thump(amount, x, y, z, now); break;
      case 'scrape': this.impacts.scrape(amount, x, y, z, now); break;
      case 'airbrake': this.impacts.airBrake(x, y, z, now, amount); break;
      case 'blowoff': this.impacts.blowoff(amount, x, y, z, now); break;
      case 'thunder': this.ambience.thunder(amount * 6000, now); break;
      case 'bell': this.ambience.bells(Math.round(amount * 12) || 1, now, this._env); break;
      default: break;
    }
  }

  click() { if (this.actx) this.impacts.click(this.actx.currentTime); }

  hornPlayer() {
    const v = this._playerVehicle || this.ctx.get('player')?.vehicle;
    const voice = v && this.voiceMap.get(v);
    if (voice) voice.horn(this.actx.currentTime);
  }

  /* -------------------------------------------------------------- frame ---- */

  update(dt, ctx) {
    const a = this.actx;
    if (!a || a.state === 'closed' || !this.started) return;
    if (a.state === 'suspended') { this._resume(); return; }
    const now = a.currentTime;
    this._frame++;

    /* --- master volume + IR readiness --------------------------------- */
    const mv = ctx.settings.masterVolume ?? 0.8;
    if (mv !== this._lastVol) { setT(this.masterVol.gain, clamp(mv, 0, 1), now, 0.05); this._lastVol = mv; }
    if (!this._irReady && this.k.lazy.ready) {
      this._irReady = true;
      const want = this.environment;
      this.environment = '';            // force setEnvironment to take
      this.setEnvironment(want || 'street');
    }

    /* --- listener ------------------------------------------------------ */
    const cam = ctx.camera;
    const e = cam.matrixWorld.elements;
    const lx = e[12], ly = e[13], lz = e[14];
    if (this._hasL && dt > 1e-4) {
      const k = 1 - Math.exp(-12 * dt);
      this._lvx += ((lx - this._lx) / dt - this._lvx) * k;
      this._lvy += ((ly - this._ly) / dt - this._lvy) * k;
      this._lvz += ((lz - this._lz) / dt - this._lvz) * k;
    }
    this._lx = lx; this._ly = ly; this._lz = lz; this._hasL = true;

    const L = a.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(lx, now, 0.02);
      L.positionY.setTargetAtTime(ly, now, 0.02);
      L.positionZ.setTargetAtTime(lz, now, 0.02);
      L.forwardX.setTargetAtTime(-e[8], now, 0.02);
      L.forwardY.setTargetAtTime(-e[9], now, 0.02);
      L.forwardZ.setTargetAtTime(-e[10], now, 0.02);
      L.upX.setTargetAtTime(e[4], now, 0.02);
      L.upY.setTargetAtTime(e[5], now, 0.02);
      L.upZ.setTargetAtTime(e[6], now, 0.02);
    } else {
      L.setPosition(lx, ly, lz);
      L.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }

    /* --- environment state --------------------------------------------- */
    const s = this._env;
    s.x = lx; s.y = ly; s.z = lz;
    s.timeOfDay = ctx.time.timeOfDay ?? 9;
    s.rain += (this._targetRain - s.rain) * (1 - Math.exp(-dt / 3.5));
    s.wind += (this._targetWind - s.wind) * (1 - Math.exp(-dt / 4.5));
    s.inVehicle += (this._targetCabin - s.inVehicle) * (1 - Math.exp(-dt / 0.22));

    if ((this._frame & 15) === 0) this._sampleDistrict(ctx, lx, lz);
    setT(this.cabinLP.frequency, lerp(20000, 760, s.inVehicle), now, 0.15);
    setT(this.worldCabinLP.frequency, lerp(20000, 1500, s.inVehicle), now, 0.15);

    if (now > this._probeAt) { this._probeAt = now + 0.4; this._probeEnvironment(ctx, s); }

    this.ambience.update(dt, now, s);
    this.impacts.update(dt, now);
    this.pool.update(now);

    /* --- vehicles ------------------------------------------------------- */
    this._updateVehicles(dt, now, ctx);
  }

  _sampleDistrict(ctx, x, z) {
    const city = ctx.get('city');
    if (!city?.districtAt) return;
    try {
      const d = city.districtAt(x, z);
      if (typeof d === 'string') {
        this._env.district = d;
        const base = DISTRICT_SURFACE[d] || 'asphalt';
        this._env.surface = (this._env.rain > 0.25 && base === 'asphalt') ? 'asphaltWet' : base;
      }
    } catch { /* city agent still landing — keep the last known district */ }
  }

  /**
   * Pick the reverb space by feeling out the geometry with five rays. Runs at 2.5 Hz,
   * never per frame: raycasts allocate inside Rapier and the answer changes slowly.
   */
  _probeEnvironment(ctx, s) {
    if (s.inVehicle > 0.5) { this.setEnvironment('indoor'); return; }
    const phys = ctx.physics;
    if (!phys?.raycast) {
      this.setEnvironment(s.district === 'water' || s.district === 'park' ? 'open' : 'street');
      return;
    }
    const o = this._probeO, d = this._probeD;
    o.x = s.x; o.y = s.y + 0.4; o.z = s.z;
    let ceiling = Infinity, walls = 0, nearest = Infinity;
    try {
      d.x = 0; d.y = 1; d.z = 0;
      const up = phys.raycast(o, d, 42);
      if (up) ceiling = up.distance;
      for (let i = 0; i < 4; i++) {
        const ang = i * Math.PI * 0.5;
        d.x = Math.cos(ang); d.y = 0; d.z = Math.sin(ang);
        const h = phys.raycast(o, d, 26);
        if (h) { walls++; if (h.distance < nearest) nearest = h.distance; }
      }
    } catch { /* physics not ready */ }

    let env;
    if (ceiling < 6 && walls >= 3) env = 'indoor';
    else if (ceiling < 14 && walls >= 2) env = 'tunnel';
    else if (walls >= 2 && nearest < 9) env = 'alley';
    else if (s.y > 55 || walls === 0 || s.district === 'water') env = 'open';
    else env = 'street';
    this.setEnvironment(env);
  }

  /**
   * Collect every live vehicle from whichever systems happen to exist. Written with
   * indexed loops and no closures because it runs every frame; `for..of` and inline
   * arrow functions would both allocate.
   */
  _gather(ctx) {
    const list = this._list;
    list.length = 0;
    const traffic = ctx.get('traffic');
    const tv = traffic?.vehicles;
    if (Array.isArray(tv)) {
      for (let i = 0; i < tv.length && list.length < 512; i++) if (tv[i]) list.push(tv[i]);
    }
    const veh = ctx.get('vehicles');
    if (veh) {
      for (let ki = 0; ki < VEHICLE_LIST_KEYS.length; ki++) {
        const arr = veh[VEHICLE_LIST_KEYS[ki]];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length && list.length < 512; i++) {
          const v = arr[i];
          if (v && list.indexOf(v) < 0) list.push(v);
        }
        break;
      }
    }
    const pv = this._playerVehicle || ctx.get('player')?.vehicle;
    if (pv && list.indexOf(pv) < 0 && list.length < 512) list.push(pv);
    return list;
  }

  _updateVehicles(dt, now, ctx) {
    const list = this._gather(ctx);
    const n = Math.min(list.length, 512);
    if (!this._budget) {
      this._budget = VOICE_BUDGET[ctx.settings.preset] ?? VOICE_BUDGET.high;
    }
    const budget = this._budget;
    const player = this._playerVehicle || ctx.get('player')?.vehicle || null;

    // Score every candidate, then partially select the top `budget`. O(n * budget)
    // with no allocation, which beats sorting for the sizes involved.
    const score = this._score, order = this._order;
    for (let i = 0; i < n; i++) {
      const v = list[i];
      const p = v.position || v.mesh?.position;
      let d2 = 1e12;
      if (p && Number.isFinite(p.x)) {
        const dx = p.x - this._lx, dy = p.y - this._ly, dz = p.z - this._lz;
        d2 = dx * dx + dy * dy + dz * dz;
      }
      let sc = 1000 / (1 + Math.sqrt(d2));
      if (v === player) sc += 1e6;
      if (v.sirenOn) sc += 800;
      score[i] = sc;
      order[i] = i;
    }
    const take = Math.min(budget, n);
    for (let i = 0; i < take; i++) {
      let best = i;
      for (let j = i + 1; j < n; j++) if (score[order[j]] > score[order[best]]) best = j;
      const t = order[i]; order[i] = order[best]; order[best] = t;
    }

    const stamp = this._frame;
    for (let i = 0; i < take; i++) {
      const v = list[order[i]];
      const p = v.position || v.mesh?.position;
      const dist = p && Number.isFinite(p.x)
        ? Math.hypot(p.x - this._lx, p.y - this._ly, p.z - this._lz) : 1e6;
      let voice = this.voiceMap.get(v);
      if (!voice) {
        if (dist > CULL_IN && v !== player) continue;
        voice = this._makeVoice(v, now, v === player, i < HRTF_VOICES);
        if (!voice) continue;
      }
      voice._stamp = stamp;
      voice.distance = dist;
      voice.read(v, dt);
      voice.setSurface(this._env.surface);
      voice.voice.setHRTF(i < HRTF_VOICES && dist < 70);

      const dop = dopplerRatio(voice.px, voice.py, voice.pz, voice.vx, voice.vy, voice.vz,
        this._lx, this._ly, this._lz, this._lvx, this._lvy, this._lvz);
      // Fade the tail of the budget out instead of cutting it dead.
      const fade = v === player ? 1 : clamp((CULL_OUT - dist) / 35, 0, 1);
      voice.update(v, dt, now, fade, dop);
      // Send more of a distant car to the reverb: that is what distance sounds like.
      voice.voice.setSend(clamp(0.10 + dist / 160, 0.1, 0.75), now, 0.3);

      if (voice.engine.blowoffPending > 0) {
        this.impacts.blowoff(voice.engine.blowoffPending, voice.px, voice.py, voice.pz, now);
        voice.engine.blowoffPending = 0;
      }
    }

    // Retire anything that missed this frame's cut.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i];
      if (voice._stamp === stamp && voice.distance < CULL_OUT) continue;
      this.voiceMap.delete(voice.vehicle);
      voice.dispose();
      this.voices.splice(i, 1);
    }
  }

  _makeVoice(v, now, isPlayer, hrtf) {
    const type = VEHICLE_AUDIO[v.type] ? v.type : 'sedan';
    let voice;
    try {
      voice = new VehicleVoice(this.actx, isPlayer ? this.cat.engine : this.worldCabinLP,
        this.reverbIn, type, { now, tap: this.voices.length, hrtf, hifi: isPlayer });
    } catch (err) {
      console.warn('[audio] could not build a vehicle voice:', err?.message || err);
      return null;
    }
    voice.vehicle = v;
    voice.isPlayer = isPlayer;
    voice._stamp = this._frame;
    this.voices.push(voice);
    this.voiceMap.set(v, voice);
    return voice;
  }

  /** Your own car bypasses the "heard through the windscreen" filter. */
  _rebindPlayerVoice(v, isPlayer) {
    const voice = v && this.voiceMap.get(v);
    if (!voice || !this.actx) return;
    const from = isPlayer ? this.worldCabinLP : this.cat.engine;
    const to = isPlayer ? this.cat.engine : this.worldCabinLP;
    try { voice.voice.panner.disconnect(from); } catch { /* was not connected */ }
    voice.voice.panner.connect(to);
    voice.isPlayer = isPlayer;
  }

  /* ------------------------------------------------------- introspection ---- */

  state() {
    return {
      started: this.started,
      contextState: this.actx?.state ?? 'none',
      sampleRate: this.actx?.sampleRate ?? 0,
      environment: this.environment,
      district: this._env.district,
      rain: +this._env.rain.toFixed(3),
      wind: +this._env.wind.toFixed(3),
      inVehicle: +this._env.inVehicle.toFixed(2),
      surface: this._env.surface,
      vehicleVoices: this.voices.length,
      voiceBudget: this._budget ?? 0,
      oneShotsActive: this.pool?.activeCount ?? 0,
      irReady: !!this._irReady,
      masterVolume: this._lastVol ?? 0,
      nodes: this.nodeEstimate(),
    };
  }

  /** Rough live node count — Web Audio exposes none, so we account for our own. */
  nodeEstimate() {
    let n = 34;                                   // master + reverb + buses
    n += (this.pool?.size ?? 0) * 3;
    n += 48;                                      // ambience beds
    n += 12;                                      // impacts scrape voice + spares
    for (const v of this.voices) {
      n += v.engine.nodes.length + v.tyres.nodes.length + 3;
      if (v.siren) n += v.siren.nodes.length;
    }
    n += (this.pool?.activeCount ?? 0) * 4;
    return n;
  }

  /** Peak / RMS of the final output, post-limiter. */
  metrics() {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this._td);
    let peak = 0, sum = 0;
    for (let i = 0; i < this._td.length; i++) {
      const v = this._td[i], a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._td.length);
    return {
      peak: +peak.toFixed(5), peakDb: +gainToDb(peak).toFixed(2),
      rms: +rms.toFixed(5), rmsDb: +gainToDb(rms).toFixed(2),
      clipping: peak >= 1.0,
      reduction: +(this.limiter.reduction ?? 0).toFixed(2),
    };
  }

  /**
   * Live spectrum. `which` = 'master' | 'engine'. Returns the strongest bins so a
   * caller (or an automation agent) can check what the mix is actually doing.
   */
  spectrum(which = 'engine', topN = 12) {
    const an = which === 'engine' ? this.engineAnalyser : this.analyser;
    if (!an) return null;
    const bins = an.frequencyBinCount;
    const data = new Float32Array(bins);
    an.getFloatFrequencyData(data);
    const binHz = this.actx.sampleRate / an.fftSize;
    const peaks = [];
    for (let i = 2; i < bins - 1; i++) {
      if (data[i] > data[i - 1] && data[i] >= data[i + 1] && data[i] > -95) {
        peaks.push({ hz: +(i * binHz).toFixed(1), db: +data[i].toFixed(1) });
      }
    }
    peaks.sort((a, b) => b.db - a.db);
    return { binHz: +binHz.toFixed(3), peaks: peaks.slice(0, topN) };
  }

  /**
   * Drive a detached engine voice through an RPM sweep in front of the listener, so a
   * human can hear a given vehicle type without the vehicle agent having landed.
   */
  demo(type = 'sports', seconds = 6) {
    if (!this.actx) return false;
    const now = this.actx.currentTime;
    const cfg = VEHICLE_AUDIO[type] || VEHICLE_AUDIO.sedan;
    const v = new VehicleVoice(this.actx, this.cat.engine, this.reverbIn, type,
      { now, tap: 3, hrtf: true, hifi: true });
    v.voice.setPosition(this._lx + 2, this._ly, this._lz - 4, now);
    v.voice.setGain(1, now, 0.05);
    const steps = Math.floor(seconds / 0.05);
    for (let i = 0; i < steps; i++) {
      const t = now + i * 0.05;
      const u = i / steps;
      const gear = 1 + Math.floor(u * 4);
      const local = (u * 4) % 1;
      const rpm = cfg.idle + (cfg.redline - cfg.idle) * (0.25 + 0.75 * local);
      v.engine.update(rpm, u < 0.85 ? 0.95 : 0, gear, 0.05, t);
      v.tyres.update(u * 45, 0, 1, t);
    }
    setTimeout(() => v.dispose(), (seconds + 1) * 1000);
    return true;
  }

  /* ============================================================ self test ==== */

  /**
   * Analytical verification. Renders the real graph builders into OfflineAudioContexts
   * and measures the result with an FFT, because "it sounds right" is not something an
   * automated agent can claim. Everything here is deterministic.
   */
  async selfTest(opt = {}) {
    const out = { ok: true, tests: {} };
    const add = (name, r) => { out.tests[name] = r; if (!r.pass) out.ok = false; };
    try {
      add('engineFundamentalTracksRpm', await this._testEngineSweep(opt.type || 'sports'));
      add('gearChangeDiscontinuity', await this._testGearChange());
      add('rainSpectrum', await this._testRain());
      add('noClipping', await this._testHeadroom());
      add('panningFollowsPosition', await this._testPanning());
    } catch (err) {
      out.ok = false;
      out.error = String(err?.stack || err);
    }
    if (this.analyser) out.live = { state: this.state(), metrics: this.metrics() };
    return out;
  }

  static async _render(seconds, build, sr = 48000) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OC(2, Math.ceil(seconds * sr), sr);
    const k = kit(oc);
    build(oc, oc.destination, k);
    const buf = await oc.startRendering();
    disposeKit(oc);
    return buf;
  }

  /** In-place radix-2 FFT. */
  static _fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const ar = re[i + j], ai = im[i + j];
          const br = re[i + j + half], bi = im[i + j + half];
          const vr = br * cr - bi * ci, vi = br * ci + bi * cr;
          re[i + j] = ar + vr; im[i + j] = ai + vi;
          re[i + j + half] = ar - vr; im[i + j + half] = ai - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /** Hann-windowed magnitude spectrum of `size` samples starting at `off`. */
  static _mag(data, off, size) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      re[i] = (data[off + i] || 0) * w;
    }
    AudioEngine._fft(re, im);
    const half = size >> 1;
    const mag = new Float64Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  /** Strongest bin in [lo,hi] Hz with parabolic sub-bin interpolation. */
  static _peak(mag, binHz, lo, hi) {
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.min(mag.length - 2, Math.ceil(hi / binHz));
    let bi = a, bv = -1;
    for (let i = a; i <= b; i++) if (mag[i] > bv) { bv = mag[i]; bi = i; }
    const l = Math.log(mag[bi - 1] + 1e-12), c = Math.log(mag[bi] + 1e-12),
      r = Math.log(mag[bi + 1] + 1e-12);
    const den = l - 2 * c + r;
    const d = den !== 0 ? 0.5 * (l - r) / den : 0;
    return { hz: (bi + clamp(d, -0.5, 0.5)) * binHz, mag: bv, bin: bi };
  }

  /**
   * (a) The engine's fundamental must follow RPM.
   * Drives a real EngineVoice through an eight-step RPM sweep, then measures the
   * spectral peak in the band around the dominant engine order at each step and
   * checks that it lands on rpm * cyl / 120 to within 2%.
   */
  async _testEngineSweep(type = 'sports') {
    const cfg = VEHICLE_AUDIO[type];
    const STEPS = 8, SEG = 1.0, SR = 48000, FFT = 32768;
    const rpms = [];
    for (let i = 0; i < STEPS; i++) {
      rpms.push(Math.round(cfg.idle + (cfg.redline - cfg.idle) * (i / (STEPS - 1)) * 0.92));
    }
    const buf = await AudioEngine._render(STEPS * SEG + 0.2, (oc, dest) => {
      const g = oc.createGain(); g.gain.value = 0.6; g.connect(dest);
      const v = new EngineVoice(oc, g, cfg, { tap: 0, now: 0 });
      v.setGain(1, 0, 0.01);
      for (let i = 0; i < STEPS; i++) {
        // Constant gear and load: this test isolates pitch tracking.
        v.update(rpms[i], 0.75, 3, SEG, i * SEG);
      }
    }, SR);
    const d = buf.getChannelData(0);
    const binHz = SR / FFT;
    const rows = [];
    let worst = 0, worstGrid = 0, monotonic = true, lastHz = 0;
    for (let i = 0; i < STEPS; i++) {
      // Analyse the tail of each segment, after setTargetAtTime has converged.
      const off = Math.floor((i * SEG + SEG - FFT / SR - 0.02) * SR);
      const mag = AudioEngine._mag(d, off, FFT);
      const expect = rpms[i] * cfg.cyl / 120;      // dominant order = cylinders / 2
      // Search window deliberately narrower than the half-order spacing (+/-12.5%)
      // so a neighbouring order can never be mistaken for the one under test.
      const p = AudioEngine._peak(mag, binHz, expect * 0.90, expect * 1.10);
      const err = Math.abs(p.hz - expect) / expect;
      if (err > worst) worst = err;
      if (p.hz <= lastHz) monotonic = false;
      lastHz = p.hz;
      // Independent check: wherever the *global* peak lands, it must sit on the
      // half-order grid k * rpm/120. That proves the whole stack tracks, not just
      // the bin we went looking in.
      const gp = AudioEngine._peak(mag, binHz, 30, 6000);
      const kf = gp.hz / (rpms[i] / 120);
      const gridErr = Math.abs(kf - Math.round(kf)) / Math.max(Math.round(kf), 1);
      if (gridErr > worstGrid) worstGrid = gridErr;
      rows.push({
        rpm: rpms[i], expectHz: +expect.toFixed(2), measuredHz: +p.hz.toFixed(2),
        errPct: +(err * 100).toFixed(2), globalPeakHz: +gp.hz.toFixed(1),
        globalPeakOrder: +(kf / 2).toFixed(2), gridErrPct: +(gridErr * 100).toFixed(2),
      });
    }
    return {
      pass: worst < 0.02 && monotonic && worstGrid < 0.03,
      type, dominantOrder: cfg.cyl / 2, binHz: +binHz.toFixed(3),
      worstErrPct: +(worst * 100).toFixed(2),
      worstGridErrPct: +(worstGrid * 100).toFixed(2), monotonic, rows,
      note: 'measured = spectral peak near order cyl/2; expected = rpm*cyl/120 Hz; '
        + 'gridErr = distance of the global peak from the nearest half-order of rpm',
    };
  }

  /**
   * (b) A gear change must produce a real discontinuity — a level dip and a *glide*
   * in pitch, not a teleport.
   */
  async _testGearChange() {
    const cfg = VEHICLE_AUDIO.sports;
    const SR = 48000, SEG = 0.02, TOTAL = 2.4;
    const SHIFT_T = 1.2, RPM_HI = 6600, RPM_LO = 4100;
    const buf = await AudioEngine._render(TOTAL, (oc, dest) => {
      const g = oc.createGain(); g.gain.value = 0.6; g.connect(dest);
      const v = new EngineVoice(oc, g, cfg, { tap: 0, now: 0 });
      v.setGain(1, 0, 0.01);
      const steps = Math.floor(TOTAL / SEG);
      for (let i = 0; i < steps; i++) {
        const t = i * SEG;
        const before = t < SHIFT_T;
        const rpm = before ? lerp(3600, RPM_HI, t / SHIFT_T)
          : lerp(RPM_LO, RPM_LO + 1400, (t - SHIFT_T) / (TOTAL - SHIFT_T));
        v.update(rpm, before ? 0.95 : (t < SHIFT_T + 0.12 ? 0.0 : 0.9), before ? 3 : 4, SEG, t);
      }
    }, SR);
    const d = buf.getChannelData(0);

    // Level: RMS in 10 ms hops.
    const HOP = Math.floor(0.01 * SR);
    const hops = Math.floor(d.length / HOP);
    const rms = new Float64Array(hops);
    for (let h = 0; h < hops; h++) {
      let s = 0;
      for (let i = 0; i < HOP; i++) { const v = d[h * HOP + i]; s += v * v; }
      rms[h] = Math.sqrt(s / HOP);
    }
    const hAt = (t) => Math.floor(t / 0.01);
    let pre = 0;
    for (let h = hAt(SHIFT_T - 0.18); h < hAt(SHIFT_T - 0.02); h++) pre = Math.max(pre, rms[h]);
    let dip = Infinity;
    for (let h = hAt(SHIFT_T); h < hAt(SHIFT_T + 0.14); h++) dip = Math.min(dip, rms[h]);
    const dipDb = gainToDb(dip / Math.max(pre, 1e-9));

    // Pitch: track the dominant order through the shift with a short (43 ms) window,
    // short enough that a hypothetical pitch teleport would resolve within one window.
    const FFT = 2048, binHz = SR / FFT, winSec = FFT / SR;
    const trackAt = (t) => {
      const off = Math.max(0, Math.min(d.length - FFT, Math.floor(t * SR) - (FFT >> 1)));
      const mag = AudioEngine._mag(d, off, FFT);
      return AudioEngine._peak(mag, binHz, 150, 640).hz;
    };
    const fBefore = trackAt(SHIFT_T - 0.10);
    const fAfter = trackAt(SHIFT_T + 0.42);
    const expectRatio = RPM_LO / RPM_HI;
    const gotRatio = fAfter / Math.max(fBefore, 1e-6);

    // How long does the pitch spend in transit? A teleport cannot take longer than one
    // analysis window (43 ms); the scheduled glide takes ~3-5x that.
    const span = fBefore - fAfter;
    const hiMark = fAfter + span * 0.9, loMark = fAfter + span * 0.1;
    let tLeave = NaN, tArrive = NaN;
    const traj = [];
    for (let t = SHIFT_T - 0.08; t <= SHIFT_T + 0.45; t += 0.008) {
      const f = trackAt(t);
      traj.push(+f.toFixed(1));
      if (f > hiMark) tLeave = t;
      if (Number.isNaN(tArrive) && !Number.isNaN(tLeave) && f < loMark) tArrive = t;
    }
    const transitionMs = (tArrive - tLeave) * 1000;
    return {
      pass: dipDb < -3.5 && Math.abs(gotRatio - expectRatio) < 0.10
        && transitionMs > winSec * 1000 * 1.8 && transitionMs < 600,
      dipDb: +dipDb.toFixed(2),
      pitchBeforeHz: +fBefore.toFixed(1), pitchAfterHz: +fAfter.toFixed(1),
      ratioExpected: +expectRatio.toFixed(3), ratioMeasured: +gotRatio.toFixed(3),
      transitionMs: +transitionMs.toFixed(1), analysisWindowMs: +(winSec * 1000).toFixed(1),
      trajectoryHz: traj,
      note: 'level dip proves the torque interrupt; a transition several analysis '
        + 'windows long proves a glide rather than a pitch teleport',
    };
  }

  /** (c) The rain bed must have a plausible, broadband, droplet-bearing spectrum. */
  async _testRain() {
    const SR = 48000;
    const buf = await AudioEngine._render(2.2, (oc, dest, k) => {
      warmLazySync(k);
      const bus = oc.createGain(); bus.gain.value = 1; bus.connect(dest);
      const amb = new Ambience(oc, { dry: bus, direct: bus, send: null, pool: null }, { now: 0 });
      amb.tryAttachBuffers(0);
      const s = { x: 0, y: 1.7, z: 0, district: 'backBay', timeOfDay: 14, weather: 'rain',
        rain: 0.9, wind: 0.5, inVehicle: 0, speed: 0, surface: 'asphaltWet' };
      for (let i = 0; i < 40; i++) amb.update(0.05, i * 0.05, s);
      // Silence everything except the weather so the measurement is unambiguous.
      amb.soloRain(0);
    }, SR);
    const d = buf.getChannelData(0);
    const FFT = 16384, binHz = SR / FFT;
    const mag = AudioEngine._mag(d, Math.floor(1.0 * SR), FFT);
    const centres = [125, 250, 500, 1000, 2000, 4000, 8000];
    const bands = {};
    let total = 0, cenNum = 0, cenDen = 0, peakDb = -Infinity;
    for (const c of centres) {
      const lo = Math.floor((c / Math.SQRT2) / binHz), hi = Math.ceil((c * Math.SQRT2) / binHz);
      let e = 0;
      for (let i = lo; i <= hi && i < mag.length; i++) e += mag[i] * mag[i];
      const db = 10 * Math.log10(e + 1e-20);
      bands[c] = +db.toFixed(1);
      if (db > peakDb) peakDb = db;
      total += e;
    }
    for (let i = 1; i < mag.length; i++) {
      const f = i * binHz;
      if (f > 16000) break;
      cenNum += f * mag[i]; cenDen += mag[i];
    }
    const centroid = cenNum / Math.max(cenDen, 1e-12);
    const highDb = bands[4000], topDb = bands[8000];
    const allPresent = centres.every(c => bands[c] > peakDb - 60);
    // Droplets put real energy above 4 kHz; a plain lowpassed noise bed would not.
    const dropletsAudible = highDb > peakDb - 26 && topDb > peakDb - 38;
    const tilted = bands[8000] < bands[500];
    return {
      pass: allPresent && dropletsAudible && tilted && centroid > 500 && centroid < 6500,
      bandsDb: bands, peakBandDb: +peakDb.toFixed(1),
      centroidHz: +centroid.toFixed(0), allBandsPresent: allPresent,
      dropletsAudible, tiltedDownward: tilted,
      note: 'filtered-noise bed plus droplet transients: broadband, tilted down, with live HF',
    };
  }

  /** (d) The master chain must not clip, even under a deliberately abusive mix. */
  async _testHeadroom() {
    const SR = 48000;
    const buf = await AudioEngine._render(2.6, (oc, dest, k) => {
      warmLazySync(k);
      // Rebuild the shipping master chain exactly.
      const analyserless = oc.createGain();
      const brick = oc.createWaveShaper();
      brick.curve = AudioEngine._limiterCurve(); brick.oversample = '2x';
      const lim = oc.createDynamicsCompressor();
      lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = 0.06;
      const comp = oc.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 3;
      comp.attack.value = 0.006; comp.release.value = 0.22;
      const master = oc.createGain(); master.gain.value = 1.0;   // worst case: full volume
      analyserless.connect(master); master.connect(comp); comp.connect(lim);
      lim.connect(brick); brick.connect(dest);

      const rev = oc.createGain(); rev.gain.value = 1;
      const conv = oc.createConvolver(); conv.normalize = false;
      conv.buffer = impulseResponse(oc, IR_PRESETS.tunnel);
      const ret = oc.createGain(); ret.gain.value = 1.5;
      rev.connect(conv); conv.connect(ret); ret.connect(analyserless);

      const pool = new OneShotPool(oc, analyserless, rev, 24);
      const imp = new Impacts(oc, { pool, dry: analyserless, send: rev, ui: analyserless },
        { now: 0 });

      // Eight vehicles at full noise, all on top of the listener.
      const types = ['sports', 'police', 'truck', 'bus', 'van', 'taxi', 'sedan', 'pickup'];
      for (let i = 0; i < types.length; i++) {
        const v = new VehicleVoice(oc, analyserless, rev, types[i], { now: 0, tap: i });
        v.voice.setPosition(i - 4, 0, -2, 0);
        v.voice.setGain(1, 0, 0.01);
        const cfg = VEHICLE_AUDIO[types[i]];
        // Large dt so the turbo spool integrator reaches its ceiling in a few calls.
        for (let s = 0; s < 14; s++) {
          const t = s * 0.04;
          v.engine.update(cfg.redline * 0.92, 1.0, 3, 0.25, t);
          v.tyres.update(38, 1.0, 1, t);
        }
        v.ensureSiren(0).set(true, 0.3, 0);
      }
      // Weather at maximum, on top of everything.
      const amb = new Ambience(oc, { dry: analyserless, direct: analyserless, send: rev,
        pool }, { now: 0 });
      amb.tryAttachBuffers(0);
      const st = { x: 0, y: 1.7, z: 0, district: 'financial', timeOfDay: 17.5,
        weather: 'storm', rain: 1, wind: 1, inVehicle: 0, speed: 0, surface: 'asphaltWet' };
      for (let i = 0; i < 50; i++) amb.update(0.05, i * 0.05, st);
      amb.thunder(120, 0.1);
      // A pile-up.
      for (let i = 0; i < 8; i++) imp.collision(90000, i - 4, 0.6, -1.5, 0.35 + i * 0.09);
    }, SR);

    let peak = 0, sum = 0, nClip = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        if (a >= 1.0) nClip++;
        sum += d[i] * d[i];
      }
    }
    const rms = Math.sqrt(sum / (buf.length * buf.numberOfChannels));
    return {
      pass: peak < 1.0 && nClip === 0,
      peak: +peak.toFixed(5), peakDbFS: +gainToDb(peak).toFixed(2),
      rmsDbFS: +gainToDb(rms).toFixed(2), clippedSamples: nClip,
      note: '8 vehicles at redline + sirens + storm + thunder + an 8-car pile-up, master at 1.0',
    };
  }

  /** (e) Panning must actually follow the source position. */
  async _testPanning() {
    const SR = 48000, DUR = 2.0;
    const run = async (hrtf) => {
      const buf = await AudioEngine._render(DUR, (oc, dest) => {
        const v = new Voice3D(oc, dest, null, { hrtf, refDistance: 6, rolloff: 0.4,
          maxDistance: 200, gain: 0.5 });
        const o = oc.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = 420;
        o.connect(v.input); o.start(0);
        const p = v.panner;
        p.positionY.setValueAtTime(0, 0);
        p.positionZ.setValueAtTime(-3, 0);
        p.positionX.setValueAtTime(-25, 0);
        p.positionX.linearRampToValueAtTime(25, DUR);
      }, SR);
      const l = buf.getChannelData(0), r = buf.getChannelData(1);
      const win = (from, to) => {
        let sl = 0, sr = 0;
        const a = Math.floor(from * SR), b = Math.floor(to * SR);
        for (let i = a; i < b; i++) { sl += l[i] * l[i]; sr += r[i] * r[i]; }
        return gainToDb(Math.sqrt(sl / (b - a))) - gainToDb(Math.sqrt(sr / (b - a)));
      };
      return { startLminusRdb: +win(0.05, 0.35).toFixed(2),
               midLminusRdb: +win(0.9, 1.1).toFixed(2),
               endLminusRdb: +win(1.65, 1.95).toFixed(2) };
    };
    const eq = await run(false);
    const hr = await run(true);
    const pass = eq.startLminusRdb > 3 && eq.endLminusRdb < -3
      && hr.startLminusRdb > 0.5 && hr.endLminusRdb < -0.5
      && Math.abs(eq.midLminusRdb) < 2;
    return {
      pass, equalpower: eq, hrtf: hr,
      note: 'source sweeps x -25 -> +25 m in front of the listener; L-R balance must invert',
    };
  }

  /* ------------------------------------------------------------ teardown ---- */

  dispose() {
    this._removeGesture();
    for (const off of this._offs) off();
    this._offs.length = 0;
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    this.voiceMap.clear();
    this.ambience?.dispose();
    this.impacts?.dispose();
    this.pool?.dispose();
    if (this.actx) {
      disposeKit(this.actx);
      try { this.actx.close(); } catch { /* already closed */ }
    }
    this.actx = null;
    this.started = false;
    if (window.__bostonAudio?.sys === this) delete window.__bostonAudio;
  }
}
