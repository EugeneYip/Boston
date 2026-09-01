/**
 * EngineSound.js — everything that is bolted to a moving vehicle:
 * engine, exhaust, induction, turbo, tyres, siren and horn.
 *
 * The engine is not a looped sample pitched up and down. It is synthesised from the
 * physics: `vehicle.rpm` drives a band-limited oscillator whose harmonic content is an
 * *engine order table*, i.e. the amplitude of every multiple of half crank speed. A
 * cross-plane V8 fires unevenly across its two banks and therefore has a lot of energy
 * at the 1.5/2.5/3.5 half-orders — that is precisely why it burbles and a flat-plane
 * Ferrari V8, which is nearly all even orders, screams instead. Model the orders and
 * the character falls out for free.
 *
 * Driving the oscillator at rpm/120 Hz (the 0.5th order) makes PeriodicWave harmonic
 * index k line up with engine order k/2, so the whole ~30-partial stack costs one
 * OscillatorNode and is anti-aliased by the browser.
 */

import {
  kit, noiseTap, pulseWave, periodicWaveFromOrders, clamp, approach, setT, Voice3D,
} from './Synth.js';

/* ------------------------------------------------------------ order tables ---- */
// [engine order, amplitude]. Order 2 = twice per crank revolution.

const ORDERS = {
  /** Gasoline inline-4. Dominant 2nd order, thin low end, buzzy top. */
  I4: [[0.5, 0.03], [1, 0.14], [1.5, 0.05], [2, 1.0], [2.5, 0.04], [3, 0.10],
       [3.5, 0.03], [4, 0.40], [5, 0.05], [6, 0.20], [7, 0.04], [8, 0.12],
       [10, 0.07], [12, 0.05], [14, 0.03]],
  /** 60-degree V6. Dominant 3rd, with a characteristic 1.5 rocking mode. */
  V6: [[0.5, 0.05], [1, 0.14], [1.5, 0.18], [2, 0.10], [2.5, 0.06], [3, 1.0],
       [4, 0.08], [4.5, 0.28], [6, 0.22], [7.5, 0.10], [9, 0.12], [10.5, 0.05],
       [12, 0.06]],
  /** Cross-plane V8: 4th order over a thick bed of half-orders. The American burble. */
  V8X: [[0.5, 0.20], [1, 0.32], [1.5, 0.28], [2, 0.42], [2.5, 0.26], [3, 0.33],
        [3.5, 0.27], [4, 1.0], [4.5, 0.16], [5, 0.20], [5.5, 0.12], [6, 0.28],
        [7, 0.12], [8, 0.24], [9, 0.08], [10, 0.12], [12, 0.08], [16, 0.05]],
  /** Flat-plane V8: even orders only. Hard, metallic, race-car wail. */
  V8F: [[1, 0.10], [2, 0.30], [3, 0.16], [4, 1.0], [5, 0.14], [6, 0.34],
        [8, 0.42], [10, 0.18], [12, 0.24], [16, 0.14], [20, 0.08], [24, 0.05]],
  /** Turbodiesel inline-6 (bus / truck). 3rd order plus a ladder of clatter. */
  I6D: [[0.5, 0.10], [1, 0.20], [1.5, 0.30], [2, 0.16], [3, 1.0], [4.5, 0.36],
        [6, 0.52], [7.5, 0.24], [9, 0.34], [10.5, 0.16], [12, 0.26], [15, 0.18],
        [18, 0.16], [21, 0.10], [24, 0.09], [27, 0.06]],
  /** Turbodiesel inline-4 (van). */
  I4D: [[0.5, 0.08], [1, 0.18], [1.5, 0.10], [2, 1.0], [3, 0.14], [4, 0.46],
        [6, 0.34], [8, 0.26], [10, 0.16], [12, 0.18], [14, 0.10], [16, 0.10],
        [20, 0.07], [24, 0.05]],
};

/**
 * Per-type character. `idle`/`redline` are only fallbacks — if the vehicle sim reports
 * its own rpm range we use that. `exhaustTone` is the Helmholtz-ish resonance of the
 * silencer, which is what actually makes a big V8 sound big.
 */
export const VEHICLE_AUDIO = {
  sedan:  { engine: 'I4',  cyl: 4, idle: 720, redline: 6300, vol: 0.80, exhaustTone: 210,
            turbo: 0.0,  diesel: 0, drive: 1.5, bright: 1.0 },
  suv:    { engine: 'V6',  cyl: 6, idle: 680, redline: 6000, vol: 0.90, exhaustTone: 170,
            turbo: 0.0,  diesel: 0, drive: 1.7, bright: 0.95 },
  taxi:   { engine: 'V6',  cyl: 6, idle: 630, redline: 5600, vol: 0.95, exhaustTone: 145,
            turbo: 0.0,  diesel: 0, drive: 2.3, bright: 0.8, rattle: 0.5 },
  police: { engine: 'V8X', cyl: 8, idle: 700, redline: 6200, vol: 1.10, exhaustTone: 118,
            turbo: 0.0,  diesel: 0, drive: 2.2, bright: 1.1, siren: true },
  sports: { engine: 'V8X', cyl: 8, idle: 820, redline: 7200, vol: 1.25, exhaustTone: 96,
            turbo: 0.0,  diesel: 0, drive: 3.4, bright: 1.35, blower: 0.30, lope: 1.0 },
  pickup: { engine: 'V8X', cyl: 8, idle: 640, redline: 5400, vol: 1.05, exhaustTone: 128,
            turbo: 0.0,  diesel: 0, drive: 1.9, bright: 0.9 },
  van:    { engine: 'I4D', cyl: 4, idle: 780, redline: 4200, vol: 0.95, exhaustTone: 155,
            turbo: 0.55, diesel: 0.7, drive: 2.0, bright: 0.85 },
  bus:    { engine: 'I6D', cyl: 6, idle: 560, redline: 2400, vol: 1.20, exhaustTone: 88,
            turbo: 0.5,  diesel: 1.0, drive: 2.4, bright: 0.7, airbrake: true },
  truck:  { engine: 'I6D', cyl: 6, idle: 520, redline: 2100, vol: 1.35, exhaustTone: 72,
            turbo: 0.8,  diesel: 0.9, drive: 2.6, bright: 0.65, airbrake: true, bighorn: true },
};
const DEFAULT_CFG = VEHICLE_AUDIO.sedan;

