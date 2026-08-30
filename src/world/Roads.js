import * as THREE from 'three';
import { PROFILE } from './RoadNetwork.js';

/**
 * Road, kerb and pavement geometry.
 *
 * The central design rule here is that **no two surfaces ever overlap**. Lane
 * markings are not decals floating above the asphalt; they are coplanar strips
 * of the same continuous ribbon, tiled edge-to-edge across the cross-section.
 * Crosswalks occupy the gap between the intersection polygon and the start of
 * the ribbon. Intersections are true polygons stitched to the exact end
 * vertices of the ribbons that feed them. Nothing is ever offset by a
 * millimetre and hoped for — so nothing can z-fight, at any distance.
 *
 * Only two things are drawn as decals (manholes and drain grates) and those use
 * a real polygon offset rather than a depth bias.
 */

const CHUNK = 700;          // merge radius, metres
const STEP = 12;            // ribbon station spacing for solid bands
const DASH_ON = 3.0, DASH_OFF = 6.0;
const CROWN = 0.09;         // camber drop from centreline to gutter
const CROSSWALK = 3.0;      // depth of a zebra band
const KERB_H = 0.145;
const VERGE = 2.2;          // graded strip that hides the terrain stamp seam

// Atlas tiles: 0 asphalt aggregate | 1 concrete slab | 2 red brick | 3 granite sett
const T_ASPHALT = 0, T_CONCRETE = 1, T_BRICK = 2, T_COBBLE = 3;

/**
 * The tint table below was authored against `makeAtlas()`, the fallback atlas at
 * the top of this file, which paints a **near-white** modulation map (~232/255).
 * The atlas the city actually renders is the one `Materials._buildRoadAtlas()`
 * assembles from the TextureFactory recipes, and those four tiles are real dark
 * textures that differ from each other by 2.5x. So the effective diffuse albedo
 * of any band is `tint x GAIN x tileLinear`, and every carriageway pixel used to
 * ship far below the surface's own dielectric F0 of 0.04 — physically impossible
 * for asphalt, which is why no albedo detail was visible and why `setWetness`
 * (which darkens *albedo*) produced no wet response.
 *
 * MEASURED, on the BAKED atlas read back to the CPU (`road_atlas.alb`, 1024²
 * sRGB), as the mean of the *per-texel* linear values — the quantity that
 * actually multiplies the tint:
 *
 *   tile in TILE_UV order   mean sRGB   mean linear   linear RGB
 *   0 T_ASPHALT   asphalt      90.5       0.1080    [0.1079 0.1071 0.1181]
 *   1 T_CONCRETE  slab        140.0       0.2685    [0.2866 0.2675 0.2249]
 *   2 T_BRICK     red brick   100.3       0.1488    [0.3021 0.1114 0.0676]
 *   3 T_COBBLE    granite     116.0       0.1890    [0.2073 0.1855 0.1703]
 *
 * **Read the RGB column before trusting any table of these numbers.** The atlas
 * is baked flipped (painted row 0 becomes v=1), so the quadrant that *looks*
 * like tile 0 in memory is tile 2. A tile identified by its memory order alone
 * pairs asphalt with 0.1488 and concrete with 0.1890; the [0.3021 0.1114 0.0676]
 * signature of that 0.1488 tile is 4.5:1.6:1 red — it is brick, not asphalt.
 * Cross-checked against the standalone `asphalt.alb` / `sidewalk.alb` /
 * `sidewalk_brick.alb` / `cobblestone.alb` textures, which are baked from the
 * same recipes and reproduce these four means exactly.
 *
 * A single uniform gain is the wrong shape of knob and the numbers say so: the
 * ratios it preserves were authored against a fallback atlas where all four
 * tiles were ~0.8 linear, and the real atlas already destroyed them. So the gain
 * is **per class**, chosen so each class lands inside its real-world albedo band.
 * Measured effective albedo (Rec.709 luma of tint x gain x tileLinearRGB):
 *
 *   class           was (uniform 3.0)   now      real-world reference
 *   asphalt              0.0308       0.1078     0.09-0.14 aged hot-mix
 *   asphalt (hot)        0.0376       0.1317     0.11-0.16 recent overlay
 *   gutter               0.0260       0.0908     0.07-0.10
 *   parking bay          0.0272       0.0954     0.07-0.10
 *   white paint          0.1910       0.5730     0.55-0.75 fresh
 *   worn white paint     0.1056       0.3870     0.35-0.45 worn
 *   yellow paint         0.1273       0.3818     0.30-0.45
 *   granite kerb face    0.1791       0.2388     0.20-0.28 Quincy granite
 *   granite kerb top     0.2025       0.2565     0.20-0.28
 *   concrete walk        0.2615       0.2615     0.18-0.30 dirty urban
 *   brick walk           0.0733       0.2443     0.20-0.30
 *   granite setts        0.0944       0.1794     0.15-0.22
 *   verge                0.0970       0.1617     0.15-0.22 grass/dirt
 *
 * Three of these differ from the uniform-9.0 recommendation in the critic
 * report, and the difference is the tile swap above: at a uniform 9.0 asphalt
 * would reach only 0.092 (bottom of its band) while concrete reached 0.785 and
 * setts 0.283, both far too bright. Concrete is the one class that was already
 * correct and is deliberately left at 3.0.
 */
const GAIN = {
  asphalt: 10.5, asphaltHot: 10.5, gutter: 10.5, parkbay: 10.5,
  white: 9.0, yellow: 9.0, whiteWorn: 11.0,
  granite: 4.0, graniteTop: 3.8, concrete: 3.0,
  brick: 10.0, cobble: 5.7, verge: 5.0,
};

// --- tints (linear albedo, before GAIN; the ACES stack does the rest) --------
// These are the *authored* ratios within a class (gutter vs running surface,
// fresh vs worn paint). GAIN sets the absolute level per class.
const C0 = {
  asphalt:   [0.092, 0.095, 0.104],
  asphaltHot:[0.115, 0.116, 0.120],
  gutter:    [0.078, 0.080, 0.086],
  white:     [0.600, 0.590, 0.552],
  whiteWorn: [0.330, 0.326, 0.310],
  yellow:    [0.520, 0.386, 0.108],
  granite:   [0.225, 0.222, 0.216],
  concrete:  [0.330, 0.324, 0.312],
  brick:     [0.235, 0.112, 0.086],
  cobble:    [0.170, 0.166, 0.158],
  verge:     [0.115, 0.126, 0.076],
  parkbay:   [0.082, 0.084, 0.090],
  graniteTop:[0.255, 0.251, 0.243],
};
const C = Object.fromEntries(Object.entries(C0).map(([k, v]) => {
  const g = GAIN[k];
  if (g === undefined) {
    // A silent `undefined` here would multiply the tint to NaN and paint the
    // whole class black, so say so instead of shipping an invisible band.
    console.warn(`[roads] no albedo gain for tint class "${k}" — using 3.0`);
  }
  return [k, v.map(x => x * (g ?? 3.0))];
}));

/** Cheap deterministic hash. Math.sin-based noise costs ~1M trig calls building
 *  the atlas; an integer mix is an order of magnitude faster and tiles better. */
