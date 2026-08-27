import * as THREE from 'three';

/** Free-fly debug camera. The gameplay agent replaces this with the chase/on-foot rig. */
export default class CameraRig {
  static id = 'cameraRig';
  static label = 'Camera';
  static deps = ['render'];

  async init(ctx) {
    this.enabled = true;
    this.yaw = 0; this.pitch = -0.18;
    this.pos = new THREE.Vector3(120, 55, 220);
    this.vel = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
  }

  update(dt, ctx) {
    if (!this.enabled) return;   // capture harness parks the camera
    const inp = ctx.input; if (!inp) return;
    const look = inp.lookAxis(dt);
    if (inp.mouse.locked || inp.gpAxes[2] || inp.gpAxes[3]) {
      this.yaw -= look.x; this.pitch -= look.y;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
    }
    this._e.set(this.pitch, this.yaw, 0);
    this._q.setFromEuler(this._e);

    const mv = inp.moveAxis();
    const speed = (inp.down('sprint') ? 160 : 42) * dt;
    this._f.set(0, 0, -1).applyQuaternion(this._q);
    this._r.set(1, 0, 0).applyQuaternion(this._q);
    this.vel.addScaledVector(this._f, -mv.y * speed);
    this.vel.addScaledVector(this._r, mv.x * speed);
    if (inp.down('jump')) this.vel.y += speed;
    if (inp.down('crouch')) this.vel.y -= speed;
    this.vel.multiplyScalar(Math.pow(0.0015, dt));   // frame-rate independent damping
    this.pos.addScaledVector(this.vel, dt * 8);
    this.pos.y = Math.max(this.pos.y, 1.6);

    ctx.camera.position.copy(this.pos);
    ctx.camera.quaternion.copy(this._q);
    if (ctx.camera.fov !== ctx.settings.fov) {
      ctx.camera.fov = ctx.settings.fov; ctx.camera.updateProjectionMatrix();
    }
  }
  dispose() {}
}
