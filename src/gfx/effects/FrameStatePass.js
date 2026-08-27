import * as THREE from 'three';
import { Pass } from 'postprocessing';

/** Halton low-discrepancy sequence — the standard TAA sample distribution. */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/**
 * Runs first in the composer, before anything is drawn. It owns two things every
 * temporal stage needs and nobody else can provide:
 *
 *  1. **Sub-pixel jitter.** The camera projection is offset by a Halton(2,3) sample
 *     each frame so TAA has something new to integrate. Doing it here rather than in
 *     a system's update() makes it immune to the order other systems touch the camera
 *     in — CameraRig calls updateProjectionMatrix() whenever the FOV changes, which
 *     would silently wipe a jitter applied any earlier.
 *
 *  2. **Matrix history.** The unjittered view-projection of this frame and the last,
 *     which is what velocity reconstruction reprojects through. Velocity is computed
 *     unjittered on purpose: folding the jitter into velocity would feed the TAA its
 *     own dither back as motion.
 */
export default class FrameStatePass extends Pass {
  constructor(camera) {
    super('FrameStatePass');
    this.needsSwap = false;
    this.camera = camera;

    this.viewProj = new THREE.Matrix4();
    this.prevViewProj = new THREE.Matrix4();
    this.invViewProj = new THREE.Matrix4();
    this.baseProjection = new THREE.Matrix4();
    /** Jitter for this frame, in pixels. */
    this.jitter = new THREE.Vector2();
    this.prevJitter = new THREE.Vector2();

    this.enabledJitter = false;
    this.sampleCount = 8;
    this._index = 0;
    this._w = 1; this._h = 1;
    this._first = true;

    // Precompute the sequence; nothing allocates per frame.
    this._seq = [];
    for (let i = 1; i <= 32; i++) {
      this._seq.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    }
  }

  setSize(width, height) { this._w = width; this._h = height; }

  /** Restore the camera to an unjittered projection (menus, screenshots, teardown). */
  clearJitter() {
    this.jitter.set(0, 0);
    this.camera.updateProjectionMatrix();
  }

  render() {
    const cam = this.camera;

    // Recompute a clean projection: last frame's jitter must not accumulate.
    cam.updateProjectionMatrix();
    this.baseProjection.copy(cam.projectionMatrix);
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    this.prevViewProj.copy(this.viewProj);
    this.viewProj.multiplyMatrices(this.baseProjection, cam.matrixWorldInverse);
    this.invViewProj.copy(this.viewProj).invert();
    if (this._first) { this.prevViewProj.copy(this.viewProj); this._first = false; }

    this.prevJitter.copy(this.jitter);
    if (this.enabledJitter) {
      const s = this._seq[this._index % this.sampleCount];
      this._index++;
      this.jitter.set(s[0], s[1]);
      const e = cam.projectionMatrix.elements;
      e[8] += (this.jitter.x * 2) / this._w;
      e[9] += (this.jitter.y * 2) / this._h;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } else {
      this.jitter.set(0, 0);
    }
  }

  dispose() {}
}