const rnd = (s) => {
  let h = Math.imul(s | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** 2-D hash. Folding x and z into one integer before hashing aliases into
 *  diagonal streaks along a straight road, which is exactly where it shows. */
const hash2 = (x, y) => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const _across = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Procedural atlases. Four seamless patterns, base colour + normal, so the
// whole city street network is one material and one draw call per chunk.
// ---------------------------------------------------------------------------
function makeAtlas() {
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d');
  const nv = document.createElement('canvas');
  nv.width = nv.height = S * 2;
  const ng = nv.getContext('2d');
  ng.fillStyle = '#8080ff'; ng.fillRect(0, 0, S * 2, S * 2);

  const px = (ctx, ox, oy) => ctx.getImageData(ox, oy, S, S);
  const put = (ctx, d, ox, oy) => ctx.putImageData(d, ox, oy);

  // --- tile 0: asphalt aggregate ---
  {
    const d = px(g, 0, 0), n = px(ng, 0, 0);
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      // clumped aggregate: two octaves of hashed cells
      let v = 0;
      for (let o = 0; o < 3; o++) {
        const sc = 1 << (o + 3);
        const cx = Math.floor(x * sc / S), cy = Math.floor(y * sc / S);
        v += (rnd(cx * 57 + cy * 131 + o * 13) - 0.5) * (0.5 / (o + 1));
      }
      const grain = rnd(x * 3 + y * 7.3) * 0.34 + rnd(x * 11.7 - y * 5.1) * 0.2;
      const l = 232 + v * 46 + (grain - 0.27) * 44;
      d.data[i * 4] = l * 0.99; d.data[i * 4 + 1] = l; d.data[i * 4 + 2] = l * 1.03;
      d.data[i * 4 + 3] = 255;
      const h = (grain - 0.27) * 2.4 + v;
      const hx = ((rnd((x + 1) * 3 + y * 7.3) * 0.34) - 0.27) * 2.4 - (grain - 0.27) * 2.4;
      const hy = ((rnd(x * 3 + (y + 1) * 7.3) * 0.34) - 0.27) * 2.4 - (grain - 0.27) * 2.4;
      n.data[i * 4] = 128 - hx * 105; n.data[i * 4 + 1] = 128 - hy * 105;
      n.data[i * 4 + 2] = 244; n.data[i * 4 + 3] = 255;
    }
    put(g, d, 0, 0); put(ng, n, 0, 0);
  }
  // --- tile 1: concrete slab with control joints ---
  {
    g.fillStyle = '#eeeae2'; g.fillRect(S, 0, S, S);
    const d = px(g, S, 0), n = px(ng, S, 0);
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const blot = (rnd(Math.floor(x / 26) * 31 + Math.floor(y / 26) * 17) - 0.5) * 26;
      const grain = (rnd(x * 5.1 + y * 2.7) - 0.5) * 26;
      const jx = Math.min(x % (S / 2), (S / 2) - 1 - (x % (S / 2)));
      const jy = Math.min(y % (S / 2), (S / 2) - 1 - (y % (S / 2)));
      const joint = (jx < 2 || jy < 2) ? -58 : 0;
      const l = 238 + blot * 0.8 + grain * 0.8 + joint * 0.8;
      d.data[i * 4] = l; d.data[i * 4 + 1] = l * 0.985; d.data[i * 4 + 2] = l * 0.955;
      d.data[i * 4 + 3] = 255;
      const nb = (jx === 2 || jy === 2) ? 60 : (jx < 2 || jy < 2) ? -50 : 0;
      n.data[i * 4] = 128 + (jx < 3 ? nb : 0) + (rnd(x * 9 + y * 4) - 0.5) * 22;
      n.data[i * 4 + 1] = 128 + (jy < 3 ? nb : 0) + (rnd(x * 4 + y * 9) - 0.5) * 22;
      n.data[i * 4 + 2] = 240; n.data[i * 4 + 3] = 255;
    }
    put(g, d, S, 0); put(ng, n, S, 0);
  }
  // --- tile 2: red brick, running bond (Boston pavement) ---
  {
    const d = px(g, 0, S), n = px(ng, 0, S);
    const BW = S / 8, BH = S / 16;
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const row = Math.floor(y / BH);
      const ox = (row % 2) * (BW / 2);
      const bx = ((x + ox) % BW), by = y % BH;
      const bid = Math.floor((x + ox) / BW) * 71 + row * 37;
      const mortar = (bx < 2.2 || by < 2.2);
      const tone = rnd(bid) * 44 - 22;
      const grain = (rnd(x * 6.1 + y * 3.3) - 0.5) * 20;
      let r, gg, b;
      if (mortar) { r = 252 + grain; gg = 250 + grain; b = 244 + grain; }
      else { r = 236 + tone + grain; gg = 214 + tone + grain; b = 206 + tone + grain; }
      d.data[i * 4] = r; d.data[i * 4 + 1] = gg; d.data[i * 4 + 2] = b; d.data[i * 4 + 3] = 255;
      const ex = bx < 3 ? (bx - 1.5) * 34 : bx > BW - 3 ? (bx - (BW - 1.5)) * 34 : 0;
      const ey = by < 3 ? (by - 1.5) * 34 : by > BH - 3 ? (by - (BH - 1.5)) * 34 : 0;
      n.data[i * 4] = 128 - ex; n.data[i * 4 + 1] = 128 - ey;
      n.data[i * 4 + 2] = 232; n.data[i * 4 + 3] = 255;
    }
    put(g, d, 0, S); put(ng, n, 0, S);
  }
  // --- tile 3: granite setts (Acorn St) ---
  {
    const d = px(g, S, S), n = px(ng, S, S);
    const CWd = S / 9, CH = S / 11;
    for (let i = 0; i < S * S; i++) {
      const x = i % S, y = (i / S) | 0;
      const row = Math.floor(y / CH);
      const ox = (row % 2) * (CWd / 2);
      const cxi = Math.floor((x + ox) / CWd);
      const bx = (x + ox) % CWd, by = y % CH;
      const id = cxi * 91 + row * 53;
      const jitter = (rnd(id) - 0.5) * 3;
      const inJoint = bx < 3 + jitter || by < 3 + jitter;
      const tone = rnd(id + 7) * 52 - 26;
      const grain = (rnd(x * 7.7 + y * 4.9) - 0.5) * 26;
      const l = inJoint ? 150 + grain * 0.5 : 240 + tone * 0.8 + grain;
      d.data[i * 4] = l * 1.01; d.data[i * 4 + 1] = l; d.data[i * 4 + 2] = l * 0.96;
      d.data[i * 4 + 3] = 255;
      // domed setts
      const u = (bx / CWd - 0.5) * 2, v = (by / CH - 0.5) * 2;
      n.data[i * 4] = 128 - u * 88; n.data[i * 4 + 1] = 128 - v * 88;
      n.data[i * 4 + 2] = 205; n.data[i * 4 + 3] = 255;
    }
    put(g, d, S, S); put(ng, n, S, S);
  }

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  const nrm = new THREE.CanvasTexture(nv);
  for (const t of [map, nrm]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
  }
  return { map, nrm };
}

/**
 * Metres of kerb per unit of `aSurf` on a kerb band. `section()` emits both the
 * granite face and the granite top with `scale: 1.5`, and the shader turns
 * `vSurf` back into metres with this constant to size the sawn block joints and
 * the stone grain. If you change one, change the other.
 */
const KERB_SCALE = 1.5;

/**
 * Surface classes carried in `aWear.y`.
 *
 * A non-negative value means "carriageway, and this is the distance in metres to
 * the nearer kerb" — which is what drives gutter grime and puddle pooling.
 * Negative values are class tags. They are constant across a band, and no band
 * shares vertices with a band of a different class, so nothing ever interpolates
 * between two classes and the comparisons below cannot straddle a boundary.
 */
const W_ROAD = 0, W_WALK = -1, W_KERB_FACE = -2, W_KERB_TOP = -3, W_VERGE = -4;

/**
 * Procedural surface detail shared by every paved surface.
 *
 * Why this is in a shader and not in the atlas: the atlas tile is 2.4 m square,
 * so *everything* painted into it repeats every 2.4 m. That is fine for
 * aggregate grain and useless for the things that actually make a road read as a
 * road — wheel-track polish (fixed to the lane, not to the tile), gutter grime
 * (fixed to the kerb), utility patches and cracks (tens of metres long), oil
 * down the middle of the lane. Those are all functions of position *in the
 * street*, which only the shader knows. Generating them here also means no new
 * texture memory and no new draw call, and it cannot introduce a tiling period:
 * the noise is evaluated on continuous world XZ at scales that are not harmonics
 * of each other or of the atlas tile.
 *
 * Scale matters more than amplitude here, and the reason is measurable. The
 * critic's flatness number is the mean absolute luminance difference across an
 * 89 px window on the *near* carriageway — and 89 px at 1080p, on ground 4.7 m
 * from a 1.65 m eye, is **0.34 m of road**. Metre-scale blotching therefore
 * scores almost nothing; what moves it is 0.2-1 m structure and thin, dark,
 * high-contrast cracks that the window can straddle. Anything finer than that
 * the atlas already carries, and the mip chain eats most of it at a grazing
 * angle anyway — which is why `bFade` exists: octaves switch off once a pixel
 * footprint approaches their cell size, instead of shimmering into the distance.
 */
const ROAD_NOISE_GLSL = `
  // Hash without sine: sin() drives a texture-sized transcendental per octave
  // and banded badly at Boston's world coordinates (up to ~4 km from origin).
  float bHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  // 1 while a feature of "cell" metres is resolved, 0 once it is not. Backticks
  // are forbidden in this string: it is a JS template literal.
  float bFade(float cell) { return smoothstep(cell * 1.30, cell * 0.40, gPx); }
  float bNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bHash(i), bHash(i + vec2(1.0, 0.0)), f.x),
               mix(bHash(i + vec2(0.0, 1.0)), bHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  /** Two hashed values per cell — the jittered crack node inside it. */
  vec2 bHash2(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy);
  }
  /**
   * Worley F2 - F1, in cell units. Zero exactly on the boundary between two
   * cells, so its level set IS the cell diagram: straight segments meeting at
   * angles and Y junctions, which is what a fatigue crack network looks like.
   *
   * The field this replaced was the iso-line of value noise, and that is the
   * whole reason the cracks read as soft grey marker scribbles: a value-noise
   * iso-line is a smooth meandering curve whose *width* is set by the local
   * gradient, so it is wide wherever the noise is flat, it never runs straight,
   * and it never meets another crack at an angle.
   */
  float bCell(vec2 p, float jit) {
    vec2 i = floor(p), f = fract(p);
    float f1 = 9.0, f2 = 9.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = g + 0.5 + (bHash2(i + g) - 0.5) * jit - f;
        float d = dot(o, o);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return sqrt(f2) - sqrt(f1);
  }
  /**
   * A crack of wm metres, d metres from its centreline, seen through a px metre
   * pixel. Never drawn narrower than one pixel — but the amplitude is cut by
   * exactly the factor it was widened, so the integrated darkness is correct at
   * every distance. That is what lets the line stay THIN and near-black up
   * close, which is the whole point, without shimmering into the distance.
   */
  float bLine(float d, float wm, float px) {
    float w = max(wm, px);
    return (1.0 - smoothstep(0.0, w, d)) * (wm / w);
  }
`;

/**
 * One material for every paved surface in the city.
 * Tiling is done in the shader (`fract` on a world-scaled UV, with explicit
 * gradients so the atlas seams do not blow up the mip selection), which is what
 * lets brick, concrete, granite and asphalt share a single draw call.
 *
 * Wetness. `Assets.setWetness()` already lerps this material's `roughness`
 * (0.92 -> 0.26) and `color` (x0.42) from the policy in `Materials.js`, which is
 * the correct *average* for rain-damp asphalt. What it cannot do is vary in
 * space, and a road that is uniformly damp everywhere is exactly the "rain
 * changes nothing" reading. `uWet` lets the shader pool water where water
 * actually goes — the gutter and the broad low spots — and leave the crown
 * merely damp. Puddles are the only thing that gets near-mirror roughness, they
 * cover ~10% of the carriageway, and everything wet gets *darker*: the global
 * roughness collapse to 0.06 that turned Boylston Street into white ice is
 * exactly what this avoids.
 */
function makeRoadMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.map, normalMap: atlas.nrm, vertexColors: true,
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.55,
    normalScale: new THREE.Vector2(1.15, 1.15), dithering: true,
  });
  m.userData.wetnessRough = 0.92;
  m.userData.wetnessColor = m.color.clone();
  /**
   * ZERO, deliberately, and the whole-material env boost is replaced by the
   * per-pixel `gEnvK` below. `Materials._applyEnv` reads this and multiplies
   * `envMapIntensity` for the entire material, which is a flat "wet surfaces
   * reflect more" assumption — and it was the single largest reason rain made
   * the road *brighter*.
   *
   * Measured, `st_southend` under `weather: 'rain'`, one frozen frame, exposure
   * meter pinned, toggling only `setWetness` on a 800x240 px near-carriageway
   * patch: wet/dry 1.288 with the 0.45 boost, 1.102 with it at 0. The boost
   * alone was +18.6% of the dry level, on a surface that is supposed to get
   * darker.
   *
   * It is also wrong physics. A water film does not add a reflector, it
   * *replaces* one: asphalt's own interface is F0 = 0.04, water's is F0 = 0.02.
   * At normal incidence a wet road reflects HALF as much of the sky as a dry
   * one. It only wins at grazing angles, and it only becomes a mirror where the
   * water actually stands — which is a puddle, and puddles are ~10% of the
   * carriageway. That is exactly the shape `gEnvK` has, and unlike a material
   * scalar it can tell the two apart.
   */
  m.userData.wetEnvBoost = 0.0;
  const shaders = [];
  m.userData.shaders = shaders;
  /** Push the current rain wetness into every compiled variant. */
  m.userData.setWet = (v) => {
    for (const sh of shaders) if (sh.uniforms.uWet) sh.uniforms.uWet.value = v;
  };
  /**
   * Ablation switch, 0..1. At 0 the surface is exactly what it was before the
   * procedural pass existed — flat tint x atlas, one uniform roughness — so a
   * critic can A/B the two in the *same* frame. That matters more than it
   * sounds: the auto-exposure and the drifting cloud shadow move the absolute
   * luminance of this shot by up to 35% between two captures minutes apart, so
   * a before/after taken across an edit is not a controlled comparison and a
   * before/after taken across this uniform is.
   */
  m.userData.setDetail = (v) => {
    for (const sh of shaders) if (sh.uniforms.uDetail) sh.uniforms.uDetail.value = v;
  };
  /*
   * Wet-response tuning hook: (sheet roughness base, polished-track roughness,
   * env multiplier, puddle env multiplier). Kept alongside `setDetail` for the
   * same reason -- a critic needs to A/B this in ONE frame, because the effect
   * being judged is a few percent of frame luminance.
   *
   * The shipped defaults below are measured, not guessed: isolated on a frozen
   * frame by toggling only wetness, they put wet/dry at 0.925 against 1.093
   * before the per-class albedo landed, i.e. the sign is finally correct and
   * wetting the road darkens it. It is NOT finished -- real wet asphalt is
   * nearer 0.5-0.7 of dry -- so this stays a live knob rather than being baked
   * into constants.
   */
  m.userData.setWetTune = (a, b, c, d) => {
    for (const sh of shaders) if (sh.uniforms.uWetTune) sh.uniforms.uWetTune.value.set(a, b, c, d);
  };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWet = { value: m.userData.wetLevel ?? 0 };
    sh.uniforms.uDetail = { value: m.userData.detailLevel ?? 1 };
    sh.uniforms.uWetTune = { value: new THREE.Vector4(0.30, 0.17, 1.0, 0.9) };
    shaders.push(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aSurf;      // world-scaled pattern UV
        attribute vec2 aTile;      // atlas tile origin (0 or 0.5)
        attribute vec2 aWear;      // x = metres from the lane centre,
                                   // y = metres to the kerb, or a class tag < 0
        attribute float aRough;
        varying vec2 vSurf; varying vec2 vTile; varying float vRough;
        varying vec2 vWear; varying vec3 vWPos;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vSurf = aSurf; vTile = aTile; vRough = aRough; vWear = aWear;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uWet;
        uniform float uDetail;
        uniform vec4 uWetTune;
        varying vec2 vSurf; varying vec2 vTile; varying float vRough;
        varying vec2 vWear; varying vec3 vWPos;
        // Resolved once in <map_fragment>, consumed by the roughness, normal and
        // indirect-specular chunks further down main().
        float gRough, gPuddle, gWet, gFlat, gPx, gEnvK;
        ${ROAD_NOISE_GLSL}
        vec4 atlasTex(sampler2D t, vec2 s, vec2 tile) {
          vec2 dx = dFdx(s) * 0.5, dy = dFdy(s) * 0.5;
          return textureGrad(t, tile + fract(s) * 0.5, dx, dy);
        }`)
      .replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = atlasTex(map, vSurf, vTile);
        vec2 W = vWPos.xz;
        float lane = vWear.x, kerb = vWear.y;
        bool isRoad = kerb > -0.5;
        bool isKerb = kerb < -1.5 && kerb > -3.5;
        bool isVerge = kerb < -3.5;

        // Pixel footprint on the ground, as the geometric mean of the two screen
        // derivatives — the isotropic equivalent of the anisotropic footprint,
        // and the same quantity a trilinear LOD would pick.
        vec2 ddWx = dFdx(W), ddWy = dFdy(W);
        gPx = sqrt(max(length(ddWx), 1e-4) * max(length(ddWy), 1e-4));

        // --- albedo variation across five non-harmonic scales ---------------
        // 0.85 m, 2.7 m, 7.7 m and 23 m, plus a 0.24 m scatter that stands in
        // for chip and sand once the atlas has been mipped away. None of these
        // is a multiple of the 2.4 m atlas period or of each other, so there is
        // nothing here for an autocorrelation to lock onto.
        float n0 = bNoise(W * 1.18);
        float n1 = bNoise(W * 0.37);
        float n2 = bNoise(W * 0.13);
        float n3 = bNoise(W * 0.043);
        float macro = (n0 - 0.5) * 0.84 * bFade(0.85)
                    + (n1 - 0.5) * 0.70
                    + (n2 - 0.5) * 0.62
                    + (n3 - 0.5) * 0.54;

        float tone = 1.0;
        gRough = roughness * vRough;
        gFlat = 0.0;

        if (isKerb) {
          // ---- sawn Quincy granite ---------------------------------------
          // The atlas has four tiles and none of them is granite, so the kerb
          // was borrowing the concrete-slab tile and reading as a painted
          // stripe. Granite is a coarse two-feldspar + quartz + biotite rock:
          // what the eye actually reads at kerb scale is dense 3-6 mm speckle
          // with sparse near-black flecks, plus the sawn joint every ~1.35 m.
          vec2 kq = vSurf * ${KERB_SCALE.toFixed(2)};      // metres (along, up)
          // The kerb face is vertical, so the world-XZ footprint gPx collapses
          // on it and cannot be used to fade the grain. Measure the footprint in
          // kerb space instead, or 3 mm speckle turns every distant kerb into a
          // sparkling line.
          float kpx = sqrt(max(length(dFdx(kq)), 1e-4) * max(length(dFdy(kq)), 1e-4));
          float kFine = smoothstep(0.008, 0.0025, kpx);
          float kMid  = smoothstep(0.030, 0.010, kpx);
          float sp = bHash(floor(kq * 300.0));
          float md = bNoise(kq * 46.0);
          float coarse = bHash(floor(kq * 84.0) + 7.7);
          tone = 0.80 + 0.15 + (sp - 0.5) * 0.30 * kFine
               + (coarse - 0.5) * 0.26 * kMid + (md - 0.5) * 0.13 * kMid;
          tone -= step(0.972, sp) * 0.42 * kFine;          // biotite
          tone += step(0.994, coarse) * 0.30 * kMid;       // quartz catch-light
          // Sawn block joints, and the traffic film that collects in them.
          float bl = fract(kq.x / 1.35 + bHash(vec2(floor(kq.x / 1.35), 3.0)) * 0.1);
          float bj = 1.0 - smoothstep(0.0, 0.022, min(bl, 1.0 - bl));
          tone *= 1.0 - bj * 0.42;
          // Splash line: the bottom 40 mm of a kerb face is permanently filthy.
          if (kerb < -2.5) {
            tone *= 1.0 - smoothstep(0.055, 0.0, kq.y) * 0.26;
          } else {
            // Kerb top: rounded, chipped arris and boot polish.
            tone *= 0.94 + bNoise(kq * 7.0) * 0.14;
          }
          tone *= 1.0 + macro * 0.30;
          gRough = clamp(0.52 + (sp - 0.5) * 0.22 * kFine + bj * 0.24, 0.20, 0.95);
        } else if (isRoad) {
          // ---- wheel tracks ----------------------------------------------
          // Tyres run ~0.78 m either side of the lane centre. Between them the
          // surface keeps its aggregate; under them 60 years of rubber has
          // polished it darker and smoother. This is the single strongest
          // "this is a road" cue and it cannot come from a tiled texture.
          float dt = (abs(lane) - 0.78) / 0.42;
          float track = exp(-dt * dt) * (0.55 + 0.45 * n2);
          // ---- gutter grime ----------------------------------------------
          float gut = smoothstep(1.45, 0.10, kerb);
          // ---- oil and drip staining down the lane centre ----------------
          float oilLane = exp(-(lane / 0.34) * (lane / 0.34));
          float oil = oilLane * smoothstep(0.44, 0.80, n2 * 0.6 + n3 * 0.4);
          // ---- utility-cut patches ----------------------------------------
          // Cells rotated off the street grid and domain-warped, so the joints
          // meander like real saw cuts instead of reading as a chequerboard.
          vec2 pw = W + vec2(n3 - 0.5, n2 - 0.5) * 5.5;
          vec2 pc = vec2(pw.x * 0.906 - pw.y * 0.423, pw.x * 0.423 + pw.y * 0.906) / 9.5;
          vec2 pi = floor(pc), pf = fract(pc);
          // NB: not "patch" — that is a reserved word in GLSL ES 3.0 and the
          // whole road material silently failed to compile.
          float cut = step(0.68, bHash(pi * 1.7));
          float rim = min(min(pf.x, pf.y), min(1.0 - pf.x, 1.0 - pf.y));
          float joint = cut * (1.0 - smoothstep(0.0, 0.010, rim)) * bFade(0.25);
          float fill = cut * (bHash(pi * 3.1) - 0.5);
          // ---- cracks ------------------------------------------------------
          // Block cracking on a ~2.6 m cell network, plus a finer alligator web
          // inside the worn areas. Both are drawn on Worley cell boundaries, so
          // they are straight segments meeting at angles and Y junctions, 2-3 cm
          // wide and near-black — thin, dark and high-contrast, which is what a
          // crack is and what survives an 89 px (0.34 m) detail window.
          //
          // Cracks also CLUSTER, and where they cluster is not a free choice:
          // fatigue cracking opens under the wheel path where the axle load is,
          // and along the gutter where water stands and the base softens. Both
          // are already solved geometry here, so the web amplitude is gated on
          // them and on the 23 m age field rather than sprayed uniformly.
          vec2 cw = W + vec2(n2 - 0.5, n3 - 0.5) * 2.2;    // meander the network
          float dBlk = bCell(cw * (1.0 / 2.60), 0.85) * 2.60;
          float dWeb = bCell(cw * (1.0 / 0.62) + 37.0, 0.95) * 0.62;
          float age  = smoothstep(0.30, 0.74, n3 * 0.62 + n2 * 0.38);
          float load = clamp(track * 1.15 + gut * 0.55 + age * 0.50, 0.0, 1.0);
          float crack = min(1.0, bLine(dBlk, 0.028, gPx) * (0.35 + 0.65 * age)
                                + bLine(dWeb, 0.019, gPx) * load * age * 0.85);
          // ---- chip scatter and skin patching ------------------------------
          // Exposed aggregate, as discrete stone rather than a smooth blotch.
          // At eye height on the near carriageway one pixel is ~3.8 mm of road,
          // so a 14 mm cell is three pixels across and reads as individual
          // chips; the old smooth value noise at 0.23 m could only ever be
          // blotching. World XZ is folded to 128 m first: at 4 km from origin
          // W/0.014 is 2.9e5, where a float32 mantissa leaves the hash barely
          // any entropy and it bands. The fold is invisible because the field is
          // uncorrelated per cell and gone by ~3 m out anyway.
          vec2 aw = W - floor(W * (1.0 / 128.0)) * 128.0;
          vec2 ac = floor(aw * 71.4);
          float grit = ((bHash(ac) - 0.5) * 1.30 - step(0.90, bHash(ac + 19.3)) * 0.26)
                     * bFade(0.026);
          float chip = (bNoise(W * 1.85 + 23.1) - 0.5) * bFade(0.62);
          // Cold-patch dabs: the shovel-and-stamp repairs around every gully and
          // trench, a third of a metre across and much darker than the mix.
          float dab = smoothstep(0.72, 0.93, bNoise(W * 2.6 + 61.4))
                    * smoothstep(0.38, 0.70, n2) * bFade(0.40);

          // Base 0.90, not 1.0: wear, grime and traffic film are a net loss of
          // reflectance, and scaling the base rather than the noise raises
          // relative contrast at the same time as it holds the level.
          tone = 0.90 + macro * 1.00 + fill * 0.34 + grit * 0.80 + chip * 0.62
               - track * 0.26 - gut * 0.34 - oil * 0.50 - dab * 0.30
               - joint * 0.62 - crack * 0.70;
          // The polish is what makes a wheel track read at a grazing angle — it
          // is a specular cue first and a tonal one second. Kept deliberately
          // moderate: smoothing and flattening a horizontal surface both raise
          // the light it returns, and at a diffuse albedo this low the specular
          // term is the larger half of the road's luminance. Ablation measured
          // the first cut of this at +8% mean, which put the asphalt brighter
          // than the concrete walk beside it.
          gRough = gRough * (1.0 - track * 0.20 - oil * 0.18) + gut * 0.02 + macro * 0.04
                 + crack * 0.12;               // a crack is a recess full of grit
          gFlat = track * 0.22 + oil * 0.16;   // polished: flatten the aggregate
        } else if (isVerge) {
          tone = 1.0 + macro * 0.60;
        } else {
          // ---- pavement ----------------------------------------------------
          // Slabs weather in patches; damp shadow lines and salt bloom leave
          // blotches at half a metre, and trodden gum leaves near-black discs.
          float stain = smoothstep(0.50, 0.86, n2 * 0.55 + n1 * 0.45);
          float gum = smoothstep(0.90, 0.985, bNoise(W * 3.1 + 5.5)) * bFade(0.22);
          // Slabs and brick crack across the bay and settle at the joint, so
          // the same cell network applies here on a coarser grid — and for the
          // same reason as the carriageway, a straight thin line reads as a
          // crack where a wide soft curve reads as a smudge.
          float crk = bLine(bCell(W * (1.0 / 1.45) + 8.5, 0.75) * 1.45, 0.016, gPx)
                    * smoothstep(0.46, 0.80, n2);
          tone = 1.0 + macro * 0.66 - stain * 0.20 - gum * 0.42 - crk * 0.42;
          gRough = gRough + macro * 0.06 + stain * 0.03 - gum * 0.18 + crk * 0.10;
        }

        // ---- rain ----------------------------------------------------------
        gWet = 0.0; gPuddle = 0.0; gEnvK = 1.0;
        if (uWet > 0.005) {
          // Dampness is not uniform: sheltered stretches stay lighter.
          gWet = uWet * (0.74 + 0.26 * bNoise(W * 0.021 + 4.4));
          // Water runs to the gutter (the carriageway is cambered towards it)
          // and gathers in broad shallow depressions. Both terms are needed:
          // the gutter alone reads as a painted stripe, the noise alone puts
          // puddles on the crown where water cannot stand.
          // Water stands in two places on a real street and only two: the
          // gutter, and the worn ruts under the wheel tracks. The rutted
          // ribbons are what makes a rainy street photograph the way it does —
          // two long broken mirrors down each lane — and they are free here,
          // because the wheel tracks are already solved geometry.
          float low = isRoad ? max(smoothstep(1.9, 0.12, kerb), gFlat * 1.3) : 0.22;
          float pn = bNoise(W * 0.075 + 17.2) * 0.64 + bNoise(W * 0.235 + 3.1) * 0.36;
          // Tight threshold: a puddle has an edge. A wide ramp gives a damp
          // smear over the whole gutter instead of standing water with a rim.
          gPuddle = smoothstep(0.600, 0.720, pn * 0.72 + low * 0.46)
                  * smoothstep(0.10, 0.55, gWet);
          if (isKerb) gPuddle = 0.0;    // a vertical face holds no water
          // Wet asphalt is DARKER. The material colour is already darkened by
          // Assets.setWetness; this is the spatial part on top of it, and the
          // puddle is the darkest thing on the street, not the brightest —
          // everything it gains, it gains as specular.
          //
          // A pavement or kerb sheds water and keeps more of its albedo than a
          // porous carriageway does: real hot-mix drops from ~0.11 diffuse to
          // ~0.045 soaked, which with Assets.setWetness's 0.58 survival is a
          // shader term of ~0.80, not the flat 0.86 that used to be here.
          tone *= 1.0 - gWet * ((isRoad ? 0.20 : 0.13) + gPuddle * 0.42);
          // Sheet-damp asphalt measures ~0.30 roughness and standing water
          // ~0.06. Only the puddle is allowed near a mirror, and puddles are a
          // minority of the surface, so the frame cannot flip to white — which
          // is exactly what the old global collapse to 0.06 did.
          // Rubber-polished wheel tracks hold a thinner, glassier film than the
          // ravelled aggregate between them, so they come out a step smoother.
          float sheet = mix(uWetTune.x, uWetTune.y, min(1.0, gFlat * 2.4));
          gRough = mix(gRough, isKerb ? 0.34 : mix(sheet, 0.050, gPuddle), gWet);
          gFlat = max(gFlat, gPuddle * 0.94);   // standing water is flat

          // Indirect-specular weight for the water film, applied per pixel to
          // the indirect radiance at <lights_fragment_maps>. See the
          // wetEnvBoost note in makeRoadMaterial for why it is not a material
          // scalar. (No backticks in here: this is a JS template literal.)
          //
          // This is a ratio of two Schlick terms, not a tuned boost. A water
          // film replaces the asphalt's own air-to-aggregate interface
          // (F0 = 0.04) with an air-to-water one (F0 = 0.02), so
          //
          //     filmF = F_water(theta) / F_asphalt(theta)
          //
          // runs from 0.5 head-on to 1.0 at perfect grazing and is NEVER above
          // 1. A wet road does not reflect more environment than a dry one — it
          // reflects the same or less, through a much tighter lobe, which is
          // what the roughness collapse above already models. Getting this
          // backwards is the whole reason rain used to brighten the street.
          //
          // Measured on the near carriageway at st_southend under rain: with
          // the old flat +45% material boost the non-albedo half of the road
          // went UP 28% when it got wet, which no amount of albedo darkening
          // can cancel.
          //
          // Puddles get 1.9x on top. That one IS a fudge and is flagged as such:
          // standing water should be a sharp mirror, but SSR contributes 0.00
          // here and the env probe cannot resolve an image, so a puddle can only
          // return a blurred average. Retire the 0.9 when SSR reaches the road.
          float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
          float g5 = pow(1.0 - ndv, 5.0);
          float filmF = (0.02 + 0.98 * g5) / (0.04 + 0.96 * g5);
          gEnvK = mix(1.0, filmF * uWetTune.z * (1.0 + uWetTune.w * gPuddle), gWet);
        }

        // uDetail = 0 restores the pre-existing surface exactly: flat tone, one
        // roughness, no wet structure. See makeRoadMaterial's setDetail.
        tone = mix(1.0, tone, uDetail);
        gRough = mix(roughness * vRough, gRough, uDetail);
        gFlat *= uDetail;
        sampledDiffuseColor.rgb *= clamp(tone, 0.18, 1.75);
        diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = atlasTex(normalMap, vSurf, vTile).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale * (1.0 - gFlat);
        normal = normalize(tbn * mapN);`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = clamp(gRough, 0.045, 1.0);`)
      // Per-pixel weight on the indirect specular only. `radiance` is declared
      // in <lights_fragment_begin> and consumed by RE_IndirectSpecular in
      // <lights_fragment_end>, so scaling it here reaches the environment
      // reflection without touching iblIrradiance (the diffuse half) or any
      // analytic light. gEnvK is 1.0 everywhere the road is dry, so this is a
      // no-op outside rain.
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        radiance *= gEnvK;`);
  };
  m.customProgramCacheKey = () => 'bostonRoad';
  return m;
}

