# OSM / factual-GIS hybrid world architecture — feasibility study

**Date** 2026-09-11 · **Baseline** `a96589e19fd68ab90f98b974120688f32262595a` (HEAD == origin/main, clean, 0/0)
**Status** RESEARCH ONLY. Nothing here is authorised. No runtime code was changed and no dataset was added.
**Scope** Would Boston benefit from factual geospatial data as an OFFLINE city-structure input, keeping the
existing Three.js procedural/game systems and using dedicated models only for selected hero structures?

Evidence grades used throughout: **CONFIRMED** (measured here, or quoted from a primary source) ·
**SUPPORTED** (strong indirect evidence) · **PLAUSIBLE** · **UNKNOWN** · **UNSUPPORTED**.

---

## A. Executive verdict

**CONDITIONAL GO — with one substantive correction to the hypothesis.**

The proposed architecture is sound, and this study did not have to imagine it. **It already exists in this
repository, built, shipped and documented, for one district.** The Northeastern hero cluster runs precisely the
pipeline the Owner describes:

```
authoritative GIS  →  offline fetcher  →  committed factual package  →  offline normalizer
                   →  generated Boston-canonical ES module  →  existing runtime systems
```

`tools/neu-height/footprints.mjs` and `tools/neu-walks/fetch.mjs` fetch; `docs/neu/*.json` is the committed
factual package; `tools/neu-hero/build.mjs` normalises; `src/data/neu-hero.js` and `src/data/neu-walks.js` are
generated, provenance-stamped runtime modules; `src/world/NeuHero.js` consumes them; and
`Districts.isReserved` → `inHeroFootprint` plus `Buildings.heroOverlap` make the procedural city step aside.
The hero-override registry exists twice over — `src/data/landmarks.js` + the `BUILDERS` map in
`Landmarks.js:1029` for point landmarks, and the NEU footprint path for clusters.

So the question is not *whether the architecture works*. It is **whether to generalise it citywide, and from
which source.** On the second half, the evidence contradicts the framing of the brief:

> **OpenStreetMap is the wrong primary source for Boston, and the project already knows this.**

For every category Boston actually needs, a licence-cleaner authoritative source exists and is already in use:
City of Boston open data is **PDDL** (public-domain dedication — no attribution condition, no share-alike),
MassGIS is a public record explicitly redistributable including derivative works, MBTA and USGS are public.
OSM is **ODbL**, which attaches share-alike to derived *databases* — and a file of footprint rings is a derived
database, not a produced work. The project's standing position (`src/data/boston-geo.js:26-28`,
`src/data/neu-walks.js:12-16`) is therefore **correct and is confirmed by primary sources in §F**.

**The recommendation is therefore:**

| question | answer |
|---|---|
| Adopt a factual-GIS-informed world-generation path? | **YES** |
| Should OSM be runtime data? | **NO — never.** |
| Should OSM be build-time input? | **NO** for geometry. **YES** for corroboration and attribute hints, which is what it already does. |
| What should be the build-time geometry input? | **City of Boston (PDDL) + MassGIS**, the sources already in the tree. |
| Should the procedural road/building systems survive? | **YES, entirely.** They are the product. |

The honest headline is a reframing: the Owner asked about **OSM**; the answer is **yes to the pipeline, no to
the source.** Everything else in the brief survives intact.

### The number that decides it

| error term | magnitude | grade |
|---|---|---|
| Hand-authored Boston geography vs reality, 8 definition-clean anchors | **median 24.7 m**, p90 51.4 m, max 95.4 m | CONFIRMED (`docs/neu/ANCHORS.json`) |
| The `geo()` projection itself, worst case over the 6 km play box | **6.47 m** | CONFIRMED (measured, §C) |
| Authoritative footprint source vs independently known truth | **sub-metre** (Prudential 228 m vs 228 m; 111 Clarendon 240.2 m vs 241 m) | CONFIRMED (`src/data/neu-hero.js` header) |

Factual input would cut positional error by roughly an order of magnitude. **The projection is not the limiting
factor and must not be touched** — see §C.

---

## B. Current Boston architecture map

### B.1 The factual layer is astonishingly small

Measured at `a96589e`:

| dataset | records | vertices | note |
|---|---|---|---|
| `STREETS` | 124 polylines | 730 | **100.4 km** of centreline, **7.3 vertices/km** |
| `PARKS` | 21 rings | 160 | |
| `WATER` | 5 rings | 98 | |
| `DISTRICTS` | 10 rings | 106 | ordered; first containing ring wins |
| `HILLS` | 9 | — | analytic drumlins, not a DEM |
| `LANDMARKS` | 10 | — | point + height + rotation + keepout |
| `NEU_HERO_PARTS` | 21 parts | 674 | the only real footprints in the world |

**The entire factual placement layer of Boston is 98,932 bytes of ES module** (`src/data/`, 5 files).
Everything else — every building, every kerb, every tree, every parked car — is generated from it.

7.3 vertices/km is the key structural fact: a 500 m street carries about four vertices. Boston's actual street
geometry is far richer than the input can express. CONFIRMED.

### B.2 Who consumes factual placement vs who generates appearance/behaviour

This is the distinction the brief asks for, and it is unusually clean in this codebase.

**CONSUMES FACTUAL PLACEMENT** (would receive better input):

| system | factual input today | source |
|---|---|---|
| `Terrain` | `HILLS`, `WATER` → 10 m raster (681×681), `BASE_LAND` 3.9 m, value noise | `boston-geo.js` |
| `RoadNetwork` | `STREETS` (path, type, lanes, oneway, surface, per-vertex `y`) | `boston-geo.js` |
| `Districts` | `DISTRICTS`, `PARKS` | `boston-geo.js` |
| `Water` | `WATER` (kind, level, depth, ring) | `boston-geo.js` |
| `Landmarks` | `landmarks.js` lat/lon/h/rot/keepout | authored |
| `NeuHero` | `neu-hero.js` outlines + heights | **City of Boston, PDDL** |
| `Transit` | Huntington reservation + `GREEN_LINE_E.json` anchors | MBTA |
| (public realm) | `neu-walks.js` | **City of Boston Sidewalk Centerline, PDDL** |

**GENERATES APPEARANCE / BEHAVIOUR** (must not be replaced):

`Buildings`, `BuildingKit`, `Facades`, `Roads` (geometry/LOD/decals), `Props`, `StreetFurniture`,
`Vegetation`, `ParkPaths`, `VehicleModels`, `VehicleFactory`, `Traffic`, `Pedestrians`, `Navigation`,
`Decals`, and the whole of `src/gfx`. These consume *derived* structures (`city.plots`, `city.roads`,
`city.parks`, `groundHeight()`), never raw geography.

**The seam between the two lists is `City._publish()`.** That is the insertion point. See §B.4.

### B.3 Build order (from `City.init`, "not negotiable")

```
Terrain.bake()            HILLS + WATER + noise → 10 m raster
RoadNetwork.build()       STREETS → nodes/edges
Terrain.stampRoads(net)   roads write their profile back into the raster (cut AND fill)
Districts.bake()          DISTRICTS + PARKS + water → district raster
Terrain.build()           ground mesh, tinted by district
buildParkPaths()          derived from parks + net + water
Districts.build()
net.buildSidewalks()
net.buildPlots(districtAt, isReserved)   ← every building in Boston originates here
net.buildSpawns()
Roads.build() / Water.build()
City._publish()           ← THE CONTRACT
City._colliders()
```

### B.4 The published contract

`city.groundHeight(x,z)`, `city.districtAt(x,z)`, `city.plots[]`, `city.parks[]`, `city.spawnPoints[]`, and
`city.roads = { nodes, edges, laneCenter, sample, nearestEdge, outgoing, laneCount, parkingLane,
parkingAllowedNear, … }`.

Everything downstream — traffic, pedestrians, props, vegetation, lighting, physics — reads only this.
**CONFIRMED** by grep: `Traffic.js` touches only `city.roads.sample / nearestEdge / edges`;
`Props.js` only `city.roads`, `city.parks`, `city.groundHeight`, `city.districtAt`.

### B.5 The parcel schema — the hard constraint

`RoadNetwork.buildPlots` (line 1149) emits, per road edge and side:

```js
{ id, district, zoning, maxHeight,
  polygon: [p0, p1, q1, q0],          // EXACTLY 4 vertices: frontage + perpendicular extrusion
  frontage: { a: p0, b: p1 },
  width, depth, edgeId, side, y }
```

A Boston parcel is **not a footprint**. It is a road-relative quad: a run of street frontage extruded
perpendicular to a depth limited by `rayToRoad` and `_fitDepth`. `Buildings.js:1051` enforces this:

