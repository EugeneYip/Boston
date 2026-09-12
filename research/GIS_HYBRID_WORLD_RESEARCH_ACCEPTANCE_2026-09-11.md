# GIS hybrid world — research acceptance and corrections

**Date** 2026-09-11 · **Corrects** `a5dcefe` (`research/OSM_HYBRID_WORLD_FEASIBILITY_2026-09-11.md`)
**Status** RESEARCH. Direction accepted; **implementation NOT authorised.** Stage 1A not started.

This note is **canonical where it disagrees with the feasibility study.** The study is kept intact and
annotated rather than rewritten; where a section is corrected here, the study carries a pointer to this file.

Grades: **CONFIRMED** (measured here or quoted from a primary source) · **SUPPORTED** · **PLAUSIBLE** ·
**UNKNOWN** · **WITHDRAWN**.

---

## 0. Summary of what changed

| # | claim in `a5dcefe` | corrected status |
|---|---|---|
| 1 | "official GIS should replace, not complement, OSM" | **WITHDRAWN as a global rule.** Replaced by a per-feature-class precedence matrix (§1). OSM is PRIMARY for **seven of fourteen** classes. |
| 2 | Boston 3D model is "the strongest unexploited lead… not yet mined" | **WITHDRAWN.** It *was* mined (4,616 buildings) and **superseded** for named-building heights; it runs systematically high (§2). |
| 3 | "Boston open data is PDDL" | **NARROWED** to per-dataset evidence. Three datasets individually confirmed; publisher identity is never sufficient (§3). |
| 4 | "no ODbL geometry in `src/`/`dist/`" presented as a licence gate | **RECLASSIFIED** as project risk-minimisation policy, not a licence requirement (§4). |
| 5 | MapLibre "cannot coexist with `RenderPipeline`" | **WITHDRAWN.** MapLibre officially documents three.js custom layers. The conclusion is about *world ownership*, not possibility (§5). |
| 6 | "hand-authored geography sits a median 24.7 m from reality" | **NARROWED.** That is a **landmark-point** statistic, n=8. Street geometry is measured separately and the spread is far wider — and far more decisive (§6). |
| 7 | GEO-1: ≤8 m PASS / >20 m FAIL | **WITHDRAWN as arbitrary.** Replaced by a four-metric baseline with in-project precedent bands (§7). |
| 8 | Stage 1 described as both "read-only probe" and "one default-off system" | **SPLIT** into Stage 1A (data only) and Stage 1B (runtime, not authorised) (§8). |
| 9 | "OSM hybrid world" framing | **RENAMED in conclusion** to an authoritative-GIS-informed multi-source pipeline (§9). |
| 10 | "the architecture already exists for Northeastern" | **RETAINED, but split** into reusable pattern vs NEU-specific implementation (§10). |

**The CONDITIONAL GO survives.** One correction strengthens it (§6); none weakens it.

---

## 1. Correction 1 — feature-class source precedence matrix

The global rule "official GIS replaces OSM" is withdrawn. It contradicted this study's own measurement that
OSM's footway and crossing coverage is its strongest Boston category, against a City sidewalk layer whose
data has not been updated since 2011.

**Completeness caveat that governs the whole matrix:** OSM completeness was **measured** here (Overpass
counts over the play-area bbox, 2026-09-11). **No official Boston or MassGIS layer's completeness was
measured citywide in this study.** Every official-source completeness cell is therefore **UNKNOWN** unless
a specific in-repo measurement exists, and the matrix must be re-read after Stage 1A.

