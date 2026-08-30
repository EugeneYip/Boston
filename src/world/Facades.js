import { geo } from '../core/Geo.js';
import { SURF, rng, hash2, orientOutward, polyCentroid, insetPoly } from './BuildingKit.js';

/**
 * Facades — the procedural grammar that turns a parcel into a building.
 *
 * Nothing here is a "building mesh". A parcel becomes a *spec* (storeys, bay
 * rhythm, materials, roof form), and the spec is walked to emit triangles:
 *
 *   footprint -> storeys -> bays -> {pier, spandrel, reveal, pane, sill, lintel}
 *             -> string courses -> cornice -> parapet/mansard -> roof clutter
 *
 * Three LODs come out of the same walk so the silhouette can never pop:
 *   0  full detail (reveals, sills, stoops, fire escapes, roof clutter)
 *   1  simplified (reveals + panes, coarse roof furniture, no small trim)
 *   2  shell — baked facade-strip texture, inset 0.25 m so LOD 0/1 always
 *      covers it. The shell is always resident, which is why the distant
 *      skyline costs ~16 draw calls instead of 400.
 *
 * All dimensions are real: 3.05–3.4 m residential storeys, 4.0–5.5 m commercial
 * ground floors, 0.75 m sill height, 0.10–0.22 m window reveals.
 */

/* -------------------------------------------------------------------------- */
/* Style catalogue — this is the Boston part                                  */
/* -------------------------------------------------------------------------- */

const STYLES = {
  /** Back Bay: Victorian brownstone, bowfronts, mansards, high stoops. */
  brownstone: {
    storeys: [4, 5], storeyH: 3.36, groundH: 3.95, bayW: 2.55,
    walls: ['brownstone', 'brownstone', 'brownstone_rus', 'brick_red'],
    trim: 'trim_stone', roof: 'roof_tar',
    tone: [[1.00, 0.92, 0.82], [0.88, 0.80, 0.72], [1.06, 0.98, 0.88], [0.80, 0.74, 0.70]],
    winKind: 1, winW: 1.22, winH: 2.20, sillH: 0.78, reveal: 0.20,
    bow: 0.42, bay: 0.62, mansard: 0.62, stoop: 1.0, basement: true, shop: 0.05,
    cornice: 0.46, stringCourse: true, arched: 0.45, chimneys: 2,
    facStrip: 'fac_brownstone',
  },
  /** Beacon Hill: Federal red brick, flat front, black shutters, fanlights. */
  federal: {
    storeys: [3, 4], storeyH: 3.06, groundH: 3.45, bayW: 2.20,
    walls: ['brick_red', 'brick_red', 'brick_dark', 'brick_painted'],
    trim: 'trim_stone', roof: 'roof_tar',
    tone: [[1.00, 0.94, 0.90], [0.90, 0.84, 0.80], [1.08, 1.00, 0.94], [0.96, 0.94, 0.92]],
    winKind: 0, winW: 1.02, winH: 1.86, sillH: 0.82, reveal: 0.14,
    bow: 0.08, bay: 0.20, mansard: 0.10, stoop: 0.85, basement: true, shop: 0.10,
    cornice: 0.24, shutters: 0.72, fanlight: true, dormers: 0.55,
    purple: 0.10, gaslamp: 0.8, bootScraper: true, chimneys: 2,
    facStrip: 'fac_brick',
  },
  /** North End: tight brick tenements, front fire escapes, cafes below. */
  tenement: {
    storeys: [4, 6], storeyH: 3.12, groundH: 4.05, bayW: 2.10,
    walls: ['brick_red', 'brick_dark', 'brick_brown', 'brick_painted'],
    trim: 'trim_stone', roof: 'roof_tar',
    tone: [[0.94, 0.88, 0.84], [0.84, 0.80, 0.78], [1.04, 0.96, 0.88], [0.98, 0.96, 0.92]],
    winKind: 1, winW: 1.08, winH: 1.90, sillH: 0.86, reveal: 0.16,
    bow: 0.04, bay: 0.16, mansard: 0.05, stoop: 0.15, shop: 0.78, awning: 0.70,
    cornice: 0.38, fireEscape: 0.82, waterTank: 0.30, laundry: 0.45, chimneys: 1,
    facStrip: 'fac_brick',
  },
  /** South End: brick rowhouses, bowfronts, garden-level entries. */
  southEnd: {
    storeys: [4, 5], storeyH: 3.28, groundH: 3.80, bayW: 2.45,
    walls: ['brick_red', 'brick_red', 'brick_brown', 'brownstone'],
    trim: 'trim_stone', roof: 'roof_tar',
    tone: [[0.98, 0.92, 0.88], [0.88, 0.82, 0.80], [1.06, 0.98, 0.90], [0.94, 0.88, 0.82]],
    winKind: 1, winW: 1.16, winH: 2.06, sillH: 0.80, reveal: 0.18,
    bow: 0.30, bay: 0.78, mansard: 0.36, stoop: 0.95, basement: true, shop: 0.14,
    cornice: 0.40, stringCourse: true, chimneys: 2,
    facStrip: 'fac_brick',
  },
  /** Fort Point / Leather District brick-and-beam loft warehouses. */
  loft: {
    storeys: [5, 7], storeyH: 3.55, groundH: 4.60, bayW: 3.10,
    walls: ['brick_dark', 'brick_red', 'brick_brown'],
    trim: 'granite', roof: 'roof_gravel',
    tone: [[0.86, 0.82, 0.80], [0.94, 0.88, 0.84], [1.00, 0.94, 0.88]],
    winKind: 1, winW: 2.05, winH: 2.55, sillH: 0.95, reveal: 0.26,
    bow: 0, mansard: 0, stoop: 0.1, shop: 0.45, awning: 0.25,
    cornice: 0.52, arched: 0.7, fireEscape: 0.35, chimneys: 0,
    facStrip: 'fac_brick',
  },
  /** Financial District: 1920s limestone/granite tower with real setbacks. */
  stoneTower: {
    storeys: [10, 26], storeyH: 3.75, groundH: 6.20, bayW: 2.35,
    walls: ['limestone', 'granite', 'terracotta'],
    trim: 'trim_stone', roof: 'roof_gravel',
    tone: [[1.00, 0.98, 0.94], [0.92, 0.92, 0.92], [1.02, 0.98, 0.90]],
    winKind: 1, winW: 1.55, winH: 2.55, sillH: 0.85, reveal: 0.30,
    bow: 0, mansard: 0, stoop: 0, shop: 0.55,
    cornice: 0.70, setbacks: true, piers: true, crown: true, chimneys: 0,
    facStrip: 'fac_stone',
  },
  /** Post-war and modern glass. Real curtain wall with mullion fins. */
  glassTower: {
    storeys: [14, 40], storeyH: 3.85, groundH: 6.80, bayW: 1.52,
    walls: ['spandrel', 'metal_panel', 'granite'],
    trim: 'metal_dark', roof: 'roof_gravel',
    tone: [[0.92, 0.96, 1.02], [0.96, 0.98, 1.00], [0.90, 0.90, 0.92]],
    winKind: 4, winW: 1.34, winH: 2.95, sillH: 0.90, reveal: 0.16,
    bow: 0, mansard: 0, stoop: 0, shop: 0.65,
    cornice: 0.20, curtain: true, mech: true, chimneys: 0,
    facStrip: 'fac_glass',
  },
  /** Seaport: glass and metal-panel mid-rise with projecting balconies. */
  seaport: {
    storeys: [6, 14], storeyH: 3.42, groundH: 5.20, bayW: 2.10,
    walls: ['metal_panel', 'spandrel', 'concrete'],
    trim: 'metal_dark', roof: 'roof_gravel',
    tone: [[0.94, 0.96, 0.98], [0.90, 0.92, 0.96], [1.00, 0.99, 0.96]],
    winKind: 2, winW: 1.72, winH: 2.42, sillH: 0.70, reveal: 0.18,
    bow: 0, mansard: 0, stoop: 0, shop: 0.55, balcony: 0.45,
    cornice: 0.18, panelBands: true, mech: true, chimneys: 0,
    facStrip: 'fac_metal',
  },
  /** Charlestown / outer neighbourhoods: painted-clapboard triple-deckers. */
  tripleDecker: {
    storeys: [3, 3], storeyH: 3.10, groundH: 3.20, bayW: 2.40,
    walls: ['wood_white', 'stucco', 'wood_white'],
    trim: 'wood_white', roof: 'slate',
    tone: [[1.00, 0.99, 0.96], [0.96, 0.92, 0.84], [0.86, 0.90, 0.94]],
    winKind: 0, winW: 1.02, winH: 1.78, sillH: 0.84, reveal: 0.13,
    bow: 0.10, bay: 0.66, mansard: 0, stoop: 0.9, porch: true, hipRoof: true,
    cornice: 0.30, shutters: 0.35, chimneys: 1,
    facStrip: 'fac_brick',
  },
  /** Infill commercial blocks — the connective tissue of every downtown. */
  commercial: {
    storeys: [3, 8], storeyH: 3.45, groundH: 4.60, bayW: 2.60,
    walls: ['brick_dark', 'limestone', 'concrete', 'brick_brown'],
    trim: 'trim_stone', roof: 'roof_gravel',
    tone: [[0.90, 0.86, 0.84], [1.00, 0.99, 0.96], [0.94, 0.94, 0.92], [0.98, 0.92, 0.86]],
    winKind: 1, winW: 1.62, winH: 2.30, sillH: 0.82, reveal: 0.22,
    bow: 0, bay: 0.12, mansard: 0.08, stoop: 0, shop: 0.85, awning: 0.35,
    cornice: 0.46, fireEscape: 0.2, chimneys: 0,
    facStrip: 'fac_stone',
  },
};

/** District -> weighted style mix. This is what makes a Bostonian nod. */
const DISTRICT_MIX = {
  backBay:    [['brownstone', 0.74], ['southEnd', 0.10], ['commercial', 0.10], ['stoneTower', 0.06]],
  beaconHill: [['federal', 0.88], ['brownstone', 0.09], ['commercial', 0.03]],
  northEnd:   [['tenement', 0.86], ['federal', 0.07], ['commercial', 0.07]],
  southEnd:   [['southEnd', 0.80], ['brownstone', 0.12], ['commercial', 0.08]],
  financial:  [['stoneTower', 0.40], ['glassTower', 0.28], ['commercial', 0.24], ['loft', 0.08]],
  downtown:   [['commercial', 0.52], ['stoneTower', 0.22], ['loft', 0.14], ['glassTower', 0.12]],
  seaport:    [['seaport', 0.62], ['glassTower', 0.16], ['loft', 0.22]],
  fenway:     [['brownstone', 0.34], ['commercial', 0.34], ['tenement', 0.20], ['seaport', 0.12]],
  charlestown:[['tripleDecker', 0.46], ['federal', 0.28], ['tenement', 0.16], ['commercial', 0.10]],
  cambridge:  [['commercial', 0.36], ['tripleDecker', 0.28], ['federal', 0.18], ['loft', 0.18]],
  southBoston:[['tripleDecker', 0.52], ['tenement', 0.24], ['commercial', 0.24]],
  chinatown:  [['tenement', 0.52], ['commercial', 0.34], ['loft', 0.14]],
  westEnd:    [['commercial', 0.44], ['glassTower', 0.28], ['tenement', 0.28]],
  default:    [['commercial', 0.5], ['tenement', 0.3], ['federal', 0.2]],
};

function pickStyle(district, r) {
  const mix = DISTRICT_MIX[district] || DISTRICT_MIX.default;
  let t = r(), acc = 0;
  for (const [name, w] of mix) { acc += w; if (t <= acc) return name; }
  return mix[0][0];
}

/* -------------------------------------------------------------------------- */
/* Vertical profile                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Boston's real height profile, per district.
 *
 * This exists because `plot.maxHeight` cannot be used as a height. The city
 * publishes **one flat zoned height for an entire district** — every parcel in
 * the Financial District carries the same 240 m — so the old
 * `storeys = max(storeys, floor(fit * 0.62))` gave every tower in the district
 * the same fraction of the same number. The result was 479 buildings inside a
 * single 20 m band with a hard gap from 100–140 m, and a skyline that read as
 * one extruded slab. A flat envelope is a *ceiling*, not a design.
 *
 * `cap` is the real ceiling for generic infill and `tail` shapes the draw
 * underneath it. A city's height histogram is close to exponential — Boston has
 * thousands of 4–6 storey rowhouses, roughly forty buildings over 100 m and a
 * dozen over 150 m — so `tail` is the exponent on a 0..1 roll, and any value
 * above 1 pushes mass toward the bottom. Bigger `tail` = rarer tall building.
 *
 * `cap` deliberately stays under the landmarks. 200 Clarendon is 241 m and the
 * Prudential 229 m; if generic infill could reach them they would stop reading
 * as landmarks at all, which is the whole point of putting them in.
 *
 * `floor` only bites when the published envelope is *lower* than the district
 * could plausibly build. On the live parcel path it never does — the city only
 * ever emits the nine districts `RoadNetwork.ZONING` knows, and its numbers are
 * sane for all of them. It matters on the `Buildings.fallbackPlots` path, which
 * is the only source of `downtown`, `westEnd`, `chinatown` and `southBoston`.
 */
const DISTRICT_HEIGHT = {
  financial:   { floor:  60, cap: 188, tail: 3.9 },
  downtown:    { floor:  40, cap: 126, tail: 4.3 },
  westEnd:     { floor:  32, cap: 104, tail: 4.3 },
  chinatown:   { floor:  24, cap:  76, tail: 4.1 },
  backBay:     { floor:  20, cap:  62, tail: 4.6 },  // brownstone, rare tall infill
  beaconHill:  { floor:  14, cap:  23, tail: 3.0 },  // the protected low-rise
  northEnd:    { floor:  16, cap:  25, tail: 3.0 },
  southEnd:    { floor:  16, cap:  27, tail: 3.4 },
  seaport:     { floor:  24, cap: 104, tail: 3.4 },  // newest, so the flattest tail
  fenway:      { floor:  16, cap:  48, tail: 3.6 },
  charlestown: { floor:  11, cap:  19, tail: 3.0 },
  cambridge:   { floor:  18, cap:  68, tail: 3.8 },
  southBoston: { floor:  11, cap:  23, tail: 3.2 },
  default:     { floor:  16, cap:  42, tail: 3.4 },
};

/**
 * Where Boston's height actually is. Towers are not spread evenly across a
 * zoning district — they pile into two tight clusters, and everything between
 * them is low. Without this the Financial District becomes a uniform plateau
 * instead of a massing with a peak.
 */
const TOWER_CORES = [
  { lat: 42.3563, lon: -71.0565, r: 470 },   // Financial District
  { lat: 42.3480, lon: -71.0790, r: 400 },   // Back Bay: Hancock / Prudential
];
const _cores = TOWER_CORES.map((c) => {
  const p = geo(c.lat, c.lon);
  return { x: p.x, z: p.z, r: c.r };
});