```js
if (!p?.polygon || p.polygon.length !== 4 || !Number.isFinite(p.edgeId)) continue;
```

This is the single most important constraint in the whole study, and §K quantifies exactly how much of real
Boston it can absorb.

---

## C. Coordinate / projection findings

### C.1 What the world actually is

`src/core/Geo.js` — an **equirectangular (equidistant-cylindrical) projection on a spherical Earth**, origin
Boston Common (42.35538, −71.06565), fixed constants `M_PER_DEG_LAT = 111320` and
`M_PER_DEG_LON = 111320·cos(φ₀) = 82263.28`. Y up, 1 unit = 1 m, +X east, −Z north, play box ±3000 m.

### C.2 Measured distortion — the docstring is an over-claim

`Geo.js` says *"Accurate to <1m over the 6km play area."* Measured against the WGS84 ellipsoid using a Vincenty
inverse over a 250 m grid across the full play box:

| quantity | measured | grade |
|---|---|---|
| max \|geo() distance − geodesic\| over the play box | **6.47 m** (at x=0, z=+3000) | CONFIRMED |
| north scale factor k_n | 1.002159 (**+2159 ppm**) | CONFIRMED |
| east scale factor k_e | 0.998484 (**−1516 ppm**) | CONFIRMED |
| anisotropy k_n/k_e | 1.003680 → **3680 ppm of shape distortion** | CONFIRMED |
| bearing shear at 45° | 6.31 arcmin → 0.92 m lateral over 500 m | CONFIRMED |
| a real 100 m square renders as | 99.848 m E-W × 100.216 m N-S | CONFIRMED |

So the **"<1 m" claim is UNSUPPORTED** by a factor of ~6.5. `docs/neu/ANCHORS.json` likewise says the
projection is *"exact by construction"* — true of the world frame's internal self-consistency, not of its
agreement with WGS84. Both are documentation-hygiene items for the Owner; **neither was changed here**
(`src/core/*` is locked by `ARCHITECTURE.md`, and `docs/neu/ANCHORS.json` is generated).

### C.3 Projection candidates compared

| method | max residual vs geodesic over the play box | angular distortion | complexity | interop | verdict |
|---|---|---|---|---|---|
| **Current `geo()` equirectangular** | **6.47 m** | 6.3 arcmin shear | trivial, already shipped | every tool already speaks it | **KEEP** |
| Two-scalar ENU calibration (`kx=1.0015182`, `kz=0.9978458`) | **0.45 m** | ~0 | one-line change | same | future option, whole-world only |
| Full local-tangent ENU (ellipsoidal) | <0.5 m | ~0 | moderate | good | no better than the two-scalar fix here |
| Web Mercator EPSG:3857 raw | scale factor 1.353, **2230 ppm variation** across the box (6.69 m differential) | conformal | trivial | tile-native | **REJECT** for a metric game world |
| MA State Plane Mainland EPSG:26986 (NAD83 LCC) | **0.137 m**, point scale −28…−35 ppm, 6.4 ppm variation | **zero, conformal** | moderate | best-in-class for MassGIS | **REJECT** — see below |

EPSG:26986 is geometrically the best of these and is the native CRS of MassGIS. It is nevertheless the wrong
choice, for one measured reason: **grid convergence at Boston is ≈0.29°.** Adopting it raw would rotate the
entire world 0.29° off true north — about 15 m of lateral displacement at the play-area edge — invalidating
every authored coordinate, the frozen Northeastern district, kerbside parking, road/terrain stamping and
collision. CONFIRMED by computation.

### C.4 Recommendation — ONE canonical method

**Keep `geo()` exactly as it is.** Promote it from an implementation detail to a named, versioned contract —
the *Boston Local Frame* — with its constants published in every provenance manifest. Every importer projects
through the **game's own `geo()`**, never a private projection. This is already the documented rule in
`tools/neu-audit/README.md` ("a private projection could disagree with the engine and the disagreement would
look like a geography defect") and it is correct.

Rationale: the projection contributes ≤6.47 m; the authoring contributes a median 24.7 m. **Fixing the smaller
term first would move every existing feature by up to 6.5 m while leaving the dominant error untouched** — a
guaranteed regression of the frozen Northeastern district in exchange for nothing visible. Record the
two-scalar calibration as a *future, whole-world, single-wave* option and never as a partial one.

---

## D. OSM capability vs Boston data reality

All counts measured **2026-09-11** by Overpass `make count` over the exact play-area bbox
`42.328431,-71.102118,42.382329,-71.029182`. Counts only; no geometry extract was taken. CONFIRMED.

### D.1 Buildings — schema is rich, Boston is empty

25,010 building ways in the play box.

| tag | count | % of buildings | class |
|---|---|---|---|
| `building` | 25,010 | 100% | **HIGH RELIABILITY** (footprint geometry) |
| `building:levels` | 3,845 | **15.4%** | SPARSE |
| `roof:shape` | 938 | **3.7%** | SPARSE |
| `height` | 749 | **3.0%** | SPARSE |
| `building:material` | 700 | **2.8%** | SPARSE |
| `name` | 1,587 | 6.3% | SPARSE but useful for POI |
| `building:colour` | 175 | **0.7%** | NOT SUITABLE |
| `min_height` | 10 | **0.04%** | NOT SUITABLE |
| `building:part` | 2,811 ways | — | concentrated on a few towers |

### D.2 Roads — the strongest attribute coverage

8,736 drivable ways (`motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street`):

| attribute | count | % | class |
|---|---|---|---|
| centreline geometry | 8,736 | 100% | **HIGH** |
| `surface` | 5,958 | 68.2% | **MEDIUM-HIGH** |
| `name` | 5,173 | 59.2% | **MEDIUM-HIGH** |
| `lanes` | 5,045 | 57.7% | **MEDIUM** |
| `width` | 4,472 | 51.2% | MEDIUM |
| `oneway` | 4,378 | 50.1% | MEDIUM (absence usually means two-way) |
| `bridge` / `tunnel` | 939 / 788 ways | — | **HIGH** where present |

Topology (shared nodes at junctions) is **HIGH RELIABILITY** and is OSM's genuine structural strength.

### D.3 Public realm — OSM's best category in Boston, by a wide margin

| feature | count | class |
|---|---|---|
| `highway=footway` | **20,017 ways** | **HIGH** |
| `footway=crossing` | **6,541** | **HIGH** |
| `highway=pedestrian` | 364 | HIGH |

For comparison the City's PDDL Sidewalk Centerline layer holds 11,439 m across 570 ways inside the
Northeastern district alone but **was last updated in 2011** and predates ISEC (2017) and EXP (2024).
OSM is current; the City layer is licence-clean. This is the one category where the trade-off is genuinely
uncomfortable — see §E.3.

### D.4 Everything else

| category | count | class |
|---|---|---|
| `leisure=park` | 248 | **HIGH** (extent), MEDIUM (classification) |
| `natural=water` / `natural=coastline` | 27 / 41 ways | **HIGH** |
| `railway` ways | 1,206 | **HIGH** for alignment |
| station/halt/entrance/tram_stop nodes | 146 | MEDIUM — MBTA is authoritative |
| `public_transport` nodes | 838 | MEDIUM |
| `landuse` ways | 1,892 | **MEDIUM** — good district-hint signal |
| `amenity=university\|hospital\|school\|college\|place_of_worship` | 162 | **HIGH** for hero candidacy |
| `historic` | 191 | **HIGH** for hero candidacy |
| `tourism` | 112 | MEDIUM |

**NOT SUITABLE AS AUTHORITATIVE 3D DETAIL, in any category:** facade composition, window rhythm, storey
heights, cornices, materials at building scale, ground-floor treatment, roof detail. OSM contains none of it,
and nothing in §D.1 comes close to supplying it. Any claim otherwise is UNSUPPORTED.

---

## E. Official GIS complement

### E.1 The stronger architecture is **official GIS first, OSM as cross-check**

| source | publisher | role | licence | redistributable? | confidence |
|---|---|---|---|---|---|
| **Boston 3D Buildings (Existing)** | City of Boston Planning Dept / Boston Maps | **massing + heights citywide** | **PDDL** | **Yes, unconditionally** | CONFIRMED |
| **Buildings with Roof Breaks** (FeatureServer/9) | City of Boston | footprints + `GRND_ELEV`/`ROOF_ELEV`/`BLDG_HGT` | **PDDL** | Yes | CONFIRMED — already in use |
| **Sidewalk Centerline** (OpenData/MapServer/5) | City of Boston | sidewalks, private walks, crosswalks | **PDDL** | Yes | CONFIRMED — already in use; **vintage 2011** |
| **Boston Street Segments (SAM)** | City of Boston GIS | street centrelines, nightly updates | PDDL (portal default) | Yes | SUPPORTED |
| **Open Space** | City of Boston GIS | parks regardless of ownership | PDDL (portal default) | Yes | SUPPORTED |
| **MassGIS-MassDOT Roads** | MassGIS / MassDOT | centrelines, lanes, oneway, surface, ROW width, speed, AADT | public record; *"may be freely redistributed and integrated into commercial products… including any derivative works"*; credit requested | **Yes** | CONFIRMED — already the runtime road source for the NEU district |
| **MassGIS Lidar Terrain (QL1, 2021)** | MassGIS | **DEM, all of eastern MA, single consistent dataset** | as above | Yes | CONFIRMED |
| **MassGIS hydrography** | MassGIS / MassDEP | shoreline, water bodies | as above | Yes | SUPPORTED |
| **MBTA V3 API / GTFS** | MBTA | stations, entrances, platforms | MassDOT Developers License Agreement | attribution; **terms not read in full here** | SUPPORTED — UNCERTAIN on redistribution |
| **USGS 3DEP / EPQS** | USGS | spot elevations | US Government work, public domain | Yes | CONFIRMED |
| OpenStreetMap | OSM contributors | **cross-check, attribute hints, currency** | **ODbL 1.0** | see §F | CONFIRMED |
| Northeastern University ArcGIS | Northeastern | naming/audit reference ONLY | **no terms published** | **No** | CONFIRMED — resolved 2026-09-07 |

### E.2 The finding that most changes the picture

**Boston publishes an authoritative citywide 3D building model, under PDDL, updated June 2026.**
`Boston 3D Buildings (Existing)` — "the authoritative 3D scene layer representing the existing conditions of
the City of Boston", an I3S SceneServer on Analyze Boston — plus a tiled download (terrain + groundplan +
buildings, semiannual) at `bostonplans.org/3d-data-maps`. CONFIRMED.

