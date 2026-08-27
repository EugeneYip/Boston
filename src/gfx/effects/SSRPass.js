import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Screen-space reflections at half resolution with temporal accumulation.
 *
 * Design notes, because the shortcuts matter more than the ray march:
 *
 *  - **No G-buffer.** The city runs close to its draw-call budget already, so a normal
 *    prepass would cost more than the effect is worth. Normals are reconstructed from
 *    depth with the standard "closest neighbour" derivative trick, which is exact on
 *    the flat surfaces that actually carry reflections — roads, pavements, facades —
 *    and only degrades on foliage, which is not reflective anyway.
 *
 *  - **Fresnel is the material model.** Every dielectric reflects ~4% head-on and
 *    approaches 100% at grazing incidence, so a Schlick term alone already produces
 *    physically right behaviour on brick and stone. Wetness then drives up-facing
 *    surfaces toward a mirror, which is where the rain payoff comes from.
 *
 *  - **Graceful failure.** Where a ray leaves the screen, runs out of steps or hits a
 *    surface at the wrong thickness, confidence fades to zero and the material's own
 *    IBL reflection (from the sky probe) is simply left alone. SSR only ever adds
 *    detail on top of the environment probe; it never replaces it.
 *
 *  - **Roughness-aware blur.** The trace result is mip-chained and sampled by
 *    roughness, so a puddle is mirror-sharp and damp asphalt is not.
 */
export default class SSRPass extends Pass {
  constructor(camera, frameState, velocityPass) {
    super('SSRPass');
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.camera = camera;
    this.frameState = frameState;
    this.velocityPass = velocityPass;

    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.traceRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.accumRT = [new THREE.WebGLRenderTarget(1, 1, opts),
                    new THREE.WebGLRenderTarget(1, 1, opts)];
    this.mipRT = [new THREE.WebGLRenderTarget(1, 1, opts),
                  new THREE.WebGLRenderTarget(1, 1, opts),
                  new THREE.WebGLRenderTarget(1, 1, opts)];
    this._ping = 0;
    this._valid = false;
    this._frame = 0;

    const base = { depthTest: false, depthWrite: false, blending: THREE.NoBlending,
                   vertexShader: VERT };

    this.traceMat = new THREE.ShaderMaterial({
      ...base, name: 'SSR.Trace', fragmentShader: TRACE_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        depthBuffer: { value: null },
        projection: { value: new THREE.Matrix4() },
        invProjection: { value: new THREE.Matrix4() },
        viewUp: { value: new THREE.Vector3(0, 1, 0) },
        texelSize: { value: new THREE.Vector2() },
        fullTexelSize: { value: new THREE.Vector2() },
        cameraNearFar: { value: new THREE.Vector2(0.25, 12000) },
        // x: max distance (m), y: thickness (m), z: steps, w: refine steps
        rayParams: { value: new THREE.Vector4(140, 1.4, 24, 5) },
        // x: wetness, y: base gloss, z: intensity, w: frame index
        surfaceParams: { value: new THREE.Vector4(0, 0.10, 1.0, 0) },
      },
    });