| feature class | PRIMARY | SECONDARY | GAP-FILL | FORBIDDEN / not authoritative | licence of primary | completeness | rationale |
|---|---|---|---|---|---|---|---|
| **Building footprint** | City of Boston **Buildings with Roof Breaks** | OSM (shape cross-check) | OSM for post-2011 structures absent from the City layer | Northeastern ArcGIS (no terms); any imagery tracing | **PDDL** (CONFIRMED, §3) | **UNKNOWN** citywide; OSM 25,010 ways in play box (CONFIRMED) | roof-break polygons are the only footprint source already validated in-tree and licence-clean |
| **Building height / elevation** | City of Boston **Buildings with Roof Breaks** (`GRND_ELEV_2010`/`ROOF_ELEV_2010`/`BLDG_HGT_2010`) | **Boston 3D Buildings (Existing)** `Height_Ft` — **upper bound only**, runs high (§2) | MassGIS parcel `STORIES`; owner-published storey counts | OSM `height` (3.0% coverage); `Z_Max_Ft − Z_MIn_Ft` (§2) | PDDL (CONFIRMED) | height attributes are a **2010** vintage; OSM `height` **3.0%**, `min_height` **0.04%** (CONFIRMED) | the 3D layer is biased for *named* buildings; roof-break heights validated sub-metre against two known towers |
| **Road centreline / ROW** | **MassGIS-MassDOT Roads** | City of Boston Street Segments (SAM) | OSM for topology and for streets the official layers split awkwardly | OSM geometry as committed runtime data (§4) | public record, redistributable with credit (CONFIRMED, §3) | UNKNOWN citywide; OSM `lanes` 57.7%, `width` 51.2% (CONFIRMED) | MassGIS carries lanes, oneway, surface, ROW width, speed, AADT and is **already the runtime source for the NEU district** |
| **Sidewalk polygon** | — none identified — | — | — | — | — | **UNKNOWN** | no sidewalk *polygon* source was located; the City layer is centreline only. Open question. |
| **Pedestrian path / footway** | **OpenStreetMap** | City of Boston Sidewalk Centerline (`SWALK-CL`/`PWALK-CL`) | — | — | **ODbL** — so see §4: research/derivation input, not committed geometry | **20,017 footway ways** (CONFIRMED) vs a City layer last updated **2011** (CONFIRMED) | OSM is both more complete and current here; the licence cost is real and is the reason this class is unresolved |
| **Crossing** | **OpenStreetMap** | City of Boston `CWALK-CL` | — | — | ODbL — see §4 | **6,541 crossings** (CONFIRMED); City 597 m inside the NEU district (CONFIRMED) | same trade-off as footways |
| **Park / open space** | City of Boston **Open Space** | MassGIS open space | OSM `leisure=park` for extent cross-check | — | PDDL (portal default — **not individually verified**, SUPPORTED) | UNKNOWN; OSM 248 park ways (CONFIRMED) | City layer is authoritative for ownership and name |
| **Water / shoreline** | **MassGIS hydrography** | OSM `natural=coastline` | — | — | public record (CONFIRMED) | UNKNOWN; OSM 27 water + 41 coastline ways (CONFIRMED) | tidal/basin distinction matters and MassGIS models it |
| **Rail alignment** | **OpenStreetMap** | MBTA GTFS shapes | MassGIS rail | MBTA route shapes as survey geometry | ODbL — see §4 | OSM 1,206 railway ways (CONFIRMED) | measured in-repo: the MBTA Green Line E shape is **8 vertices over 320 m, shared by both directions**, and sits 5.9 m off — it cannot supply two track centres at all |
| **Transit stop** | **MBTA V3 API / GTFS** | OSM `public_transport` | — | OSM as the authority for stop identity | MassDOT Developers License Agreement — **not read in full; UNCERTAIN** | 146 OSM station nodes (CONFIRMED) | MBTA is the operator and publishes canonical ids (`place-nuniv`, `place-rugg`) |
| **Land use / district hint** | **OSM `landuse`** | MassGIS land use | City zoning | — | ODbL — see §4 | 1,892 OSM landuse ways (CONFIRMED) | this is a *hint* feeding procedural grammar, not geometry; the derivation-only path in §4 fits it well |
| **POI / semantic classification** | **OSM** | City/MassGIS facility layers | — | — | ODbL — see §4 | 162 institutional + 191 historic + 112 tourism (CONFIRMED) | OSM's semantic tagging has no official equivalent at this breadth |
| **Historic / tourism signal** | **OSM** | National Register / MHC listings | — | — | ODbL — see §4 | 191 + 112 (CONFIRMED) | ranking signal only |
| **Hero candidacy signal** | **OSM** (semantic) + in-game measurement (screen occupancy, route proximity) | City landmark lists | — | — | ODbL for the OSM half — see §4 | — | a *score* is a fact-derived number, not geometry |

**Conclusion: no source family wins every class.** OSM is PRIMARY for footway, crossing, rail alignment,
landuse, POI, historic/tourism and hero candidacy — seven of fourteen — and the licence question for those
is a **policy** question (§4), not a settled one. Official GIS is PRIMARY for footprint, height, roads, parks,
water and transit stops. One class (**sidewalk polygon**) has **no identified source at all.**

---

## 2. Correction 2 — Boston 3D dataset, fully pinned

### 2.1 Identity

| field | value | grade |
|---|---|---|
| dataset title | **Boston 3D Buildings (Existing)** | CONFIRMED |
| publisher | City of Boston Planning Department (BPDA); ArcGIS item owner `jcowart_bpda`; portal org **"Boston Maps"**; CKAN publisher "Boston Maps" | CONFIRMED |
| authoritative record | `https://data.boston.gov/dataset/boston-3d-buildings-existing` | CONFIRMED |
| service | `https://tiles.arcgis.com/tiles/sFnw0xNflSi8J0uh/arcgis/rest/services/Bos3d_Existing_MP/SceneServer` (layer 0) | CONFIRMED |
| ArcGIS item id | **`d01bebadca584c249960f1eb6080f88c`** | CONFIRMED |
| CKAN resource id (portal item) | `5ccfe9f0-c618-4d34-903f-89a16f83340f` | CONFIRMED |
| geometry type | I3S **SceneServer**, 3DObject, `meshpyramids` profile, store version 1.10 | CONFIRMED (in-repo, `docs/neu/HEIGHT_SOURCE.md`) |
| horizontal CRS | **EPSG:4326** | CONFIRMED (in-repo) |
| vertical datum | `vcsWkid 5773`; `heightModelInfo` gravity-related, **EGM96_height**; `elevationInfo.unit` = **us-foot** | CONFIRMED (in-repo) |
| scope | **Existing conditions only.** No Approved/Proposed/Under-Construction sibling was found on Analyze Boston; whether one exists is **UNKNOWN** (searched, not located) | CONFIRMED (scope) / UNKNOWN (siblings) |
| lineage | derives from the BPDA Citywide 3D Smart Model, originating in **2011 planimetry**, updated since from BPDA Urban Design models, CyberCity 3D and LiDAR | **SUPPORTED** (secondary source, not the publisher) |

