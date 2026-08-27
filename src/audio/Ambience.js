/**
 * Ambience.js — the layered environmental bed.
 *
 * Nothing here is a loop of a field recording; there aren't any. Each layer is a
 * shaped noise process with its own slow modulators, so the bed never repeats and
 * never costs a per-frame allocation. Layer gains are driven by the district under
 * the listener, the time of day, the weather and the listener's height, and crossfade
 * over ~2 s so walking from Beacon Hill into the Financial District is a transition
 * rather than a cut.
 */

import { kit, noiseTap, clamp, setT, BELL_PARTIALS, makePRNG } from './Synth.js';

/**
 * Per-district bed weights. `wind` is a multiplier on the global wind level — open
 * water and the tower canyons of the Financial District are much windier than the
 * sheltered brick streets of Beacon Hill.
 */
const DISTRICTS = {
  backBay:     { traffic: 0.55, hvac: 0.40, crowd: 0.35, water: 0.00, gull: 0.00, wind: 1.00 },
  beaconHill:  { traffic: 0.28, hvac: 0.16, crowd: 0.18, water: 0.00, gull: 0.00, wind: 0.82 },
  northEnd:    { traffic: 0.38, hvac: 0.28, crowd: 0.58, water: 0.10, gull: 0.18, wind: 0.90 },
  financial:   { traffic: 0.85, hvac: 0.72, crowd: 0.50, water: 0.05, gull: 0.06, wind: 1.28 },
  fenway:      { traffic: 0.45, hvac: 0.24, crowd: 0.42, water: 0.00, gull: 0.00, wind: 1.00 },
  seaport:     { traffic: 0.40, hvac: 0.36, crowd: 0.24, water: 0.75, gull: 0.62, wind: 1.42 },
  southEnd:    { traffic: 0.45, hvac: 0.26, crowd: 0.30, water: 0.00, gull: 0.00, wind: 0.94 },
  charlestown: { traffic: 0.34, hvac: 0.20, crowd: 0.18, water: 0.55, gull: 0.46, wind: 1.20 },
  cambridge:   { traffic: 0.50, hvac: 0.30, crowd: 0.30, water: 0.35, gull: 0.22, wind: 1.06 },
  water:       { traffic: 0.12, hvac: 0.04, crowd: 0.04, water: 1.00, gull: 0.80, wind: 1.65 },
  park:        { traffic: 0.26, hvac: 0.06, crowd: 0.32, water: 0.12, gull: 0.12, wind: 0.90 },
};
const DEFAULT_DISTRICT = DISTRICTS.backBay;

/** Traffic and crowd both follow the working day. 0..24 -> multiplier. */
function todCurve(h) {
  // Two commuter humps, a lunchtime plateau, near-silence at 4 am.
  const rush = Math.exp(-Math.pow((h - 8.2) / 1.5, 2)) * 0.45
             + Math.exp(-Math.pow((h - 17.6) / 1.9, 2)) * 0.5;
  const day = 1 / (1 + Math.exp(-(h - 6.4) * 1.6)) * 1 / (1 + Math.exp((h - 22.2) * 1.1));
  return clamp(0.14 + day * 0.72 + rush, 0.1, 1.35);
}