    this.accumMat = new THREE.ShaderMaterial({
      ...base, name: 'SSR.Accumulate', fragmentShader: ACCUM_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        historyBuffer: { value: null },
        velocityBuffer: { value: null },
        texelSize: { value: new THREE.Vector2() },
        params: { value: new THREE.Vector2(0.90, 0) },   // feedback, valid
      },
    });

    this.downMat = new THREE.ShaderMaterial({
      ...base, name: 'SSR.Down', fragmentShader: DOWN_FRAG,
      uniforms: { inputBuffer: { value: null }, texelSize: { value: new THREE.Vector2() } },
    });

    this.compositeMat = new THREE.ShaderMaterial({
      ...base, name: 'SSR.Composite', fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        inputBuffer: { value: null },
        depthBuffer: { value: null },
        ssr0: { value: null }, ssr1: { value: null },
        ssr2: { value: null }, ssr3: { value: null },
        invProjection: { value: new THREE.Matrix4() },
        viewUp: { value: new THREE.Vector3(0, 1, 0) },
        texelSize: { value: new THREE.Vector2() },
        surfaceParams: { value: new THREE.Vector4(0, 0.10, 1.0, 0) },
      },
    });

    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this.traceMat);
    this._quad.frustumCulled = false;
    this.scene.add(this._quad);
    this._orthoCam = new THREE.OrthographicCamera();

    /** Public knobs. */
    this.intensity = 1.0;
    this.wetness = 0.0;
    this.baseGloss = 0.10;      // dry dielectric reflectivity floor
    this.maxDistance = 140;
    this.thickness = 1.4;
    this.steps = 24;
    this.refineSteps = 5;
    this.feedback = 0.90;
  }

  reset() { this._valid = false; }

  setSize(width, height) {
    const hw = Math.max(1, Math.round(width * 0.5));
    const hh = Math.max(1, Math.round(height * 0.5));
    this.traceRT.setSize(hw, hh);
    this.accumRT[0].setSize(hw, hh);
    this.accumRT[1].setSize(hw, hh);
    let w = hw, h = hh;
    for (const rt of this.mipRT) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); rt.setSize(w, h); }
    this.traceMat.uniforms.texelSize.value.set(1 / hw, 1 / hh);
    this.traceMat.uniforms.fullTexelSize.value.set(1 / width, 1 / height);
    this.accumMat.uniforms.texelSize.value.set(1 / hw, 1 / hh);
    this.compositeMat.uniforms.texelSize.value.set(1 / width, 1 / height);
    this._valid = false;
  }

  setDepthTexture(depthTexture) {
    this.traceMat.uniforms.depthBuffer.value = depthTexture;
    this.compositeMat.uniforms.depthBuffer.value = depthTexture;
  }
  getDepthTexture() { return this.traceMat.uniforms.depthBuffer.value; }

  _draw(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this._orthoCam);
  }

  render(renderer, inputBuffer, outputBuffer) {
    const cam = this.camera;
    const tu = this.traceMat.uniforms;
    tu.inputBuffer.value = inputBuffer.texture;
    tu.projection.value.copy(this.frameState.baseProjection);
    tu.invProjection.value.copy(this.frameState.baseProjection).invert();
    tu.viewUp.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    tu.cameraNearFar.value.set(cam.near, cam.far);
    tu.rayParams.value.set(this.maxDistance, this.thickness, this.steps, this.refineSteps);
    tu.surfaceParams.value.set(this.wetness, this.baseGloss, this.intensity, this._frame % 16);
    this._draw(renderer, this.traceMat, this.traceRT);

    // --- temporal accumulation (half-res traces need it to look clean) ---
    const au = this.accumMat.uniforms;
    au.inputBuffer.value = this.traceRT.texture;
    au.historyBuffer.value = this.accumRT[this._ping].texture;
    au.velocityBuffer.value = this.velocityPass?.texture ?? null;
    au.params.value.set(this.velocityPass ? this.feedback : 0.0, this._valid ? 1 : 0);
    const accum = this.accumRT[this._ping ^ 1];
    this._draw(renderer, this.accumMat, accum);
    this._ping ^= 1;
    this._valid = true;

    // --- roughness mip chain ---
    let src = accum;
    for (const rt of this.mipRT) {
      this.downMat.uniforms.inputBuffer.value = src.texture;
      this.downMat.uniforms.texelSize.value.set(1 / src.width, 1 / src.height);
      this._draw(renderer, this.downMat, rt);
      src = rt;
    }

    // --- composite ---
    const cu = this.compositeMat.uniforms;
    cu.inputBuffer.value = inputBuffer.texture;
    cu.ssr0.value = accum.texture;
    cu.ssr1.value = this.mipRT[0].texture;
    cu.ssr2.value = this.mipRT[1].texture;
    cu.ssr3.value = this.mipRT[2].texture;
    cu.invProjection.value.copy(tu.invProjection.value);
    cu.viewUp.value.copy(tu.viewUp.value);
    cu.surfaceParams.value.copy(tu.surfaceParams.value);
    this._draw(renderer, this.compositeMat, this.renderToScreen ? null : outputBuffer);

    this._frame++;
  }

  dispose() {
    this.traceRT.dispose();
    this.accumRT[0].dispose(); this.accumRT[1].dispose();
    for (const rt of this.mipRT) rt.dispose();
    this.traceMat.dispose(); this.accumMat.dispose();
    this.downMat.dispose(); this.compositeMat.dispose();
  }
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

