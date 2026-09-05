import * as THREE from 'three';
import { GROUP, groups } from '../physics/PhysicsWorld.js';
import {
  CrowdMesh, dressActor, clipForSpeed, phaseRate, CLIP_ROW, REF_HEIGHT,
} from './Character.js';

/**
 * Player.
 *
 * On foot the player is a Rapier **kinematic capsule** driven through
 * `KinematicCharacterController`, which is the piece of Rapier that already
 * solves the three things a hand-rolled controller always gets wrong: walking up
 * a kerb without jumping (autostep), staying glued to a slope on the way down
 * (snap-to-ground), and sliding along a wall rather than stopping dead against
 * it. A dynamic rigid body would be the obvious choice and is the wrong one —
 * a dynamic capsule tips, bounces down stairs, and accumulates velocity against
 * corners.
 *
 * In a vehicle the capsule is switched out of the collision world entirely and
 * the `vehicles` system drives the car from the same input; this system only
 * owns the transition and the seated pose.
 *
 * The camera is deliberately **not** here — `CameraRig.js` owns it, because the
 * capture harness parks the camera by setting `cameraRig.enabled = false` and
 * that contract must keep working whether or not a player exists.
 */

const CAP_R = 0.30;                  // capsule radius
const CAP_HH = 0.60;                 // half height of the cylindrical section
const CAP_HH_CROUCH = 0.30;
const EYE = 1.58;                    // eye height above the feet, standing

const SPEED = { walk: 1.45, jog: 3.40, sprint: 6.30, crouch: 1.15 };
const ACCEL_GROUND = 14.0;
const ACCEL_AIR = 2.2;
const JUMP_V = 6.05;                 // ~0.92 m of clearance against GRAVITY
const GRAVITY = 20.0;                // heavier than real: games always are
const SNAP_GROUND = 0.35;
const ENTER_RANGE = 4.6;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _delta = { x: 0, y: 0, z: 0 };
const _next = { x: 0, y: 0, z: 0 };

export default class Player {
  static id = 'player';
  static label = 'Player';
  static deps = ['city', 'physics'];

  constructor() {
    /** @type {'onFoot'|'driving'} */
    this.mode = 'onFoot';
    this.vehicle = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.health = 100;
    this.armour = 0;
    this.wanted = 0;
    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this.speed = 0;
    // Deliberately no `enabled` flag: `CaptureHarness.setCamera` stands down every
    // system that has one, and this system does not drive the camera — `CameraRig`
    // does. Advertising an `enabled` here would only freeze the character for no
    // reason during a shot.
    this.visible = true;

    this._vy = 0;
    this._yaw = 0;                   // where the character is facing
    this._hh = CAP_HH;               // current capsule half height
    this._crouched = false;
    this._snapOn = true;
    this._airborne = false;
    this._coyote = 0;                // grace period for a late jump press
    this._jumpBuffer = 0;
    this._exitCooldown = 0;
    this._actor = null;
    this._ready = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.city = ctx.get('city');
    const P = ctx.physics;
    if (!P?.world) { console.warn('[player] no physics world — player disabled'); return; }
    this.P = P;
    const R = P.RAPIER;

    const spawn = this._pickSpawn();
    this.position.copy(spawn);

    const desc = R.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawn.x, spawn.y + CAP_HH + CAP_R, spawn.z);
    this.body = P.world.createRigidBody(desc);
    const cd = R.ColliderDesc.capsule(CAP_HH, CAP_R)
      .setCollisionGroups(groups(GROUP.CHARACTER, 0xFFFF))
      .setFriction(0.4);
    this.collider = P.world.createCollider(cd, this.body);

    // The controller is the whole reason this is kinematic. Numbers chosen for a
    // person: a 45 cm autostep clears any kerb or stair in the city, a 52 degree
    // climb limit stops him walking up a wall, and 35 cm of ground snap keeps him
    // on the pavement crossing a camber instead of launching off it.
    this.ctrl = P.world.createCharacterController(0.02);
    this.ctrl.setUp({ x: 0, y: 1, z: 0 });
    this.ctrl.enableAutostep(0.45, 0.20, true);
    this.ctrl.enableSnapToGround(0.35);
    this.ctrl.setMaxSlopeClimbAngle(52 * Math.PI / 180);
    this.ctrl.setMinSlopeSlideAngle(38 * Math.PI / 180);
    this.ctrl.setSlideEnabled(true);
    this.ctrl.setApplyImpulsesToDynamicBodies(true);
    this.ctrl.setCharacterMass?.(82);

