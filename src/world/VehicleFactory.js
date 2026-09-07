import * as THREE from 'three';
import { yieldToPaint } from '../core/Yield.js';
import Vehicle from '../physics/Vehicle.js';
import {
  VEHICLE_TYPES, VEHICLE_SPECS, createMaterialKit, buildVehicleVisual,
  getVehicleGeometry, getShellGeometry, disposeSharedGeometry,
} from './VehicleModels.js';

/**
 * The `vehicles` system: spawning, level of detail, and the instanced shell pool that
 * keeps a city full of traffic inside the 1200 draw-call budget.
 *
 * Draw-call budget per car:
 *   LOD0  (<32 m)   ~7 body + 3 per wheel   — the player's car and its neighbours
 *   LOD1  (<115 m)  5 total, wheels baked into the body
 *   LOD2  (>115 m)  0 extra — folded into two InstancedMesh per type, for any count
 */

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();

const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 3.2);

const LOD0_DIST = 32;
const LOD1_DIST = 115;
const HYST = 1.12;

/**
 * How many cars the player has abandoned stay in the world as real vehicles.
 *
 * `Traffic.takeOver` is the only thing that ever spawns here, so every entry in
 * `list` is a car the player took — and nothing used to remove them. Measured
 * over twelve consecutive thefts: `list` +1.00 per theft, Rapier rigid bodies
 * +1.00, colliders **+11.75**, LightManager sources +4.33, and never a single
 * despawn. A car is also a `fixedUpdate` every physics step and a visual with
 * its own light rig, so an hour of driving across Boston monotonically degrades
 * the frame with cars the player left behind and cannot see.
 *
 * Eight is a gameplay number, not a budget one: leaving a car and coming back
 * for it has to work, and a small trail of recently abandoned cars is part of
 * what makes the city feel used. Beyond that the oldest are reclaimed.
 */
const ABANDONED_KEEP = 8;
/**
 * Hard ceiling on abandoned cars, whatever the player does.
 *
 * The distance rule below is not enough on its own, and measuring showed why:
 * driving around one district and taking a new car every few hundred metres
 * leaves every abandoned car inside the protection radius, so 24 thefts still
 * left 21 live vehicles against a soft cap of 8. Traffic is spawned around the
 * camera, so the cars available to steal are always near the player and so is
 * everything he abandons. Past this count the oldest car the player cannot
 * currently see is reclaimed regardless of how close it is.
 */
const ABANDONED_MAX = 14;
/**
 * Nothing is reclaimed within this radius of the camera, in metres.
 *
 * Comfortably past `LOD1_DIST` (115), where a car is already a five-draw
 * silhouette, so a reclaimed car cannot be one the player was looking at.
 */
const REAP_RADIUS = 160;
/** At the hard ceiling, still never reclaim a car this close, in metres. */
const REAP_NEAR = 45;
/** Above this speed, in m/s, a car is still doing something and is left alone. */
const REAP_SPEED = 1.0;

/** One InstancedMesh pair per vehicle type, holding every distant car of that type. */
class ShellPool {
  constructor(type, kit, scene, cap = 64) {
    const { paint, trim } = getShellGeometry(type);
    this.cap = cap;
    this.n = 0;
    this.scene = scene;
    this.meshes = [];
    if (paint) {
      const m = new THREE.InstancedMesh(paint, kit.paint(0xffffff), cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.count = 0;
      // Per-instance tint: one material, one draw call, every colour in the city.
      m.setColorAt(0, _col.setHex(0xffffff));
      this.paint = m; this.meshes.push(m); scene.add(m);
    }
    if (trim) {
      const m = new THREE.InstancedMesh(trim, kit.trim, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.count = 0;
      this.trim = m; this.meshes.push(m); scene.add(m);
    }
  }

  begin() { this.n = 0; }

  push(matrix, colorHex) {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    if (this.paint) {
      this.paint.setMatrixAt(i, matrix);
      this.paint.setColorAt(i, _col.setHex(colorHex));
    }
    if (this.trim) this.trim.setMatrixAt(i, matrix);
    return true;
  }

  end() {
    for (const m of this.meshes) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of this.meshes) { this.scene.remove(m); m.dispose(); }
    this.meshes.length = 0;
  }
}

export default class VehicleFactory {
  static id = 'vehicles';
  static label = 'Vehicles';
  static deps = ['physics', 'assets'];

