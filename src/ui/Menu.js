import { uiRoot, el, setText, setClass, DISTRICT_NAMES } from './HUD.js';

/**
 * Pause menu (Esc) and full-screen map (M).
 *
 * Both are modals over the live frame — the engine keeps rendering so the
 * backdrop blur has something to chew on, but the world clock and the camera
 * rig are frozen and `game:paused` is broadcast for gameplay systems.
 *
 * Settings write straight through to `src/core/Settings.js` and fire the events
 * other systems already listen for (`quality:changed`, `weather:set`), so this
 * screen is a usable tuning tool for the whole team, not just chrome.
 */

const WEATHERS = ['clear', 'overcast', 'rain', 'storm', 'fog', 'snow'];
const TIME_FLOW = [['Frozen', 0], ['Slow', 10], ['Normal', 40], ['Fast', 160]];

const KEYMAP = [
  ['Move', 'W A S D'], ['Sprint', 'Shift'], ['Jump / Brake', 'Space'], ['Crouch', 'C'],
  ['Enter / exit vehicle', 'F'], ['Interact', 'E'], ['Fire', 'LMB'], ['Aim', 'RMB'],
  ['Reload', 'R'], ['Horn', 'H'], ['Headlights', 'L'], ['Camera', 'V'],
  ['Shift up / down', 'Q / Z'], ['Map', 'M'], ['Pause', 'Esc or P'], ['Fullscreen', 'Pause menu'],
  ['Minimap north lock', 'N'], ['Toggle HUD', 'F3'], ['Perf overlay', 'F1'], ['Physics debug', 'F2'],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hhmm = (h) => `${String(Math.floor(h % 24)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

export default class Menu {
  static id = 'menu';
  static label = 'Menu';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.root = uiRoot();
    this.layer = el('div', 'modal-layer', this.root);
    this.open = null;          // 'pause' | 'map' | null
    this.rows = [];
    this.cursor = 0;
    this._statT = 0;
    this._mapT = 0;
    this._mapDirty = true;
    this._mv = { cx: 0, cz: 0, mppx: 2.4 };
    this._drag = null;
    this._cursorWorld = { x: 0, z: 0 };

    this._buildPause();
    this._buildMap();

    this._off = [
      ctx.bus.on('key:down', (c) => this._key(c)),
      ctx.bus.on('resize', () => { this._mapDirty = true; this._sizeMap(); }),
      ctx.bus.on('map:waypointSet', () => { this._mapDirty = true; }),
    ];
    window.__menu = this;
  }

  /* ------------------------------------------------------------- pause UI --- */

  _buildPause() {
    const mo = el('div', 'mo pause', this.layer);
    const wrap = el('div', 'wrap', mo);

    const top = el('div', 'top', wrap);
    const brand = el('div', 'brand', top);
    el('h1', null, brand, 'BOSTON');
    el('div', 'tag', brand, 'Paused');
    const meta = el('div', 'meta', top);
    this.metaTime = this._meta(meta, 'Local time');
    this.metaWx = this._meta(meta, 'Weather');
    this.metaWhere = this._meta(meta, 'Location');

    const body = el('div', 'body', wrap);
    const tabs = el('div', 'tabs', body);
    const pane = el('div', 'pane', body);

    this.tabDefs = [
      { id: 'map', label: 'Map', hint: 'M', action: () => { this._close(); this._openMap(); } },
      { id: 'stats', label: 'Stats', hint: 'F1' },
      { id: 'settings', label: 'Settings' },
      { id: 'controls', label: 'Controls' },
      { id: 'fullscreen', label: 'Fullscreen', hint: '\u21F1', action: () => this._toggleFullscreen() },
      { id: 'resume', label: 'Resume', hint: 'Esc / P', danger: true, action: () => this._close() },
    ];
    this.tabEls = {}; this.paneEls = {};
    for (const t of this.tabDefs) {
      const e = el('div', 'tab' + (t.danger ? ' danger' : ''), tabs);
      el('span', null, e, t.label);
      if (t.hint) el('span', 'n', e, t.hint);
      e.onclick = () => (t.action ? t.action() : this._tab(t.id));
      e.onmouseenter = () => { if (!t.action) this._tab(t.id); };
      this.tabEls[t.id] = e;
      if (!t.action) this.paneEls[t.id] = el('div', 'p', pane);
    }

    this._buildSettings(this.paneEls.settings);
    this._buildStats(this.paneEls.stats);
    this._buildControls(this.paneEls.controls);

    const foot = el('div', 'foot', wrap);
    foot.innerHTML =
      '<div><kbd>&uarr; &darr;</kbd>Navigate</div>' +
      '<div><kbd>&larr; &rarr;</kbd>Adjust</div>' +
      '<div><kbd>Enter</kbd>Select</div>' +
      '<div><kbd>M</kbd>Map</div>' +
      '<div><kbd>Esc</kbd> / <kbd>P</kbd>Resume</div>';

    this.pauseEl = mo;
    this._tab('settings');
  }

  _meta(parent, k) {
    const d = el('div', null, parent);
    el('div', 'k', d, k);
    return el('div', 'v', d, '—');
  }

  _buildControls(pane) {
    const g = el('div', 'grp', pane);
    el('h3', null, g, 'Keyboard & mouse');
    const keys = el('div', 'keys', g);
    for (const [a, k] of KEYMAP) {
      const d = el('div', null, keys);
      el('span', null, d, a);
      el('b', null, d, k);
    }
    const g2 = el('div', 'grp', pane);
    el('h3', null, g2, 'Gamepad');
    el('div', 'plist', g2,
      'Left stick <b>move / steer</b>  ·  Right stick <b>look</b>  ·  RT <b>throttle</b>  ·  LT <b>brake</b>' +
      '<br>A standard-mapping controller is picked up automatically on first input.');
  }

  _buildStats(pane) {
    const g = el('div', 'grp', pane);
    el('h3', null, g, 'Frame');
    const grid = el('div', 'sgrid', g);
    this.stat = {};
    const mk = (key, label) => {
      const d = el('div', 'stat', grid);
      el('div', 'k', d, label);
      const v = el('div', 'v num', d, '—');
      this.stat[key] = d; this.stat[key + 'V'] = v;
    };
    mk('fps', 'Frames / sec'); mk('ms', 'Frame time');
    mk('draws', 'Draw calls'); mk('tris', 'Triangles');
    mk('geo', 'Geometries'); mk('tex', 'Textures');
    mk('prog', 'Shaders'); mk('sys', 'Systems');

    const g2 = el('div', 'grp', pane);
    el('h3', null, g2, 'World');
    this.statWorld = el('div', 'plist', g2, '');
    const g3 = el('div', 'grp', pane);
    el('h3', null, g3, 'Budget (ARCHITECTURE.md)');
    el('div', 'plist', g3,
      '60 fps @ 1920x1080  ·  <b>&lt; 1200</b> draw calls  ·  <b>&lt; 3.5M</b> triangles  ·  <b>&lt; 1.5 GB</b> GPU');
  }

  /* -------------------------------------------------------------- settings --- */

  _buildSettings(pane) {
    const s = this.ctx.settings, bus = this.ctx.bus, engine = this.ctx.engine;
    this.rowsAll = [];

    const gfx = this._grp(pane, 'Graphics');
    this.rQuality = this._seg(gfx, 'Quality preset', 'Shadow resolution, SSAO/SSR, draw distance, crowd density.',
      ['low', 'medium', 'high', 'ultra'], () => s.preset,
      (v) => { s.apply(v); bus.emit('quality:changed'); this._syncAll(); });
    this.rFov = this._slider(gfx, 'Field of view', 'Vertical FOV in degrees. 62 is the shipping default.',
      45, 100, 1, () => s.fov, (v) => { s.fov = v; }, (v) => v.toFixed(0) + '°');
    this.rExp = this._slider(gfx, 'Exposure', 'Scene exposure before the AgX tone map.',
      0.3, 2.2, 0.05, () => s.exposure, (v) => { s.exposure = v; }, (v) => v.toFixed(2));

    const wld = this._grp(pane, 'World');
    this.rTod = this._slider(wld, 'Time of day', 'Drives sun angle, sky, street lights and window emissives.',
      0, 23.99, 0.25, () => s.timeOfDay,
      (v) => { s.timeOfDay = v; engine.time.timeOfDay = v; }, hhmm);
    this.rFlow = this._seg(wld, 'Time flow', 'Game-seconds per real second. Freeze for repeatable shots.',
      TIME_FLOW.map(t => t[0]), () => (TIME_FLOW.find(t => t[1] === s.timeScale) || TIME_FLOW[2])[0],
      (v) => { s.timeScale = (TIME_FLOW.find(t => t[0] === v) || TIME_FLOW[2])[1]; this._paused = false; });
    this.rWx = this._seg(wld, 'Weather', 'Overrides the weather system until it is changed again.',
      WEATHERS, () => s.weather, (v) => { s.weather = v; bus.emit('weather:set', v); });

    const inp = this._grp(pane, 'Controls');
    this.rSens = this._slider(inp, 'Mouse sensitivity', 'Multiplier on raw pointer delta.',
      0.1, 3, 0.05, () => s.mouseSensitivity, (v) => { s.mouseSensitivity = v; bus.emit('input:changed'); },
      (v) => v.toFixed(2) + '×');
    this.rInv = this._toggle(inp, 'Invert vertical look', 'Pull down to look up.',
      () => s.invertY, (v) => { s.invertY = v; bus.emit('input:changed'); });

    const aud = this._grp(pane, 'Audio');
    this.rVol = this._slider(aud, 'Master volume', 'Applies to every audio bus.',
      0, 1, 0.01, () => s.masterVolume, (v) => { s.masterVolume = v; bus.emit('audio:volume', v); },
      (v) => Math.round(v * 100) + '%');

    const ui = this._grp(pane, 'Interface');
    this.rHud = this._slider(ui, 'HUD scale', 'Scales the whole interface. 4K displays already get a boost.',
      0.7, 1.45, 0.05, () => +(this.root.style.getPropertyValue('--hs') || 1),
      (v) => this.root.style.setProperty('--hs', String(v)), (v) => Math.round(v * 100) + '%');
    this.rNorth = this._toggle(ui, 'Lock minimap to north', 'Otherwise the map rotates with your heading.',
      () => !!this.ctx.get('minimap')?.northLock, (v) => this.ctx.get('minimap')?.setNorthLock(v));
    this.rShowHud = this._toggle(ui, 'Show HUD', 'Hide everything for a clean screenshot.',
      () => this.ctx.get('hud')?.hudEl?.style.display !== 'none', (v) => this.ctx.get('hud')?.setVisible(v));
    this.rShowStats = this._toggle(ui, 'Performance overlay', 'The F1 readout.',
      () => !!s.showStats, (v) => { s.showStats = v; });
  }

  _grp(pane, title) {
    const g = el('div', 'grp', pane);
    el('h3', null, g, title);
    return g;
  }

  _row(grp, label, desc) {
    const r = el('div', 'row', grp);
    const l = el('div', null, r);
    el('div', 'lab', l, label);
    if (desc) el('div', 'des', l, desc);
    const c = el('div', 'ctl', r);
    return { r, c };
  }

  _seg(grp, label, desc, opts, get, set) {
    const { r, c } = this._row(grp, label, desc);
    const box = el('div', 'seg', c);
    const btns = opts.map(o => {
      const b = el('button', null, box, String(o).toUpperCase());
      b.onclick = () => { set(o); this._syncAll(); };
      return b;
    });
    const ctl = {
      r, sync: () => { const v = get(); btns.forEach((b, i) => setClass(b, 'sel', opts[i] === v)); },
      nudge: (d) => { const i = opts.indexOf(get()); set(opts[clamp(i + d, 0, opts.length - 1)]); this._syncAll(); },
      activate: () => ctl.nudge(1),
    };
    r.__ctl = ctl; this.rowsAll.push(ctl);
    return ctl;
  }

  _slider(grp, label, desc, min, max, step, get, set, fmt) {
    const { r, c } = this._row(grp, label, desc);
    const s = el('div', 'sld', c);
    el('div', 'trk', s).appendChild(el('div', 'fil'));
    const fil = s.querySelector('.fil');
    const knb = el('div', 'knb', s);
    const val = el('div', 'val num', c, '');
    const at = (clientX) => {
      const b = s.getBoundingClientRect();
      const t = clamp((clientX - b.left) / Math.max(1, b.width), 0, 1);
      set(Math.round((min + t * (max - min)) / step) * step);
      ctl.sync();
    };
    s.onpointerdown = (e) => { s.setPointerCapture(e.pointerId); at(e.clientX); this._drag = at; };
    s.onpointermove = (e) => { if (this._drag === at) at(e.clientX); };
    s.onpointerup = () => { this._drag = null; };
    const ctl = {
      r, sync: () => {
        const v = clamp(get(), min, max);
        const t = (v - min) / (max - min);
        fil.style.transform = `scaleX(${t.toFixed(4)})`;
        knb.style.left = (t * 100).toFixed(2) + '%';
        setText(val, fmt ? fmt(v) : String(v));
      },
      nudge: (d) => { set(clamp(Math.round((get() + d * step) / step) * step, min, max)); ctl.sync(); },
      activate: () => {},
    };
    r.__ctl = ctl; this.rowsAll.push(ctl);
    return ctl;
  }

  _toggle(grp, label, desc, get, set) {
    const { r, c } = this._row(grp, label, desc);
    const t = el('div', 'tgl', c);
    el('i', null, t);
    t.onclick = () => { set(!get()); this._syncAll(); };
    const ctl = {
      r, sync: () => setClass(t, 'on', !!get()),
      nudge: (d) => { set(d > 0); this._syncAll(); },
      activate: () => { set(!get()); this._syncAll(); },
    };
    r.__ctl = ctl; this.rowsAll.push(ctl);
    return ctl;
  }

  _syncAll() { for (const c of this.rowsAll) c.sync(); }

  /* ------------------------------------------------------------- map modal --- */

  _buildMap() {
    const mo = el('div', 'mo map', this.layer);
    const wrap = el('div', 'map-wrap', mo);
    this.mapCv = el('canvas', null, wrap);
    this.mapG = this.mapCv.getContext('2d');
    this.mapWrap = wrap;

    const hud = el('div', 'map-hud', mo);
    const top = el('div', 'mh-top', hud);
    const t = el('div', 'map-t', top);
    el('h2', null, t, 'BOSTON');
    el('span', null, t, 'City Map');
    this.mapRead = el('div', 'map-read card', top, '');

    const zoom = el('div', 'map-zoom', mo);
    const zi = el('button', null, zoom, '+');
    const zo = el('button', null, zoom, '−');
    zi.onclick = () => this._zoom(0.7);
    zo.onclick = () => this._zoom(1 / 0.7);

    const bot = el('div', 'mh-bot', hud);
    const lg = el('div', 'map-legend card', bot);
    const item = (cls, style, label) => {
      const d = el('div', null, lg);
      const i = el('i', cls, d);
      Object.assign(i.style, style);
      el('span', null, d, label);
    };
    item('', { background: '#e8b552' }, 'Highway');
    item('', { background: '#5c6878' }, 'Arterial');
    item('', { background: '#414a57' }, 'Street');
    item('dot', { background: '#0c1b2c', border: '1px solid rgba(96,150,200,.5)' }, 'Water');
    item('dot', { background: '#16261b', border: '1px solid rgba(120,200,140,.35)' }, 'Park');
    item('dot', { background: '#ff4fa3' }, 'Waypoint');
    item('dot', { background: '#ffc247' }, 'Objective');
    item('dot', { background: '#3ea0ff' }, 'GPS route');
    const hint = el('div', 'map-read card', bot,
      '<b>Drag</b> pan &nbsp; <b>Wheel</b> zoom<br><b>Click</b> set waypoint &nbsp; <b>Right-click</b> clear<br><b>Esc / M</b> close');
    hint.style.textAlign = 'right';

    // Interaction
    let downX = 0, downY = 0, moved = 0, panning = false;
    wrap.onpointerdown = (e) => {
      if (e.button === 2) return;
      wrap.setPointerCapture(e.pointerId);
      panning = true; moved = 0; downX = e.clientX; downY = e.clientY;
      wrap.classList.add('drag');
    };
    wrap.onpointermove = (e) => {
      const b = this.mapCv.getBoundingClientRect();
      this._cursorWorld.x = this._mv.cx + (e.clientX - b.left - b.width / 2) * this._mv.mppx;
      this._cursorWorld.z = this._mv.cz + (e.clientY - b.top - b.height / 2) * this._mv.mppx;
      if (!panning) { this._readout(); return; }
      const dx = e.clientX - downX, dy = e.clientY - downY;
      moved += Math.abs(dx) + Math.abs(dy);
      this._mv.cx -= dx * this._mv.mppx;
      this._mv.cz -= dy * this._mv.mppx;
      downX = e.clientX; downY = e.clientY;
      this._mapDirty = true;
    };
    wrap.onpointerup = (e) => {
      wrap.classList.remove('drag');
      if (panning && moved < 5) {
        const b = this.mapCv.getBoundingClientRect();
        const x = this._mv.cx + (e.clientX - b.left - b.width / 2) * this._mv.mppx;
        const z = this._mv.cz + (e.clientY - b.top - b.height / 2) * this._mv.mppx;
        this.ctx.get('minimap')?.setWaypoint(x, z);
        this.ctx.bus.emit('hud:notify', { kind: 'info', title: 'Waypoint set', text: this._placeName(x, z), duration: 3 });
        this._mapDirty = true;
      }
      panning = false;
    };
    wrap.oncontextmenu = (e) => {
      e.preventDefault();
      this.ctx.get('minimap')?.clearWaypoint();
      this._mapDirty = true;
    };
    wrap.onwheel = (e) => {
      e.preventDefault();
      const b = this.mapCv.getBoundingClientRect();
      const wx = this._mv.cx + (e.clientX - b.left - b.width / 2) * this._mv.mppx;
      const wz = this._mv.cz + (e.clientY - b.top - b.height / 2) * this._mv.mppx;
      const f = e.deltaY > 0 ? 1.16 : 1 / 1.16;
      const next = clamp(this._mv.mppx * f, 0.22, 9);
      const k = next / this._mv.mppx;
      this._mv.cx = wx + (this._mv.cx - wx) * k;
      this._mv.cz = wz + (this._mv.cz - wz) * k;
      this._mv.mppx = next;
      this._mapDirty = true;
    };

    this.mapEl = mo;
  }

  _zoom(f) {
    this._mv.mppx = clamp(this._mv.mppx * f, 0.22, 9);
    this._mapDirty = true;
  }

  _placeName(x, z) {
    const city = this.ctx.get('city');
    let d = null;
    try { d = city?.districtAt?.(x, z); } catch { /* half-built city */ }
    return d ? (DISTRICT_NAMES[d] || d) : `${x.toFixed(0)}, ${z.toFixed(0)}`;
  }

  _sizeMap() {
    if (this.open !== 'map') return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.mapCv.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (this.mapCv.width !== w || this.mapCv.height !== h) {
      this.mapCv.width = w; this.mapCv.height = h;
      this._mapDpr = dpr;
      this._mapDirty = true;
    }
  }

  _drawMap() {
    const mm = this.ctx.get('minimap');
    const map = mm?.map;
    const g = this.mapG, dpr = this._mapDpr || 1;
    const W = this.mapCv.width, H = this.mapCv.height;
    if (!W || !H) return;

    if (!this._base) this._base = document.createElement('canvas');
    if (this._base.width !== W || this._base.height !== H) {
      this._base.width = W; this._base.height = H; this._mapDirty = true;
    }

    if (this._mapDirty && map?.ready) {
      const bg = this._base.getContext('2d');
      bg.setTransform(1, 0, 0, 1, 0, 0);
      map.draw(bg, { cx: this._mv.cx, cz: this._mv.cz, mppx: this._mv.mppx / dpr, w: W, h: H, rot: 0 });
      this._drawLabels(bg, map, dpr, W, H);
      this._mapDirty = false;
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(this._base, 0, 0);

    // Overlay: route, blips, player. Redrawn every refresh, costs nothing.
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = W / dpr, ch = H / dpr, mppx = this._mv.mppx;
    const toS = (x, z) => [cw / 2 + (x - this._mv.cx) / mppx, ch / 2 + (z - this._mv.cz) / mppx];

    if (mm?.routePts?.length > 3) {
      const p = mm.routePts;
      g.beginPath();
      let s = toS(p[0], p[1]); g.moveTo(s[0], s[1]);
      for (let i = 2; i < p.length; i += 2) { s = toS(p[i], p[i + 1]); g.lineTo(s[0], s[1]); }
      g.lineJoin = g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 7; g.stroke();
      g.strokeStyle = '#3ea0ff'; g.lineWidth = 4.2; g.stroke();
      g.strokeStyle = 'rgba(200,230,255,.9)'; g.lineWidth = 1.3; g.stroke();
    }

    for (const b of (mm?.blips || [])) this._pin(g, toS(b.x, b.z), b.colour || '#ffc247', 'dot', b.label);
    if (mm?.waypoint) this._pin(g, toS(mm.waypoint.x, mm.waypoint.z), '#ff4fa3', 'wp', 'Waypoint');

    const pl = this.ctx.get('player');
    const pos = pl?.position || this.ctx.camera.position;
    const ps = toS(pos.x, pos.z);
    const head = mm ? mm._heading : 0;
    g.save();
    g.translate(ps[0], ps[1]); g.rotate(head);
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 6;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7.6, 9); g.lineTo(0, 4.6); g.lineTo(-7.6, 9); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    g.shadowBlur = 0; g.lineWidth = 1.4; g.strokeStyle = 'rgba(10,14,20,.9)'; g.stroke();
    g.restore();

    // Scale bar
    const target = 110;
    const metres = niceNumber(target * mppx);
    const px = metres / mppx;
    const bx = cw - 40 - px, by = ch - 34;
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(bx, by - 5); g.lineTo(bx, by); g.lineTo(bx + px, by); g.lineTo(bx + px, by - 5);
    g.stroke();
    g.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    g.fillStyle = 'rgba(255,255,255,.8)'; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 3;
    g.fillText(metres >= 1000 ? (metres / 1000) + ' km' : metres + ' m', bx + px / 2, by - 7);
    g.shadowBlur = 0;
  }

  _pin(g, s, col, kind, label) {
    g.save();
    g.translate(s[0], s[1]);
    g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 5;
    if (kind === 'wp') {
      g.beginPath();
      g.moveTo(0, 13); g.lineTo(-7.5, -2); g.lineTo(0, -13); g.lineTo(7.5, -2); g.closePath();
    } else {
      g.beginPath(); g.arc(0, 0, 6.5, 0, Math.PI * 2);
    }
    g.fillStyle = col; g.fill();
    g.shadowBlur = 0; g.lineWidth = 1.6; g.strokeStyle = 'rgba(0,0,0,.8)'; g.stroke();
    if (label) {
      g.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = 4;
      g.fillStyle = '#fff';
      g.fillText(label, 0, 16);
    }
    g.restore();
  }

  /** District names and — when zoomed in — street names along the road itself. */
  _drawLabels(g, map, dpr, W, H) {
    const mppx = this._mv.mppx / dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.9)';

    if (mppx < 1.9) {
      const seen = new Set();
      const scan = { x0: this._mv.cx - W / 2 * mppx, z0: this._mv.cz - H / 2 * mppx,
                     x1: this._mv.cx + W / 2 * mppx, z1: this._mv.cz + H / 2 * mppx };
      const roads = map.roadLayer.query(scan.x0, scan.z0, scan.x1, scan.z1);
      g.font = `600 ${(10 * dpr).toFixed(0)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      g.shadowBlur = 4 * dpr;
      for (const r of roads) {
        if (!r.name || r.cls > (mppx < 0.9 ? 2 : 1)) continue;
        const mid = (r.pts.length >> 2) * 2;
        const x = r.pts[mid], z = r.pts[mid + 1];
        const key = r.name + '|' + Math.round(x / (170 * mppx)) + ',' + Math.round(z / (170 * mppx));
        if (seen.has(key)) continue;
        seen.add(key);
        const sx = W / 2 + (x - this._mv.cx) / mppx, sy = H / 2 + (z - this._mv.cz) / mppx;
        if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        let a = 0;
        if (r.pts.length >= 4) {
          const i = Math.max(0, mid - 2);
          a = Math.atan2(r.pts[i + 3] - r.pts[i + 1], r.pts[i + 2] - r.pts[i]);
          if (a > Math.PI / 2) a -= Math.PI;
          if (a < -Math.PI / 2) a += Math.PI;
        }
        g.save(); g.translate(sx, sy); g.rotate(a);
        g.fillStyle = r.cls === 0 ? 'rgba(255,225,170,.92)' : 'rgba(226,236,246,.78)';
        g.fillText(r.name, 0, -6 * dpr);
        g.restore();
      }
    }

    for (const d of map.districts) {
      const sx = W / 2 + (d.x - this._mv.cx) / mppx, sy = H / 2 + (d.z - this._mv.cz) / mppx;
      if (sx < -100 || sy < -50 || sx > W + 100 || sy > H + 50) continue;
      const size = clamp(15 / Math.max(0.35, mppx) * 1.6, 12, 30) * dpr;
      g.font = `800 ${size.toFixed(0)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      g.shadowBlur = 8 * dpr;
      g.fillStyle = 'rgba(255,255,255,.34)';
      g.save(); g.translate(sx, sy);
      const txt = d.name.toUpperCase().split('').join(' ');
      g.fillText(txt, 0, 0);
      g.restore();
    }
    g.shadowBlur = 0;
  }

  _readout() {
    if (this.open !== 'map') return;
    const w = this._cursorWorld;
    const mm = this.ctx.get('minimap');
    const wp = mm?.waypoint;
    let dist = '';
    if (wp) {
      const pl = this.ctx.get('player');
      const p = pl?.position || this.ctx.camera.position;
      const d = Math.hypot(wp.x - p.x, wp.z - p.z);
      dist = `<br>waypoint <b>${d > 1000 ? (d / 1000).toFixed(2) + ' km' : d.toFixed(0) + ' m'}</b>`;
    }
    this.mapRead.innerHTML =
      `<b>${this._placeName(w.x, w.z)}</b><br>` +
      `x ${w.x.toFixed(0)}  z ${w.z.toFixed(0)}<br>` +
      `scale <b>${this._mv.mppx.toFixed(2)}</b> m/px${dist}`;
  }

  /* ------------------------------------------------------------ open/close --- */

  _key(code) {
    if (code === 'Escape' || code === 'KeyP') {
      // Both, deliberately. Escape is the browser's escape hatch first and ours
      // second: in fullscreen or pointer lock it may be consumed before we ever
      // see it, so `KeyP` is the binding that is always reachable.
      if (this.open) this._close(); else this._openPause();
      return;
    }
    if (code === 'KeyM') {
      if (this.open === 'map') this._close();
      else { if (this.open) this._close(); this._openMap(); }
      return;
    }
    if (this.open !== 'pause') return;
    const rows = this.rows;
    if (code === 'ArrowDown') { this.cursor = clamp(this.cursor + 1, 0, rows.length - 1); this._cursor(); }
    else if (code === 'ArrowUp') { this.cursor = clamp(this.cursor - 1, 0, rows.length - 1); this._cursor(); }
    else if (code === 'ArrowLeft') rows[this.cursor]?.nudge(-1);
    else if (code === 'ArrowRight') rows[this.cursor]?.nudge(1);
    else if (code === 'Enter' || code === 'Space') rows[this.cursor]?.activate();
    else if (code === 'Tab') {
      const order = this.tabDefs.filter(t => !t.action);
      const j = (order.findIndex(t => t.id === this._tabId) + 1) % order.length;
      this._tab(order[j].id);
    }
  }

  _tab(id) {
    if (!this.paneEls[id]) return;
    this._tabId = id;
    for (const t of this.tabDefs) {
      setClass(this.tabEls[t.id], 'sel', t.id === id);
      if (this.paneEls[t.id]) setClass(this.paneEls[t.id], 'sel', t.id === id);
    }
    this.rows = id === 'settings' ? this.rowsAll.slice() : [];
    this.cursor = 0;
    this._cursor();
    if (id === 'settings') this._syncAll();
    if (id === 'stats') this._stats();
  }

  _cursor() {
    for (let i = 0; i < this.rowsAll.length; i++) {
      setClass(this.rowsAll[i].r, 'cur', this.rows[this.cursor] === this.rowsAll[i]);
    }
    if (this.open === 'pause') this.rows[this.cursor]?.r.scrollIntoView({ block: 'nearest' });
  }

  _openPause() {
    this._show(this.pauseEl); this.open = 'pause';
    this._syncAll(); this._tab(this._tabId || 'settings');
    this._pause(true);
  }
  _openMap() {
    this._show(this.mapEl); this.open = 'map';
    const pl = this.ctx.get('player');
    const p = pl?.position || this.ctx.camera.position;
    this._mv.cx = p.x; this._mv.cz = p.z;
    this._mapDirty = true;
    this._pause(true);
    requestAnimationFrame(() => { this._sizeMap(); this._readout(); });
  }
  /**
   * Enter or leave browser fullscreen.
   *
   * Boston had no fullscreen control at all, so the only way in or out was the
   * browser's own chrome -- which is why Escape felt ambiguous: it could drop
   * pointer lock, leave fullscreen, open this menu, or some combination, and the
   * player could not tell which. This gives fullscreen an explicit control, and
   * `Input` observes `fullscreenchange` so the game never holds a stale idea of
   * the state. It deliberately does NOT re-request pointer lock afterwards; a
   * click on the canvas does that.
   */
  _toggleFullscreen() {
    const doc = document, el = doc.documentElement;
    const active = doc.fullscreenElement || doc.webkitFullscreenElement;
    try {
      if (active) (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
      else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } catch { /* a rejected request is the browser's call, not an error state */ }
  }

  _show(mo) {
    mo.classList.remove('close');
    mo.classList.add('open');
    this.root.classList.add('modal');
    document.exitPointerLock?.();
  }
  _close() {
    if (!this.open) return;
    const mo = this.open === 'map' ? this.mapEl : this.pauseEl;
    mo.classList.remove('open');
    mo.classList.add('close');
    setTimeout(() => mo.classList.remove('close'), 240);
    this.root.classList.remove('modal');
    this.open = null;
    this._pause(false);
  }

  /** Freeze the world clock and the camera; broadcast for gameplay systems. */
  _pause(on) {
    const s = this.ctx.settings;
    if (on) {
      if (this._paused) return;
      this._paused = true;
      this._prevScale = s.timeScale;
      s.timeScale = 0;
      const rig = this.ctx.get('cameraRig');
      if (rig && rig.enabled) { this._rigWas = true; rig.enabled = false; }
    } else {
      if (!this._paused) return;
      this._paused = false;
      if (s.timeScale === 0 && this._prevScale != null) s.timeScale = this._prevScale;
      const rig = this.ctx.get('cameraRig');
      if (rig && this._rigWas) { rig.enabled = true; this._rigWas = false; }
    }
    this.ctx.bus.emit('game:paused', on);
  }

  /* ------------------------------------------------------------------ loop --- */

  update(dt) {
    if (!this.open) return;
    if (this.open === 'map') {
      this._mapT -= dt;
      if (this._mapT <= 0) { this._mapT = 0.1; this._sizeMap(); this._drawMap(); this._readout(); }
      return;
    }
    this._statT -= dt;
    if (this._statT <= 0) {
      this._statT = 0.25;
      const s = this.ctx.settings;
      setText(this.metaTime, hhmm(s.timeOfDay));
      setText(this.metaWx, s.weather.charAt(0).toUpperCase() + s.weather.slice(1));
      const p = this.ctx.get('player')?.position || this.ctx.camera.position;
      setText(this.metaWhere, this._placeName(p.x, p.z));
      if (this._tabId === 'stats') this._stats();
    }
  }

  _stats() {
    const e = this.ctx.engine, p = e.perf, r = e.renderer;
    const S = this.stat;
    setText(S.fpsV, p.fps.toFixed(0));
    S.fps.className = 'stat ' + (p.fps >= 58 ? 'good' : p.fps >= 45 ? 'warn' : 'bad');
    setText(S.msV, p.ms.toFixed(2));
    S.ms.className = 'stat ' + (p.ms <= 16.7 ? 'good' : p.ms <= 22 ? 'warn' : 'bad');
    setText(S.drawsV, String(p.drawCalls));
    S.draws.className = 'stat ' + (p.drawCalls < 1200 ? 'good' : 'bad');
    setText(S.trisV, (p.tris / 1e6).toFixed(2) + 'M');
    S.tris.className = 'stat ' + (p.tris < 3.5e6 ? 'good' : 'bad');
    setText(S.geoV, String(r?.info.memory.geometries ?? 0));
    setText(S.texV, String(r?.info.memory.textures ?? 0));
    setText(S.progV, String(r?.info.programs?.length ?? 0));
    setText(S.sysV, String(e.order.length));
    const pos = this.ctx.get('player')?.position || this.ctx.camera.position;
    const mm = this.ctx.get('minimap')?.map;
    this.statWorld.innerHTML =
      `position <b>${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)}</b><br>` +
      `district <b>${this._placeName(pos.x, pos.z)}</b><br>` +
      `map source <b>${mm ? (mm.synthetic ? 'lattice fallback' : 'city road graph') : 'none'}</b> ` +
      `(${mm?.roads.length ?? 0} segments, ${mm?.blocks.length ?? 0} footprints)<br>` +
      `systems <b>${e.order.map(s => s.constructor.id).join(', ')}</b>`;
  }

  dispose() {
    this._off?.forEach(f => f());
    this.layer?.remove();
    if (window.__menu === this) delete window.__menu;
  }
}

function niceNumber(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
