import * as THREE from 'three';
import TextureFactory, { RECIPES } from './TextureFactory.js';
import { makeRoadMaterial } from '../world/Roads.js';

/**
 * The city's material library.
 *
 * Everything is procedural — no image assets, no fetches. Each material gets a
 * full PBR set baked by TextureFactory: albedo (sRGB), a Sobel-derived
 * tangent-space normal map, and a packed ORM map (R=AO, G=roughness,
 * B=metalness). Materials and textures are registered through `ctx.assets` so
 * they are shared city-wide, disposed once, and picked up automatically by
 * `assets.setWetness()` when it rains.
 *
 * UV convention for consumers: uv 1.0 spans `material.userData.tileMeters`
 * metres of world surface. Build UVs in metres and divide, e.g.
 *   uv = worldXZ / m.userData.tileMeters
 * so texel density is consistent everywhere in the city.
 */

const V2 = (x, y = x) => new THREE.Vector2(x, y);

/**
 * Physical parameters per material. `map`/`normalMap`/`ormMap` come from the
 * recipe of the same name; anything here overrides the baked scalars.
 * wet: true  -> the rain system may darken and gloss this surface.
 */
const SPEC = {
  /* --- ground ---------------------------------------------------------- */
  asphalt:          { normalScale: 1.0, ao: 1.0, wet: true },
  asphalt_worn:     { normalScale: 1.1, ao: 1.0, wet: true },
  sidewalk:         { normalScale: 1.0, ao: 1.0, wet: true },
  sidewalk_brick:   { normalScale: 1.15, ao: 1.15, wet: true },
  cobblestone:      { normalScale: 1.35, ao: 1.25, wet: true },
  dirt:             { normalScale: 1.15, ao: 1.1, wet: true },
  grass:            { normalScale: 1.0, ao: 1.0, wet: true },

  road_line_white:  { normalScale: 0.7, ao: 0.5, wet: true, transparent: true,
                      depthWrite: false, polygonOffset: -2, alphaTest: 0.12 },
  road_line_yellow: { normalScale: 0.7, ao: 0.5, wet: true, transparent: true,
                      depthWrite: false, polygonOffset: -2, alphaTest: 0.12 },

  /* --- masonry --------------------------------------------------------- */
  brick_red:        { normalScale: 1.0, ao: 1.1, wet: true },
  brick_brown:      { normalScale: 1.0, ao: 1.1, wet: true },
  brownstone:       { normalScale: 0.9, ao: 1.0, wet: true },
  granite:          { normalScale: 0.7, ao: 0.9, wet: true },
  limestone:        { normalScale: 0.8, ao: 0.9, wet: true },
  concrete:         { normalScale: 0.85, ao: 0.9, wet: true },
  concrete_stained: { normalScale: 0.9, ao: 1.0, wet: true },

  /* --- glass -----------------------------------------------------------
   * Deliberately NOT wetness-driven. assets.setWetness() lerps roughness to
   * 0.06 and multiplies colour by up to 0.58; on a curtain wall (already
   * roughness 0.02-0.08) that only darkens the tower by 40% for no gain, and
   * vertical glass sheds water anyway. window_lit is an interior, water is
   * already water. Everything else outdoors sets wetnessRough/wetnessColor. */
  glass_tower:      { normalScale: 0.35, ao: 0.4, env: 1.25 },
  glass_dark:       { normalScale: 0.35, ao: 0.4, env: 1.1 },
  window_lit:       { normalScale: 0.3, ao: 0.4, env: 0.9, nightEmissive: 1.35,
                      emissive: 0xffffff },

  /* --- metals ---------------------------------------------------------- */
  metal_painted:    { normalScale: 0.7, ao: 0.7, wet: true, env: 1.0 },
  metal_rusty:      { normalScale: 1.1, ao: 1.0, wet: true, env: 0.9 },
  // Deliberately NOT using MeshPhysicalMaterial.anisotropy: three's anisotropy
  // chunk redeclares geometryNormal, which collides with the custom lighting
  // injected via onBeforeCompile and fails the fragment shader outright. The
  // directional scratch normal map carries the brushed look on its own.
  steel_brushed:    { normalScale: 0.5, ao: 0.6, env: 1.1, wet: true },
  chrome:           { normalScale: 0.25, ao: 0.3, env: 1.3, wet: true },
  copper_patina:    { normalScale: 0.8, ao: 0.9, wet: true, env: 1.0 },

  /* --- roofs / cladding ------------------------------------------------ */
  roof_tar:         { normalScale: 0.9, ao: 0.9, wet: true },
  roof_gravel:      { normalScale: 1.3, ao: 1.2, wet: true },
  slate_roof:       { normalScale: 1.1, ao: 1.1, wet: true },
  wood_painted:     { normalScale: 0.9, ao: 0.9, wet: true },

  /* --- vegetation ------------------------------------------------------ */
  foliage:          { normalScale: 0.8, ao: 1.0, wet: true, alphaTest: 0.34,
                      side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
                      transparent: false },

  /* --- water ----------------------------------------------------------- */
  water:            { normalScale: 0.55, env: 1.35, physical: true,
                      color: 0x18333c, roughness: 0.055, metalness: 0.0,
                      ior: 1.333, scroll: 0.010 },

  /* --- vehicles -------------------------------------------------------- */
  tire:             { normalScale: 1.0, ao: 1.0, wet: true },
  glass_car:        { normalScale: 0.3, env: 1.5, physical: true, wet: true,
                      transparent: true, opacity: 0.30, color: 0x0b1014,
                      ior: 1.52, depthWrite: false, side: THREE.DoubleSide },
};