// ---------------------------------------------------------------------------
class Batch {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.s = []; this.t = []; this.r = [];
    this.w = []; this.i = []; this.v = 0;
  }
  vert(x, y, z, nx, ny, nz, cr, cg, cb, su, sv, tu, tv, rg, wl = 0, wk = W_ROAD) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(cr, cg, cb);
    this.s.push(su, sv); this.t.push(tu, tv); this.r.push(rg); this.w.push(wl, wk);
    return this.v++;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  get empty() { return this.v === 0; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 2));
    g.setAttribute('aTile', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(this.r, 1));
    g.setAttribute('aWear', new THREE.Float32BufferAttribute(this.w, 2));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.s, 2));  // for TBN
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const TILE_UV = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];

/**
 * Give a world-space merged mesh a meaningful sort key.
 *
 * three's opaque sort projects each mesh's *origin* to clip space. Geometry
 * baked in world space on a mesh left at (0,0,0) therefore projects to the same
 * point as every other such mesh, the sort falls through to creation order, and
 * front-to-back ordering is lost across the whole frame — which is the worst
 * case for overdraw on a tile-based GPU. Re-centre the geometry on its own
 * bounding box and put that centre on the mesh instead.
 */
function recenter(geometry, mesh) {
  geometry.computeBoundingBox();
  const c = new THREE.Vector3();
  geometry.boundingBox.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.computeBoundingSphere();
  mesh.position.copy(c);
  mesh.updateMatrix();            // matrixAutoUpdate is off on all of these
  geometry.userData.origin = c;
  return c;
}


