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

/**
 * One entrance cue per massed part, positioned ON that part's own outline at the
 * point where a PDDL private walk dead-ends against it. `edge` and `t` locate it
 * along the outline, so the runtime places geometry on its own footprint rather
 * than at an imported coordinate.
 */
export const NEU_ENTRANCE_CUES = [
  {
    "part": 660840,
    "buildings": [
      "Dana Research Center"
    ],
    "edge": 6,
    "t": 0.46,
    "x": -1882.34,
    "z": 1900.77,
    "edgeLenM": 5.44,
    "faceDistM": 0,
    "fromWay": 56406
  },
  {
    "part": 661061,
    "buildings": [
      "Ell Hall",
      "Curry Student Center"
    ],
    "edge": 80,
    "t": 0.82,
    "x": -1856.83,
    "z": 1731.23,
    "edgeLenM": 14,
    "faceDistM": 0.71,
    "fromWay": 56328
  },
  {
    "part": 661113,
    "buildings": [
      "Mugar Life Sciences Building"
    ],
    "edge": 18,
    "t": 0.82,
    "x": -1806.69,
    "z": 1720.68,
    "edgeLenM": 7.33,
    "faceDistM": 0.95,
    "fromWay": 56331
  },
  {
    "part": 665218,
    "buildings": [
      "Ryder Hall"
    ],
    "edge": 21,
    "t": 0.82,
    "x": -2088.37,
    "z": 2106.83,
    "edgeLenM": 34.14,
    "faceDistM": 0.9,
    "fromWay": 32370
  },
  {
    "part": 665219,
    "buildings": [
      "Ryder Hall"
    ],
    "edge": 1,
    "t": 0.82,
    "x": -2060.04,
    "z": 2069.4,
    "edgeLenM": 35.64,
    "faceDistM": 1.46,
    "fromWay": 29859
  },
  {
    "part": 666435,
    "buildings": [
      "Hayden Hall"
    ],
    "edge": 10,
    "t": 0.82,
    "x": -1903.22,
    "z": 1777.52,
    "edgeLenM": 21.8,
    "faceDistM": 0.79,
    "fromWay": 56325
  },
  {
    "part": 666436,
    "buildings": [
      "Richards Hall"
    ],
    "edge": 8,
    "t": 0.18,
    "x": -1885.07,
    "z": 1726.19,
    "edgeLenM": 22.6,
    "faceDistM": 0.83,
    "fromWay": 56327
  },
  {
    "part": 676668,
    "buildings": [
      "Dodge Hall"
    ],
    "edge": 20,
    "t": 0.82,
    "x": -1830.82,
    "z": 1648.32,
    "edgeLenM": 22.52,
    "faceDistM": 0.91,
    "fromWay": 56330
  }
];

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
