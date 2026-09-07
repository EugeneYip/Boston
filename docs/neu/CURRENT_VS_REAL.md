# Current vs real — Northeastern hero district

Measurements from `tools/neu-audit/build.mjs`; the machine-readable form is in
`GAPS.json`. Nothing in `src/` changed to produce this document.

## 1. Georeference — sound

The world is **genuinely georeferenced**, category A. `src/core/Geo.js` is an
equirectangular projection about Boston Common and every real thing is stored as
lat/lon and converted through `geo()` at load. No transform had to be reconstructed.

What *is* uncertain is the hand-traced content, and that is what the anchor check
measures: 11 city-wide landmarks against their footprint centroids in OSM.

| | n | median | p90 | max |
|---|---|---|---|---|
| all anchors | 11 | 24.7 m | 132.8 m | 183.1 m |
| definition-clean | 8 | 24.7 m | 51.4 m | 95.4 m |

"Definition-clean" drops three entries whose game pin deliberately covers a
different extent from the OSM feature — Faneuil Hall (the game entry is *Faneuil
Hall & Quincy Market*), South Station (whole station vs head house) and the BPL
(McKim building only). Those are naming differences, not errors, and leaving them
in would overstate the drift.

Mean offset is **15.4 m** against a 24.7 m median scatter, so there is **no
rotation, scale or datum fault** — just per-landmark authoring variance.

**Operational consequence.** External GIS geometry can be imported safely and will
be internally consistent. It will *not* line up with the existing hand-traced
streets to better than 25–50 m. The hero district must therefore **replace** the
geography inside its envelope, in one coherent piece, rather than being stitched
onto the current polylines. Attempting to graft will produce visible seams at the
envelope boundary — which is where the transition needs the most care.

## 2. Huntington Avenue is in the wrong place, worst at the campus

The game draws Huntington Avenue as a **9-vertex polyline**. Sampled every 20 m
against the real centreline:

| street | samples | median | p90 | max |
|---|---|---|---|---|
| Huntington Avenue | 73 | **107.6 m** | 149.1 m | 157.3 m |
| Massachusetts Avenue | 54 | 95.3 m | 234.9 m | 264.8 m |
| Columbus Avenue | 23 | 89.5 m | 96.6 m | 97.3 m |
| Tremont Street | 10 | 37.5 m | 47.6 m | 51.7 m |

The Huntington error is not uniform. Per vertex it runs 66 m → 34 → 80 → 104 →
129 → **152** → 91 → 64 → 43 m, and the game's line lies consistently **north-west**
of the real one. That is the signature of too few vertices cutting the chord of a
curve, and the maximum falls **exactly at the campus**. The street that gives the
university its address is displaced by more than a city block precisely where it
matters most.

Consequence in engine terms: the campus bounding box contains **4 road edges and
1,396 m of centreline**, and they are named Columbus Avenue and Massachusetts
Avenue. **Huntington Avenue does not enter the campus bounding box at all.**

## 3. The campus is empty, and that follows from the roads

`RoadNetwork.buildPlots` walks road frontage; `Buildings` builds on the resulting
parcels. Ground with no street near it therefore produces no city. Distance from
each 10 m cell of the real campus polygon to the nearest road the game has:

- min **0.2 m**, median **182 m**, p90 **407 m**, max **611 m**
- within 40 m of any game road: **10.9 %** of campus
- within 100 m: 27.3 % · within 200 m: 55.2 % · within 300 m: 77.2 %

Measured in the running engine, the campus bounding box holds **118 generated
buildings** — 79 under `fenway` midrise rules, 39 under `southEnd` brownstone —
with median height 16.7 m. The real campus polygon alone holds **107 buildings, 77
of them named**, including a 22-storey residence and a 60 m tower.

Worse, **6 of 8 probed campus locations return `district: null`**. `buildPlots`
falls back to `Z.southEnd` for an unknown district, so the sparse fabric that does
appear on campus is authored as South End brownstones.

## 4. Gap matrix

Ranked by *screen-space prominence × recognisability × frequency of encounter ×
systemic leverage ÷ implementation risk*. Scores are 1–5; the rank column is the
resulting product, and the reasoning is stated so it can be argued with.

