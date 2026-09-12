/** Stage 1A.2 second-area bbox. Defined and recorded BEFORE any query. */
import { geo } from '../../src/core/Geo.js';
export const CENTRE = { lat: 42.36450, lon: -71.05450 };   // North End, Boston
export const HALF_M = 200;
const dLat = HALF_M / 111320, dLon = HALF_M / (111320 * Math.cos(42.35538 * Math.PI / 180));
export const BBOX_WGS84 = {
  s: +(CENTRE.lat - dLat).toFixed(6), w: +(CENTRE.lon - dLon).toFixed(6),
  n: +(CENTRE.lat + dLat).toFixed(6), e: +(CENTRE.lon + dLon).toFixed(6),
};
const sw = geo(BBOX_WGS84.s, BBOX_WGS84.w), ne = geo(BBOX_WGS84.n, BBOX_WGS84.e);
export const BBOX_WORLD = {
  x0: +Math.min(sw.x, ne.x).toFixed(2), x1: +Math.max(sw.x, ne.x).toFixed(2),
  z0: +Math.min(sw.z, ne.z).toFixed(2), z1: +Math.max(sw.z, ne.z).toFixed(2),
};
