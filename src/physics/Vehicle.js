import * as THREE from 'three';
import { Tire, TIRE_PRESETS, SURFACE_MU, relaxSlip } from './TireModel.js';
import { GROUP, groups } from './PhysicsWorld.js';

/**
 * Raycast vehicle: one dynamic chassis body, N suspension raycasts, a Magic Formula
 * tyre at each contact patch, and a real drivetrain on top.
 *
 * Design notes that matter:
 *  - The wheels are NOT colliders. Wheel colliders make a car that skates, catches on
 *    seams and needs absurd solver iterations. A ray per wheel plus a spring/damper is
 *    what every shipped driving game does, and it's stable at 60 Hz.
 *  - Suspension *and* tyre forces are applied at the contact patch, not at the hub.
 *    That's the whole reason the car squats, dives and rolls: a force at ground level
 *    offset from a centre of mass 0.5 m up is a moment.
 *  - Forces (not impulses) are accumulated into Rapier and reset each step. `physics`
 *    sorts before us in the engine's dependency order, so we read a freshly stepped
 *    state and stage forces for the next step.
 *
 * Coordinate convention: chassis local -Z is forward, +X is right, +Y is up.
 * `heading` is the Y rotation, so world forward = (-sin h, 0, -cos h); h = 0 faces North.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _tire = { fx: 0, fy: 0, load: 0, slide: 0 };

const RPM_PER_RADS = 60 / (2 * Math.PI);
const RADS_PER_RPM = (2 * Math.PI) / 60;
const AIR_DENSITY = 1.225;

/** Normalised engine torque vs rpm/redline. Peaky enough to be worth using the gearbox. */
const TORQUE_CURVE = [
  [0.00, 0.40], [0.08, 0.60], [0.16, 0.76], [0.26, 0.88], [0.36, 0.955],
  [0.46, 0.99], [0.58, 1.00], [0.70, 0.985], [0.80, 0.945], [0.90, 0.885],
  [1.00, 0.79], [1.10, 0.55],
];