That single fact reshapes §I (hero strategy) and much of §D: the massing layer OSM cannot supply is available
from the city, in public domain, already identified in this repo's own `docs/neu/HEIGHT_GATE.md` as the
recommended unblock and **explicitly recorded there as "not yet mined"**. Its stated limitation — *"intended
for visualization purposes only"* — is a fitness disclaimer, not a licence restriction, and is exactly the
right fitness for a game.

### E.3 Where OSM still earns its place

Three roles, all non-geometry:

1. **Currency check.** OSM is live; the City sidewalk layer is frozen at 2011. OSM can *tell you a layer is
   stale* without its geometry being copied.
2. **Attribute corroboration.** Already the practice: `src/data/neu-hero.js` records
   `storeyBasis: "OSM levels, corroborated by the factual height"` — an OSM integer used as a cross-check on a
   PDDL-sourced height, never as geometry.
3. **Hero candidacy signal.** 162 institutional + 191 historic + 112 tourism polygons are an excellent
   *ranking* input for which buildings deserve bespoke treatment. A ranking is not geometry.

---

## F. Licensing / provenance findings

### F.1 The six distinct things

1. **The OSM database** — ODbL 1.0.
2. **A Derivative Database** — any restructured/normalised database built from OSM contents. Share-alike
   attaches on public use (ODbL §4.4).
3. **A Produced Work** — *"a work (such as an image, audiovisual material, text, or sounds) resulting from
   using the whole or a Substantial part of the Contents"*. Share-alike does **not** attach to the Produced
   Work itself (§4.5); attribution does (§4.3).
4. **Independently written Boston runtime code** — unaffected.
5. **Independently licensed hero 3D assets** — unaffected by *being positioned* using data. See F.4.
6. **Other official GIS layers** — PDDL / public-record, no share-alike.

### F.2 The clause that decides it

The OSM Foundation's Produced Work guideline states, of a work published from OSM data:

> "if you publish a produced work, the underlying database has to be published as well (or alternations to the
> original database as is the case of derived databases), according to section 4.6 of ODbL."

**The trap is not that the game would become ODbL. It is §4.6.** A rendered frame of Boston is a Produced
Work. **A JSON or binary file of footprint rings is not** — it is structured data intended for extraction,
i.e. a Derivative Database. So shipping OSM-derived geometry in `dist/` and publishing the game would oblige
the project to publish that derived database under ODbL.

`src/data/boston-geo.js:26-28` already says exactly this:
*"it is ODbL and share-alike would attach to this file if its geometry were copied in. Facts corroborated from
OSM are fine; its geometry is not imported."* **That position is CONFIRMED correct by primary sources.**

Grade: the §4.5/§4.6 *mechanics* are **SUPPORTED** (consistent across the ODbL text and the OSMF guideline,
read twice). The precise boundary between "produced work" and "derivative database" for a *game world file*
is **UNCERTAIN** and is the one item that would need a lawyer if the Owner ever wanted to ship OSM geometry.
The recommendation here removes the need to ask.

### F.3 What Boston would need, under the recommended architecture

Because the geometry sources are PDDL and MassGIS, the obligations are light:

| source | attribution required? | where it would go |
|---|---|---|
| City of Boston (PDDL) | **No condition.** Credit anyway, as good practice. | in-game credits + `research/`/`docs/` manifest |
| MassGIS | **Requested, not required:** *"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"* | credits screen + `src/data/*.js` header (already done) |
| MBTA | per MassDOT Developers License Agreement | credits screen |
| USGS | none (public domain) | courtesy credit |
| OSM | ODbL §4.3 attribution — **only if OSM output is publicly used at all** | not required under the recommendation, because no OSM output ships |

**Committing normalised PDDL/MassGIS geometry to the repository has no share-alike implication.** CONFIRMED.
Generating runtime geometry from it changes nothing. This is already the shipped state for `src/data/neu-hero.js`.

### F.4 Does positioning a hero asset with GIS data infect the asset?

**No — SUPPORTED, not CONFIRMED.** A transform (x, z, rotation) taken from a source is a fact, not a
substantial part of a database; and under the recommended sources the question is moot, since PDDL carries no
share-alike at all. If the Owner ever positions an asset using OSM, the transform is *de minimis* — but
that is a legal judgement, not a technical one, and is flagged **UNCERTAIN**.

### F.5 Provenance manifest — concept

The project already ships a minimal version (`NEU_HERO_SOURCE = { dataset, publisher, licence, vintage,
service }`). The generalised form, one record per input layer:

```jsonc
{
  "schemaVersion": "1.0.0",
  "source":        "City of Boston — Buildings with Roof Breaks",
  "publisher":     "City of Boston (Boston Maps)",
  "sourceUrl":     "https://gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9",
  "licence":       "ODC-PDDL-1.0",
  "licenceUrl":    "https://opendatacommons.org/licenses/pddl/1-0/",
  "attribution":   "City of Boston",             // courtesy; PDDL imposes no condition
  "extractDate":   "2026-09-11",
  "vintage":       "2010 snapshot",              // the DATA's age, not the fetch date
  "bbox":          [42.328431, -71.102118, 42.382329, -71.029182],
  "rawChecksum":   "sha256:…",                   // over the gitignored cache
  "normalizerVersion": "tools/gis-import/build.mjs@1.0.0",
  "outputSchemaVersion": "boston-canonical/1",
  "transform": {
    "projection": "boston-local-frame",
    "impl": "src/core/Geo.js geo()",
    "originLat": 42.35538, "originLon": -71.06565,
    "mPerDegLat": 111320, "mPerDegLon": 82263.28,
    "knownDistortion": "max 6.47 m vs WGS84 geodesic over the play box; 3680 ppm anisotropy"
  },
  "derivedChecksum": "sha256:…",
  "redistributable": true,
  "notes": "Vintage predates ISEC (2017) and EXP (2024)."
}
```

Two fields matter more than the rest and are the ones a naive manifest omits: **`vintage` separate from
`extractDate`** (the NEU sidewalk layer is a 2011 dataset fetched in 2026), and **`transform`**, so a successor
can reproduce world coordinates without reading `Geo.js`.

---

## G. Architecture comparison

Scored 1–5, 5 best. Weighted by what this project actually is: a game with one WebGL context, a hand-tuned
HDR pipeline, Rapier physics and a hard 60 fps / <1200 draw / <3.5M camera-triangle budget.