/** Shared surface reconstruction. Included by both the trace and the composite. */
const SURFACE = /* glsl */`
uniform highp sampler2D depthBuffer;
uniform mat4 invProjection;
uniform vec3 viewUp;

vec3 viewPos(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProjection * clip;
  return v.xyz / ((abs(v.w) < 1e-8) ? 1e-8 : v.w);
}
vec3 viewPosAt(vec2 uv) { return viewPos(uv, texture2D(depthBuffer, uv).r); }

/**
 * Normal from depth. Picking the closer of the two neighbours on each axis keeps
 * silhouettes from producing a normal that faces halfway into the background.
 */
vec3 reconstructNormal(vec2 uv, vec3 p, vec2 texel) {
  vec3 pr = viewPosAt(uv + vec2(texel.x, 0.0));
  vec3 pl = viewPosAt(uv - vec2(texel.x, 0.0));
  vec3 pu = viewPosAt(uv + vec2(0.0, texel.y));
  vec3 pd = viewPosAt(uv - vec2(0.0, texel.y));
  vec3 dx = (abs(pr.z - p.z) < abs(p.z - pl.z)) ? (pr - p) : (p - pl);
  vec3 dy = (abs(pu.z - p.z) < abs(p.z - pd.z)) ? (pu - p) : (p - pd);
  vec3 n = normalize(cross(dx, dy));
  return (dot(n, p) > 0.0) ? -n : n;   // always face the camera
}

/** Wet, up-facing surfaces go glossy; everything else keeps a dielectric floor. */
float glossFor(vec3 n, float wetness, float baseGloss) {
  float up = clamp(dot(n, viewUp), 0.0, 1.0);
  float puddle = smoothstep(0.55, 0.9, up) * wetness;
  return clamp(mix(baseGloss, 1.0, puddle), 0.0, 1.0);
}
float roughFor(vec3 n, float wetness, float baseGloss) {
  float up = clamp(dot(n, viewUp), 0.0, 1.0);
  float puddle = smoothstep(0.55, 0.9, up) * wetness;
  return clamp(mix(0.42, 0.05, puddle), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

const TRACE_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform mat4 projection;
uniform vec2 texelSize;
uniform vec2 fullTexelSize;
uniform vec2 cameraNearFar;
uniform vec4 rayParams;
uniform vec4 surfaceParams;
varying vec2 vUv;
${SURFACE}

void main() {
  float d = texture2D(depthBuffer, vUv).r;
  if (d >= 0.9999) { gl_FragColor = vec4(0.0); return; }   // sky reflects nothing

  vec3 p = viewPos(vUv, d);
  vec3 n = reconstructNormal(vUv, p, fullTexelSize);
  float gloss = glossFor(n, surfaceParams.x, surfaceParams.y);
  if (gloss < 0.02) { gl_FragColor = vec4(0.0); return; }

  vec3 v = normalize(p);
  float rough = roughFor(n, surfaceParams.x, surfaceParams.y);

  // Roughness-proportional ray jitter: a rough surface scatters, so scatter the ray
  // and let the temporal pass average it back into a soft reflection.
  float h1 = hash12(vUv * 977.0 + surfaceParams.w * 13.7);
  float h2 = hash12(vUv * 311.0 - surfaceParams.w * 7.3);
  vec3 t = normalize(abs(n.z) < 0.9 ? cross(n, vec3(0.0, 0.0, 1.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  float spread = rough * rough * 0.35;
  vec3 jn = normalize(n + (t * (h1 - 0.5) + b * (h2 - 0.5)) * spread * 2.0);

  vec3 dir = reflect(v, jn);
  if (dot(dir, n) < 0.02) { gl_FragColor = vec4(0.0); return; }

  vec3 start = p + n * (0.02 + abs(p.z) * 0.0025);
  vec3 end = start + dir * rayParams.x;
  // Clip the ray to the near plane or the projection folds it behind the camera.
  if (end.z > -cameraNearFar.x) {
    float tClip = (-cameraNearFar.x - start.z) / max(dir.z, 1e-6);
    end = start + dir * max(tClip, 0.0);
  }

  vec4 c0 = projection * vec4(start, 1.0);
  vec4 c1 = projection * vec4(end, 1.0);
  vec2 uv0 = (c0.xy / c0.w) * 0.5 + 0.5;
  vec2 uv1 = (c1.xy / c1.w) * 0.5 + 0.5;
  float invZ0 = 1.0 / start.z;
  float invZ1 = 1.0 / end.z;

  int steps = int(rayParams.z);
  float stepJitter = hash12(vUv * 613.0 + surfaceParams.w * 3.1);

  float tPrev = 0.0, zPrev = start.z;
  float tHit = -1.0;
  const int MAX_STEPS = 40;
  for (int i = 1; i <= MAX_STEPS; i++) {
    if (i > steps) break;
    float t = (float(i) - 1.0 + stepJitter) / float(steps);
    vec2 uv = mix(uv0, uv1, t);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float rayZ = 1.0 / mix(invZ0, invZ1, t);
    float sceneZ = viewPosAt(uv).z;
    float diff = sceneZ - rayZ;             // > 0 => ray passed behind the surface
    if (diff > 0.0 && diff < rayParams.y + abs(rayZ) * 0.02) { tHit = t; break; }
    if (diff > 0.0) break;                  // passed behind something too thick: miss
    tPrev = t; zPrev = rayZ;
  }

  if (tHit < 0.0) { gl_FragColor = vec4(0.0); return; }

  // Binary refinement between the last miss and the hit.
  float lo = tPrev, hi = tHit;
  int refine = int(rayParams.w);
  for (int i = 0; i < 8; i++) {
    if (i >= refine) break;
    float mid = 0.5 * (lo + hi);
    vec2 uv = mix(uv0, uv1, mid);
    float rayZ = 1.0 / mix(invZ0, invZ1, mid);
    float sceneZ = viewPosAt(uv).z;
    if (sceneZ - rayZ > 0.0) hi = mid; else lo = mid;
  }
  vec2 hitUv = mix(uv0, uv1, hi);

  // --- confidence -------------------------------------------------------------
  // Screen edges: nothing outside the frame was ever rendered, so fade out.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), hitUv)
            * (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitUv));
  float conf = edge.x * edge.y;
  // Rays pointing back at the camera are the ones that betray SSR the fastest.
  conf *= 1.0 - smoothstep(0.25, 0.7, -dot(dir, v));
  // Distance falloff: a long ray has accumulated the most stepping error.
  conf *= 1.0 - smoothstep(0.55, 1.0, hi);

  vec3 hitColor = texture2D(inputBuffer, hitUv).rgb;
  gl_FragColor = vec4(hitColor, clamp(conf, 0.0, 1.0));
}`;