/** Boost the upper orders — the "loaded" wave the smooth one crossfades into. */
function harshen(list, k) {
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const [o, a] = list[i];
    out[i] = [o, a * (1 + k * Math.min(o, 20) / 6)];
  }
  return out;
}

function cachedWave(k, key, build) {
  let w = k.waves.get(key);
  if (!w) { w = build(); k.waves.set(key, w); }
  return w;
}

/* ================================================================ engine ==== */

export class EngineVoice {
  /**
   * @param {BaseAudioContext} actx
   * @param {AudioNode} dest voice output (usually a Voice3D input)
   * @param {object} cfg entry from VEHICLE_AUDIO
   * @param {{tap?:number, hifi?:boolean, now?:number}} opt
   */
  constructor(actx, dest, cfg, opt = {}) {
    this.actx = actx;
    this.cfg = cfg = Object.assign({}, DEFAULT_CFG, cfg);
    const k = this.k = kit(actx);
    const now = opt.now ?? actx.currentTime;
    const tap = opt.tap ?? 0;
    const hifi = !!opt.hifi;
    this.nodes = [];
    const keep = (n) => { this.nodes.push(n); return n; };
    // Edges from the kit's SHARED looping noise sources into this voice.
    //
    // `noiseTap()` is a selector, not a factory: it returns one of the seven
    // `k.noise[*]` sources that live for the whole AudioContext. `dispose()` walks
    // `this.nodes` and calls `n.disconnect()`, which severs only each node's OUTGOING
    // edges -- so without this the shared source kept a strong reference to every
    // retired filter and gain in the voice, still feeding it noise, for the life of the
    // context. Voices are created and retired continuously as cars cross the cull
    // radius, so this accumulated without bound in ordinary play.
    //
    // Record the pair and sever it with the DESTINATION argument, which removes only
    // this edge and leaves every other live voice on the same tap untouched. The shared
    // source is never stopped here: it belongs to the kit, not to any one voice.
    this._srcLinks = [];
    const tapTo = (src, dest) => { src.connect(dest); this._srcLinks.push([src, dest]); return dest; };

    const orders = ORDERS[cfg.engine] || ORDERS.I4;
    const waveSmooth = cachedWave(k, cfg.engine + '|s', () => periodicWaveFromOrders(actx, orders, { seed: 7 }));
    const waveHarsh = cachedWave(k, cfg.engine + '|h', () => periodicWaveFromOrders(actx, harshen(orders, cfg.bright ?? 1), { seed: 19 }));

    // --- summing point and tone stage -------------------------------------
    this.sum = keep(actx.createGain()); this.sum.gain.value = 0.32;
    this.preDrive = keep(actx.createGain()); this.preDrive.gain.value = 1;
    this.shaper = keep(actx.createWaveShaper());
    this.shaper.curve = k.curves.softLight;
    this.shaper.oversample = hifi ? '2x' : 'none';
    this.postDrive = keep(actx.createGain()); this.postDrive.gain.value = 1;

    this.tone = keep(actx.createBiquadFilter());
    this.tone.type = 'lowpass'; this.tone.frequency.value = 900; this.tone.Q.value = 0.8;
    this.resonance = keep(actx.createBiquadFilter());
    this.resonance.type = 'peaking';
    this.resonance.frequency.value = cfg.exhaustTone; this.resonance.Q.value = 1.6;
    this.resonance.gain.value = 6;
    this.dc = keep(actx.createBiquadFilter());
    this.dc.type = 'highpass'; this.dc.frequency.value = 34; this.dc.Q.value = 0.6;

    this.level = keep(actx.createGain()); this.level.gain.value = 0;
    this.shift = keep(actx.createGain()); this.shift.gain.value = 1;

    this.sum.connect(this.preDrive); this.preDrive.connect(this.shaper);
    this.shaper.connect(this.postDrive); this.postDrive.connect(this.tone);
    this.tone.connect(this.resonance); this.resonance.connect(this.dc);
    this.dc.connect(this.level); this.level.connect(this.shift);
    this.shift.connect(dest);

    // --- harmonic stack ---------------------------------------------------
    this.oscA = keep(actx.createOscillator());
    this.oscA.setPeriodicWave(waveSmooth);
    this.gA = keep(actx.createGain()); this.gA.gain.value = 0.6;
    this.oscA.connect(this.gA); this.gA.connect(this.sum);

    this.oscB = keep(actx.createOscillator());
    this.oscB.setPeriodicWave(waveHarsh);
    this.gB = keep(actx.createGain()); this.gB.gain.value = 0;
    this.oscB.connect(this.gB); this.gB.connect(this.sum);

    // Combustion is never perfectly periodic. A slow random wobble on the crank
    // frequency is the difference between "engine" and "sawtooth".
    this.jitLP = keep(actx.createBiquadFilter());
    this.jitLP.type = 'lowpass'; this.jitLP.frequency.value = 18;
    this.jitDepth = keep(actx.createGain()); this.jitDepth.gain.value = 0;
    tapTo(k.noise[6], this.jitLP); this.jitLP.connect(this.jitDepth);
    this.jitDepth.connect(this.oscA.frequency);
    this.jitDepth.connect(this.oscB.frequency);

    // --- exhaust chuff: noise amplitude-modulated at the firing rate --------
    this.fireMod = keep(actx.createOscillator());
    this.fireMod.setPeriodicWave(cachedWave(k, 'pulse12', () => pulseWave(actx, 12)));
    this.exBP = keep(actx.createBiquadFilter());
    this.exBP.type = 'bandpass'; this.exBP.frequency.value = 320; this.exBP.Q.value = 0.9;
    this.gEx = keep(actx.createGain()); this.gEx.gain.value = 0;
    this.exDepth = keep(actx.createGain()); this.exDepth.gain.value = 0.9;
    tapTo(noiseTap(k, tap), this.exBP);
    this.exBP.connect(this.gEx); this.gEx.connect(this.sum);
    this.fireMod.connect(this.exDepth); this.exDepth.connect(this.gEx.gain);

    // --- diesel injector clatter -------------------------------------------
    if (cfg.diesel > 0) {
      this.clBP = keep(actx.createBiquadFilter());
      this.clBP.type = 'bandpass'; this.clBP.frequency.value = 2200; this.clBP.Q.value = 1.1;
      this.gCl = keep(actx.createGain()); this.gCl.gain.value = 0;
      this.clMod = keep(actx.createOscillator());
      this.clMod.setPeriodicWave(cachedWave(k, 'pulse40', () => pulseWave(actx, 40)));
      this.clDepth = keep(actx.createGain()); this.clDepth.gain.value = 1.4;
      tapTo(noiseTap(k, tap + 1), this.clBP);
      this.clBP.connect(this.gCl); this.gCl.connect(this.sum);
      this.clMod.connect(this.clDepth); this.clDepth.connect(this.gCl.gain);
    }

    // --- induction (intake) roar -------------------------------------------
    this.inBP = keep(actx.createBiquadFilter());
    this.inBP.type = 'bandpass'; this.inBP.frequency.value = 700; this.inBP.Q.value = 1.1;
    this.gIn = keep(actx.createGain()); this.gIn.gain.value = 0;
    tapTo(noiseTap(k, tap, true), this.inBP);
    this.inBP.connect(this.gIn); this.gIn.connect(this.sum);

    // --- overrun burble: sparse exhaust pops off-throttle -------------------
    // Slow noise -> threshold curve -> gain param. Sparse random bursts whose rate
    // follows the firing rate, and not one line of per-frame JavaScript.
    this.popRate = keep(actx.createBiquadFilter());
    this.popRate.type = 'lowpass'; this.popRate.frequency.value = 20; this.popRate.Q.value = 1.4;
    this.popShape = keep(actx.createWaveShaper());
    this.popShape.curve = cfg.lope ? k.curves.popsRich : k.curves.pops;
    this.popDepth = keep(actx.createGain()); this.popDepth.gain.value = 0;
    this.popBP = keep(actx.createBiquadFilter());
    this.popBP.type = 'bandpass'; this.popBP.frequency.value = 190; this.popBP.Q.value = 2.2;
    this.gPop = keep(actx.createGain()); this.gPop.gain.value = 0;
    tapTo(k.noise[6], this.popRate);
    this.popRate.connect(this.popShape); this.popShape.connect(this.popDepth);
    this.popDepth.connect(this.gPop.gain);
    tapTo(noiseTap(k, tap + 2), this.popBP);
    this.popBP.connect(this.gPop); this.gPop.connect(this.sum);

    // --- turbo: intake-side, so it bypasses the exhaust tone stack ----------
    this.turboOut = keep(actx.createGain()); this.turboOut.gain.value = 0;
    this.turboOut.connect(this.level);
    if (cfg.turbo > 0) {
      this.turboOsc = keep(actx.createOscillator());
      this.turboOsc.type = 'triangle';
      this.turboOsc.frequency.value = 2000;
      this.gTurboOsc = keep(actx.createGain()); this.gTurboOsc.gain.value = 0.10;
      this.turboOsc.connect(this.gTurboOsc); this.gTurboOsc.connect(this.turboOut);
      this.turboBP = keep(actx.createBiquadFilter());
      this.turboBP.type = 'bandpass'; this.turboBP.frequency.value = 3400; this.turboBP.Q.value = 2.4;
      this.gTurboNoise = keep(actx.createGain()); this.gTurboNoise.gain.value = 0.5;
      tapTo(noiseTap(k, tap + 3), this.turboBP);
      this.turboBP.connect(this.gTurboNoise); this.gTurboNoise.connect(this.turboOut);
    }
    if (cfg.blower > 0) {
      // Roots blower whine: a near-pure tone at a fixed multiple of crank speed.
      this.blowerOsc = keep(actx.createOscillator());
      this.blowerOsc.type = 'sawtooth';
      this.blowerBP = keep(actx.createBiquadFilter());
      this.blowerBP.type = 'bandpass'; this.blowerBP.frequency.value = 2600; this.blowerBP.Q.value = 3;
      this.gBlower = keep(actx.createGain()); this.gBlower.gain.value = 0;
      this.blowerOsc.connect(this.blowerBP); this.blowerBP.connect(this.gBlower);
      // Straight to the output stage: the blower is intake-side, and routing it via
      // the turbo bus would make the two layers fight over the same gain.
      this.gBlower.connect(this.level);
    }

    for (const n of this.nodes) if (n.start) { try { n.start(now); } catch { /* re-init */ } }

    // --- state ------------------------------------------------------------
    this.rpm = cfg.idle;
    this.load = 0;
    this.spool = 0;
    this.gear = 1;
    this._shiftUntil = -1;
    this._slew = 0.035;
    this._gain = 1;
    this._doppler = 1;
    this._lastLoad = 0;
    this.blowoffPending = 0;    // AudioEngine drains this to fire a pooled one-shot
  }

