import { GIS_ROADS, GIS_ROADS_CLIPPED, GIS_ROADS_SOURCE } from '../data/gis-backbay-roads.js';

/**
 * Stage 2A prototype — factual Back Bay road centrelines.
 *
 * **DEFAULT OFF.** Without `?gisRoads=1` nothing here runs: `apply()` is never
 * called and `RoadNetwork.build()` consumes the same `STREETS` array it always
 * did, by identity.
 *
 * ## What this is, after four stages of finding out what it is not
 *
 * Stage 1D established that Boston's Back Bay street geometry is hand-authored
 * to landmark anchors — `src/data/boston-geo.js` says so itself, "a median ~25 m
 * from reality" — and that no transform repairs it, because the error is
 * per-street and even per-side. Stage 1E found that the City publishes factual
 * street centrelines under ODC-PDDL-1.0 whose lines are inside a real building
 * 0.23% of the time against the hand-authored 42.35%.
 *
 * So this swaps ONE thing: the geographic centreline backbone, inside a bounded
 * box. Everything downstream — frontage, parcels, buildings, facades, sidewalks,
 * traffic, props, collision — regenerates from it through exactly the code that
 * already exists. That is the experiment: not better buildings, better ground
 * for the same buildings to stand on.
 *
 * ## What stays procedural, deliberately
 *
 * Road width, lane count, road class, footway, kerb, parking bays. SAM publishes
 * no authoritative width, so inventing one would confound the variable this
 * stage exists to isolate. Each factual street inherits the width semantics
 * Boston already uses for the street of that name.
 */

/** Query-flag control. Absent flag ⇒ absent feature. */
export function isEnabled() {
  if (typeof location === 'undefined' || !location.search) return false;
  const q = new URLSearchParams(location.search);
  const on = (k) => { const v = q.get(k); return v === '1' || v === 'true'; };
  if (!on('gisRoads')) return false;
  // Fail-safe, not precedence. The Stage 1B/1B.1 whole-footprint candidate
  // replaces buildings on the assumption that the roads under them are the
  // hand-authored ones; stacking it on a moved road graph would produce a
  // result neither experiment could be held responsible for. Refuse both.
  if (on('gisBackBay')) {
    console.error('[gis-roads] ?gisRoads and ?gisBackBay are mutually exclusive; BOTH disabled.');
    return false;
  }
  return true;
}

/** True when the two experimental flags were supplied together. */
export function isConflicting() {
  if (typeof location === 'undefined' || !location.search) return false;
  const q = new URLSearchParams(location.search);
  const on = (k) => { const v = q.get(k); return v === '1' || v === 'true'; };
  return on('gisRoads') && on('gisBackBay');
}

export const CORE = GIS_ROADS_SOURCE.core;
export const source = GIS_ROADS_SOURCE;

/**
 * Swap the road backbone inside the factual core.
 *
 * @param {Array<object>} streets Boston's own `STREETS`, untouched.
 * @returns {{streets: Array<object>, ledger: object}} the array to build from.
 *
 * Order is load-bearing. Hand-authored entries come first so that
 * `RoadNetwork.build()`'s pass-2 endpoint snap — which MOVES the endpoint it is
 * processing — pulls the clipped procedural stubs onto the factual lines rather
 * than the other way round. The factual core is the thing that must not move;
 * all geometric accommodation belongs in the seam.
 */
export function apply(streets) {
  const clippedByIndex = new Map(GIS_ROADS_CLIPPED.map((c) => [c.index, c]));
  const out = [];
  const ledger = {
    enabled: true, source: GIS_ROADS_SOURCE.dataset, licence: GIS_ROADS_SOURCE.licence,
    core: CORE, factualStreets: 0, proceduralKept: 0, proceduralClipped: 0,
    proceduralRuns: 0, proceduralFullyRemoved: 0,
  };
  for (let i = 0; i < streets.length; i++) {
    const c = clippedByIndex.get(i);
    if (!c) { out.push(streets[i]); ledger.proceduralKept++; continue; }
    ledger.proceduralClipped++;
    if (!c.runs.length) { ledger.proceduralFullyRemoved++; continue; }
    for (const run of c.runs) {
      out.push({ ...streets[i], path: run });
      ledger.proceduralRuns++;
    }
  }
  for (const r of GIS_ROADS) { out.push(r); ledger.factualStreets++; }
  return { streets: out, ledger };
}