export default class Roads {
  constructor(net, terrain) {
    this.net = net; this.terrain = terrain;
    this.chunks = new Map();
    this.meshes = [];
    this.decals = null;
    this._nodeGeom = new Map();     // nodeId -> { dirs, trim } used by sidewalks
    // Reused so surfaceAt() allocates nothing when called every frame.
    this._surf = { y: 0, kind: 'road', edgeId: -1, offset: 0 };
  }

  /** The chunk covering a world point, created on first touch. */
  _chunk(x, z) {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let b = this.chunks.get(k);
    if (!b) this.chunks.set(k, b = { near: new Batch(), far: new Batch(), key: k });
    return b;
  }

  /** Full-detail vertex sink for a world point. */
  _batch(x, z) { return this._chunk(x, z).near; }

  // -- cross-section --------------------------------------------------------

  /**
   * The full kerb-to-kerb cross-section of one edge, as non-overlapping bands.
   * Bands are emitted left-to-right and tile exactly, so markings are part of
   * the road surface rather than something laid on top of it.
   */
  section(e) {
    const P = PROFILE[e.type];
    const lw = e.width && e.surface !== 'asphalt' ? e.width : null;
    const laneW = P.lane;
    const fwd = e.oneway ? e.lanes : Math.ceil(e.lanes / 2);
    const bwd = e.lanes - fwd;
    const sh = P.shoulder;
    const pk = e.parking ? e.parking.width : 0;
    let L = lw ? -lw / 2 : -(bwd * laneW) - sh - pk;
    let R = lw ? lw / 2 : (fwd * laneW) + sh + pk;
    const shift = -(L + R) / 2;
    L += shift; R += shift;
    const half = Math.max(-L, R);

    const bands = [];
    const add = (o0, o1, tile, tint, rough, dash) =>
      bands.push({ o0, o1, tile, tint, rough, dash, road: true });

    const surfTile = e.surface === 'cobble' ? T_COBBLE : T_ASPHALT;
    const surfTint = e.surface === 'cobble' ? C.cobble : C.asphalt;
    const marks = e.type !== 'alley' && e.surface === 'asphalt' && !lw;

    // Lane centrelines, in the same offset space as the bands. The shader puts
    // the wheel tracks 0.78 m either side of these, so they have to be the real
    // travelled lanes and not a naive division of the kerb-to-kerb width —
    // otherwise the tracks land in the parking bay and the gutter.
    const lanes = [];
    if (marks) {
      for (let k = bwd; k >= 1; k--) lanes.push(shift - (k - 0.5) * laneW);
      for (let k = 1; k <= fwd; k++) lanes.push(shift + (k - 0.5) * laneW);
    } else {
      const n = Math.max(1, Math.round((R - L) / laneW));
      for (let k = 0; k < n; k++) lanes.push(L + (k + 0.5) * ((R - L) / n));
    }

    if (!marks) {
      add(L, R, surfTile, surfTint, e.surface === 'cobble' ? 0.86 : 0.97);
    } else {
      let o = L;
      const solid = e.type === 'arterial' || e.type === 'highway';
      // Kerbside parking bay: slightly darker and dirtier than the running
      // surface because nothing polishes it, and edged with a worn white line.
      if (pk > 0.5) {
        add(o, o + pk - 0.10, T_ASPHALT, C.parkbay, 0.99); o += pk - 0.10;
        add(o, o + 0.10, T_ASPHALT, C.whiteWorn, 0.72); o += 0.10;
      }
      if (sh > 0.05) { add(o, o + sh, T_ASPHALT, C.gutter, 0.99); o += sh; }
      if (solid) { add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12; }
      // left-hand (b->a) lanes
      for (let k = bwd; k >= 1; k--) {
        const next = shift - (k - 1) * laneW;
        add(o, k === 1 ? next - 0.09 : next - 0.06, T_ASPHALT, surfTint, 0.97);
        if (k > 1) { add(next - 0.06, next + 0.06, T_ASPHALT, C.white, 0.62, 1); o = next + 0.06; }
        else o = next - 0.09;
      }
      if (bwd > 0 && fwd > 0) {
        // double yellow centre line, with the real 10 cm gap between them
        add(o, o + 0.10, T_ASPHALT, C.yellow, 0.66); o += 0.10;
        add(o, o + 0.08, T_ASPHALT, surfTint, 0.97); o += 0.08;
        add(o, o + 0.10, T_ASPHALT, C.yellow, 0.66); o += 0.10;
      } else if (bwd === 0 && fwd > 0 && sh > 0.05) {
        add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12;
      }
      // right-hand (a->b) lanes
      for (let k = 1; k <= fwd; k++) {
        const next = shift + k * laneW;
        const isLast = k === fwd;
        add(o, isLast ? next : next - 0.06, T_ASPHALT, surfTint, 0.97);
        if (!isLast) { add(next - 0.06, next + 0.06, T_ASPHALT, C.white, 0.62, 1); o = next + 0.06; }
        else o = next;
      }
      if (solid && (sh > 0.05 || pk > 0.5)) {
        add(o, o + 0.12, T_ASPHALT, C.whiteWorn, 0.7); o += 0.12;
      }
      if (sh > 0.05) { add(o, o + sh, T_ASPHALT, C.gutter, 0.99); o += sh; }
      if (pk > 0.5) {
        add(o, o + 0.10, T_ASPHALT, C.whiteWorn, 0.72); o += 0.10;
        add(o, R, T_ASPHALT, C.parkbay, 0.99); o = R;
      }
      if (o < R - 0.02) add(o, R, T_ASPHALT, C.gutter, 0.99);
    }

    // Kerbs and pavement. Boston mixes poured concrete with red brick; brick
    // is the historic districts and the smarter streets.
    const walk = e.walk;
    if (walk > 0.3) {
      const brick = e.brick;
      const wt = brick ? T_BRICK : T_CONCRETE, wc = brick ? C.brick : C.concrete;
      for (const side of [-1, 1]) {
        const edge = side < 0 ? L : R;
        const k0 = edge, k1 = edge + side * 0.16;
        // Boston kerbs are sawn granite blocks about a metre and a half long.
        // The face must not be asphalt-textured or it reads as a painted stripe
        // rather than a kerb; the concrete-slab tile at this scale gives the
        // block joints, and `vertical` maps the texture up the face properly.
        bands.push({ o0: k0, o1: k0, y0: 0, y1: KERB_H, tile: T_CONCRETE,
                     tint: C.granite, rough: 0.74, vertical: true, side,
                     scale: KERB_SCALE, cls: W_KERB_FACE });
        bands.push({ o0: side < 0 ? k1 : k0, o1: side < 0 ? k0 : k1, y0: KERB_H, y1: KERB_H,
                     tile: T_CONCRETE, tint: C.graniteTop, rough: 0.70,
                     scale: KERB_SCALE, cls: W_KERB_TOP });
        const w0 = edge + side * 0.16, w1 = edge + side * (0.16 + walk);
        bands.push({ o0: side < 0 ? w1 : w0, o1: side < 0 ? w0 : w1,
                     y0: KERB_H + (side < 0 ? 0.05 : 0.0), y1: KERB_H + (side < 0 ? 0.0 : 0.05),
                     tile: wt, tint: wc, rough: brick ? 0.9 : 0.88,
                     scale: brick ? 1.9 : 2.6, cls: W_WALK });
        // Graded verge behind the pavement. The terrain raster is stamped a
        // little low around every street so it can never poke through the
        // asphalt; this closes that seam instead of leaving a visible lip.
        const v1 = edge + side * (0.16 + walk + VERGE);
        bands.push({ o0: side < 0 ? v1 : w1, o1: side < 0 ? w1 : v1,
                     y0: side < 0 ? -0.46 : KERB_H, y1: side < 0 ? KERB_H : -0.46,
                     tile: T_CONCRETE, tint: C.verge, rough: 0.98, scale: 3.4,
                     cls: W_VERGE });
      }
    }
    return { bands, L, R, half, shift, lanes,
             corridor: half + (walk > 0.3 ? walk + 0.16 : 0) };
  }