export default class Ambience {
  /**
   * @param {BaseAudioContext} actx
   * @param {{dry:AudioNode, send:AudioNode, direct:AudioNode, pool:import('./Synth.js').OneShotPool}} io
   *   `dry` is the ambience bus (goes through the cabin muffle filter when you get in
   *   a car); `direct` bypasses it, for rain drumming on the roof above your head.
   */
  constructor(actx, io, opt = {}) {
    this.actx = actx;
    this.io = io;
    this.k = kit(actx);
    const now = opt.now ?? actx.currentTime;
    this.nodes = [];
    const keep = (n) => { this.nodes.push(n); return n; };
    const k = this.k;

    const bus = io.dry;

    /* ---- distant traffic: the low continuous roar of a city ------------- */
    this.trafficLP = keep(actx.createBiquadFilter());
    this.trafficLP.type = 'lowpass'; this.trafficLP.frequency.value = 420; this.trafficLP.Q.value = 0.7;
    this.trafficBP = keep(actx.createBiquadFilter());
    this.trafficBP.type = 'peaking'; this.trafficBP.frequency.value = 170;
    this.trafficBP.Q.value = 0.9; this.trafficBP.gain.value = 6;
    this.gTraffic = keep(actx.createGain()); this.gTraffic.gain.value = 0;
    noiseTap(k, 0, true).connect(this.trafficLP);
    this.trafficLP.connect(this.trafficBP); this.trafficBP.connect(this.gTraffic);
    this.gTraffic.connect(bus);
    // Slow ebb and flow as unseen traffic lights cycle.
    this.trafficMod = keep(actx.createBiquadFilter());
    this.trafficMod.type = 'lowpass'; this.trafficMod.frequency.value = 0.16;
    this.trafficModD = keep(actx.createGain()); this.trafficModD.gain.value = 0;
    k.noise[6].connect(this.trafficMod); this.trafficMod.connect(this.trafficModD);
    this.trafficModD.connect(this.gTraffic.gain);

    /* ---- HVAC: rooftop plant, extract fans, the hum of a transformer ---- */
    this.hvacBP = keep(actx.createBiquadFilter());
    this.hvacBP.type = 'bandpass'; this.hvacBP.frequency.value = 195; this.hvacBP.Q.value = 4.5;
    this.hvacBP2 = keep(actx.createBiquadFilter());
    this.hvacBP2.type = 'bandpass'; this.hvacBP2.frequency.value = 760; this.hvacBP2.Q.value = 1.6;
    this.gHvac = keep(actx.createGain()); this.gHvac.gain.value = 0;
    const nt1 = noiseTap(k, 1);
    nt1.connect(this.hvacBP); nt1.connect(this.hvacBP2);
    this.hvacBP.connect(this.gHvac); this.hvacBP2.connect(this.gHvac);
    this.gHvac.connect(bus);
    this.hum = keep(actx.createOscillator());
    this.hum.type = 'sawtooth'; this.hum.frequency.value = 120;   // US mains, 2nd harmonic
    this.humLP = keep(actx.createBiquadFilter());
    this.humLP.type = 'lowpass'; this.humLP.frequency.value = 420;
    this.gHum = keep(actx.createGain()); this.gHum.gain.value = 0;
    this.hum.connect(this.humLP); this.humLP.connect(this.gHum); this.gHum.connect(bus);

    /* ---- crowd murmur: broadband with speech formants ------------------- */
    this.crowdBP = keep(actx.createBiquadFilter());
    this.crowdBP.type = 'bandpass'; this.crowdBP.frequency.value = 720; this.crowdBP.Q.value = 0.65;
    this.f1 = keep(actx.createBiquadFilter());
    this.f1.type = 'peaking'; this.f1.frequency.value = 520; this.f1.Q.value = 3.2; this.f1.gain.value = 7;
    this.f2 = keep(actx.createBiquadFilter());
    this.f2.type = 'peaking'; this.f2.frequency.value = 1620; this.f2.Q.value = 2.6; this.f2.gain.value = 6;
    this.f3 = keep(actx.createBiquadFilter());
    this.f3.type = 'peaking'; this.f3.frequency.value = 2680; this.f3.Q.value = 3.0; this.f3.gain.value = 4;
    this.gCrowd = keep(actx.createGain()); this.gCrowd.gain.value = 0;
    noiseTap(k, 2, true).connect(this.crowdBP);
    this.crowdBP.connect(this.f1); this.f1.connect(this.f2); this.f2.connect(this.f3);
    this.f3.connect(this.gCrowd); this.gCrowd.connect(bus);
    // Syllabic rate modulation is what makes noise read as "people talking".
    this.crowdMod = keep(actx.createBiquadFilter());
    this.crowdMod.type = 'bandpass'; this.crowdMod.frequency.value = 3.6; this.crowdMod.Q.value = 1.2;
    this.crowdModD = keep(actx.createGain()); this.crowdModD.gain.value = 0;
    k.noise[6].connect(this.crowdMod); this.crowdMod.connect(this.crowdModD);
    this.crowdModD.connect(this.gCrowd.gain);

    /* ---- harbour water -------------------------------------------------- */
    this.waterSrc = keep(actx.createBufferSource());
    this.waterLP = keep(actx.createBiquadFilter());
    this.waterLP.type = 'lowpass'; this.waterLP.frequency.value = 1400; this.waterLP.Q.value = 0.7;
    this.gWater = keep(actx.createGain()); this.gWater.gain.value = 0;
    this.waterLP.connect(this.gWater); this.gWater.connect(bus);

    /* ---- wind ------------------------------------------------------------ */
    this.windBP = keep(actx.createBiquadFilter());
    this.windBP.type = 'bandpass'; this.windBP.frequency.value = 480; this.windBP.Q.value = 1.4;
    this.windLow = keep(actx.createBiquadFilter());
    this.windLow.type = 'lowpass'; this.windLow.frequency.value = 260; this.windLow.Q.value = 1.1;
    this.gWind = keep(actx.createGain()); this.gWind.gain.value = 0;
    this.gWindLow = keep(actx.createGain()); this.gWindLow.gain.value = 0;
    const nt3 = noiseTap(k, 3);
    nt3.connect(this.windBP); nt3.connect(this.windLow);
    this.windBP.connect(this.gWind); this.windLow.connect(this.gWindLow);
    this.gWind.connect(bus); this.gWindLow.connect(bus);
    // Gusts: very slow noise sweeps both the filter and the level.
    this.gustLP = keep(actx.createBiquadFilter());
    this.gustLP.type = 'lowpass'; this.gustLP.frequency.value = 0.22;
    this.gustFreqD = keep(actx.createGain()); this.gustFreqD.gain.value = 0;
    this.gustGainD = keep(actx.createGain()); this.gustGainD.gain.value = 0;
    k.noise[6].connect(this.gustLP);
    this.gustLP.connect(this.gustFreqD); this.gustFreqD.connect(this.windBP.frequency);
    this.gustLP.connect(this.gustGainD); this.gustGainD.connect(this.gWind.gain);

    /* ---- rain ------------------------------------------------------------ */
    // Bed: a low "roar" off roofs and road, plus a high hiss of the drops themselves.
    this.rainLow = keep(actx.createBiquadFilter());
    this.rainLow.type = 'lowpass'; this.rainLow.frequency.value = 900; this.rainLow.Q.value = 0.6;
    this.gRainLow = keep(actx.createGain()); this.gRainLow.gain.value = 0;
    noiseTap(k, 0).connect(this.rainLow);
    this.rainLow.connect(this.gRainLow); this.gRainLow.connect(bus);

    this.rainHigh = keep(actx.createBiquadFilter());
    this.rainHigh.type = 'highpass'; this.rainHigh.frequency.value = 2400; this.rainHigh.Q.value = 0.5;
    this.rainTilt = keep(actx.createBiquadFilter());
    this.rainTilt.type = 'lowpass'; this.rainTilt.frequency.value = 9000; this.rainTilt.Q.value = 0.5;
    this.gRainHigh = keep(actx.createGain()); this.gRainHigh.gain.value = 0;
    noiseTap(k, 1).connect(this.rainHigh);
    this.rainHigh.connect(this.rainTilt); this.rainTilt.connect(this.gRainHigh);
    this.gRainHigh.connect(bus);

    // Droplet transients — the part that makes the ear believe it.
    this.dropSrc = keep(actx.createBufferSource());
    this.gDrops = keep(actx.createGain()); this.gDrops.gain.value = 0;
    this.gDrops.connect(bus);

    // Rain on a car roof: same drops, close-mic'd through the sheet-metal resonance.
    this.roofSrc = keep(actx.createBufferSource());
    this.roofBP = keep(actx.createBiquadFilter());
    this.roofBP.type = 'bandpass'; this.roofBP.frequency.value = 820; this.roofBP.Q.value = 1.1;
    this.roofRes = keep(actx.createBiquadFilter());
    this.roofRes.type = 'peaking'; this.roofRes.frequency.value = 260;
    this.roofRes.Q.value = 3.0; this.roofRes.gain.value = 8;
    this.gRoof = keep(actx.createGain()); this.gRoof.gain.value = 0;
    this.roofBP.connect(this.roofRes); this.roofRes.connect(this.gRoof);
    this.gRoof.connect(io.direct || bus);

    this.hum.start(now);
    this._buffersReady = false;
    this._pending = [];        // scheduled one-shot chains awaiting teardown
    this._rng = makePRNG(4242);
    this._gullAt = now + 6 + Math.random() * 20;
    this._passbyAt = now + 4 + Math.random() * 8;
    this._lastHour = -1;

    // Cached targets so the per-frame pass is pure arithmetic.
    this.rain = 0; this.windLevel = 0.2; this.inVehicle = 0;
    this._d = DEFAULT_DISTRICT;
    this._blend = Object.assign({}, DEFAULT_DISTRICT);
  }

