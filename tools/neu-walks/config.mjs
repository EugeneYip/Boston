/** Shared constants. Kept out of `fetch.mjs` so importing them cannot start a download. */

/**
 * City of Boston — Sidewalk Centerline, layer 5 of the OpenData MapServer.
 *
 * PDDL: an Open Data Commons Public Domain Dedication and Licence. No attribution
 * condition and no share-alike, which is why THIS is the public-realm source and
 * not OSM — an ODbL extract cannot be committed as runtime geometry without
 * taking on share-alike obligations. See docs/neu/SOURCES.md.
 *
 * Classes in the `TYPE` field: `SWALK-CL` public sidewalk, `PWALK-CL` private
 * walk (the campus interior paths), `CWALK-CL` / `CWALK-CL-UM` marked and
 * unmarked crosswalks.
 *
 * **Vintage: created 2011, last updated 2011.** It predates ISEC (2017) and EXP
 * (2024), so the newest campus is missing. The Krentzman quadrangle is historic
 * and well covered.
 */
export const LAYER =
  'https://gisportal.boston.gov/arcgis/rest/services/Infrastructure/OpenData/MapServer/5';

/** Northeastern hero envelope plus margin, in degrees. */
export const BBOX = { w: -71.0985, e: -71.0790, s: 42.3310, n: 42.3470 };

/** The opening cluster's centre — Krentzman Quadrangle, world metres. */
export const KRENTZMAN = { x: -1864.9, z: 1698.7 };

/**
 * The ways this wave ships, and nothing else.
 *
 * 11,439 m of centreline exists inside the `northeastern` district. Importing it
 * all would be a path network nobody asked for; the brief is one arrival
 * connector and at most one continuation. These OBJECTIDs were chosen by tracing
 * endpoint connectivity outward from the Huntington public sidewalk (97257) and
 * keeping only ways that (a) form a connected route, (b) reach the Krentzman
 * octagon boundary without entering it, and (c) cross no hero footprint and no
 * carriageway.
 */
export const SELECTED = {
  /** Huntington public sidewalk -> the Krentzman octagon edge, both sides of the mouth. */
  arrival: [96012, 96013, 72294, 13933, 13932],
  /** One continuation, westward off the mouth toward the Cabot / Dana side. */
  continuation: [21249, 97343],
};

/**
 * The Huntington pavement itself (97257) is deliberately NOT shipped: `Roads`
 * already builds that sidewalk, and drawing a second surface on top of it is how
 * you get a z-fighting seam along the most important frontage in the district.
 * It is the ANCHOR, not the content.
 */
export const ANCHOR_ONLY = [97257];