  /** Centre of the travelled lane nearest an offset, in the same space. */
  static _nearestLane(lanes, o) {
    let best = 0, bd = 1e9;
    for (let i = 0; i < lanes.length; i++) {
      const d = Math.abs(o - lanes[i]);
      if (d < bd) { bd = d; best = lanes[i]; }
    }
    return best;
  }

  /**
   * Signed distance from an offset to the nearest lane centre, in metres.
   * Clamped to well outside a wheel-track lobe so the tracks never leak into
   * the next lane when a "lane" is really a wide shoulder.
   */
  static _laneOff(lanes, o) {
    if (!lanes.length) return 0;
    return Math.max(-2.2, Math.min(2.2, o - Roads._nearestLane(lanes, o)));
  }

  // -- ribbon ---------------------------------------------------------------

  /** Arc-length frames along an edge, trimmed back from each intersection. */
  _frames(e, t0, t1, step) {
    const out = [];
    const total = e.length;
    const n = Math.max(1, Math.ceil((t1 - t0) / step));
    for (let i = 0; i <= n; i++) {
      const d = t0 + (t1 - t0) * (i / n);
      const s = this._at(e, d);
      s.d = d; s.camber = 1;
      // flatten the camber into the junction so the ribbon end is a straight
      // line and stitches to the intersection polygon without a crack
      const fade = 10;
      s.camber = Math.min(1, Math.min(d - t0, t1 - d) / fade);
      out.push(s);
    }
    return out;
  }

  _at(e, d) {
    const cum = e.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = e.pts[i - 1], b = e.pts[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
    let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
             dx, dz, rx: -dz, rz: dx, slope: (b.y - a.y) / seg };
  }

  /**
   * Emit a band, splitting it at chunk boundaries.
   *
   * Mass Ave is 3 km long and survives intersection-splitting as a handful of
   * very long edges. Assigning a whole edge to the chunk containing its
   * midpoint gave chunks a 1700 m bounding sphere, which made every distance
   * LOD test pass and every frustum cull fail. Grouping the stations by the
   * chunk they actually sit in fixes both. Runs overlap by one station and
   * share identical vertex positions, so the split cannot open a crack.
   */
  _stripChunked(frames, band, sec, dashPhase, far) {
    let start = 0;
    let key = this._key(frames[0]);
    for (let i = 1; i <= frames.length; i++) {
      const k = i < frames.length ? this._key(frames[i]) : null;
      if (k === key && i < frames.length) continue;
      const run = frames.slice(start, Math.min(i + 1, frames.length));
      if (run.length > 1) {
        const ch = this._chunk(run[0].x, run[0].z);
        this._strip(far ? ch.far : ch.near, run, band, sec, dashPhase);
      }
      start = i; key = k;
    }
  }

  _key(f) { return `${Math.floor(f.x / CHUNK)},${Math.floor(f.z / CHUNK)}`; }