  /** Attach the rendered loop buffers once Synth.warmLazy has produced them. */
  tryAttachBuffers(now) {
    if (this._buffersReady) return true;
    const L = this.k.lazy;
    if (!L.water || !L.dropMed) return false;
    const start = (src, buf, rate) => {
      src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
      try { src.start(now, Math.random() * buf.duration); } catch { /* already started */ }
    };
    start(this.waterSrc, L.water, 0.85);
    this.waterSrc.connect(this.waterLP);
    start(this.dropSrc, L.dropMed, 1.0);
    this.dropSrc.connect(this.gDrops);
    start(this.roofSrc, L.dropHeavy, 1.0);
    this.roofSrc.connect(this.roofBP);
    this._buffersReady = true;
    return true;
  }

  /**
   * @param {object} s persistent state object owned by AudioEngine — never allocated
   *   here. Fields: x, y, z, district, timeOfDay, weather, rain, wind, inVehicle,
   *   speed, quality.
   */
  update(dt, now, s) {
    if (!this._buffersReady) this.tryAttachBuffers(now);

    const target = DISTRICTS[s.district] || DEFAULT_DISTRICT;
    // Crossfade the whole weight set rather than snapping between districts.
    const b = this._blend, r = 1 - Math.exp(-dt / 1.6);
    b.traffic += (target.traffic - b.traffic) * r;
    b.hvac += (target.hvac - b.hvac) * r;
    b.crowd += (target.crowd - b.crowd) * r;
    b.water += (target.water - b.water) * r;
    b.gull += (target.gull - b.gull) * r;
    b.wind += (target.wind - b.wind) * r;

    const tod = todCurve(s.timeOfDay);
    const rain = this.rain = clamp(s.rain, 0, 1);
    const cab = this.inVehicle = clamp(s.inVehicle, 0, 1);
    // Height: above the rooftops the street disappears and the wind takes over.
    const hi = clamp((s.y - 12) / 130, 0, 1);
    const streetMask = 1 - hi * 0.75;

    setT(this.gTraffic.gain, 0.075 * b.traffic * tod * streetMask * (1 - rain * 0.25), now, 0.6);
    setT(this.trafficModD.gain, 0.03 * b.traffic * tod, now, 1.0);
    setT(this.trafficLP.frequency, 380 + hi * 240, now, 1.0);

    setT(this.gHvac.gain, 0.030 * b.hvac * (1 - hi * 0.55), now, 0.8);
    setT(this.gHum.gain, 0.0055 * b.hvac * (1 - hi * 0.7), now, 0.8);

    // Rain and night both clear the streets.
    const crowdLvl = b.crowd * tod * (1 - rain * 0.7) * streetMask;
    setT(this.gCrowd.gain, 0.055 * crowdLvl, now, 0.9);
    setT(this.crowdModD.gain, 0.05 * crowdLvl, now, 0.9);

    setT(this.gWater.gain, 0.14 * b.water * (1 - cab * 0.7), now, 0.9);
    setT(this.waterLP.frequency, 900 + b.water * 900, now, 1.0);

    const wind = this.windLevel = clamp(s.wind, 0, 1) * b.wind * (0.35 + hi * 1.5);
    setT(this.gWind.gain, 0.055 * wind, now, 0.7);
    setT(this.gWindLow.gain, 0.045 * wind * (0.5 + hi), now, 0.7);
    setT(this.gustFreqD.gain, 260 * wind, now, 1.2);
    setT(this.gustGainD.gain, 0.045 * wind, now, 1.2);
    setT(this.windBP.frequency, 300 + wind * 420, now, 1.2);

    // Rain: the bed tilts brighter as it gets heavier, and the droplet layer swaps
    // between three densities rather than just getting louder.
    const rr = rain * rain;
    setT(this.gRainLow.gain, 0.22 * rain * (1 - cab * 0.45), now, 0.5);
    setT(this.gRainHigh.gain, 0.10 * rr * (1 - cab * 0.75), now, 0.5);
    setT(this.rainLow.frequency, 620 + rain * 900, now, 0.7);
    setT(this.rainHigh.frequency, 3200 - rain * 1400, now, 0.7);
    setT(this.gDrops.gain, 0.17 * rain * (1 - cab * 0.8), now, 0.5);
    if (this._buffersReady) setT(this.dropSrc.playbackRate, 0.75 + rain * 0.55, now, 0.8);
    setT(this.gRoof.gain, 0.30 * rr * cab, now, 0.35);
    if (this._buffersReady) setT(this.roofSrc.playbackRate, 0.8 + rain * 0.5, now, 0.8);
    setT(this.roofBP.frequency, 700 + rain * 500, now, 0.6);

    // Church bells on the hour.
    const hour = Math.floor(s.timeOfDay);
    if (this._lastHour < 0) this._lastHour = hour;
    else if (hour !== this._lastHour) { this._lastHour = hour; this.bells(hour, now, s); }

    // Occasional character events, spatialised through the one-shot pool.
    if (now > this._gullAt) {
      this._gullAt = now + 4 + this._rng() * 22;
      if (b.gull > 0.12 && this._rng() < b.gull) this.gull(now, s);
    }
    if (now > this._passbyAt) {
      this._passbyAt = now + 3.5 + this._rng() * 9;
      if (b.traffic > 0.25 && this._rng() < b.traffic * tod * 0.9) this.passby(now, s);
    }
    this._drain(now);
  }

