import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * Adds the LensPass output back into the HDR frame: veiling glare (wide + core lobes),
 * anamorphic streaks and lens dirt.
 *
 * Runs before exposure and tone mapping, because glare happens at the lens, not at the
 * sensor — that way a bloomed highlight is stopped down by eye adaptation exactly like
 * the source that produced it.
 *
 * Only samples external textures at the current uv, never the input buffer at an offset,
 * so it is NOT a convolution effect and merges into the main effect pass for free.
 */
export default class LensCompositeEffect extends Effect {
  constructor() {
    super('LensCompositeEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([
        ['bloomCore', new THREE.Uniform(null)],
        ['bloomWide', new THREE.Uniform(null)],
        ['streakTex', new THREE.Uniform(null)],
        ['dirtTex', new THREE.Uniform(makeDirtTexture())],
        // x: core weight, y: wide weight, z: streak weight, w: dirt amount
        ['lensWeights', new THREE.Uniform(new THREE.Vector4(0.55, 0.85, 0.0, 0.0))],
        ['bloomTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['streakTint', new THREE.Uniform(new THREE.Vector3(0.55, 0.72, 1.0))],
      ]),
    });
  }

  setTextures(core, wide, streak) {
    this.uniforms.get('bloomCore').value = core;
    this.uniforms.get('bloomWide').value = wide;
    this.uniforms.get('streakTex').value = streak;
  }

  /**
   * @param {number} core - weight of the tight PSF lobe
   * @param {number} wide - weight of the broad veiling-glare lobe
   * @param {number} streak - anamorphic streak weight
   * @param {number} dirt - lens dirt amount (modulates the glare, never the base image)
   */
  setWeights(core, wide, streak, dirt) {
    this.uniforms.get('lensWeights').value.set(core, wide, streak, dirt);
  }

  setTints(bloom, streak) {
    this.uniforms.get('bloomTint').value.set(bloom[0], bloom[1], bloom[2]);
    this.uniforms.get('streakTint').value.set(streak[0], streak[1], streak[2]);
  }

  dispose() {
    this.uniforms.get('dirtTex').value?.dispose();
    super.dispose();
  }
}

/**
 * Procedural lens dirt: a few greasy smudges, a scatter of dust and a couple of
 * hairline scratches. Only ever multiplies the glare term, so it is invisible until
 * something bright is in frame — which is exactly how a dirty front element behaves.
 */
function makeDirtTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);

  // Deterministic PRNG so every session gets the same lens.
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 100000) / 100000;
  };

  g.globalCompositeOperation = 'lighter';
  // Smudges: large, soft, low contrast.
  for (let i = 0; i < 14; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.05 + rnd() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.10 + rnd() * 0.22;
    grad.addColorStop(0, `rgba(255,250,240,${a})`);
    grad.addColorStop(0.55, `rgba(210,225,255,${a * 0.35})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rnd()), rnd() * 3.14, 0, 6.2832); g.fill();
  }
  // Dust specks.
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 0.6 + rnd() * 2.6;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.25 + rnd() * 0.6;
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  // Hairline scratches.
  g.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const x = rnd() * size, y = rnd() * size;
    const ang = rnd() * 6.2832, len = size * (0.1 + rnd() * 0.45);
    g.strokeStyle = `rgba(235,240,255,${0.10 + rnd() * 0.18})`;
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(ang) * len * 0.5 + (rnd() - 0.5) * 40,
                       y + Math.sin(ang) * len * 0.5 + (rnd() - 0.5) * 40,
                       x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'LensDirt';
  return tex;
}

const FRAG = /* glsl */`
uniform sampler2D bloomCore;
uniform sampler2D bloomWide;
uniform sampler2D streakTex;
uniform sampler2D dirtTex;
uniform vec4 lensWeights;
uniform vec3 bloomTint;
uniform vec3 streakTint;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 glare = texture2D(bloomCore, uv).rgb * lensWeights.x
             + texture2D(bloomWide, uv).rgb * lensWeights.y;
  glare *= bloomTint;

  if (lensWeights.z > 0.0) {
    glare += texture2D(streakTex, uv).rgb * streakTint * lensWeights.z;
  }

  if (lensWeights.w > 0.0) {
    // Dirt scatters the glare that is already there. Never added on its own, so a
    // clean dark frame stays clean.
    vec3 dirt = texture2D(dirtTex, uv * vec2(aspect, 1.0) * 0.75).rgb;
    glare += glare * dirt * lensWeights.w;
  }

  outputColor = vec4(inputColor.rgb + max(glare, vec3(0.0)), inputColor.a);
}`;
