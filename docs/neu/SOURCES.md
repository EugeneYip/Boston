# Sources — Northeastern hero district

All accessed **2026-09-07**. Coordinates recorded in this package are facts and
measurements derived from these sources; no third-party map imagery, tiles or
screenshots are stored in the repository, and the raw extracts are cached under
`tools/neu-audit/.cache/` which is **not committed**.

---

## Tier 1 — official / government

### Northeastern University ArcGIS Online
- **Provider** Northeastern University
- **URL** `https://services5.arcgis.com/S8KZ4xiwVgqpYP63/arcgis/rest/services`
- **Layers used** `Buildings_ALL/FeatureServer/29` (227 rows, 104 with `Site_ID = BOS`),
  `AccessibleEntrance/FeatureServer/0` (82 points in the envelope)
- **Supports** Building footprints, canonical names, street addresses, `YearBuilt`,
  `YearReno`, `GrossArea`, ownership (90 owned / 11 leased), facility ids, and
  official accessible entrance points.
- **Limitations** `Levels_Above_Ground` and `Height_Relative` are present but are
  **`0` for every Boston row** — the official source publishes no heights. `PrimaryUse`
  is blank for all 104. `GrossArea` is in square feet and includes below-grade space,
  so storeys derived from it are an **upper bound**, not a measurement. A handful of
  rows imply under one storey, which means the footprint covers more than the
  enclosed area (Ruggles station is the clearest case).
- **Licence** Public REST endpoint reached from the university's own published campus
  map. **Terms of use were not separately verified.** Treat as *readable for
  reference*; confirm redistribution rights before shipping this geometry in a build.
  This is an open item — see CURRENT_VS_REAL.md.
- **How it was found** The published campus map at `campusmap.northeastern.edu`
  301-redirects to an ArcGIS Experience app; its item config names the org.

### MBTA V3 API
- **Provider** Massachusetts Bay Transportation Authority
- **URL** `https://api-v3.mbta.com/stops` (radius query about the campus centroid)
- **Supports** Station positions and ids, platform names, and station entrances.
  6 parent stations fall inside the context buffer: **Northeastern University**
  (`place-nuniv`), **Ruggles** (`place-rugg`), **Massachusetts Avenue**, **Symphony**,
  **Museum of Fine Arts** and **Prudential**. Roxbury Crossing and Nubian are just
  outside it but frame the south-western approach. Ruggles carries a nine-berth busway (A1–A4,
  B1–B5) plus an upper busway, and its entrances include one named
  *"Northeastern, Forsyth St"*. A bus stop is named *"360 Huntington Ave"* — the
  university's own address.
- **Limitations** Stop points are platform/entrance positions, not structure
  outlines; the station buildings themselves come from OSM or the university layer.
- **Licence** MBTA open data. Attribution recorded.

### USGS 3DEP elevation (EPQS)
- **Provider** U.S. Geological Survey
- **URL** `https://epqs.nationalmap.gov/v1/json`
- **Supports** 24 spot elevations on two transects — along Huntington Avenue through
  campus, and across the rail corridor at Ruggles.
- **Result** 0.9–3.6 m, about **2.6 m of relief**. The campus really is nearly flat,
  which broadly agrees with the game's own 2.9–4.7 m (1.7 m relief) — a vertical
  offset of roughly +1.5 m but the right character.
- **Limitations** Point sampling at 1 m raster resolution; **vertical datum not
  reconciled** with the game's sea-level-zero convention. It did not resolve the
  Ruggles rail cut, so treat local grade structure as unmeasured here.
- **Licence** U.S. Government work, public domain.

---

## Tier 2 — open geographic data

### OpenStreetMap, via Overpass API
- **Provider** OpenStreetMap contributors
- **URL** `https://overpass-api.de/api/interpreter` (mirror: `overpass.kumi.systems`)
- **Envelope** `42.3300,-71.1000,42.3480,-71.0780`
- **Supports** The campus polygon (`way/301210399`, 141 points, 42.3 ha, tagged
  `addr:housenumber=360`, `addr:street=Huntington Avenue`, `wikidata=Q37548`);
  1,123 road ways carrying **247 distinct street names**; 1,737 building footprints
  of which 268 are named; the pedestrian realm (**16.1 km of footway in 332 ways,
  39 stair runs** inside the campus polygon); named open spaces; rail alignments;
  and the 11 city-wide anchor footprints used for the georeference check.
- **Limitations** Community-maintained and unevenly attributed: only **34 of 1,737**
  buildings carry a height tag and 197 carry `building:levels`. Names and levels are
  good; heights are not. Relation centroids are area-weighted over outer members.
- **Licence** **ODbL 1.0.** Attribution required, and share-alike attaches to derived
  databases. This is why the raw extract is not committed and why shipping OSM
  geometry inside the game is flagged as an owner decision rather than assumed.
  <https://www.openstreetmap.org/copyright>

---

## Tier 3 — secondary cross-check

- **Northeastern University — campus address and directions.** Confirms the campus
  address **360 Huntington Avenue, Boston, MA 02115**, arrival by the Green Line E
  "Northeastern" stop and the Orange Line at Ruggles, and the Renaissance Parking
  Garage at 835 Columbus Avenue. Used only to corroborate Tier 1 facts.
  <https://campusmap.northeastern.edu/directions.html> (redirects to an ArcGIS app)
- **SAH Archipedia — Krentzman Quadrangle** (Society of Architectural Historians).
  Records the quadrangle as the original campus nucleus arising from an
  **invitational competition held in 1934**, with Ell, Richards and Dodge halls
  fronting it. <https://sah-archipedia.org/buildings/MA-01-FL7>
- **Northeastern campus guidance** describes Krentzman as *"one of the campus'
  primary gateways"* and notes the seal-bearing brick ledge at its entrance. The
  plural is the reason this package does not name a single main gate.
  <https://news.northeastern.edu/2016/09/07/a-helpful-guide-to-navigating-campus/>

---

## Sources deliberately not used

- **Aerial and street-level imagery.** Not consulted and not stored. Nothing in this
  package depends on tracing an image.
- **Boston Assessing / BPDA parcel data.** Not needed: the university's own footprint
  layer is better attributed for this district than a generic parcel extract, and the
  game does not consume real parcels at all — `RoadNetwork.buildPlots` derives every
  lot from road frontage. Worth revisiting only if the context buffer beyond campus
  is built out.
