import * as THREE from 'three';
import TextureFactory, { RECIPES, ASPHALT_ABLATE } from './TextureFactory.js';
import EnvProbe from './EnvProbe.js';
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
   * Deliberately NOT wetness-driven. assets.setWetness() darkens and smooths a
   * surface; on a curtain wall (already roughness 0.02-0.08) that only darkens
   * the tower for no gain, and vertical glass sheds water anyway. window_lit is
   * an interior, water is already water. Everything else outdoors sets
   * wetnessRough/wetnessColor.
   *
   * `env` is load-bearing beyond this file: `Buildings.init` copies
   * `glass_tower.envMapIntensity` onto `building_glass`, which is the material
   * on 200 Clarendon, the Pru and every curtain wall in the city. It is 2.0
   * rather than 1.0 because that glass is authored as a near-dielectric
   * (metalness 0.02, F0 = 0.04) while the Hancock's glazing is a *coated*
   * mirror — roughly 20-25% reflectance at normal incidence, not 4%. Scaling
   * the IBL is the approximation that reaches it without touching a material
   * this file does not own. */
  glass_tower:      { normalScale: 0.35, ao: 0.4, env: 2.0 },
  glass_dark:       { normalScale: 0.35, ao: 0.4, env: 1.7 },
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

/**
 * Wetness response, by material family.
 *
 * `rough` is the roughness a fully soaked surface converges to; `darken` is the
 * fraction of its dry albedo that a full soaking REMOVES — `Assets.setWetness`
 * applies `color x (1 - wetness * darken)`, so 0.58 leaves 42% of the albedo
 * standing, not 58%. (This comment used to say "survives", which is the
 * opposite, and reading it that way turns every entry below into its own
 * complement.) Both are stamped into `userData` (see `_stampWetness`) and
 * consumed by `Assets.setWetness`, which is a dumb lerp — the policy lives here,
 * in the material library, so it also reaches materials authored in
 * `src/world/`.
 *
 * Measured against the physics, on the road: dry asphalt now ships at 0.108
 * linear albedo and real soaked hot-mix measures 0.04-0.05, so the survival the
 * carriageway wants is 0.37-0.46. `darken: 0.58` here gives 0.42, and the road
 * shader multiplies a further ~0.80 on top of it, for 0.34 — which is why that
 * shader term is 0.20 and not larger. Do not raise `darken` for the road family
 * to chase a wet/dry ratio: it is already at the physical value, and past it the
 * carriageway drops back under its own F0 of 0.04 in the rain, which is the
 * failure this whole line of work started from.
 *
 * The physics, because the old constants had it backwards. A water film fills
 * the pores of a rough surface; light that enters the film is trapped by total
 * internal reflection and comes back out attenuated, so **wet asphalt gets
 * darker** — real dry asphalt sits near 0.10 diffuse reflectance and drops to
 * ~0.04-0.05 when soaked. What comes back is a *specular* layer, not a brighter
 * diffuse one. And a wet road is not a mirror: only standing water is, and
 * standing water is a puddle. A sheet of rain-damp asphalt measures around
 * 0.2-0.3 roughness, which is why the target here is 0.26 and not 0.06.
 */
const WETNESS = [
  [/asphalt|road|tarmac|carriageway/i,        { rough: 0.26, darken: 0.58 }],
  [/sidewalk|pavement|concrete|granite|stone|kerb|curb/i, { rough: 0.30, darken: 0.48 }],
  [/cobble|brick|brownstone|limestone|slate|masonry|facade/i, { rough: 0.29, darken: 0.46 }],
  // Vegetation and cloth soak rather than sheet. They darken hard and gain only
  // a weak sheen; lerping a leaf to 0.26 turns a park into a hall of mirrors.
  [/veg|foliage|leaf|leaves|plant|tree|bark|shrub|grass|hedge|ivy/i,
                                              { rough: 0.55, darken: 0.34 }],
  [/char|ped|cloth|skin|hair/i,               { rough: 0.62, darken: 0.24 }],
  [/dirt|soil|earth|mud|gravel|sand/i,        { rough: 0.42, darken: 0.55 }],
  [/metal|steel|chrome|copper|alu|tire|tyre|rubber/i, { rough: 0.20, darken: 0.28 }],
  [/glass|window/i,                           { rough: 0.06, darken: 0.10 }],
];
/** Anything the table does not name. Derived from its own dry roughness. */
const WET_DEFAULT = { rough: null, darken: 0.45 };