  /** Master trim for this voice (distance/priority mixing lives in Voice3D). */
  setGain(g, now, tc = 0.06) { this._gain = g; setT(this.level.gain, g * this._lvl(), now, tc); }
  setDoppler(r) { this._doppler = r; }

  _lvl() {
    const cfg = this.cfg;
    const rev = clamp((this.rpm - cfg.idle) / (cfg.redline - cfg.idle), 0, 1.2);
    return cfg.vol * (0.34 + 0.66 * this.load) * (0.60 + 0.55 * rev);
  }

  /** Gear change: torque interrupt, then re-attack. Never a pitch teleport. */
  noteShift(now, up = true) {
    const g = this.shift.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(up ? 0.30 : 0.55, now + 0.028);   // clutch out
    g.linearRampToValueAtTime(1.0, now + (up ? 0.17 : 0.10));   // back on the throttle
    this._shiftUntil = now + 0.22;
    // Let the rpm glide through the change instead of stepping.
    this._slew = 0.055;
  }

  /**
   * Per-frame. Positional scalar args on purpose: this is called for every audible
   * vehicle every frame and must not allocate.
   * @param {number} rpm  crank speed
   * @param {number} load 0..1 throttle/torque demand
   * @param {number} gear current gear (used only to detect changes)
   * @param {number} dt   seconds
   * @param {number} now  audio clock time
   */
  update(rpm, load, gear, dt, now) {
    const cfg = this.cfg;
    if (!Number.isFinite(rpm)) rpm = cfg.idle;
    rpm = clamp(rpm, cfg.idle * 0.55, cfg.redline * 1.12);

    if (gear !== this.gear) {
      const up = gear > this.gear;
      this.gear = gear;
      if (Number.isFinite(gear)) this.noteShift(now, up);
    }
    if (now > this._shiftUntil && this._slew !== 0.035) this._slew = 0.035;

    this.rpm = rpm;
    this.load = load = clamp(load, 0, 1);
    const rev = clamp((rpm - cfg.idle) / (cfg.redline - cfg.idle), 0, 1.2);
    const coast = 1 - load;
    const dop = this._doppler;

    // Half-order fundamental. Everything pitched hangs off this.
    const fBase = (rpm / 120) * dop;
    const fFire = fBase * cfg.cyl;                 // cylinder firing rate

    setT(this.oscA.frequency, fBase, now, this._slew);
    setT(this.oscB.frequency, fBase, now, this._slew);
    setT(this.fireMod.frequency, fFire, now, this._slew);
    setT(this.jitDepth.gain, fBase * 0.075 * (1 - rev * 0.65) * (1 + (cfg.lope || 0) * 0.8), now, 0.1);

    // Smooth wave under load-free running, harsh wave as torque comes on.
    const harsh = clamp(load * 0.85 + rev * 0.30, 0, 1);
    setT(this.gA.gain, 0.70 * (1 - harsh * 0.75), now, 0.06);
    setT(this.gB.gain, 0.85 * harsh, now, 0.06);

    // Drive into the soft clipper rises with load: an engine on song is distorted.
    const drive = 1 + (cfg.drive - 1) * (0.25 + 0.75 * load) * (0.5 + 0.5 * rev);
    setT(this.preDrive.gain, drive, now, 0.08);
    setT(this.postDrive.gain, 1 / (0.7 + 0.55 * drive), now, 0.08);

    // Tone opens with revs and load — the "wail" as it comes on cam.
    const cutoff = clamp(240 + rev * (1100 + load * 4600) * (cfg.bright ?? 1) + load * 420,
      160, 15000);
    setT(this.tone.frequency, cutoff, now, 0.05);
    setT(this.resonance.gain, 4 + load * 7 + rev * 3, now, 0.08);
    setT(this.resonance.frequency, cfg.exhaustTone * (0.9 + rev * 0.25) * dop, now, 0.08);

    // Exhaust roughness: louder and brighter on throttle.
    setT(this.exBP.frequency, clamp(180 + rev * 900 + load * 700, 120, 6000), now, 0.06);
    setT(this.gEx.gain, (0.10 + 0.34 * load) * (0.5 + 0.6 * rev), now, 0.06);
    setT(this.exDepth.gain, 0.55 + 0.65 * load, now, 0.08);

    if (this.gCl) {
      // Diesel clatter is loudest at low rpm and light load — the classic idle rattle.
      const cl = cfg.diesel * (0.55 + 0.45 * load) * (1.15 - rev * 0.55);
      setT(this.gCl.gain, 0.05 * cl, now, 0.07);
      setT(this.clMod.frequency, fFire, now, this._slew);
      setT(this.clBP.frequency, clamp(1500 + rev * 2400, 800, 9000), now, 0.08);
      setT(this.clDepth.gain, 1.1 + 0.9 * cfg.diesel, now, 0.1);
    }

    // Induction: only present when the throttle is open.
    setT(this.inBP.frequency, clamp(280 + rev * 2100, 200, 9000), now, 0.05);
    setT(this.gIn.gain, 0.22 * load * (0.25 + 0.9 * rev), now, 0.05);

    // Overrun burble: closed throttle, engine still spinning, car still moving.
    const burble = coast * clamp((rev - 0.10) * 2.2, 0, 1) * (0.7 + 0.6 * (cfg.lope || 0));
    setT(this.popRate.frequency, clamp(fFire * 0.30, 2, 70), now, 0.1);
    setT(this.popDepth.gain, 1.5 * burble, now, 0.12);
    setT(this.popBP.frequency, clamp(130 + rev * 260, 90, 900), now, 0.1);
    setT(this.gPop.gain, 0, now, 0.2);   // sits at zero; the shaper opens it in bursts

    // Turbo. Spools faster than it decays, exactly like the real thing.
    if (cfg.turbo > 0) {
      const target = load * clamp((rev - 0.06) * 1.6, 0, 1);
      this.spool = approach(this.spool, target, target > this.spool ? 2.3 : 1.1, dt);
      const s = this.spool;
      setT(this.turboOsc.frequency, (1700 + 9200 * s) * dop, now, 0.09);
      setT(this.turboBP.frequency, clamp((2400 + 6000 * s) * dop, 400, 16000), now, 0.09);
      setT(this.turboOut.gain, cfg.turbo * (0.06 + 0.55 * s * s), now, 0.08);
      // Lifting off a spooled turbo dumps its pressure: blow-off valve.
      if (this._lastLoad - load > 0.35 && s > 0.32) this.blowoffPending = s;
      this._lastLoad = load;
    }
    if (this.gBlower) {
      const bf = clamp(rpm * 0.55 * dop, 120, 14000);
      setT(this.blowerOsc.frequency, bf, now, 0.05);
      setT(this.blowerBP.frequency, clamp(bf * 1.8, 300, 16000), now, 0.05);
      setT(this.gBlower.gain, cfg.blower * (0.05 + 0.6 * rev) * (0.3 + 0.7 * load), now, 0.06);
    }

    setT(this.level.gain, this._gain * this._lvl(), now, 0.05);
  }

