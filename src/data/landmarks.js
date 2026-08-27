import { geo } from '../core/Geo.js';

/**
 * Boston's landmarks, by real coordinate.
 *
 * Every entry is placed with `geo(lat, lon)` — never by eye. `keepout` is the
 * radius (metres) inside which the generic building generator must not place a
 * parcel, so the landmark always sits in its real footprint rather than being
 * swallowed by procedural infill.
 *
 * `rot` is the building's long-axis heading in radians (0 = long axis runs
 * east-west, +X). Heights are the real ones.
 */
export const LANDMARKS = [
  {
    id: 'hancock', name: '200 Clarendon (John Hancock Tower)',
    lat: 42.34894, lon: -71.07485, h: 241, rot: -0.42, keepout: 62,
    note: 'I. M. Pei / Henry Cobb rhomboid. The defining Boston skyline object.',
  },
  {
    id: 'prudential', name: 'Prudential Tower',
    lat: 42.34672, lon: -71.08238, h: 229, rot: 0.0, keepout: 66,
  },
  {
    id: 'stateHouse', name: 'Massachusetts State House',
    lat: 42.35876, lon: -71.06381, h: 34, rot: 0.06, keepout: 74,
  },
  {
    id: 'customHouse', name: 'Custom House Tower',
    lat: 42.35913, lon: -71.05329, h: 151, rot: 0.30, keepout: 40,
  },
  {
    id: 'faneuil', name: 'Faneuil Hall & Quincy Market',
    lat: 42.36000, lon: -71.05462, h: 30, rot: -0.16, keepout: 128,
  },
  {
    id: 'trinity', name: 'Trinity Church, Copley Square',
    lat: 42.34966, lon: -71.07650, h: 65, rot: -0.42, keepout: 52,
  },
  {
    id: 'bpl', name: 'Boston Public Library, McKim Building',
    lat: 42.34934, lon: -71.07800, h: 27, rot: -0.42, keepout: 60,
  },
  {
    id: 'fenway', name: 'Fenway Park',
    lat: 42.34657, lon: -71.09724, h: 30, rot: 0.62, keepout: 150,
  },
  {
    id: 'citgo', name: 'Citgo Sign, Kenmore Square',
    lat: 42.34887, lon: -71.09540, h: 40, rot: -0.30, keepout: 34,
  },
  {
    id: 'zakim', name: 'Leonard P. Zakim Bunker Hill Bridge',
    lat: 42.36631, lon: -71.06200, h: 82, rot: 0.20, keepout: 130,
  },
  {
    id: 'oldNorth', name: 'Old North Church',
    lat: 42.36632, lon: -71.05442, h: 53, rot: 0.14, keepout: 34,
  },
  {
    id: 'bunkerHill', name: 'Bunker Hill Monument',
    lat: 42.37634, lon: -71.06106, h: 67, rot: 0, keepout: 78,
  },
  {
    id: 'tdGarden', name: 'TD Garden',
    lat: 42.36624, lon: -71.06222, h: 46, rot: 0.20, keepout: 0,
    // shares the Zakim keepout; placed relative to North Station
    lat2: 42.36575, lon2: -71.06195,
  },
  {
    id: 'southStation', name: 'South Station',
    lat: 42.35234, lon: -71.05537, h: 32, rot: 0.28, keepout: 86,
  },
  {
    id: 'cityHall', name: 'Boston City Hall',
    lat: 42.36037, lon: -71.05780, h: 43, rot: -0.16, keepout: 92,
  },
  {
    id: 'constitution', name: 'USS Constitution',
    lat: 42.37244, lon: -71.05646, h: 62, rot: 0.55, keepout: 60,
  },
  {
    id: 'oldState', name: 'Old State House',
    lat: 42.35887, lon: -71.05744, h: 25, rot: 0.32, keepout: 26,
  },
  {
    id: 'onePru', name: '111 Huntington / Prudential annexe',
    lat: 42.34556, lon: -71.08094, h: 168, rot: 0.0, keepout: 40,
  },
  {
    id: 'federalSt', name: 'One Post Office Square tower group',
    lat: 42.35670, lon: -71.05620, h: 183, rot: 0.30, keepout: 42,
  },
  {
    id: 'intlPlace', name: 'One International Place',
    lat: 42.35640, lon: -71.05170, h: 184, rot: 0.30, keepout: 44,
  },
];

/** Landmark exclusion discs in world space, resolved once. */
export const KEEPOUTS = LANDMARKS
  .filter(l => l.keepout > 0)
  .map(l => { const p = geo(l.lat, l.lon); return { x: p.x, z: p.z, r: l.keepout }; });

/** Open space the building generator must leave alone (parks, squares, water). */
export const OPEN_SPACE = [
  // Boston Common
  { poly: [[42.35646, -71.06318], [42.35745, -71.06556], [42.35577, -71.06877],
           [42.35271, -71.06603], [42.35337, -71.06305]] },
  // Public Garden
  { poly: [[42.35577, -71.06877], [42.35470, -71.07173], [42.35300, -71.07020],
           [42.35400, -71.06730]] },
  // Copley Square plaza
  { poly: [[42.35010, -71.07700], [42.34980, -71.07530], [42.34880, -71.07580],
           [42.34910, -71.07750]] },
  // Back Bay Fens
  { poly: [[42.34640, -71.09330], [42.34350, -71.09000], [42.33970, -71.09500],
           [42.34320, -71.10000]] },
  // City Hall Plaza
  { poly: [[42.36125, -71.05930], [42.36090, -71.05650], [42.35930, -71.05720],
           [42.35970, -71.05990]] },
  // Christopher Columbus Park / waterfront
  { poly: [[42.36180, -71.05130], [42.36110, -71.04950], [42.35930, -71.05070],
           [42.36000, -71.05260]] },
  // Rose Kennedy Greenway (the old Central Artery scar)
  { poly: [[42.36190, -71.05590], [42.36150, -71.05450], [42.35300, -71.05620],
           [42.35340, -71.05760]] },
  // Charlestown Navy Yard water side
  { poly: [[42.37430, -71.05820], [42.37380, -71.05300], [42.37150, -71.05380],
           [42.37200, -71.05880]] },
  // Bunker Hill Monument square
  { poly: [[42.37720, -71.06210], [42.37710, -71.06000], [42.37560, -71.06010],
           [42.37570, -71.06220]] },
];

/** Pre-projected open-space polygons in world space. */
export const OPEN_SPACE_XZ = OPEN_SPACE.map(o => o.poly.map(([la, lo]) => geo(la, lo)));

/** Point-in-polygon in the XZ plane. */
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) &&
        x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** True if a point must be left free of procedural buildings. */
export function isReserved(x, z) {
  for (const k of KEEPOUTS) {
    const dx = x - k.x, dz = z - k.z;
    if (dx * dx + dz * dz < k.r * k.r) return true;
  }
  for (const p of OPEN_SPACE_XZ) if (inPoly(x, z, p)) return true;
  return false;
}