/** Ceiling on an adopted material's authored `envMapIntensity` (see _applyEnv). */
const ENV_MAX = 2.4;

export default class Materials {
  static id = 'materials';
  static label = 'Material library';
  /**
   * `sky` is a dependency for **ordering**, not for data: `Sky.lateUpdate`
   * reassigns `scene.environment` to its own sky-only PMREM whenever the sun
   * moves, so the reflection probe has to run after it or the two thrash the
   * texture — and because `envMapCubeUVHeight` is part of the program cache key,
   * thrashing it would recompile every lit material in the city, twice a frame.
   * Sky depends only on `render`, so this adds no cycle; it just moves Sky one
   * slot earlier in boot.
   */
  static deps = ['assets', 'render', 'sky'];

  constructor() {
    this._mats = new Map();
    this._maps = new Map();
    this._carPaints = new Map();
    this._warned = new Set();
    this._lastNight = -1;
    this._scroll = 0;
    this._adoptTimer = 1e9;
    this._lastEnvI = -1;
    this._lastWet = -1;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.assets = ctx.assets;

    // Texture budget scales with the quality preset: half-res on low ends up
    // around 55 MB of VRAM instead of 210 MB, with the same art.
    const scale = { low: 0.5, medium: 0.75, high: 1, ultra: 1 }[ctx.settings.preset] ?? 1;
    this.factory = new TextureFactory({ scale, seed: 20240826 });

    // The reflection probe is allocated FIRST so `probe.texture` already exists
    // when the materials below are constructed. Handing a material its envMap at
    // construction costs nothing; assigning one later is what forces a recompile.
    this.probe = new EnvProbe({ preset: ctx.settings.preset });
    this.probe.init(ctx);

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
    ctx.bus.on('engine:ready', () => {
      this._booted = true;
      // The city exists now, so the probe finally has something to reflect.
      // Doing the whole cube here, before the first presented frame, means the
      // one recompile wave caused by `envMapCubeUVHeight` changing (336x256 sky
      // PMREM -> the probe's) lands during boot instead of mid-game.
      this.probe.refreshNow(ctx);
      this.adopt(ctx);
      ctx.scene.environment = this.probe.texture;
      console.info(`[materials] env probe ${this.probe.size}^2 cube -> ` +
        `${this.probe.pmremRT.width}x${this.probe.pmremRT.height} PMREM, ` +
        `${this._adopted} materials on it`);
    });
    ctx.bus.on('quality:changed', () => {
      if (this.probe.setQuality(ctx.settings.preset)) this.adopt(ctx, true);
    });
    ctx.bus.on('weather:set', () => this.probe?.invalidate());
  }

  /**
   * Put every registered material on the probe.
   *
   * Two things happen here, and the second one is the reason this exists at all.
   *
   * 1. `material.envMap = probe.texture`. Materials that lean on
   *    `scene.environment` instead have their `envMapIntensity` **overwritten**
   *    by `scene.environmentIntensity` every frame — see the block quoted in
   *    EnvProbe.js. Every authored reflectance in this project (glass 2.0, water
   *    2.1, chrome 1.3, car glass 2.4, road 0.55) was being collapsed to one
   *    global scalar. Adoption restores them.
   * 2. The wetness response is stamped from the `WETNESS` table, so materials
   *    built in `src/world/` get the same physics as the ones built here.
   *
   * Costs no recompile: `scene.environment` and every adopted `envMap` are the
   * same texture object, so the `envMapCubeUVHeight` program parameter does not
   * change.
   */
  adopt(ctx, force = false) {
    const tex = this.probe?.texture;
    if (!tex) return 0;
    let n = 0;
    for (const m of ctx.assets.materials.values()) {
      this._stampWetness(m);
      if (!m.isMeshStandardMaterial) continue;      // Physical extends Standard
      if (m.userData.noEnvProbe) continue;
      if (m.envMap === tex && !force) { n++; continue; }
      if (m.userData.envBase === undefined) {
        m.userData.envBase = THREE.MathUtils.clamp(m.envMapIntensity ?? 1, 0, ENV_MAX);
      }
      m.envMap = tex;
      n++;
    }
    this._adopted = n;
    this._lastEnvI = -1;                            // force an intensity refresh
    return n;
  }