const ACCUM_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D historyBuffer;
uniform sampler2D velocityBuffer;
uniform vec2 texelSize;
uniform vec2 params;
varying vec2 vUv;

void main() {
  vec4 cur = texture2D(inputBuffer, vUv);
  if (params.y < 0.5 || params.x <= 0.0) { gl_FragColor = cur; return; }

  vec2 vel = texture2D(velocityBuffer, vUv).xy;
  vec2 prevUv = vUv - vel;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    gl_FragColor = cur; return;
  }

  // Clamp the history to the local neighbourhood so a reflection that just became
  // occluded cannot smear across the road behind the car.
  vec4 lo = cur, hi = cur;
  for (int i = 0; i < 4; i++) {
    vec2 o = (i == 0) ? vec2(-1.0, 0.0) : (i == 1) ? vec2(1.0, 0.0)
           : (i == 2) ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
    vec4 s = texture2D(inputBuffer, vUv + o * texelSize);
    lo = min(lo, s); hi = max(hi, s);
  }
  vec4 hist = clamp(texture2D(historyBuffer, prevUv), lo, hi);
  gl_FragColor = mix(cur, hist, params.x);
}`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 texelSize;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(inputBuffer, vUv + texelSize * vec2(-1.0, -1.0));
  c += texture2D(inputBuffer, vUv + texelSize * vec2(1.0, -1.0));
  c += texture2D(inputBuffer, vUv + texelSize * vec2(-1.0, 1.0));
  c += texture2D(inputBuffer, vUv + texelSize * vec2(1.0, 1.0));
  gl_FragColor = c * 0.25;
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform sampler2D ssr0;
uniform sampler2D ssr1;
uniform sampler2D ssr2;
uniform sampler2D ssr3;
uniform vec2 texelSize;
uniform vec4 surfaceParams;
varying vec2 vUv;
${SURFACE}

void main() {
  vec4 base = texture2D(inputBuffer, vUv);
  float d = texture2D(depthBuffer, vUv).r;
  if (d >= 0.9999) { gl_FragColor = base; return; }

  vec3 p = viewPos(vUv, d);
  vec3 n = reconstructNormal(vUv, p, texelSize);
  float gloss = glossFor(n, surfaceParams.x, surfaceParams.y);
  if (gloss < 0.02) { gl_FragColor = base; return; }

  float rough = roughFor(n, surfaceParams.x, surfaceParams.y);
  vec3 v = normalize(p);
  float nv = clamp(dot(n, -v), 0.0, 1.0);
  // Schlick: every dielectric goes to a mirror at grazing incidence.
  float fresnel = 0.04 + 0.96 * pow(1.0 - nv, 5.0);

  // Roughness picks the mip: mirror puddles read sharp, damp asphalt reads soft.
  float lod = clamp(rough * 3.6, 0.0, 3.0);
  vec4 a = (lod < 1.0) ? mix(texture2D(ssr0, vUv), texture2D(ssr1, vUv), lod)
         : (lod < 2.0) ? mix(texture2D(ssr1, vUv), texture2D(ssr2, vUv), lod - 1.0)
                       : mix(texture2D(ssr2, vUv), texture2D(ssr3, vUv), lod - 2.0);

  float w = a.a * gloss * fresnel * surfaceParams.z;
  // Where the ray missed, w is 0 and the material's own environment probe is left
  // untouched — that is the fallback, and it costs nothing.
  gl_FragColor = vec4(mix(base.rgb, a.rgb, clamp(w, 0.0, 1.0)), base.a);
}`;
