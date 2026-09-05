// Unified keyboard / mouse / gamepad input. Poll-based (query in update), plus events.
const ACTIONS = {
  forward:   ['KeyW', 'ArrowUp'],
  back:      ['KeyS', 'ArrowDown'],
  left:      ['KeyA', 'ArrowLeft'],
  right:     ['KeyD', 'ArrowRight'],
  jump:      ['Space'],
  sprint:    ['ShiftLeft', 'ShiftRight'],
  crouch:    ['KeyC'],
  brake:     ['Space'],
  handbrake: ['ShiftLeft'],
  enter:     ['KeyF'],
  interact:  ['KeyE'],
  fire:      ['Mouse0'],
  aim:       ['Mouse2'],
  reload:    ['KeyR'],
  horn:      ['KeyH'],
  lights:    ['KeyL'],
  camera:    ['KeyV'],
  map:       ['KeyM'],
  // Escape is deliberately NOT here. It belongs to the browser: it releases
  // pointer lock and leaves fullscreen, and whether the keydown ever reaches the
  // page depends on the browser and the privileged state it was in. Binding a
  // game action to it made one keypress mean three different things in Safari
  // and the player could not tell which they would get. Boston now owns no
  // Escape behaviour at all and instead observes `pointerlockchange` and
  // `fullscreenchange`, which are authoritative. `KeyP` is the pause key.
  pause:     ['KeyP'],
  gearUp:    ['KeyQ'],
  gearDown:  ['KeyZ'],
};

export default class Input {
  constructor(dom, bus) {
    this.dom = dom; this.bus = bus;
    this.keys = new Set();
    this.pressed = new Set();   // edge: this frame only
    this.released = new Set();
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, locked: false };
    /** Observed from fullscreenchange, never assumed from a key press. */
    this.fullscreen = false;
    this.gamepad = null;
    this.gpAxes = [0, 0, 0, 0];
    this.gpButtons = [];
    this._bind();
  }

  _bind() {
    const d = window;
    d.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code); this.pressed.add(e.code);
      if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.code)) e.preventDefault();
      this.bus?.emit('key:down', e.code);
    });
    d.addEventListener('keyup', (e) => {
      this.keys.delete(e.code); this.released.add(e.code);
      this.bus?.emit('key:up', e.code);
    });
    d.addEventListener('blur', () => { this.keys.clear(); });

    this.dom.addEventListener('mousedown', (e) => {
      this.keys.add('Mouse' + e.button); this.pressed.add('Mouse' + e.button);
    });
    d.addEventListener('mouseup', (e) => {
      this.keys.delete('Mouse' + e.button); this.released.add('Mouse' + e.button);
    });
    d.addEventListener('mousemove', (e) => {
      if (this.mouse.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    });
    d.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    d.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.mouse.locked = document.pointerLockElement === this.dom;
      this.bus?.emit('pointerlock', this.mouse.locked);
    });
    // Fullscreen is a privileged browser state that Escape can drop without ever
    // telling the page through a key event, so OBSERVE the state change rather
    // than inferring it from keys. Safari still needs the webkit-prefixed event.
    const onFs = () => {
      const was = this.fullscreen;
      this.fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (was !== this.fullscreen) this.bus?.emit('fullscreen', this.fullscreen);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    onFs();
    this.dom.addEventListener('click', () => {
      if (!this.mouse.locked) this.dom.requestPointerLock?.();
    });
    window.addEventListener('gamepadconnected', (e) => { this.gamepad = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepad = null; });
  }

  /** Call once per frame BEFORE systems update. */
  poll() {
    if (this.gamepad !== null) {
      const gp = navigator.getGamepads?.()[this.gamepad];
      if (gp) {
        const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
        this.gpAxes = [dz(gp.axes[0]||0), dz(gp.axes[1]||0), dz(gp.axes[2]||0), dz(gp.axes[3]||0)];
        this.gpButtons = gp.buttons.map(b => b.value);
      }
    }
  }
  /** Call once per frame AFTER systems update. */
  endFrame() {
    this.pressed.clear(); this.released.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
  }

  down(action)     { return (ACTIONS[action] || [action]).some(k => this.keys.has(k)); }
  justDown(action) { return (ACTIONS[action] || [action]).some(k => this.pressed.has(k)); }
  justUp(action)   { return (ACTIONS[action] || [action]).some(k => this.released.has(k)); }

  /** -1..1 movement axes combining WASD + left stick. */
  moveAxis() {
    let x = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    let y = (this.down('back') ? 1 : 0) - (this.down('forward') ? 1 : 0);
    if (this.gpAxes[0]) x = this.gpAxes[0];
    if (this.gpAxes[1]) y = this.gpAxes[1];
    const l = Math.hypot(x, y);
    return l > 1 ? { x: x / l, y: y / l } : { x, y };
  }
  /** Look delta combining mouse + right stick. */
  lookAxis(dt) {
    return {
      x: this.mouse.dx * 0.0022 + this.gpAxes[2] * 2.6 * dt,
      y: this.mouse.dy * 0.0022 + this.gpAxes[3] * 2.0 * dt,
    };
  }
  /** Analog triggers for driving: 0..1 */
  throttle() { return this.gpButtons[7] || (this.down('forward') ? 1 : 0); }
  brakeAxis() { return this.gpButtons[6] || (this.down('back') ? 1 : 0); }
}