| criterion | A. Procedural-first (today) | **B. Offline GIS → canonical → current runtime** | C. Runtime geospatial engine (MapLibre) | D. 3D Tiles / external tiled city |
|---|---|---|---|---|
| Factual placement accuracy | 2 — median 24.7 m | **5** | 5 | 5 |
| Compatibility with current gameplay systems | **5** | **5** | 1 | 2 |
| Runtime complexity | **5** | **5** | 1 | 2 |
| One-WebGL-context constraint | **5** | **5** | **1** | 2 |
| Traffic integration | **5** | 4 | 1 | 1 |
| Pedestrian integration | **5** | 4 | 1 | 1 |
| Physics / Rapier integration | **5** | 4 | 1 | 2 |
| Terrain integration | **5** | 4 | 2 | 2 |
| LOD ownership | **5** | **5** | 1 | 2 |
| Visual-quality control | **5** | **5** | 1 | 2 |
| Art-direction consistency | **5** | **5** | 1 | 1 |
| Deterministic builds | 4 | **5** | 2 | 3 |
| GitHub Pages compatibility | **5** | 4 | 3 | 2 |
| Bundle / network cost | **5** | 4 | 2 | 1 |
| Offline development | **5** | **5** | 2 | 2 |
| Licensing / attribution | 4 | **5** (PDDL path) | 2 | 3 |
| Migration risk | **5** | 3 | 1 | 1 |
| AI-maintainability | 4 | **5** | 2 | 2 |
| Successor-AI readability | 4 | **5** | 2 | 2 |
| **Total (of 95)** | **84** | **88** | **30** | **36** |

### G.1 Why C is disqualified, not merely low-scoring

MapLibre's `CustomLayerInterface` **does** share the WebGL context — the layer receives `gl` in `onAdd`. That is
not the problem. The problem is ownership:

- MapLibre **owns the camera and the projection**; the custom layer is handed a `modelViewProjectionMatrix`.
- *"The layer cannot make any assumptions about the current GL state."*
- MapLibre drives the frame.

Boston's `ARCHITECTURE.md` rule 2 is *"Only `src/gfx/RenderPipeline.js` may call `renderer.render()`"*, and the
project runs `postprocessing` + `n8ao` + custom cascaded shadows through a composer it owns. Under MapLibre,
the HDR stack, the cascades and the camera solve would all have to be rebuilt inside a callback with
unspecified GL state. **This is not a trade-off; it is a rewrite of the renderer to get data the offline path
delivers for free.** CONFIRMED from MapLibre's own documentation.

The brief warns against choosing MapLibre "merely because it already renders maps". The inverse warning also
holds and is the operative one here: **Boston is a game, and the map engine would have to stop being a map
engine to host it.**

### G.2 Why D is disqualified

3D Tiles solves streaming for a *viewer*. Boston's LOD, chunking (`CHUNK=170`, `SECTOR=600`), material
registry, wetness system, shadow-cascade budget and collision generation are all owned by Boston and mutually
tuned. An external tileset would arrive with its own geometry, its own materials and no colliders, and would
be an art-direction foreign body — the exact failure the brief names as "generic extruded grey boxes".

### G.3 Why B beats A by only 4 points, and why that is the right answer

A is genuinely good. It scores 84 because the current architecture is well-built and everything except factual
accuracy is already right. **B is A, plus better input, minus 2 points of migration risk.** That is the whole
proposition, and it is why the migration must be incremental and reversible: the delta is real but modest, and
a botched migration would destroy more value than the accuracy gain creates.

---

## H. Recommended architecture

```
  City of Boston (PDDL)   MassGIS / MassDOT   MBTA   USGS          OpenStreetMap (ODbL)
          │                       │             │      │                    │
          └───────────────┬───────┴─────────────┴──────┘                    │
                          ▼                                                 ▼
              tools/gis-import/fetch.mjs                          cross-check ONLY
              → .cache/  (GITIGNORED, never committed)            ┌──────────────────┐
                          │                                      │ currency check   │
                          ▼                                      │ attribute hints  │
              tools/gis-import/build.mjs   ◄─────────────────────│ hero candidacy   │
              normalise · validate · project through geo()       └──────────────────┘
                          │                                       (facts, not geometry)
                          ▼
              src/data/boston-canonical/*.js   GENERATED, provenance-stamped
                          │
        ┌─────────────────┼──────────────────┬─────────────────┐
        ▼                 ▼                  ▼                 ▼
   RoadNetwork        Terrain            Districts        hero registry
        │                 │                  │                 │
        ▼                 ▼                  ▼                 ▼
   buildPlots()  ──────────────────────────────────────►  keepout / isReserved
        │
        ▼
   Buildings · Facades · Props · Vegetation · Traffic · Pedestrians · Physics
        (UNCHANGED — they consume city.plots / city.roads, never geography)
```

**Three invariants that make this safe:**

1. **No runtime code ever sees a GIS tag.** Normalisation happens offline; the runtime sees Boston's own
   schema. (Already the rule: `tools/neu-audit/README.md` — *"Nothing here is imported by `src/`."*)
2. **Everything projects through the game's own `geo()`.** Never a private projection.
3. **Raw extracts are never committed.** Fetchers and normalisers are; caches are gitignored; only derived,
   licence-clean artefacts land in the tree. Already the shipped convention (`tools/*/.gitignore` → `.cache/`).

---

## I. Proposed Boston canonical geospatial schema

Sketches only. `[x, z]` world metres, already projected, 2 dp — matching `neu-hero.js` and `neu-walks.js`.
Every record carries `conf` (confidence tier, §L) and `src` (manifest id).

```jsonc
ROAD = {
  id, name,
  cls: 'highway'|'arterial'|'street'|'alley'|'service',   // Boston's vocabulary, NOT OSM's
  path: [[x,z], …],
  lanes, oneway: -1|0|1, surface: 'asphalt'|'cobble'|'brick',
  widthM: number|null,                    // right-of-way, where the source gives it
  bridge: bool, tunnel: bool,
  y: [number]|null,                       // per-vertex elevation override
  medianM: number|null,                   // reserved central strip (the Green Line case)
  conf, src
}

BUILDING = {
  id, name: string|null,
  outline: [[x,z], …],                    // CLOSED ring, CCW in XZ, no holes at this tier
  parts: [BUILDING_PART]|null,
  heightM: number|null, gndElevM: number|null,
  levels: int|null, roofShape: string|null,
  use: string|null,                        // normalised land-use code
  heroCandidateScore: number,              // §L
  conf, src
}

BUILDING_PART = { id, outline, heightM, minHeightM, roofShape, conf, src }

WATER  = { id, name, kind: 'river'|'basin'|'harbour'|'channel', levelM, depthM, ring: [[x,z],…], conf, src }
PARK   = { id, name, kind: 'lawn'|'formal'|'plaza'|'mall', ring: [[x,z],…], conf, src }
RAIL   = { id, name, mode: 'subway'|'light_rail'|'commuter'|'freight', path, surface: bool, gaugeM, conf, src }
STOP   = { id, name, mode, x, z, parentId: string|null, entrances: [[x,z],…], conf, src }
DISTRICT_HINT = { id, ring, landUse, density: 0..1, grainBearingRad: number|null, conf, src }
POI    = { id, name, cls: 'university'|'hospital'|'church'|'school'|'retail'|'tourism'|'historic',
           x, z, buildingId: string|null, significance: 0..1, conf, src }

HERO   = {                                  // the override registry (§L)
  id, name, sourceFeatureId, buildingId,
  transform: { x, z, y, rotY },
  asset: { path, licence, attribution } | null,   // null ⇒ bespoke procedural
  lod: { near, far, shellOnly: bool },
  collision: 'mesh'|'hull'|'box'|'none',
  fallback: 'procedural-massing',                 // MANDATORY — never a hole
  keepoutM, conf, src
}
```

`fallback` is mandatory and load-bearing: a hero asset that fails to load, or is culled from a build, must
degrade to procedural massing, never to a gap in the streetwall. This mirrors `AGENTS.md` rule 3
("a missing file degrades gracefully instead of failing boot").

---

## J. Roads / traffic integration

### J.1 Assumptions a prototype must not violate

Derived from `RoadNetwork`, `Roads`, `Traffic`, `Navigation` and `CONTRACTS.md`. **These are the high-risk
contracts:**