  dispose() {
    // Sever the shared-source edges FIRST, by destination, so the kit's looping taps
    // stop referencing this voice. `n.disconnect()` below cannot do it: it clears only
    // outgoing edges, and these arrive from a source this voice does not own. Never
    // call `src.disconnect()` without the destination -- that would cut every other
    // live voice sharing the tap. Idempotent: the list is emptied, so a second dispose
    // finds nothing to do. Guarded because not every voice owns shared edges.
    for (const [src, dest] of this._srcLinks || []) {
      try { src.disconnect(dest); } catch { /* already severed */ }
    }
    if (this._srcLinks) this._srcLinks.length = 0;
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      n.disconnect();
    }
    this.nodes.length = 0;
  }
}

/* ================================================================= tyres ==== */

/** Surface presets: [lowBand, highBand, level, hissMix, cobbleAM] */
const SURFACES = {
  asphalt:    { low: 130, high: 1500, lvl: 1.00, hiss: 0.55, am: 0.0,  q: 1.0 },
  asphaltWet: { low: 150, high: 3200, lvl: 1.20, hiss: 1.00, am: 0.0,  q: 0.8 },
  cobble:     { low: 105, high: 900,  lvl: 1.30, hiss: 0.35, am: 0.85, q: 1.7 },
  concrete:   { low: 160, high: 2100, lvl: 0.95, hiss: 0.70, am: 0.12, q: 1.1 },
  gravel:     { low: 180, high: 2600, lvl: 1.15, hiss: 0.95, am: 0.30, q: 0.7 },
  grass:      { low: 90,  high: 520,  lvl: 0.55, hiss: 0.25, am: 0.20, q: 0.9 },
};
export const SURFACE_NAMES = Object.keys(SURFACES);