function curveAt(frac) {
  const c = TORQUE_CURVE;
  if (frac <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (frac <= c[i][0]) {
      const t = (frac - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return c[c.length - 1][1] * 0.6;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let _uid = 0;

export default class Vehicle {
  /**
   * @param {object} ctx     engine context
   * @param {object} spec    vehicle spec (see VehicleModels.VEHICLE_SPECS)
   * @param {object} [opts]  { position, heading, visual, color, ai }
   */
  constructor(ctx, spec, opts = {}) {
    this.id = ++_uid;
    this.ctx = ctx;
    this.spec = spec;
    this.type = spec.type;
    this.bus = ctx.bus;
    this.physics = ctx.physics;
    this.alive = true;

    const s = spec.phys;
    this.mass = s.mass;
    this.visual = opts.visual || null;
    this.mesh = this.visual ? this.visual.root : null;
    this.color = opts.color ?? 0xdddddd;

    // ---- inputs -----------------------------------------------------------
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, gearUp: false, gearDown: false };
    this._prevGearUp = false;
    this._prevGearDown = false;

    // ---- state ------------------------------------------------------------
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.rightVec = new THREE.Vector3(1, 0, 0);
    this.upVec = new THREE.Vector3(0, 1, 0);
    this.speed = 0;                 // signed m/s along forward
    this.speedAbs = 0;
    this.heading = opts.heading || 0;
    this.wheelsOnGround = 0;
    this.damage = 0;
    this.headlightsOn = false;
    this.highBeams = false;
    this.sirenOn = false;
    this.hornOn = false;
    this.indicator = 0;             // -1 left, 0 off, 1 right
    this.brakeLightOn = false;
    this.reverseLightOn = false;
    this.lateralG = 0;
    this.longitudinalG = 0;
    this.isPlayer = false;
    this.ai = !!opts.ai;
    this.distanceToCamera = 0;
    this.engineLoad = 0;            // 0..1, audio agent reads this with rpm
    this.slipAmount = 0;            // 0..1 max tyre slide, for skid audio / particles
    this.surface = 'asphalt';

    // ---- drivetrain -------------------------------------------------------
    const e = spec.engine;
    this.redline = e.redline;
    this.idleRpm = e.idle;
    this.peakTorque = e.peakTorque;
    this.gearsF = e.gears.slice();
    this.gearRev = e.reverse;
    this.finalDrive = e.final;
    this.driveline = e.drive;               // 'fwd' | 'rwd' | 'awd'
    this.awdFrontSplit = e.awdFrontSplit ?? 0.4;
    this.engineInertia = e.inertia ?? 0.22;
    this.clutchCapacity = e.clutchCapacity ?? this.peakTorque * 1.9;
    this.autoGearbox = true;
    this.gear = 1;
    this.rpm = this.idleRpm;
    this._omegaE = this.idleRpm * RADS_PER_RPM;
    this.clutch = 1;
    this._shiftTimer = 0;
    this._shiftCooldown = 0;
    this._revCut = 0;
    this._reverseHold = 0;
    this.abs = e.abs ?? true;
    this.tcs = e.tcs ?? true;
    this.esc = e.esc ?? false;
    this._absPhase = 0;
    this._tcCut = 0;
    this.topSpeedLimit = e.topSpeed ?? 999;

    // ---- body -------------------------------------------------------------
    this._buildBody(opts.position || { x: 0, y: 1, z: 0 }, this.heading);
    this._buildWheels();

    // Collision bookkeeping
    this._prevVel = new THREE.Vector3();
    this._appliedAccel = new THREE.Vector3();
    this._forceSum = new THREE.Vector3();
    this._collideCooldown = 0;
    this._restTimer = 0;
    this.physicsLod = 0;          // 0 = full substepping, 1 = cheap (distant traffic)
    this._driveTorque = 0;
    this._reflectedInertia = 0;
    this._effThrottle = 0;
    this._effBrake = 0;

    this.seats = spec.seats.map(st => ({
      name: st.name, localPos: new THREE.Vector3(st.p[0], st.p[1], st.p[2]),
    }));

    this._syncTransform();
  }

  // =========================================================================
  //  Construction
  // =========================================================================

  _buildBody(pos, heading) {
    const P = this.physics;
    const R = P.RAPIER;
    const s = this.spec.phys;

    _q1.setFromAxisAngle(_up.set(0, 1, 0), heading);

    // A box inertia tensor with a real mass distribution: long in Z, so yaw inertia is
    // much larger than roll. Scaled by a fudge factor per axis because a car is not a
    // uniform box — it's heavy low and in the middle.
    const hx = s.width * 0.5, hy = s.height * 0.5, hz = s.length * 0.5;
    const m = s.mass;
    // Local X is right, Y up, Z back — so roll is about Z, pitch about X, yaw about Y.
    // Scaling each axis independently is the cheapest honest way to say "a car is not a
    // uniform box": it's heavy low and amidships, which means low roll inertia relative
    // to yaw. Low roll inertia is what lets weight transfer happen fast enough to feel.
    const kRoll = s.inertiaScale?.[0] ?? 0.85;
    const kYaw = s.inertiaScale?.[1] ?? 1.05;
    const kPitch = s.inertiaScale?.[2] ?? 0.95;
    const Iroll = kRoll * m * (hx * hx * 4 + hy * hy * 4) / 12;
    const Iyaw = kYaw * m * (hx * hx * 4 + hz * hz * 4) / 12;
    const Ipitch = kPitch * m * (hy * hy * 4 + hz * hz * 4) / 12;

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w })
      .setLinearDamping(0.015)
      .setAngularDamping(0.32)
      .setCcdEnabled(true)
      .setAdditionalMassProperties(
        m,
        { x: s.com[0], y: s.com[1], z: s.com[2] },
        { x: Ipitch, y: Iyaw, z: Iroll },
        { x: 0, y: 0, z: 0, w: 1 });
    if (desc.setSoftCcdPrediction) desc.setSoftCcdPrediction(0.5);

    this.body = P.world.createRigidBody(desc);

    // Hull collider: density 0 so it contributes nothing — the mass properties above
    // are authoritative and give us an honest low centre of mass.
    const ch = s.colliderHalf || [hx * 0.98, hy * 0.94, hz * 0.99];
    const cd = R.ColliderDesc.cuboid(ch[0], ch[1], ch[2])
      .setTranslation(0, s.colliderY, 0)
      .setDensity(0)
      .setFriction(0.32)
      .setRestitution(0.06)
      .setCollisionGroups(groups(GROUP.VEHICLE, 0xFFFF))
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    this.collider = P.world.createCollider(cd, this.body);
    this.collider.userData = { vehicle: this };

    this._rayFilter = groups(GROUP.WHEEL, GROUP.STATIC | GROUP.PROP | GROUP.WATER);
    this._ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this._halfExtent = Math.max(hx, hz);
  }

  _buildWheels() {
    const s = this.spec.phys;
    const w = this.spec.wheels;
    const preset = TIRE_PRESETS[s.tire || 'street'];
    this.tire = preset();
    // Nominal load = static corner weight, so load sensitivity is centred on this car.
    this.tire.fz0 = (s.mass * 9.81) / w.length;

    const front = w.filter(x => x.axle === 0);
    this.wheelbase = Math.abs((front[0]?.p[2] ?? -1.4) - (w[w.length - 1].p[2] ?? 1.4));
    this.track = Math.abs(w[0].p[0] - w[1].p[0]);

    this.wheels = w.map((cfg, i) => ({
      index: i,
      side: Math.sign(cfg.p[0]) || 1,
      axle: cfg.axle,
      steered: !!cfg.steer,
      driven: this._isDriven(cfg.axle),
      handbraked: !!cfg.handbrake,
      radius: cfg.radius,
      width: cfg.width,
      inertia: cfg.inertia ?? (cfg.radius * cfg.radius * (s.mass / w.length) * 0.055 + 0.55),

      local: new THREE.Vector3(cfg.p[0], cfg.p[1], cfg.p[2]),
      rest: cfg.rest ?? s.susRest,
      maxComp: (cfg.rest ?? s.susRest) * 0.92,
      stiffness: cfg.stiffness ?? s.susStiffness,
      bump: cfg.bump ?? s.susBump,
      rebound: cfg.rebound ?? s.susRebound,
      arb: cfg.arb ?? (cfg.axle === 0 ? s.arbFront : s.arbRear),

      brakeMax: (cfg.axle === 0 ? s.brakeFront : s.brakeRear),
      handbrakeMax: cfg.handbrake ? s.handbrakeTorque : 0,

      // runtime
      contact: false, hitDist: 0, susLen: cfg.rest ?? s.susRest, prevSusLen: cfg.rest ?? s.susRest,
      compression: 0, load: 0, prevLoad: 0,
      omega: 0, spin: 0, steer: 0, torque: 0,
      kappa: 0, alpha: 0, kappaRaw: 0, alphaRaw: 0, slide: 0, fx: 0, fy: 0,
      surfaceMu: 1, absCut: 0,
      worldPos: new THREE.Vector3(),
      contactPoint: new THREE.Vector3(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
    }));

    // Axle groups for anti-roll bars and differentials.
    this.axles = [];
    for (const wh of this.wheels) {
      (this.axles[wh.axle] || (this.axles[wh.axle] = [])).push(wh);
    }
    this.drivenWheels = this.wheels.filter(x => x.driven);
    this.steerAngle = 0;
    this.steerTarget = 0;
  }

  _isDriven(axle) {
    const nAxles = this.spec.wheels.reduce((a, x) => Math.max(a, x.axle), 0) + 1;
    if (this.driveline === 'awd') return true;
    if (this.driveline === 'fwd') return axle === 0;
    return axle === nAxles - 1;                       // rwd: last axle
  }

  // =========================================================================
  //  Public API (the `vehicles` contract)
  // =========================================================================

  /** @param {{throttle?:number,brake?:number,steer?:number,handbrake?:number,gearUp?:boolean,gearDown?:boolean}} i */
  setInput(i) {
    const n = this.input;
    if (i.throttle !== undefined) n.throttle = clamp(i.throttle, 0, 1);
    if (i.brake !== undefined) n.brake = clamp(i.brake, 0, 1);
    if (i.steer !== undefined) n.steer = clamp(i.steer, -1, 1);
    if (i.handbrake !== undefined) n.handbrake = clamp(i.handbrake, 0, 1);
    if (i.gearUp !== undefined) n.gearUp = !!i.gearUp;
    if (i.gearDown !== undefined) n.gearDown = !!i.gearDown;
  }

  /** Manual shift. Switches the box out of auto until `setAutoGearbox(true)`. */
  shiftUp() {
    if (this._shiftTimer > 0) return;
    this.autoGearbox = false;
    if (this.gear < 0) this._engageGear(0);
    else if (this.gear < this.gearsF.length) this._engageGear(this.gear + 1);
  }
  shiftDown() {
    if (this._shiftTimer > 0) return;
    this.autoGearbox = false;
    if (this.gear > 1) this._engageGear(this.gear - 1);
    else if (this.gear === 1) this._engageGear(0);
    else if (this.gear === 0) this._engageGear(-1);
  }
  setAutoGearbox(on) { this.autoGearbox = !!on; }

  _engageGear(g) {
    if (g === this.gear) return;
    this.gear = g;
    this._shiftTimer = this.spec.engine.shiftTime ?? 0.22;
    this._shiftCooldown = 0.5;
  }

  /** Teleport (respawn, mission setup). Clears all momentum. */
  setTransform(pos, heading) {
    this.heading = heading;
    _q1.setFromAxisAngle(_up.set(0, 1, 0), heading);
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) { w.omega = 0; w.kappa = 0; w.alpha = 0; }
    this._syncTransform();
  }

  /**
   * Register an impact. Deforms the body panel nearest the hit and tells the world.
   * @param {number} impulse  N·s
   * @param {THREE.Vector3|{x,y,z}} worldPoint
   */
  applyDamage(impulse, worldPoint) {
    const j = Math.abs(impulse);
    if (j < 60) return;
    const norm = clamp(j / (this.mass * 9), 0, 1);
    this.damage = clamp(this.damage + norm * 0.55, 0, 1);

    if (this.visual && worldPoint) {
      _v1.set(worldPoint.x, worldPoint.y, worldPoint.z);
      _v1.sub(this.position).applyQuaternion(_q1.copy(this.quaternion).invert());
      this.visual.deform(_v1, clamp(norm, 0, 1));
    }
    this.bus.emit('vehicle:collision', {
      vehicle: this, impulse: j,
      point: worldPoint ? _v2.set(worldPoint.x, worldPoint.y, worldPoint.z).clone() : this.position.clone(),
    });
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    if (this.collider) this.collider.userData = null;
    this.physics.world.removeRigidBody(this.body);
    this.body = null; this.collider = null;
    this.visual?.dispose();
    this.visual = null; this.mesh = null;
  }

  // =========================================================================
  //  Simulation
  // =========================================================================

  /** @param {number} fdt fixed step (1/60) */
  fixedUpdate(fdt) {
    if (!this.alive) return;
    const body = this.body;

    this._syncTransform();

    const inputActive = this.input.throttle > 0.01 || this.input.brake > 0.01 ||
      this.input.handbrake > 0.01 || Math.abs(this.input.steer) > 0.01;
    const sleeping = body.isSleeping();
    if (sleeping && !inputActive) {
      // Parked. Nothing to integrate; leave the solver alone so it stays asleep.
      this._restTimer += fdt;
      this.speed = 0; this.speedAbs = 0;
      this.rpm += (this.idleRpm - this.rpm) * 0.1;
      return;
    }
    if (inputActive && sleeping) body.wakeUp();

    body.resetForces(false);
    body.resetTorques(false);
    this._forceSum.set(0, 0, 0);

    this._shiftCooldown = Math.max(0, this._shiftCooldown - fdt);
    this._revCut = Math.max(0, this._revCut - fdt);
    this._collideCooldown = Math.max(0, this._collideCooldown - fdt);
    this._absPhase += fdt * 13.5;

    this._pollGearInputs();
    this._updateSteering(fdt);
    this._castSuspension();
    this._applySuspension(fdt);
    this._updateDrivetrain(fdt);
    this._updateTires(fdt);
    this._applyAero();
    this._applyStabilisers(fdt);
    this._detectImpacts(fdt);
    this._updateRest(fdt, inputActive);
  }

  _syncTransform() {
    const b = this.body;
    const t = b.translation(), r = b.rotation(), v = b.linvel(), a = b.angvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(v.x, v.y, v.z);
    this.angular.set(a.x, a.y, a.z);

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.rightVec.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.upVec.set(0, 1, 0).applyQuaternion(this.quaternion);

    this.speed = this.velocity.dot(this.forward);
    this.speedAbs = this.velocity.length();
    this.heading = Math.atan2(-this.forward.x, -this.forward.z);
  }

  /** Velocity of a world-space point on the chassis, into `out`. */
  _pointVel(out, worldPoint) {
    _v5.copy(worldPoint).sub(this.position);
    return out.copy(this.angular).cross(_v5).add(this.velocity);
  }

  /** Stage a force and remember it, so impact detection knows what we asked for. */
  _addForceAt(force, point) {
    this._forceSum.add(force);
    this.body.addForceAtPoint(force, point, false);
  }

  _pollGearInputs() {
    if (this.input.gearUp && !this._prevGearUp) this.shiftUp();
    if (this.input.gearDown && !this._prevGearDown) this.shiftDown();
    this._prevGearUp = this.input.gearUp;
    this._prevGearDown = this.input.gearDown;
  }

  // ---- steering -----------------------------------------------------------

  _updateSteering(fdt) {
    const s = this.spec.phys;
    const v = this.speedAbs;
    // Speed-sensitive ratio: full lock parking, a wrist-flick at motorway speed.
    const t = clamp((v - 4) / 42, 0, 1);
    const maxSteer = THREE.MathUtils.lerp(s.steerMax, s.steerMaxHigh, t * t);

    let target = this.input.steer * maxSteer;

    // Caster self-centre. Real cars pull the wheel straight harder the faster you go;
    // this is what makes the car track straight without the driver sawing at it.
    if (Math.abs(this.input.steer) < 0.06) {
      const centre = clamp(v / 12, 0, 1) * s.selfCentre;
      target = this.steerAngle * (1 - centre * fdt * 12);
      if (Math.abs(target) < 0.002) target = 0;
    }

    const rate = s.steerRate * THREE.MathUtils.lerp(1, 0.45, t);
    const d = clamp(target - this.steerAngle, -rate * fdt, rate * fdt);
    this.steerAngle += d;
    this.steerTarget = target;

    // Ackermann: the inside wheel turns tighter, because the two wheels trace circles
    // about the same centre. Without it a car scrubs badly at parking speed.
    const wb = this.wheelbase, tr = this.track;
    const a = this.steerAngle;
    let inner = a, outer = a;
    if (Math.abs(a) > 1e-4) {
      const R = wb / Math.tan(Math.abs(a));
      inner = Math.atan(wb / Math.max(R - tr * 0.5, wb * 0.22));
      outer = Math.atan(wb / (R + tr * 0.5));
      const sg = Math.sign(a);
      inner *= sg; outer *= sg;
    }
    for (const w of this.wheels) {
      if (!w.steered) { w.steer = 0; continue; }
      const isInner = Math.sign(w.local.x) === Math.sign(a);
      w.steer = a === 0 ? 0 : (isInner ? inner : outer);
    }
  }

  // ---- suspension ---------------------------------------------------------

  _castSuspension() {
    const world = this.physics.world;
    const ray = this._ray;
    let grounded = 0;

    for (const w of this.wheels) {
      // Ray from the top of suspension travel, straight down the chassis' own Y.
      _v1.copy(w.local).applyQuaternion(this.quaternion).add(this.position);
      w.worldPos.copy(_v1);
      _v2.copy(this.upVec).multiplyScalar(-1);

      ray.origin.x = _v1.x; ray.origin.y = _v1.y; ray.origin.z = _v1.z;
      ray.dir.x = _v2.x; ray.dir.y = _v2.y; ray.dir.z = _v2.z;

      const maxT = w.rest + w.radius;
      const hit = world.castRayAndGetNormal(
        ray, maxT, true, undefined, this._rayFilter, undefined, this.body);

      w.prevSusLen = w.susLen;
      if (hit && hit.timeOfImpact <= maxT) {
        w.contact = true;
        w.hitDist = hit.timeOfImpact;
        w.susLen = clamp(hit.timeOfImpact - w.radius, 0, w.rest);
        w.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        if (w.contactNormal.dot(this.upVec) < 0) w.contactNormal.multiplyScalar(-1);
        w.contactPoint.copy(_v1).addScaledVector(_v2, hit.timeOfImpact);
        w.compression = w.rest - w.susLen;
        grounded++;
      } else {
        w.contact = false;
        w.hitDist = maxT;
        w.susLen = w.rest;
        w.compression = 0;
        w.load = 0;
        w.contactNormal.copy(this.upVec);
        w.contactPoint.copy(_v1).addScaledVector(_v2, w.rest + w.radius);
      }
    }
    this.wheelsOnGround = grounded;
  }

  _applySuspension(fdt) {
    const inv = 1 / fdt;
    // Pass 1: spring + damper.
    for (const w of this.wheels) {
      if (!w.contact) { w.load = 0; continue; }

      let f = w.stiffness * w.compression;

      // Progressive bump stop — the last 8% of travel gets very stiff instead of
      // punching straight through to the chassis collider.
      const over = w.compression - w.maxComp;
      if (over > 0) f += w.stiffness * 14 * over * over / Math.max(w.rest, 0.01);

      // Damper works on the rate of change of suspension length. Rebound is always
      // stiffer than bump on a real car — that asymmetry is why a car settles after a
      // kerb instead of pogoing.
      const vel = (w.prevSusLen - w.susLen) * inv;     // +ve = compressing
      f += (vel > 0 ? w.bump : w.rebound) * vel;

      w.load = f < 0 ? 0 : f;
    }

    // Pass 2: anti-roll bars. A torsion bar between the two wheels of an axle that
    // fights *difference* in travel, so it stiffens the car in roll without stiffening
    // it in heave. Front/rear balance here is the main handling-balance knob.
    for (const ax of this.axles) {
      if (!ax || ax.length !== 2) continue;
      const [a, b] = ax;
      if (!a.contact && !b.contact) continue;
      const d = (a.compression - b.compression) * a.arb;
      a.load = Math.max(0, a.load - d);
      b.load = Math.max(0, b.load + d);
    }

    // Pass 3: push. Applied at the contact patch so the moment arm to the centre of
    // mass is real — this is what produces squat, dive and body roll.
    for (const w of this.wheels) {
      if (!w.contact || w.load <= 0) continue;
      _v1.copy(this.upVec).multiplyScalar(w.load);
      this._addForceAt(_v1, w.contactPoint);
    }
  }

  // ---- drivetrain ---------------------------------------------------------

  _gearRatio() {
    if (this.gear > 0) return this.gearsF[this.gear - 1] * this.finalDrive;
    if (this.gear < 0) return -this.gearRev * this.finalDrive;
    return 0;
  }

  _updateDrivetrain(fdt) {
    const inp = this.input;

    // GTA-style reverse: hold the brake at a standstill and the box drops into R,
    // then the brake pedal becomes reverse throttle.
    let throttle = inp.throttle, brake = inp.brake;
    if (this.spec.engine.autoReverse !== false && this.autoGearbox) {
      if (this.gear >= 0 && this.speed < 0.7 && brake > 0.35 && throttle < 0.15) {
        this._reverseHold += fdt;
        if (this._reverseHold > 0.22) { this._engageGear(-1); this._reverseHold = 0; }
      } else if (this.gear < 0 && this.speed > -0.7 && throttle > 0.35) {
        this._engageGear(1);
      } else {
        this._reverseHold = 0;
      }
      if (this.gear < 0) { const t = throttle; throttle = brake; brake = t; }
    }
    this._effThrottle = throttle;
    this._effBrake = brake;

    // Shift progress. The clutch drops out entirely mid-shift, which is why an upshift
    // at full throttle produces a real lurch.
    if (this._shiftTimer > 0) {
      this._shiftTimer = Math.max(0, this._shiftTimer - fdt);
      this.clutch = this._shiftTimer > 0 ? 0 : 1;
    }

    const ratio = this._gearRatio();
    let avgOmega = 0, n = 0;
    for (const w of this.drivenWheels) { avgOmega += w.omega; n++; }
    avgOmega = n ? avgOmega / n : 0;
    const omegaIn = avgOmega * ratio;

    // Clutch engagement: slips near idle so the car creeps away from rest instead of
    // stalling or launching, locks solid once the wheels are spinning.
    const idleOmega = this.idleRpm * RADS_PER_RPM;
    let lock = 1;
    if (this._shiftTimer > 0) lock = 0;
    else if (ratio === 0) lock = 0;
    else lock = clamp((Math.abs(omegaIn) - idleOmega * 0.30) / (idleOmega * 0.85), 0, 1);
    // Feathering the throttle from rest should still bite.
    if (throttle > 0.05 && lock < 1) lock = Math.max(lock, throttle * 0.55);
    this.clutch = lock;

    // Rev limiter: hard cut, then let it fall back. Gives the bounce off the limiter
    // that the audio agent can key a fuel-cut sample to.
    if (this.rpm > this.redline) this._revCut = 0.055;
    let thr = this._revCut > 0 ? 0 : throttle;

    // Traction control trims throttle when a driven wheel lights up.
    if (this.tcs) {
      let worst = 0;
      for (const w of this.drivenWheels) worst = Math.max(worst, Math.abs(w.kappa));
      const over = worst - (this.tire.peakSlip * 1.25);
      this._tcCut = over > 0
        ? Math.min(1, this._tcCut + over * 9 * fdt)
        : Math.max(0, this._tcCut - 3.2 * fdt);
      thr *= 1 - clamp(this._tcCut, 0, 0.92);
    } else this._tcCut = 0;

    // Damage saps power.
    thr *= 1 - this.damage * 0.4;

    const frac = this.rpm / this.redline;
    const drive = this.peakTorque * curveAt(frac) * thr;
    const friction = this.peakTorque * (0.055 + 0.10 * frac) * (1 - thr * 0.85);
    const engT = drive - friction;

    if (lock > 0.995 && ratio !== 0) {
      // Locked: engine speed is dictated by the wheels. The engine's rotating inertia
      // is reflected into the wheels below, which is why first gear feels heavy.
      this._omegaE = Math.max(Math.abs(omegaIn), idleOmega * 0.92);
      this._driveTorque = engT * ratio * (this.spec.engine.efficiency ?? 0.9);
    } else {
      const cap = this.clutchCapacity * lock;
      const slip = this._omegaE - omegaIn;
      const Tc = clamp(cap * Math.tanh(slip * 0.28), -cap, cap);
      this._omegaE += (engT - Tc) / this.engineInertia * fdt;
      this._driveTorque = Tc * ratio * (this.spec.engine.efficiency ?? 0.9);
    }
    this._omegaE = clamp(this._omegaE, idleOmega * 0.55, this.redline * RADS_PER_RPM * 1.08);
    this.rpm = this._omegaE * RPM_PER_RADS;
    this.engineLoad = clamp(thr * (0.35 + 0.65 * curveAt(frac)), 0, 1);

    // Reflected drivetrain inertia at each driven wheel.
    const eff = lock > 0.5 ? lock : 0;
    this._reflectedInertia = ratio === 0 ? 0
      : this.engineInertia * ratio * ratio * eff / Math.max(this.drivenWheels.length, 1);

    if (this.autoGearbox && this._shiftTimer <= 0) this._autoShift(fdt, throttle);
  }

  _autoShift(fdt, throttle) {
    if (this.gear < 0) return;
    if (this.gear === 0 && Math.abs(this.speed) < 0.5) { this._engageGear(1); return; }
    if (this._shiftCooldown > 0) return;

    const e = this.spec.engine;
    // Shift points follow the pedal: cruise up early, floor it and hold to the limiter.
    const up = THREE.MathUtils.lerp(e.shiftUpLight ?? 0.44, e.shiftUpFull ?? 0.955, throttle) * this.redline;
    const down = THREE.MathUtils.lerp(e.shiftDownLight ?? 0.20, e.shiftDownFull ?? 0.62, throttle) * this.redline;

    if (this.gear < this.gearsF.length && this.rpm > up && this.speed > 1) {
      this._engageGear(this.gear + 1);
    } else if (this.gear > 1 && this.rpm < down) {
      this._engageGear(this.gear - 1);
    }
  }

  /** Split axle torque across two wheels through a limited-slip differential. */
  _diffSplit(axle, torque, out) {
    if (!axle || axle.length < 2) { out[0] = torque; out[1] = 0; return out; }
    const [a, b] = axle;
    const half = torque * 0.5;
    const s = this.spec.engine;
    const dw = a.omega - b.omega;
    // Preload always resists, plus a torque-sensitive component (a real Torsen/clutch
    // pack bites harder the more torque is going through it).
    const bias = ((s.lsdPreload ?? 40) + (s.lsdPower ?? 0.28) * Math.abs(torque)) *
      Math.tanh(dw * 0.85);
    out[0] = half - bias;
    out[1] = half + bias;
    return out;
  }

  // ---- tyres --------------------------------------------------------------

  _updateTires(fdt) {
    const SUB = this.physicsLod === 1 ? 1 : 3;
    const h = fdt / SUB;
    const inp = this.input;
    const brake = this._effBrake;
    const handbrake = inp.handbrake;

    // Distribute drive torque through the differentials once per step.
    const split = this._splitBuf || (this._splitBuf = [0, 0]);
    const total = this._driveTorque || 0;
    for (const w of this.wheels) w.torque = 0;

    if (this.driveline === 'awd') {
      const fAx = this.axles[0];
      const rAx = this.axles[this.axles.length - 1];
      const fT = total * this.awdFrontSplit, rT = total * (1 - this.awdFrontSplit);
      this._diffSplit(fAx, fT, split); if (fAx) { fAx[0].torque = split[0]; fAx[1].torque = split[1]; }
      this._diffSplit(rAx, rT, split); if (rAx) { rAx[0].torque = split[0]; rAx[1].torque = split[1]; }
    } else {
      const ax = this.driveline === 'fwd' ? this.axles[0] : this.axles[this.axles.length - 1];
      this._diffSplit(ax, total, split);
      if (ax) { ax[0].torque = split[0]; ax[1].torque = split[1]; }
    }

    let maxSlide = 0;
    const surfMu = SURFACE_MU[this.surface] ?? 1;

    for (const w of this.wheels) {
      // Wheel axes projected onto the contact plane so grip doesn't change on a camber.
      _fwd.copy(this.forward).applyAxisAngle(this.upVec, -w.steer);
      _right.copy(this.rightVec).applyAxisAngle(this.upVec, -w.steer);
      const n = w.contactNormal;
      _fwd.addScaledVector(n, -_fwd.dot(n)).normalize();
      _right.addScaledVector(n, -_right.dot(n)).normalize();
      w.fwd.copy(_fwd); w.right.copy(_right);

      if (!w.contact) {
        // Free wheel: drive torque spins it up, brakes slow it, nothing else.
        let om = w.omega + w.torque /
          (w.inertia + (w.driven ? this._reflectedInertia : 0)) * fdt;
        const bt = (w.brakeMax * brake + w.handbrakeMax * handbrake) / w.inertia * fdt;
        om = Math.abs(om) <= bt ? 0 : om - Math.sign(om) * bt;
        w.omega = om;
        w.fx = 0; w.fy = 0; w.kappa = 0; w.alpha = 0; w.slide = 0;
        w.spin += w.omega * fdt;
        continue;
      }

      this._pointVel(_v3, w.contactPoint);
      const vLong = _v3.dot(_fwd);
      const vLat = _v3.dot(_right);
      const vRef = Math.max(Math.abs(vLong), 1.6);

      w.surfaceMu = surfMu;
      const I = w.inertia + (w.driven ? this._reflectedInertia : 0);

      // ABS: bleed brake pressure the moment the wheel starts to lock, and pulse it,
      // because a locked wheel gives up both stopping power and all steering.
      let brakeT = w.brakeMax * brake * (1 - this.damage * 0.25);
      if (this.abs && brake > 0.02 && Math.abs(vLong) > 2.2) {
        const lockUp = -w.kappa - this.tire.peakSlip * 1.15;
        w.absCut = lockUp > 0 ? Math.min(1, w.absCut + lockUp * 14 * fdt)
                              : Math.max(0, w.absCut - 5 * fdt);
        const pulse = w.absCut > 0.05 ? (0.55 + 0.45 * Math.sin(this._absPhase * 6.28)) : 1;
        brakeT *= 1 - clamp(w.absCut, 0, 0.85) * pulse;
      } else w.absCut = 0;
      brakeT += w.handbrakeMax * handbrake;

      // Rolling resistance as a wheel torque (it is one — deflection hysteresis).
      const rr = this.tire.crr * w.load * w.radius;

      let fxAcc = 0, fyAcc = 0;
      for (let s = 0; s < SUB; s++) {
        const kTarget = (w.omega * w.radius - vLong) / vRef;
        const aTarget = Math.atan2(vLat, vRef);
        w.kappa = relaxSlip(w.kappa, kTarget, vRef, this.tire.relaxLong, h);
        w.alpha = relaxSlip(w.alpha, aTarget, vRef, this.tire.relaxLat, h);
        w.kappaRaw = kTarget; w.alphaRaw = aTarget;

        this.tire.solve(_tire, w.load, w.kappa, w.alpha, surfMu);

        // Wheel spin: I*dw = T_drive - Fx*r - T_brake - T_rr
        let om = w.omega + (w.torque - _tire.fx * w.radius) / I * h;
        const resist = (brakeT + rr) / I * h;
        om = Math.abs(om) <= resist ? 0 : om - Math.sign(om) * resist;
        w.omega = om;

        fxAcc += _tire.fx; fyAcc += _tire.fy;
        w.slide = _tire.slide;
      }
      w.fx = fxAcc / SUB;
      w.fy = fyAcc / SUB;
      w.spin += w.omega * fdt;
      if (w.slide > maxSlide && Math.abs(vLong) > 1.5) maxSlide = w.slide;

      // Static-friction stand-in. Below walking pace the slip equations have no
      // resolution left, so clamp residual contact-patch motion directly. This is the
      // difference between a car that parks and a car that buzzes.
      if (this.speedAbs < 0.9) {
        const grip = _tire.load * 0.9;
        const kk = clamp(1 - this.speedAbs / 0.9, 0, 1) * 0.85;
        w.fx = THREE.MathUtils.lerp(w.fx, clamp(-vLong * this.mass * 2.2 / this.wheels.length, -grip, grip),
          w.torque === 0 && this._effThrottle < 0.05 ? kk : kk * 0.35);
        w.fy = THREE.MathUtils.lerp(w.fy, clamp(-vLat * this.mass * 2.6 / this.wheels.length, -grip, grip), kk);
      }

      _v4.copy(_fwd).multiplyScalar(w.fx).addScaledVector(_right, w.fy);
      this._addForceAt(_v4, w.contactPoint);
    }

    this.slipAmount = maxSlide;
  }

  // ---- aero, assists, impacts --------------------------------------------

  _applyAero() {
    const s = this.spec.phys;
    const v = this.speedAbs;
    if (v < 0.4) return;
    const q = 0.5 * AIR_DENSITY * v * v;

    // Drag opposes the velocity vector, applied a touch above the centre of mass so a
    // fast car gets light at the front the way a real one does.
    _v1.copy(this.velocity).multiplyScalar(-q * s.cdA / Math.max(v, 0.001));
    _v2.copy(this.position).addScaledVector(this.upVec, 0.25);
    this._addForceAt(_v1, _v2);

    // Downforce split front/rear so it also trims the aero balance, not just grip.
    if (s.clAFront || s.clARear) {
      const wb = this.wheelbase * 0.5;
      _v1.copy(this.upVec).multiplyScalar(-q * s.clAFront);
      _v2.copy(this.position).addScaledVector(this.forward, wb);
      this._addForceAt(_v1, _v2);
      _v1.copy(this.upVec).multiplyScalar(-q * s.clARear);
      _v2.copy(this.position).addScaledVector(this.forward, -wb);
      this._addForceAt(_v1, _v2);
    }

    // Soft top-speed limiter (traffic cars, buses).
    if (this.speed > this.topSpeedLimit) {
      _v1.copy(this.forward).multiplyScalar(-(this.speed - this.topSpeedLimit) * this.mass * 2.5);
      this._addForceAt(_v1, this.position);
    }
  }

  _applyStabilisers(fdt) {
    const air = this.wheels.length - this.wheelsOnGround;

    if (air >= this.wheels.length - 1) {
      // Airborne: a little pitch/roll authority so landings can be saved. Small enough
      // that it never reads as flying, big enough that a jump isn't a coin toss.
      const s = this.spec.phys.airControl ?? 0.9;
      _v1.copy(this.forward).multiplyScalar(-this.input.steer * s * this.mass * 0.9);
      this.body.addTorque(_v1, false);
      // Kill spin so we land flat-ish.
      _v1.copy(this.angular).multiplyScalar(-this.mass * 0.06);
      this.body.addTorque(_v1, false);
    } else if (this.wheelsOnGround > 0) {
      // Anti-flip: only fights roll that has already gone past the point of no return,
      // so normal cornering roll is untouched.
      const tilt = this.upVec.y;
      if (tilt < 0.55 && this.speedAbs > 2) {
        _v1.crossVectors(this.upVec, _v2.set(0, 1, 0)).multiplyScalar(this.mass * 0.55);
        this.body.addTorque(_v1, false);
      }
    }

    // Electronic stability control (traffic + police): brake the outside front wheel
    // when the yaw rate overshoots what the steering asked for.
    if (this.esc && this.wheelsOnGround >= 3 && this.speedAbs > 6) {
      const desired = this.speed * Math.tan(this.steerAngle) / Math.max(this.wheelbase, 0.5);
      const err = clamp(this.angular.dot(this.upVec) - desired, -1.2, 1.2);
      if (Math.abs(err) > 0.16) {
        _v1.copy(this.upVec).multiplyScalar(-err * this.mass * 0.35);
        this.body.addTorque(_v1, false);
      }
    }
  }

  _detectImpacts(fdt) {
    // Residual = the velocity change the solver produced that our own forces plus
    // gravity don't explain. That's a contact. Far cheaper and more robust than
    // digging manifolds out of the narrow phase every step for every car.
    _v1.copy(this.velocity).sub(this._prevVel);
    _v1.addScaledVector(this._appliedAccel, -fdt);
    _v1.y += 9.81 * fdt;
    const dv = _v1.length();

    this._prevVel.copy(this.velocity);
    this._appliedAccel.copy(this._forceSum).divideScalar(this.mass);

    if (dv > 0.7 && this._collideCooldown <= 0) {
      // Impact point: walk back along the push direction to the hull surface.
      _v2.copy(_v1).normalize().multiplyScalar(-1);
      _v3.copy(this.position).addScaledVector(_v2, this._halfExtent * 0.9);
      this._collideCooldown = 0.16;
      this.applyDamage(this.mass * dv, _v3);
    }
  }

  _updateRest(fdt, inputActive) {
    if (this.speedAbs < 0.08 && !inputActive && this.wheelsOnGround === this.wheels.length) {
      this._restTimer += fdt;
      if (this._restTimer > 1.2) this.body.sleep?.();
    } else this._restTimer = 0;
  }

  // =========================================================================
  //  Presentation
  // =========================================================================

  /** Per-frame visual sync. Cheap; safe to call at render rate. */
  update(dt, ctx) {
    if (!this.alive || !this.visual) return;
    const v = this.visual;
    v.root.position.copy(this.position);
    v.root.quaternion.copy(this.quaternion);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      v.setWheel(i, w.susLen, w.steer, w.spin);
    }

    // Lights. Brake lamps follow the *actual* braking effort, not the key.
    const tod = ctx.time.timeOfDay;
    if (this.ai) this.headlightsOn = tod > 18.2 || tod < 6.8;
    this.brakeLightOn = this._effBrake > 0.06 || this.input.handbrake > 0.35;
    this.reverseLightOn = this.gear < 0;
    v.setLights(this, dt);
  }
}

export { SURFACE_MU, Tire };