### 2.2 Dates — narrowed, not withdrawn

- CKAN record: **Released 2025-04-17, Modified 2026-06-11.** CONFIRMED.
- Publisher's own description string: *"Last updated: June 2026."* CONFIRMED.
- ArcGIS portal item record: Created 2024-01-30, **Last Updated 2026-09-10**, metadata 2026-09-11.

**Corrected statement:** the publisher's description and the CKAN `modified` field agree on **June 2026**, so
the date stands. The ArcGIS portal item's later 2026-09-10 stamp is an **item-record** modification and is
**not** evidence about the data. Do not quote the September date as a data vintage.

### 2.3 Licence — and why publisher identity was not enough

- **The ArcGIS item's own `licenseInfo` and `accessInformation` are EMPTY.** CONFIRMED (in-repo,
  `docs/neu/HEIGHT_SOURCE.md`).
- The PDDL comes from **the `data.boston.gov` record that names this exact service URL and this exact item
  id**, with licence field verbatim *"Open Data Commons Public Domain Dedication and License (PDDL)"*.
  CONFIRMED (fetched 2026-09-11).
- Redistribution: PDDL is a public-domain dedication — no attribution condition, no share-alike.
- Fitness caveat from the publisher: *"intended for visualization purposes only."* A fitness statement, not a
  licence restriction; it belongs beside every number taken from the layer.

This is the pattern the whole study must follow: **the licence attaches because the City's own portal record
names the resource, not because the City published it.**

### 2.4 What it actually contains, and the bias that disqualifies it as PRIMARY

Fields (`tools/neu-height/config.mjs`): `OBJECTID, Name, Status, QA_Flag, Centr_Lat, Centr_Lon, Gnd_El_Ft,
Height_Ft, Model_LOD, Parcel_ID, StructType, Survey_Dt, Z_Max_Ft, Z_MIn_Ft`.

- **It was mined.** `tools/neu-height/i3s.mjs` reads the per-feature attribute table from I3S node pages
  without decoding a single vertex: **36 leaf nodes, 4,616 buildings, 504 attribute blobs** over the
  Northeastern envelope. The claim in `a5dcefe` §E.2 that it is "not yet mined" was inherited from
  `docs/neu/SOURCES.md:128` (written 2026-09-07) and is **WITHDRAWN** — `docs/neu/HEIGHT_SOURCE.md`
  supersedes it.
- **`Height_Ft === Z_Max_Ft − Gnd_El_Ft`**, deviation 0 across all 4,616 objects. CONFIRMED.
- **Unit is US survey feet**, established independently: EXP reads 184.6 ft → 56.3 m against an OSM-tagged
  56.6928 m (0.7% apart).
- **It runs systematically high for named buildings.** Prudential **233.6 m against a known 228 m**; **+3.2
  to +8.8 m** across the Northeastern cluster. Cause: `Height_Ft` takes the top of the **whole modelled
  mass**, which is correct for a merged object and wrong for a named building.
- **Do not use `Z_Max_Ft − Z_MIn_Ft`.** `Z_MIn_Ft` is the model's lowest vertex, running to **−46 to −50 ft**
  on towers — that difference overstates a tower by ~15 m.
- **Absolute Z is not reconciled.** Ten campus samples against USGS 3DEP: mean −2.96 m with a **3.51 m
  spread**. A datum shift is a constant; that spread is the signature of a unit or local-datum mismatch.
- **Footprints are not available from this layer** in usable form — it publishes `Centr_Lat`/`Centr_Lon`
  centroids, not rings. Footprints must come from Buildings with Roof Breaks.
- **3D geometry is downloadable** in principle (I3S mesh node pages; plus a tiled SketchUp/open-format
  download at `bostonplans.org/3d-data-maps`), but **no mesh has ever been downloaded or committed** here.
- **Citywide coverage is UNKNOWN.** 4,616 buildings were counted in one ~2.2 × 1.8 km envelope; no citywide
  count was taken.

**Corrected role:** the Boston 3D layer is **SECONDARY** for building height — an upper-bound cross-check, and
the gap-fill for post-2011 structures the roof-break vintage does not carry. It is **not** the citywide
massing windfall §E.2 of the study implied.

---

## 3. Correction 3 — Boston licensing is dataset-specific

**Durable rule: never infer a Boston dataset's licence from publisher identity.** Three tiers exist and they
do not behave alike.

**A — Analyze Boston datasets with an explicit PDDL licence field.** Verified individually, 2026-09-11:

| dataset | licence field (verbatim) | publisher | released / modified | data vintage | service named on the record |
|---|---|---|---|---|---|
| **Boston 3D Buildings (Existing)** | "Open Data Commons Public Domain Dedication and License (PDDL)" | Boston Maps | 2025-04-17 / **2026-06-11** | "Last updated: June 2026" | `tiles.arcgis.com/…/Bos3d_Existing_MP/SceneServer` |
| **Boston Buildings with Roof Breaks** | "Open Data Commons Public Domain Dedication and License (PDDL)" | Boston Maps | 2023-01-10 / **2026-04-29** | *"created initially from a flyover in 2011 and is updated periodically based on the aerial imagery and LIDAR data"* | `gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer` |
| **Sidewalk Centerline** | "Open Data Commons Public Domain Dedication and License (PDDL)" | Boston Maps | 2015-08-19 / **2023-12-18** | *"Created in 2011 and last updated in 2011"* | `gisportal.boston.gov/arcgis/rest/services/Infrastructure/OpenData/MapServer/5` |

All three CKAN records **name the exact upstream service**, which is what carries the dedication across to
`gis.bostonplans.org` and `gisportal.boston.gov`. That is the evidence chain; it is not an inference from
"the City published it".

**Two observations that matter more than they look:**

- **Record date ≠ data vintage.** Sidewalk Centerline's record was modified 2023-12-18 but the data is
  **2011**. Roof Breaks' record was modified 2026-04-29 but its height fields are named `*_2010`. A manifest
  must carry both, separately (study §F.5 already requires this).
- **Roof Breaks geometry and attributes have different vintages.** The description says the outlines are
  *updated periodically* from imagery and LiDAR, while the elevation fields are explicitly 2010. The study's
  flat "2010 snapshot" is **NARROWED**: 2010 applies to the **height attributes**; the **footprint geometry
  vintage is UNKNOWN** and must be established before any post-2010 completeness claim.

**B — Boston GIS / ArcGIS services not covered by a naming CKAN record.** `gis.bostonplans.org`,
`gisportal.boston.gov` and `bostonopendata-boston.opendata.arcgis.com` are **separate hosts from
data.boston.gov**. A layer reached directly on one of them, with no Analyze Boston record naming it, has
**UNKNOWN** terms and must be checked at the item and service level before use.

**C — Legacy / other City-hosted resources.** `bostonplans.org/3d-data-maps` publishes a tiled downloadable
city model; **its own terms page was not located** and its licence is **UNKNOWN**. Do not assume it inherits
the Analyze Boston dedication.

Every canonical source must record: **publisher · exact resource (service URL + item/resource id) · exact
terms text · retrieval date · data vintage separately from record date.**

### 3.1 MassGIS — conclusion retained, with one exception added

Supported by current official MassGIS policy (mass.gov, retrieved 2026-09-11):

- data MassGIS creates, collects or holds *"is a matter of public record, and it can be used by anyone for
  their purposes"*;
- *"may be freely redistributed and integrated into commercial products and applications, including any
  derivative works"*;
- credit **requested**: *"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"*;
- MassGIS, EOTSS, data providers and the Commonwealth *"assume no liability"*.

**The exception the study omitted, and it is material:** MassGIS states that where it **licenses certain
datasets for internal use**, it is bound not to redistribute them. So the general conclusion holds, but
**per-layer verification is still required** — "MassGIS" is not, by itself, a redistribution grant either.

No legal certainty is offered beyond this source text.

---

## 4. Correction 4 — ODbL legal requirement vs Boston project policy

These are different things and the study conflated them.

**What ODbL actually requires (SUPPORTED — ODbL 1.0 text and the OSMF Produced Work guideline, read
2026-09-11; not legal advice):**

- Attribution when OSM data or output is publicly used (§4.3).
- Share-alike attaches to a **Derivative Database** publicly used (§4.4); it does **not** attach to a
  **Produced Work** (§4.5) — a rendered frame of Boston would not make the game ODbL.
- §4.6: where a Produced Work is publicly used *from* a Derivative Database, that database must be made
  available. OSMF states it as: *"if you publish a produced work, the underlying database has to be published
  as well (or alternations to the original database as is the case of derived databases), according to
  section 4.6 of ODbL."*

**What is therefore genuinely a licence consequence:** if Boston shipped an OSM-derived canonical geometry
file and published the game, it would be obliged to publish that derived database under ODbL, with
attribution. **It would not be obliged to open-source the game.**

**What is Boston project policy, chosen and not compelled:**

> **POLICY (project, not licence):** no ODbL-derived canonical geometry in `src/` or `dist/`.

This is a **risk-minimisation choice** to avoid taking on derivative-database obligations, versioning a
published database alongside a game, and the unresolved question of where a world-geometry file sits on the
produced-work/derivative-database boundary (**UNCERTAIN**; the one item that would need counsel). It is not
a quotation from ODbL. `a5dcefe` §T condition 4 and gate LEG-2 presented it as though it were; both are
**reclassified as policy.**

**Retained, explicitly:** OSM remains usable for research, cross-check, currency signals, attribute
corroboration and candidate enrichment, provided provenance and attribution obligations are handled. §1 makes
OSM the PRIMARY source for seven feature classes on merit; whether any of those ever become committed
geometry is a **policy decision for the Owner**, and it is now stated as one rather than foreclosed by a
misattributed rule.

---

## 5. Correction 5 — MapLibre

**Withdrawn:** *"cannot coexist with `RenderPipeline`."* That is not true and was not supported.