/**
 * Road atlas layout, in the UV space `Roads.js` samples with
 * (`TILE_UV = [[0,0],[0.5,0],[0,0.5],[0.5,0.5]]`, tiles asphalt/concrete/brick/
 * cobble). Our textures are baked flipped (painted row 0 becomes v=1), so
 * uv v 0..0.5 is the LOWER half of the painted image.
 */
const ATLAS_TILES = {
  asphalt:        [0, 512],     // uv (0.0, 0.0)  T_ASPHALT
  sidewalk:       [512, 512],   // uv (0.5, 0.0)  T_CONCRETE
  sidewalk_brick: [0, 0],       // uv (0.0, 0.5)  T_BRICK
  cobblestone:    [512, 0],     // uv (0.5, 0.5)  T_COBBLE
};
/** Sobel gain the atlas is baked at — asphalt's, the tile seen most. */
const ATLAS_REF_K = 0.019 * 512 / (8 * 2.4);

/** Fallback used by get() for unknown names — neutral, never null. */
function makeFallback() {
  const m = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85, metalness: 0 });
  m.userData.tileMeters = 1;
  return m;
}

export default class Materials {
  static id = 'materials';
  static label = 'Material library';
  static deps = ['assets', 'render'];

  constructor() {
    this._mats = new Map();
    this._maps = new Map();
    this._carPaints = new Map();
    this._warned = new Set();
    this._lastNight = -1;
    this._scroll = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.assets = ctx.assets;

    // Texture budget scales with the quality preset: half-res on low ends up
    // around 55 MB of VRAM instead of 210 MB, with the same art.
    const scale = { low: 0.5, medium: 0.75, high: 1, ultra: 1 }[ctx.settings.preset] ?? 1;
    this.factory = new TextureFactory({ scale, seed: 20240826 });

    const t0 = performance.now();
    // Only the road atlas is built eagerly. Everything else is generated on the
    // first get(), because consumers resolve their materials during their own
    // init() — so anything the city actually uses is still ready before the
    // first frame, and we stop paying ~120 MB and ~2.5 s for the materials
    // nobody has adopted yet.
    //
    // The atlas gives the whole street network one draw call per chunk. Its
    // four tiles are the same recipes as the standalone materials, so we
    // capture each painted surface as it is built rather than painting twice.
    this._atlas = this.factory.newAtlas(1024);
    for (const name of Object.keys(ATLAS_TILES)) this._build(name, ctx);
    this._buildRoadAtlas();
    this.buildMs = performance.now() - t0;

    console.info(`[materials] ready in ${this.buildMs | 0} ms ` +
      `(road atlas + ${this._mats.size - 1} tiles; ${Object.keys(SPEC).length} more on demand)`);

    // Anything generated after boot costs a ~150 ms hitch on the frame that
    // asks for it. Every consumer should resolve its materials in init(), so
    // surface it loudly rather than letting it hide as a stutter.
    ctx.bus.on('engine:ready', () => { this._booted = true; });
  }

