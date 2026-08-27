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
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 4));
    this.debugMesh = new THREE.LineSegments(g,
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

  update(dt, ctx) {
    if (!this.debugEnabled) { this.debugMesh.visible = false; return; }
    this.debugMesh.visible = true;
    const { vertices, colors } = this.world.debugRender();
    this.debugMesh.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.debugMesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }

  dispose() {
    this.debugMesh?.geometry.dispose();
    this.debugMesh?.material.dispose();
    this.world?.free();
  }
}
