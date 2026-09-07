# Northeastern University, Boston — factual source package

**Status: evidence only. Nothing here is imported by `src/`, and no world geometry
changed to produce it.** This package answers what the real district is, what the
game currently has, and how far apart those two are, so that a later modelling
wave starts from measurements instead of from someone's memory of Huntington Avenue.

This is **Northeastern University, Boston, Massachusetts** — 360 Huntington Avenue,
02115. Not Tohoku, and not the Huntington Library in California, which is what two
wikidata ids guessed from memory actually resolved to during this audit. Every
external fact below is traceable to a source in [SOURCES.md](SOURCES.md).

Regenerate with:

```bash
node tools/neu-audit/fetch.mjs && node tools/neu-audit/build.mjs
```

## The eight questions

**1. What does the game represent here today?** Essentially nothing. Three streets
pass nearby — Huntington, Columbus and Massachusetts Avenues — and the 42.3 ha
campus itself is bare ground. Standing at the real Krentzman Quadrangle in the
running game you see an empty dirt plain with the downtown skyline 2.6 km away.
The city fabric stops at a hard diagonal edge along Columbus Avenue.

**2. How does game space relate to real geography?** Exactly, and by construction.
`src/core/Geo.js` is an equirectangular projection about Boston Common
(42.35538, −71.06565); world data is stored as real lat/lon and converted at load,
so there was no transform to reconstruct. The open question was never the
projection — it was whether the hand-traced *content* sits where reality does.
It does, to a median of about 25 m. See [ANCHORS.json](ANCHORS.json).

**3. What is factually missing or wrong?** In order of severity: the whole campus
fabric is absent; Huntington Avenue is drawn ~108 m from its real centreline and
the error peaks *at the campus*; there is no rail transit anywhere in the game;
and most of the campus is not assigned to any district, so the little fabric that
does generate there is built under South End brownstone rules. See
[CURRENT_VS_REAL.md](CURRENT_VS_REAL.md).

**4. What real geometry should be canonical?** The university's own ArcGIS
footprints for buildings (104 Boston rows, with name, address, year built, gross
area and ownership), MBTA V3 for transit, and OpenStreetMap for the connective
tissue — streets, footways, steps and open space. See
[BUILDING_INVENTORY.json](BUILDING_INVENTORY.json), [TRANSIT.json](TRANSIT.json),
[PUBLIC_REALM.json](PUBLIC_REALM.json).

**5. Which sources support each claim?** [SOURCES.md](SOURCES.md), with access
dates, coverage, limitations and licence per source.

**6. What is high confidence versus inferred?** Every geometric item carries an
A/B/C/D/UNKNOWN grade. Footprints are A. Storey counts are mostly C or D.
**Heights are the single biggest hole**: the official layer publishes
`Height_Relative` and `Levels_Above_Ground` as `0` for every Boston building, so
no authoritative height exists in this package at all.

**7. What should modelling build first?** Geography before buildings: the street
and path network, then the campus ground plane, then Hero-A massing. The ordering
and its justification are in [CURRENT_VS_REAL.md](CURRENT_VS_REAL.md).

**8. Where should the player eventually spawn?** Not decided here, deliberately.
Authoritative material does not support one singular main gate — the university
calls Krentzman "one of the campus' primary gateways", and the busiest real
arrival is a transit interchange. Four evidenced candidates are in
[SPAWN_CANDIDATES.json](SPAWN_CANDIDATES.json); the choice is an owner
art/product decision, and the spawn does not move until the migration gate passes.

## Envelope

| | world x | world z |
|---|---|---|
| **Hero core** — the OSM campus polygon's extent, 42.3 ha | −2304 … −1473 | 1349 … 2307 |
| **Context buffer** — core + 320 m | −2624 … −1153 | 1029 … 2627 |

Campus centroid is world **(−1895, 1847)**, 2,647 m from Boston Common — the far
south-west of the 6 km play area. The 320 m buffer is not arbitrary: it is the
distance that reaches Symphony and Massachusetts Avenue stations, the Museum of
Fine Arts frontage, Carter Playground and the Melnea Cass edge, all of which are
visible from inside the campus or frame the approach to it.

## The one-line finding

The georeference is sound and external GIS data can be brought in safely, but it
will land **25–50 m away from the existing hand-traced streets**, so the hero
district must *replace* the geography inside its envelope rather than graft onto it.
