import './ui.css';

/**
 * Perf + state readout, and the harness the visual critic screenshots against.
 *
 * F1 toggles it (through `settings.showStats`, so the pause menu's switch and
 * the key agree), F2 toggles the physics debug view. The numbers are colour-
 * coded against the ARCHITECTURE.md budget so a regression is visible at a
 * glance instead of needing to be read.
 */

const BARS = 44;

export default class DevOverlay {
  static id = 'devOverlay';
  static label = 'Overlay';
  static deps = ['render'];

  async init(ctx) {
    const el = document.createElement('div');
    el.id = 'dev';
    el.innerHTML =
      '<div class="dv-h"><b>Boston</b><div class="dv-fps">--<i>FPS</i></div></div>' +
      row('frame') + row('draws') + row('tris') + row('mem') +
      row('pos') + row('clock') + row('quality') +
      '<div class="dv-bars"></div>' +
      '<div class="dv-hint">F1 stats / F2 physics / F3 hud</div>';
    document.body.appendChild(el);

    this.el = el;
    this.fpsEl = el.querySelector('.dv-fps');
    this.vals = {};
    for (const r of el.querySelectorAll('.dv-r')) this.vals[r.dataset.k] = r.querySelector('b');

    const barBox = el.querySelector('.dv-bars');
    this.bars = [];
    this.hist = new Float32Array(BARS).fill(60);
    for (let i = 0; i < BARS; i++) {
      const b = document.createElement('i');
      b.style.height = '100%';
      barBox.appendChild(b);
      this.bars.push(b);
    }

    this._t = 0;
    this._shown = null;
    this._off = ctx.bus.on('key:down', (c) => {
      if (c === 'F1') ctx.settings.showStats = !ctx.settings.showStats;
      if (c === 'F2') { const p = ctx.get('physics'); if (p) p.debugEnabled = !p.debugEnabled; }
    });

    // Expose for the automated critic harness.
    window.__BOSTON__ = ctx.engine;
  }

  update(dt, ctx) {
    const show = ctx.settings.showStats !== false;
    if (show !== this._shown) { this._shown = show; this.el.style.display = show ? '' : 'none'; }
    if (!show) return;

    this._t += dt;
    if (this._t < 0.2) return;
    this._t = 0;

    const p = ctx.engine.perf, c = ctx.camera.position, r = ctx.engine.renderer;
    const h = ctx.time.timeOfDay;
    const hh = String(Math.floor(h)).padStart(2, '0');
    const mm = String(Math.floor((h % 1) * 60)).padStart(2, '0');

    const f = p.fps.toFixed(0);
    if (this.fpsEl.__v !== f) {
      this.fpsEl.__v = f;
      this.fpsEl.innerHTML = f + '<i>FPS</i>';
      const cls = 'dv-fps' + (p.fps >= 57 ? '' : p.fps >= 45 ? ' warn' : ' bad');
      if (this.fpsEl.className !== cls) this.fpsEl.className = cls;
    }

    this._set('frame', p.ms.toFixed(1) + ' ms', p.ms > 16.7);
    this._set('draws', String(p.drawCalls), p.drawCalls >= 1200);
    this._set('tris', (p.tris / 1e6).toFixed(2) + 'M', p.tris >= 3.5e6);
    this._set('mem', (r ? r.info.memory.geometries : 0) + ' geo / ' + (r ? r.info.memory.textures : 0) + ' tex', false);
    this._set('pos', c.x.toFixed(0) + ' ' + c.y.toFixed(0) + ' ' + c.z.toFixed(0), false);
    this._set('clock', hh + ':' + mm + '  ' + ctx.settings.weather, false);
    this._set('quality', ctx.settings.preset, false);

    // Rolling frame-rate history. Transform-only writes, so no layout.
    const hist = this.hist;
    hist.copyWithin(0, 1);
    hist[BARS - 1] = p.fps;
    for (let i = 0; i < BARS; i++) {
      const v = Math.max(0.04, Math.min(1, hist[i] / 72)).toFixed(3);
      const b = this.bars[i];
      if (b.__t !== v) { b.__t = v; b.style.transform = 'scaleY(' + v + ')'; }
      const col = hist[i] >= 57 ? '#4f9e75' : hist[i] >= 45 ? '#b0913f' : '#a04a44';
      if (b.__c !== col) { b.__c = col; b.style.background = col; }
    }
  }

  _set(k, v, over) {
    const n = this.vals[k];
    if (!n) return;
    if (n.__v !== v) { n.__v = v; n.textContent = v; }
    const cls = over ? 'over' : '';
    if (n.__cls !== cls) { n.__cls = cls; n.className = cls; }
  }

  dispose() {
    this._off?.();
    this.el?.remove();
  }
}

function row(k) {
  return '<div class="dv-r" data-k="' + k + '"><span>' + k + '</span><b>--</b></div>';
}
