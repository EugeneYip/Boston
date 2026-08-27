import './ui.css';

/**
 * BOSTON HUD.
 *
 * Owns every diegetic 2D element except the minimap (Minimap.js) and the
 * pause/map modals (Menu.js), plus the shared UI root those two mount into.
 *
 * Design constraints, in order of importance:
 *  1. Nothing rebuilds DOM per frame. Text nodes are written only when the
 *     *rendered string* changes; everything that moves, moves on a transform.
 *  2. The only canvas is the vehicle dial, whose static face is pre-rendered
 *     once per resize and blitted; per frame we stroke one arc and one needle.
 *  3. Every consumer contract is optional. `player`, `vehicles`, `city` and the
 *     mission system may all be missing — the HUD degrades to whatever it has.
 */

export const MPS_TO_MPH = 2.2369362920544;

/** Pretty district names, keyed by the ids in CONTRACTS.md `city.districtAt`. */
export const DISTRICT_NAMES = {
  backBay: 'Back Bay', beaconHill: 'Beacon Hill', northEnd: 'North End',
  financial: 'Financial District', fenway: 'Fenway', seaport: 'Seaport',
  southEnd: 'South End', charlestown: 'Charlestown', cambridge: 'Cambridge',
  water: 'Boston Harbor', park: 'Parkland',
};

let _rootBound = false;

/**
 * The shared UI root. Created on first call by whichever UI system inits first,
 * so Minimap/Menu do not depend on HUD having been registered.
 * @returns {HTMLElement}
 */
export function uiRoot() {
  let root = document.getElementById('boston-ui');
  if (!root) {
    root = document.createElement('div');
    root.id = 'boston-ui';
    document.body.appendChild(root);
  }
  if (!_rootBound) {
    _rootBound = true;
    const apply = () => {
      const w = window.innerWidth, h = window.innerHeight;
      // Uniform scale off the smaller axis, softened so 4K doesn't get a
      // cartoonishly large HUD and 720p stays legible.
      const base = Math.min(w / 1920, h / 1080);
      const s = Math.min(2.0, Math.max(0.66, Math.pow(base, 0.78)));
      root.style.setProperty('--s', s.toFixed(4));
      // Ultrawide: pull the corners in so the HUD isn't in the player's periphery.
      const extra = Math.max(0, (w - h * 2.0) * 0.16);
      root.style.setProperty('--pad-x', (24 * s + extra).toFixed(1) + 'px');
      root.style.setProperty('--pad-y', (22 * s).toFixed(1) + 'px');
      root.dispatchEvent(new CustomEvent('ui:scale'));
    };
    apply();
    window.addEventListener('resize', apply);
  }
  return root;
}

/** Terse DOM builder — the HUD tree is built once, at init. */
export function el(tag, cls, parent, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  if (parent) parent.appendChild(n);
  return n;
}

/** Write a text node only when it actually changed. The whole point of the HUD budget. */
export function setText(n, v) {
  if (n.__v !== v) { n.__v = v; n.textContent = v; }
}
/** Same idea for classes. */
export function setClass(n, cls, on) {
  const k = '__c_' + cls;
  if (n[k] === on) return;
  n[k] = on; n.classList.toggle(cls, on);
}

const STAR_D = 'M12 2.2 15.09 8.86 22.4 9.72 17 14.7 18.44 21.9 12 18.3 5.56 21.9 7 14.7 1.6 9.72 8.91 8.86Z';

const ICONS = {
  info:    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z',
  money:   'M12 1v3.2c2.9.2 4.9 1.7 5.1 4.1h-2.7c-.2-1-1-1.8-2.4-1.9v3.9c3.1.7 4.9 1.8 4.9 4.3 0 2.5-1.9 4.1-4.9 4.4V23h-1.6v-3.1C7.2 19.7 5.1 18.1 5 15.4h2.8c.2 1.2 1.1 2 2.6 2.2v-4.2C7.6 12.8 5.6 11.7 5.6 9.2c0-2.4 1.9-3.9 4.8-4.1V2zm-1.6 6.4c-1.2.2-1.9.8-1.9 1.7 0 .8.5 1.3 1.9 1.7zm1.6 6v3.6c1.3-.2 2-.8 2-1.8 0-.9-.6-1.4-2-1.8z',
  pickup:  'M12 2 3 6.5v11L12 22l9-4.5v-11zm0 2.2 6.4 3.2L12 10.6 5.6 7.4zM5 9.3l6 3v7.1l-6-3zm14 0v7.1l-6 3v-7.1z',
  phone:   'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4V5a2 2 0 0 1 2-2zm3 5v2h10V8zm0 4v2h7v-2z',
  warn:    'M12 2 1.5 21h21zm-1 6h2v7h-2zm0 9h2v2h-2z',
  mission: 'M5 2v20h2v-8h9.4l-1.6-4 1.6-4H7V2z',
  star:    STAR_D,
};