export class TyreVoice {
  constructor(actx, dest, opt = {}) {
    this.actx = actx;
    const k = this.k = kit(actx);
    const now = opt.now ?? actx.currentTime;
    const tap = opt.tap ?? 0;
    this.nodes = [];
    const keep = (n) => { this.nodes.push(n); return n; };
    // Edges from the kit's SHARED looping noise sources into this voice.
    //
    // `noiseTap()` is a selector, not a factory: it returns one of the seven
    // `k.noise[*]` sources that live for the whole AudioContext. `dispose()` walks
    // `this.nodes` and calls `n.disconnect()`, which severs only each node's OUTGOING
    // edges -- so without this the shared source kept a strong reference to every
    // retired filter and gain in the voice, still feeding it noise, for the life of the
    // context. Voices are created and retired continuously as cars cross the cull
    // radius, so this accumulated without bound in ordinary play.
    //
    // Record the pair and sever it with the DESTINATION argument, which removes only
    // this edge and leaves every other live voice on the same tap untouched. The shared
    // source is never stopped here: it belongs to the kit, not to any one voice.
    this._srcLinks = [];
    const tapTo = (src, dest) => { src.connect(dest); this._srcLinks.push([src, dest]); return dest; };

    this.out = keep(actx.createGain()); this.out.gain.value = 1;
    this.out.connect(dest);

    // Rolling roar (structure-borne, low) ...
    this.roarBP = keep(actx.createBiquadFilter());
    this.roarBP.type = 'bandpass'; this.roarBP.frequency.value = 130; this.roarBP.Q.value = 1.0;
    this.gRoar = keep(actx.createGain()); this.gRoar.gain.value = 0;
    tapTo(noiseTap(k, tap), this.roarBP);
    this.roarBP.connect(this.gRoar); this.gRoar.connect(this.out);

    // ... and tread hiss (air pumping out of the tread blocks, high).
    this.hissBP = keep(actx.createBiquadFilter());
    this.hissBP.type = 'bandpass'; this.hissBP.frequency.value = 1500; this.hissBP.Q.value = 0.7;
    this.gHiss = keep(actx.createGain()); this.gHiss.gain.value = 0;
    tapTo(noiseTap(k, tap + 1, true), this.hissBP);
    this.hissBP.connect(this.gHiss); this.gHiss.connect(this.out);

    // Cobblestone: rhythmic amplitude modulation whose rate is speed / stone pitch.
    this.cobMod = keep(actx.createOscillator());
    this.cobMod.setPeriodicWave(cachedWave(k, 'pulse8', () => pulseWave(actx, 8)));
    this.cobDepth = keep(actx.createGain()); this.cobDepth.gain.value = 0;
    this.cobMod.connect(this.cobDepth);
    this.cobDepth.connect(this.gRoar.gain);

    // Skid squeal: stick-slip produces a strong, wandering tonal peak near 1 kHz.
    this.sqBP = keep(actx.createBiquadFilter());
    this.sqBP.type = 'bandpass'; this.sqBP.frequency.value = 1100; this.sqBP.Q.value = 13;
    this.sqBP2 = keep(actx.createBiquadFilter());
    this.sqBP2.type = 'bandpass'; this.sqBP2.frequency.value = 2450; this.sqBP2.Q.value = 8;
    this.gSkid = keep(actx.createGain()); this.gSkid.gain.value = 0;
    this.skidBroad = keep(actx.createBiquadFilter());
    this.skidBroad.type = 'bandpass'; this.skidBroad.frequency.value = 700; this.skidBroad.Q.value = 0.6;
    this.gSkidBroad = keep(actx.createGain()); this.gSkidBroad.gain.value = 0;
    const nt = noiseTap(k, tap + 2);
    tapTo(nt, this.sqBP); tapTo(nt, this.sqBP2); tapTo(nt, this.skidBroad);
    this.sqBP.connect(this.gSkid); this.sqBP2.connect(this.gSkid);
    this.gSkid.connect(this.out);
    this.skidBroad.connect(this.gSkidBroad); this.gSkidBroad.connect(this.out);

    this.sqWob = keep(actx.createBiquadFilter());
    this.sqWob.type = 'lowpass'; this.sqWob.frequency.value = 9;
    this.sqWobDepth = keep(actx.createGain()); this.sqWobDepth.gain.value = 150;
    tapTo(k.noise[6], this.sqWob); this.sqWob.connect(this.sqWobDepth);
    this.sqWobDepth.connect(this.sqBP.frequency);

    for (const n of this.nodes) if (n.start) { try { n.start(now); } catch { /* ignore */ } }

    this.surface = 'asphalt';
    this._s = SURFACES.asphalt;
  }