  constructor() {
    this.types = VEHICLE_TYPES.slice();
    this.specs = VEHICLE_SPECS;
    this.list = [];
    this.pools = new Map();
    this._lodCursor = 0;
    this._enableInstancing = true;
    /** Set by the gameplay agent (or the dev harness) to drive a car from ctx.input. */
    this.playerVehicle = null;
    this.driveWithInput = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.kit = createMaterialKit(ctx);
    this.lighting = ctx.get('lighting');
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    ctx.scene.add(this.group);

    // Lofting a body is 30-200 ms. Doing it on demand mid-game is a visible hitch, so
    // pay for every type up front while the loading screen is still on screen.
    //
    // The yield below MUST NOT be `setTimeout`. All nine types loft in ~380 ms, but a
    // hidden tab clamps timers to >=1/s (1/min once hidden five minutes), so nine
    // `setTimeout(0)` yields measured 2896 ms here and were the whole of the 49 s
    // `vehicles` init reported on a loaded machine. See `src/core/Yield.js`.
    for (const t of this.types) {
      getVehicleGeometry(t);
      await yieldToPaint();                        // let the loading bar paint
    }

    this._onEnter = (v) => {
      if (!v) return;
      v._abandonedAt = 0;
      v.unpark?.();
      // Hand the car back its authored damping, or it drives like it is towing
      // something.
      try {
        v.body.setLinearDamping(v._dampBase ?? 0);
        v.body.setAngularDamping(v._angDampBase ?? 0);
      } catch { /* older binding */ }
      this.setPlayerVehicle(v);
    };
    /**
     * Park the car the player just stepped out of.
     *
     * Two things were wrong with simply letting go of it. `setInput` PERSISTS,
     * and once a car stops being `playerVehicle` nothing calls `_readInput` for
     * it again — so it keeps whatever the player last held. Step out at full
     * throttle and the car drives itself across Boston for the rest of the
     * session, steering locked at whatever angle it had.
     *
     * And even at neutral it does not come to rest: measured on 32 abandoned
     * cars a median of 2.7 km behind the player, every one was still rolling at
     * 2-5 m/s with `isSleeping()` false, purely horizontal, indefinitely. A car
     * you leave at the kerb is supposed to be there when you come back, and
     * nothing that never stops moving can ever be reclaimed either — this is
     * what made the first version of `_reap` reclaim almost nothing.
     *
     * `Vehicle.park()` is what actually stops it — neutral, so the drivetrain
     * stops replacing the energy damping removes — and it avoids the brake
     * lamps that a handbrake input would leave burning on an empty car. `_abandonedAt` is stamped so the reaper takes the car
     * left longest ago, which is not the car spawned longest ago once the player
     * goes back for one.
     */
    this._onExit = (v) => {
      this.setPlayerVehicle(null);
      if (!v) return;
      v._abandonedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      v.park?.();
      try {
        v.body.setLinearDamping(1.4);
        v.body.setAngularDamping(2.2);
      } catch { /* older binding: it will coast, and the reaper will wait */ }
    };
    ctx.bus.on('player:enterVehicle', this._onEnter);
    ctx.bus.on('player:exitVehicle', this._onExit);
  }

  // -------------------------------------------------------------------------
  //  Contract API
  // -------------------------------------------------------------------------

  /**
   * @param {string} type      one of `vehicles.types`
   * @param {{x:number,y:number,z:number}} pos  ground contact point (the model origin
   *   sits on the road surface, so pass the road height directly)
   * @param {number} [heading] radians about +Y; 0 faces North (-Z)
   * @param {object} [opts]    { color, ai, lod }
   * @returns {Vehicle}
   */
  spawn(type, pos, heading = 0, opts = {}) {
    const spec = this.specs[type] || this.specs.sedan;
    const color = opts.color ?? pickColor(spec);
    const visual = buildVehicleVisual(spec.type, {
      kit: this.kit, color, castShadow: opts.castShadow !== false,
    });
    const y = (pos.y ?? 0) + 0.05;
    const v = new Vehicle(this.ctx, spec, {
      position: { x: pos.x, y, z: pos.z },
      heading, visual, color, ai: !!opts.ai,
    });
    v.factory = this;
    // Recorded once, so `_onExit` can damp an abandoned car to a stop and
    // `_onEnter` can give the authored values back.
    try {
      v._dampBase = v.body.linearDamping();
      v._angDampBase = v.body.angularDamping();
    } catch { v._dampBase = 0; v._angDampBase = 0; }
    this.group.add(visual.root);
    // Place the root before registering: `registerVehicleLights` samples the
    // anchors' world matrices, and `Vehicle` does not move the visual until its
    // first update(), so registering here on an unplaced root would put a frame
    // of headlight pool at the world origin.
    visual.root.position.set(pos.x, y, pos.z);
    visual.root.rotation.y = heading;
    visual.lightRig = this._buildLightRig(visual, spec.type);
    this.list.push(v);
    return v;
  }