  /** Force-build a set of materials up front, e.g. before a level transition. */
  prewarm(names) {
    for (const n of names) this.get(n);
  }

  /** Aggregate cost of everything generated so far. */
  stats() {
    const f = this.factory.stats;
    return {
      materials: this._mats.size,
      textures: f.textures,
      vramMB: +((f.texels * 4 * 1.334) / (1024 * 1024)).toFixed(1),
      buildMs: +f.timings.reduce((a, x) => a + x[1], 0).toFixed(0),
    };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Bake (or fetch) the map set for a recipe, cached in ctx.assets so every
   * caller shares one copy.
   *
   * Anisotropy is tiered deliberately. Roads and sidewalks fill the screen at
   * grazing angles, where 16x aniso costs up to 16 taps per map per pixel —
   * three maps deep that is the single most expensive thing a ground material
   * can do. Albedo is the only channel where the extra taps are visible, so
   * normals get 4x and the (already half-res, low-frequency) ORM gets 2x.
   */
  _mapsFor(name) {
    let m = this._maps.get(name);
    if (m) return m;
    const recipe = RECIPES[name];
    if (!recipe) return null;
    const baked = this.factory.build(name, recipe);
    const aniso = (t, cap) => { if (t) t.anisotropy = Math.min(t.anisotropy || 1, cap); return t; };
    m = {
      map: aniso(this.assets.texture(`${name}.alb`, () => baked.map), 8),
      normalMap: baked.normalMap ? aniso(this.assets.texture(`${name}.nrm`, () => baked.normalMap), 4) : null,
      ormMap: baked.ormMap ? aniso(this.assets.texture(`${name}.orm`, () => baked.ormMap), 2) : null,
      roughScalar: baked.roughScalar, metalScalar: baked.metalScalar,
    };
    this._maps.set(name, m);
    return m;
  }

  _build(name, ctx) {
    if (this._booted && !this._warned.has('late:' + name)) {
      this._warned.add('late:' + name);
      console.warn(`[materials] "${name}" generated after boot — this stalls a ` +
        `frame. Resolve it in your system's init(), or call materials.prewarm().`);
    }
    const s = SPEC[name] || {};
    const recipe = RECIPES[name];
    const maps = this._mapsFor(name);
    const mat = this.assets.material(name, () => {
      const p = {
        color: s.color ?? 0xffffff,
        map: maps.map,
        normalMap: maps.normalMap || null,
        normalScale: V2(s.normalScale ?? 1),
        roughness: s.roughness ?? maps.roughScalar,
        metalness: s.metalness ?? maps.metalScalar,
        envMapIntensity: s.env ?? 1.0,
        side: s.side ?? THREE.FrontSide,
        transparent: !!s.transparent,
      };
      if (maps.ormMap) {
        p.aoMap = maps.ormMap;
        p.roughnessMap = maps.ormMap;
        if ((s.metalness ?? maps.metalScalar) > 0) p.metalnessMap = maps.ormMap;
      }
      const m = s.physical ? new THREE.MeshPhysicalMaterial(p) : new THREE.MeshStandardMaterial(p);
      if (maps.ormMap) m.aoMapIntensity = s.ao ?? 1;
      if (s.alphaTest) m.alphaTest = s.alphaTest;
      if (s.opacity !== undefined) m.opacity = s.opacity;
      if (s.depthWrite === false) m.depthWrite = false;
      if (s.shadowSide) m.shadowSide = s.shadowSide;
      if (s.polygonOffset) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = s.polygonOffset;
        m.polygonOffsetUnits = s.polygonOffset;
      }
      if (s.ior !== undefined && m.ior !== undefined) m.ior = s.ior;
      if (s.anisotropy !== undefined) {
        m.anisotropy = s.anisotropy;
        m.anisotropyRotation = s.anisotropyRotation ?? 0;
      }
      if (s.nightEmissive) {
        m.emissive = new THREE.Color(s.emissive ?? 0xffffff);
        m.emissiveMap = maps.map;               // the lit interior is the albedo
        m.emissiveIntensity = 0;                // update() drives this
      }
      return m;
    });

    const slot = ATLAS_TILES[name];
    if (slot && this._atlas) {
      const S = this.factory.lastSurface;
      if (S && S.w === 512) {
        this.factory.blitTile(this._atlas, S, slot[0], slot[1],
          this.factory.lastRelief / ATLAS_REF_K);
        this._atlasRef = this._atlasRef || {};
        this._atlasRef[name] = true;
      }
    }

    mat.userData.tileMeters = recipe?.tile ?? 1;
    mat.userData.tileMetersY = recipe?.tileY ?? recipe?.tile ?? 1;
    if (s.scroll) mat.userData.scrollSpeed = s.scroll;
    if (s.nightEmissive) mat.userData.nightEmissive = s.nightEmissive;
    // Rain hook — Assets.setWetness() lerps these toward wet values.
    if (s.wet) {
      mat.userData.wetnessRough = mat.roughness;
      mat.userData.wetnessColor = mat.color.clone();
    }
    this._mats.set(name, mat);
    void ctx;
    return mat;
  }