**CONFIRMED from MapLibre's own documentation and examples** (`CustomLayerInterface`; "Add a 3D model using
three.js", and three further three.js examples covering terrain, shadow and globe):

- Custom layers **share MapLibre's WebGL context** (`onAdd(map, gl)`).
- MapLibre officially documents **three.js integration** as a supported pattern.
- The documented wiring is `renderingMode: '3d'`, `renderer.autoClear = false`,
  `renderer.resetState()` before each `renderer.render(scene, camera)`, then `map.triggerRepaint()`, with the
  camera matrix built from the `modelViewProjectionMatrix` MapLibre supplies.

**Corrected conclusion:**

> MapLibre custom layers **can** technically host custom WebGL/three.js content, and MapLibre documents it.
> But adopting MapLibre as the **camera, projection and world owner** conflicts with Boston's current
> renderer (`RenderPipeline` owns `renderer.render()`, the `postprocessing` HDR composer, n8ao and custom
> cascaded shadows), its local-metre coordinate contract, its Rapier physics stepping, its camera solve and
> its gameplay loop — and it delivers no data the offline pipeline does not already deliver. The benefit is
> insufficient for the cost.

The very mechanics that make it possible are the evidence for the ownership conclusion: `resetState()` exists
because MapLibre owns GL state, `autoClear = false` because MapLibre owns the frame, and the MVP matrix
arrives from MapLibre because MapLibre owns the camera. **Architecture C stays rejected; the reason is
ownership and benefit, not impossibility.** Its score is unchanged, because the score was always about
suitability as world owner.

---

## 6. Correction 6 — projection and mismatch measurements, made reproducible

### 6.1 The 24.7 m figure was over-generalised

`a5dcefe` says *"the hand-authored geography sits a median 24.7 m from reality."* That is too broad.

**What it actually is:** the Euclidean distance, in world metres, between a **game landmark point**
(`src/data/landmarks.js`, one lat/lon per landmark) and the **area-weighted centroid of the corresponding OSM
feature**, both projected through the game's own `geo()`. Source `docs/neu/ANCHORS.json`, generated by
`tools/neu-audit/build.mjs`.

