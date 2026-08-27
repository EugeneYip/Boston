/**
 * Impacts.js — transient events: collisions, scrapes, suspension thumps, UI.
 *
 * Impact sound is modal. A struck car door rings at a handful of heavily damped
 * inharmonic modes; a windscreen breaking is hundreds of tiny, bright, sparsely
 * distributed modes. So: a bank of high-Q bandpasses excited by a short noise burst
 * for the body, a pre-rendered grain cloud for the glass, and a pitched-down sine for
 * the chest-thump of the actual momentum exchange. Impulse maps to all three
 * differently, which is why a graze and a head-on read as different events rather
 * than the same event at two volumes.
 */

import { kit, clamp, modalBurst, setT, Voice3D } from './Synth.js';

/** Body-panel modes, roughly a mid-size steel unibody. */
const BODY_F = [92, 167, 249, 386, 563, 818, 1235, 1840];
const BODY_D = [0.42, 0.33, 0.26, 0.19, 0.14, 0.10, 0.075, 0.05];
const BODY_G = [1.0, 0.86, 0.70, 0.60, 0.46, 0.34, 0.24, 0.15];

/** Kerb / pothole: shorter, deader, dominated by the tyre and the damper. */
const SUSP_F = [58, 104, 186, 312, 520];
const SUSP_D = [0.24, 0.18, 0.12, 0.08, 0.05];
const SUSP_G = [1.0, 0.72, 0.48, 0.30, 0.18];

export default class Impacts {
  /**
   * @param {BaseAudioContext} actx
   * @param {{pool:import('./Synth.js').OneShotPool, dry:AudioNode, send:AudioNode,
   *          ui:AudioNode, duck:(amount:number, seconds:number)=>void}} io
   */
  constructor(actx, io, opt = {}) {
    this.actx = actx;
    this.io = io;
    this.k = kit(actx);
    const now = opt.now ?? actx.currentTime;
    this.nodes = [];
    const keep = (n) => { this.nodes.push(n); return n; };

    /** Impulse value that counts as a maximum-severity crash. */
    this.impulseScale = 7000;

    // A persistent scrape voice: metal dragging on stone is continuous, so it gets a
    // held voice that is fed by contact events and decays when they stop arriving.
    this.scrapeVoice = new Voice3D(actx, io.dry, io.send, {
      hrtf: false, refDistance: 3, rolloff: 1.4, maxDistance: 200, send: 0.3, gain: 0,
    });
    this.scrapeBP = keep(actx.createBiquadFilter());
    this.scrapeBP.type = 'bandpass'; this.scrapeBP.frequency.value = 2400; this.scrapeBP.Q.value = 3.2;
    this.scrapeRes = keep(actx.createBiquadFilter());
    this.scrapeRes.type = 'peaking'; this.scrapeRes.frequency.value = 1150;
    this.scrapeRes.Q.value = 8; this.scrapeRes.gain.value = 10;
    this.scrapeGain = keep(actx.createGain()); this.scrapeGain.gain.value = 0;
    this.k.noise[0].connect(this.scrapeBP);
    this.scrapeBP.connect(this.scrapeRes); this.scrapeRes.connect(this.scrapeGain);
    this.scrapeGain.connect(this.scrapeVoice.input);
    this.scrapeVoice.setGain(1, now, 0.01);
    this._scrapeLevel = 0;
    this._scrapeDecay = 0;

    this._pending = [];
    this._lastBig = -10;
  }

  /* --------------------------------------------------------- collisions ---- */