  /**
   * Assemble the shared paved-surface atlas and wrap it in the road shader.
   * The material is built by Roads.js's own exported `makeRoadMaterial`, so the
   * custom attributes (aSurf/aTile/aRough) and the tiling shader stay in sync
   * with the geometry that feeds them — we only supply the pixels.
   */
  _buildRoadAtlas() {
    const missing = Object.keys(ATLAS_TILES).filter(n => !this._atlasRef?.[n]);
    if (missing.length) {
      console.warn('[materials] road_atlas missing tiles:', missing.join(', '));
    }
    const tex = this.factory.bakeAtlas(this._atlas, ATLAS_REF_K);
    const map = this.assets.texture('road_atlas.alb', () => tex.map);
    const nrm = this.assets.texture('road_atlas.nrm', () => tex.nrm);
    map.anisotropy = Math.min(map.anisotropy || 1, 8);
    nrm.anisotropy = Math.min(nrm.anisotropy || 1, 4);
    const m = this.assets.material('road_atlas', () => makeRoadMaterial({ map, nrm }));
    m.userData.tileMeters = 2.4;
    m.userData.wetnessRough = m.roughness;
    m.userData.wetnessColor = m.color.clone();
    this._mats.set('road_atlas', m);
    this._atlas = null;                        // free the 4 MB float composite
  }

  /* ---- public API (CONTRACTS.md) --------------------------------------- */

  /**
   * Fetch a shared material by name. Never returns null: unknown names get a
   * neutral grey standard material and warn exactly once.
   * @param {string} name
   * @returns {THREE.Material}
   */
  get(name) {
    const m = this._mats.get(name);
    if (m) return m;
    if (name && name.startsWith('car_paint:')) return this.carPaint(name.slice(10));
    if (name === 'car_paint') return this.carPaint();
    if (SPEC[name]) return this._build(name, this.ctx);      // generate on demand
    if (!this._warned.has(name)) {
      this._warned.add(name);
      console.warn(`[materials] unknown material "${name}" — using fallback`);
    }
    if (!this._fallback) {
      this._fallback = this.assets.material('_fallback', makeFallback);
    }
    return this._fallback;
  }