    // Visual: one instance of the same rig the crowd uses, so it shares the
    // shader program and the animation texture — one extra draw call, total.
    this._crowd = new CrowdMesh(ctx, 0, 1, { castShadow: true, name: 'player_body' });
    ctx.scene.add(this._crowd.mesh);
    this._actor = makeActor();
    this._actor.x = spawn.x; this._actor.y = spawn.y; this._actor.z = spawn.z;

    this._onWanted = (lvl) => { this.wanted = lvl | 0; };
    ctx.bus.on('player:wanted', this._onWanted);

    this._ready = true;
    console.info(`[player] spawned at ${spawn.x.toFixed(0)}, ${spawn.y.toFixed(1)}, ` +
      `${spawn.z.toFixed(0)} (${this.city?.districtAt?.(spawn.x, spawn.z) ?? '?'})`);
  }

  /** A pavement spawn near the Common, so the player starts somewhere that reads. */
  _pickSpawn() {
    const c = this.city;
    const out = new THREE.Vector3(34, 0, 96);
    const pts = c?.spawnPoints;
    if (pts?.length) {
      let best = null, bd = Infinity;
      for (const p of pts) {
        if (p.kind !== 'sidewalk') continue;
        const d = (p.x - 34) ** 2 + (p.z - 96) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) out.set(best.x, best.y ?? 0, best.z);
    }
    // `surfaceHeight`, not `groundHeight`: the raster is stamped below the
    // carriageway on purpose, so `groundHeight` is 0.4-0.6 m too low near a
    // street and spawned him under the pavement (measured 0.57 m at the default
    // spawn). City.js:172 states the rule; Lighting and LightManager already
    // follow it. `out.y` disambiguates a bridge deck from the ground beneath.
    out.y = (c?.surfaceHeight?.(out.x, out.z, out.y) ?? c?.groundHeight?.(out.x, out.z) ?? 0) + 0.06;
    return out;
  }

  // -- input ----------------------------------------------------------------

  /** Camera yaw drives movement; the rig owns it so free-fly still works. */
  _lookYaw() {
    const rig = this.ctx.get('cameraRig');
    return typeof rig?.yaw === 'number' ? rig.yaw : this._yaw;
  }

  /** A throw here would abort `capture()` for every other agent — contain it. */
  update(dt, ctx) {
    if (!this._ready) return;
    try {
      this._update(dt, ctx);
    } catch (err) {
      this._ready = false;
      if (this._crowd) this._crowd.mesh.visible = false;
      console.error('[player] disabled after an error in update():', err);
    }
  }

  _update(dt, ctx) {
    const inp = ctx.input;
    if (!inp) return;

    if (this._exitCooldown > 0) this._exitCooldown -= dt;
    if (this._jumpBuffer > 0) this._jumpBuffer -= dt;
    if (inp.justDown('jump')) this._jumpBuffer = 0.18;

    if (inp.justDown('enter') && this._exitCooldown <= 0) {
      if (this.mode === 'driving') this._exitVehicle();
      else this._tryEnterVehicle(ctx);
    }

    if (this.mode === 'driving') this._updateDriving(dt, ctx);
    else this._updateOnFootVisual(dt, ctx);

    this._present();
  }

  fixedUpdate(fdt, ctx) {
    if (!this._ready || this.mode !== 'onFoot') return;
    const inp = ctx.input;
    if (!inp) return;
    try { this._move(fdt, inp); } catch (err) {
      this._ready = false;
      console.error('[player] disabled after an error in fixedUpdate():', err);
    }
  }

  _move(fdt, inp) {
    const yaw = this._lookYaw();
    const mv = inp.moveAxis();

    // Crouching moves the body, so it has to happen before the translation is
    // read — otherwise `setNextKinematicTranslation` below writes the pre-crouch
    // position straight back over it and the character drops half a capsule.
    this._setCrouch(inp.down('crouch'));
    const t = this.body.translation();
    const mag = Math.min(1, Math.hypot(mv.x, mv.y));
    this.sprinting = inp.down('sprint') && mag > 0.1 && !this.crouching;
    let top = this.crouching ? SPEED.crouch : this.sprinting ? SPEED.sprint : SPEED.jog;
    // A part-deflected stick walks; keyboard is always full deflection.
    if (mag > 0.02 && mag < 0.55 && !this.sprinting) top = SPEED.walk;

    // Camera-relative basis. Forward is -Z at yaw 0, matching the engine.
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const fwd = -mv.y, side = mv.x;
    const wantX = (-sy * fwd + cy * side) * top;
    const wantZ = (-cy * fwd - sy * side) * top;

    const k = 1 - Math.exp(-(this.grounded ? ACCEL_GROUND : ACCEL_AIR) * fdt);
    this.velocity.x += (wantX - this.velocity.x) * k;
    this.velocity.z += (wantZ - this.velocity.z) * k;

    // ---- vertical state ----------------------------------------------------
    // `computedGrounded()` keeps reporting true for the first few centimetres of
    // a jump — the capsule is still inside the controller's ground tolerance — so
    // driving gravity straight off it makes a jump either impossible or, worse,
    // a slow unstoppable climb. An explicit airborne latch, cleared only on the
    // way *down*, is the only version of this that behaves.
    if (!this._airborne && (this.grounded || this._coyote > 0)
        && (this._jumpBuffer > 0 || (this._coyote > 0 && inp.down('jump')))) {
      this._vy = JUMP_V;
      this._jumpBuffer = 0; this._coyote = 0;
      this._airborne = true; this.grounded = false;
    }
    if (this._airborne || !this.grounded) {
      this._vy -= GRAVITY * fdt;
      if (this._vy < -55) this._vy = -55;
      if (this._coyote > 0) this._coyote -= fdt;
    } else if (this._vy <= 0) {
      this._vy = -2.0;               // press into the ground so snap-to-ground bites
    }

    // Snap-to-ground is what keeps him glued to a camber on the way down — and
    // it is also what silently eats a jump, because a 7 cm first step upward is
    // well inside the 35 cm snap distance and gets pulled straight back. Turn it
    // off for exactly as long as he is rising.
    const wantSnap = this._vy <= 0.01;
    if (wantSnap !== this._snapOn) {
      this._snapOn = wantSnap;
      if (wantSnap) this.ctrl.enableSnapToGround(SNAP_GROUND);
      else this.ctrl.disableSnapToGround();
    }

    _delta.x = this.velocity.x * fdt;
    _delta.y = this._vy * fdt;
    _delta.z = this.velocity.z * fdt;

    this.ctrl.computeColliderMovement(this.collider, _delta);
    const m = this.ctrl.computedMovement();
    _next.x = t.x + m.x; _next.y = t.y + m.y; _next.z = t.z + m.z;

    const wasGrounded = this.grounded;
    const onGround = this.ctrl.computedGrounded();
    // Only a descending character may land; while rising, the ground report is
    // the tolerance talking, not the floor.
    if (this._airborne && onGround && this._vy <= 0) this._airborne = false;
    this.grounded = onGround && !this._airborne;
    if (this.grounded) { this._vy = Math.min(this._vy, 0); this._coyote = 0.12; }
    else if (wasGrounded) this._coyote = 0.12;

    // Blocked horizontally? Bleed the velocity so he does not "push" at a wall
    // and shoot sideways the instant it ends.
    if (fdt > 0) {
      const actual = Math.hypot(m.x, m.z) / fdt;
      const wanted = Math.hypot(this.velocity.x, this.velocity.z);
      if (wanted > 0.2 && actual < wanted * 0.6) {
        const s = Math.max(0.0, actual / wanted);
        this.velocity.x *= s; this.velocity.z *= s;
      }
    }

    // Never let a solver hiccup drop him through the world.
    const ground = this.city?.surfaceHeight?.(_next.x, _next.z, _next.y)
      ?? this.city?.groundHeight?.(_next.x, _next.z);
    if (ground !== undefined && _next.y < ground - 6) {
      _next.y = ground + this._hh + CAP_R + 0.1;
      this._vy = 0;
    }
    if (!isFinite(_next.x) || !isFinite(_next.y) || !isFinite(_next.z)) return;

    this.body.setNextKinematicTranslation(_next);
    this.position.set(_next.x, _next.y - this._hh - CAP_R, _next.z);
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * Shrink or restore the capsule.
   *
   * A capsule shrinks about its centre, so changing the half height alone lifts
   * the feet off the ground by the difference. The body has to move down by the
   * same amount for the character to crouch in place rather than hop.
   */
  _setCrouch(on) {
    this.crouching = on;
    if (on === this._crouched) return;
    const hh = on ? CAP_HH_CROUCH : CAP_HH;
    const dy = on ? -(CAP_HH - CAP_HH_CROUCH) : (CAP_HH - CAP_HH_CROUCH);
    try {
      this.collider.setHalfHeight(hh);
      const t = this.body.translation();
      this.body.setTranslation({ x: t.x, y: t.y + dy, z: t.z }, true);
    } catch { return; }               // older binding: keep the standing capsule
    this._crouched = on;
    this._hh = hh;
  }

  /** Face the way he is going; stand still facing wherever he stopped. */
  _updateOnFootVisual(dt) {
    const a = this._actor;
    if (this.speed > 0.35) {
      const target = Math.atan2(-this.velocity.x, -this.velocity.z);
      let d = target - this._yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this._yaw += d * (1 - Math.exp(-dt * 11));
    }
    this.heading = this._yaw;

    const clip = this.grounded
      ? (this.speed < 0.22 ? (this.crouching ? 'crouch' : 'idle')
        : clipForSpeed(this.speed, this.crouching))
      : 'jog';                        // airborne reads best as a held stride
    if (clip !== a.clip) { a.clip = clip; a.clipRow = CLIP_ROW[clip]; }
    a.phase += phaseRate(clip, Math.max(this.speed, this.grounded ? 0 : 2.4), a.h) * dt;
    if (a.phase >= 1) a.phase -= Math.floor(a.phase);

    a.x = this.position.x; a.y = this.position.y; a.z = this.position.z;
    a.yaw = this._yaw;
    a.tilt = 0; a.lean = 0;
  }

  /** Seated: ride the car's transform, with the sit clip. */
  _updateDriving(dt, ctx) {
    const v = this.vehicle;
    if (!v || v.disposed) { this._exitVehicle(); return; }
    const a = this._actor;
    this.position.copy(v.position);
    this.velocity.set(0, 0, 0);
    this.speed = Math.abs(v.speed || 0);
    this.heading = v.heading || 0;

    _e.setFromQuaternion(v.quaternion, 'YXZ');
    a.yaw = _e.y; a.tilt = _e.x; a.lean = _e.z;

    const seat = v.seats?.[0]?.localPos;
    const s = a.h / REF_HEIGHT;
    _v.set(seat ? seat.x : -0.34, (seat ? seat.y : 0.55) - 0.90 * s, (seat ? seat.z : 0.10) + 0.05);
    _v.applyQuaternion(v.quaternion).add(v.position);
    a.x = _v.x; a.y = _v.y; a.z = _v.z;

    if (a.clip !== 'sit') { a.clip = 'sit'; a.clipRow = CLIP_ROW.sit; }
    a.phase += 0.2 * dt;
    if (a.phase >= 1) a.phase -= Math.floor(a.phase);
    void ctx;
  }

  _present() {
    const c = this._crowd;
    c.begin();
    if (this.visible) c.push(this._actor);
    c.end();
  }

  // -- vehicles --------------------------------------------------------------

  _tryEnterVehicle(ctx) {
    const factory = ctx.get('vehicles');
    if (!factory?.nearest) return;
    _v2.set(this.position.x, this.position.y + 0.9, this.position.z);
    let v = factory.nearest(_v2, ENTER_RANGE);
    if (v === this.vehicle) v = null;
    if (!v) {
      // Nothing physical in reach, so try the AI traffic: `Traffic.takeOver`
      // swaps the kinematic car for a real one in the same place. Without this
      // there is nothing in the city to get into — every car on the road is
      // kinematic and has no rigid body.
      const traffic = ctx.get('traffic');
      const car = traffic?.nearestCar?.(this.position.x, this.position.z, ENTER_RANGE + 1.6);
      if (car) v = traffic.takeOver(car, ctx);
    }
    if (!v) return;
    this.vehicle = v;
    this.mode = 'driving';
    this.velocity.set(0, 0, 0);
    this._vy = 0;
    this._airborne = false;
    factory.driveWithInput = true;
    // Out of the collision world entirely: a capsule left inside the car body
    // is a solver fight nobody wins.
    try { this.collider.setCollisionGroups(0); } catch { /* ignore */ }
    this._exitCooldown = 0.4;
    ctx.bus.emit('player:enterVehicle', v);
  }

  _exitVehicle() {
    const ctx = this.ctx;
    const v = this.vehicle;
    this.mode = 'onFoot';
    this.vehicle = null;
    const factory = ctx.get('vehicles');
    if (factory) factory.driveWithInput = false;
    try { this.collider.setCollisionGroups(groups(GROUP.CHARACTER, 0xFFFF)); } catch { /* ignore */ }

    if (v?.position) {
      // Step out on the driver's side: left of the car's forward vector.
      const f = v.forward || _v.set(0, 0, -1);
      const lx = f.z, lz = -f.x;
      const L = Math.hypot(lx, lz) || 1;
      const x = v.position.x + (lx / L) * 1.75;
      const z = v.position.z + (lz / L) * 1.75;
      // Stand him on what is drawn, and pass the car's height so leaving a
      // vehicle on a flyover does not drop him to the street underneath.
      const g = this.city?.surfaceHeight?.(x, z, v.position.y)
        ?? this.city?.groundHeight?.(x, z) ?? v.position.y;
      this.position.set(x, g + 0.05, z);
      this._yaw = Math.atan2(-(lx / L), -(lz / L));
      this.body.setTranslation(
        { x, y: g + 0.05 + this._hh + CAP_R, z }, true);
      this.body.setNextKinematicTranslation({ x, y: g + 0.05 + this._hh + CAP_R, z });
    }
    this.velocity.set(0, 0, 0);
    this._vy = 0;
    this._airborne = false;
    this.grounded = true;
    this._exitCooldown = 0.4;
    if (v) ctx.bus.emit('player:exitVehicle', v);
  }

  // -- misc ------------------------------------------------------------------

  /** Eye position — the camera rig pivots here. */
  eye(out) {
    return out.set(this.position.x,
      this.position.y + (this.crouching ? EYE - 0.42 : EYE),
      this.position.z);
  }

  setWanted(level) {
    const l = Math.max(0, Math.min(5, level | 0));
    if (l === this.wanted) return;
    this.wanted = l;
    this.ctx.bus.emit('player:wanted', l);
  }

  dispose() {
    this.ctx?.bus.off?.('player:wanted', this._onWanted);
    this._crowd?.dispose();
    if (this.P?.world) {
      try { this.ctrl?.free(); } catch { /* already gone */ }
      if (this.body) this.P.world.removeRigidBody(this.body);
    }
    this.body = null; this.collider = null; this.ctrl = null;
  }
}

