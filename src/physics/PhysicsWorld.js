import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

/** Collision groups (16-bit membership | 16-bit filter). */
export const GROUP = {
  STATIC:   0x0001, VEHICLE: 0x0002, CHARACTER: 0x0004,
  PROP:     0x0008, WHEEL:   0x0010, TRIGGER:   0x0020,
  PROJECTILE: 0x0040, WATER:  0x0080,
};
export function groups(member, collidesWith) { return (member << 16) | collidesWith; }

export default class PhysicsWorld {
  static id = 'physics';
  static label = 'Physics';
  static deps = [];

  async init(ctx) {
    await RAPIER.init();
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    // Tighter solver = less jitter on stacked props and stable vehicles.
    this.world.numSolverIterations = 8;
    this.world.numAdditionalFrictionIterations = 4;
    this.world.numInternalPgsIterations = 1;

    this.eventQueue = new RAPIER.EventQueue(true);
    this.bodies = new Map();      // handle -> { body, mesh, onContact }
    this._syncList = [];
    this.debugEnabled = false;
    this.bus = ctx.bus;

    // Debug wireframe renderer (toggle with the dev overlay)
    this.debugMesh = new THREE.LineSegments(this._debugGeometry(0),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false }));
    this.debugMesh.frustumCulled = false;
    this.debugMesh.visible = false;
    this.debugMesh.renderOrder = 9999;
    ctx.scene.add(this.debugMesh);
  }

  /** Static trimesh collider from a THREE mesh (world-space baked). */
  addTrimesh(mesh, groupBits = groups(GROUP.STATIC, 0xFFFF)) {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const pos = geo.attributes.position.array;
    const idx = geo.index ? new Uint32Array(geo.index.array)
                          : new Uint32Array([...Array(pos.length / 3).keys()]);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(pos), idx)
      .setCollisionGroups(groupBits).setFriction(1.0).setRestitution(0.0);
    this.world.createCollider(desc, body);
    geo.dispose();
    return body;
  }

  addBox(halfExtents, position, quaternion, { mass = 0, friction = 0.85,
      restitution = 0.1, group = groups(GROUP.PROP, 0xFFFF), mesh = null, ccd = false } = {}) {
    const desc = mass > 0 ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(position.x, position.y, position.z);
    if (quaternion) desc.setRotation(quaternion);
    if (ccd) desc.setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setCollisionGroups(group).setFriction(friction).setRestitution(restitution);
    if (mass > 0) cd.setMass(mass);
    this.world.createCollider(cd, body);
    if (mesh) this.bind(body, mesh);
    return body;
  }

  /** Keep a THREE object's transform synced from a rigid body each step. */
  bind(body, mesh) {
    this._syncList.push({ body, mesh });
    this.bodies.set(body.handle, { body, mesh });
  }
  unbind(body) {
    const i = this._syncList.findIndex(s => s.body === body);
    if (i >= 0) this._syncList.splice(i, 1);
    this.bodies.delete(body.handle);
  }
  remove(body) { this.unbind(body); this.world.removeRigidBody(body); }

  /** Raycast. Returns {point, normal, distance, collider} or null. */
  raycast(origin, dir, maxDist = 100, filterGroups = undefined, exclude = null) {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(
      ray, maxDist, true, undefined, filterGroups, undefined, exclude || undefined);
    if (!hit) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    return {
      point: new THREE.Vector3(p.x, p.y, p.z),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      collider: hit.collider,
    };
  }

  fixedUpdate(fdt, ctx) {
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      this.bus.emit('physics:contact', { h1, h2, started });
    });
    for (const { body, mesh } of this._syncList) {
      const t = body.translation(), r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Debug-draw geometry sized for `cap` vertices. The attributes are long-lived and
   * rewritten in place; `update()` explains why they are never swapped on a live one.
   */
  _debugGeometry(cap) {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    g.setDrawRange(0, 0);
    return g;
  }

  update(dt, ctx) {
    if (!this.debugEnabled) { this.debugMesh.visible = false; return; }
    this.debugMesh.visible = true;
    const { vertices, colors } = this.world.debugRender();
    const n = vertices.length / 3;
    let g = this.debugMesh.geometry;
    const pos = g.attributes.position, col = g.attributes.color;
    if (vertices.length > pos.array.length || colors.length > col.array.length) {
      // Growth is the only case that needs new attributes, and it must retire the
      // whole geometry to get them. `setAttribute` in three r171 is just
      // `this.attributes[name] = attribute` -- it never looks at what it displaced,
      // and the ONLY paths that reach `WebGLAttributes.remove` (and so
      // `gl.deleteBuffer`) are WebGLGeometries.onGeometryDispose, which walks the
      // attributes still attached at that moment, the wireframe-index special case,
      // and InstancedMesh teardown. A BufferAttribute has no dispose() of its own.
      // So replacing these two every frame -- which is what this method used to do
      // -- orphaned two GL buffers per frame for as long as F2 was held, invisibly:
      // renderer.info counts geometries and textures, not buffers. Disposing the old
      // geometry WHILE its attributes are still on it is the public boundary that
      // actually frees them.
      //
      // Doubling bounds capacity by the largest frame ever seen rather than by how
      // long the overlay has been open, and capacity never shrinks, so a smaller
      // frame reallocates nothing.
      const cap = Math.ceil(Math.max(n, colors.length / 4, (pos.array.length / 3) * 2));
      this.debugMesh.geometry = this._debugGeometry(cap);
      g.dispose();
      g = this.debugMesh.geometry;
    }
    g.attributes.position.array.set(vertices);
    g.attributes.color.array.set(colors);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    // Without this the tail of a larger previous frame would keep drawing.
    g.setDrawRange(0, n);
  }

  dispose() {
    this.debugMesh?.parent?.remove(this.debugMesh);
    this.debugMesh?.geometry.dispose();
    this.debugMesh?.material.dispose();
    this.world?.free();
  }
}
