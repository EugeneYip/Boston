import * as THREE from 'three';
import { GROUP, groups } from '../physics/PhysicsWorld.js';

/**
 * Camera.
 *
 * Every screenshot of this game is taken through this file, so it is worth
 * being precise about what a good third-person camera actually does:
 *
 * 1. **Rotation is instant, translation lags.** The orbit angles follow the
 *    mouse with no smoothing at all — smoothing the aim is what makes a camera
 *    feel like it is underwater. What lags is the *pivot*, which chases the
 *    character with a critically damped spring, so a stop or a direction change
 *    settles without overshoot or bounce.
 * 2. **It never clips through geometry.** A fan of five rays sweeps the orbit
 *    line (centre plus the four corners of the near plane), and the camera is
 *    pulled to the nearest hit. Pulling *in* is instantaneous — a frame inside a
 *    wall is unrecoverable — while pushing back *out* is rate limited, which is
 *    what stops the shudder as you walk past a lamp post.
 * 3. **Speed reads on the lens.** Distance and field of view both open up with
 *    speed, so 100 km/h looks different from 20 even in a still frame.
 * 4. **A car is not a person.** Driving gets a longer, higher, centred camera
 *    that re-centres itself behind the car when the mouse is idle; on foot gets
 *    a close over-the-shoulder framing that never auto-centres.
 *
 * ## The `enabled` contract — do not break this
 * `CaptureHarness.setCamera()` parks the camera for a deterministic shot by
 * setting `cameraRig.enabled = false`, and `releaseCamera()` sets it back to
 * true after copying the camera position into `rig.pos`. Every screenshot taken
 * by every other agent and by the visual critic depends on those two lines
 * working. So: while `enabled` is false this system touches nothing at all, and
 * on the false -> true edge it re-derives its orbit angles from wherever the
 * harness left the camera, so control resumes without a jump.
 */

const FREE_SLOW = 42, FREE_FAST = 165;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _want = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/** Corner offsets of the sweep, in units of the near-plane half extents. */
const FAN = [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];

export default class CameraRig {
  static id = 'cameraRig';
  static label = 'Camera';
  static deps = ['render'];

  async init(ctx) {
    this.enabled = true;
    this.mode = 'chase';             // 'chase' | 'free'
    this.yaw = 0;
    this.pitch = -0.16;
    this.pos = new THREE.Vector3(120, 55, 220);   // harness compatibility
    this.vel = new THREE.Vector3();

    this._pivot = new THREE.Vector3();
    this._pivotInit = false;
    this._dist = 4;
    this._fov = ctx.settings.fov;
    this._lookIdle = 0;
    this._parked = false;
    this._canRay = true;
    this._shoulder = 0;

    const P = ctx.physics;
    if (P?.RAPIER) {
      this._ray = new P.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      this._rayFilter = groups(0xFFFF, GROUP.STATIC | GROUP.PROP | GROUP.VEHICLE);
    }
    this._noPlayerWarned = false;
  }

  /** The system the camera is following, or null for free-fly. */
  _target(ctx) {
    if (this.mode === 'free') return null;
    const p = ctx.get('player');
    if (!p || !p.position || !isFinite(p.position.x)) return null;
    return p;
  }

  // -- look ------------------------------------------------------------------

  update(dt, ctx) {
    if (!this.enabled) {
      // Parked by the capture harness. Hand the character back its visibility —
      // it is only ever hidden because *this* camera pushed in close, and a shot
      // taken while it is hidden loses the player from the frame for no reason.
      this._parked = true;
      const p = ctx.get('player');
      if (p) p.visible = true;
      return;
    }
    if (this._parked) { this._resync(ctx); this._parked = false; }
    const inp = ctx.input;
    if (!inp) return;

    if (inp.justDown('camera')) {
      this.mode = this.mode === 'free' ? 'chase' : 'free';
      if (this.mode === 'free') this.pos.copy(ctx.camera.position);
      this._pivotInit = false;
    }

    const look = inp.lookAxis(dt);
    const sens = ctx.settings.mouseSensitivity ?? 1;
    const moved = Math.abs(look.x) + Math.abs(look.y);
    if (inp.mouse.locked || inp.gpAxes[2] || inp.gpAxes[3]) {
      this.yaw -= look.x * sens;
      this.pitch -= look.y * sens * (ctx.settings.invertY ? -1 : 1);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.30, 1.05);
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }
    this._lookIdle = moved > 1e-4 ? 0 : this._lookIdle + dt;

