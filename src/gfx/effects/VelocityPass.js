import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Screen-space velocity buffer, in uv units per frame.
 *
 * Two sources, in this order:
 *
 *  1. **Camera reprojection.** Every pixel is unprojected with this frame's inverse
 *     view-projection and re-projected through the previous frame's — exact for
 *     everything that did not move, which in a driving game is the entire world
 *     streaming past the windows.
 *
 *  2. **Tracked dynamic objects.** Vehicles and anything else registered through
 *     `track()` are drawn again into the same buffer through a proxy scene that shares
 *     their geometry (no duplicate GPU memory), using their own previous world matrix.
 *     The proxy fragments test themselves against the scene depth texture and discard
 *     when occluded, so a car behind a wall does not smear through it.
 *
 * If nothing is tracked the second stage costs literally nothing, so this degrades to
 * a correct camera-only velocity buffer until the vehicle system lands.
 */
export default class VelocityPass extends Pass {
  /**
   * @param {THREE.Camera} camera
   * @param {import('./FrameStatePass.js').default} frameState
   */
  constructor(camera, frameState) {
    super('VelocityPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.camera = camera;
    this.frameState = frameState;

    this.velocityRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.velocityRT.texture.name = 'Velocity';

    this.cameraMat = new THREE.ShaderMaterial({
      name: 'Velocity.Camera',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        depthBuffer: { value: null },
        invViewProj: { value: new THREE.Matrix4() },
        prevViewProj: { value: new THREE.Matrix4() },
        cameraNearFar: { value: new THREE.Vector2(0.25, 12000) },
      },
      vertexShader: VERT,
      fragmentShader: CAMERA_FRAG,
    });

    this.objectMat = new THREE.ShaderMaterial({
      name: 'Velocity.Object',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      side: THREE.FrontSide,
      uniforms: {
        depthBuffer: { value: null },
        prevModelMatrix: { value: new THREE.Matrix4() },
        prevViewProj: { value: new THREE.Matrix4() },
        resolution: { value: new THREE.Vector2(1, 1) },
        cameraNearFar: { value: new THREE.Vector2(0.25, 12000) },
      },
      vertexShader: OBJECT_VERT,
      fragmentShader: OBJECT_FRAG,
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.cameraMat);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._orthoCam = new THREE.OrthographicCamera();

    /** Proxy scene: shares geometry with the real meshes, never owns any. */
    this._proxyScene = new THREE.Scene();
    this._proxyScene.matrixAutoUpdate = false;
    this._tracked = new Map();   // source Object3D -> { proxy, prevMatrix }
  }

  get texture() { return this.velocityRT.texture; }

  /**
   * Start writing per-object velocity for a mesh. Safe to call for InstancedMesh —
   * the proxy shares the instance matrix attribute.
   *
   * @param {THREE.Mesh} mesh
   */
  track(mesh) {
    if (!mesh?.geometry || this._tracked.has(mesh)) return;
    // One material clone per proxy so prevModelMatrix is per-object and the whole
    // proxy scene can be drawn in a single renderer.render() call. Clones share the
    // shader program, so this costs no extra compiles.
    const mat = this.objectMat.clone();
    mat.uniforms.depthBuffer.value = this.objectMat.uniforms.depthBuffer.value;
    mat.uniforms.resolution.value = this.objectMat.uniforms.resolution.value;
    const proxy = mesh.isInstancedMesh
      ? new THREE.InstancedMesh(mesh.geometry, mat, mesh.count)
      : new THREE.Mesh(mesh.geometry, mat);
    if (mesh.isInstancedMesh) proxy.instanceMatrix = mesh.instanceMatrix;
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    this._proxyScene.add(proxy);
    this._tracked.set(mesh, { proxy, mat, prevMatrix: mesh.matrixWorld.clone() });
  }

  untrack(mesh) {
    const e = this._tracked.get(mesh);
    if (!e) return;
    this._proxyScene.remove(e.proxy);
    e.mat.dispose();
    this._tracked.delete(mesh);
  }

  setSize(width, height) {
    this.velocityRT.setSize(width, height);
    this.objectMat.uniforms.resolution.value.set(width, height);
    for (const e of this._tracked.values()) {
      e.mat.uniforms.resolution.value.set(width, height);
    }
  }

  setDepthTexture(depthTexture) {
    this.cameraMat.uniforms.depthBuffer.value = depthTexture;
    this.objectMat.uniforms.depthBuffer.value = depthTexture;
    for (const e of this._tracked.values()) e.mat.uniforms.depthBuffer.value = depthTexture;
  }
  getDepthTexture() { return this.cameraMat.uniforms.depthBuffer.value; }

  render(renderer) {
    const fs = this.frameState;
    const cu = this.cameraMat.uniforms;
    cu.invViewProj.value.copy(fs.invViewProj);
    cu.prevViewProj.value.copy(fs.prevViewProj);
    cu.cameraNearFar.value.set(this.camera.near, this.camera.far);

    this._quad.material = this.cameraMat;
    renderer.setRenderTarget(this.velocityRT);
    renderer.render(this.scene, this._orthoCam);

    if (this._tracked.size === 0) return;

    // Per-object pass. The proxies keep their own previous matrix, so a car moving
    // relative to the world gets a velocity that is not just the camera's.
    let stale = null;
    for (const [mesh, e] of this._tracked) {
      if (!mesh.parent) { (stale ??= []).push(mesh); continue; }
      e.proxy.visible = mesh.visible;
      if (!mesh.visible) continue;
      e.proxy.matrix.copy(mesh.matrixWorld);
      e.proxy.matrixWorld.copy(mesh.matrixWorld);
      if (mesh.isInstancedMesh) e.proxy.count = mesh.count;
      e.mat.uniforms.prevModelMatrix.value.copy(e.prevMatrix);
      e.mat.uniforms.prevViewProj.value.copy(fs.prevViewProj);
      e.mat.uniforms.cameraNearFar.value.set(this.camera.near, this.camera.far);
      e.prevMatrix.copy(mesh.matrixWorld);
    }
    if (stale) for (const m of stale) this.untrack(m);

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;               // keep the camera velocity underneath
    renderer.render(this._proxyScene, this.camera);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.velocityRT.dispose();
    this.cameraMat.dispose();
    this.objectMat.dispose();
    for (const e of this._tracked.values()) e.mat.dispose();
    this._proxyScene.clear();
    this._tracked.clear();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

const LINEARIZE = /* glsl */`
uniform vec2 cameraNearFar;
/** Non-linear depth -> distance along the view axis, in metres. */
float viewDistance(const in float d) {
  float z = 2.0 * d - 1.0;
  return (2.0 * cameraNearFar.x * cameraNearFar.y)
       / (cameraNearFar.y + cameraNearFar.x - z * (cameraNearFar.y - cameraNearFar.x));
}`;

const CAMERA_FRAG = /* glsl */`
uniform highp sampler2D depthBuffer;
uniform mat4 invViewProj;
uniform mat4 prevViewProj;
varying vec2 vUv;
${LINEARIZE}

void main() {
  float d = texture2D(depthBuffer, vUv).r;
  // Skybox depth: reproject at the far plane so the sky still streaks when the
  // camera rotates, which it must, or TAA locks the sky to the screen.
  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 world = invViewProj * ndc;
  world.xyz /= (abs(world.w) < 1e-8) ? 1e-8 : world.w;

  vec4 prevClip = prevViewProj * vec4(world.xyz, 1.0);
  float pw = (abs(prevClip.w) < 1e-8) ? 1e-8 : prevClip.w;
  vec2 prevUv = (prevClip.xy / pw) * 0.5 + 0.5;

  vec2 v = vUv - prevUv;
  // A huge value means the reprojection blew up (behind the camera); clamp so the
  // consumers just fall back to rejecting the history rather than reading garbage.
  v = clamp(v, vec2(-2.0), vec2(2.0));
  // .z carries linear view distance in metres: TAA's closest-depth dilation and
  // motion blur's occlusion test both need a comparison the depth buffer's
  // non-linearity does not warp.
  gl_FragColor = vec4(v, viewDistance(d), 1.0);
}`;

const OBJECT_VERT = /* glsl */`
uniform mat4 prevModelMatrix;
uniform mat4 prevViewProj;
varying vec4 vCurrent;
varying vec4 vPrevious;

void main() {
  vec4 local = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
  #endif
  vec4 world = modelMatrix * local;
  vec4 prevWorld = prevModelMatrix * local;
  vCurrent = projectionMatrix * viewMatrix * world;
  vPrevious = prevViewProj * prevWorld;
  gl_Position = vCurrent;
}`;

const OBJECT_FRAG = /* glsl */`
uniform highp sampler2D depthBuffer;
uniform vec2 resolution;
varying vec4 vCurrent;
varying vec4 vPrevious;
${LINEARIZE}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  // The proxy scene has no depth buffer of its own; reject fragments the real scene
  // already covered with something closer.
  float sceneDepth = texture2D(depthBuffer, uv).r;
  float myDepth = gl_FragCoord.z;
  if (myDepth > sceneDepth + 2.0e-5) discard;

  float cw = (abs(vCurrent.w) < 1e-8) ? 1e-8 : vCurrent.w;
  float pw = (abs(vPrevious.w) < 1e-8) ? 1e-8 : vPrevious.w;
  vec2 v = (vCurrent.xy / cw - vPrevious.xy / pw) * 0.5;
  gl_FragColor = vec4(clamp(v, vec2(-2.0), vec2(2.0)), viewDistance(sceneDepth), 1.0);
}`;