  /**
   * @param {number} impulse raw impulse from the physics contact
   * @param {number} x @param {number} y @param {number} z world point
   * @param {number} now audio clock
   * @param {{glass?:number, hard?:number, priority?:number}} o
   *   `hard` 0..1 selects concrete/steel over sheet metal (kerbs, lamp posts).
   */
  collision(impulse, x, y, z, now, o = {}) {
    // Soft-knee normalisation: works whether the vehicle agent reports newton-seconds
    // or an already-normalised 0..1 severity.
    const raw = Math.abs(impulse) || 0;
    const i = raw <= 1.001 ? clamp(raw, 0, 1)
      : 1 - Math.exp(-raw / this.impulseScale);
    if (i < 0.02) return 0;

    const pool = this.io.pool;
    if (!pool) return i;
    const dur = 0.55 + i * 0.9;
    const slot = pool.acquire(now, dur, 4 + i * 4);
    if (!slot) return i;
    const actx = this.actx;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.setGain(clamp(0.35 + i * 0.9, 0, 1.4), now, 0.005);
    slot.voice.setSend(0.35 + i * 0.35, now, 0.01);

    const hard = clamp(o.hard ?? 0, 0, 1);
    const pitch = 1 + hard * 0.55 - i * 0.18;   // big hits ring lower

    // 1. the panel ringing
    const nodes = slot.nodes;
    const bus = slot.voice.input;
    const f = BODY_F, d = BODY_D, g = BODY_G;
    const freqs = this._scratchF || (this._scratchF = new Array(BODY_F.length));
    const decs = this._scratchD || (this._scratchD = new Array(BODY_F.length));
    const gains = this._scratchG || (this._scratchG = new Array(BODY_F.length));
    for (let n = 0; n < f.length; n++) {
      freqs[n] = f[n] * pitch;
      decs[n] = d[n] * (0.55 + i * 0.9) * (1 - hard * 0.35);
      gains[n] = g[n] * (0.30 + i * 0.9);
    }
    modalBurst(actx, bus, now, this.k.buffers.white, {
      freqs, decays: decs, gains, amp: 0.35 + i * 0.9,
      q: 9 + hard * 22, exciteDur: 0.012 + i * 0.03, nodes,
    });

    // 2. the crunch — deforming metal is broadband, dense and distorted
    const cr = actx.createBufferSource();
    cr.buffer = this.k.lazy.gravel || this.k.buffers.white;
    cr.playbackRate.value = 0.55 + Math.random() * 0.5 + hard * 0.4;
    const crBP = actx.createBiquadFilter();
    crBP.type = 'bandpass';
    crBP.frequency.setValueAtTime(2400 + hard * 2200, now);
    crBP.frequency.exponentialRampToValueAtTime(600, now + 0.22 + i * 0.2);
    crBP.Q.value = 0.8;
    const crG = actx.createGain();
    crG.gain.setValueAtTime(0, now);
    crG.gain.linearRampToValueAtTime(0.5 * i + 0.06, now + 0.006);
    crG.gain.exponentialRampToValueAtTime(0.0006, now + 0.18 + i * 0.45);
    cr.connect(crBP); crBP.connect(crG); crG.connect(bus);
    cr.start(now, Math.random() * 0.5);
    cr.stop(now + 0.9 + i * 0.5);
    nodes.push(cr, crBP, crG);

    // 3. the thud — the momentum you feel in your chest
    const th = actx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(78 + i * 40, now);
    th.frequency.exponentialRampToValueAtTime(34, now + 0.16);
    const thG = actx.createGain();
    thG.gain.setValueAtTime(0, now);
    thG.gain.linearRampToValueAtTime(0.55 * i, now + 0.004);
    thG.gain.exponentialRampToValueAtTime(0.0004, now + 0.18 + i * 0.25);
    th.connect(thG); thG.connect(bus);
    th.start(now); th.stop(now + 0.5 + i * 0.3);
    nodes.push(th, thG);

    // 4. glass, if it was hard enough
    const gl = o.glass ?? (i > 0.42 ? clamp((i - 0.42) * 2.2, 0, 1) : 0);
    if (gl > 0.05) this.glass(gl, x, y, z, now + 0.02 + Math.random() * 0.05);

    // Big hits duck the ambience so the crash has room.
    if (i > 0.35 && now - this._lastBig > 0.25) {
      this._lastBig = now;
      this.io.duck?.(clamp(i, 0, 1), 0.9 + i * 0.7);
    }
    return i;
  }