/** The player's own appearance — fixed, not random, so he is recognisable. */
function makeActor() {
  const a = {
    x: 0, y: 0, z: 0, yaw: 0, tilt: 0, lean: 0,
    h: 1.82, build: 1.02, seed: 0.5,
    phase: 0, clip: 'idle', clipRow: CLIP_ROW.idle,
    topR: 1, topG: 1, topB: 1, botR: 1, botG: 1, botB: 1, skinR: 1, skinG: 1, skinB: 1,
  };
  let n = 0;
  dressActor(a, () => { n += 0.137; return (Math.sin(n * 91.7) * 0.5 + 0.5); });
  // seed 0.5 lands the sleeve test on 'sleeved' and the hair on dark brown.
  // Bare pale forearms read as detached limbs at gameplay distance.
  a.h = 1.82; a.build = 1.02; a.seed = 0.5;
  const c = new THREE.Color();
  c.setHex(0x2a3542); a.topR = c.r; a.topG = c.g; a.topB = c.b;      // dark blue jacket
  c.setHex(0x2b2f36); a.botR = c.r; a.botG = c.g; a.botB = c.b;      // charcoal jeans
  c.setHex(0xc19a78); a.skinR = c.r; a.skinG = c.g; a.skinB = c.b;
  return a;
}