  /**
   * Give a material its wet-surface targets, once.
   *
   * `Assets.setWetness` used to lerp *every* wet surface to roughness 0.06 and
   * only 58% of its albedo. On a flat carriageway a roughness of 0.06 is a
   * mirror, and the brightest thing a horizontal mirror can see is the sky —
   * which is why rain turned Boylston Street into a sheet of white ice, the
   * single most wrong thing in the critic's rain frame. Measured on 234k road
   * pixels at Beacon St, exposure pinned: dry mean luminance 30.1, wet **69.9**.
   * Water is supposed to make asphalt darker, not 2.3x brighter.
   */
  _stampWetness(m) {
    const ud = m.userData;
    if (ud.wetnessRough === undefined || ud.wetRough !== undefined) return;
    const key = `${m.name || ''}|${ud.family || ''}`;
    let spec = WET_DEFAULT;
    for (const [re, s] of WETNESS) { if (re.test(key)) { spec = s; break; } }
    const dry = ud.wetnessRough;
    ud.wetRough = spec.rough ?? Math.max(0.24, dry * 0.32);
    ud.wetDarken = spec.darken;
  }

  /**
   * Fold the world clock's environment level back into every adopted material.
   *
   * `Lighting` drives `scene.environmentIntensity` (0.16 at night to ~0.78 at
   * noon) and that is the *only* thing an unadopted material sees. An adopted
   * one keeps its own `envMapIntensity`, so the day/night curve has to be
   * multiplied in by hand or the city would reflect a noon sky at midnight.
   */
  _applyEnv(ctx) {
    const envI = ctx.scene.environmentIntensity ?? 1;
    const wet = ctx.assets.wetness || 0;
    if (Math.abs(envI - this._lastEnvI) < 0.002 && Math.abs(wet - this._lastWet) < 0.01) return;
    this._lastEnvI = envI; this._lastWet = wet;
    const tex = this.probe?.texture;
    for (const m of ctx.assets.materials.values()) {
      // Surfaces that shade their own wetness (the road atlas) need the level
      // itself, not just a roughness lerp — puddles have to pool somewhere, and
      // only the shader knows where the gutter is. Push it before the envMap
      // test so it reaches the material whether or not it is on the probe.
      const ud = m.userData;
      if (ud.setWet) { ud.wetLevel = wet; ud.setWet(wet); }
      const base = ud.envBase;
      if (base === undefined || m.envMap !== tex) continue;
      // A water film is a fresh dielectric layer over a surface that had none,
      // so a wet street does pick up more of the environment. Kept modest by
      // default: the darker albedo below it is what has to dominate, or we are
      // back to a white road by another route. `wetEnvBoost` raises it for the
      // one surface where the reflection IS the effect — a puddle at roughness
      // 0.055 reflecting a 0.4-intensity probe is a grey smudge, not a mirror.
      const boost = ud.wetRough !== undefined ? 1 + wet * (ud.wetEnvBoost ?? 0.35) : 1;
      m.envMapIntensity = base * envI * boost;
    }
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
        // Handed in at construction so the material compiles with USE_ENVMAP
        // already set and never needs a mid-game recompile. See EnvProbe.js.
        envMap: this.probe?.texture ?? null,
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
    mat.userData.envBase = s.env ?? 1.0;
    if (s.scroll) mat.userData.scrollSpeed = s.scroll;
    if (s.nightEmissive) mat.userData.nightEmissive = s.nightEmissive;
    // Rain hook — Assets.setWetness() lerps toward the targets stamped here.
    if (s.wet) {
      mat.userData.wetnessRough = mat.roughness;
      mat.userData.wetnessColor = mat.color.clone();
      this._stampWetness(mat);
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
    m.userData.envBase = m.envMapIntensity;
    m.envMap = this.probe?.texture ?? null;
    this._stampWetness(m);
    this._mats.set('road_atlas', m);
    this._atlas = null;                        // free the 4 MB float composite
  }

  /**
   * Repaint and re-upload the road atlas with `ASPHALT_ABLATE` flags applied.
   *
   * The carriageway's look is half shader and half baked pixels, and only the
   * shader half was switchable — so a motif painted into `paintAsphalt` was
   * invisible to `setDetail` and `setCrack` and got blamed on a shader term
   * three critic passes in a row. This is the missing half of the bisection:
   * `setAtlas(0, 1)` says "it is in the albedo texture", and this says WHICH
   * painted motif it is.
   *
   * Debug/authoring only — it costs a repaint of all four tiles (~200 ms) and
   * is never called by the running game. Pass `null` to restore the shipped
   * textures without a repaint.
   *
   * @param {object|null} flags e.g. `{ snake: 0 }`, or null to restore.
   */
  rebuildRoadAtlas(flags) {
    const m = this._mats.get('road_atlas');
    if (!m || !this.factory) return null;
    // Keep the shipped pair alive so restoring is exact and free. They are
    // owned by ctx.assets; only the debug bakes below are ours to dispose.
    this._roadAtlas0 = this._roadAtlas0 || { map: m.map, nrm: m.normalMap };
    const drop = () => {
      if (!this._roadAtlasDbg) return;
      this._roadAtlasDbg.map.dispose(); this._roadAtlasDbg.nrm.dispose();
      this._roadAtlasDbg = null;
    };
    if (!flags) {
      m.map = this._roadAtlas0.map; m.normalMap = this._roadAtlas0.nrm;
      m.needsUpdate = true; drop();
      for (const k of Object.keys(ASPHALT_ABLATE)) ASPHALT_ABLATE[k] = 1;
      return { restored: true };
    }
    Object.assign(ASPHALT_ABLATE, flags);
    const t0 = performance.now();
    const A = this.factory.newAtlas(1024);
    for (const [name, slot] of Object.entries(ATLAS_TILES)) {
      // build() bakes three textures we do not want here; take the painted
      // Surface and dispose the rest rather than leaking ~3 MB per call.
      const baked = this.factory.build(name, RECIPES[name]);
      baked.map?.dispose(); baked.normalMap?.dispose(); baked.ormMap?.dispose();
      this.factory.blitTile(A, this.factory.lastSurface, slot[0], slot[1],
        this.factory.lastRelief / ATLAS_REF_K);
    }
    const tex = this.factory.bakeAtlas(A, ATLAS_REF_K);
    tex.map.anisotropy = 8; tex.nrm.anisotropy = 4;
    drop();
    this._roadAtlasDbg = { map: tex.map, nrm: tex.nrm };
    m.map = tex.map; m.normalMap = tex.nrm; m.needsUpdate = true;
    return { ms: +(performance.now() - t0).toFixed(1), ablate: { ...ASPHALT_ABLATE } };
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
      envMap: this.probe?.texture ?? null,
    }));
    m.userData.tileMeters = 0.35;
    m.userData.envBase = 1.25;
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
   * Runs after `Sky.lateUpdate` (see `static deps`) so the probe, not the
   * sky-only PMREM, is what `scene.environment` holds when the composer renders.
   */
  lateUpdate(dt, ctx) {
    if (!this.probe) return;
    this.probe.update(dt, ctx);
    if (this.probe.texture) ctx.scene.environment = this.probe.texture;
    this._applyEnv(ctx);
    // Materials keep arriving after boot (vehicles, missions, streamed props).
    // Sweeping the registry is a walk over ~40 entries; twice a second is free
    // and means nothing is ever left on the stale sky-only environment.
    this._adoptTimer += dt;
    if (this._booted && this._adoptTimer > 0.5) {
      this._adoptTimer = 0;
      if (ctx.assets.materials.size !== this._adoptSeen) {
        this._adoptSeen = ctx.assets.materials.size;
        this.adopt(ctx);
      }
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
    this.probe?.dispose();
    this.probe = null;
    this.factory?.release();
  }
}

export { SPEC as MATERIAL_SPEC };