/** 1 at the centre of the nearest tower cluster, 0 once you are outside it. */
function coreWeight(cx, cz) {
  let best = 0;
  for (const c of _cores) {
    const t = 1 - Math.hypot(cx - c.x, cz - c.z) / c.r;
    if (t > best) best = t;
  }
  return best > 0 ? best : 0;
}

/* -------------------------------------------------------------------------- */
/* Roofscape                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * From any elevated shot the roofs are half the frame, and a whole district
 * sharing one `St.roof` reads as a sea of cardboard. A real roofscape is a
 * patchwork: black felt beside pale ballast beside a silver-coated membrane
 * beside rusted standing seam, re-roofed in different decades.
 *
 * Every entry is an atlas layer that already exists, so the variety costs no
 * texture memory and no triangles — it is the highest value-per-byte change
 * available to the roofline.
 */
const ROOF_MIX = {
  roof_tar: [
    ['roof_tar', 0.42], ['roof_gravel', 0.20], ['metal_rust', 0.13],
    ['paint_green', 0.09], ['metal_panel', 0.08], ['concrete', 0.08],
  ],
  roof_gravel: [
    ['roof_gravel', 0.38], ['roof_tar', 0.24], ['concrete', 0.15],
    ['metal_panel', 0.13], ['metal_rust', 0.10],
  ],
  slate: [
    ['slate', 0.70], ['roof_tar', 0.15], ['metal_rust', 0.09], ['copper', 0.06],
  ],
};

/**
 * Mean tint and spread per roof surface. The spread matters more than the mean:
 * neighbouring roofs have to differ in *value*, or they merge into one plane no
 * matter how much clutter sits on them.
 */
const ROOF_VALUE = {
  roof_tar:    [0.56, 0.34],
  roof_gravel: [0.84, 0.42],
  concrete:    [0.76, 0.34],
  metal_panel: [0.90, 0.30],
  metal_rust:  [0.70, 0.38],
  paint_green: [0.66, 0.30],
  slate:       [0.88, 0.26],
  copper:      [0.90, 0.20],
};

/** The contrasting field a roof gets re-covered with. Never the same as the deck. */
const ROOF_PATCH = ['roof_tar', 'roof_gravel', 'concrete', 'metal_rust', 'paint_green'];

/**
 * Roof furniture scales with the deck it sits on. Shared by every tier so the
 * detailed mesh and the distant shell agree on unit size to the centimetre.
 */
const ROOF_UNIT_SCALE = (area) => Math.min(2.4, 0.90 + area / 700);

/* -------------------------------------------------------------------------- */
/* Keeping ornament on the building                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pull a point back inside a polygon along the ray from its centroid.
 *
 * Every roof item — bulkhead, HVAC unit, duct, vent, water tank, dish, skylight,
 * mast, chimney — used to be placed uniformly inside the deck's **axis-aligned
 * bounding box**. That is only the roof for a parcel whose sides happen to run
 * north/south. Boston's do not: Back Bay runs 14 deg off the cardinals, the North
 * End runs every which way, and a corridor clip leaves trapezoids. Measured over
 * a 425-building sample, 71,001 emitted vertices sat outside their own footprint,
 * the worst by **18.65 m** — packaged air-conditioning units and antenna masts
 * hanging in mid-air beside the roofline. The always-resident LOD-2 shell placed
 * them the same way, so they were in every distant frame as well.
 *
 * Clamping rather than re-rolling is deliberate: the position stays a pure
 * function of the same hash keys, so LOD 0, LOD 1 and the shell still resolve the
 * identical item at the identical spot, which is what stops roofs reshuffling as
 * you approach. `pad` keeps the item's own half-size clear of the parapet.
 *
 * Results land in `_fitX` / `_fitZ` — module scope, because this runs inside the
 * streaming build and must not allocate.
 */
let _fitX = 0, _fitZ = 0;
function fitInPoly(poly, cx, cz, x, z, pad) {
  const vx = x - cx, vz = z - cz;
  // Slide along centroid -> target until the point is `pad` clear of every edge
  // *line*. Perpendicular clearance, not ray length: a ray can leave a long thin
  // roof through the far end while running within centimetres of a long side.
  let t = 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let nx = b.z - a.z, nz = -(b.x - a.x);
    const L = Math.hypot(nx, nz);
    if (L < 1e-9) continue;
    nx /= L; nz /= L;
    let d0 = (cx - a.x) * nx + (cz - a.z) * nz;
    let dv = vx * nx + vz * nz;
    if (d0 < 0) { d0 = -d0; dv = -dv; }        // make the normal point inward
    if (dv >= -1e-9) continue;                 // moving away from this edge
    const lim = (pad - d0) / dv;
    if (lim < t) t = lim;
  }
  if (!(t > 0)) t = 0;
  _fitX = cx + vx * t; _fitZ = cz + vz * t;
}

/** Distance from `(cx,cz)` to the nearest edge line — how big an item may be. */
function inRadius(poly, cx, cz) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ez = b.z - a.z;
    const L = Math.hypot(ex, ez);
    if (L < 1e-9) continue;
    const d = Math.abs((cx - a.x) * (ez / L) - (cz - a.z) * (ex / L));
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Rooftop masts, shared by every tier so the distant shell puts the same mast in
 * the same place at the same height as the detailed mesh.
 *
 * A real skyline's top edge is defined by masts, and a tall building is far more
 * likely to carry one — it is the tall buildings that hold the transmitters.
 */
const mastChance = (spec) => (spec.h > 90 ? 0.62 : spec.h > 45 ? 0.40 : 0.26);
const mastHeight = (spec, u) => 3 + u * 5 + Math.min(15, spec.h * 0.075);

/**
 * Pick this building's roof surface and tone.
 * Driven by the *keyed* hash, not the sequential one, so adding it leaves every
 * other spec roll (bows, mansards, shopfronts) bit-for-bit unchanged.
 */
function pickRoof(base, rr) {
  const mix = ROOF_MIX[base] || ROOF_MIX.roof_gravel;
  let t = rr(0), acc = 0, surf = mix[0][0];
  for (const [k, w] of mix) { acc += w; if (t <= acc) { surf = k; break; } }
  const V = ROOF_VALUE[surf] || [0.80, 0.34];
  const v = Math.max(0.18, V[0] + (rr(1) - 0.5) * V[1]);
  const warm = (rr(2) - 0.5) * 0.15;
  const col = [v * (1 + warm), v, v * (1 - warm * 0.8)];

  // A re-covered field over most of the deck. Two triangles, and from above it
  // is the single strongest thing on the roof.
  let patch = null;
  if (rr(3) < 0.62) {
    const cand = ROOF_PATCH.filter(s => s !== surf);
    const ps = cand[Math.min(cand.length - 1, (rr(4) * cand.length) | 0)];
    const PV = ROOF_VALUE[ps] || [0.80, 0.34];
    const pv = Math.max(0.18, PV[0] + (rr(5) - 0.5) * PV[1]);
    // Reject a patch that would be invisible against the deck it sits on.
    if (Math.abs(pv - v) > 0.13) {
      patch = { surf: ps, col: [pv * (1 + warm * 0.5), pv, pv * (1 - warm * 0.4)] };
    }
  }
  return { surf, col, patch };
}

/* -------------------------------------------------------------------------- */
/* Spec generation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn a parcel into a full building spec.
 * @param {{id:*, polygon:Array<{x:number,z:number}>, district:string,
 *          zoning?:string, maxHeight?:number, frontage?:object}} plot
 * @param {number} baseY ground elevation under the parcel
 * @param {number} seed
 * @returns {object|null} spec, or null if the parcel is unbuildable
 */
export function makeSpec(plot, baseY, seed) {
  const r = rng(seed * 2654435761 % 2147483647 | 0);
  let poly = orientOutward(plot.polygon);
  if (poly.length < 3) return null;

  // Footprint metrics
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const w = maxX - minX, d = maxZ - minZ;
  if (w < 3.2 || d < 3.2) return null;
  const area = Math.abs(polyAreaOf(poly));
  if (area < 22) return null;

  const district = plot.district || 'downtown';
  let styleName = plot.style || pickStyle(district, r);
  const S = STYLES[styleName] || STYLES.commercial;

  // Storeys.
  const span = S.storeys[1] - S.storeys[0];
  let storeys = S.storeys[0] + Math.floor(r() * (span + 1));
  const groundH = S.groundH * (0.94 + r() * 0.12);
  const storeyH = S.storeyH * (0.96 + r() * 0.09);

  // The envelope. `plot.maxHeight` is a hint, not truth — see DISTRICT_HEIGHT
  // for why it cannot be trusted on its own — so bracket it by what the
  // district is really allowed to do.
  const HP = DISTRICT_HEIGHT[district] || DISTRICT_HEIGHT.default;
  const envelope = Math.min(HP.cap, Math.max(plot.maxHeight || 0, HP.floor));
  const fit = Math.max(2, Math.floor((envelope - groundH) / storeyH) + 1);
  storeys = Math.max(2, Math.min(storeys, fit));

  if (S.setbacks || S.curtain) {
    // Most parcels zoned for height never use it. Draw the tower's share of its
    // envelope from a power law so the mass sits low and the tail is genuinely
    // rare, then gate it on the two things that decide height in a real city:
    // how much land the parcel has, and how close it is to the tower cluster.
    // The previous `max(storeys, floor(fit * 0.62))` gave every tower the same
    // fraction of the same flat number, which is what welded the skyline shut.
    const c = polyCentroid(poly);
    const u = hash2(seed | 0, 991);
    const land = Math.min(1, Math.max(0, (area - 300) / 900));
    const core = coreWeight(c.x, c.z);
    const t = Math.pow(u, HP.tail) * (0.26 + 0.74 * land) * (0.34 + 0.66 * core);
    storeys = Math.max(storeys, Math.round(2 + (fit - 2) * t));
  }
  // A parcel too small for a tower gets a mid-rise instead of a pencil.
  if ((S.setbacks || S.curtain) && area < 420) {
    styleName = 'commercial';
    storeys = Math.min(storeys, 8);
  }
  const St = STYLES[styleName];
  const h = groundH + (storeys - 1) * storeyH;

  const toneIdx = Math.floor(r() * St.walls.length);
  const wallSurf = St.walls[toneIdx];
  const tone = St.tone[Math.min(toneIdx, St.tone.length - 1)];
  const jit = 0.94 + r() * 0.13;
  const wallCol = [tone[0] * jit, tone[1] * jit, tone[2] * jit];

  // Which edges front a street? Matching by outward *direction* rather than by
  // index, because `orientOutward` may have reversed the winding.
  const front = new Set();
  const dirs = plot.frontDirs
    || (plot.frontage && plot.frontage.dir ? [plot.frontage.dir] : null);
  if (dirs && dirs.length) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const nx = dz / L, nz = -dx / L;
      for (const dd of dirs) {
        const dl = Math.hypot(dd.x, dd.z) || 1;
        if ((nx * dd.x + nz * dd.z) / dl > 0.80) { front.add(i); break; }
      }
    }
  }
  if (!front.size && plot.frontage && Number.isInteger(plot.frontage.edge)) {
    front.add(plot.frontage.edge % poly.length);
  }
  if (!front.size && Array.isArray(plot.frontEdges)) {
    for (const i of plot.frontEdges) front.add(i % poly.length);
  }
  if (!front.size) {
    let best = 0, bestL = -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L > bestL) { bestL = L; best = i; }
    }
    front.add(best);
  }

  /* ---- Per-building setback jitter ------------------------------------ *
   * `754747a` put every facade on the frontage line and it worked — 86.6% of
   * buildings now address the street — but it over-corrected: the streetwall
   * came out flush to a 0.03 m per-street standard deviation. No real block is
   * that regular. Houses step, corner buildings hold the line, and the ones that
   * step back put an areaway in the gap.
   *
   * Only the FRONT edge moves, and only backwards. Moving the whole footprint
   * would open a slot between party walls; moving the front edge shortens the
   * flanks instead, so the row keeps its shared sides and gains a step at the
   * street corner — which is what a real row does. Backwards only, because
   * forwards is the pavement.
   */
  let setbackJit = 0;
  if (front.size && front.size < poly.length) {
    let mx = 0, mz = 0, nf = 0;
    for (const i of front) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      mx += (p0.x + p1.x) * 0.5; mz += (p0.z + p1.z) * 0.5; nf++;
    }
    mx /= nf; mz /= nf;
    // One component correlated over ~40 m, so a run of houses shares a building
    // line; one per house; and a rare deeper step.
    const blk = hash2(Math.round(mx / 41) | 0, Math.round(mz / 41) | 0);
    const own = hash2(seed | 0, 3307);
    const deep = hash2(seed | 0, 3308) < 0.10 ? 0.55 + hash2(seed | 0, 3309) * 0.95 : 0;
    setbackJit = Math.min(0.10 + blk * 0.55 + own * 0.45 + deep,
      0.22 * Math.min(w, d));            // never eat a small parcel
    const ox = new Float64Array(poly.length), oz = new Float64Array(poly.length);
    for (const i of front) {
      const j = (i + 1) % poly.length;
      const p0 = poly[i], p1 = poly[j];
      const ex = p1.x - p0.x, ez = p1.z - p0.z;
      const L = Math.hypot(ex, ez) || 1;
      const inx = (-ez / L) * setbackJit, inz = (ex / L) * setbackJit;
      ox[i] += inx; oz[i] += inz; ox[j] += inx; oz[j] += inz;
    }
    // New point objects, never a mutation: `poly` may alias the city's own parcel
    // ring, which props, traffic and the minimap all read.
    poly = poly.map((p, i) => ({ x: p.x + ox[i], z: p.z + oz[i] }));
  }

  const spec = {
    poly, base: baseY, style: styleName, S: St, setbackJit,
    storeys, storeyH, groundH, h, area, seed,
    wallSurf, wallCol, trimSurf: St.trim,
    trimCol: [0.98 + r() * 0.06, 0.97 + r() * 0.05, 0.94 + r() * 0.06],
    roofSurf: St.roof,
    front,
    // Geometry randomness must be keyed, never sequential: LOD 0, LOD 1 and the
    // shell are built at different times and must agree exactly or they z-fight.
    rnd: (k) => hash2(seed | 0, k | 0),
    bow: r() < (St.bow || 0) && w * d > 40,
    mansard: r() < (St.mansard || 0),
    shop: r() < (St.shop || 0),
    awning: r() < (St.awning || 0),
    fireEscape: r() < (St.fireEscape || 0),
    shutters: r() < (St.shutters || 0),
    dormers: r() < (St.dormers || 0),
    waterTank: r() < (St.waterTank || 0),
    laundry: r() < (St.laundry || 0),
    balcony: r() < (St.balcony || 0),
    arched: r() < (St.arched || 0),
    purpleGlass: r() < (St.purple || 0),
    gaslamp: r() < (St.gaslamp || 0),
    lit: 0.24 + r() * 0.46,
    uOff: r() * 6,            // per-building texture offset kills grid repetition
    parapet: 0.62 + r() * 0.75,
    mansardH: 2.7 + r() * 0.9,
    stoopH: St.basement ? 1.05 + r() * 0.6 : 0.28 + r() * 0.22,
  };
  spec.hasStoop = r() < (St.stoop || 0) && !spec.shop;
  if (spec.hasStoop) spec.base += 0;    // stoop rises from grade, mass starts above

  // Square/canted bay, and the areaway that fills the setback in front of it.
  // Keyed off `spec.rnd`, never the sequential `r()`, so adding them leaves every
  // pre-existing roll in this function bit-for-bit unchanged — and so LOD 0,
  // LOD 1 and `Buildings._fitOrnament` all resolve the same bay.
  spec.bay = !spec.bow && !spec.shop && (St.bay || 0) > 0 && w * d > 40
    && spec.rnd(8100) < St.bay;
  spec.bayProj = spec.bay ? 0.72 + spec.rnd(8101) * 0.42 : 0;
  spec.bayFromGround = spec.bay && !St.basement;
  spec.areaway = setbackJit > 0.42 && !spec.shop && !!St.basement;

  // Roof surface, tone and re-covered field. Keyed off `spec.rnd` rather than the
  // sequential `r()` so every tier — LOD 0, LOD 1 and the always-resident shell —
  // resolves the identical roof without having to pass anything between them.
  const roof = pickRoof(St.roof, (k) => spec.rnd(7000 + k));
  spec.roofSurf = roof.surf;
  spec.roofCol = roof.col;
  spec.roofPatch = roof.patch;

  // Setbacks for 1920s towers: real ziggurat massing.
  if (St.setbacks && h > 45) {
    spec.setbacks = [];
    let cur = 0;
    const n = 1 + Math.floor(r() * 2.4);
    for (let i = 0; i < n; i++) {
      cur += 0.42 + r() * 0.22;
      if (cur > 0.9) break;
      spec.setbacks.push({ t: cur, inset: 1.8 + r() * 3.2 });
    }
    if (r() < 0.55) spec.crown = true;
  }
  return spec;
}