  /**
   * Every material name this library can serve, whether or not it has been
   * generated yet. Generation happens on first get().
   * @returns {string[]}
   */
  names() {
    return [...new Set([...Object.keys(SPEC), ...this._mats.keys(), 'car_paint'])].sort();
  }

  /** @returns {string[]} names that have actually been generated. */
  built() {
    return [...this._mats.keys()].sort();
  }

  /**
   * Clearcoat metallic car paint, cached per colour.
   * @param {number|string} color  hex number or CSS colour string
   * @returns {THREE.MeshPhysicalMaterial}
   */
  carPaint(color = 0xb9bec4) {
    const c = new THREE.Color();
    typeof color === 'string' ? c.setStyle(color[0] === '#' ? color : '#' + color) : c.set(color);
    // Snap to a 5-bit-per-channel grid: callers passing jittered colours still
    // land on a shared material instead of spawning a new draw batch each.
    c.setRGB(Math.round(c.r * 31) / 31, Math.round(c.g * 31) / 31, Math.round(c.b * 31) / 31);
    const key = 'car_paint:' + c.getHexString();
    let m = this._carPaints.get(key);
    if (m) return m;

    const flake = this._mapsFor('_car_flake');
    const coat = this._mapsFor('_car_clearcoat');
    m = this.assets.material(key, () => new THREE.MeshPhysicalMaterial({
      color: c,
      metalness: 0.78,
      roughness: 0.26,
      // Flake sparkle lives in the base normal; the clearcoat gets its own
      // gentle orange peel so highlights ripple the way real paint does.
      normalMap: flake.normalMap,
      normalScale: V2(0.13),
      roughnessMap: flake.ormMap,
      metalnessMap: flake.ormMap,
      clearcoat: 1.0,
      clearcoatRoughness: 0.045,
      clearcoatNormalMap: coat.normalMap,
      clearcoatNormalScale: V2(0.22),
      envMapIntensity: 1.25,
    }));
    m.userData.tileMeters = 0.35;
    this._carPaints.set(key, m);
    if (!this._mats.has('car_paint')) this._mats.set('car_paint', m);
    return m;
  }

  /* ---------------------------------------------------------------------- */

  update(dt, ctx) {
    // Window emissives follow the world clock (lights on ~18:30, off ~06:30).
    const h = ctx.time.timeOfDay;
    const day = THREE.MathUtils.smoothstep(h, 5.9, 7.1) *
                (1 - THREE.MathUtils.smoothstep(h, 17.9, 19.3));
    const night = 1 - day;
    if (Math.abs(night - this._lastNight) > 0.002) {
      this._lastNight = night;
      for (const m of this._mats.values()) {
        const k = m.userData.nightEmissive;
        if (k) m.emissiveIntensity = k * night;
      }
    }
    // Slow drift on the water normal so the river is never static.
    const w = this._mats.get('water');
    if (w?.normalMap) {
      this._scroll = (this._scroll + dt * (w.userData.scrollSpeed || 0.01)) % 1;
      w.normalMap.offset.x = this._scroll;
      w.normalMap.offset.y = this._scroll * 0.37;
    }
  }

  /**
   * The factory deliberately stays resident after init so an on-demand build
   * does not have to regenerate the 512^2 noise bank. That is ~25 MB of JS
   * heap, not VRAM, and it is released here.
   */
  dispose() {
    // Textures and materials are owned by ctx.assets, which disposes them.
    this._mats.clear(); this._maps.clear(); this._carPaints.clear();
    this.factory?.release();
  }
}

export { SPEC as MATERIAL_SPEC };