  setSurface(name) {
    if (name === this.surface) return;
    this._s = SURFACES[name] || SURFACES.asphalt;
    this.surface = name;
  }

  /**
   * @param {number} speed m/s (absolute)
   * @param {number} slip 0..1 combined tyre slip from the vehicle's tyre model
   * @param {number} grounded 0..1 fraction of wheels on the ground
   */
  update(speed, slip, grounded, now) {
    const s = this._s;
    const v = clamp(Math.abs(speed), 0, 70);
    // Rolling noise is roughly proportional to v^1.4 with a floor near walking pace.
    const roll = clamp(Math.pow(v / 30, 1.4), 0, 2.2) * s.lvl * grounded;

    setT(this.roarBP.frequency, clamp(s.low + v * 3.4, 50, 900), now, 0.08);
    setT(this.roarBP.Q, s.q, now, 0.2);
    setT(this.gRoar.gain, 0.30 * roll, now, 0.07);
    setT(this.hissBP.frequency, clamp(s.high + v * 26, 300, 12000), now, 0.08);
    setT(this.gHiss.gain, 0.13 * roll * s.hiss, now, 0.07);

    // Stone pitch ~ 0.115 m; below 1 Hz it stops reading as texture, so clamp.
    setT(this.cobMod.frequency, clamp(v / 0.115, 0.6, 120), now, 0.06);
    setT(this.cobDepth.gain, s.am * roll * 0.55, now, 0.1);

    const sk = clamp(slip, 0, 1) * clamp(v / 4, 0, 1) * grounded;
    setT(this.gSkid.gain, 0.16 * sk * sk, now, 0.03);
    setT(this.gSkidBroad.gain, 0.10 * sk, now, 0.03);
    setT(this.sqBP.frequency, clamp(880 + sk * 520 + v * 4, 400, 4000), now, 0.05);
    setT(this.sqWobDepth.gain, 90 + 220 * sk, now, 0.1);
  }

  dispose() {
    // Sever the shared-source edges FIRST, by destination, so the kit's looping taps
    // stop referencing this voice. `n.disconnect()` below cannot do it: it clears only
    // outgoing edges, and these arrive from a source this voice does not own. Never
    // call `src.disconnect()` without the destination -- that would cut every other
    // live voice sharing the tap. Idempotent: the list is emptied, so a second dispose
    // finds nothing to do. Guarded because not every voice owns shared edges.
    for (const [src, dest] of this._srcLinks || []) {
      try { src.disconnect(dest); } catch { /* already severed */ }
    }
    if (this._srcLinks) this._srcLinks.length = 0;
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      n.disconnect();
    }
    this.nodes.length = 0;
  }
}

/* ================================================================ sirens ==== */

/**
 * US emergency siren. A real one is an electronic tone generator into a horn-loaded
 * compression driver, so: a harmonically rich oscillator, a very peaky horn response
 * around 1.5-3 kHz, and a modulator that sweeps the pitch on one of four patterns.
 */
const SIREN_PATTERNS = {
  wail:    { rate: 0.22, shape: 'triangle', lo: 700,  hi: 1600, depth: 1 },
  yelp:    { rate: 3.6,  shape: 'triangle', lo: 780,  hi: 1600, depth: 1 },
  phaser:  { rate: 8.5,  shape: 'sawtooth', lo: 800,  hi: 1500, depth: 1 },
  hilo:    { rate: 1.1,  shape: 'square',   lo: 660,  hi: 1000, depth: 1 },
  airhorn: { rate: 0.0,  shape: 'triangle', lo: 320,  hi: 320,  depth: 0 },
};
export const SIREN_NAMES = Object.keys(SIREN_PATTERNS);

export class SirenVoice {
  constructor(actx, dest, opt = {}) {
    this.actx = actx;
    const k = kit(actx);
    const now = opt.now ?? actx.currentTime;
    this.nodes = [];
    const keep = (n) => { this.nodes.push(n); return n; };

    const wave = cachedWave(k, 'sirenHorn', () => {
      const real = new Float32Array(9), imag = new Float32Array(9);
      const amps = [0, 1, 0.55, 0.34, 0.21, 0.15, 0.10, 0.07, 0.05];
      for (let i = 1; i < 9; i++) imag[i] = amps[i];
      return actx.createPeriodicWave(real, imag, { disableNormalization: false });
    });

    this.out = keep(actx.createGain()); this.out.gain.value = 0;
    // Horn loading: nothing below ~600 Hz gets out, big peak in the "ouch" band.
    this.hp = keep(actx.createBiquadFilter());
    this.hp.type = 'highpass'; this.hp.frequency.value = 520; this.hp.Q.value = 0.9;
    this.horn = keep(actx.createBiquadFilter());
    this.horn.type = 'peaking'; this.horn.frequency.value = 2400;
    this.horn.Q.value = 1.1; this.horn.gain.value = 9;
    this.horn2 = keep(actx.createBiquadFilter());
    this.horn2.type = 'peaking'; this.horn2.frequency.value = 4200;
    this.horn2.Q.value = 2.0; this.horn2.gain.value = 5;
    this.hp.connect(this.horn); this.horn.connect(this.horn2);
    this.horn2.connect(this.out); this.out.connect(dest);

    this.osc = keep(actx.createOscillator());
    this.osc.setPeriodicWave(wave);
    this.osc2 = keep(actx.createOscillator());
    this.osc2.setPeriodicWave(wave);
    this.osc2.detune.value = 9;            // two drivers beating slightly
    this.g1 = keep(actx.createGain()); this.g1.gain.value = 0.5;
    this.g2 = keep(actx.createGain()); this.g2.gain.value = 0.32;
    this.osc.connect(this.g1); this.osc2.connect(this.g2);
    this.g1.connect(this.hp); this.g2.connect(this.hp);

    this.mod = keep(actx.createOscillator());
    this.mod.type = 'triangle'; this.mod.frequency.value = 0.22;
    this.modDepth = keep(actx.createGain()); this.modDepth.gain.value = 0;
    this.mod.connect(this.modDepth);
    this.modDepth.connect(this.osc.frequency);
    this.modDepth.connect(this.osc2.frequency);

    for (const n of this.nodes) if (n.start) { try { n.start(now); } catch { /* ignore */ } }

    this.pattern = 'wail';
    this._p = SIREN_PATTERNS.wail;
    this._on = false;
    this._doppler = 1;
    this._level = 0;
  }