function polyAreaOf(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a * 0.5;
}

/* -------------------------------------------------------------------------- */
/* Edge helpers                                                               */
/* -------------------------------------------------------------------------- */

function edgeFrame(A, B) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const L = Math.hypot(dx, dz) || 1e-6;
  return { ax: A.x, az: A.z, L, dx: dx / L, dz: dz / L, nx: dz / L, nz: -dx / L };
}
/** Point on an edge: `u` along, `y` up, `off` outward (negative = into wall). */
function P(e, u, y, off) {
  return [e.ax + e.dx * u + e.nx * (off || 0), y, e.az + e.dz * u + e.nz * (off || 0)];
}

/* -------------------------------------------------------------------------- */
/* Window module — reveal, pane, sill, lintel, shutters                       */
/* -------------------------------------------------------------------------- */

const WHITE = [1, 1, 1];

/**
 * One window with a real reveal. Emits the reveal box faces, a recessed pane and
 * (at LOD 0) a projecting stone sill, a lintel and optional shutters.
 * The caller has already left a hole in the wall band.
 */
function windowUnit(mb, gb, e, u0, u1, y0, y1, spec, o) {
  const dep = o.reveal;
  const s = spec.trimSurf;
  const tc = spec.trimCol;

  // Jambs (left faces +u, right faces -u), then head soffit and sill bed. The
  // soffit and bed are sub-pixel past ~200 m, so LOD 1 keeps only the jambs —
  // the reveal shadow still reads, at 40% of the triangles.
  const uvJ = [0, 0, dep, 0, dep, y1 - y0, 0, y1 - y0];
  mb.quadAuto(P(e, u0, y0, 0), P(e, u0, y0, -dep), P(e, u0, y1, -dep), P(e, u0, y1, 0),
    e.dx, 0, e.dz, uvJ, o.jambCol || spec.wallCol, o.jambSurf || spec.wallSurf);
  mb.quadAuto(P(e, u1, y0, 0), P(e, u1, y0, -dep), P(e, u1, y1, -dep), P(e, u1, y1, 0),
    -e.dx, 0, -e.dz, uvJ, o.jambCol || spec.wallCol, o.jambSurf || spec.wallSurf);
  if (o.lod === 0) {
    const uvH = [0, 0, u1 - u0, 0, u1 - u0, dep, 0, dep];
    mb.quadAuto(P(e, u0, y1, 0), P(e, u1, y1, 0), P(e, u1, y1, -dep), P(e, u0, y1, -dep),
      0, -1, 0, uvH, tc, s);
    mb.quadAuto(P(e, u0, y0, 0), P(e, u1, y0, 0), P(e, u1, y0, -dep), P(e, u0, y0, -dep),
      0, 1, 0, uvH, tc, s);
  }

  // The pane itself, set back the full reveal depth.
  const a = P(e, u0 + 0.03, y0 + 0.03, -dep);
  const b = P(e, u1 - 0.03, y0 + 0.03, -dep);
  const c = P(e, u1 - 0.03, y1 - 0.03, -dep);
  const d = P(e, u0 + 0.03, y1 - 0.03, -dep);
  const kind = o.kind + (o.purple ? 8 : 0);
  gb.pane(a, b, c, d, [e.nx, 0, e.nz], [e.dx, 0, e.dz],
    Math.max(0.6, u1 - u0), Math.max(0.6, y1 - y0), o.roomDepth || 3.0,
    o.seed, o.lit, kind, o.frameCol || [0.86, 0.85, 0.82]);

  if (o.lod > 0) return;

  const mid = (u0 + u1) * 0.5;
  const wpt = P(e, mid, 0, 0);
  const rot = Math.atan2(e.nx, e.nz);

  // Projecting sill with a drip edge, and a lintel or flat arch above.
  if (o.sill !== false) {
    mb.box(wpt[0] + e.nx * 0.055, y0 - 0.055, wpt[2] + e.nz * 0.055,
      (u1 - u0) + 0.34, 0.11, 0.22, rot, s, tc);
  }
  if (o.lintel !== false) {
    mb.box(wpt[0] + e.nx * 0.035, y1 + 0.10, wpt[2] + e.nz * 0.035,
      (u1 - u0) + 0.28, 0.20, 0.13, rot, s, tc);
  }
  if (o.shutters) {
    const sw = (u1 - u0) * 0.5;
    for (const side of [-1, 1]) {
      const su = mid + side * ((u1 - u0) * 0.5 + sw * 0.5 + 0.03);
      const sp = P(e, su, 0, 0.035);
      mb.box(sp[0], (y0 + y1) * 0.5, sp[2], sw, (y1 - y0) * 0.98, 0.05,
        rot, 'wood_dark', [0.42, 0.46, 0.44]);
    }
  }
}

/**
 * Segmental arch over a window head: the wall spandrels above the curve, the
 * curved reveal soffit, and a dark tympanum pane. Topologically closed — no
 * holes in the wall, which a naive "cut an arc" approach always leaves.
 */
function archTop(mb, e, u0, u1, yHead, rise, spec, dep) {
  const seg = 6;
  const cu = (u0 + u1) * 0.5, rad = (u1 - u0) * 0.5;
  const s = spec.trimSurf, tc = spec.trimCol;
  const ws = spec.wallSurf, wc = spec.wallCol;
  const yTop = yHead + rise;
  const curve = (u) => yHead + Math.sqrt(Math.max(0, 1 - ((u - cu) / rad) ** 2)) * rise;
  for (let i = 0; i < seg; i++) {
    const a0 = u0 + (u1 - u0) * (i / seg);
    const a1 = u0 + (u1 - u0) * ((i + 1) / seg);
    const y0 = curve(a0), y1 = curve(a1);
    // wall spandrel between the arc and the storey line
    mb.quadAuto(P(e, a0, y0, 0), P(e, a1, y1, 0), P(e, a1, yTop, 0), P(e, a0, yTop, 0),
      e.nx, 0, e.nz, [a0 / 2, y0 / 2, a1 / 2, y1 / 2, a1 / 2, yTop / 2, a0 / 2, yTop / 2],
      wc, ws);
    // curved reveal soffit
    mb.quadAuto(P(e, a0, y0, 0), P(e, a1, y1, 0), P(e, a1, y1, -dep), P(e, a0, y0, -dep),
      0, -1, 0, [0, 0, 0.4, 0, 0.4, dep, 0, dep], tc, s);
    // tympanum: dark glazed fan behind the arch
    mb.quadAuto(P(e, a0, yHead, -dep), P(e, a1, yHead, -dep),
      P(e, a1, y1, -dep), P(e, a0, y0, -dep),
      e.nx, 0, e.nz, [0, 0, 0.4, 0, 0.4, 0.4, 0, 0.4], [0.5, 0.55, 0.62], 'spandrel');
  }
  // keystone
  const kp = P(e, cu, 0, 0.07);
  mb.box(kp[0], yTop - 0.10, kp[2], 0.26, 0.44, 0.16, Math.atan2(e.nx, e.nz), s, tc);
}

/* -------------------------------------------------------------------------- */
/* Storey bands                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A single storey of the street facade across [uS,uE]: piers, spandrels,
 * headers and one window per bay.
 */
function frontStorey(mb, gb, e, uS, uE, y0, y1, spec, sIdx, lod) {
  const St = spec.S;
  const L = uE - uS;
  const bays = Math.max(1, Math.round(L / St.bayW));
  const bw = L / bays;
  const winW = Math.min(St.winW, bw * 0.62);
  const hgt = y1 - y0;
  const winH = Math.min(St.winH * (sIdx === 0 ? 1.04 : (sIdx > 3 ? 0.88 : 1.0)), hgt - 0.95);
  const sill = y0 + St.sillH;
  const head = sill + winH;
  const useArch = spec.arched && sIdx === (St.basement ? 1 : 0);
  const wc = spec.wallCol, ws = spec.wallSurf;
  const uo = spec.uOff;
  const vo = 0;

  const rise = useArch ? Math.min(winW * 0.42, Math.max(0.1, y1 - head - 0.35)) : 0;
  for (let i = 0; i < bays; i++) {
    const bu0 = uS + i * bw, bu1 = bu0 + bw;
    const wu0 = (bu0 + bu1) * 0.5 - winW * 0.5;
    const wu1 = wu0 + winW;
    // piers either side of the opening
    band(mb, e, bu0, wu0, y0, y1, ws, wc, uo, vo);
    band(mb, e, wu1, bu1, y0, y1, ws, wc, uo, vo);
    // spandrel below and header above
    band(mb, e, wu0, wu1, y0, sill, ws, wc, uo, vo);
    band(mb, e, wu0, wu1, head + rise, y1, ws, wc, uo, vo);
    if (useArch) archTop(mb, e, wu0, wu1, head, rise, spec, St.reveal);

    const seed = hash2(spec.seed + sIdx * 37, i * 911 + ((bu0 * 13) | 0));
    // Above about eight storeys a 110 mm sill is smaller than a pixel from the
    // street, so tall buildings drop to the cheap window module up top. This is
    // what keeps a 20-storey stone tower from costing 12,000 triangles.
    const wlod = (y0 - spec.base) > 24 ? Math.max(lod, 1) : lod;
    windowUnit(mb, gb, e, wu0, wu1, sill, head, spec, {
      reveal: St.reveal, kind: St.winKind, lod: wlod,
      seed, lit: spec.lit, roomDepth: 2.6 + seed * 2.2,
      purple: spec.purpleGlass && sIdx <= 1 && seed > 0.55,
      shutters: spec.shutters && wlod === 0 && sIdx > 0,
      frameCol: St.curtain ? [0.30, 0.32, 0.34] : [0.88, 0.87, 0.83],
    });
  }
}

/** Plain wall band between two u positions. */
function band(mb, e, u0, u1, y0, y1, surf, col, uo, vo) {
  if (u1 - u0 < 0.006 || y1 - y0 < 0.006) return;
  const a = P(e, u0, y0, 0), b = P(e, u1, y0, 0);
  mb.wall(a[0], a[2], b[0], b[2], y0, y1, surf, col, uo + u0, vo);
}

/**
 * Curtain-wall storey: spandrel bands, one shader-subdivided glazing pane for
 * the whole band, and real projecting mullion fins only where you can see them.
 *
 * The pane uses `kind 5`, which splits itself into a full mullion grid in the
 * fragment shader — every cell still gets its own room interior and its own
 * night light. A 40-storey tower's glazing is therefore ~160 quads instead of
 * ~10,000, which is the difference between shipping and not.
 */
function curtainStorey(mb, gb, e, uS, uE, y0, y1, spec, sIdx, lod) {
  const St = spec.S;
  const L = uE - uS;
  const spand = 0.94;
  const gy0 = y0 + spand, gy1 = y1 - 0.16;
  if (gy1 - gy0 < 0.3 || L < 0.3) return;
  const rot = Math.atan2(e.nx, e.nz);
  const dep = 0.13;

  band(mb, e, uS, uE, y0, gy0, 'spandrel', [0.86, 0.90, 0.96], spec.uOff, 0);
  band(mb, e, uS, uE, gy1, y1, 'spandrel', [0.86, 0.90, 0.96], spec.uOff, 0);

  gb.pane(P(e, uS + 0.05, gy0, -dep), P(e, uE - 0.05, gy0, -dep),
    P(e, uE - 0.05, gy1, -dep), P(e, uS + 0.05, gy1, -dep),
    [e.nx, 0, e.nz], [e.dx, 0, e.dz], L - 0.1, gy1 - gy0,
    3.4 + hash2(spec.seed, sIdx * 53) * 2.4, hash2(spec.seed + 5, sIdx * 53),
    spec.lit * 0.9, 5, [0.26, 0.28, 0.31]);

  // Reveal cheeks at the ends of the band so the glass sits behind the frame.
  const uvJ = [0, 0, dep, 0, dep, gy1 - gy0, 0, gy1 - gy0];
  mb.quadAuto(P(e, uS, gy0, 0), P(e, uS, gy0, -dep), P(e, uS, gy1, -dep), P(e, uS, gy1, 0),
    e.dx, 0, e.dz, uvJ, [0.5, 0.52, 0.55], 'metal_dark');
  mb.quadAuto(P(e, uE, gy0, 0), P(e, uE, gy0, -dep), P(e, uE, gy1, -dep), P(e, uE, gy1, 0),
    -e.dx, 0, -e.dz, uvJ, [0.5, 0.52, 0.55], 'metal_dark');

  // Projecting fins only on the storeys you can actually stand next to; higher
  // up the shader's mullion grid carries the reading on its own.
  if (lod === 0 && y0 - spec.base < 26) {
    const bays = Math.max(1, Math.round(L / St.bayW));
    const bw = L / bays;
    for (let i = 0; i <= bays; i++) {
      const p = P(e, uS + i * bw, 0, 0.10);
      mb.box(p[0], (y0 + y1) * 0.5, p[2], 0.10, y1 - y0, 0.24, rot,
        'metal_dark', [0.62, 0.64, 0.66]);
    }
  }
  if (lod === 0) {
    const pf = P(e, (uS + uE) * 0.5, 0, 0.055);
    mb.box(pf[0], gy0 - 0.06, pf[2], L, 0.10, 0.15, rot, 'metal_dark', [0.62, 0.64, 0.66]);
  }
}

