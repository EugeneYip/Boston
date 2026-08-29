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
    /** 0..1, published for ColorGrade and the material library. */
    this.wetness = 0;
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

  /**
   * Global wetness 0..1 — the rain system drives this.
   *
   * This is a dumb lerp on purpose. The *policy* — how dark and how glossy each
   * family of surface goes — lives in `Materials.WETNESS` and is stamped into
   * `userData.wetRough` / `userData.wetDarken`, so it also reaches materials
   * authored in `src/world/`. A material that has not been stamped falls back to
   * a conservative derivation of its own dry roughness rather than the old
   * hard-coded 0.06, which was a mirror.
   *
   * Previous behaviour, for the record: every wet surface went to roughness 0.06
   * and 58% albedo. A horizontal near-mirror reflects the brightest thing in the
   * sky, so rain made the carriageway *brighter* — measured 2.32x brighter over
   * 234k road pixels with exposure pinned — and read as ice.
   */
  setWetness(v) {
    const w = THREE.MathUtils.clamp(v, 0, 1);
    this.wetness = w;
    for (const m of this.materials.values()) {
      const ud = m.userData;
      const dry = ud.wetnessRough;
      if (dry === undefined) continue;
      const k = w * (ud.wetAmount ?? 1);
      // Smoother, but never a mirror: a sheeted surface is ~0.2-0.3 rough.
      // Only standing water mirrors, and standing water is a puddle.
      const target = ud.wetRough ?? Math.max(0.24, dry * 0.32);
      m.roughness = dry + (target - dry) * k;
      // Darker, because water trapped in the pores is what a wet surface is.
      if (ud.wetnessColor) {
        m.color.copy(ud.wetnessColor).multiplyScalar(1 - k * (ud.wetDarken ?? 0.45));
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
