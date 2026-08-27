import * as THREE from 'three';

/**
 * Central texture + material registry. Everything shares through here so we
 * can retune the whole city (wetness, night emissives) with one call.
 */
export default class Assets {
  static id = 'assets';
  static label = 'Asset registry';
  static deps = [];

  constructor() {
    this.textures = new Map();
    this.materials = new Map();
    this.geometries = new Map();
    this._anis = 8;
  }

  async init(ctx) {
    this._anis = Math.min(ctx.settings.anisotropy,
      ctx.renderer.capabilities.getMaxAnisotropy());
    this.ctx = ctx;
  }

  /** Register (or fetch) a texture built by `fn` exactly once. */
  texture(key, fn) {
    if (this.textures.has(key)) return this.textures.get(key);
    const t = fn();
    t.anisotropy = this._anis;
    t.needsUpdate = true;
    this.textures.set(key, t);
    return t;
  }

  /** Register (or fetch) a material built by `fn` exactly once. */
  material(key, fn) {
    if (this.materials.has(key)) return this.materials.get(key);
    const m = fn();
    m.name = key;
    this.materials.set(key, m);
    return m;
  }

  geometry(key, fn) {
    if (this.geometries.has(key)) return this.geometries.get(key);
    const g = fn();
    this.geometries.set(key, g);
    return g;
  }

  /** Global wetness 0..1 — rain system drives this. */
  setWetness(v) {
    for (const m of this.materials.values()) {
      if (m.userData.wetnessRough === undefined) continue;
      m.roughness = THREE.MathUtils.lerp(m.userData.wetnessRough, 0.06, v);
      if (m.userData.wetnessColor) {
        m.color.copy(m.userData.wetnessColor).multiplyScalar(1 - v * 0.42);
      }
    }
  }

  stats() {
    return { textures: this.textures.size, materials: this.materials.size,
             geometries: this.geometries.size };
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const g of this.geometries.values()) g.dispose();
    this.textures.clear(); this.materials.clear(); this.geometries.clear();
  }
}