| # | contract | why it is fragile |
|---|---|---|
| R1 | **Edges are chords; roads are not.** Kerbside placement samples the *polyline*, not the chord. | `CONTRACTS.md:846` — already cost one fix |
| R2 | **`Terrain.stampRoads` is cut AND fill**, and runs *before* the ground mesh. | `CONTRACTS.md:1244`; denser centrelines change the raster everywhere |
| R3 | **The collision ground must never stand above a road.** | `CONTRACTS.md:1675` — a past outage |
| R4 | Visual terrain and collision terrain **differ under carriageways, by design**. | `CONTRACTS.md:1723` |
| R5 | `corridorHalf` is shared by `RoadNetwork` and `Buildings`; the two tolerances (`CORRIDOR_TOL`, `FRONTAGE_TOL`) must stay ordered, both **under `Buildings.CLIP_EPS` (0.02)**. | 0.05 once produced 43 buildings with vertices at 7.7e11 m |
| R6 | `buildPlots` skips `highway`, `alley` and `bridged` edges. | changing classification silently deletes or creates whole streetwalls |
| R7 | A road may reserve a **central median**; a local section may override part of one edge; a platform is a raised island. | `CONTRACTS.md:1771/1803/1852` |
| R8 | **Bridges have no ground.** | `CONTRACTS.md:891` |
| R9 | Parking bays, `parkingAllowedNear`, junction handling and spawn generation all derive from edge geometry. | 1 km of new centreline silently changes kerbside car placement |

### J.2 Verdict on roads

**Do NOT replace the road runtime. Feed it better input, and do it last.**

The opportunity is real — 124 authored polylines at 7.3 vertices/km against MassGIS-MassDOT centrelines
carrying lanes, oneway, surface, ROW width, speed and AADT, plus 8,736 OSM ways for corroboration. But roads
are the **single highest-risk migration target in the project**, because every one of R1–R9 was learned from a
failure, and because roads sit upstream of terrain, parcels, buildings, traffic, pedestrians, parking and
collision. A road change is a whole-world change.

Two further specifics from this repo's own measurements:

- MassGIS models divided roads as **two directional carriageways**, so a single centreline must be derived by
  averaging the pair, leaving a **~6–8 m half-median residual that is geometry, not error**
  (`docs/neu/SOURCES.md`). An importer that does not know this will report a false 7 m accuracy failure.
- The MBTA route shape for the Green Line E is **8 vertices across 320 m, shared by both directions**, and sits
  a systematic 5.9 m off this project's Huntington. Transit alignments are not survey data.

**Recommended ordering: roads come after buildings, parks, water and terrain — not before.** This inverts the
brief's illustrative stage list, deliberately, and §P explains why.

---

## K. Buildings / terrain / collision integration

### K.1 How much of real Boston fits the quad assumption — measured

Sampled 1,014 real OSM footprints across three 400 m boxes (Back Bay, North End, South End), counting
**distinct** corners (closing node removed):

| distinct corners | share | cumulative |
|---|---|---|
| **exactly 4 (a quad)** | **43.9%** | 43.9% |
| ≤ 6 | — | **71.8%** |
| ≤ 8 | — | **83.6%** |
| > 12 | **5.3%** | — |

Mean 6.24 corners; median 5–7 depending on neighbourhood. CONFIRMED.

**So the vertex count is not the blocker — 44% of Boston's footprints are already quads.** The blocker is that
`plot.polygon` is *not a footprint at all*: it is a road-relative quad carrying `frontage`, `edgeId`, `side`,
`width` and `depth`, all of which `Facades.makeSpec`, `frontageDir`, the super-block merger
(`Buildings.js:1048-1131`) and the ground-floor treatment consume. A real footprint has none of them.

### K.2 What breaks, and the fix shape

| assumption | breaks on | fix (architecture only) |
|---|---|---|
| `polygon.length === 4` | 56% of footprints | derive an **oriented bounding quad** for the facade pipeline; keep the true ring for collision and the shell |
| `frontage: {a,b}` | any footprint | pick the ring edge most nearly parallel to, and nearest, the owning road edge |
| `edgeId` / `side` | any footprint | `roads.nearestEdge(centroid)`; reject if > `cfg.depth` away |
| `depth` | any footprint | project the ring onto the frontage normal |
| courtyards / holes | ~few % | **tier them to hero or shell-only**; do not attempt at massing tier |
| multi-street corner buildings | common downtown | `frontDirs` already exists for this (`Buildings.js:955-962`) — reuse it |
| footprint straddling a corridor | any source | `hitsCorridor` / `spanInCorridor` already solve it — **reuse, do not reimplement** (§J R5) |

The honest read: **a footprint tier is a new, parallel path beside `buildPlots`, not a substitution into it.**
That is exactly what `NeuHero.js` already is. Generalising means promoting that path from one district to a
tier, with `Districts.isReserved` → `inHeroFootprint` as the existing, working hand-off.

### K.3 Real footprints do not automatically look better

**This must not be assumed.** The brief says so and the evidence agrees. A true footprint extruded to a true
height with a generic facade grammar can easily read *worse* than a well-tuned procedural streetwall, because:

- Boston's facade quality lives in `Facades.js` (2,431 lines) and `BuildingKit.js` (1,705), not in the outline.
- The current parcel rhythm is *designed* to produce a continuous streetwall; real footprints have gaps, kinks
  and setbacks that the facade grammar has never had to handle.
- `Buildings.js` documents that a count cap silently became a radius cap and left the west edge of the city
  bare. Any new tier can reproduce that class of failure.

Accuracy and beauty are **separate axes**. §O gates them separately.

### K.4 Terrain

`Terrain` bakes a **10 m raster, 681×681**, from 9 analytic drumlins + water + value noise, `BASE_LAND` 3.9 m.
A real DEM slots in *structurally perfectly* — MassGIS QL1 lidar (2021, all of eastern MA, single consistent
dataset) downsampled to the existing 10 m grid, replacing `HILLS` + noise and keeping `stampRoads` untouched.

**And it is still the second-highest-risk change in the project**, because `groundHeight()` is the one function
every system agrees through. Moving it moves buildings, kerbs, colliders, spawn points, parked cars, props,
vegetation and the player. Two datum problems must be resolved first, both currently **UNKNOWN**:

- the game's sea-level-zero convention vs NAVD88 (`docs/neu/SOURCES.md` records the vertical datum as
  **"not reconciled"**, with a ~+1.5 m offset observed at Northeastern);
- the interaction with `WATER[].level` — the Charles basin is held ~2 m above sea level by the dam.

### K.5 Collision

`Landmark collision: the drawn triangles are the collider` (`CONTRACTS.md:327`) and building collision is
already a solved, documented, twice-corrected contract (`CONTRACTS.md:255`). A footprint tier must produce
colliders through the same path. **Do not introduce a second collision convention.**

---

## L. Hero-model strategy

### L.1 It already exists — twice

- **Point tier:** `src/data/landmarks.js` (10 entries: id, lat, lon, h, rot, **keepout**) dispatched through
  `BUILDERS` in `Landmarks.js:1029/1103`. Bespoke *procedural* builders, no imported assets.
- **Footprint tier:** `src/data/neu-hero.js` (21 parts) → `NeuHero.js`, with `Districts.inHeroFootprint`
  suppressing generic infill.

**No GLB pipeline exists, and none is needed yet.** Both hero tiers today are bespoke procedural code, which
keeps art direction, materials, wetness, LOD and collision inside the systems that already own them. That is a
feature, not a gap.

### L.2 Selection rule — evidence-based, not a percentage

Reject any fixed 95/5 split. Score each candidate; promote above a threshold the Owner sets after seeing the
distribution:

```
score =  0.30 · routeProximity      // distance to canonical routes / the opening; from viewpoints.json + routes.json
       + 0.25 · screenOccupancy     // measured solid angle from the world sweep, NOT footprint area
       + 0.20 · silhouetteUniqueness// how badly generic massing misrepresents it (Zakim, Citgo, Hancock rhomboid)
       + 0.15 · recognition         // OSM historic/tourism/wikidata + city landmark lists
       + 0.10 · proceduralDeficit   // measured gap between current render and the factual massing
       − cost                       // bespoke-builder effort
```

Two disciplines carried over from the closed Northeastern programme, both learned the hard way:

- **Do not rank by area alone.** A human at 1% of frame can outrank an inert object at several percent.
- **Do not implement merely because it is iconic in reality.** If it is sub-pixel or occluded from every
  reachable viewpoint, it does not earn geometry. (Wave D4's rule; it stands.)

### L.3 Asset policy

If external assets are ever introduced (not now):

- **licence must be independent and recorded per asset** in the HERO record;
- **`fallback: 'procedural-massing'` is mandatory** — never a hole;
- collision and LOD policy declared per hero, produced through the existing paths;
- and the **City's own PDDL 3D model (§E.2) should be evaluated first**, because it is authoritative, public
  domain, citywide and already updated to June 2026. **Buying or downloading third-party landmark models
  should be the last resort, not the first.**

---

## M. Performance / storage model

Measured on 1,014 real Boston footprints, serialised in the existing `neu-hero.js` convention
(`[x, z]` world metres, 2 dp), then projected to the 25,010 building ways inside the play box. CONFIRMED.

| encoding | per building | **citywide (25,010)** |
|---|---|---|
| JSON, uncompressed | 130 B | **3.10 MiB** |
| JSON + gzip −9 | 38.7 B | **0.92 MiB** |
| JSON + brotli | 31.0 B | **0.74 MiB** |
| Float32 binary, raw | 58 B | **1.38 MiB** |

Estimated ~181,000 ring vertices citywide. Compression ratio 3.4× (gzip) / 4.2× (brotli).

**Conclusion: footprints are not a storage problem.** Under 1 MiB over the wire for every building in the
play area, served statically, cached immutably. For comparison, the whole current factual layer is 97 KiB and
the Geofabrik Massachusetts PBF is **295 MB** — four orders of magnitude apart, which is precisely why the raw
extract must never enter Git.

### M.1 Runtime cost — modelled, not measured

No benchmark was run (correctly: no WebGL in this task). Static reasoning:

- **Parse:** ~181k vertices of JSON is a few tens of ms on the target machine. A Float32 `ArrayBuffer` with a
  small JSON side-table would remove even that. Either is acceptable against the current `[city]` init budget.
- **Triangulation:** `Districts._mesh` already triangulates rings via `THREE.ShapeUtils.triangulateShape` with
  the documented 2D→XZ handedness reversal. 25,010 mostly-convex rings averaging 6.24 corners is a modest,
  one-off, build-time-cacheable cost. **PLAUSIBLE**, not measured.
- **Triangle budget:** the binding constraint is **<3.5M camera triangles**, and `ARCHITECTURE.md` records
  `Props.js` as the largest single shadow contributor. A footprint tier must be **shell-first**: outer-ring
  extrusion at ~80 tris/building in the always-resident shell (the existing pattern), detail only inside the
  LOD radius. Anything else risks the budget. **This is a gate, not a hope** (§O).
- **Draw calls:** must stay inside the existing chunk/sector merge. **No new material buckets** without
  measurement — this project has repeatedly confused a missing material-bucket *name* with missing geometry.

### M.2 Where raw data should live — **recommendation: D, hybrid (already in force)**

| option | verdict |
|---|---|
| A. raw OSM/GIS in Git | **NO.** 295 MB PBF; and for OSM it would be redistributing an ODbL database. |
| B. download during build | **NO** as the only path — breaks offline development and CI determinism, and Overpass's fair-use policy explicitly says production apps should not run against the public instance. |
| C. external archive + checksum | Good for the *raw* tier. |
| **D. hybrid — fetchers in Git, cache gitignored, derived artefacts committed with provenance** | **YES.** Already the shipped convention. |

Acquisition paths:

| path | use | limits | CI-suitable? |
|---|---|---|---|
| **Overpass API** | bounded prototypes, counts, cross-checks | ~10k req/day, ~1 GB/day, 180 s default timeout, 512 MiB/query, HTTP 429 on slot exhaustion; **requires a `User-Agent`** (406 without) | **No** — rate-limited, not for builds |
| **Geofabrik Massachusetts PBF** | any citywide OSM work | 295 MB, daily, ODbL | Yes, but archived externally |
| **ArcGIS REST `/query`** (Boston, MassGIS) | **the recommended path** — the one already in use | paginated; stable; no key needed for the layers used | Yes, cached |
| Analyze Boston bulk / bostonplans tiles | the 3D model and downloadable tiles | semiannual | Yes |

**Prototype path:** ArcGIS REST against the City of Boston layers, cached under a gitignored `.cache/`, exactly
as `tools/neu-walks/fetch.mjs` already does. **Production/update path:** the same, plus a checksum-pinned
archived snapshot and a `--force` refresh, so a build is reproducible years later without depending on a live
service.

---

## N. Prototype specification

### N.1 Location — three candidates compared

All measured over 400 m squares on 2026-09-11. CONFIRMED.

| | **Back Bay** (42.3495, −71.0800) | **North End** (42.3645, −71.0545) | **South End** (42.3410, −71.0730) |
|---|---|---|---|
| buildings | 154 | **587** | 273 |
| mean / median corners | 7.5 / 5 | 7.8 / 7 | 6.0 / 5 |
| p95 / max corners | 21 / 44 | 14 / 32 | 10 / 26 |
| `height` | 6 (3.9%) | **59 (10.1%)** | **0 (0%)** |
| `building:levels` | 34 (22%) | 129 (22%) | 12 (4.4%) |
| `roof:shape` | 6 | 39 | 0 |
| `addr:housenumber` | 140 (91%) | 521 (89%) | 251 (92%) |
| street grid | **regular, surveyed** | medieval tangle | regular |
| how Boston authors it today | **exact rotated frame** (`bb()`, `BB_BEARING` 251.5°) | hand-traced | hand-traced |

**Choice: Back Bay.** Not because it is easiest, but because it is the only one of the three that is a
**controlled experiment.**

Back Bay is generated from an exact surveyed frame fitted to real corners — so any mismatch between imported
footprints and the existing world is attributable to the *import*, not to authoring scatter. In the North End
or South End, hand-tracing error (median 24.7 m citywide) would swamp the signal and the prototype could not
tell a projection bug from a bad trace.

The honest cost of that choice, recorded so nobody is surprised: **Back Bay is Boston's least representative
neighbourhood** — it is the one planned grid in an irregular city, its footprints are the simplest (median 5
corners), and a pass there does *not* establish that the North End will work. The North End is the correct
**second** prototype and the real difficulty test; the study recommends running it only if Back Bay passes.

Back Bay also satisfies the brief's content checklist: regular grid ✓, real footprints ✓, varied sizes
(4-corner rowhouses to 44-corner institutional) ✓, sidewalks ✓, kerbside parking ✓, vegetation (Comm Ave Mall)
✓, irregular parcels at the Dartmouth/Boylston corner ✓, and dense existing procedural content to compare ✓.
And it is **not Northeastern**, which stays frozen.

**Extent:** 400 m square centred (42.3495, −71.0800) — bbox `42.347703,-71.082431,42.351297,-71.077569`,
world-space roughly x ∈ [−1450, −1050], z ∈ [−600, −200]. 154 buildings is a big enough sample to be
statistically meaningful and small enough to read every failure by eye.

### N.2 Pipeline

```
tools/osm-prototype/                     ← name kept per the brief; sources are City of Boston + MassGIS
  README.md            what this is, how to delete it
  config.mjs           bbox, layer URLs, licence ids
  fetch.mjs            ArcGIS REST → .cache/   (GITIGNORED)
  manifest.mjs         emits the §F.5 provenance record
  normalize.mjs        project through src/core/Geo.js geo(); emit canonical records
  validate.mjs         the §O structural gates; exits non-zero on failure
  build.mjs            → fixtures/backbay.canonical.json  (committed, ~20 KiB)
  fixtures/            the ONLY committed data
```

- **INPUT** — City of Boston Buildings with Roof Breaks (footprints + `GRND_ELEV`/`ROOF_ELEV`) and Open Space,
  bounded to the bbox. MassGIS-MassDOT Roads for the same box, read-only, for comparison against the existing
  `STREETS`. OSM used **only** to cross-check counts and currency — no geometry retained.
- **NORMALIZED OUTPUT** — `BUILDING[]` + `ROAD[]` per §I, `[x,z]` world metres via `geo()`, plus the manifest.
  ~154 buildings ≈ 20 KiB JSON / ~6 KiB gzipped.
- **VALIDATION** — §O structural gates, run in `validate.mjs`, deterministic, no browser.
- **RUNTIME CONSUMER** — a single **opt-in, default-off** system `src/world/GisProbe.js` behind
  `?gisProbe=1`, that draws the imported outlines as flat ribbons at `groundHeight()+0.05` beside the existing
  city. **It generates no buildings, no colliders, no parcels and touches no existing system.** Its only job
  is to answer: *do the factual footprints land where Boston thinks that block is?*
- **REMOVAL PATH** — `rm -rf tools/osm-prototype src/world/GisProbe.js`. One system file, auto-loaded by
  `import.meta.glob`, whose absence degrades gracefully by `AGENTS.md` rule 3. **No existing file is modified**,
  so removal is a pure deletion with no revert.

### N.3 What the prototype deliberately does NOT do

No buildings generated. No parcels replaced. No terrain change. No road change. No collision. No new
dependency. No `package.json` change. No Northeastern. **It measures agreement and nothing else** — because
the one question that decides the whole programme is whether factual geometry and the existing world can
coexist in the same frame.

---

## O. Prototype acceptance gates

| # | gate | PASS | PARTIAL | FAIL |
|---|---|---|---|---|
| **GEO-1** | Footprint vs existing streetwall offset, median over the block | ≤ 8 m | 8–20 m | > 20 m |
| **GEO-2** | Footprint long-axis vs owning road bearing | ≤ 5° median | 5–12° | > 12° |
| **GEO-3** | Block topology — every footprint inside the block its address implies | 100% | ≥ 95% | < 95% |
| **GEO-4** | Comm Ave Mall alignment vs the existing `PARKS` ring | ≤ 10 m | 10–25 m | > 25 m |
| **STR-1** | Byte-identical output across two runs from the same cache | required | — | any diff |
| **STR-2** | Zero self-intersecting or zero-area rings; zero NaN/Inf | required | — | any |
| **STR-3** | Consistent winding (CCW in XZ after the documented flip) | 100% | — | any |
| **STR-4** | Unique ids; no duplicate source features | 100% | — | any |
| **STR-5** | Round-trip `geo()`→`unGeo()`→`geo()` residual | < 0.01 m | — | ≥ 0.01 m |
| **GAME-1** | `city.roads` contract unchanged | byte-identical `net.stats()` | — | any change |
| **GAME-2** | Traffic / pedestrian navigation unchanged | identical spawn + edge counts | — | any change |
| **GAME-3** | Collision contract untouched | zero new colliders | — | any |
| **GAME-4** | `groundHeight()` unchanged | byte-identical raster checksum | — | any change |
| **VIS-1** | Ordinary Boston still looks like Boston | no visible change with the probe off | — | any |
| **VIS-2** | Probe ribbons read as plausible building lines from street level | Owner judgement | — | — |
| **PERF-1** | Generated fixture size | ≤ 64 KiB for the block | ≤ 128 KiB | > 128 KiB |
| **PERF-2** | Runtime triangle growth with probe ON | ≤ 5k tris | ≤ 20k | > 20k |
| **PERF-3** | New draw calls with probe ON | ≤ 2 | ≤ 5 | > 5 |
| **PERF-4** | New WebGL contexts | **0** | — | ≥ 1 |
| **PERF-5** | New material/program count | 0–1 | 2 | ≥ 3 |
| **LEG-1** | Every committed byte traceable to a manifest record | 100% | — | any |
| **LEG-2** | Zero ODbL-derived geometry committed | required | — | any |
| **LEG-3** | Attribution present for every source used | required | — | any |

**Overall:** PASS = all gates PASS. PARTIAL = no FAIL and ≤ 3 PARTIAL. **FAIL = any single FAIL**, and any
FAIL in GAME-*, PERF-4 or LEG-* is a **hard stop**, not a retry.

The interesting gate is **GEO-1**. The existing world is a median 24.7 m from reality. If imported footprints
land within 8 m of the existing streetwall, the two frames are compatible and everything downstream is
tractable. If they land 30 m away, the honest conclusion is that **factual footprints and the hand-authored
street grid cannot coexist**, and the programme stops — because reconciling them would mean moving the roads,
which means moving everything.

---

## P. Migration / rollback plan

Derived from the dependency order in §B.3, **not** from the brief's illustrative list. The single governing
principle: **migrate leaves before roots.** Roads and terrain are roots; everything else hangs off them.

| stage | scope | prerequisite | rollback | gate | untouched |
|---|---|---|---|---|---|
| **0. Source freeze** | archive + checksum the City/MassGIS extracts; write the manifests | this study | delete `research/` | manifests complete | everything |
| **1. Back Bay probe** | §N, read-only overlay | 0 | `rm -rf` two paths | §O all | everything |
| **2. North End probe** | same harness, hardest geometry | 1 PASS | `rm -rf` | §O all | everything |
| **3. Coordinate adapter** | formalise the Boston Local Frame; publish constants; **no numeric change** | 2 | revert one doc + one export | round-trip < 0.01 m | all coordinates |
| **4. Building footprints, shell tier only** | outer-ring extrusion into the always-resident shell for one district; `isReserved` suppresses the parcel underneath | 3 | feature flag off | §O + triangle/draw budget | roads, terrain, collision, traffic, peds |
| **5. Footprint tier gains facades + collision** | promote the tier through `Facades`/`BuildingKit`/existing collider path, one district | 4 accepted **by the Owner visually** | flag off | full critic rubric | roads, terrain |
| **6. Parks / water / rail** | replace `PARKS`/`WATER` rings from City Open Space + MassGIS hydrography | 5 | data-file revert | GEO gates + park-pipeline regression | roads, terrain, buildings |
| **7. Hero override registry** | generalise `landmarks.js` + `neu-hero.js` into one registry with `fallback` | 5 | registry empty ⇒ current behaviour | per-hero critic pass | everything else |
| **8. Terrain DEM** | MassGIS QL1 → the existing 10 m raster | **vertical datum reconciled**; 4–7 accepted | raster revert | GAME-4 + full world sweep + physics regression | — |
| **9. Roads** | MassGIS-MassDOT centrelines into `STREETS` | 8 accepted; every R1–R9 contract re-verified | data-file revert | full world sweep + traversal sweep + `st_*` critic set | — |
| **10. District-by-district** | only where 4–9 demonstrably improved the render | Owner decision per district | per-district flag | critic rubric | — |

**Rollback is always available** because every stage is either a generated data file (revert the file,
regenerate) or a flagged system (turn it off). No stage rewrites an existing system in place. **Northeastern
stays frozen through every stage**; it is already on this architecture and does not need migrating.

Stages 8 and 9 are deliberately last and deliberately hardest. They are also the stages most likely never to
be reached, and that is an acceptable outcome: stages 4–7 capture most of the factual-accuracy benefit for a
fraction of the risk.

---

## Q. Risk register

| # | risk | L | I | mitigation | tripwire |
|---|---|---|---|---|---|
| Q1 | Footprints land far from the hand-authored streetwall; the two frames are irreconcilable | **M** | **H** | GEO-1 at stage 1, before anything else | GEO-1 FAIL ⇒ stop the programme |
| Q2 | Real footprints look *worse* than the tuned procedural streetwall | **M** | **H** | §K.3; VIS gates separate accuracy from beauty; Owner visual acceptance gates stage 5 | critic rubric regression |
| Q3 | Triangle/draw budget breach from a footprint tier | M | H | shell-first (~80 tris/bldg); PERF-2/3/5; no new material buckets | >3.5M camera tris |
| Q4 | Terrain datum error silently shifts the whole world | **M** | **VH** | stage 8 blocked until NAVD88↔sea-level-zero is reconciled and `WATER[].level` reconciled | GAME-4 checksum change |
| Q5 | Road migration breaks one of R1–R9 | **H** | **VH** | stage 9 last; every contract re-verified individually | any `CONTRACTS.md` road invariant |
| Q6 | ODbL geometry leaks into `src/` or `dist/` | L | **VH** | LEG-2 gate in `validate.mjs`; cache gitignored; convention already enforced | any OSM coordinate in `src/` |
| Q7 | Raw extract committed; repo bloats | L | M | `.cache/` gitignored (already); LEG-1 | repo size jump |
| Q8 | Source vintage mistaken for currency (2010 buildings, 2011 sidewalks) | **H** | M | `vintage` separate from `extractDate` in the manifest; OSM currency cross-check | a "missing" building that was built after the snapshot |
| Q9 | Scope creep from probe to rewrite | **M** | **H** | one stage per Owner authorisation; probe generates nothing | any stage starting without its gate |
| Q10 | `geo()` "fixed" mid-programme, moving every existing feature | L | **VH** | §C.4 — keep it; two-scalar fix is whole-world-only, never partial | any change to `src/core/Geo.js` constants |
| Q11 | MBTA licence permits use but not redistribution | M | L | read the MassDOT Developers License Agreement before shipping MBTA-derived geometry | — |
| Q12 | Successor AI cannot rebuild the pipeline | M | H | §R | — |

---

## R. Successor-AI handoff requirements

The project already does most of this, which is why the pattern is worth generalising rather than inventing.

**Required, and already true of the Northeastern pipeline:**

1. **Deterministic commands** in the file header — `neu-hero.js` line 4 literally carries
   `node tools/neu-hero/build.mjs`.
2. **`GENERATED, do not hand-edit`** on every generated file (already the convention).
3. **Provenance in the artefact**, not only in docs (`NEU_HERO_SOURCE`).
4. **Coordinate contract documented** — and now measured (§C), which it was not before.
5. **Raw cache gitignored**, fetchers committed.
6. **Explicit generated-vs-authored distinction** (`boston-geo.js` = authored; `neu-hero.js` = generated).

**Required, and currently missing:**

7. **Versioned schema** — `outputSchemaVersion` in every artefact, so a successor can tell a v1 fixture from a v2.
8. **Fixture tests** — a tiny committed input and expected output, so `build.mjs` can be proven unchanged
   without network access. The Northeastern pipeline has none; a successor cannot currently verify a
   regeneration is correct.
9. **A small example dataset** — the Back Bay fixture (§N) serves this.
10. **The manifest schema itself versioned** (§F.5).

**Nothing Claude-specific is proposed.** Node + `fetch` + the existing `geo()`. No Claude-only tooling, no
knowledge stored only in chat, no dependency on this conversation.

**What would make successor takeover harder, and is therefore rejected:** a runtime OSM/tag parser (a successor
would need to learn OSM tagging to change a building); MapLibre (a successor would need to learn a map engine's
frame ownership to change a shader); a binary fixture format without a JSON debug path; and any pipeline whose
correctness can only be checked by booting the game.

---

## S. Evidence / source table

| # | claim | source | grade |
|---|---|---|---|
| S1 | Hand-authored geography sits median 24.7 m from reality (8 clean anchors: min 3, p90 51.4, max 95.4); systematic bias only 15.4 m | `docs/neu/ANCHORS.json` | CONFIRMED |
| S2 | `geo()` max radial error 6.47 m vs WGS84 geodesic; 2159/−1516 ppm anisotropy; 3680 ppm shape distortion | measured, Vincenty over a 250 m grid | CONFIRMED |
| S3 | Two-scalar ENU calibration (1.0015182 / 0.9978458) reduces max error to 0.45 m | measured | CONFIRMED |
| S4 | EPSG:26986 residual 0.137 m, zero angular distortion, but **0.29° grid convergence** at Boston | computed from the LCC 2SP definition | CONFIRMED |
| S5 | Web Mercator raw: k=1.353, 2230 ppm variation across the play box | computed | CONFIRMED |
| S6 | Boston factual layer = 124 streets / 730 vertices / 100.4 km / 7.3 vertices per km; 98,932 bytes total | measured from `src/data/` | CONFIRMED |
| S7 | OSM play-area: 25,010 buildings; height 3.0%, levels 15.4%, roof:shape 3.7%, min_height 0.04% | Overpass `make count`, 2026-09-11 | CONFIRMED |
| S8 | OSM play-area roads: 8,736 drivable; lanes 57.7%, width 51.2%, oneway 50.1%, surface 68.2% | Overpass, 2026-09-11 | CONFIRMED |
| S9 | OSM play-area realm: 20,017 footways, 6,541 crossings — OSM's strongest Boston category | Overpass, 2026-09-11 | CONFIRMED |
| S10 | 43.9% of Boston footprints are exactly 4 corners; 71.8% ≤6; 83.6% ≤8; mean 6.24 | 1,014 sampled footprints | CONFIRMED |
| S11 | Citywide footprints: 3.10 MiB JSON / 0.92 MiB gzip / 0.74 MiB brotli / 1.38 MiB Float32 | measured + projected to 25,010 | CONFIRMED |
| S12 | ODbL: share-alike binds Derivative Databases (§4.4), not Produced Works (§4.5); §4.6 compels making the Derivative Database available | opendatacommons.org ODbL 1.0 | SUPPORTED |
| S13 | *"if you publish a produced work, the underlying database has to be published as well… according to section 4.6 of ODbL"* | OSM Foundation, Produced Work guideline | CONFIRMED (quote) |
| S14 | OSM requires attribution and *"If you alter or build upon our data, you may distribute the result only under the same license"* | openstreetmap.org/copyright | CONFIRMED |
| S15 | data.boston.gov default licence is ODC-PDDL; adopted 2016 to remove barriers, attribution dropped deliberately | boston.gov news; portal `license_id=odc-pddl` | CONFIRMED |
| S16 | MassGIS data *"may be freely redistributed and integrated into commercial products and applications, including any derivative works"*; credit "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS" | mass.gov MassGIS | CONFIRMED |
| S17 | Boston 3D Buildings (Existing): PDDL, Boston Maps, authoritative existing-conditions 3D scene layer, updated June 2026, "visualization purposes only" | data.boston.gov dataset page | CONFIRMED |
| S18 | bostonplans.org publishes a tiled citywide 3D model: terrain + groundplan + buildings, open formats + SketchUp | bostonplans.org 3D Data Download | CONFIRMED (formats), UNKNOWN (its own terms page) |
| S19 | MassGIS QL1 lidar covers eastern MA from the 2021 acquisition as a single consistent dataset; DEMs as GeoTIFF/IMG | mass.gov MassGIS Lidar Terrain Data | CONFIRMED |
| S20 | Geofabrik Massachusetts: 295 MB PBF, daily, ODbL 1.0 | download.geofabrik.de | CONFIRMED |
| S21 | Overpass fair use: ~10k requests/day, ~1 GB/day, 180 s default timeout, 512 MiB/query, 429 on slot exhaustion; bulk extracts for large work | Overpass API documentation | CONFIRMED |
| S22 | MapLibre custom layers share the GL context but **MapLibre owns the camera/projection**; *"The layer cannot make any assumptions about the current GL state"* | maplibre.org CustomLayerInterface | CONFIRMED |
| S23 | Simple 3D Buildings defines building:part, height, min_height, building:levels, roof:* ; **height takes precedence over levels** | OSM wiki Simple 3D buildings | CONFIRMED |
| S24 | MBTA data governed by the MassDOT Developers License Agreement; V3 API key limit 1,000 req/min | mbta.com developers | SUPPORTED — agreement not read in full |
| S25 | Boston's own footprint source validated sub-metre (Prudential 228 m vs 228; 111 Clarendon 240.2 vs 241) | `src/data/neu-hero.js` header | CONFIRMED (in-repo) |
| S26 | Northeastern ArcGIS publishes **no terms**; absence of restriction is not a grant; audit-reference only | `docs/neu/SOURCES.md`, resolved 2026-09-07 | CONFIRMED |
| S27 | City Sidewalk Centerline vintage is 2011 — predates ISEC (2017) and EXP (2024) | `docs/neu/SOURCES.md` | CONFIRMED |
| S28 | MassGIS models divided roads as two carriageways, leaving a ~6–8 m half-median residual that is geometry, not error | `docs/neu/SOURCES.md` | CONFIRMED |
| S29 | `Geo.js` docstring "<1m over the 6km play area" is an over-claim by ~6.5× | S2 vs `src/core/Geo.js:2` | CONFIRMED |
| S30 | `docs/neu/ANCHORS.json` "the projection… is exact by construction" is true of frame self-consistency, not of WGS84 agreement | S2 vs the file | CONFIRMED |

**Deliberately not used:** Google Maps, Street View, any aerial or street-level imagery. No imagery was
consulted, traced or stored. No proprietary geometry was copied.

---

## T. Verdict

# CONDITIONAL GO

**GO** on the architecture: offline factual GIS → Boston-canonical dataset → the existing Three.js runtime,
with a hero override layer. It is the right shape, it is already proven in this repository at district scale,
and the storage, licensing and performance evidence all support generalising it.

**NO-GO** on OpenStreetMap as the geometry source. ODbL share-alike attaches to derived databases, licence-
cleaner authoritative sources exist for every category Boston needs, and the project's existing position is
correct. OSM stays what it already is: **a cross-check, an attribute hint and a currency signal.**

**The conditions, all four of which must hold:**

1. **`src/core/Geo.js` is not changed.** The projection contributes 6.47 m against an authoring error of
   24.7 m. Fixing it first would move the frozen Northeastern district for no visible gain.
2. **The Back Bay probe passes GEO-1** (median footprint-to-streetwall offset ≤ 8 m). If factual footprints
   cannot coexist with the hand-authored grid, the programme stops there — that is the falsification test.
3. **Roads and terrain migrate last, or never.** Stages 8–9 are the roots of every contract this project has
   repaired. Stages 4–7 deliver most of the benefit at a fraction of the risk.
4. **No ODbL-derived geometry ever reaches `src/` or `dist/`,** enforced by a gate in `validate.mjs`, not by
   discipline alone.

### What would STOP the migration after the prototype

GEO-1 FAIL · any GAME-* gate change · PERF-4 (a second WebGL context) · any LEG-* failure · triangle budget
breach that shell-first cannot fix · or the Owner judging at stage 5 that real footprints look worse than the
procedural streetwall. **Q2 is the one that most deserves respect: factual accuracy and visual quality are
different axes, and this study does not claim the first buys the second.**

### What would justify going citywide

Back Bay **and** North End both PASS · stage 4 lands inside the triangle and draw budget · and stage 5 earns
Owner visual acceptance against the existing critic rubric — that is, the factual city is judged *better
looking*, not merely *more correct*.

---

*Research only. No runtime change, no dataset added, no dependency added, no implementation authorised.*