    if (this.mode === 'free') this._free(dt, ctx);
  }

  /** Camera solve runs late, after the player and vehicles have moved. */
  lateUpdate(dt, ctx) {
    if (!this.enabled || this.mode === 'free') return;
    const player = this._target(ctx);
    if (!player) {
      if (!this._noPlayerWarned) {
        this._noPlayerWarned = true;
        console.info('[camera] no player system — free-fly camera (V toggles)');
      }
      this.mode = 'free';
      this.pos.copy(ctx.camera.position);
      return;
    }
    const driving = player.mode === 'driving' && player.vehicle;
    if (driving) this._solveDriving(dt, ctx, player);
    else this._solveOnFoot(dt, ctx, player);
  }

  // -- chase -----------------------------------------------------------------

  _solveOnFoot(dt, ctx, player) {
    const p = player.position;
    const crouch = player.crouching ? -0.36 : 0;
    _pivot.set(p.x, p.y + 1.42 + crouch, p.z);
    const speed = player.speed || 0;
    const dist = 3.35 + Math.min(1.05, speed * 0.17);
    const lift = 0.20;
    // The shoulder offset eases out as the camera is forced in by a wall,
    // otherwise a tight corner frames the character's ear.
    this._shoulder += (0.46 - this._shoulder) * (1 - Math.exp(-dt * 6));
    const fovBase = ctx.settings.fov;
    const fovWant = fovBase + (player.sprinting ? 5.5 : 0);
    this._apply(dt, ctx, _pivot, dist, lift, this._shoulder, fovWant, 16, player);
    player.visible = this._dist > 0.95;
  }

  _solveDriving(dt, ctx, player) {
    const v = player.vehicle;
    const speed = Math.abs(v.speed || 0);
    const len = v.spec?.phys?.length || 4.8;
    const hgt = v.spec?.phys?.height || 1.5;
    _pivot.set(v.position.x, v.position.y + hgt * 0.62 + 0.35, v.position.z);

    // Re-centre behind the car once the mouse has been still for a moment. This
    // is the single thing that makes driving with a mouse feel like a game
    // rather than a debug view.
    if (this._lookIdle > 0.9 && speed > 2.2) {
      const target = (v.speed || 0) < -0.5 ? (v.heading || 0) + Math.PI : (v.heading || 0);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const rate = Math.min(1, (speed - 2.2) * 0.10) * (1 - Math.exp(-dt * 1.9));
      this.yaw += d * rate;
      const dp = -0.10 - this.pitch;
      this.pitch += dp * (1 - Math.exp(-dt * 0.9));
    }

    const dist = len * 0.95 + 2.6 + Math.min(3.4, speed * 0.135);
    const lift = 0.55 + Math.min(0.5, speed * 0.014);
    this._shoulder += (0 - this._shoulder) * (1 - Math.exp(-dt * 6));
    const fovWant = ctx.settings.fov - 4 + Math.min(17, speed * 0.62);
    this._apply(dt, ctx, _pivot, dist, lift, 0, fovWant, 11, player);
    player.visible = true;
  }

  /**
   * Shared tail of both solves: spring the pivot, sweep for collision, place
   * the camera, ease the field of view.
   */
  _apply(dt, ctx, pivot, dist, lift, shoulder, fovWant, pivotK, player) {
    if (!this._pivotInit) { this._pivot.copy(pivot); this._pivotInit = true; }
    const k = 1 - Math.exp(-pivotK * dt);
    this._pivot.lerp(pivot, k);
    // A spring that never quite arrives leaves the camera permanently trailing;
    // snap the last centimetre.
    if (this._pivot.distanceToSquared(pivot) < 1e-4) this._pivot.copy(pivot);

    _e.set(this.pitch, this.yaw, 0);
    _q.setFromEuler(_e);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);

    // Orbit origin: the pivot shifted onto the shoulder, lifted a little.
    _want.copy(this._pivot).addScaledVector(_up, lift);

    const free = this._sweep(ctx, _want, _fwd, _right, _up, dist, shoulder, player);
    // In fast, out slow. Popping toward the player is invisible; popping away
    // from him reads as a glitch.
    if (free < this._dist) this._dist = free;
    else this._dist = Math.min(free, this._dist + (2.6 + this._dist) * dt);
    this._dist = Math.max(0.42, this._dist);

    const shrink = dist > 0.01 ? Math.min(1, this._dist / dist) : 1;
    this.pos.copy(_want)
      .addScaledVector(_fwd, -this._dist)
      .addScaledVector(_right, shoulder * shrink);

    ctx.camera.position.copy(this.pos);
    ctx.camera.quaternion.copy(_q);

    const f = this._fov + (fovWant - this._fov) * (1 - Math.exp(-dt * 3.2));
    this._fov = f;
    if (Math.abs(ctx.camera.fov - f) > 0.02) {
      ctx.camera.fov = f;
      ctx.camera.updateProjectionMatrix();
    }
  }

  /**
   * How far back the camera may sit before something is in the way. Five rays
   * approximate the swept near plane; the tightest wins.
   */
  _sweep(ctx, origin, fwd, right, up, dist, shoulder, player) {
    const P = ctx.physics;
    if (!P?.world || !this._ray || !this._canRay) return dist;
    const cam = ctx.camera;
    const hh = Math.tan((cam.fov * Math.PI / 180) * 0.5) * (cam.near + 0.16);
    const hw = hh * (cam.aspect || 1.6);
    const pad = 0.22;

    // Exclude whatever the player is riding; the camera lives inside its shell.
    const exclude = player?.vehicle?.body || undefined;
    const ray = this._ray;
    let best = dist;
    try {
      for (let i = 0; i < FAN.length; i++) {
        const ox = FAN[i][0] * hw, oy = FAN[i][1] * hh;
        ray.origin.x = origin.x + right.x * (ox + shoulder) + up.x * oy;
        ray.origin.y = origin.y + right.y * (ox + shoulder) + up.y * oy;
        ray.origin.z = origin.z + right.z * (ox + shoulder) + up.z * oy;
        ray.dir.x = -fwd.x; ray.dir.y = -fwd.y; ray.dir.z = -fwd.z;
        const hit = P.world.castRay(ray, dist + pad, true, undefined,
          this._rayFilter, undefined, exclude);
        if (!hit) continue;
        const toi = hit.timeOfImpact ?? hit.toi;
        if (typeof toi !== 'number') continue;
        const allow = toi - pad;
        if (allow < best) best = allow;
      }
    } catch (err) {
      // A Rapier signature change must degrade to "no collision", never to a
      // per-frame exception storm.
      this._canRay = false;
      console.warn('[camera] collision sweep disabled:', err?.message || err);
      return dist;
    }
    return Math.max(0.42, best);
  }

  // -- free fly --------------------------------------------------------------

  _free(dt, ctx) {
    const inp = ctx.input;
    _e.set(this.pitch, this.yaw, 0);
    _q.setFromEuler(_e);
    const mv = inp.moveAxis();
    const speed = (inp.down('sprint') ? FREE_FAST : FREE_SLOW) * dt;
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    this.vel.addScaledVector(_fwd, -mv.y * speed);
    this.vel.addScaledVector(_right, mv.x * speed);
    if (inp.down('jump')) this.vel.y += speed;
    if (inp.down('crouch')) this.vel.y -= speed;
    this.vel.multiplyScalar(Math.pow(0.0015, dt));
    this.pos.addScaledVector(this.vel, dt * 8);
    this.pos.y = Math.max(this.pos.y, 1.6);

    ctx.camera.position.copy(this.pos);
    ctx.camera.quaternion.copy(_q);
    if (ctx.camera.fov !== ctx.settings.fov) {
      ctx.camera.fov = ctx.settings.fov;
      ctx.camera.updateProjectionMatrix();
      this._fov = ctx.settings.fov;
    }
  }

  /** Resume control from wherever the capture harness left the camera. */
  _resync(ctx) {
    const cam = ctx.camera;
    this.pos.copy(cam.position);
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = _e.y;
    this.pitch = THREE.MathUtils.clamp(_e.x, -1.30, 1.05);
    this._fov = cam.fov;
    this._pivotInit = false;
    this.vel.set(0, 0, 0);
    _tmp.set(0, 0, 0);
  }

  dispose() {}
}
