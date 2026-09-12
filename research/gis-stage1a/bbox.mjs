/** Stage 1A area definition. Resolved once, recorded, never silently moved. */
import { geo, unGeo } from '../../src/core/Geo.js';

/** From the accepted handoff: Back Bay, 400 m square, centred here. */
export const CENTRE = { lat: 42.34950, lon: -71.08000 };
export const HALF_M = 200;

/** The handoff's stated bbox, reproduced exactly. */
export const BBOX_WGS84 = { s: 42.347703, w: -71.082431, n: 42.351297, e: -71.077569 };

/** Same box in current Boston local X/Z, via the game's own geo(). */
const sw = geo(BBOX_WGS84.s, BBOX_WGS84.w);
const ne = geo(BBOX_WGS84.n, BBOX_WGS84.e);
export const BBOX_WORLD = {
  x0: Math.min(sw.x, ne.x), x1: Math.max(sw.x, ne.x),
  z0: Math.min(sw.z, ne.z), z1: Math.max(sw.z, ne.z),
};
export const inBox = (x, z) =>
  x >= BBOX_WORLD.x0 && x <= BBOX_WORLD.x1 && z >= BBOX_WORLD.z0 && z <= BBOX_WORLD.z1;