  /**
   * A headlight/tail-lamp rig sized to this body, or null if the lighting agent
   * is absent. Owned by the visual, which releases it in `VehicleVisual.dispose()`
   * — so every teardown path frees the slots, not just `despawn()`.
   */
  _buildLightRig(visual, type) {
    if (!this.lighting?.registerVehicleLights) return null;
    try {
      const a = getVehicleGeometry(type).anchors;
      if (!a.head.length && !a.tail.length) return null;
      return this.lighting.registerVehicleLights(visual.root, {
        front: a.head.map(p => [p.x, p.y, p.z]),
        rear: a.tail.map(p => [p.x, p.y, p.z]),
      });
    } catch (err) {
      console.warn('[vehicles] light rig failed for', type, err);
      return null;
    }
  }

  /** @param {Vehicle} v */
  despawn(v) {
    const i = this.list.indexOf(v);
    if (i >= 0) this.list.splice(i, 1);
    v.dispose();
  }

  /** Route `ctx.input` into this car. The gameplay agent normally owns this. */
  setPlayerVehicle(v) {
    if (this.playerVehicle) this.playerVehicle.isPlayer = false;
    this.playerVehicle = v;
    if (v) { v.isPlayer = true; v.ai = false; }
  }

  /** @returns {Vehicle|null} nearest vehicle to a point, within `maxDist`. */
  nearest(point, maxDist = 12) {
    let best = null, bd = maxDist * maxDist;
    for (const v of this.list) {
      const d = v.position.distanceToSquared(point);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  //  Loop
  // -------------------------------------------------------------------------

  fixedUpdate(fdt, ctx) {
    if (this.driveWithInput && this.playerVehicle) this._readInput(ctx, this.playerVehicle);
    for (let i = 0; i < this.list.length; i++) this.list[i].fixedUpdate(fdt);
  }

  _readInput(ctx, v) {
    const inp = ctx.input;
    if (!inp) return;
    const mv = inp.moveAxis();
    v.setInput({
      throttle: Math.max(inp.throttle(), mv.y < 0 ? -mv.y : 0),
      brake: Math.max(inp.brakeAxis(), mv.y > 0 ? mv.y : 0),
      steer: mv.x,
      handbrake: inp.down('handbrake') ? 1 : 0,
      gearUp: inp.down('gearUp'), gearDown: inp.down('gearDown'),
    });
    if (inp.justDown('lights')) v.headlightsOn = !v.headlightsOn;
  }

  update(dt, ctx) {
    const cam = ctx.camera;
    this._reap(cam);
    const n = this.list.length;
    if (!n) return;

    for (const p of this.pools.values()) p.begin();

    // LOD is re-evaluated for a slice of the fleet per frame; distances change slowly
    // enough that a few frames of latency is invisible and the sqrt cost is amortised.
    const slice = Math.max(1, Math.ceil(n / 4));
    for (let k = 0; k < slice; k++) {
      const v = this.list[(this._lodCursor + k) % n];
      if (v) this._evalLod(v, cam);
    }
    this._lodCursor = (this._lodCursor + slice) % n;

    for (let i = 0; i < n; i++) {
      const v = this.list[i];
      v.update(dt, ctx);
      if (v._lod === 2 && this._enableInstancing) this._pushShell(v);
    }

    for (const p of this.pools.values()) p.end();
  }

  /**
   * Reclaim cars the player abandoned and walked away from.
   *
   * Four conditions, all of which must hold, so that nothing the player could
   * notice is ever removed:
   *
   *   - it is not the car he is driving;
   *   - it is further than `REAP_RADIUS` away;
   *   - it is not materially moving, so a car still rolling downhill stays;
   *   - it is outside the view frustum, so a car parked at the end of a long
   *     straight is not deleted while it is on screen.
   *
   * Oldest abandonment first, and only as many as are over the cap, so a car
   * left somewhere deliberately survives for as long as the eight slots allow.
   */
  _reap(cam) {
    const mine = this.playerVehicle ? 1 : 0;
    const soft = this.list.length - ABANDONED_KEEP - mine;
    if (soft <= 0) return;

    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    // `radius` is the only thing that differs between the two passes, and the
    // invariants that protect the player's experience — his own car, a car
    // still moving, a car on screen — hold in both.
    const gather = (radius) => {
      const out = [];
      for (let i = 0; i < this.list.length; i++) {
        const v = this.list[i];
        if (!v || !v.alive || v === this.playerVehicle) continue;
        if (v.position.distanceTo(cam.position) < radius) continue;
        if (Math.abs(v.speed || 0) > REAP_SPEED) continue;
        _sphere.center.copy(v.position);
        if (_frustum.intersectsSphere(_sphere)) continue;
        out.push(v);
      }
      out.sort((a, b) => (a._abandonedAt || 0) - (b._abandonedAt || 0));
      return out;
    };

    let took = 0;
    for (const v of gather(REAP_RADIUS)) {
      if (took >= soft) break;
      this.despawn(v); took++;
    }
    if (this.list.length - mine <= ABANDONED_MAX) return;
    // Still over the ceiling, so the distance rule gives way. Everything else
    // does not: a car the player is driving, one still rolling, or one he can
    // see is never taken.
    for (const v of gather(REAP_NEAR)) {
      if (this.list.length - mine <= ABANDONED_MAX) break;
      this.despawn(v);
    }
  }

  _evalLod(v, cam) {
    const d = v.position.distanceTo(cam.position);
    v.distanceToCamera = d;
    const cur = v._lod ?? 0;
    // Hysteresis, or a car sitting on a boundary flickers between LODs every frame.
    let lod = cur;
    if (d < LOD0_DIST) lod = 0;
    else if (d < LOD1_DIST) lod = (cur === 0 && d < LOD0_DIST * HYST) ? 0 : 1;
    else lod = (cur === 1 && d < LOD1_DIST * HYST) ? 1 : 2;
    if (v.isPlayer) lod = 0;

    if (lod !== cur) {
      v._lod = lod;
      if (v.visual) {
        v.visual.setLod(Math.min(lod, 2));
        v.visual.setHidden(lod === 2 && this._enableInstancing);
      }
    }
    v.physicsLod = d > 90 && !v.isPlayer ? 1 : 0;
  }

  _pushShell(v) {
    let pool = this.pools.get(v.type);
    if (!pool) {
      pool = new ShellPool(v.type, this.kit, this.scene);
      this.pools.set(v.type, pool);
      pool.begin();
    }
    _m.compose(v.position, v.quaternion, _s);
    if (!pool.push(_m, v.color) && v.visual) {
      // Pool full — fall back to this car's own shell meshes rather than dropping it.
      v.visual.setHidden(false);
    }
  }

  dispose() {
    this.ctx?.bus.off?.('player:enterVehicle', this._onEnter);
    this.ctx?.bus.off?.('player:exitVehicle', this._onExit);
    for (const v of this.list.slice()) v.dispose();
    this.list.length = 0;
    for (const p of this.pools.values()) p.dispose();
    this.pools.clear();
    this.group?.parent?.remove(this.group);
    this.kit?.dispose();
    disposeSharedGeometry();
  }
}

function pickColor(spec) {
  const c = spec.def.colors;
  const hex = parseInt(c[(Math.random() * c.length) | 0].slice(1), 16);
  if (c.length === 1) return hex;           // liveried types keep their exact colour
  // A touch of per-car variation in sRGB, so a row of parked cars isn't obviously cloned.
  const j = 0.93 + Math.random() * 0.14;
  const ch = (sh) => {
    const v = Math.round(((hex >> sh) & 255) * j);
    return (v < 0 ? 0 : v > 255 ? 255 : v) << sh;
  };
  return ch(16) | ch(8) | ch(0);
}