/** Tach geometry, in the dial's own 250x118 design units. */
const DIAL = {
  W: 250, H: 118,
  CX: 192, CY: 56, R: 40,
  A0: Math.PI * (150 / 180),      // lower-left
  SW: Math.PI * (240 / 180),      // sweep, clockwise through the top
  RED: 0.80,
  FONT: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const WEAPON_SVG ='<svg viewBox="0 0 48 24"><path d="M2 6h30v3h-4l-1.6 3.4H20L18 18h-6v-6H4a2 2 0 0 1-2-2zm34 0h10v3H36zM12 12h5v4l-2.2 4H12z"/></svg>';

export default class HUD {
  static id = 'hud';
  static label = 'HUD';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.root = uiRoot();

    /** Read by Minimap.js to draw the health/armour ring. 0..1 each. */
    this.vitals = { health: 1, armour: 0, stamina: 1 };
    /** Read/written by the gameplay agent; drives the reticle. */
    this.aim = { visible: false, spread: 0, hot: false };

    this._veh = null;
    this._wanted = -1;
    this._money = null;
    this._moneyShown = 0;
    this._district = null;
    this._street = null;
    this._notes = [];
    this._subT = 0;
    this._objOn = false;
    this._t = 0;
    this._streetT = 0;
    this._ndl = { p: 0, v: 0 };
    this._spdSm = 0;
    this._retSp = 0;
    this._dpr = 1;

    this._build();
    this._bind(ctx);
    this._resize();

    window.__hud = this;   // debugging + a hook for other agents' smoke tests
  }

  // ---------------------------------------------------------------- build ---
  _build() {
    const hud = el('div', 'hud', this.root);
    this.hudEl = hud;

    // --- top right: money, stars, feed ---
    const tr = el('div', 'tr', hud);
    const money = el('div', 'money', tr);
    el('i', null, money, '$');
    this.moneyN = el('b', 'num', money, '0');
    this.moneyD = el('div', 'money-d num', money, '');
    this.moneyEl = money;

    const stars = el('div', 'stars', tr);
    this.starEls = [];
    for (let i = 0; i < 5; i++) {
      const s = el('i', null, stars,
        `<svg viewBox="0 0 24 24"><path class="edge" d="${STAR_D}"/><path class="fill" d="${STAR_D}"/></svg>`);
      this.starEls.push(s);
    }
    this.starsEl = stars;
    this.feedEl = el('div', 'feed', tr);

    // --- bottom left: street + objective (sits to the right of the minimap) ---
    const bl = el('div', 'bl', hud);
    const st = el('div', 'street', bl);
    this.districtN = el('div', 'd', st, '');
    this.streetN = el('div', 's', st, '');
    const obj = el('div', 'obj', bl);
    el('div', 'bar', obj);
    const otx = el('div', null, obj);
    this.objT = el('div', 't', otx, 'Objective');
    this.objB = el('div', 'b', otx, '');
    this.objEl = obj;

    // --- bottom right: dials + weapon ---
    const br = el('div', 'br', hud);
    const dash = el('div', 'dash', br);
    this.dashCv = el('canvas', null, dash);
    const read = el('div', 'read', dash);
    this.spdN = el('div', 'spd num', read, '0');
    el('div', 'unit', read, 'mph');
    this.gearN = el('div', 'gear n', dash, 'N');
    const tell = el('div', 'tell', dash);
    this.tellLights = el('b', 'lights', tell);
    this.tellSiren = el('b', 'siren', tell);
    this.dashEl = dash;

    const wep = el('div', 'wep card', br);
    el('div', 'g', wep, WEAPON_SVG);
    const am = el('div', 'a', wep);
    this.ammoN = el('div', 'm num', am, '0');
    this.ammoR = el('div', 'r num', am, '/ 0');
    this.wepN = el('div', 'n', wep, '');
    this.wepEl = wep; this.ammoEl = am;

    // --- centre: reticle + hit marker ---
    const ret = el('div', 'ret', hud);
    el('div', 'dot', ret);
    for (const d of ['n', 's', 'w', 'e']) el('div', 'bl ' + d, ret);
    this.retEl = ret;
    this.hitEl = el('div', 'hit', hud,
      '<svg viewBox="0 0 44 44"><line x1="8" y1="8" x2="17" y2="17"/><line x1="36" y1="8" x2="27" y2="17"/>' +
      '<line x1="8" y1="36" x2="17" y2="27"/><line x1="36" y1="36" x2="27" y2="27"/></svg>');

    // --- subtitles + banner ---
    const subs = el('div', 'subs', hud);
    this.subWho = el('div', 'who', subs, '');
    this.subTx = el('div', 'tx', subs, '');
    this.subsEl = subs;
    this.bannerEl = el('div', 'banner', hud, '');
  }

  _bind(ctx) {
    const b = ctx.bus;
    this._off = [
      b.on('player:wanted', (l) => this.setWanted(l)),
      b.on('player:wantedSearching', (on) => setClass(this.starsEl, 'hunt', !!on)),
      b.on('player:enterVehicle', (v) => this.setVehicle(v)),
      b.on('player:exitVehicle', () => this.setVehicle(null)),
      b.on('player:money', (m) => this.setMoney(typeof m === 'number' ? m : m?.amount, m?.delta)),
      b.on('hud:money', (m) => this.setMoney(typeof m === 'number' ? m : m?.amount, m?.delta)),
      b.on('player:health', (h) => this.setVitals(h)),
      b.on('player:vitals', (h) => this.setVitals(h)),
      b.on('hud:notify', (n) => this.notify(n)),
      b.on('hud:subtitle', (s) => this.subtitle(s)),
      b.on('hud:objective', (o) => this.objective(o)),
      b.on('hud:banner', (o) => this.banner(o)),
      b.on('hud:hit', (o) => this.hit(o)),
      b.on('hud:weapon', (w) => this.setWeapon(w)),
      b.on('hud:reticle', (r) => Object.assign(this.aim, r)),
      b.on('hud:visible', (v) => this.setVisible(v)),
      // Debug hook: pins the dial to an arbitrary object so the driving HUD can
      // be exercised without a Vehicle. Suppresses the player auto-follow.
      b.on('hud:vehicle', (v) => { this._vehManual = !!v; this.setVehicle(v); }),
      b.on('mission:objective', (o) => this.objective(o)),
      b.on('mission:start', (m) => {
        this.banner({ kind: 'mission', k: 'Mission', title: m?.name || m?.title || 'New Mission', sub: m?.sub });
        if (m?.objective) this.objective(m.objective);
      }),
      b.on('mission:passed', (m) => {
        this.objective(null);
        this.banner({ kind: 'pass', k: 'Mission Passed', title: m?.name || m?.title || '', sub: m?.sub, stats: m?.stats });
      }),
      b.on('mission:failed', (m) => {
        this.objective(null);
        this.banner({ kind: 'fail', k: 'Mission Failed', title: m?.name || m?.title || '', sub: m?.reason || m?.sub });
      }),
      b.on('key:down', (c) => { if (c === 'F3') this.setVisible(this.hudEl.style.display === 'none'); }),
      b.on('resize', () => this._resize()),
    ];
    this._onScale = () => this._resize();
    this.root.addEventListener('ui:scale', this._onScale);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.dashEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.dashCv.width === w && this.dashCv.height === h) return;
    this.dashCv.width = w; this.dashCv.height = h;
    this._dpr = dpr;
    this._g = this.dashCv.getContext('2d');
    this._face = null;   // invalidated; rebuilt lazily on next dial draw
  }

  // ------------------------------------------------------------- public API ---
  /** @param {boolean} v show/hide the whole diegetic HUD (F3). */
  setVisible(v) { this.hudEl.style.display = v === false ? 'none' : ''; }

  /** @param {number} level 0..5 */
  setWanted(level) {
    const l = Math.max(0, Math.min(5, Math.round(level || 0)));
    if (l === this._wanted) return;
    const prev = this._wanted;
    this._wanted = l;
    setClass(this.starsEl, 'on', l > 0);
    for (let i = 0; i < 5; i++) {
      const lit = i < l;
      setClass(this.starEls[i], 'lit', lit);
      if (lit && i >= prev) {           // only newly gained stars pop
        this.starEls[i].classList.remove('pop');
        void this.starEls[i].offsetWidth;   // restart the animation
        this.starEls[i].classList.add('pop');
      }
    }
    // Freshly changed = police actively searching; the row strobes for a while.
    setClass(this.starsEl, 'hunt', l > 0);
    clearTimeout(this._huntT);
    if (l > 0) this._huntT = setTimeout(() => setClass(this.starsEl, 'hunt', false), 4200);
  }

  /** @param {number} amount total cash. @param {number} [delta] shows a floating +/-. */
  setMoney(amount, delta) {
    if (typeof amount !== 'number' || !isFinite(amount)) return;
    if (this._money === null) { this._moneyShown = amount; this.moneyEl.classList.add('on'); }
    const d = typeof delta === 'number' ? delta : (this._money === null ? 0 : amount - this._money);
    this._money = amount;
    if (d) {
      const n = this.moneyD;
      n.className = 'money-d num ' + (d > 0 ? 'up' : 'dn');
      n.textContent = (d > 0 ? '+$' : '-$') + Math.abs(Math.round(d)).toLocaleString('en-US');
      void n.offsetWidth;
      n.classList.add('go');
    }
  }

  /** @param {{health?:number,armour?:number,armor?:number,stamina?:number,max?:number}|number} v */
  setVitals(v) {
    const n = (x) => (x == null ? null : (x > 1.001 ? x / 100 : x));
    if (typeof v === 'number') { this.vitals.health = Math.max(0, Math.min(1, n(v))); return; }
    if (!v) return;
    const h = n(v.health), a = n(v.armour ?? v.armor), s = n(v.stamina);
    if (h != null) this.vitals.health = Math.max(0, Math.min(1, h));
    if (a != null) this.vitals.armour = Math.max(0, Math.min(1, a));
    if (s != null) this.vitals.stamina = Math.max(0, Math.min(1, s));
  }

  /** @param {object|null} v a `vehicles` contract Vehicle, or null when on foot. */
  setVehicle(v) {
    this._veh = v || null;
    setClass(this.dashEl, 'on', !!v);
    if (v) { setClass(this.wepEl, 'on', false); this.aim.visible = false; }
    else if (this._weapon) setClass(this.wepEl, 'on', true);
  }

  /** @param {{name?:string,ammo?:number,reserve?:number}|null} w */
  setWeapon(w) {
    this._weapon = w || null;
    setClass(this.wepEl, 'on', !!w && !this._veh);
    if (!w) return;
    setText(this.wepN, (w.name || 'Weapon').toUpperCase());
    setText(this.ammoN, String(w.ammo ?? 0));
    setText(this.ammoR, '/ ' + (w.reserve ?? 0));
    setClass(this.ammoEl, 'low', (w.ammo ?? 0) <= Math.max(1, (w.clip ?? 12) * 0.25));
  }

  /** @param {{text:string,title?:string}|string|null} o */
  objective(o) {
    if (!o) { setClass(this.objEl, 'on', false); this._objOn = false; return; }
    const text = typeof o === 'string' ? o : (o.text || o.objective || '');
    if (!text) { setClass(this.objEl, 'on', false); return; }
    setText(this.objT, ((typeof o === 'object' && o.title) || 'Objective').toUpperCase());
    setText(this.objB, text);
    if (!this._objOn) { this.objEl.classList.remove('on'); void this.objEl.offsetWidth; }
    setClass(this.objEl, 'on', true);
    this._objOn = true;
  }

  /**
   * Feed notification.
   * @param {{title?:string,text?:string,kind?:'info'|'money'|'pickup'|'phone'|'warn'|'mission',duration?:number}} o
   */
  notify(o) {
    if (!o) return;
    const kind = o.kind || 'info';
    const n = el('div', 'note ' + kind, null);
    const ic = el('div', 'ico', n);
    ic.innerHTML = `<svg viewBox="0 0 24 24"><path d="${ICONS[kind] || ICONS.info}"/></svg>`;
    const tx = el('div', 'tx', n);
    if (o.title) el('div', 't', tx, String(o.title));
    if (o.text) el('div', 'b', tx, String(o.text));
    this.feedEl.appendChild(n);
    const rec = { n, die: (this.ctx.time.elapsed || 0) + (o.duration || 5.5) };
    this._notes.push(rec);
    while (this._notes.length > 6) this._killNote(this._notes[0]);
  }

  _killNote(rec) {
    const i = this._notes.indexOf(rec);
    if (i < 0) return;
    this._notes.splice(i, 1);
    rec.n.classList.add('out');
    setTimeout(() => rec.n.remove(), 360);
  }

  /** @param {{speaker?:string,text:string,duration?:number}|string|null} s */
  subtitle(s) {
    if (!s) { setClass(this.subsEl, 'on', false); this._subT = 0; return; }
    const text = typeof s === 'string' ? s : s.text;
    const who = typeof s === 'object' ? (s.speaker || s.who || '') : '';
    setText(this.subWho, who ? who.toUpperCase() : '');
    this.subWho.style.display = who ? '' : 'none';
    setText(this.subTx, text || '');
    setClass(this.subsEl, 'on', true);
    const dur = (typeof s === 'object' && s.duration) || Math.max(1.8, (text || '').length * 0.055);
    this._subT = (this.ctx.time.elapsed || 0) + dur;
  }

  /**
   * Big centre card: mission passed/failed, district name, WASTED, etc.
   * @param {{kind?:string,k?:string,title?:string,sub?:string,stats?:{label:string,value:string}[]}} o
   */
  banner(o) {
    if (!o) return;
    const b = this.bannerEl;
    const kind = o.kind || 'info';
    let html = '<div class="rule"></div>';
    if (o.k) html += `<div class="k">${esc(o.k)}</div>`;
    if (o.title) html += `<div class="h">${esc(o.title)}</div>`;
    if (o.sub) html += `<div class="sub">${esc(o.sub)}</div>`;
    if (o.stats?.length) {
      html += '<div class="stats">' + o.stats.map(s =>
        `<div><div class="sl">${esc(s.label)}</div><div class="sv">${esc(s.value)}</div></div>`).join('') + '</div>';
    }
    html += '<div class="rule"></div>';
    b.innerHTML = html;
    b.className = 'banner ' + (kind === 'fail' ? 'fail ' : kind === 'district' ? 'district ' : '');
    void b.offsetWidth;
    b.classList.add('go');
  }

  /** @param {{kind?:'hit'|'crit'|'kill'}|string} [o] */
  hit(o) {
    const kind = (typeof o === 'string' ? o : o?.kind) || 'hit';
    const h = this.hitEl;
    h.className = 'hit ' + kind;
    void h.offsetWidth;
    h.classList.add('go');
  }

  /** Populate everything with plausible values — used for UI screenshots. */
  demo(on = true) {
    if (!on) {
      this.setWanted(0); this.setWeapon(null); this.objective(null);
      this.aim.visible = false; return;
    }
    this.setMoney(184250);
    this.setVitals({ health: 0.78, armour: 0.55, stamina: 0.9 });
    this.setWeapon({ name: 'Combat Pistol', ammo: 12, reserve: 84, clip: 12 });
    this.objective({ text: 'Lose the cops, then meet Sully at the Fish Pier.' });
    this.aim.visible = true; this.aim.spread = 0.25;
    this.notify({ kind: 'money', title: 'Payout', text: 'Longshoreman job  +$4,500' });
    this.notify({ kind: 'phone', title: 'Sully', text: 'Where are you? The boat leaves at nine.' });
    this.setWanted(3);
  }

  // ------------------------------------------------------------------ loop ---
  update(dt, ctx) {
    const t = ctx.time.elapsed;

    // Auto-follow the gameplay agent's player state when it exists, so the HUD
    // is correct even if nobody emitted the enter/exit events.
    const p = ctx.get('player');
    if (p && typeof p.mode === 'string' && !this._vehManual) {
      const pv = p.vehicle || null;
      if (p.mode === 'driving' && pv && pv !== this._veh) this.setVehicle(pv);
      else if (p.mode !== 'driving' && this._veh) this.setVehicle(null);
      if (typeof p.health === 'number') this.setVitals({ health: p.health });
      if (typeof p.armour === 'number') this.setVitals({ armour: p.armour });
      if (typeof p.wanted === 'number') this.setWanted(p.wanted);
    }

    this._updateMoney(dt);
    this._updateDash(dt, ctx);
    this._updateReticle(dt);

    // Expiring transient elements.
    for (let i = this._notes.length - 1; i >= 0; i--) {
      if (t >= this._notes[i].die) this._killNote(this._notes[i]);
    }
    if (this._subT && t >= this._subT) { setClass(this.subsEl, 'on', false); this._subT = 0; }

    // Street + district readout: 4 Hz is plenty and nearestEdge is not free.
    this._streetT -= dt;
    if (this._streetT <= 0) { this._streetT = 0.25; this._updatePlace(ctx); }
  }

  _updateMoney(dt) {
    if (this._money === null) return;
    const d = this._money - this._moneyShown;
    if (Math.abs(d) < 0.5) this._moneyShown = this._money;
    else this._moneyShown += d * Math.min(1, dt * 7);
    setText(this.moneyN, Math.round(this._moneyShown).toLocaleString('en-US'));
  }

  _updatePlace(ctx) {
    const city = ctx.get('city');
    const pl = ctx.get('player');
    const pos = pl?.position || ctx.camera.position;
    let district = null, street = null;
    try {
      if (city?.districtAt) district = city.districtAt(pos.x, pos.z);
      const near = city?.roads?.nearestEdge?.(pos.x, pos.z);
      if (near && near.distance < 45) {
        // The minimap already has an id -> edge index; don't rescan the graph.
        street = ctx.get('minimap')?.map?.edgeName?.(near.edgeId) || null;
      }
    } catch { /* a half-built city must never take the HUD down */ }

    const dn = district ? (DISTRICT_NAMES[district] || district) : null;
    if (dn !== this._district) {
      // Entering a new district gets the lower-third card, but not on first fix.
      if (this._district !== null && dn) this.banner({ kind: 'district', title: dn, k: 'Now entering' });
      this._district = dn;
    }
    setText(this.districtN, dn || 'Boston');
    if (street !== this._street) this._street = street;
    setText(this.streetN, street || (dn ? '' : ''));
    this.streetN.style.display = street ? '' : 'none';
  }

  _updateReticle(dt) {
    const show = this.aim.visible && !this._veh;
    setClass(this.retEl, 'on', show);
    if (!show) return;
    setClass(this.retEl, 'hot', !!this.aim.hot);
    const target = 5 + (this.aim.spread || 0) * 46;
    this._retSp += (target - this._retSp) * Math.min(1, dt * 14);
    const v = this._retSp.toFixed(1);
    if (this.retEl.__sp !== v) { this.retEl.__sp = v; this.retEl.style.setProperty('--sp', `calc(${v} * var(--u))`); }
  }

  // ------------------------------------------------------------- dial draw ---
  _updateDash(dt, ctx) {
    const v = this._veh;
    if (!v) { this._ndl.p *= Math.pow(0.02, dt); this._ndl.v = 0; return; }

    const rpmMax = v.rpmMax || v.maxRpm || 8000;
    const rpm = Math.max(0, Math.min(rpmMax, Number(v.rpm) || 0));
    const speed = Number(v.speed) || 0;
    const mph = Math.abs(speed) * MPS_TO_MPH;

    // Needle: an actual second-order system, so it overshoots on a hard shift
    // and settles — the single biggest reason analogue dials read as "real".
    const target = rpm / rpmMax;
    const n = this._ndl;
    const sub = Math.min(4, Math.max(1, Math.ceil(dt * 120)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      const a = (target - n.p) * 300 - n.v * 27;
      n.v += a * h; n.p += n.v * h;
    }
    n.p = Math.max(-0.02, Math.min(1.06, n.p));
    // Engine vibration, scaled by load. Tiny, but it kills the "CSS gauge" feel.
    const shake = Math.sin(ctx.time.elapsed * 61.0) * 0.0028 * target;

    this._spdSm += (mph - this._spdSm) * Math.min(1, dt * 12);
    setText(this.spdN, String(Math.round(this._spdSm)));

    let g = v.gear;
    let gs, gc;
    if (speed < -0.4 || g === -1 || g === 'R') { gs = 'R'; gc = 'gear r'; }
    else if (Math.abs(speed) < 0.4 && (g == null || g === 0)) { gs = 'N'; gc = 'gear n'; }
    else gs = String(g == null ? 1 : (typeof g === 'number' ? Math.max(1, g) : g)), gc = 'gear';
    setText(this.gearN, gs);
    if (this.gearN.className !== gc) this.gearN.className = gc;

    setClass(this.tellLights, 'on', !!v.headlightsOn);
    setClass(this.tellSiren, 'on', !!v.sirenOn);

    this._drawDial(n.p + shake, rpmMax);
  }

  /** Static tach face: track, redline band, ticks outside the ring, numerals. */
  _buildFace(W, H, rpmMax) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const k = W / DIAL.W;
    g.setTransform(k, 0, 0, k, 0, 0);
    const { CX, CY, R, A0, SW, RED } = DIAL;

    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255,255,255,.16)';
    g.lineWidth = 4.6;
    g.beginPath(); g.arc(CX, CY, R, A0, A0 + SW); g.stroke();
    g.strokeStyle = 'rgba(255,86,71,.30)';
    g.beginPath(); g.arc(CX, CY, R, A0 + RED * SW, A0 + SW); g.stroke();

    const steps = Math.max(4, Math.round(rpmMax / 500));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const a = A0 + f * SW;
      const major = i % 2 === 0;
      const r0 = R + 3.6, r1 = r0 + (major ? 5.2 : 2.6);
      g.strokeStyle = f >= RED - 1e-6
        ? 'rgba(255,120,105,.92)'
        : (major ? 'rgba(255,255,255,.66)' : 'rgba(255,255,255,.26)');
      g.lineWidth = major ? 1.6 : 1;
      g.beginPath();
      g.moveTo(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0);
      g.lineTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
      g.stroke();
      // Numerals every 2000 rpm only — a small dial with ten numbers is noise.
      if (major && (i / 2) % 2 === 0) {
        const rt = R + 14;
        g.fillStyle = f >= RED - 1e-6 ? 'rgba(255,150,135,.95)' : 'rgba(255,255,255,.62)';
        g.font = '700 8.5px ' + DIAL.FONT;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(i / 2), CX + Math.cos(a) * rt, CY + Math.sin(a) * rt);
      }
    }
    g.fillStyle = 'rgba(255,255,255,.36)';
    g.font = '700 6.5px ' + DIAL.FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R P M  x 1 0 0 0', CX, CY + R * 0.66);
    return c;
  }

  _drawDial(p, rpmMax) {
    const g = this._g;
    if (!g) return;
    const W = this.dashCv.width, H = this.dashCv.height;
    if (!this._face || this._faceMax !== rpmMax || this._faceW !== W) {
      this._face = this._buildFace(W, H, rpmMax);
      this._faceMax = rpmMax; this._faceW = W;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(this._face, 0, 0);

    const k = W / DIAL.W;
    g.setTransform(k, 0, 0, k, 0, 0);
    const { CX, CY, R, A0, SW, RED } = DIAL;
    const pc = Math.max(0, Math.min(1.015, p));
    const a = A0 + pc * SW;

    if (pc > 0.004) {
      g.lineCap = 'round';
      g.lineWidth = 4.6;
      g.strokeStyle = pc > RED ? '#ff6a55' : '#ffc247';
      g.shadowColor = pc > RED ? 'rgba(255,90,70,.9)' : 'rgba(255,180,60,.65)';
      g.shadowBlur = 9 * k;
      g.beginPath(); g.arc(CX, CY, R, A0, a); g.stroke();
      g.shadowBlur = 0;
    }

    // Needle: tapered, sweeping inside the ring so it never crosses a numeral.
    const ca = Math.cos(a), sa = Math.sin(a);
    const nx = -sa, ny = ca;
    const tip = R - 4.5, tail = 9;
    g.beginPath();
    g.moveTo(CX + ca * tip, CY + sa * tip);
    g.lineTo(CX + nx * 2.1 - ca * tail, CY + ny * 2.1 - sa * tail);
    g.lineTo(CX - nx * 2.1 - ca * tail, CY - ny * 2.1 - sa * tail);
    g.closePath();
    g.fillStyle = pc > RED ? '#ff8474' : 'rgba(255,255,255,.96)';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 4 * k;
    g.fill();
    g.shadowBlur = 0;

    g.beginPath(); g.arc(CX, CY, 5.4, 0, Math.PI * 2);
    g.fillStyle = '#0e1219'; g.fill();
    g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.34)'; g.stroke();
  }

  dispose() {
    clearTimeout(this._huntT);
    this._off?.forEach(f => f());
    this.root?.removeEventListener('ui:scale', this._onScale);
    this.hudEl?.remove();
    if (window.__hud === this) delete window.__hud;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