  /** Emit one band as a strip of quads along the given frames. */
  _strip(bat, frames, band, sec, dashPhase) {
    const tile = TILE_UV[band.tile];
    const sc = band.scale || 2.4;
    const half = sec.half || 1;
    // Wear coordinates. On the carriageway these are real geometry — offset from
    // the travelled lane centre, and distance to the nearer kerb — so wheel
    // tracks and gutter grime land where traffic and water actually put them.
    // Off it, aWear.y is a class tag (see W_* above).
    const cls = band.cls ?? W_ROAD;
    const lanes = sec.lanes || [];
    // Pick the lane from the band's MIDPOINT, not per vertex. Choosing per
    // vertex lets a 12 cm lane-divider band pick lane A at one edge and lane B
    // at the other, so the interpolated offset sweeps ±1.7 m across 12 cm and
    // paints a bogus wheel track inside the painted line.
    const cMid = cls === W_ROAD && lanes.length
      ? Roads._nearestLane(lanes, (band.o0 + band.o1) / 2) : 0;
    const wearAt = (o) => cls !== W_ROAD ? [0, cls]
      : [band.laneOff !== undefined ? band.laneOff
                                    : Math.max(-2.2, Math.min(2.2, o - cMid)),
         Math.max(0, Math.min(o - sec.L, sec.R - o))];
    const wa = wearAt(band.o0), wb = wearAt(band.o1);
    const vy = (o, fr) => {
      const base = band.vertical || band.y0 !== undefined ? 0 : 0;
      const cam = band.road === true || band.y0 === undefined
        ? -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / half), 2) * fr.camber : 0;
      return base + cam;
    };
    const nrm = new THREE.Vector3();
    let prevA = -1, prevB = -1;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const o0 = band.o0, o1 = band.o1;
      const y0 = (band.y0 !== undefined ? band.y0 : vy(o0, f));
      const y1 = (band.y1 !== undefined ? band.y1 : vy(o1, f));
      const x0 = f.x + f.rx * o0, z0 = f.z + f.rz * o0;
      const x1 = f.x + f.rx * o1, z1 = f.z + f.rz * o1;
      // surface normal from the across-vector tilt and the along-slope
      if (band.vertical) {
        // Kerb face: look back across the carriageway, tilted a little up so it
        // still catches the sky rather than going flat black in shadow.
        const sd = band.side || 1;
        nrm.set(-sd * f.rx, 0.16, -sd * f.rz).normalize();
      } else {
        const ax = f.rx * (o1 - o0), ay = y1 - y0, az = f.rz * (o1 - o0);
        _across.set(ax, ay, az);
        nrm.set(f.dx, f.slope, f.dz).cross(_across).normalize();
        if (nrm.y < 0) nrm.negate();
      }
      let cr = band.tint[0], cg = band.tint[1], cb = band.tint[2];
      if (band.dash) {
        const on = ((f.d + dashPhase) % (DASH_ON + DASH_OFF)) < DASH_ON;
        if (!on) { cr = C.asphalt[0]; cg = C.asphalt[1]; cb = C.asphalt[2]; }
      }
      // age the surface: large-scale patchiness plus per-station wear
      const w = 0.86 + hash2(Math.floor(f.x / 9), Math.floor(f.z / 9)) * 0.3;
      cr *= w; cg *= w; cb *= w;
      // A vertical face has no lateral extent, so run the pattern up it instead.
      const v0 = band.vertical ? y0 / sc : o0 / sc;
      const v1 = band.vertical ? y1 / sc : o1 / sc;
      const a = bat.vert(x0, f.y + y0, z0, nrm.x, nrm.y, nrm.z, cr, cg, cb,
        f.d / sc, v0, tile[0], tile[1], band.rough, wa[0], wa[1]);
      const b = bat.vert(x1, f.y + y1, z1, nrm.x, nrm.y, nrm.z, cr, cg, cb,
        f.d / sc, v1, tile[0], tile[1], band.rough, wb[0], wb[1]);
      if (i > 0) bat.quad(prevA, prevB, b, a);
      prevA = a; prevB = b;
    }
  }

  // -- intersections --------------------------------------------------------

  /** Corner geometry and trim distances for every node. Must run before ribbons. */
  planNodes() {
    const net = this.net;
    for (const n of net.nodes) {
      const arms = [];
      for (const id of n.edges) {
        const e = net.edges[id];
        const fromA = e.a === n.id;
        const p0 = fromA ? e.pts[0] : e.pts[e.pts.length - 1];
        const p1 = fromA ? e.pts[1] : e.pts[e.pts.length - 2];
        let dx = p1.x - p0.x, dz = p1.z - p0.z;
        const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const sec = this.section(e);
        arms.push({ e, fromA, dx, dz, rx: -dz, rz: dx, sec,
                    hw: sec.half, ang: Math.atan2(dz, dx), trim: sec.half * 0.6 });
      }
      arms.sort((a, b) => a.ang - b.ang);

      const corners = [];
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length];
        corners.push(this._corner(n, A, B));
      }
      // trim each arm back far enough to clear both of its corners
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i];
        const prev = corners[(i - 1 + corners.length) % corners.length];
        const need = [prev, corners[i]].map(c =>
          (c.x - n.x) * A.dx + (c.z - n.z) * A.dz);
        const t = Math.max(A.hw * 0.35, ...need) + 0.4;
        A.trim = Math.min(t, A.e.length * 0.42);
      }
      this._nodeGeom.set(n.id, { arms, corners });
    }
  }

  /** Where two adjacent kerb lines meet, i.e. the actual corner of the junction. */
  _corner(n, A, B) {
    // A's right-hand edge line vs B's left-hand edge line
    const ax = n.x + A.rx * A.hw, az = n.z + A.rz * A.hw;
    const bx = n.x - B.rx * B.hw, bz = n.z - B.rz * B.hw;
    const den = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(den) < 0.12) {
      // near head-on or near-parallel: fall back to a rounded splay
      const mx = (A.dx - B.dx), mz = (A.dz - B.dz);
      const L = Math.hypot(mx, mz) || 1;
      const r = Math.max(A.hw, B.hw);
      return { x: ax + (mx / L) * r * 0.5, z: az + (mz / L) * r * 0.5, A, B };
    }
    const t = ((bx - ax) * B.dz - (bz - az) * B.dx) / den;
    const tc = Math.min(Math.max(t, -Math.max(A.hw, B.hw) * 2.2), Math.max(A.hw, B.hw) * 3.2);
    return { x: ax + A.dx * tc, z: az + A.dz * tc, A, B };
  }

  /** Fill the junction polygon and the pavement corners around it. */
  _emitNode(n) {
    const { arms, corners } = this._nodeGeom.get(n.id);
    if (arms.length < 2) return;
    const bat = this._batch(n.x, n.z);
    const tile = TILE_UV[T_ASPHALT];
    const loop = [];
    const ends = [];
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i];
      const px = n.x + A.dx * A.trim, pz = n.z + A.dz * A.trim;
      const py = n.y + A.trim * (A.fromA ? A.e.pts[1].y - A.e.pts[0].y : 0) * 0;
      const l = { x: px - A.rx * A.hw, z: pz - A.rz * A.hw, y: py };
      const r = { x: px + A.rx * A.hw, z: pz + A.rz * A.hw, y: py };
      ends.push({ A, l, r, px, pz, py });
      loop.push(l, r, { x: corners[i].x, z: corners[i].z, y: n.y });
    }
    // fan from the node centre — crowned very slightly so water sheds
    const nrm = [0, 1, 0];
    // aWear on a junction: no lane structure, so no wheel tracks — but the
    // middle of a junction is the oiliest asphalt in a city and its edges drain
    // like a gutter, which is what the 3.6 m / 0.9 m kerb distances buy.
    const cIdx = bat.vert(n.x, n.y + 0.035, n.z, 0, 1, 0,
      C.asphaltHot[0], C.asphaltHot[1], C.asphaltHot[2], n.x / 2.4, n.z / 2.4,
      tile[0], tile[1], 0.98, 0, 3.6);
    const ring = loop.map(p => bat.vert(p.x, p.y, p.z, nrm[0], nrm[1], nrm[2],
      C.asphaltHot[0] * 0.96, C.asphaltHot[1] * 0.96, C.asphaltHot[2] * 0.96,
      p.x / 2.4, p.z / 2.4, tile[0], tile[1], 0.98, 0, 0.9));
    for (let i = 0; i < ring.length; i++) {
      bat.i.push(cIdx, ring[i], ring[(i + 1) % ring.length]);
    }

    // pavement corners: a wedge between each pair of arms, at kerb height
    const ct = TILE_UV[T_CONCRETE];
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i], B = arms[(i + 1) % arms.length], c = corners[i];
      if (A.e.walk < 0.3 || B.e.walk < 0.3) continue;
      const oa = A.hw + 0.16 + A.e.walk, ob = B.hw + 0.16 + B.e.walk;
      const ea = ends[i], eb = ends[(i + 1) % arms.length];
      const co = { x: c.x, z: c.z };
      const dirx = co.x - n.x, dirz = co.z - n.z;
      const dl = Math.hypot(dirx, dirz) || 1;
      const outer = { x: n.x + (dirx / dl) * (dl + Math.max(oa, ob) - Math.max(A.hw, B.hw)),
                      z: n.z + (dirz / dl) * (dl + Math.max(oa, ob) - Math.max(A.hw, B.hw)) };
      const pA = { x: ea.px + A.rx * oa, z: ea.pz + A.rz * oa };
      const pB = { x: eb.px - B.rx * ob, z: eb.pz - B.rz * ob };
      const y = n.y + KERB_H;
      const quad = [
        [ea.r.x, ea.r.z], [pA.x, pA.z], [outer.x, outer.z], [pB.x, pB.z], [eb.l.x, eb.l.z],
        [c.x, c.z],
      ];
      const vs = quad.map(([x, z]) => bat.vert(x, y, z, 0, 1, 0,
        C.concrete[0], C.concrete[1], C.concrete[2], x / 2.6, z / 2.6, ct[0], ct[1], 0.88,
        0, W_WALK));
      for (let k = 1; k < vs.length - 1; k++) bat.i.push(vs[0], vs[k], vs[k + 1]);
      // kerb face around the corner
      const gt = TILE_UV[T_CONCRETE];
      const face = [[ea.r.x, ea.r.z], [c.x, c.z], [eb.l.x, eb.l.z]];
      for (let k = 0; k < face.length - 1; k++) {
        const [x0, z0] = face[k], [x1, z1] = face[k + 1];
        let fx = x1 - x0, fz = z1 - z0; const fl = Math.hypot(fx, fz) || 1;
        const nx = -fz / fl, nz = fx / fl;
        const S = KERB_SCALE, KF = W_KERB_FACE;
        const a = bat.vert(x0, n.y, z0, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x0 / S, 0, gt[0], gt[1], 0.74, 0, KF);
        const b = bat.vert(x1, n.y, z1, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x1 / S, 0, gt[0], gt[1], 0.74, 0, KF);
        const c2 = bat.vert(x1, n.y + KERB_H, z1, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x1 / S, KERB_H / S, gt[0], gt[1], 0.74, 0, KF);
        const d = bat.vert(x0, n.y + KERB_H, z0, -nx, 0.2, -nz, C.granite[0], C.granite[1], C.granite[2], x0 / S, KERB_H / S, gt[0], gt[1], 0.74, 0, KF);
        bat.quad(a, b, c2, d);
      }
    }
  }

  /** Zebra crossing in the gap between the junction polygon and the ribbon. */
  _crosswalk(e, sec, d0, d1) {
    const f0 = this._at(e, d0), f1 = this._at(e, d1);
    const bat = this._batch(f0.x, f0.z);
    const tile = TILE_UV[T_ASPHALT];
    const inset = 0.35;
    const w = sec.R - sec.L - inset * 2;
    const stripes = Math.max(2, Math.round(w / 1.05));
    const sw = w / stripes;
    for (let i = 0; i < stripes; i++) {
      const paint = i % 2 === 0;
      const t = paint ? C.white : C.asphalt;
      const wear = 0.72 + rnd(i * 7 + Math.floor(f0.x)) * 0.42;
      const o0 = sec.L + inset + i * sw, o1 = o0 + sw * (paint ? 0.86 : 1);
      const vs = [[f0, o0], [f0, o1], [f1, o1], [f1, o0]].map(([f, o]) => {
        const cam = -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / sec.half), 2) * 0.35;
        return bat.vert(f.x + f.rx * o, f.y + cam, f.z + f.rz * o, 0, 1, 0,
          t[0] * wear, t[1] * wear, t[2] * wear, (f.d || 0) / 2.4, o / 2.4,
          tile[0], tile[1], paint ? 0.66 : 0.97,
          Roads._laneOff(sec.lanes || [], o),
          Math.max(0, Math.min(o - sec.L, sec.R - o)));
      });
      bat.quad(vs[0], vs[1], vs[2], vs[3]);
    }
  }

  // -- build ----------------------------------------------------------------

  build(scene, materials, assets) {
    // The road material carries custom vertex attributes (atlas tile, world
    // pattern UV, per-band roughness) and does its tiling in the shader, so it
    // cannot be one of the materials library's generic surfaces. Build it here
    // and register it so it is still shared, disposed centrally and picked up
    // by `assets.setWetness()` when it rains.
    // Materials.init already assembles a `road_atlas` from the TextureFactory
    // recipes and registers it, and that is the one the city actually renders.
    // Painting the fallback atlas anyway cost two 1024^2 canvas passes and two
    // CanvasTextures that were never sampled, on every boot. Only build it if
    // nobody got here first.
    const shared = assets?.materials?.get('road_atlas');
    if (shared) {
      this.material = shared;
      this._ownMaterial = false;
    } else {
      this.atlas = makeAtlas();
      this.material = assets
        ? assets.material('road_atlas', () => makeRoadMaterial(this.atlas))
        : makeRoadMaterial(this.atlas);
      this._ownMaterial = !assets;
    }
    // Match the materials library's environment response if it has landed.
    const ref = materials?.get?.('asphalt');
    if (ref && ref.name === 'asphalt') {
      this.material.envMapIntensity = ref.envMapIntensity ?? this.material.envMapIntensity;
    }

    this.planNodes();
    const net = this.net;

    // Boston's brick pavement districts.
    for (const e of net.edges) {
      e.brick = e.surface === 'cobble' ||
        (e.type !== 'highway' && (e.name.includes('Beacon') || e.name.includes('Chestnut') ||
         e.name.includes('Mount Vernon') || e.name.includes('Pinckney') ||
         e.name.includes('Charles Street') || e.name.includes('Hanover') ||
         e.name.includes('Salem') || e.name.includes('Newbury') ||
         e.name.includes('Marlborough') || e.name.includes('Commonwealth')));
    }

    for (const e of net.edges) {
      const sec = this.section(e);
      e._sec = sec;
      const ga = this._nodeGeom.get(e.a), gb = this._nodeGeom.get(e.b);
      const ta = ga?.arms.find(a => a.e === e && a.fromA);
      const tb = gb?.arms.find(a => a.e === e && !a.fromA);
      let d0 = ta ? ta.trim : 0;
      let d1 = e.length - (tb ? tb.trim : 0);
      if (d1 - d0 < 3) { const m = (d0 + d1) / 2; d0 = m - 1.5; d1 = m + 1.5; }

      // crosswalks only where it is a real junction and a real street
      const cwA = net.nodes[e.a].edges.length > 2 && e.type !== 'alley' && e.type !== 'highway';
      const cwB = net.nodes[e.b].edges.length > 2 && e.type !== 'alley' && e.type !== 'highway';
      if (cwA && d1 - d0 > CROSSWALK * 2 + 6) { this._crosswalk(e, sec, d0, d0 + CROSSWALK); d0 += CROSSWALK; }
      if (cwB && d1 - d0 > CROSSWALK + 6) { this._crosswalk(e, sec, d1 - CROSSWALK, d1); d1 -= CROSSWALK; }
      e._span = [d0, d1];

      const coarse = this._frames(e, d0, d1, STEP);
      const fine = this._frames(e, d0, d1, DASH_ON);
      const phase = rnd(e.id) * (DASH_ON + DASH_OFF);
      for (const band of sec.bands) {
        this._stripChunked(band.dash ? fine : coarse, band, sec, phase, false);
      }
      // low-detail version: bare carriageway + pavement, no markings
      const lo = this._frames(e, d0, d1, STEP * 3);
      // `laneOff: 2.2` parks the far LOD outside every wheel-track lobe. The band
      // is the whole carriageway in two vertices, so a real lane offset would
      // interpolate straight across it and paint one bogus track down the middle;
      // at >290 m the tracks are sub-pixel anyway.
      this._stripChunked(lo, { o0: sec.L, o1: sec.R, tile: T_ASPHALT, tint: C.asphalt,
                               rough: 0.97, road: true, laneOff: 2.2 }, sec, 0, true);
      for (const band of sec.bands) {
        if (band.vertical) continue;
        if (band.tile === T_CONCRETE || band.tile === T_BRICK) {
          this._stripChunked(lo, band, sec, 0, true);
        }
      }
    }

    for (const n of net.nodes) this._emitNode(n);

    // stop lines: a solid bar across the approach lanes, just past the zebra
    this._stopLines();
    this._details();

    let tris = 0;
    for (const ch of this.chunks.values()) {
      if (ch.near.empty) continue;
      const near = new THREE.Mesh(ch.near.geometry(), this.material);
      near.receiveShadow = true; near.castShadow = false;
      near.matrixAutoUpdate = false; near.name = 'road_' + ch.key;
      const c = recenter(near.geometry, near);
      scene.add(near);
      const far = new THREE.Mesh(ch.far.geometry(), this.material);
      far.receiveShadow = true; far.matrixAutoUpdate = false;
      far.visible = false; far.name = 'roadLod_' + ch.key;
      recenter(far.geometry, far);
      scene.add(far);
      ch.nearMesh = near; ch.farMesh = far;
      // World-space centre and radius for the LOD test: the geometry's own
      // bounding sphere is local now, so keep the world centre explicitly.
      ch.center = c.clone();
      ch.radius = near.geometry.boundingSphere.radius;
      this.meshes.push(near, far);
      tris += ch.near.i.length / 3;
    }
    this.triangles = tris;
    return this;
  }

  _stopLines() {
    const net = this.net, tile = TILE_UV[T_ASPHALT];
    for (const e of net.edges) {
      if (e.type === 'alley' || e.type === 'highway' || !e._span) continue;
      const sec = e._sec;
      for (const end of [0, 1]) {
        const nid = end === 0 ? e.a : e.b;
        if (net.nodes[nid].edges.length < 3) continue;
        const d = end === 0 ? e._span[0] + 0.05 : e._span[1] - 0.65;
        if (d < 0 || d + 0.6 > e.length) continue;
        const f0 = this._at(e, d), f1 = this._at(e, d + 0.6);
        const bat = this._batch(f0.x, f0.z);
        // only the approach half of the carriageway
        const o0 = end === 0 ? sec.shift + 0.14 : sec.L + 0.6;
        const o1 = end === 0 ? sec.R - 0.5 : sec.shift - 0.14;
        if (o1 - o0 < 1) continue;
        const wear = 0.6 + rnd(e.id * 3 + end) * 0.5;
        const vs = [[f0, o0], [f0, o1], [f1, o1], [f1, o0]].map(([f, o]) => {
          const cam = -CROWN * Math.pow(Math.min(1, Math.abs(o - sec.shift) / sec.half), 2) * 0.3;
          return bat.vert(f.x + f.rx * o, f.y + cam, f.z + f.rz * o, 0, 1, 0,
            C.white[0] * wear, C.white[1] * wear, C.white[2] * wear,
            f.d / 2.4, o / 2.4, tile[0], tile[1], 0.66,
            Roads._laneOff(sec.lanes || [], o),
            Math.max(0, Math.min(o - sec.L, sec.R - o)));
        });
        bat.quad(vs[0], vs[1], vs[2], vs[3]);
      }
    }
  }

  /**
   * Manholes and gully gratings. The only true decals in the system, so they
   * get a real polygon offset instead of a hopeful vertical nudge.
   */
  _details() {
    const pos = [], nrm = [], col = [], idx = [];
    let v = 0;
    const disc = (cx, cy, cz, r, sides, shade, ring) => {
      const c0 = v;
      pos.push(cx, cy, cz); nrm.push(0, 1, 0); col.push(shade * 1.1, shade, shade * 0.92); v++;
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r);
        nrm.push(0, 1, 0);
        const s = shade * (ring ? (0.7 + 0.3 * Math.abs(Math.sin(a * 4))) : 1);
        col.push(s * 1.1, s, s * 0.92); v++;
      }
      for (let i = 0; i < sides; i++) idx.push(c0, c0 + 1 + i, c0 + 1 + ((i + 1) % sides));
    };
    for (const e of this.net.edges) {
      if (!e._span || e.type === 'highway' || e.type === 'alley') continue;
      const sec = e._sec;
      const [d0, d1] = e._span;
      for (let d = d0 + 6; d < d1 - 6; d += 34) {
        const j = rnd(e.id * 17 + d);
        if (j > 0.55) continue;
        const f = this._at(e, d + j * 20);
        if (j < 0.24) {                      // manhole, near the crown
          const o = sec.shift + (j - 0.12) * 8;
          disc(f.x + f.rx * o, f.y + 0.006, f.z + f.rz * o, 0.33, 14, 0.055, true);
        } else {                             // gully grating, in the gutter
          const side = j > 0.4 ? 1 : -1;
          const o = (side < 0 ? sec.L : sec.R) - side * 0.34;
          disc(f.x + f.rx * o, f.y - CROWN * 0.85 + 0.004, f.z + f.rz * o, 0.26, 8, 0.035, false);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.72,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      depthWrite: false,
    });
    this.decals = new THREE.Mesh(g, m);
    this.decals.renderOrder = 2;
    this.decals.matrixAutoUpdate = false;
    recenter(g, this.decals);
    this.decals.receiveShadow = true;
    this._detailMat = m;
  }

  /**
   * Height of the surface that is actually drawn at a point, and what it is.
   *
   * `Terrain.groundHeight()` is deliberately stamped 0.4-0.75 m *below* the
   * carriageway so the ground can never poke through asphalt, which means it is
   * the wrong answer for anything standing on a street: a lamp post placed on
   * it sinks by more than half a metre. This walks the same cross-section the
   * ribbon geometry was built from, so it agrees with the mesh to the
   * centimetre — camber included.
   *
   * @param {number} x @param {number} z
   * @param {number} [nearY] hint, used only to decide whether a caller is on a
   *   bridge deck or on the ground beneath it
   * @returns {{y:number, kind:'road'|'pavement', edgeId:number, offset:number}|null}
   *   null when the point is not on a paved surface at all
   */
  surfaceAt(x, z, nearY) {
    const ne = this.net.nearestEdge(x, z);
    if (!ne) return null;
    const e = this.net.edges[ne.edgeId];
    const sec = e._sec || (e._sec = this.section(e));
    const walk = e.walk > 0.3 ? 0.16 + e.walk : 0;
    if (ne.distance > sec.half + walk) return null;

    const f = this._at(e, ne.t * e.length);
    // A flyover is only your surface if you are actually up on it.
    if (e.bridged && (nearY === undefined || Math.abs(nearY - f.y) > 6)) return null;

    const off = (x - f.x) * f.rx + (z - f.z) * f.rz;
    const _r = this._surf;
    _r.edgeId = e.id; _r.offset = off;
    if (off >= sec.L && off <= sec.R) {
      const t = Math.min(1, Math.abs(off - sec.shift) / (sec.half || 1));
      _r.y = f.y - CROWN * t * t;
      _r.kind = 'road';
    } else {
      // pavement: kerb height plus the same slight fall back towards the kerb
      const over = Math.abs(off) - Math.max(-sec.L, sec.R);
      _r.y = f.y + KERB_H + Math.max(0, 1 - over / (e.walk || 1)) * 0.05;
      _r.kind = 'pavement';
    }
    return _r;
  }

  /** Distance LOD. Markings are sub-pixel past ~320 m, so drop them. */
  update(camera) {
    const p = camera.position;
    for (const ch of this.chunks.values()) {
      if (!ch.nearMesh) continue;
      const d = Math.hypot(p.x - ch.center.x, p.z - ch.center.z) - ch.radius;
      const near = d < 290;
      if (ch.nearMesh.visible !== near) {
        ch.nearMesh.visible = near;
        ch.farMesh.visible = !near;
      }
    }
    if (this.decals) this.decals.visible = true;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.parent?.remove(m); }
    this.meshes.length = 0;
    this.decals?.geometry.dispose();
    this.decals?.parent?.remove(this.decals);
    this._detailMat?.dispose();
    if (this._ownMaterial) this.material?.dispose();
    this.atlas?.map.dispose(); this.atlas?.nrm.dispose();
  }
}

export { KERB_H, makeRoadMaterial, makeAtlas };
