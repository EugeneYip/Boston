// Real-world geography -> world-space projection for Boston.
// Equirectangular projection centered on Boston Common. Accurate to <1m over the 6km play area.

export const ORIGIN_LAT = 42.35538;   // Boston Common, center
export const ORIGIN_LON = -71.06565;

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN_LAT * Math.PI / 180); // ~82,290 m

/** lat/lon -> world {x,z}. +X east, -Z north. */
export function geo(lat, lon) {
  return {
    x: (lon - ORIGIN_LON) * M_PER_DEG_LON,
    z: -(lat - ORIGIN_LAT) * M_PER_DEG_LAT,
  };
}

/** world {x,z} -> {lat,lon} */
export function unGeo(x, z) {
  return {
    lat: ORIGIN_LAT - z / M_PER_DEG_LAT,
    lon: ORIGIN_LON + x / M_PER_DEG_LON,
  };
}

/** Convenience: array of [lat,lon] -> array of {x,z} */
export function geoPath(pairs) {
  return pairs.map(([la, lo]) => geo(la, lo));
}

export const WORLD = {
  minX: -3000, maxX: 3000,
  minZ: -3000, maxZ: 3000,
  seaLevel: 0,
};

/** True if a world position is inside the playable bounds. */
export function inBounds(x, z) {
  return x >= WORLD.minX && x <= WORLD.maxX && z >= WORLD.minZ && z <= WORLD.maxZ;
}