- **n = 11** anchors total: median **24.7**, p90 132.8, max 183.1, mean 57.
- **n = 8** "definition-clean": median **24.7** as reported (recomputed here as **24.55** with linear
  interpolation — the generator's quantile convention is **unspecified**, so quote it as **~24.6 m**),
  p90 **51.4** as reported / 64.6 recomputed, max **95.4**.
- Excluded three, by definitional mismatch recorded in `build.mjs`: `faneuil` (the game entry deliberately
  covers Faneuil Hall *and* Quincy Market), `southStation` (OSM has the whole station, the game pin reads as
  the head house), `bpl` (game entry names the McKim building only).
- Systematic bias dx **+13.6**, dz **−7.3**, magnitude **15.4 m** — reported separately; **translation is NOT
  removed** from the 24.7 m figure.

**Four limits that must travel with the number:**

1. It compares a **point to a polygon centroid**. For a large complex, "position" is ambiguous by tens of
   metres before any error exists.
2. **n = 8.** It is not a distribution; it is eight landmarks.
3. The reference is **OpenStreetMap**, itself community-maintained. This is **cross-source agreement, not
   accuracy against survey ground truth.** No survey-grade reference has ever been used in this project.
4. It measures **landmark placement only.** It says nothing about streets, parks, water or districts.

### 6.2 The street measurement — which is stronger, and which the study missed

`docs/neu/GAPS.json` measures game street centrelines against OSM inside the Northeastern envelope:

| street | n samples | min | **median** | p90 | max | mean | source of the game's geometry |
|---|---|---|---|---|---|---|---|
| Huntington Avenue | 81 | 0.3 | **6.0** | 9.8 | 11.1 | 6.2 | **MassGIS-MassDOT** |
| Columbus Avenue | 46 | 0.0 | **2.4** | 14.8 | 19.9 | 4.1 | **MassGIS-MassDOT** |
| Massachusetts Avenue | 54 | 2.7 | **95.3** | 234.9 | 264.8 | 112.8 | hand-traced |
| Tremont Street | 10 | 21.9 | **37.5** | 47.6 | 51.7 | 36.5 | hand-traced |

**This is the most decisive evidence in the entire study, and `a5dcefe` did not use it.** The two streets fed
from authoritative GIS sit **2.4–6.0 m** from an independent reference; the two hand-traced streets sit
**37.5–95.3 m**. That is a **6× to 40×** difference, measured on the exact system the proposal targets, in
this repository, already.

Caveats, stated plainly: it is **one district**; the comparison reference is OSM, not survey; and the good
results are partly a MassGIS-vs-OSM agreement measurement rather than proof of absolute accuracy. It does not
establish citywide accuracy for anything.

Two further in-repo figures worth carrying: **247** distinct real street names in the Northeastern envelope
against **11** the game has there; and only **39.5%** of the campus polygon lies within 40 m of any game road
(median distance to the nearest game road **51.7 m**, n = 4,232 cells).

### 6.3 Projection measurements — full method

All figures in `a5dcefe` §C were computed in this study by a disposable Node script, run once, **not
committed**. The method is recorded here in full so it can be reproduced from documented inputs.

- **Subject:** `geo()` from `src/core/Geo.js` — equirectangular, origin φ₀ = 42.35538, λ₀ = −71.06565,
  `M_PER_DEG_LAT = 111320`, `M_PER_DEG_LON = 111320·cos φ₀ = 82263.2797…`.
- **Reference CRS:** **WGS84 ellipsoid**, a = 6378137.0, f = 1/298.257223563.
- **Reference distance:** **Vincenty inverse geodesic**, iterated to 1e−12 rad, max 200 iterations.
- **Error metric:** for a point P generated at world (x, z), let `lat = φ₀ − z/111320`,
  `lon = λ₀ + x/82263.2797`. Then **error = | hypot(x, z) − geodesic(origin, P) |**, in metres. It is a
  **radial distance error from the origin**, not a two-point residual and not RMS.
- **Extent / sampling:** deterministic grid over the play box, `x ∈ [−3000, 3000]`, `z ∈ [−3000, 3000]`,
  **step 250 m ⇒ 25 × 25 = 625 samples.** The reported value is the **maximum**.
- **Scale factors:** compared against the WGS84 local radii at φ₀ — meridian
  `M = a(1−e²)/W³`, prime vertical `N = a/W`, `W = √(1−e² sin²φ₀)`, so true metres per degree are
  `M·π/180` (lat) and `N·cos φ₀·π/180` (lon). `k_n = 111320 / (M·π/180)`, `k_e = 82263.2797 / (N·cos φ₀·π/180)`.
- **Shear:** `Δθ = atan(tan 45° · k_n/k_e) − 45°`.
- **State plane:** EPSG:26986 evaluated from the Lambert Conformal Conic 2SP definition — φ₁ = 42°41′,
  φ₂ = 41°43′, φ₀ = 41°, λ₀ = −71°30′, FE 200000, FN 750000 — with point scale
  `k(φ) = ρ(φ)·n / (a·m(φ))` and convergence `γ = n(λ − λ₀)`.

Reported results and their statistic type:

| result | value | statistic |
|---|---|---|
| `geo()` vs geodesic | **6.47 m** at (0, +3000) | **max** over 625 grid samples |
| north scale factor `k_n` | 1.002159 (+2159 ppm) | exact, at origin |
| east scale factor `k_e` | 0.998484 (−1516 ppm) | exact, at origin |
| anisotropy `k_n/k_e` | 1.003680 (3680 ppm) | exact, at origin |
| shear at 45° | 6.31 arcmin | exact, at origin |
| two-scalar ENU calibration residual | **0.45 m** | max over the same 625 samples |
| EPSG:26986 planar vs geodesic | **0.137 m** | max over the same 625 samples |
| EPSG:26986 grid convergence at λ₀ᴮᵒˢᵗᵒⁿ | 0.292° | exact |
| Web Mercator scale variation across the box | 2230 ppm | ratio of endpoints, 42.28° to 42.42° |

**Grade: MEASURED IN THIS STUDY.** The method above is complete enough to reproduce; the script itself was
not retained, so these are **not independently verified**. Anyone re-running should expect the same values to
2 decimal places and should treat a disagreement as a finding.

**Unchanged conclusion:** the projection error (max 6.47 m) is smaller than every authored-geometry error term
in §6.1–6.2, so `src/core/Geo.js` must not change. That conclusion is *strengthened* by §6.2, where the
hand-traced street term reaches 95 m.

---

## 7. Correction 7 — GEO-1 withdrawn, replaced by a four-metric baseline

**Withdrawn:** "median footprint-to-streetwall offset ≤ 8 m PASS / > 20 m FAIL."

It was one number doing three jobs, and the thresholds were not derived from evidence. Worse, it was
calibrated against the 24.7 m landmark statistic (§6.1), which measures a different thing entirely.

### 7.1 What is actually being compared, defined

- **Imported footprint** — a closed ring from Buildings with Roof Breaks, projected through `geo()`.
- **Streetwall** — the polyline formed by the `frontage: {a, b}` segments of the generated parcels
  (`RoadNetwork.buildPlots`) along one side of one road edge, in order. **Not** the kerb, **not** the road
  centreline, **not** the building mesh.
- **Corner and setback parcels** — any parcel whose building carries `frontDirs.length > 1` (the existing
  multi-frontage marker, `Buildings.js:955-962`) is **excluded from the primary statistic and reported
  separately.** A corner building legitimately faces two streetwalls and would otherwise pollute the median.

### 7.2 The four metrics, separated

| id | measures | definition | reported as |
|---|---|---|---|
| **M1 — source consistency** | is the source self-consistent? | distance between Roof Breaks footprint centroids and the independently produced OSM footprint centroid for the same building, matched by containment | min / median / p90 / max, n. **Explicitly NOT accuracy** — no survey reference exists (§6.1 limit 3) |
| **M2 — current-world displacement** | how far is Boston from the source, today? | perpendicular distance from each imported footprint's street-facing edge to the nearest streetwall segment on the owning road edge | full distribution + histogram. **This is the primary output of Stage 1A** |
| **M3 — translation-removed residual** | is the block *offset* or the wrong *shape*? | fit the best rigid translation over the block, report it, then re-report M2 on the residual. Report fitted rotation and scale **separately, and do not remove them** | translation vector + residual distribution |
| **M4 — prototype improvement** | does importing actually help? | not measurable at Stage 1A | **Stage 1B only** |

M3 is the one that changes decisions. A block that is 20 m offset but shape-correct is a cheap fix — one
translation, or a known road misplacement. A block with a 20 m residual *after* translation removal is a
shape disagreement, and shape disagreements propagate into every parcel, frontage and collider.

### 7.3 Decision bands — anchored to in-project precedent, not invented

There is no external accuracy standard to appeal to, so the bands are anchored to measurements this project
has already made (§6.2):

| band | M2/M3 median | meaning | derived from |
|---|---|---|---|
| **A — as good as the project's best** | ≤ **6 m** | matches what MassGIS-sourced streets already achieve against an independent reference | Huntington 6.0 m, Columbus 2.4 m |
| **B — informative, needs judgement** | 6–37 m | better than the worst hand-traced street, worse than the GIS-sourced ones | between the two measured groups |
| **C — the import adds nothing** | ≥ **37 m** | no better than Tremont Street, the worst hand-traced street already shipped | Tremont 37.5 m, Mass Ave 95.3 m |

**These are decision bands, not a pass/fail gate.** Stage 1A's purpose is to **establish the M2 distribution
in Back Bay, which has never been measured**, not to pass a test. A band-C result is a genuine STOP signal; a
band-A or band-B result is a finding to be taken to the Owner with the histogram attached.

All other gates in `a5dcefe` §O (STR-*, GAME-*, PERF-*, LEG-*) stand as written, except that **LEG-2 is
policy, not licence** (§4).

---

## 8. Correction 8 — Stage 1A and Stage 1B split

`a5dcefe` §N described Stage 1 as both a "read-only probe" and "one default-off system". Those are different
authorisations and are now separate stages.

### STAGE 1A — DATA-ONLY PROBE (the only thing the Owner is being asked to consider)

**Hard constraints:**
- **NO `src/` changes.** No runtime consumer of any kind.
- **NO WebGL, no browser, no Vite, no build.**
- **NO new dependency, no `package.json` change.**
- No modification to the production world, in any file.
- Raw extracts cached under a gitignored `.cache/`; **never committed.**

**Deliverables:**
- source provenance manifest per `a5dcefe` §F.5, including data vintage separate from record date (§3);
- coordinate conversion through the game's own `geo()`, never a private projection;
- a normalized schema **candidate** (`a5dcefe` §I) — proposed, not adopted;
- deterministic validation (`STR-1` … `STR-5`), exiting non-zero on failure;
- **comparison against the current authored geography: M1, M2 and M3 with full distributions** (§7);
- one small committed fixture (~20 KiB) for the Back Bay block.

**Output is a report and a fixture. Nothing renders. Nothing is consumed at runtime.**

### STAGE 1B — ISOLATED SANDBOX / DEFAULT-OFF RUNTIME PROTOTYPE

**NOT AUTHORISED by this pass, and not requested.** Would add one opt-in, default-off system behind a query
flag that draws imported outlines as flat ribbons, plus M4. Requires its own Owner review **after** Stage 1A's
report, because it is the first change to `src/`.

The Owner can authorise Stage 1A without authorising any runtime integration. That is the point of the split.

---

## 9. Correction 9 — naming the architecture accurately

The research began as an **OSM hybrid world** hypothesis. Its own evidence does not support OSM as the
backbone, and does support OSM as the best source for seven of fourteen feature classes (§1). Those two
statements are only compatible under a broader name.

- **The OSM-specific hypothesis** — "OSM provides the factual horizontal city geometry" — is **not
  supported.** For footprints, heights and road centrelines, OSM is less complete than the official sources
  (height 3.0%) and carries a licence cost the official sources do not.
- **The general architecture** — *an authoritative-GIS-informed, multi-source, offline world pipeline* — **is
  supported**, and is what the Northeastern district already runs.

Files are **not renamed** (the brief forbids cosmetic churn and the SHAs would stop matching the study).
Both documents now state the distinction in their conclusions. OSM is treated per feature class on value and
licensing cost, never as an assumed backbone.

---

## 10. Correction 10 — what generalises from Northeastern, and what must not

**Northeastern remains CLOSED and FROZEN. No NEU runtime code was read for modification, and none was
changed in this pass.**

### REUSABLE PATTERN — generalise this

| # | pattern | where it exists |
|---|---|---|
| P1 | **Fetch/cache separation** — a `fetch.mjs` that only writes to a gitignored `.cache/`, and constants in a separate file so importing them cannot start a download | `tools/neu-walks/`, `tools/neu-height/config.mjs` |
| P2 | **Offline normalisation with no network** — `build.mjs` reads the committed package and emits; it never re-derives GIS geometry | `tools/neu-hero/build.mjs` |
| P3 | **Generated, provenance-stamped runtime module** — `GENERATED, do not hand-edit`, the regeneration command in the header, and a source block in the artefact | `src/data/neu-hero.js`, `neu-walks.js` |
| P4 | **Project through the game's own `geo()`** — points stored as `[x, z]` world metres, so the runtime never converts | both generated modules |
| P5 | **Runtime keep-out / override** — factual footprints suppress procedural infill through a generic predicate | `Districts.isReserved` → `inHeroFootprint` |
| P6 | **Deterministic output** — same input, same bytes | `tools/neu-hero/build.mjs` |
| P7 | **Graded confidence with the basis recorded** — `storeyConfidence` B/C/D plus `storeyBasis` naming the evidence | `src/data/neu-hero.js` |
| P8 | **Explicit supersession** — a source that loses records *why*, in the file that replaced it | `HEIGHT_SOURCE.md` header |
| P9 | **Selection recorded as selection** — "11,439 m exists inside the district; 163.26 m ships" | `src/data/neu-walks.js` |

### NEU-SPECIFIC — do NOT copy blindly

| # | thing | why it does not generalise |
|---|---|---|
| N1 | The **source schema** — `GRND_ELEV_2010`/`ROOF_ELEV_2010`, `Height_Ft`/`Gnd_El_Ft`, `SWALK-CL`/`PWALK-CL`/`CWALK-CL` | layer-specific field names and encodings; a citywide adapter needs its own mapping per layer |
| N2 | **The part-vs-building unit.** `NEU_HERO_PARTS` is keyed on the *roof-break part*, because three parts are each shared by two named buildings (661061 = Ell + Curry) | correct for a connected quadrangle; **wrong** as a citywide default, where the named building is usually the unit |
| N3 | **`MICRO_M2 = 100`** — the cutoff below which a roof-break part is clutter | tuned on one campus; a citywide value must be re-derived |
| N4 | **Campus-specific overlap logic** — `heroOverlap`, the campus-polygon envelope, the 320 m context buffer, `crossesPath` against the Huntington arterial | written against one campus ring and one arterial; the *idea* (P5) generalises, the *implementation* does not |
| N5 | **Hero-specific geometry** — `NeuHero.js` extrusion, facade reuse, Krentzman octagon, Huntington median/platform/reservation | frozen, district-specific, and part of a closed programme |
| N6 | **Coordinate assumptions** — outlines pre-projected to `[x, z]` at build time | the *convention* generalises (P4); the *specific* committed coordinates are NEU's and are frozen |
| N7 | **`ASSESSOR_STOREYS` / `OFFICIAL_STOREYS`** hand-curated maps | per-building owner-published evidence; does not scale and must not be faked at scale |
| N8 | **Every frozen Northeastern contract** — the opening, the grade transition, the Green Line reservation, the platform, ground ownership | CLOSED. A citywide pipeline must route around the NEU district, not through it |

**Practical rule for a successor:** copy P1–P9 as a *shape*; re-derive N1–N8 from scratch for any new district;
and treat `src/world/NeuHero.js` and `src/data/neu-hero.js` as read-only reference, never as a template to
edit.

---

## 11. Final architecture classification

# B — AUTHORITATIVE-GIS-FIRST HYBRID WITH OSM GAP FILL

Chosen on the §1 matrix, not as a default. Precisely:

- **Authoritative GIS is PRIMARY** for building footprint, building height, road centreline/ROW, park, water
  and transit stop — six classes.
- **OSM is PRIMARY** for footway, crossing, rail alignment, land use, POI, historic/tourism and hero
  candidacy — seven classes — on measured merit.
- **One class has no source** (sidewalk polygon) and is an open question.
- **The matrix governs.** Where it and this heading disagree, the matrix wins.

The label "with OSM gap fill" understates OSM's role in the semantic and pedestrian classes; it is retained
because for the classes that produce **runtime geometry**, official GIS leads and OSM fills gaps. Whether
OSM's seven classes ever become committed geometry is the **policy** question in §4, still open, and now
correctly labelled as the Owner's to decide rather than closed by a misattributed licence rule.

**Not C (authoritative-GIS-only):** it would discard the best available footway, crossing and semantic data.
**Not A (OSM-centric):** OSM height coverage is 3.0% and the licence cost is real.
**Not D (keep current architecture):** §6.2 measures hand-traced streets at 37.5–95.3 m against 2.4–6.0 m for
GIS-sourced ones, in this repository, on this system.

---

## 12. Does the CONDITIONAL GO survive?

**Yes, unchanged in direction, with conditions restated.**

Nothing found in this pass weakens the case. §6.2 — the street-deviation measurement the original study
overlooked — **strengthens** it considerably: it is direct, in-repo evidence that authoritative input improves
the exact system in question by 6× to 40×.

Restated conditions:

1. **`src/core/Geo.js` is not changed.** Max projection error 6.47 m against authored errors up to 95 m.
2. **Stage 1A measures M1/M2/M3 in Back Bay and reports the distributions.** A band-C result (median ≥ 37 m)
   is a STOP. There is no pass/fail gate, because the quantity has never been measured.
3. **Roads and terrain migrate last, or never.**
4. **Policy (not licence): no ODbL-derived canonical geometry in `src/` or `dist/`**, enforced by a gate —
   and reviewable by the Owner as the policy it is.

---

*Research only. No runtime change, no dataset added, no dependency added, no implementation authorised.
Stage 1A not started.*