  /**
   * Hard-mute every layer except the weather. Used by the analytical self-test so the
   * measured rain spectrum is unambiguously the rain and nothing else. Modulator depth
   * gains have to go too: they sum into the layer gain params, so zeroing the gain
   * alone would leave the modulation still audible.
   */
  soloRain(time = 0) {
    const kill = (p) => { p.cancelScheduledValues(time); p.setValueAtTime(0, time); };
    for (const g of [this.gTraffic, this.gHvac, this.gCrowd, this.gHum, this.gWater,
      this.gWind, this.gWindLow, this.trafficModD, this.crowdModD, this.gustGainD,
      this.gustFreqD]) kill(g.gain);
  }

  /* ------------------------------------------------------------ events ---- */

  _drain(now) {
    const p = this._pending;
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i].t > now) continue;
      for (const n of p[i].nodes) { try { n.stop?.(); } catch { /* ended */ } n.disconnect(); }
      p.splice(i, 1);
    }
  }

  /**
   * Thunder. Distance sets three things at once: the delay after the flash, how much
   * high frequency the air has absorbed, and how long the rumble smears out as the
   * wavefront reflects off the ground, clouds and buildings.
   * @param {number} distance metres
   */
  thunder(distance, now) {
    const actx = this.actx;
    const d = clamp(distance, 60, 14000);
    const delay = d / 343;
    const t0 = now + delay;
    const near = 1 - clamp((d - 200) / 3000, 0, 1);
    const dur = clamp(1.6 + d / 900, 1.6, 11);

    const src = actx.createBufferSource();
    src.buffer = this.k.buffers.brown;
    src.loop = true;
    src.playbackRate.value = 0.35 + near * 0.5;

    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(180 + near * 4200, 110, 5000);
    lp.Q.value = 0.7;
    const lp2 = actx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = lp.frequency.value * 1.4;
    const boom = actx.createBiquadFilter();
    boom.type = 'peaking'; boom.frequency.value = 48 + near * 40;
    boom.Q.value = 0.9; boom.gain.value = 9;

    const g = actx.createGain();
    // Silence before the wavefront arrives. This must sit strictly *before* the value
    // curve — setValueCurveAtTime throws if any event lands inside its own window.
    g.gain.setValueAtTime(0, now);
    // Multi-lobe envelope: real thunder rolls, it does not fade smoothly.
    const N = 220;
    const env = new Float32Array(N);
    const rng = makePRNG((d * 1000) | 0);
    const lobes = 2 + Math.floor(rng() * 4);
    const cen = [], wid = [], amp = [];
    for (let i = 0; i < lobes; i++) {
      cen.push(rng() * 0.85); wid.push(0.05 + rng() * 0.28); amp.push(0.35 + rng() * 0.65);
    }
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      let v = 0;
      for (let l = 0; l < lobes; l++) v += amp[l] * Math.exp(-Math.pow((t - cen[l]) / wid[l], 2));
      // Sharp leading crack only when it is close.
      v += near * near * 2.4 * Math.exp(-t * 90);
      env[i] = clamp(v * (1 - t * 0.55), 0, 3) * (0.20 + 0.55 * near);
    }
    env[N - 1] = 0;
    g.gain.setValueCurveAtTime(env, t0, dur);

    src.connect(lp); lp.connect(lp2); lp2.connect(boom); boom.connect(g);
    g.connect(this.io.dry);
    if (this.io.send) { const s = actx.createGain(); s.gain.value = 0.9; g.connect(s); s.connect(this.io.send);
      this._pending.push({ t: t0 + dur + 0.4, nodes: [s] }); }
    src.start(t0, rng() * 3);
    src.stop(t0 + dur + 0.2);
    this._pending.push({ t: t0 + dur + 0.4, nodes: [src, lp, lp2, boom, g] });
    return delay;
  }

  /** Church bells: an inharmonic modal set, struck `hour` times. */
  bells(hour, now, s) {
    const h12 = ((hour + 11) % 12) + 1;
    const strikes = Math.min(h12, 12);
    const actx = this.actx;
    const f0 = 236;                              // prime of a large tenor bell
    const spacing = 2.0;
    for (let n = 0; n < strikes; n++) {
      const t = now + 0.4 + n * spacing;
      const out = actx.createGain();
      out.gain.value = 0.055;
      out.connect(this.io.dry);
      const send = actx.createGain(); send.gain.value = 1.2;
      out.connect(send); if (this.io.send) send.connect(this.io.send);
      const nodes = [out, send];
      for (let i = 0; i < 8; i++) {
        const [ratio, amp, dec] = BELL_PARTIALS[i];
        const o = actx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f0 * ratio * (1 + (i > 3 ? 0.004 * (i - 3) : 0));
        const g = actx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(amp, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0006, t + dec * 0.7);
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + dec * 0.7 + 0.05);
        nodes.push(o, g);
      }
      this._pending.push({ t: t + 7.5, nodes });
    }
  }

  /** Gull cry: a few rapid descending syllables through a horn-ish bandpass. */
  gull(now, s) {
    const pool = this.io.pool;
    if (!pool) return;
    const slot = pool.acquire(now, 1.4, 0.4);
    if (!slot) return;
    const actx = this.actx;
    const rng = this._rng;
    const ang = rng() * Math.PI * 2, dist = 18 + rng() * 45;
    slot.voice.setPosition(s.x + Math.cos(ang) * dist, s.y + 8 + rng() * 22,
      s.z + Math.sin(ang) * dist, now);
    slot.voice.setGain(0.5 + rng() * 0.4, now, 0.01);

    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 2.2;
    const g = actx.createGain(); g.gain.value = 0;
    const osc = actx.createOscillator();
    osc.type = 'sawtooth';
    osc.connect(g); g.connect(bp); bp.connect(slot.voice.input);
    const syl = 2 + Math.floor(rng() * 3);
    let t = now;
    const base = 900 + rng() * 500;
    for (let i = 0; i < syl; i++) {
      const len = 0.13 + rng() * 0.12;
      osc.frequency.setValueAtTime(base * (1.35 - i * 0.09), t);
      osc.frequency.exponentialRampToValueAtTime(base * (0.72 - i * 0.03), t + len);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      t += len + 0.06 + rng() * 0.09;
    }
    osc.start(now); osc.stop(t + 0.1);
    slot.nodes.push(osc, g, bp);
    slot.freeAt = t + 0.2;
  }

  /**
   * A car you never see, passing on a nearby street. The panner position is ramped
   * across the listener and the source's playback rate is ramped with it, so it
   * genuinely sweeps through the stereo field with a Doppler drop.
   */
  passby(now, s) {
    const pool = this.io.pool;
    if (!pool) return;
    const rng = this._rng;
    const dur = 2.6 + rng() * 2.2;
    const slot = pool.acquire(now, dur, 0.5);
    if (!slot) return;
    const actx = this.actx;
    const side = rng() < 0.5 ? -1 : 1;
    const off = (8 + rng() * 22) * side;         // lateral offset of the "street"
    const reach = 60 + rng() * 50;
    const dir = rng() < 0.5 ? -1 : 1;
    const p = slot.voice.panner;
    const set = (ax, v, t) => { if (ax) { ax.cancelScheduledValues(t); ax.setValueAtTime(v, t); } };
    if (p.positionX) {
      set(p.positionX, s.x + off, now);
      set(p.positionZ, s.z - reach * dir, now);
      set(p.positionY, s.y - 0.4, now);
      p.positionZ.linearRampToValueAtTime(s.z + reach * dir, now + dur);
    } else {
      slot.voice.setPosition(s.x + off, s.y - 0.4, s.z, now);
    }
    slot.voice.setGain(0.55 + rng() * 0.4, now, 0.01);

    const src = actx.createBufferSource();
    src.buffer = this.k.buffers.pink;
    src.loop = true;
    src.playbackRate.setValueAtTime(1.12, now);
    src.playbackRate.linearRampToValueAtTime(0.88, now + dur);   // cheap Doppler
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
    bp.frequency.setValueAtTime(340, now);
    bp.frequency.linearRampToValueAtTime(1400, now + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(420, now + dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.16 + rng() * 0.12, now + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp); bp.connect(g); g.connect(slot.voice.input);
    src.start(now, rng() * 4);
    src.stop(now + dur + 0.05);
    slot.nodes.push(src, bp, g);
  }

  dispose() {
    this._drain(Infinity);
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      n.disconnect();
    }
    this.nodes.length = 0;
  }
}

export { DISTRICTS as AMBIENCE_DISTRICTS, todCurve };