| system | state | prom | recog | freq | lever | risk | rank | note |
|---|---|---|---|---|---|---|---|---|
| Street & path geography | **MISSING** | 5 | 5 | 5 | 5 | 2 | **313** | Everything else is derived from it. 247 real named streets in the envelope; the game has 7. |
| Campus public realm | **MISSING** | 5 | 5 | 5 | 3 | 2 | **188** | 16.1 km of footway, 39 stair runs, 9 named greens. This *is* the campus at eye level. |
| Huntington Ave alignment | **WRONG** | 5 | 5 | 4 | 4 | 2 | **200** | 107.6 m median, 152 m at the campus. Cheap to fix, blocks everything downstream. |
| Building footprints | **MISSING** | 5 | 4 | 4 | 4 | 2 | **160** | 104 official footprints available at confidence A. |
| District identity | **WRONG** | 3 | 3 | 5 | 5 | 1 | **225** | `district: null` over most of campus → South End brownstone fallback. One data fix, very high leverage. |
| Building height / massing | **PARTIAL** | 4 | 4 | 4 | 2 | 4 | **32** | No authoritative heights exist. Needs survey or explicit inference. |
| Building identity | **MISSING** | 4 | 5 | 3 | 2 | 4 | **30** | Names are known; bespoke modelling is expensive. Hero-A only. |
| Transit | **MISSING** | 4 | 5 | 3 | 2 | 4 | **30** | No rail transit anywhere in the game. Ruggles is a 7,339 m² structure (OSM footprint; the university's own layer records only its 2,427 m² share) over a rail cut. |
| Vegetation | **PARTIAL** | 3 | 2 | 4 | 2 | 2 | **24** | Street trees exist citywide; campus landscape structure does not. |
| Terrain / grade | **CORRECT ENOUGH** | 2 | 1 | 3 | 1 | 3 | **2** | USGS: ~2.6 m relief. Game: 1.7 m. Do **not** open terrain work on this evidence. |
| Campus-edge urban fabric | **PARTIAL** | 3 | 2 | 3 | 3 | 3 | **18** | Fabric stops at a hard diagonal along Columbus Avenue. |
| Intersections | **PARTIAL** | 2 | 2 | 4 | 3 | 2 | **24** | Follows from the street graph; not separately actionable. |
| Ownership / licensing | **OWNER DECISION** | — | — | — | — | — | — | ODbL share-alike, and university ArcGIS terms unverified. Resolve before shipping geometry. |

**The four that matter:** street geography, district identity, the Huntington
alignment, and the public realm. District identity is the cheapest by a wide
margin — it is a data fix with no geometry attached.

## 5. Modelling waves

Reordered from the brief's suggestion on the evidence above. The change is that
**district identity and the Huntington re-trace come first**, before any footprint
work, because both are cheap and everything downstream inherits them.

- **Wave 0 — corrections.** Re-trace Huntington Avenue in the envelope at proper
  vertex density; add the missing campus district with its own zoning entry so
  `districtAt` stops returning null and the South End fallback stops firing.
  No new systems. Small, and it stops the district generating wrong.
- **Wave 1 — geography foundation.** Street and service-road graph, campus ground
  plane, the pedestrian network as real geometry rather than decoration.
- **Wave 2 — Hero-A massing.** 31 buildings on the two arrival sequences.
- **Wave 3 — Hero-B and Context-C massing and materials.** 9 + 46 buildings.
- **Wave 4 — public realm.** Krentzman, Centennial Common, Carter Playground,
  the quads, steps, landscape structure, the seal ledge.
- **Wave 5 — transit and surrounding context.** Ruggles and its rail cut, the
  Green Line E surface running on Huntington, the Southwest Corridor.
- **Wave 6 — eye-level, pedestrian and vehicle QA.**
- **Wave 7 — spawn migration gate.**

## 6. Spawn migration gate — all must pass

The canonical spawn and the `#f07318` starting SUV move **together**, and only when:

1. real geography established in the envelope;
2. major roads correct — Huntington median offset under ~10 m;
3. key campus building massing credible;
4. key campus public realm credible;
5. eye-level visual audit passes;
6. player pedestrian access passes;
7. starting SUV physical placement passes;
8. vehicle exit/entry access passes;
9. opening camera composition passes.

Until then the spawn stays at world (166, 128) on the Boston Common edge, 2,684 m
from the campus centroid.

## 7. Open factual questions

1. **No authoritative building heights exist.** Neither the university layer nor
   OSM supplies them at coverage. Options: derive from gross area over footprint
   (upper bound, confidence D), survey by hand from elevation photographs, or find
   a BPDA/Assessing height field. **This is the biggest blocker to Wave 2.**
2. **Licensing.** ODbL share-alike on anything OSM-derived that ships, and the
   university ArcGIS terms are unverified. An owner decision, not a technical one.
3. **The Ruggles rail cut is unmeasured.** USGS point sampling did not resolve it.
   The MBTA topology shows stair and ramp top/bottom pairs, so the grade separation
   is real; its depth is not established.
4. **Vertical datum** between USGS 3DEP and the game's sea-level-zero is not
   reconciled — a consistent ~1.5 m offset was observed but not explained.
5. **`PrimaryUse` is blank** for all 104 official rows, so building typology
   (residence / lab / athletics) currently rests on names and OSM tags.