  /** Glass shatter: the pre-rendered grain cloud, band-shaped by severity. */
  glass(intensity, x, y, z, now) {
    const pool = this.io.pool;
    const buf = this.k.lazy.glass;
    if (!pool || !buf) return;
    const i = clamp(intensity, 0, 1);
    const slot = pool.acquire(now, 1.6, 3 + i * 3);
    if (!slot) return;
    const actx = this.actx;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.setGain(0.3 + i * 0.7, now, 0.005);
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.85 + Math.random() * 0.4 - i * 0.15;
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900 - i * 400; hp.Q.value = 0.7;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.25 + i * 0.7, now);
    g.gain.exponentialRampToValueAtTime(0.0006, now + 0.5 + i * 1.0);
    src.connect(hp); hp.connect(g); g.connect(slot.voice.input);
    src.start(now); src.stop(now + 1.8);
    slot.nodes.push(src, hp, g);
  }

  /** Kerb strike / pothole. Short, dead, dominated by tyre and damper. */
  thump(intensity, x, y, z, now, hard = 0) {
    const pool = this.io.pool;
    if (!pool) return;
    const i = clamp(intensity, 0, 1);
    if (i < 0.03) return;
    const slot = pool.acquire(now, 0.45, 1.5 + i * 2);
    if (!slot) return;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.setGain(0.3 + i * 0.6, now, 0.004);
    const freqs = this._sF || (this._sF = new Array(SUSP_F.length));
    const decs = this._sD || (this._sD = new Array(SUSP_F.length));
    const gains = this._sG || (this._sG = new Array(SUSP_F.length));
    const pitch = 1 + hard * 0.4;
    for (let n = 0; n < SUSP_F.length; n++) {
      freqs[n] = SUSP_F[n] * pitch;
      decs[n] = SUSP_D[n] * (0.6 + i * 0.7);
      gains[n] = SUSP_G[n] * (0.25 + i * 0.8);
    }
    modalBurst(this.actx, slot.voice.input, now, this.k.buffers.white, {
      freqs, decays: decs, gains, amp: 0.3 + i * 0.7, q: 7 + hard * 14,
      exciteDur: 0.01 + i * 0.012, nodes: slot.nodes,
    });
  }

  /**
   * Continuous scrape. Feed it every frame while contact lasts; it decays on its own
   * the moment you stop, so callers do not need start/stop bookkeeping.
   * @param {number} intensity 0..1, typically slip speed along the contact
   */
  scrape(intensity, x, y, z, now) {
    const i = clamp(intensity, 0, 1);
    if (i > this._scrapeLevel) this._scrapeLevel = i;
    this._scrapeDecay = now + 0.12;
    this.scrapeVoice.setPosition(x, y, z, now);
    setT(this.scrapeBP.frequency, 1200 + i * 3400, now, 0.05);
    setT(this.scrapeRes.frequency, 700 + i * 1600, now, 0.05);
  }

  /* ---------------------------------------------------------------- UI ---- */

  /** Short, dry, non-spatial. UI must never sound like it is in the world. */
  click(now, bright = 1) {
    const actx = this.actx, dest = this.io.ui;
    if (!dest) return;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.045);
    g.connect(dest);
    for (const [f, a] of [[2050 * bright, 1], [3120 * bright, 0.45]]) {
      const o = actx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const og = actx.createGain(); og.gain.value = a;
      o.connect(og); og.connect(g);
      o.start(now); o.stop(now + 0.06);
      this._pending.push({ t: now + 0.15, nodes: [o, og] });
    }
    const n = actx.createBufferSource();
    n.buffer = this.k.buffers.white;
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 3800;
    const ng = actx.createGain();
    ng.gain.setValueAtTime(0.10, now);
    ng.gain.exponentialRampToValueAtTime(0.0004, now + 0.016);
    n.connect(hp); hp.connect(ng); ng.connect(dest);
    n.start(now, Math.random() * 4); n.stop(now + 0.04);
    this._pending.push({ t: now + 0.2, nodes: [g, n, hp, ng] });
  }

  hover(now) { this.click(now, 1.45); }

  /**
   * Notification sting: a short rising figure on soft FM bells, sent to the reverb so
   * it sits slightly behind the UI clicks.
   * @param {'info'|'good'|'bad'} kind
   */
  notify(now, kind = 'info') {
    const actx = this.actx, dest = this.io.ui;
    if (!dest) return;
    const seq = kind === 'bad' ? [523.25, 415.30, 349.23]
      : kind === 'good' ? [523.25, 659.26, 783.99, 1046.5]
      : [783.99, 1046.5];
    const out = actx.createGain(); out.gain.value = 0.12;
    out.connect(dest);
    const send = actx.createGain(); send.gain.value = 0.6;
    out.connect(send); if (this.io.send) send.connect(this.io.send);
    const nodes = [out, send];
    for (let i = 0; i < seq.length; i++) {
      const t = now + i * 0.085;
      const car = actx.createOscillator(); car.type = 'sine'; car.frequency.value = seq[i];
      const mod = actx.createOscillator(); mod.type = 'sine';
      mod.frequency.value = seq[i] * 2.01;
      const md = actx.createGain(); md.gain.setValueAtTime(seq[i] * 1.6, t);
      md.gain.exponentialRampToValueAtTime(seq[i] * 0.02, t + 0.18);
      mod.connect(md); md.connect(car.frequency);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.42);
      car.connect(g); g.connect(out);
      car.start(t); car.stop(t + 0.5);
      mod.start(t); mod.stop(t + 0.5);
      nodes.push(car, mod, md, g);
    }
    this.io.duck?.(0.35, 0.6);
    this._pending.push({ t: now + 0.9 + seq.length * 0.085, nodes });
  }

  /** Air brake release — buses and trucks stopping. Pure noise, fast decay. */
  airBrake(x, y, z, now, strength = 1) {
    const pool = this.io.pool;
    if (!pool) return;
    const slot = pool.acquire(now, 0.7, 2);
    if (!slot) return;
    const actx = this.actx;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.setGain(0.5 * strength, now, 0.004);
    const src = actx.createBufferSource();
    src.buffer = this.k.buffers.white;
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(5200, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + 0.5);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.55);
    src.connect(bp); bp.connect(g); g.connect(slot.voice.input);
    src.start(now, Math.random() * 4); src.stop(now + 0.7);
    slot.nodes.push(src, bp, g);
  }

  /** Turbo blow-off. Sharp chuff with a falling resonance. */
  blowoff(spool, x, y, z, now) {
    const pool = this.io.pool;
    if (!pool) return;
    const s = clamp(spool, 0, 1);
    const slot = pool.acquire(now, 0.5, 2.5);
    if (!slot) return;
    const actx = this.actx;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.setGain(0.35 + s * 0.5, now, 0.004);
    const src = actx.createBufferSource();
    src.buffer = this.k.buffers.white;
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.6;
    bp.frequency.setValueAtTime(3600 + s * 2600, now);
    bp.frequency.exponentialRampToValueAtTime(900, now + 0.3);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.30 * (0.4 + s), now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.34);
    src.connect(bp); bp.connect(g); g.connect(slot.voice.input);
    src.start(now, Math.random() * 4); src.stop(now + 0.45);
    slot.nodes.push(src, bp, g);
  }

  /** Gear-change clunk for heavy vehicles. */
  gearClunk(x, y, z, now, strength = 0.5) {
    this.thump(strength * 0.5, x, y, z, now, 0.8);
  }

  /* -------------------------------------------------------------- frame ---- */

  update(dt, now) {
    // Scrape release
    if (now > this._scrapeDecay) this._scrapeLevel *= Math.exp(-6 * dt);
    setT(this.scrapeGain.gain, 0.22 * this._scrapeLevel, now, 0.04);

    const p = this._pending;
    for (let i = p.length - 1; i >= 0; i--) {
      if (p[i].t > now) continue;
      for (const n of p[i].nodes) { try { n.stop?.(); } catch { /* ended */ } n.disconnect(); }
      p.splice(i, 1);
    }
  }

  dispose() {
    for (const e of this._pending) {
      for (const n of e.nodes) { try { n.stop?.(); } catch { /* ended */ } n.disconnect(); }
    }
    this._pending.length = 0;
    for (const n of this.nodes) { try { n.stop?.(); } catch { /* not a source */ } n.disconnect(); }
    this.nodes.length = 0;
    this.scrapeVoice.dispose();
  }
}