  setPattern(name, now) {
    const p = SIREN_PATTERNS[name];
    if (!p || name === this.pattern) return;
    this.pattern = name; this._p = p;
    setT(this.mod.frequency, p.rate, now, 0.02);
    this.mod.type = p.shape;
    this._apply(now);
  }
  setDoppler(r) { this._doppler = r; }

  set(on, level, now) {
    this._on = on; this._level = level;
    setT(this.out.gain, on ? level : 0, now, on ? 0.05 : 0.12);
    this._apply(now);
  }

  _apply(now) {
    const p = this._p, d = this._doppler;
    const centre = (p.lo + p.hi) * 0.5 * d;
    const half = (p.hi - p.lo) * 0.5 * d;
    setT(this.osc.frequency, centre, now, 0.03);
    setT(this.osc2.frequency, centre, now, 0.03);
    setT(this.modDepth.gain, this._on ? half * p.depth : 0, now, 0.05);
    setT(this.horn.frequency, 2400 * d, now, 0.05);
    setT(this.horn2.frequency, 4200 * d, now, 0.05);
  }

  /** Cheap per-frame refresh; only the Doppler-dependent params move. */
  update(now) { if (this._on) this._apply(now); }

  dispose() {
    // Sever the shared-source edges FIRST, by destination, so the kit's looping taps
    // stop referencing this voice. `n.disconnect()` below cannot do it: it clears only
    // outgoing edges, and these arrive from a source this voice does not own. Never
    // call `src.disconnect()` without the destination -- that would cut every other
    // live voice sharing the tap. Idempotent: the list is emptied, so a second dispose
    // finds nothing to do. Guarded because not every voice owns shared edges.
    for (const [src, dest] of this._srcLinks || []) {
      try { src.disconnect(dest); } catch { /* already severed */ }
    }
    if (this._srcLinks) this._srcLinks.length = 0;
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      n.disconnect();
    }
    this.nodes.length = 0;
  }
}

/* ========================================================== vehicle voice ==== */

const _q = { x: 0, y: 0, z: 0, w: 1 };

/** Rotate (0,0,-1) by a quaternion, writing into `out`. No allocation. */
function forwardOf(q, out) {
  const { x, y, z, w } = q;
  out.x = -(2 * (x * z + w * y));
  out.y = -(2 * (y * z - w * x));
  out.z = -(1 - 2 * (x * x + y * y));
}
const _fwd = { x: 0, y: 0, z: -1 };
const _right = { x: 1, y: 0, z: 0 };

/**
 * Everything attached to one vehicle: a shared spatial slot, the engine, the tyres,
 * and (for emergency types) a siren. It also does the dirty work of extracting rpm,
 * load, slip and velocity from whatever shape the vehicle agent's object turns out to
 * have — the contract guarantees rpm/gear/speed but not throttle or a tyre model, so
 * everything else degrades to an estimate instead of throwing.
 */
export class VehicleVoice {
  constructor(actx, dry, send, type, opt = {}) {
    this.actx = actx;
    this.type = type;
    this.cfg = Object.assign({}, DEFAULT_CFG, VEHICLE_AUDIO[type] || {});
    const now = opt.now ?? actx.currentTime;
    const tap = opt.tap ?? 0;

    this.voice = new Voice3D(actx, dry, send, {
      hrtf: !!opt.hrtf, refDistance: 5, rolloff: 1.15, maxDistance: 400,
      send: 0.22, gain: 0,
    });
    this.engine = new EngineVoice(actx, this.voice.input, this.cfg, { tap, hifi: !!opt.hifi, now });
    this.tyres = new TyreVoice(actx, this.voice.input, { tap: tap + 1, now });
    this.siren = null;
    this._sirenOn = false;

    // state, all scalar, all reused
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this._hasPrev = false;
    this.speed = 0;
    this.slip = 0;
    this.load = 0;
    this.distance = 999;
    this.priority = 0;
    this.isPlayer = false;
    this._hornNodes = null;
    this._hornUntil = -1;
    this._now = now;
  }

  ensureSiren(now) {
    if (!this.siren) this.siren = new SirenVoice(this.actx, this.voice.input, { now });
    return this.siren;
  }

  setSurface(name) { this.tyres.setSurface(name); }

