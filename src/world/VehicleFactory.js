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

const LOD0_DIST = 32;
const LOD1_DIST = 115;
const HYST = 1.12;

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

    this._onEnter = (v) => { if (v) this.setPlayerVehicle(v); };
    this._onExit = () => { this.setPlayerVehicle(null); };
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
