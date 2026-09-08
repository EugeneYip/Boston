/**
 * Northeastern hero district — factual public-realm paths. GENERATED, do not hand-edit.
 *
 *   node tools/neu-walks/fetch.mjs && node tools/neu-walks/build.mjs
 *
 * Source:  City of Boston — Sidewalk Centerline (OpenData MapServer layer 5)
 * Licence: PDDL (Open Data Commons Public Domain Dedication and Licence)
 * Vintage: created 2011, last updated 2011
 * Service: https://gisportal.boston.gov/arcgis/rest/services/Infrastructure/OpenData/MapServer/5
 *
 * PDDL is a public-domain dedication — no attribution condition, no share-alike —
 * which is the whole reason this is the public-realm source. The OSM footway
 * extract in `docs/neu/PUBLIC_REALM.json` is ODbL and confidence C; committing it
 * as runtime geometry would attach share-alike obligations to the game. Do not
 * substitute it.
 *
 * **This is a deliberate SELECTION, not the network.** 11,439 m of centreline
 * exists inside the `northeastern` district; 163.26 m ships. Every way here
 * was validated against the geometry that already exists — none crosses a hero
 * footprint, none enters the Huntington carriageway, none runs through the
 * Krentzman octagon, where the park pipeline already owns the circulation.
 *
 * Points are [x, z] in world metres, already projected through `Geo.geo()`.
 * Endpoints are shared between consecutive ways, so the route is genuinely
 * connected rather than a bundle of near-misses.
 */

/** Huntington public sidewalk -> the Krentzman octagon boundary. */
export const NEU_WALK_ARRIVAL = [
    { id: 96012, cls: 'SWALK-CL', lengthM: 14.72,
      pts: [[-1901.03,1682.58], [-1888.09,1675.58]] },
    { id: 96013, cls: 'SWALK-CL', lengthM: 21,
      pts: [[-1888.09,1675.58], [-1886.37,1674.65], [-1869.8,1665.27]] },
    { id: 72294, cls: 'SWALK-CL', lengthM: 13.89,
      pts: [[-1869.8,1665.27], [-1857.71,1658.43]] },
    { id: 13933, cls: 'SWALK-CL', lengthM: 30.71,
      pts: [[-1901.03,1682.58], [-1895.78,1687.68], [-1876.63,1701.12]] },
    { id: 13932, cls: 'SWALK-CL', lengthM: 31.1,
      pts: [[-1857.71,1658.43], [-1855.99,1662.29], [-1855.08,1689.15]] },
];

/** One continuation, westward off the quadrangle mouth. */
export const NEU_WALK_CONTINUATION = [
    { id: 21249, cls: 'SWALK-CL', lengthM: 4.03,
      pts: [[-1904.58,1684.5], [-1901.03,1682.58]] },
    { id: 97343, cls: 'SWALK-CL', lengthM: 47.8,
      pts: [[-1946.53,1707.42], [-1937.54,1702.34], [-1904.58,1684.5]] },
];

/**
 * The Huntington pavement itself. NOT drawn — `Roads` already builds that
 * sidewalk, and a second surface on top of it is a z-fighting seam along the most
 * important frontage in the district. Recorded because it is what the arrival
 * connector is anchored TO.
 */
export const NEU_WALK_ANCHOR_IDS = [97257];

export const NEU_WALK_SOURCE = {
  dataset: 'Sidewalk Centerline',
  publisher: 'City of Boston (Analyze Boston / gisportal.boston.gov)',
  licence: 'PDDL (odc-pddl)',
  vintage: '2011 snapshot, last updated 2011',
  service: "https://gisportal.boston.gov/arcgis/rest/services/Infrastructure/OpenData/MapServer/5",
  classes: { 'SWALK-CL': 'public sidewalk', 'PWALK-CL': 'private walk', 'CWALK-CL': 'crosswalk' },
  districtTotalM: 11439,
  shippedM: 163.26,
  shippedWays: 7,
  krentzman: {"x":-1864.9,"z":1698.7},
};

/** Ways named in config but dropped by validation, with the reason. */
export const NEU_WALK_REJECTED = [];