/* -------------------------------------------------------------------------- */
/* Ground floor: shopfronts                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A real shopfront: stall riser, big glazing set back behind pilasters, a
 * recessed doorway, a fascia sign that lights at night and often an awning.
 */
function shopfront(mb, gb, e, uS, uE, y0, y1, spec, lod) {
  let kk = 2000;
  const r = () => spec.rnd(kk++);
  const L = uE - uS;
  const fascia = 0.78;
  const topGlass = y1 - fascia - 0.16;
  const riser = 0.55;
  const rot = Math.atan2(e.nx, e.nz);
  const units = Math.max(1, Math.round(L / (7.5 + r() * 4)));
  const uw = L / units;
  const pil = 0.34;

  // Past ~200 m a shopfront is a dark glazed band under a lit fascia. Building
  // the pilasters, reveals, recessed doors and awnings out there costs ~250
  // triangles a unit and resolves to nothing.
  if (lod > 0) {
    const rot1 = Math.atan2(e.nx, e.nz);
    band(mb, e, uS, uE, y0, y0 + riser, 'granite', [0.72, 0.70, 0.68], spec.uOff, 0);
    band(mb, e, uS, uE, topGlass, y1, spec.wallSurf, spec.wallCol, spec.uOff, 0);
    for (let k = 0; k < units; k++) {
      const su = uS + k * uw;
      const seed = hash2(spec.seed + 7717, k * 173 + ((su * 7) | 0));
      gb.pane(P(e, su + 0.25, y0 + riser, -0.12), P(e, su + uw - 0.25, y0 + riser, -0.12),
        P(e, su + uw - 0.25, topGlass, -0.12), P(e, su + 0.25, topGlass, -0.12),
        [e.nx, 0, e.nz], [e.dx, 0, e.dz], uw - 0.5, topGlass - y0 - riser,
        4.2, seed, 0.86, 3, [0.30, 0.30, 0.32]);
      const cp = P(e, su + uw * 0.5, 0, 0.09);
      mb.box(cp[0], y1 - fascia * 0.5 - 0.10, cp[2], uw - 0.10, fascia * 0.80, 0.16,
        rot1, 'sign', [1, 1, 1], 1.0);
    }
    return;
  }

  for (let k = 0; k < units; k++) {
    const su = uS + k * uw, eu = su + uw;
    const seed = hash2(spec.seed + 7717, k * 173 + ((su * 7) | 0));
    // pilasters
    band(mb, e, su, su + pil, y0, y1 - fascia, spec.wallSurf, spec.wallCol, spec.uOff, 0);
    band(mb, e, eu - pil, eu, y0, y1 - fascia, spec.wallSurf, spec.wallCol, spec.uOff, 0);

    const gu0 = su + pil, gu1 = eu - pil;
    const doorW = Math.min(1.15, (gu1 - gu0) * 0.28);
    const doorAt = seed > 0.5 ? gu0 + 0.12 : gu1 - doorW - 0.12;
    const dep = 0.20, ddep = 0.62;

    // stall riser and window head band
    band(mb, e, gu0, gu1, y0, y0 + riser, 'granite', [0.72, 0.70, 0.68], spec.uOff, 0);
    band(mb, e, gu0, gu1, topGlass, y1 - fascia, spec.wallSurf, spec.wallCol, spec.uOff, 0);

    // glazing either side of the recessed door
    const segs = doorAt > (gu0 + gu1) * 0.5
      ? [[gu0, doorAt], [doorAt + doorW, gu1]]
      : [[gu0, doorAt], [doorAt + doorW, gu1]];
    for (const [a0, a1] of segs) {
      if (a1 - a0 < 0.5) continue;
      const uvJ = [0, 0, dep, 0, dep, topGlass - y0 - riser, 0, topGlass - y0 - riser];
      mb.quadAuto(P(e, a0, y0 + riser, 0), P(e, a0, y0 + riser, -dep),
        P(e, a0, topGlass, -dep), P(e, a0, topGlass, 0),
        e.dx, 0, e.dz, uvJ, [0.55, 0.55, 0.55], 'metal_dark');
      mb.quadAuto(P(e, a1, y0 + riser, 0), P(e, a1, y0 + riser, -dep),
        P(e, a1, topGlass, -dep), P(e, a1, topGlass, 0),
        -e.dx, 0, -e.dz, uvJ, [0.55, 0.55, 0.55], 'metal_dark');
      mb.quadAuto(P(e, a0, topGlass, 0), P(e, a1, topGlass, 0),
        P(e, a1, topGlass, -dep), P(e, a0, topGlass, -dep),
        0, -1, 0, [0, 0, a1 - a0, 0, a1 - a0, dep, 0, dep], [0.5, 0.5, 0.5], 'metal_dark');
      gb.pane(P(e, a0 + 0.04, y0 + riser + 0.04, -dep), P(e, a1 - 0.04, y0 + riser + 0.04, -dep),
        P(e, a1 - 0.04, topGlass - 0.04, -dep), P(e, a0 + 0.04, topGlass - 0.04, -dep),
        [e.nx, 0, e.nz], [e.dx, 0, e.dz], a1 - a0, topGlass - y0 - riser,
        4.2, seed + k * 0.13, 0.86, 3, [0.30, 0.30, 0.32]);
    }

    // recessed doorway with a reveal you can actually stand in
    const uvD = [0, 0, ddep, 0, ddep, topGlass - y0, 0, topGlass - y0];
    mb.quadAuto(P(e, doorAt, y0, 0), P(e, doorAt, y0, -ddep),
      P(e, doorAt, topGlass, -ddep), P(e, doorAt, topGlass, 0),
      e.dx, 0, e.dz, uvD, spec.wallCol, spec.wallSurf);
    mb.quadAuto(P(e, doorAt + doorW, y0, 0), P(e, doorAt + doorW, y0, -ddep),
      P(e, doorAt + doorW, topGlass, -ddep), P(e, doorAt + doorW, topGlass, 0),
      -e.dx, 0, -e.dz, uvD, spec.wallCol, spec.wallSurf);
    mb.quadAuto(P(e, doorAt, topGlass, 0), P(e, doorAt + doorW, topGlass, 0),
      P(e, doorAt + doorW, topGlass, -ddep), P(e, doorAt, topGlass, -ddep),
      0, -1, 0, [0, 0, doorW, 0, doorW, ddep, 0, ddep], [0.5, 0.5, 0.5], 'metal_dark');
    mb.quadAuto(P(e, doorAt, y0 + 0.02, 0), P(e, doorAt + doorW, y0 + 0.02, 0),
      P(e, doorAt + doorW, y0 + 0.02, -ddep), P(e, doorAt, y0 + 0.02, -ddep),
      0, 1, 0, [0, 0, doorW, 0, doorW, ddep, 0, ddep], [0.62, 0.62, 0.60], 'granite');
    gb.pane(P(e, doorAt + 0.06, y0 + 0.10, -ddep), P(e, doorAt + doorW - 0.06, y0 + 0.10, -ddep),
      P(e, doorAt + doorW - 0.06, topGlass - 0.08, -ddep), P(e, doorAt + 0.06, topGlass - 0.08, -ddep),
      [e.nx, 0, e.nz], [e.dx, 0, e.dz], doorW, topGlass - y0, 3.6,
      seed * 0.77 + 0.11, 0.9, 3, [0.24, 0.22, 0.20]);

    // fascia sign — emissive at night
    const cp = P(e, (su + eu) * 0.5, 0, 0.09);
    mb.box(cp[0], y1 - fascia * 0.5 - 0.10, cp[2], uw - 0.10, fascia * 0.80, 0.16,
      rot, 'sign', [1, 1, 1], 1.0);
    if (lod === 0) {
      // small projecting blade sign
      if (seed > 0.62) {
        const bp = P(e, su + uw * 0.22, 0, 0.44);
        mb.box(bp[0], y1 - fascia - 0.85, bp[2], 0.06, 0.62, 0.80, rot,
          'sign', [1, 1, 1], 0.9);
        mb.box(bp[0], y1 - fascia - 0.30, bp[2], 0.05, 0.5, 0.05, rot,
          'metal_dark', [0.4, 0.4, 0.4]);
      }
    }

    // awning
    if (spec.awning && seed > 0.28) {
      const proj = 1.25;
      const ay = y1 - fascia - 0.12;
      const a0 = P(e, su + 0.12, ay, 0), a1 = P(e, eu - 0.12, ay, 0);
      const b0 = P(e, su + 0.12, ay - 0.72, proj), b1 = P(e, eu - 0.12, ay - 0.72, proj);
      mb.quadAuto(a0, a1, b1, b0, e.nx, 0.55, e.nz,
        [0, 0, uw, 0, uw, 1.45, 0, 1.45], [1, 1, 1], 'awning');
      mb.quadAuto(a0, a1, b1, b0, -e.nx, -0.55, -e.nz,
        [0, 0, uw, 0, uw, 1.45, 0, 1.45], [0.55, 0.53, 0.5], 'awning');
      // valance
      mb.quadAuto(b0, b1, [b1[0], b1[1] - 0.26, b1[2]], [b0[0], b0[1] - 0.26, b0[2]],
        e.nx, 0, e.nz, [0, 0, uw, 0, uw, 0.26, 0, 0.26], [1, 1, 1], 'awning');
      if (lod === 0) for (const su2 of [su + 0.12, eu - 0.12]) {
        const sp = P(e, su2, 0, proj * 0.5);
        mb.box(sp[0], ay - 0.36, sp[2], 0.05, 0.05, proj, rot, 'metal_dark', [0.35, 0.35, 0.35]);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entrances: stoops, doors, fanlights                                        */
/* -------------------------------------------------------------------------- */

function entrance(mb, gb, e, u, y0, spec, lod) {
  const St = spec.S;
  let kk = 3000;
  const r = () => spec.rnd(kk++);
  const rise = spec.stoopH;
  const rot = Math.atan2(e.nx, e.nz);
  const dw = 1.12, dh = 2.35;
  const dep = 0.42;
  // The entablature over the door is dw + 0.86 wide and the gaslamp hangs another
  // 0.5 m past it, so a doorway placed at the midpoint of a short wall — a bow
  // segment is ~1.1 m — used to push its own surround off the end of the facade.
  const halfSpan = lod === 0 ? 1.10 : dw * 0.5 + 0.30;
  if (e.L < halfSpan * 2 + 0.1) return;
  u = Math.min(Math.max(u, halfSpan), e.L - halfSpan);
  const u0 = u - dw * 0.5, u1 = u + dw * 0.5;
  const dy0 = y0 + rise;

  // doorway reveal
  const uvJ = [0, 0, dep, 0, dep, dh, 0, dh];
  mb.quadAuto(P(e, u0, dy0, 0), P(e, u0, dy0, -dep), P(e, u0, dy0 + dh, -dep), P(e, u0, dy0 + dh, 0),
    e.dx, 0, e.dz, uvJ, spec.trimCol, spec.trimSurf);
  mb.quadAuto(P(e, u1, dy0, 0), P(e, u1, dy0, -dep), P(e, u1, dy0 + dh, -dep), P(e, u1, dy0 + dh, 0),
    -e.dx, 0, -e.dz, uvJ, spec.trimCol, spec.trimSurf);
  mb.quadAuto(P(e, u0, dy0 + dh, 0), P(e, u1, dy0 + dh, 0),
    P(e, u1, dy0 + dh, -dep), P(e, u0, dy0 + dh, -dep),
    0, -1, 0, [0, 0, dw, 0, dw, dep, 0, dep], spec.trimCol, spec.trimSurf);
  // the door leaf
  const dcol = [[0.16, 0.20, 0.24], [0.22, 0.14, 0.12], [0.14, 0.16, 0.14], [0.10, 0.10, 0.12]][
    Math.floor(r() * 4)];
  const dp = P(e, u, 0, -dep + 0.05);
  mb.box(dp[0], dy0 + dh * 0.46, dp[2], dw - 0.16, dh * 0.90, 0.09, rot, 'wood_dark', dcol);
  if (lod === 0) {
    // raised panels + a brass knob
    for (let i = 0; i < 2; i++) {
      const pp = P(e, u, 0, -dep + 0.11);
      mb.box(pp[0], dy0 + 0.55 + i * 1.05, pp[2], dw - 0.42, 0.72, 0.03, rot,
        'wood_dark', [dcol[0] * 1.25, dcol[1] * 1.25, dcol[2] * 1.25]);
    }
    const kp = P(e, u + dw * 0.28, 0, -dep + 0.13);
    mb.box(kp[0], dy0 + 1.05, kp[2], 0.09, 0.09, 0.06, rot, 'gold', [1, 0.95, 0.7]);
  }
  // fanlight or transom over the door
  if (St.fanlight) {
    gb.pane(P(e, u0 + 0.10, dy0 + dh * 0.92, -dep + 0.02),
      P(e, u1 - 0.10, dy0 + dh * 0.92, -dep + 0.02),
      P(e, u1 - 0.10, dy0 + dh - 0.04, -dep + 0.02),
      P(e, u0 + 0.10, dy0 + dh - 0.04, -dep + 0.02),
      [e.nx, 0, e.nz], [e.dx, 0, e.dz], dw, 0.5, 0.9,
      hash2(spec.seed, 4441), 0.9, 0, [0.94, 0.93, 0.90]);
  }
  // door surround: pilasters + entablature
  if (lod === 0) {
    for (const side of [-1, 1]) {
      const sp = P(e, u + side * (dw * 0.5 + 0.16), 0, 0.09);
      mb.box(sp[0], dy0 + dh * 0.5, sp[2], 0.26, dh + 0.12, 0.18, rot,
        spec.trimSurf, spec.trimCol);
    }
    const ep = P(e, u, 0, 0.13);
    mb.box(ep[0], dy0 + dh + 0.22, ep[2], dw + 0.86, 0.30, 0.30, rot,
      spec.trimSurf, spec.trimCol);
    if (spec.gaslamp) {
      const gp = P(e, u + dw * 0.5 + 0.42, 0, 0.20);
      mb.box(gp[0], dy0 + 2.15, gp[2], 0.05, 0.05, 0.36, rot, 'metal_dark', [0.3, 0.3, 0.3]);
      const lp = P(e, u + dw * 0.5 + 0.42, 0, 0.42);
      mb.box(lp[0], dy0 + 2.00, lp[2], 0.20, 0.30, 0.20, rot, 'sign', [1, 0.86, 0.6], 1.3);
      mb.box(lp[0], dy0 + 2.18, lp[2], 0.24, 0.08, 0.24, rot, 'metal_dark', [0.3, 0.3, 0.3]);
    }
    if (St.bootScraper) {
      const bp = P(e, u - dw * 0.5 - 0.30, 0, 0.16);
      mb.box(bp[0], y0 + 0.16, bp[2], 0.04, 0.30, 0.20, rot, 'metal_dark', [0.28, 0.28, 0.28]);
    }
  }

  // The stoop itself
  if (rise > 0.5) {
    if (lod > 0) {
      const run = Math.max(3, Math.round(rise / 0.175)) * 0.30;
      const sp = P(e, u, 0, run * 0.5);
      mb.box(sp[0], y0 + rise * 0.5, sp[2], dw + 0.5, rise, run, rot,
        'granite', [0.78, 0.77, 0.74], 0, false);
      return;
    }
    const steps = Math.max(3, Math.round(rise / 0.175));
    const sh = rise / steps, sd = 0.30;
    const sw = dw + 0.5;
    for (let i = 0; i < steps; i++) {
      const proj = (steps - i) * sd;
      const sp = P(e, u, 0, proj * 0.5);
      mb.box(sp[0], y0 + sh * (i + 0.5), sp[2], sw, sh, proj, rot,
        'granite', [0.78, 0.77, 0.74], 0, false);
    }
    if (lod === 0) {
      // Wrought-iron railings. Back Bay and Beacon Hill are unreadable without
      // them, so they stay — but at four balusters a side, not eight.
      const run = steps * sd;
      const IRON = [0.20, 0.20, 0.21];
      for (const side of [-1, 1]) {
        const su = u + side * sw * 0.5;
        for (let i = 0; i <= 4; i++) {
          const t = i / 4;
          const bp = P(e, su, 0, run * (1 - t) + 0.08);
          mb.box(bp[0], y0 + 0.22 + rise * t + 0.42, bp[2], 0.035, 0.85, 0.035,
            rot, 'metal_dark', IRON);
        }
        // sloped handrail, as a genuine raked ribbon rather than a level box
        const a0 = P(e, su, y0 + 1.10, run + 0.08);
        const b0 = P(e, su, y0 + rise + 1.10, 0.08);
        mb.quadAuto(a0, b0, [b0[0], b0[1] + 0.07, b0[2]], [a0[0], a0[1] + 0.07, a0[2]],
          e.dx * side, 0, e.dz * side, [0, 0, 1.4, 0, 1.4, 0.1, 0, 0.1], IRON, 'metal_dark');
        mb.quadAuto([a0[0], a0[1] + 0.07, a0[2]], [b0[0], b0[1] + 0.07, b0[2]],
          [b0[0], b0[1] + 0.07, b0[2]], [a0[0], a0[1] + 0.07, a0[2]],
          0, 1, 0, [0, 0, 1.4, 0, 1.4, 0.1, 0, 0.1], IRON, 'metal_dark');
        const np = P(e, su, 0, run + 0.08);
        mb.box(np[0], y0 + 0.62, np[2], 0.09, 1.24, 0.09, rot, 'metal_dark', IRON);
        const np2 = P(e, su, 0, 0.08);
        mb.box(np2[0], y0 + rise + 0.62, np2[2], 0.09, 1.24, 0.09, rot, 'metal_dark', IRON);
      }
    }
  }

  // basement / garden-level door under the stoop
  if (St.basement && rise > 0.9) {
    const bu0 = u - 0.5, bu1 = u + 0.5;
    const uvB = [0, 0, 0.35, 0, 0.35, 1.95, 0, 1.95];
    mb.quadAuto(P(e, bu0, y0, 0), P(e, bu0, y0, -0.35), P(e, bu0, y0 + 1.95, -0.35),
      P(e, bu0, y0 + 1.95, 0), e.dx, 0, e.dz, uvB, spec.wallCol, spec.wallSurf);
    mb.quadAuto(P(e, bu1, y0, 0), P(e, bu1, y0, -0.35), P(e, bu1, y0 + 1.95, -0.35),
      P(e, bu1, y0 + 1.95, 0), -e.dx, 0, -e.dz, uvB, spec.wallCol, spec.wallSurf);
    const bp = P(e, u, 0, -0.30);
    mb.box(bp[0], y0 + 0.98, bp[2], 0.94, 1.94, 0.08, rot, 'wood_dark', [0.14, 0.15, 0.16]);
  }
}

/**
 * The areaway: granite kerb and iron rail along the property line, with the
 * basement light-well behind it.
 *
 * This is what a Boston rowhouse actually puts in front of itself, and it is why
 * the setback jitter does not read as a suburban gap. A house pulled 0.8 m back
 * off the pavement with nothing in the gap looks like a mistake; the same house
 * with a rail on the line and its stoop bridging the well looks like Marlborough
 * Street. The rail is broken for the steps, which is where a real one stops too.
 */
function areaway(mb, e, spec, gapU, gapW) {
  const off = Math.max(0.22, spec.setbackJit - 0.14);
  const rot = Math.atan2(e.nx, e.nz);
  // `_buildSpecs` sets `base = ground - 0.25` so nothing can float; grade is
  // therefore 0.25 m up. The forecourt is RAISED 0.12 m rather than sunk: a sunk
  // well would need a hole in the terrain, which belongs to another system, and
  // a floor at grade would z-fight the ground mesh.
  const g = spec.base + 0.25;
  const IRON = [0.20, 0.20, 0.21];
  const runs = [[0.07, Math.min(gapU - gapW * 0.5, e.L - 0.07)],
                [Math.max(gapU + gapW * 0.5, 0.07), e.L - 0.07]];
  for (const [r0, r1] of runs) {
    const L = r1 - r0;
    if (L < 0.7) continue;
    const c = P(e, (r0 + r1) * 0.5, 0, off);
    // Granite retaining kerb on the property line, buried 0.24 m, showing 0.12 m.
    mb.box(c[0], g - 0.06, c[2], L, 0.36, 0.30, rot, 'granite', [0.74, 0.73, 0.70]);
    // The forecourt slab behind it.
    mb.quadAuto(P(e, r0, g + 0.12, 0.02), P(e, r1, g + 0.12, 0.02),
      P(e, r1, g + 0.12, off), P(e, r0, g + 0.12, off),
      0, 1, 0, [0, 0, L / 2, 0, L / 2, off / 2, 0, off / 2],
      [0.66, 0.65, 0.62], 'granite');
    // Iron rail on the kerb: the single most recognisable thing on a Back Bay
    // frontage after the bow itself.
    mb.box(c[0], g + 1.02, c[2], L, 0.07, 0.07, rot, 'metal_dark', IRON);
    const n = Math.max(1, Math.round(L / 1.35));
    for (let i = 0; i <= n; i++) {
      const pp = P(e, r0 + (L * i) / n, 0, off);
      mb.box(pp[0], g + 0.58, pp[2], 0.05, 1.00, 0.05, rot, 'metal_dark', IRON);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fire escapes — the North End's signature                                   */
/* -------------------------------------------------------------------------- */

function fireEscape(mb, e, u, spec, lod) {
  const y0 = spec.base + spec.groundH;
  const rot = Math.atan2(e.nx, e.nz);
  // A 2.30 m platform on a 1.1 m bow segment or a narrow North End frontage used
  // to hang half a metre past the corner of the building. Fit it to the wall it
  // is bolted to, and centre it there.
  const pd = 1.05;
  const pw = Math.min(2.30, e.L - 0.24);
  if (pw < 0.9) return;
  u = Math.min(Math.max(u, pw * 0.5 + 0.12), e.L - pw * 0.5 - 0.12);
  const proj = pd * 0.5 + 0.06;
  const surf = spec.rnd(4001) < 0.4 ? 'metal_rust' : 'metal_dark';
  const col = surf === 'metal_rust' ? [0.9, 0.85, 0.8] : [0.30, 0.31, 0.32];

  for (let s = 0; s < spec.storeys - 1; s++) {
    const py = y0 + s * spec.storeyH;
    const c = P(e, u, 0, proj);
    // grating platform
    mb.box(c[0], py + 0.03, c[2], pw, 0.07, pd, rot, surf, col);
    if (lod === 0) {
      // railing: top rail, mid rail, balusters
      const fr = P(e, u, 0, pd + 0.06);
      mb.box(fr[0], py + 0.55, fr[2], pw, 0.05, 0.05, rot, surf, col);
      mb.box(fr[0], py + 1.02, fr[2], pw, 0.05, 0.05, rot, surf, col);
      for (let b = 0; b <= 4; b++) {
        const bu = u - pw * 0.5 + (pw * b) / 4;
        const bp = P(e, bu, 0, pd + 0.06);
        mb.box(bp[0], py + 0.55, bp[2], 0.035, 1.05, 0.035, rot, surf, col);
      }
      for (const side of [-1, 1]) {
        const sp = P(e, u + side * pw * 0.5, 0, proj);
        mb.box(sp[0], py + 0.55, sp[2], 0.035, 1.05, pd, rot, surf, col);
      }
      // stair stringers to the platform above, kept inside the platform's own width
      const sy = py + spec.storeyH;
      const stairU = Math.min(u + pw * 0.28, u + pw * 0.5 - 0.33);
      const sx = P(e, stairU, 0, proj);
      const run = spec.storeyH;
      mb.box(sx[0], (py + sy) * 0.5 + 0.30, sx[2], 0.06, run * 1.02, 0.10, rot, surf, col);
      for (let st = 0; st < 4; st++) {
        const t = st / 4;
        const stp = P(e, stairU, 0, proj + (t - 0.5) * pd * 0.55);
        mb.box(stp[0], py + 0.16 + t * (spec.storeyH - 0.2), stp[2], 0.62, 0.04, 0.22,
          rot, surf, col);
      }
    } else if ((s & 1) === 0) {
      const fr = P(e, u, 0, pd + 0.06);
      mb.box(fr[0], py + 0.55, fr[2], pw, 1.05, 0.06, rot, surf, col);
    }
  }
  // drop ladder hanging over the street
  if (lod === 0) {
    const lp = P(e, Math.min(u + pw * 0.28, u + pw * 0.5 - 0.28), 0, proj);
    mb.box(lp[0], y0 - 1.35, lp[2], 0.52, 2.7, 0.06, rot, surf, col);
  }
  // Laundry line strung off the escape. The far end used to be pinned a flat
  // 4.6 m along the edge; a North End frontage is 7 m and the escape sits at its
  // middle, so on nearly every tenement the line and five shirts ran a metre or
  // more past the corner of the building and hung in open sky.
  if (spec.laundry && lod === 0) {
    const ly = y0 + spec.storeyH * 1.1;
    const far = Math.min(u + 4.6, e.L - 0.15);
    if (far - (u - pw * 0.5) < 1.6) return;
    const a = P(e, u - pw * 0.5, ly, proj);
    const b = P(e, far, ly + 0.5, 0.25);
    mb.box((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5,
      Math.hypot(b[0] - a[0], b[2] - a[2]), 0.03, 0.03,
      Math.atan2(b[0] - a[0], b[2] - a[2]) + Math.PI / 2, 'metal_dark', [0.4, 0.4, 0.4]);
    const cols = [[0.85, 0.88, 0.92], [0.9, 0.6, 0.55], [0.95, 0.94, 0.9], [0.5, 0.62, 0.8]];
    for (let g = 0; g < 5; g++) {
      const t = 0.15 + g * 0.17;
      const gx = a[0] + (b[0] - a[0]) * t, gz = a[2] + (b[2] - a[2]) * t;
      const gy = a[1] + (b[1] - a[1]) * t;
      mb.box(gx, gy - 0.34, gz, 0.42, 0.62, 0.03,
        Math.atan2(b[0] - a[0], b[2] - a[2]) + Math.PI / 2,
        'wood_white', cols[g % 4]);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Roofs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Roof furniture. You look down on a lot of roofs in an open-world game, so a
 * bare lid is an instant tell.
 *
 * Every item draws from an *explicitly keyed* hash rather than a running
 * counter, so LOD 0, LOD 1 and the distant shell all place the same bulkhead in
 * the same spot. A running counter would drift the moment one tier skipped an
 * item, and the roofs would visibly reshuffle as you approached.
 */
function roofClutter(mb, poly, y, spec, lod) {
  const r0 = (k) => spec.rnd(5000 + k);
  let kk = 0;
  const r = () => r0(kk++);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const w = maxX - minX, d = maxZ - minZ;
  if (w < 3 || d < 3) return;
  const area = w * d;
  const inset = 1.3;
  const ctr = polyCentroid(poly);
  // `ROOF_UNIT_SCALE` reads the *bounding box*, which on a rotated Back Bay
  // parcel is nearly twice the roof. That grew a 3.4 m packaged unit on a 7.6 m
  // rowhouse deck, and no amount of repositioning makes an item that is wider
  // than the roof sit on it. Cap every footprint by the deck's own inradius.
  const rin = Math.max(0.3, inRadius(poly, ctr.x, ctr.z));
  const lim = Math.max(0.45, rin * 1.32 - 0.34);
  const rx = () => minX + inset + r() * Math.max(0.1, w - inset * 2);
  const rz = () => minZ + inset + r() * Math.max(0.1, d - inset * 2);
  /** Draw a bbox position (same keys as ever) and pull it onto the actual deck. */
  const site = (pad) => { const sx = rx(), sz = rz(); fitInPoly(poly, ctr.x, ctr.z, sx, sz, pad); };

  // roof access bulkhead — every flat roof in the city has one
  kk = 0;
  if (area > 55) {
    const bw = Math.min(2.0 + r() * 1.1, lim), bd = Math.min(2.2 + r() * 1.2, lim),
          bh = 2.35 + r() * 0.5;
    site(Math.hypot(bw + 0.18, bd + 0.18) * 0.5);
    const bx = _fitX, bz = _fitZ;
    mb.box(bx, y + bh * 0.5, bz, bw, bh, bd, r() * 3.14, 'brick_dark', [0.86, 0.82, 0.80]);
    mb.box(bx, y + bh + 0.06, bz, bw + 0.18, 0.12, bd + 0.18, 0, 'metal_dark', [0.4, 0.4, 0.4]);
  }
  // HVAC farm. Units scale with the roof: a 1.5 m box on a 40 m warehouse roof
  // is invisible past the next block, and real packaged rooftop units on a big
  // commercial deck are 4–6 m long.
  kk = 20;
  const usc = ROOF_UNIT_SCALE(area);
  const hn = lod === 0
    ? Math.min(7, Math.max(1, Math.floor(area / 140) + (r() < 0.5 ? 1 : 0)))
    : Math.min(4, Math.max(1, Math.floor(area / 200)));
  for (let i = 0; i < hn; i++) {
    const uw = Math.min((1.1 + r() * 1.5) * usc, lim),
          ud = Math.min((0.9 + r() * 1.1) * usc, lim),
          uh = (0.75 + r() * 0.7) * Math.min(1.7, usc);
    site(Math.hypot(uw + 0.3, ud + 0.3) * 0.5);
    const ux = _fitX, uz = _fitZ;
    const rot = r() < 0.5 ? 0 : Math.PI / 2;
    mb.box(ux, y + uh * 0.5 + 0.12, uz, uw, uh, ud, rot, 'metal_panel', [0.85, 0.86, 0.88]);
    mb.box(ux, y + 0.06, uz, uw + 0.3, 0.12, ud + 0.3, rot, 'metal_dark', [0.35, 0.35, 0.35]);
    if (lod === 0) {
      mb.box(ux, y + uh + 0.20, uz, uw * 0.55, 0.16, ud * 0.55, rot,
        'metal_dark', [0.32, 0.33, 0.34]);
      // condenser fan cowl
      mb.box(ux + 0.02, y + uh + 0.30, uz, uw * 0.42, 0.06, ud * 0.42, rot,
        'metal_dark', [0.22, 0.22, 0.23]);
    }
  }
  // ducting — a long horizontal run is one of the few roof items that still
  // reads as a shape rather than a speck at LOD 1 distance, so keep it there.
  kk = 120;
  if (lod < 2 && area > 120) {
    const dx0raw = rx(), dz0raw = rz();
    const len = Math.min((2 + r() * 5) * usc, rin * 1.7);
    fitInPoly(poly, ctr.x, ctr.z, dx0raw, dz0raw, len * 0.52);
    mb.box(_fitX, y + 0.55, _fitZ, len, 0.42 * usc, 0.42 * usc, r() < 0.5 ? 0 : Math.PI / 2,
      'metal_panel', [0.8, 0.82, 0.84]);
  }
  // vent stacks
  kk = 140;
  const vn = lod === 0 ? 2 + Math.floor(r() * 4) : 2;
  for (let i = 0; i < vn; i++) {
    const vh = 0.5 + r() * 1.5;
    site(0.2);
    mb.box(_fitX, y + vh * 0.5, _fitZ, 0.16, vh, 0.16, 0, 'metal_dark', [0.45, 0.44, 0.42]);
  }
  // rooftop water tank on a steel cradle
  kk = 170;
  if (spec.waterTank && area > 90 && lod === 0) {
    const tr = Math.min(1.5, rin * 0.62);
    site(tr * 1.18);
    const tx = _fitX, tz = _fitZ;
    const legH = 1.9, th = 2.8;
    for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      mb.box(tx + ox * tr * 0.6, y + legH * 0.5, tz + oz * tr * 0.6, 0.12, legH, 0.12,
        0, 'metal_dark', [0.35, 0.34, 0.33]);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 6.2832, a1 = ((i + 1) / n) * 6.2832;
      const x0 = tx + Math.cos(a0) * tr, z0 = tz + Math.sin(a0) * tr;
      const x1 = tx + Math.cos(a1) * tr, z1 = tz + Math.sin(a1) * tr;
      mb.wall(x0, z0, x1, z1, y + legH, y + legH + th, 'wood_dark', [0.55, 0.42, 0.32], i * 1.2, 0);
    }
    const cone = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832;
      cone.push({ x: tx + Math.cos(a) * tr * 0.98, z: tz + Math.sin(a) * tr * 0.98 });
    }
    mb.cap(cone, y + legH + th, 'metal_dark', [0.4, 0.38, 0.36], true);
    mb.box(tx, y + legH + th + 0.5, tz, tr * 0.9, 1.0, tr * 0.9, 0.4,
      'metal_dark', [0.42, 0.40, 0.38]);
  }
  // satellite dishes and an antenna mast
  kk = 200;
  if (lod === 0) {
    const dn = Math.floor(r() * 3);
    for (let i = 0; i < dn; i++) {
      site(0.65);
      const dx0 = _fitX, dz0 = _fitZ;
      mb.box(dx0, y + 0.55, dz0, 0.08, 1.1, 0.08, 0, 'metal_dark', [0.5, 0.5, 0.5]);
      const dr = 0.34 + r() * 0.22;
      const dish = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * 6.2832;
        dish.push({ x: dx0 + Math.cos(a) * dr, z: dz0 + Math.sin(a) * dr });
      }
      mb.cap(dish, y + 1.12, 'metal_panel', [0.92, 0.92, 0.9], true);
      mb.cap(dish, y + 1.10, 'metal_panel', [0.7, 0.7, 0.7], false);
    }
    // skylights
    if (r() < 0.45 && area > 80) {
      const kw = Math.min(1.2, lim), kd = Math.min(0.9, lim);
      site(Math.hypot(kw, kd) * 0.5);
      const sx = _fitX, sz = _fitZ;
      mb.box(sx, y + 0.20, sz, kw, 0.34, kd, 0, 'metal_dark', [0.35, 0.35, 0.36]);
      mb.box(sx, y + 0.40, sz, kw * 0.88, 0.06, kd * 0.84, 0, 'spandrel',
        [0.75, 0.85, 0.95], 0.12);
    }
  }
  // Rooftop mast. This is a SILHOUETTE element, not clutter: masts and the
  // bulkheads beside them are most of what gives a distant skyline its ragged
  // top edge. It used to be emitted at LOD 0 only, which is precisely backwards
  // — by the time a tower is far enough away for its top edge to be the only
  // thing you can read about it, the mast had already been dropped, and every
  // tower ended in the same flat parapet line.
  kk = 240;
  if (lod < 2 && area > 240 && r() < mastChance(spec)) {
    site(0.4);
    const mx = _fitX, mz = _fitZ;
    const mh = mastHeight(spec, r());
    mb.box(mx, y + mh * 0.5, mz, 0.16, mh, 0.16, 0, 'metal_dark', [0.4, 0.4, 0.42]);
    mb.box(mx, y + mh * 0.62, mz, 0.62, 0.07, 0.62, 0, 'metal_dark', [0.4, 0.4, 0.42]);
    mb.box(mx, y + mh, mz, 0.42, 0.06, 0.42, 0, 'metal_dark', [0.4, 0.4, 0.42]);
  }
  // chimneys — kept at every LOD, they define a rowhouse roofline
  const cn = spec.S.chimneys || 0;
  const csc = chimneyScale(rin);
  for (let i = 0; i < cn; i++) {
    chimneySite(poly, ctr, minX, minZ, w, d, inset, i, cn, r0, csc);
    const ch = 1.5 + r0(261 + i * 2) * 1.3;
    mb.box(_fitX, y + ch * 0.5, _fitZ, 0.85 * csc, ch, 0.62 * csc, 0,
      'brick_dark', [0.88, 0.84, 0.82]);
    mb.box(_fitX, y + ch + 0.06, _fitZ, 0.98 * csc, 0.12, 0.75 * csc, 0,
      'trim_stone', [0.85, 0.84, 0.8]);
    if (lod === 0) {
      mb.box(_fitX, y + ch + 0.38, _fitZ, 0.62 * csc, 0.55, 0.22 * csc, 0,
        'terracotta', [0.9, 0.62, 0.45]);
    }
  }
}

/** A chimney narrow enough for the ridge it stands on. */
function chimneyScale(rin) { return Math.min(1, rin / 0.63); }

/**
 * Chimney i of n, on the deck rather than in its bounding box.
 *
 * Explicitly keyed (`260 + 2i`, `261 + 2i`) instead of walking a running counter.
 * The shell used to key its chimneys `261 + 3i` / `262 + 3i` against the detailed
 * tiers' `260 + i*2`, so a chimney was in a different place and a different height
 * in the shell than in the mesh drawn over it — visible as a doubled chimney
 * wherever an LOD-1 chunk left the shell showing through.
 */
function chimneySite(poly, ctr, minX, minZ, w, d, inset, i, cn, r0, csc) {
  const cx = minX + inset + (i + 0.5) / cn * Math.max(0.2, w - inset * 2);
  const cz = minZ + d * (0.18 + r0(260 + i * 2) * 0.1);
  fitInPoly(poly, ctr.x, ctr.z, cx, cz, Math.hypot(0.98, 0.75) * 0.5 * csc);
}

/**
 * The re-covered field: a large contrasting rectangle over most of the deck.
 * Two triangles on a quad footprint, and from above it is the single strongest
 * thing on the roof — more legible at any distance than a dozen HVAC boxes.
 */
function roofField(mb, poly, y, spec) {
  const p = spec.roofPatch;
  if (!p) return;
  const q = insetPoly(poly, 0.8 + spec.rnd(7100) * 2.0);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const pt of q) {
    if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
    if (pt.z < minZ) minZ = pt.z; if (pt.z > maxZ) maxZ = pt.z;
  }
  // insetPoly walks vertices toward the centroid, so a small roof collapses.
  if (maxX - minX < 2.5 || maxZ - minZ < 2.5) return;
  mb.cap(q, y + 0.045, p.surf, p.col, true);
}

/** Parapet, coping and the roof deck itself. */
function flatRoof(mb, poly, y, spec, lod) {
  const ph = spec.parapet;
  const col = spec.wallCol, ws = spec.wallSurf;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const e = edgeFrame(a, b);
    // outer face continues the wall
    mb.wall(a.x, a.z, b.x, b.z, y, y + ph, ws, col, spec.uOff, 0);
    // inner face
    mb.quadAuto(P(e, 0, y, -0.24), P(e, e.L, y, -0.24),
      P(e, e.L, y + ph - 0.1, -0.24), P(e, 0, y + ph - 0.1, -0.24),
      -e.nx, 0, -e.nz, [0, 0, e.L / 2, 0, e.L / 2, ph / 2, 0, ph / 2],
      [col[0] * 0.86, col[1] * 0.86, col[2] * 0.86], SURF[ws] ? ws : 'brick_red');
    // stone coping
    const mp = P(e, e.L * 0.5, 0, -0.11);
    mb.box(mp[0], y + ph, mp[2], e.L, 0.14, 0.46,
      Math.atan2(e.nx, e.nz), 'trim_stone', spec.trimCol);
  }
  const deck = insetPoly(poly, 0.24);
  mb.cap(deck, y, spec.roofSurf, spec.roofCol, true);
  roofField(mb, deck, y, spec);
  if (lod < 2) roofClutter(mb, deck, y, spec, lod);
}

/** Mansard: steep slate slope with dormers, then a small flat deck. */
function mansardRoof(mb, gb, poly, y, spec, lod) {
  const mh = spec.mansardH;
  const inset = mh * 0.42;
  const top = insetPoly(poly, inset);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const a2 = top[i], b2 = top[(i + 1) % n];
    const e = edgeFrame(a, b);
    mb.quadAuto([a.x, y, a.z], [b.x, y, b.z], [b2.x, y + mh, b2.z], [a2.x, y + mh, a2.z],
      e.nx, 0.35, e.nz, [0, 0, e.L, 0, e.L, mh * 1.2, 0, mh * 1.2],
      [0.95, 0.96, 0.98], 'slate');
    // eaves cornice
    const mp = P(e, e.L * 0.5, 0, 0.16);
    mb.box(mp[0], y - 0.14, mp[2], e.L, 0.30, 0.44,
      Math.atan2(e.nx, e.nz), spec.trimSurf, spec.trimCol);
  }
  mb.cap(top, y + mh, spec.roofSurf, spec.roofCol, true);
  roofField(mb, top, y + mh, spec);
  if (lod < 2) roofClutter(mb, insetPoly(top, 0.5), y + mh, spec, lod);

  // Dormers on the street-facing slopes.
  if (lod === 0) {
    for (const i of spec.front) {
      const a = poly[i], b = poly[(i + 1) % n];
      const e = edgeFrame(a, b);
      const cnt = Math.max(1, Math.round(e.L / 3.0));
      for (let k = 0; k < cnt; k++) {
        const u = ((k + 0.5) / cnt) * e.L;
        const dw = 1.30, dh = 1.75, dd = 1.15;
        const fy = y + 0.42;
        const off = -0.30;
        const rot = Math.atan2(e.nx, e.nz);
        const c = P(e, u, 0, off - dd * 0.5);
        mb.box(c[0], fy + dh * 0.5, c[2], dw, dh, dd, rot, 'wood_white', [0.96, 0.96, 0.94]);
        mb.box(c[0], fy + dh + 0.12, c[2], dw + 0.3, 0.16, dd + 0.24, rot,
          'slate', [0.95, 0.96, 0.98]);
        const fp = P(e, u, 0, off);
        void fp;
        gb.pane(P(e, u - dw * 0.34, fy + 0.28, off - 0.01),
          P(e, u + dw * 0.34, fy + 0.28, off - 0.01),
          P(e, u + dw * 0.34, fy + dh - 0.24, off - 0.01),
          P(e, u - dw * 0.34, fy + dh - 0.24, off - 0.01),
          [e.nx, 0, e.nz], [e.dx, 0, e.dz], dw * 0.68, dh - 0.5, 2.2,
          hash2(spec.seed + 991, k * 77), spec.lit, 1, [0.93, 0.93, 0.90]);
      }
    }
  }
}

/** Hip roof for triple-deckers. */
function hipRoof(mb, poly, y, spec) {
  const rh = 1.9;
  const top = insetPoly(poly, 1.7);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const a2 = top[i], b2 = top[(i + 1) % n];
    const e = edgeFrame(a, b);
    mb.quadAuto([a.x, y, a.z], [b.x, y, b.z], [b2.x, y + rh, b2.z], [a2.x, y + rh, a2.z],
      e.nx, 0.7, e.nz, [0, 0, e.L, 0, e.L, rh * 1.6, 0, rh * 1.6],
      [0.94, 0.95, 0.97], 'slate');
    const mp = P(e, e.L * 0.5, 0, 0.28);
    mb.box(mp[0], y - 0.10, mp[2], e.L, 0.26, 0.62,
      Math.atan2(e.nx, e.nz), 'wood_white', [0.97, 0.97, 0.95]);
  }
  mb.cap(top, y + rh, 'slate', [0.94, 0.95, 0.97], true);
}

/* -------------------------------------------------------------------------- */
/* Bowfronts and bays                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Replace part of a street edge with a shallow arc. Back Bay and the South End
 * are unreadable without this.
 *
 * `t0..t1` is the span of the frontage the bow occupies. It used to be pinned at
 * 0.16..0.84 — dead centre, leaving 1.3 m of flat wall at each end of an 8.3 m
 * frontage. That is narrower than the front door, so on every bowfront in the
 * city the doorway, its pilasters, its 1.98 m entablature and its stoop were
 * emitted across a 1.15 m arc segment and overhung it at both ends. A real Back
 * Bay rowhouse is a bow **beside** an entry bay, not a bow with a door punched
 * through the middle of it, so the arc is now pushed to one end and the entry
 * bay gets the ~2.9 m of flat wall it actually needs.
 */
function bowPolyline(a, b, proj, t0, t1) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  const nx = uz, nz = -ux;
  const pts = [a];
  const segs = 5;
  for (let i = 0; i <= segs; i++) {
    const t = t0 + (t1 - t0) * (i / segs);
    const bulge = Math.sin((i / segs) * Math.PI) * proj;
    pts.push({ x: a.x + ux * L * t + nx * bulge, z: a.z + uz * L * t + nz * bulge });
  }
  pts.push(b);
  return pts;
}

/**
 * Where the bow (or the square bay) sits on a frontage, and where the door goes.
 *
 * Keyed off the spec hash so LOD 0, LOD 1 and `_fitOrnament` all agree, and so
 * neighbouring houses mirror each other the way real paired rowhouses do.
 * @returns {{t0:number, t1:number, entryLeft:boolean}}
 */
function frontLayout(spec, L) {
  // Below ~6.5 m there is no room for both, so the projection stays central and
  // the door takes what is left.
  const wide = L > 6.4;
  const entryLeft = wide && spec.rnd(6003) < 0.5;
  const share = Math.min(0.66, Math.max(0.40, 1 - 3.05 / L));
  if (!wide) return { t0: 0.5 - share * 0.5, t1: 0.5 + share * 0.5, entryLeft: false, wide };
  return entryLeft
    ? { t0: 1 - share - 0.04, t1: 0.96, entryLeft, wide }
    : { t0: 0.04, t1: share + 0.04, entryLeft, wide };
}

/**
 * A square or canted bay: the South End and Back Bay signature, and the single
 * biggest Boston authenticity miss the critic found — those rows had none at all.
 *
 * Built as a shallow prism bonded to the wall: a mini-facade on the front plane
 * (real reveals, sills and lintels, from the same `frontStorey` walk as the rest
 * of the building) and two blind returns with a recessed light in each. The main
 * facade skips the span the bay covers, so this is close to triangle-neutral —
 * it moves the wall forward rather than adding a second one in front of it.
 *
 * Everything is anchored to `[u0,u1]` of the wall it grows from, so no part of it
 * can leave the frontage.
 */
function bayFront(mb, gb, e, u0, u1, y0, y1, spec, lod) {
  const St = spec.S;
  const pr = spec.bayProj;
  const W = u1 - u0;
  if (W < 1.5 || y1 - y0 < 1.6 || pr < 0.2) return;
  const rot = Math.atan2(e.nx, e.nz);

  // Front plane and the two returns, as ordinary edge frames so the outward
  // normals come out right without a special case anywhere downstream.
  const fa = { x: e.ax + e.dx * u0 + e.nx * pr, z: e.az + e.dz * u0 + e.nz * pr };
  const fb = { x: e.ax + e.dx * u1 + e.nx * pr, z: e.az + e.dz * u1 + e.nz * pr };
  const wa = { x: e.ax + e.dx * u0, z: e.az + e.dz * u0 };
  const wb = { x: e.ax + e.dx * u1, z: e.az + e.dz * u1 };
  const ef = edgeFrame(fa, fb);
  const el = edgeFrame(wa, fa);        // left return, faces -e.d
  const er = edgeFrame(fb, wb);        // right return, faces +e.d

  // A bay carries two or three lights; force the rhythm rather than inheriting
  // the parent's bay width, which would put a single window on a 3 m front.
  const lights = W > 2.7 ? 3 : 2;
  const bs = Object.create(spec);
  bs.S = Object.create(St);
  bs.S.bayW = W / lights;
  bs.S.winW = Math.min(St.winW, (W / lights) * 0.74);
  bs.arched = false;
  bs.shutters = false;

  let y = y0, s = spec.bayFromGround ? 0 : 1;
  while (y < y1 - 0.4) {
    // Storey lines must match the flanking facade or the bay's windows sit half a
    // metre off its neighbours'.
    const yy = Math.min(y + (s === 0 ? spec.groundH : spec.storeyH), y1);
    frontStorey(mb, gb, ef, 0, ef.L, y, yy, bs, s, lod);
    for (const cheek of [el, er]) {
      band(mb, cheek, 0, cheek.L, y, yy, spec.wallSurf, spec.wallCol, spec.uOff, 0);
      if (lod === 0 && cheek.L > 0.55) {
        // A narrow light in the return. Glass costs no shadow triangles.
        gb.pane(P(cheek, 0.18, y + St.sillH, -0.10), P(cheek, cheek.L - 0.18, y + St.sillH, -0.10),
          P(cheek, cheek.L - 0.18, Math.min(yy - 0.42, y + St.sillH + St.winH), -0.10),
          P(cheek, 0.18, Math.min(yy - 0.42, y + St.sillH + St.winH), -0.10),
          [cheek.nx, 0, cheek.nz], [cheek.dx, 0, cheek.dz],
          cheek.L, St.winH, 2.4, hash2(spec.seed + 611, s * 91), spec.lit, St.winKind,
          [0.88, 0.87, 0.83]);
      }
    }
    y = yy; s++;
  }

  // Cap: a cornice band carried round the bay, then a lid so you cannot see in
  // from a roof camera.
  const cd = Math.max(0.22, St.cornice || 0.3);
  const cp = P(ef, ef.L * 0.5, 0, cd * 0.45);
  mb.box(cp[0], y1 - 0.22, cp[2], ef.L + 0.20, 0.44, cd * 0.9 + 0.2,
    rot, spec.trimSurf, spec.trimCol);
  mb.quadAuto([wa.x, y1, wa.z], [wb.x, y1, wb.z], [fb.x, y1, fb.z], [fa.x, y1, fa.z],
    0, 1, 0, [0, 0, W, 0, W, pr, 0, pr], spec.roofCol, spec.roofSurf);
  // Bracketed soffit under an oriel — this is what makes it read as carried
  // rather than as a box glued to the wall.
  if (lod === 0 && y0 > spec.base + 0.05) {
    const sp = P(e, (u0 + u1) * 0.5, 0, pr * 0.5);
    mb.box(sp[0], y0 - 0.16, sp[2], W, 0.24, pr + 0.1, rot, spec.trimSurf, spec.trimCol);
  }
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Emit one building's geometry at the requested detail level.
 * @param {object} spec from `makeSpec`
 * @param {import('./BuildingKit.js').MeshBuf} mb opaque output
 * @param {import('./BuildingKit.js').GlassBuf} gb window output
 * @param {0|1|2} lod
 */
export function buildBuilding(spec, mb, gb, lod) {
  if (lod === 2) return buildShell(spec, mb);
  const St = spec.S;
  const poly = spec.poly;
  const n = poly.length;
  const base = spec.base;
  const stages = [];

  // Vertical massing: one stage per setback.
  if (spec.setbacks && spec.setbacks.length) {
    let prevT = 0, prevPoly = poly;
    for (const sb of spec.setbacks) {
      stages.push({ poly: prevPoly, y0: base + spec.h * prevT, y1: base + spec.h * sb.t });
      prevPoly = insetPoly(prevPoly, sb.inset);
      prevT = sb.t;
    }
    stages.push({ poly: prevPoly, y0: base + spec.h * prevT, y1: base + spec.h });
  } else {
    stages.push({ poly, y0: base, y1: base + spec.h });
  }

  for (let si = 0; si < stages.length; si++) {
    const st = stages[si];
    const sp = orientOutward(st.poly);
    const m = sp.length;
    for (let i = 0; i < m; i++) {
      const a = sp[i], b = sp[(i + 1) % m];
      const isFront = si === 0 && spec.front.has(i);
      // Bowfront: swap part of the flat street edge for an arc, pushed to one end
      // so the entry bay beside it is wide enough for a door and its surround.
      const chord = Math.hypot(b.x - a.x, b.z - a.z);
      const lay = isFront && (spec.bow || spec.bay) ? frontLayout(spec, chord) : null;
      const line = (isFront && spec.bow && !spec.shop)
        ? bowPolyline(a, b, 0.95 + spec.rnd(6001) * 0.5, lay.t0, lay.t1) : [a, b];
      // Which sub-segment carries the front door: the flat entry bay, never the
      // middle of the arc.
      const entryK = line.length === 2 ? 0 : (lay && lay.entryLeft ? 0 : line.length - 2);

      for (let k = 0; k < line.length - 1; k++) {
        const e = edgeFrame(line[k], line[k + 1]);
        if (e.L < 0.05) continue;
        if (!isFront) {
          partyWall(mb, gb, e, st.y0, st.y1, spec, lod, si);
          continue;
        }
        // Square/canted bay: the wall it covers is skipped rather than buried,
        // so the bay is close to triangle-neutral.
        // A real Boston bay is ~3 m of a ~8 m frontage, set to one side with the
        // entry bay beside it — not a bulge across the whole front.
        const hasBay = spec.bay && line.length === 2 && e.L > 3.2;
        const bayW = hasBay ? Math.min(3.35, e.L * 0.46) : 0;
        const bu0 = hasBay ? (lay.entryLeft ? e.L - bayW - 0.35 : 0.35) : 0;
        const bu1 = bu0 + bayW;
        const bayY0 = base + (spec.bayFromGround ? 0 : spec.groundH);
        // Street facade: walk the storeys.
        let y = st.y0;
        for (let s = 0; s < spec.storeys; s++) {
          const hgt = s === 0 ? spec.groundH : spec.storeyH;
          const y1 = Math.min(y + hgt, st.y1);
          if (y1 - y < 0.2) break;
          const skipBay = hasBay && y >= bayY0 - 0.01;
          if (s === 0 && spec.shop && line.length === 2) {
            shopfront(mb, gb, e, 0, e.L, y, y1, spec, lod);
          } else if (St.curtain) {
            curtainStorey(mb, gb, e, 0, e.L, y, y1, spec, s, lod);
          } else if (skipBay) {
            // A sub-span narrower than a metre is a pier, not a window bay —
            // `frontStorey` would fit a 22 cm window into it.
            for (const [q0, q1] of [[0, bu0], [bu1, e.L]]) {
              if (q1 - q0 < 0.05) continue;
              if (q1 - q0 < 1.0) band(mb, e, q0, q1, y, y1, spec.wallSurf, spec.wallCol, spec.uOff, 0);
              else frontStorey(mb, gb, e, q0, q1, y, y1, spec, s, lod);
            }
          } else {
            frontStorey(mb, gb, e, 0, e.L, y, y1, spec, s, lod);
            if (St.stringCourse && s === 0 && lod === 0) {
              const mp = P(e, e.L * 0.5, 0, 0.07);
              mb.box(mp[0], y1 - 0.06, mp[2], e.L, 0.16, 0.20,
                Math.atan2(e.nx, e.nz), spec.trimSurf, spec.trimCol);
            }
          }
          y = y1;
          if (y >= st.y1 - 0.05) break;
        }
        if (hasBay && bu1 - bu0 > 1.5) {
          bayFront(mb, gb, e, bu0, bu1, bayY0, st.y1, spec, lod);
        }
        // Entrance and street furniture only on the true ground stage.
        if (si === 0 && k === entryK) {
          if (spec.hasStoop && !spec.shop) {
            // Beside the bay when there is one, otherwise a third of the way in.
            const du = hasBay
              ? (bu0 > e.L - bu1 ? bu0 * 0.5 : (bu1 + e.L) * 0.5)
              : e.L * (line.length > 2 ? 0.5 : 0.30);
            entrance(mb, gb, e, du, base, spec, lod);
            if (spec.areaway && lod === 0) areaway(mb, e, spec, du, 2.3);
          } else if (spec.areaway && lod === 0) {
            areaway(mb, e, spec, -9, 0);
          }
        }
        if (si === 0 && k === Math.floor((line.length - 1) / 2)
            && spec.fireEscape && lod < 2 && spec.storeys > 2) {
          fireEscape(mb, e, e.L * 0.5, spec, lod);
        }
        // Cornice at the top of the stage.
        if (St.cornice && lod < 2) {
          const cd = St.cornice;
          const mp = P(e, e.L * 0.5, 0, cd * 0.45);
          const top = st.y1;
          mb.box(mp[0], top - 0.24, mp[2], e.L, 0.48, cd * 0.9 + 0.2,
            Math.atan2(e.nx, e.nz), spec.trimSurf, spec.trimCol);
          if (lod === 0 && cd > 0.3) {
            const cnt = Math.max(2, Math.round(e.L / 0.95));
            for (let mi = 0; mi < cnt; mi++) {
              const mu = ((mi + 0.5) / cnt) * e.L;
              const bp = P(e, mu, 0, cd * 0.35);
              mb.box(bp[0], top - 0.62, bp[2], 0.16, 0.34, cd * 0.7,
                Math.atan2(e.nx, e.nz), spec.trimSurf, spec.trimCol);
            }
          }
        }
      }
    }
    // Ledge over each setback so the massing reads as stone, not a stack.
    if (si < stages.length - 1) {
      mb.cap(insetPoly(sp, 0.1), st.y1, spec.roofSurf, spec.roofCol, true);
      for (let i = 0; i < m; i++) {
        const a = sp[i], b = sp[(i + 1) % m];
        const e = edgeFrame(a, b);
        const mp = P(e, e.L * 0.5, 0, 0.12);
        mb.box(mp[0], st.y1 + 0.5, mp[2], e.L, 1.0, 0.34,
          Math.atan2(e.nx, e.nz), spec.trimSurf, spec.trimCol);
      }
    }
  }

  // Roof of the topmost stage.
  const topStage = stages[stages.length - 1];
  const tp = orientOutward(topStage.poly);
  if (spec.mansard) mansardRoof(mb, gb, tp, topStage.y1, spec, lod);
  else if (St.hipRoof) hipRoof(mb, tp, topStage.y1, spec);
  else flatRoof(mb, tp, topStage.y1, spec, lod);

  // Mechanical penthouse on modern towers.
  if (St.mech && spec.h > 40) {
    const pen = insetPoly(tp, Math.min(4.5, spec.h * 0.03 + 2));
    const py = topStage.y1 + spec.parapet;
    const ph = 3.6 + spec.rnd(6002) * 2.4;
    const p2 = orientOutward(pen);
    for (let i = 0; i < p2.length; i++) {
      const a = p2[i], b = p2[(i + 1) % p2.length];
      mb.wall(a.x, a.z, b.x, b.z, py, py + ph, 'metal_panel', [0.86, 0.88, 0.9], 0, 0);
    }
    mb.cap(pen, py + ph, 'roof_gravel', [0.9, 0.9, 0.88], true);
    if (lod === 0) roofClutter(mb, insetPoly(pen, 0.6), py + ph, spec, lod);
  }
  // 1920s crown: a stepped granite cap.
  if (spec.crown) {
    let cp = insetPoly(tp, 1.4);
    let cy = topStage.y1 + spec.parapet;
    for (let i = 0; i < 3; i++) {
      const c2 = orientOutward(cp);
      for (let k = 0; k < c2.length; k++) {
        const a = c2[k], b = c2[(k + 1) % c2.length];
        mb.wall(a.x, a.z, b.x, b.z, cy, cy + 2.2, spec.wallSurf, spec.wallCol, 0, 0);
      }
      mb.cap(cp, cy + 2.2, spec.roofSurf, spec.roofCol, true);
      cy += 2.2;
      cp = insetPoly(cp, 1.5);
      if (Math.hypot(cp[0].x - cp[2].x, cp[0].z - cp[2].z) < 3) break;
    }
  }
}

/** Rear and party walls: cheap, but never blank. */
function partyWall(mb, gb, e, y0, y1, spec, lod, stage) {
  const ws = spec.wallSurf;
  const col = [spec.wallCol[0] * 0.93, spec.wallCol[1] * 0.93, spec.wallCol[2] * 0.93];
  if (lod > 0 || e.L < 2.5 || spec.S.curtain) {
    mb.wall(e.ax, e.az, e.ax + e.dx * e.L, e.az + e.dz * e.L, y0, y1, ws, col, spec.uOff, 0);
    if (spec.S.curtain && lod === 0) {
      // Towers are glazed on all four sides — never leave a blank back.
      let y = y0 + spec.groundH;
      for (let s = 1; s < spec.storeys; s++) {
        const yy = Math.min(y + spec.storeyH, y1);
        if (yy - y < 0.4) break;
        curtainStorey(mb, gb, e, 0, e.L, y, yy, spec, s, 1);
        y = yy;
      }
    }
    return;
  }
  // Sparse rear windows, still with a reveal — but only up to eight storeys.
  // Above that a party wall reads as brick and nothing else.
  const bays = Math.max(1, Math.round(e.L / 3.4));
  const bw = e.L / bays;
  const detailTop = y0 + 24;
  if (y1 > detailTop) {
    mb.wall(e.ax + e.dx * 0, e.az, e.ax + e.dx * e.L, e.az + e.dz * e.L,
      detailTop, y1, ws, col, spec.uOff, 0);
  }
  let y = y0;
  for (let s = 0; s < spec.storeys; s++) {
    const hgt = s === 0 ? spec.groundH : spec.storeyH;
    const yy = Math.min(y + hgt, y1, detailTop);
    if (yy - y < 0.3) break;
    for (let i = 0; i < bays; i++) {
      const seed = hash2(spec.seed + 313 + s * 17, i * 57 + stage);
      const bu0 = i * bw, bu1 = bu0 + bw;
      if (seed < 0.34) { band(mb, e, bu0, bu1, y, yy, ws, col, spec.uOff, 0); continue; }
      const wW = Math.min(1.0, bw * 0.42), sill = y + 0.9;
      const head = Math.min(sill + 1.5, yy - 0.5);
      const wu0 = (bu0 + bu1) * 0.5 - wW * 0.5, wu1 = wu0 + wW;
      band(mb, e, bu0, wu0, y, yy, ws, col, spec.uOff, 0);
      band(mb, e, wu1, bu1, y, yy, ws, col, spec.uOff, 0);
      band(mb, e, wu0, wu1, y, sill, ws, col, spec.uOff, 0);
      band(mb, e, wu0, wu1, head, yy, ws, col, spec.uOff, 0);
      windowUnit(mb, gb, e, wu0, wu1, sill, head, spec, {
        reveal: 0.12, kind: 1, lod: 1, seed, lit: spec.lit * 0.8,
        roomDepth: 2.4, sill: false, lintel: false,
      });
    }
    y = yy;
  }
}

/* -------------------------------------------------------------------------- */
/* Shell (LOD 2) — the always-resident distant city                           */
/* -------------------------------------------------------------------------- */

/**
 * Distant roof furniture: the same bulkhead and the first two HVAC units the
 * detailed tiers place, at the same coordinates, 0.30 m lower and 6% smaller so
 * the detailed geometry swallows it whole. Twelve triangles buys a roofline
 * that still reads as a city from a kilometre up.
 */
function shellRoofKit(mb, poly, y, spec) {
  const r0 = (k) => spec.rnd(5000 + k);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const w = maxX - minX, d = maxZ - minZ;
  if (w < 3 || d < 3) return;
  const area = w * d;
  const inset = 1.3;
  const K = 0.94, DY = 0.30;
  const ctr = polyCentroid(poly);
  const rin = Math.max(0.3, inRadius(poly, ctr.x, ctr.z));
  const lim = Math.max(0.45, rin * 1.32 - 0.34);
  const px = (k) => minX + inset + r0(k) * Math.max(0.1, w - inset * 2);
  const pz = (k) => minZ + inset + r0(k) * Math.max(0.1, d - inset * 2);
  /** Same keys, same clamp, same result as `roofClutter` — see `fitInPoly`. */
  const site = (k, pad) => fitInPoly(poly, ctr.x, ctr.z, px(k), pz(k + 1), pad);

  if (area > 55) {
    const bw = Math.min(2.0 + r0(0) * 1.1, lim), bd = Math.min(2.2 + r0(1) * 1.2, lim),
          bh = 2.35 + r0(2) * 0.5;
    site(3, Math.hypot(bw + 0.18, bd + 0.18) * 0.5);
    mb.box(_fitX, y - DY + bh * 0.5, _fitZ, bw * K, bh, bd * K, r0(5) * 3.14,
      'brick_dark', [0.86, 0.82, 0.80]);
  }
  // Unit count and size must track `roofClutter` or the furniture visibly
  // resizes as a chunk crosses the LOD 1 boundary.
  const usc = ROOF_UNIT_SCALE(area);
  const hn = Math.min(3, Math.max(1, Math.floor(area / 240)));
  for (let i = 0; i < hn; i++) {
    const k = 20 + i * 6;
    const uw = Math.min((1.1 + r0(k) * 1.5) * usc, lim),
          ud = Math.min((0.9 + r0(k + 1) * 1.1) * usc, lim),
          uh = (0.75 + r0(k + 2) * 0.7) * Math.min(1.7, usc);
    site(k + 3, Math.hypot(uw + 0.3, ud + 0.3) * 0.5);
    mb.box(_fitX, y - DY + uh * 0.5 + 0.12, _fitZ, uw * K, uh, ud * K,
      r0(k + 5) < 0.5 ? 0 : Math.PI / 2, 'metal_panel', [0.85, 0.86, 0.88]);
  }
  // Mast — same keys, same place, same height as `roofClutter`. This is the one
  // roof item that changes the building's silhouette, so the shell must have it:
  // the shell is what you are looking at whenever the silhouette is all you can
  // see. Not dropped by `K`/`DY` either — a mast shrunk into the roof would
  // simply disappear.
  if (area > 240 && r0(240) < mastChance(spec)) {
    site(241, 0.4);
    const mx = _fitX, mz = _fitZ;
    const mh = mastHeight(spec, r0(243));
    mb.box(mx, y - DY + mh * 0.5, mz, 0.16, mh, 0.16, 0, 'metal_dark', [0.4, 0.4, 0.42]);
    mb.box(mx, y - DY + mh * 0.62, mz, 0.62, 0.07, 0.62, 0, 'metal_dark', [0.4, 0.4, 0.42]);
    mb.box(mx, y - DY + mh, mz, 0.42, 0.06, 0.42, 0, 'metal_dark', [0.4, 0.4, 0.42]);
  }
  const cn = spec.S.chimneys || 0;
  const csc = chimneyScale(rin);
  for (let i = 0; i < cn; i++) {
    chimneySite(poly, ctr, minX, minZ, w, d, inset, i, cn, r0, csc);
    const ch = 1.5 + r0(261 + i * 2) * 1.3;
    mb.box(_fitX, y - DY + ch * 0.5, _fitZ, 0.85 * K * csc, ch, 0.62 * K * csc, 0,
      'brick_dark', [0.88, 0.84, 0.82]);
  }
}

/**
 * A ~40 triangle version of the same building, textured with a baked facade
 * strip so the window rhythm still reads from a kilometre away. Inset 0.25 m
 * (0.9 m at street level, where shopfronts recess) so the detailed LODs always
 * cover it — that is what removes LOD popping entirely.
 */
function buildShell(spec, mb) {
  const St = spec.S;
  const strip = St.facStrip;
  const vs = SURF[strip].vsize;
  const base = spec.base;
  // Everything the shell caps or roofs sits 0.3 m below its LOD 0 twin, so the
  // two can never be coplanar. Combined with the 0.25 m horizontal inset the
  // shell is strictly inside the detailed mesh: no z-fighting, no popping.
  const DROP = 0.30;
  const stages = [];
  if (spec.setbacks && spec.setbacks.length) {
    let prevT = 0, prevPoly = spec.poly;
    for (const sb of spec.setbacks) {
      stages.push({ poly: prevPoly, y0: base + spec.h * prevT, y1: base + spec.h * sb.t });
      prevPoly = insetPoly(prevPoly, sb.inset);
      prevT = sb.t;
    }
    stages.push({ poly: prevPoly, y0: base + spec.h * prevT, y1: base + spec.h });
  } else {
    stages.push({ poly: spec.poly, y0: base, y1: base + spec.h });
  }

  const col = spec.wallCol;
  for (let si = 0; si < stages.length; si++) {
    const st = stages[si];
    const shrunk = orientOutward(insetPoly(st.poly, 0.25));
    const plinth = orientOutward(insetPoly(st.poly, 0.92));
    const m = shrunk.length;
    const gH = spec.groundH;
    for (let i = 0; i < m; i++) {
      const a = shrunk[i], b = shrunk[(i + 1) % m];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const u1 = L / SURF[strip].size;
      if (si === 0) {
        const pa = plinth[i], pb = plinth[(i + 1) % m];
        mb.wallV(pa.x, pa.z, pb.x, pb.z, st.y0, st.y0 + gH, strip, col, 0, u1, 0, gH / vs);
        // ledge closing the gap between plinth and shaft
        mb.wallV(a.x, a.z, b.x, b.z, st.y0 + gH, st.y1, strip, col,
          0, u1, gH / vs, (st.y1 - st.y0) / vs);
        mb.quadAuto([pa.x, st.y0 + gH, pa.z], [pb.x, st.y0 + gH, pb.z],
          [b.x, st.y0 + gH, b.z], [a.x, st.y0 + gH, a.z], 0, 1, 0,
          [0, 0, L / 2, 0, L / 2, 0.4, 0, 0.4], col, 'trim_stone');
      } else {
        mb.wallV(a.x, a.z, b.x, b.z, st.y0, st.y1, strip, col,
          0, u1, st.y0 / vs, st.y1 / vs);
      }
    }
    if (si < stages.length - 1) {
      mb.cap(shrunk, st.y1 - DROP, spec.roofSurf, spec.roofCol, true);
    }
  }

  const top = stages[stages.length - 1];
  const tp = orientOutward(insetPoly(top.poly, 0.25));
  const ty = top.y1 - DROP;
  if (spec.mansard) {
    const mh = spec.mansardH, inset = mh * 0.42;
    const tt = insetPoly(tp, inset);
    for (let i = 0; i < tp.length; i++) {
      const a = tp[i], b = tp[(i + 1) % tp.length];
      const a2 = tt[i], b2 = tt[(i + 1) % tp.length];
      const e = edgeFrame(a, b);
      mb.quadAuto([a.x, ty, a.z], [b.x, ty, b.z],
        [b2.x, ty + mh, b2.z], [a2.x, ty + mh, a2.z],
        e.nx, 0.35, e.nz, [0, 0, e.L, 0, e.L, mh * 1.2, 0, mh * 1.2],
        [0.95, 0.96, 0.98], 'slate');
    }
    mb.cap(tt, ty + mh, spec.roofSurf, spec.roofCol, true);
    roofField(mb, tt, ty + mh, spec);
  } else if (St.hipRoof) {
    const tt = insetPoly(tp, 1.7);
    for (let i = 0; i < tp.length; i++) {
      const a = tp[i], b = tp[(i + 1) % tp.length];
      const a2 = tt[i], b2 = tt[(i + 1) % tp.length];
      const e = edgeFrame(a, b);
      mb.quadAuto([a.x, ty, a.z], [b.x, ty, b.z],
        [b2.x, ty + 1.9, b2.z], [a2.x, ty + 1.9, a2.z],
        e.nx, 0.7, e.nz, [0, 0, e.L, 0, e.L, 3, 0, 3], [0.94, 0.95, 0.97], 'slate');
    }
    mb.cap(tt, ty + 1.9, 'slate', [0.94, 0.95, 0.97], true);
  } else {
    const ph = spec.parapet - 0.16;
    const cop = Math.min(0.30, ph * 0.45);
    for (let i = 0; i < tp.length; i++) {
      const a = tp[i], b = tp[(i + 1) % tp.length];
      const e = edgeFrame(a, b);
      mb.wall(a.x, a.z, b.x, b.z, ty, ty + ph - cop, spec.wallSurf, col, 0, 0);
      // A pale coping line at the parapet is the strongest horizontal a facade
      // has at distance; without it every roofline dissolves into the wall.
      // Two triangles an edge, stacked rather than overlaid, so nothing fights.
      mb.wall(a.x, a.z, b.x, b.z, ty + ph - cop, ty + ph, 'trim_stone', spec.trimCol, 0, 0);
      // Inner parapet face. Walls are single-sided, so without this you can see
      // straight through the far parapet into the sky from any elevated shot.
      mb.quadAuto(P(e, 0, ty, -0.18), P(e, e.L, ty, -0.18),
        P(e, e.L, ty + ph - 0.06, -0.18), P(e, 0, ty + ph - 0.06, -0.18),
        -e.nx, 0, -e.nz, [0, 0, e.L / 2, 0, e.L / 2, ph / 2, 0, ph / 2],
        [col[0] * 0.86, col[1] * 0.86, col[2] * 0.86], spec.wallSurf);
    }
    // The deck sits on the shell's own drop plane, NOT on top of the parapet.
    // Lidding the parapet put this surface up to 0.9 m ABOVE the LOD 0 deck —
    // and because the shell is always resident, that lid covered every detailed
    // roof in the city. Roofs read as bare pale planes from every elevated shot
    // while all their furniture was hidden underneath.
    mb.cap(insetPoly(tp, 0.18), ty, spec.roofSurf, spec.roofCol, true);
    roofField(mb, insetPoly(tp, 0.18), ty, spec);
    shellRoofKit(mb, insetPoly(top.poly, 0.24), top.y1, spec);
  }
  if (St.mech && spec.h > 40) {
    const pen = insetPoly(tp, Math.min(4.5, spec.h * 0.03 + 2) + 0.25);
    const py = ty + spec.parapet - 0.16, ph2 = 3.3;
    const p2 = orientOutward(pen);
    for (let i = 0; i < p2.length; i++) {
      const a = p2[i], b = p2[(i + 1) % p2.length];
      mb.wall(a.x, a.z, b.x, b.z, py, py + ph2, 'metal_panel', [0.86, 0.88, 0.9], 0, 0);
    }
    mb.cap(pen, py + ph2, 'roof_gravel', [0.9, 0.9, 0.88], true);
  }
}

export { STYLES, DISTRICT_MIX };