  /** Pull state off the vehicle object without allocating. */
  read(v, dt) {
    // --- position -------------------------------------------------------
    const p = v.position || v.mesh?.position;
    let x = this.px, y = this.py, z = this.pz;
    if (p) { x = p.x; y = p.y; z = p.z; }
    else if (v.body) { const t = v.body.translation(); x = t.x; y = t.y; z = t.z; }
    if (!Number.isFinite(x)) { x = this.px; y = this.py; z = this.pz; }

    // Velocity by differencing: Rapier's linvel() allocates a fresh vector per call
    // and this runs for every vehicle every frame.
    if (this._hasPrev && dt > 1e-4) {
      const k = 1 - Math.exp(-14 * dt);
      this.vx += ((x - this.px) / dt - this.vx) * k;
      this.vy += ((y - this.py) / dt - this.vy) * k;
      this.vz += ((z - this.pz) / dt - this.vz) * k;
    }
    this.px = x; this.py = y; this.pz = z;
    this._hasPrev = true;

    const measured = Math.hypot(this.vx, this.vz);
    this.speed = Number.isFinite(v.speed) ? Math.abs(v.speed) : measured;

    // --- throttle / load -------------------------------------------------
    const inp = v.input || v._input || v.controls;
    let load = inp && Number.isFinite(inp.throttle) ? inp.throttle
      : Number.isFinite(v.throttle) ? v.throttle : NaN;
    if (!Number.isFinite(load)) {
      // No throttle exposed: infer it. Rising revs or holding speed against drag both
      // mean the driver is on the gas; falling revs while rolling mean overrun.
      const dr = (v.rpm ?? this.cfg.idle) - (this._prevRpm ?? v.rpm ?? this.cfg.idle);
      const accel = (this.speed - (this._prevSpeed ?? this.speed)) / Math.max(dt, 1e-3);
      load = clamp(accel * 0.28 + (dr / Math.max(dt, 1e-3)) * 0.00035
        + clamp(this.speed / 34, 0, 0.42), 0, 1);
    }
    this._prevRpm = v.rpm;
    this._prevSpeed = this.speed;
    const brake = inp && Number.isFinite(inp.brake) ? inp.brake : (v.brake || 0);
    const hand = inp && Number.isFinite(inp.handbrake) ? inp.handbrake : (v.handbrake || 0);
    if (brake > 0.05) load *= (1 - brake);
    this.load = clamp(load, 0, 1);

    // --- slip ------------------------------------------------------------
    let slip = 0;
    const wheels = v.wheels;
    if (Array.isArray(wheels) && wheels.length) {
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w) continue;
        const a = Math.abs(w.slip ?? w.slipRatio ?? w.longitudinalSlip ?? 0);
        const b = Math.abs(w.lateralSlip ?? w.slipAngle ?? 0);
        if (a > slip) slip = a;
        if (b * 0.85 > slip) slip = b * 0.85;
      }
      if (slip > 1.2) slip = clamp(slip / 8, 0, 1);      // slip angle in degrees
    }
    if (slip < 0.02) {
      // Estimate from how sideways the car is travelling, plus locked brakes/handbrake.
      const q = v.quaternion || v.mesh?.quaternion;
      if (q && Number.isFinite(q.w)) {
        _q.x = q.x; _q.y = q.y; _q.z = q.z; _q.w = q.w;
        forwardOf(_q, _fwd);
        _right.x = -_fwd.z; _right.y = 0; _right.z = _fwd.x;
        const lat = Math.abs(this.vx * _right.x + this.vz * _right.z);
        slip = clamp((lat - 1.2) / 6, 0, 1);
      }
      const locked = clamp((brake - 0.75) * 4, 0, 1) * clamp(this.speed / 8, 0, 1);
      const spin = clamp((this.load - 0.85) * 6, 0, 1) * clamp(1 - this.speed / 12, 0, 1);
      slip = Math.max(slip, Math.max(locked, spin), hand > 0.5 ? clamp(this.speed / 10, 0, 1) : 0);
    }
    this.slip = clamp(slip, 0, 1);

    const wog = v.wheelsOnGround;
    this.grounded = Number.isFinite(wog) ? clamp(wog / 4, 0, 1) : (wog === false ? 0 : 1);
    return this;
  }

  /**
   * @param {object} v the Vehicle
   * @param {number} gain 0..1 mix level from the AudioEngine's priority pass
   * @param {number} doppler pitch ratio from listener/source relative motion
   */
  update(v, dt, now, gain, doppler) {
    this.engine.setDoppler(doppler);
    this.engine.update(v.rpm ?? this.cfg.idle, this.load, v.gear ?? 1, dt, now);
    this.tyres.update(this.speed, this.slip, this.grounded, now);
    this.voice.setPosition(this.px, this.py + 0.45, this.pz, now);
    this.voice.setVelocity(this.vx, this.vy, this.vz);
    this.voice.setGain(gain, now, 0.08);

    const wantSiren = !!v.sirenOn;
    if (wantSiren || this.siren) {
      const s = this.ensureSiren(now);
      s.setDoppler(doppler);
      if (wantSiren !== this._sirenOn) { s.set(wantSiren, 0.22, now); this._sirenOn = wantSiren; }
      s.update(now);
    }
    if (this._hornUntil > 0 && now > this._hornUntil) this._stopHorn();
  }

  /** Dual-tone horn. Trucks and buses get an air horn an octave down. */
  horn(now, duration = 0.6) {
    if (this._hornNodes) this._stopHorn();
    const actx = this.actx;
    const big = !!this.cfg.bighorn || this.type === 'bus';
    const f1 = big ? 148 : 405, f2 = big ? 186 : 508;
    const g = actx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(big ? 0.42 : 0.30, now + 0.02);
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = big ? 620 : 1250; bp.Q.value = 0.55;
    const sh = actx.createWaveShaper();
    sh.curve = kit(actx).curves.softHard;
    g.connect(sh); sh.connect(bp); bp.connect(this.voice.input);
    const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = f1;
    const o2 = actx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = f2;
    o1.connect(g); o2.connect(g);
    o1.start(now); o2.start(now);
    g.gain.setValueAtTime(big ? 0.42 : 0.30, now + duration);
    g.gain.linearRampToValueAtTime(0, now + duration + 0.06);
    o1.stop(now + duration + 0.1); o2.stop(now + duration + 0.1);
    this._hornNodes = [o1, o2, g, sh, bp];
    this._hornUntil = now + duration + 0.15;
  }
  _stopHorn() {
    if (!this._hornNodes) return;
    for (const n of this._hornNodes) { try { n.stop?.(); } catch { /* ended */ } n.disconnect(); }
    this._hornNodes = null; this._hornUntil = -1;
  }

  dispose() {
    this._stopHorn();
    this.engine.dispose();
    this.tyres.dispose();
    this.siren?.dispose();
    this.voice.dispose();
  }
}

export { ORDERS as ENGINE_ORDERS, SURFACES as TYRE_SURFACES, SIREN_PATTERNS };
