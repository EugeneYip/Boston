# Stage 1A — Back Bay data-only factual geography probe

**Date** 2026-09-12 · **Baseline** `b4ae2c075c187f865fcc8ed105c484237d14d802` (HEAD == origin/main, clean, 0/0)
**Scope** Data only. No `src/` change, no runtime consumer, no WebGL, no build, no dependency.
**Canonical where documents disagree** `research/GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md`.
**Stage 1B is NOT authorised and was not begun.**

> **SUPERSEDED IN PART, 2026-09-12 — see `research/GIS_HYBRID_WORLD_STAGE1A1_BUILDING_RECONSTRUCTION_2026-09-12.md`.**
> Stage 1A.1 answers this report's main open question (R1, the roof-break part vs building unit) and
> narrows the datum wording in §F. Where the two disagree, Stage 1A.1 is canonical.

---

## A. Executive result

**PARTIAL — a positive partial.** Every PASS criterion is met except one, and the one that is not is a
known, solvable preprocessing gap rather than a blocker.

What Stage 1A established, all measured:

- The authoritative source can be **acquired reproducibly**: three identical bounded queries returned
  **byte-identical** responses.
- Its licence is **PDDL, pinned to the exact resource** — and the pinning discipline was necessary, because
  the service's own metadata is empty.
- The transform into Boston's existing coordinate frame is **verified to 0.03 mm of scatter** over 4,575
  vertices against an independent inverse projection, with a **0.971 m NAD83/WGS84 datum offset isolated**
  rather than hidden.
- Normalization is **deterministic** — byte-identical across three runs — with **218 of 218 features
  accepted, 0 rejected**, and structural validation **clean**.
- Building **height is present on 88.5%** of features, against **3.9% for OSM in the same box** — a 23×
  difference, and the single strongest argument for authoritative-first.
- The current world **is materially displaced** from the authoritative source: M2 abs median **6.52 m**
  excluding Commonwealth Avenue, **12.81 m** including it, and M3 shows **only about a third** of that is a
  rigid offset. The rest is genuine placement and width disagreement.
- **The one unresolved feature class in the accepted matrix is now resolved**: a City of Boston **Sidewalk
  Inventory polygon layer** exists, is PDDL, and has 68 polygons in the probe area.

Why not PASS:

- **The Roof Breaks unit is the roof-break PART, not the building.** 207 of 218 parts (**95.0%**) share an
  edge with a sibling; the median part is 146.66 m². A **dissolve step**, which Stage 1A did not attempt, is
  required before this data can feed any building-level consumer.
- **Matching ambiguity limits M2's decisiveness**: 89 of 218 parts are unmatched, and the headline moves from
  6.52 m to 12.81 m depending on whether Commonwealth Avenue — which Boston models as two one-way
  carriageways — is included.

Both are exactly the brief's own PARTIAL examples.

---

## B. Exact area

| | |
|---|---|
| centre | 42.34950, −71.08000 → world **(−1180.48, 654.56)** |
| bbox WGS84 (s, w, n, e) | **42.347703, −71.082431, 42.351297, −71.077569** |
| bbox Boston local | **x [−1380.46, −980.50], z [+454.52, +854.60]** |
| span | **399.96 m** E–W × **400.08 m** N–S |

The handoff's WGS84 bbox reconstructs from "centre ± 200 m" to within 4×10⁻⁷ degrees, so it was used
verbatim and **not moved or enlarged**. Its parenthetical world-space annotation (`x ∈ [−1450, −1050],
z ∈ [−600, −200]`) was **wrong in both magnitude and the sign of z**; the WGS84 box is authoritative and the
handoff has been corrected.

Streets Boston has inside the box: Blagden, Boylston, Commonwealth Avenue Inbound and Outbound, Exeter,
Fairfield, Huntington, Newbury, Public Alley 435, Public Alley 442, Ring Road — **11 named edges, 35 road
edges, 386 current parcels** (333 `backBay`, 53 with a null district falling back to `southEnd` zoning).
Current parcel width median 8.3 m, depth median 22.2 m. Not Northeastern; Northeastern untouched.

---

## C. Source inventory

| role | dataset | features in box | licence |
|---|---|---|---|
| **PRIMARY — footprint + height** | City of Boston **Buildings with Roof Breaks**, FeatureServer/9 | **218** | ODC-PDDL-1.0 |
| **Sidewalk polygon (Phase 3)** | City of Boston **Sidewalk Inventory**, OpenData MapServer/0 | **68** | ODC-PDDL-1.0 |
| **Comparison only** | OpenStreetMap via Overpass — **counts only, no geometry retrieved** | see §M | ODbL-1.0 |

MassGIS was not required for Stage 1A: the City layers cover buildings and sidewalks, and no road import was
attempted (roads migrate last, or never — accepted §P).

---

## D. Provenance / licensing

Full machine-readable records in `research/gis-stage1a/manifest.json`.

**Buildings with Roof Breaks.** Publisher Boston Maps. Analyze Boston record
`data.boston.gov/dataset/boston-buildings-with-roof-breaks` (CKAN id `08fd5249-…`), released 2023-01-10,
record modified **2026-04-29**. Data vintage: *"created initially from a flyover in 2011 and is updated
periodically based on the aerial imagery and LIDAR data"*, with elevation fields named `*_2010`.
CRS **EPSG:6492** (NAD83(2011) / Massachusetts Mainland, **ftUS**) — the service reports
`wkid 103072 / latestWkid 6492`, `xyUnits 3048.0060960121928`.

**The licence pinning mattered, and this is the evidence it mattered.** The service's own metadata is
**empty**: `copyrightText ""`, `serviceDescription ""`, `description ""`, no `licenseInfo`. Publisher identity
alone would have proved nothing. The licence attaches because the City's **own Analyze Boston record states
PDDL verbatim and lists this exact FeatureServer URL as one of its resources.** That is the chain, and it is
the discipline the acceptance note required.

**Sidewalk Inventory.** Publisher Boston Maps; survey by Boston Public Works Department. CKAN id
`57b57bc6-…`, released 2015-06-04, record modified 2023-12-18, data vintage *"Completed by the Boston Public
Works Department (PWD) in 2014"*. CRS **EPSG:2249**. Same pinning chain; layer's own `copyrightText` empty.

**Vertical datum: UNRESOLVED.** The Roof Breaks service states no vertical reference for `GRND_ELEV_2010` /
`ROOF_ELEV_2010`. Stage 1A therefore keeps elevations **in source feet** and converts only the *difference*
(`BLDG_HGT_2010`) to metres. Absolute elevation is not converted into the game's vertical frame, because
doing so would manufacture a false absolute. This is the same discipline `docs/neu/HEIGHT_SOURCE.md` reached.

**OSM.** ODbL-1.0. Used for **counts only** — no geometry was retrieved, normalized or committed, so **no
ODbL derived database exists in this repository**. Per Owner policy this is permitted for research and
comparison; the policy bound on production/`src/`/`dist/` was not approached.

---

## E. Normalized schema candidate

`research/gis-stage1a/schema-v0-candidate.json` — a **candidate for review, not the production schema**.

Invariants (`sourceFamily`, `dataset`, `featureClass`, `licence`, `sourceCrs`, units, transform) are hoisted
to a file-level `source` block rather than repeated 218 times, the shape `neu-hero.js` already uses with
`NEU_HERO_SOURCE`.

Each feature separates three tiers, and the separation is load-bearing:

- **FACT** — supplied by the source, **in the source's own units**: `heightFt`, `groundElevFt`, `roofElevFt`,
  `partUse`, `landUse`, `braLandUse`, `ielType`, `shapeAreaFt2`. Nothing here is converted, so a successor can
  re-derive independently instead of trusting this adapter.
- **DERIVED** — computed deterministically from FACT: `rings` (Boston local metres, 2 dp, outer ring first,
  closing vertex dropped, outer CCW / holes CW by signed area so source winding is irrelevant), `areaM2`,
  `heightM`, and `heightBasis` recording the exact arithmetic (`BLDG_HGT_2010 x 0.3048`).
- **INFERRED** — **Stage 1A emits none, by design.** No facade, window, cornice, material or architectural
  attribute appears anywhere. The source supplies none.

`confidence` is `FACT_IF_PRESENT` (193) or `FACT_GEOMETRY_ONLY` (25) — the latter meaning footprint only, and
downstream **must not invent a height for it**.

---

## F. Coordinate transform

```
EPSG:6492 (ftUS)  --[ArcGIS query outSR=4326]-->  WGS84 lat/lon  --[src/core/Geo.js geo()]-->  Boston X/Z
```

**`geo()` was not modified and not reimplemented** — it is imported from production. EPSG:26986/6492 was
**not** introduced as a runtime coordinate system; it is the source CRS only, and it is left at the door.

**Verification.** An independent inverse Lambert Conformal Conic (`transform.mjs`) was run over **all 4,575
shared vertices** of the native EPSG:6492 fetch and compared against the server's own `outSR=4326` output:

| | value |
|---|---|
| radial residual | min **0.9708 m**, median **0.9709 m**, max **0.9710 m** |
| standard deviation | **0.00003 m** north, **0.00004 m** east |
| mean component | dNorth **−0.9698 m**, dEast **+0.0464 m** |
| transformation ArcGIS used | **NOT PINNED** — see the correction below |

The 0.03 mm scatter **verifies the server reprojection** rather than trusting it.

**[CORRECTED 2026-09-12 — Stage 1A.1]** The constant 0.971 m was described here as isolating the
"NAD83 → WGS84 datum shift". **That is too strong and is withdrawn.** A constant difference between the
ArcGIS `outSR=4326` result and an independent inverse projection does not establish *which* geographic
transformation ArcGIS applied; the service publishes no transformation metadata, and Stage 1A.1 did not pin
it. The durable wording is:

> **Observed constant offset between the ArcGIS EPSG:4326 transformation and the independent
> inverse-projection result; likely attributable to datum / geographic-transformation choice, exact
> transformation not yet pinned.**

What remains established: the offset is constant to 0.03 mm across 4,575 vertices, is essentially all
northing, is present in every fixture coordinate, and is **smaller than every other quantity Stage 1A
measured**. No coordinate system was changed.

---

## G. Structural validation

`validate.mjs` → `validation-report.json`. Result **PASS_WITH_WARNINGS**, exit 0.

| check | result |
|---|---|
| source → normalized → rejected | 218 → **218** → **0** |
| unique ids / unique source ids | 218 / 218 |
| non-finite coordinates | **0** |
| rings under 3 vertices / under 1 m² | **0 / 0** |
| outer-ring winding wrong / hole winding wrong | **0 / 0** |
| self-intersecting rings | **0** (0 checks skipped) |
| deterministic ordering | verified |
| ring vertices | 4,348; outer ring min 4, mean **19.94**, max 316 |
| multi-ring features | 7 (3.2%) |
| **repeated-output determinism** | **byte-identical across 3 runs**, sha256 `1c9cf1dc2e6f31a4…` |

One warning, **deliberately reclassified**: the roof−ground ≡ height identity is a *source* consistency
question, so it is measured by M1 and only warned here. Failing a structural gate on it would conflate the
integrity of our output with the internal consistency of the City's data, which the normalizer cannot fix.

---

## H. M1 — source consistency

| check | result |
|---|---|
| features / duplicate source ids | 218 / **0** |
| elevation triplet present / absent / partial | **193** / 25 / **0** (all-or-nothing) |
| **height identity `roof − ground ≡ height`** | **192 of 193 = 99.48%** |
| identity failures | **1** — `bos-rb-676270`, Δ **8.259 ft** (2.52 m) |
| area agreement, ring vs `Shape__Area` | median **0.06%**, p25 0.04%, p75 0.09% |
| multi-ring features | 7 |

**M1: USABLE.** The one outlier is recorded, not smoothed. The area-agreement max of 109% is an artefact of
comparing an outer-ring area against a source area net of holes, on one of the 7 multi-ring features — it is
a limitation of the check, not of the source.

---

## I. M2 — current-world displacement

**Definition used.** Signed perpendicular distance from the authoritative part's street-facing edge to the
current parcel `frontage` polyline for the matched road edge and side. **Positive = the real building sits
inland of Boston's building line; negative = it would stand in Boston's pavement or road.** Matching rules
are documented in full in `metrics.mjs`.

**One methodological correction, made during the work and reported because it changed the answer's sign.**
The first implementation reused `Buildings._streetDirs`' third condition — deduct `corridorHalf(e)`, require
the residual under `EXPOSED` (3.0 m). That is correct for **generated parcels**, which by construction never
lie inside a road corridor. Applied to **authoritative footprints** it is a biased selector: real footprints
frequently do overlap Boston's mis-placed roads, such an edge scores a *negative* gap, and sorting by gap then
picks the edge lying deepest inside the carriageway while rejecting every genuinely set-back wall at gap ≥ 3 m.
It returned a median of **−5.68 m** on a sample whose buildings sit a median 15.3 m from the centreline of an
8.76 m corridor — **a sign inversion manufactured by the selection rule.** It was replaced with an occlusion
ray (nothing built between this wall and that street), which has no such bias. All figures below use the
corrected test.

| bucket | n | share |
|---|---|---|
| PRIMARY (exactly one street-facing front) | **67** | 30.7% |
| CORNER (≥2 fronts — the accepted `frontDirs > 1` exclusion) | **45** | 20.6% |
| UNMATCHED | **89** | 40.8% |
| centroid outside the box | 17 | 7.8% |

Unmatched reasons: **64 no-parcel-frontage** (`buildPlots` grants no frontage to alleys, and Public Alleys
435/442 run through this block), **25 no-street-facing-edge** (interior roof-break parts).

| distribution | n | min | p10 | p25 | median | p75 | p90 | max | mean | RMS |
|---|---|---|---|---|---|---|---|---|---|---|
| **PRIMARY signed** | 67 | −12.81 | −6.01 | −3.09 | **+12.77** | 17.32 | 19.56 | 53.95 | 9.77 | 16.63 |
| **PRIMARY abs** | 67 | 0.19 | 3.26 | 5.73 | **12.81** | 17.32 | 19.56 | 53.95 | 13.10 | 16.63 |
| **PRIMARY abs, excluding Commonwealth Ave** | **46** | 0.19 | — | 4.86 | **6.52** | 13.29 | 17.99 | 53.95 | 11.40 | — |
| front rank only (within 4 m of the nearest wall on that frontage) | 59 | — | — | 5.73 | **12.81** | 17.32 | 18.01 | 53.95 | 12.75 | 15.92 |
| CORNER abs (reported, excluded from primary) | 45 | 0.97 | 2.96 | 4.98 | **8.41** | 10.61 | 20.96 | 112.86 | 12.68 | 22.15 |

**Per street, front rank, signed median:** Commonwealth Avenue Outbound **+17.32** (n=20) · Exeter **+8.57**
(n=3) · Boylston **+6.38** (n=9) · Newbury **−3.26** (n=18) · Fairfield **−5.75** (n=4) · Ring Road −6.01
(n=2) · Huntington −12.81 (n=2) · Dartmouth +49.14 (n=1).

**Commonwealth Avenue dominates the headline and is a modelling-convention mismatch, not simply an error.**
Boston models Comm Ave as two separate one-way carriageways, so "distance to the frontage of one carriageway"
is not the same quantity as on an undivided street. Excluding it moves the abs median from **12.81 m to
6.52 m**. Both figures are reported; neither is the single truth.

**An independent check, needing no matching heuristic.** Perpendicular probes every 8 m along Boston's own
centrelines, measuring real building-line to building-line separation directly from the authoritative
footprints:

| street | real b-line separation (median) | Boston models | delta | per-side to Boston centreline |
|---|---|---|---|---|
| Newbury | **29.8 m** | 17.5 m | **+12.3** | 5.5 / 24.9 (Boston corridorHalf 8.76) |
| Exeter | 36.7 m | 17.5 m | +19.2 | 15.3 / 17.2 |
| Boylston | 31.7 m | 27.1 m | +4.6 | 20.9 / 9.9 (13.56) |
| Huntington | 36.0 m | 27.1 m | +8.9 | 12.6 / 16.4 |
| Fairfield | **11.9 m** | 17.5 m | **−5.7** | 7.4 / 6.1 |

This corroborates M2 from a different direction and shows the error is **not one thing**: Newbury's
centreline is displaced (5.5 vs 24.9 either side), Exeter's is well-centred but the street is modelled far too
narrow, and Fairfield is modelled too *wide*.

---

## J. M3 — residual after one rigid translation

One best-fit 2D translation over the front-rank set. **No rotation, no scale, no warp.** Each row constrains
the translation only along its own outward normal, so this is a 2×2 least-squares system; residual is
`m2 − (t · n)`.

| | |
|---|---|
| best-fit translation | **dx +6.650 m, dz −11.304 m, magnitude 13.115 m** |
| conditioning | n = 59, det = 400.6 (well conditioned) |
| residual signed | min −21.10, p25 +3.39, median **+8.02**, p75 9.80, max 43.83 |
| residual abs | min 1.72, p25 5.14, median **8.59**, p75 11.62, p90 16.60, max 43.83, RMS 13.35 |

**A single rigid translation absorbs about a third of the displacement** (abs median 12.81 → 8.59 m) and
leaves 8.59 m. **The block is therefore not merely offset.** There is genuine per-street placement and width
disagreement, which is precisely what M3 exists to distinguish — and it is consistent with the §I table,
where different streets fail in different directions. M3 is reported alongside M2, not instead of it.

---

## K. Attribute completeness

Measured on the fixture, n = 218. **Field exists in schema ≠ field populated.**

| attribute | count | % |
|---|---|---|
| footprint (outer ring) | 218 | **100%** |
| stable source ID | 218 | **100%** |
| `Land_Use` / `BRA_Land_Use` | 218 | **100%** |
| `Shape__Area` | 218 | **100%** |
| `IEL_TYPE` | 217 | 99.5% |
| **`BLDG_HGT_2010` (height)** | **193** | **88.5%** |
| `GRND_ELEV_2010` (base elevation) | 193 | 88.5% |
| `ROOF_ELEV_2010` (roof elevation) | 193 | 88.5% |
| `PART_USE` | 191 | 87.6% |
| roof-break / multipart representation | 7 | 3.2% |
| **`Added` (per-feature vintage)** | **1** | **0.5%** |

Heights: n = 193, min 5.19 m, **median 16.85 m**, max 120.42 m. Land use spans RC 88, C 60, CM 26, E 17,
A 14, R1 5, R4 3, O 3, R3 1, G 1.

**Per-feature vintage is effectively absent** (0.5%) — a real gap. Dataset-level vintage is all there is, and
it differs between geometry (2011 flyover, periodically updated) and elevations (2010). No second official
source was joined, so no join-success rate is reported.

---

## L. Sidewalk source hunt — **FOUND-AUTHORITATIVE**

Bounded search, City of Boston first, and it terminated at step 1.

**City of Boston — Sidewalk Inventory**, `Infrastructure/OpenData/MapServer/0`, `esriGeometryPolygon`,
EPSG:2249, **68 polygons inside the probe box**. Licence **ODC-PDDL-1.0**, pinned through the Analyze Boston
record (`57b57bc6-…`) which names this exact layer URL; the layer's own `copyrightText` is empty. Data
vintage: **completed by Boston PWD in 2014**.

Fields carry more than geometry: `SWK_ID`, `MATERIAL`, `SWK_WIDTH`, `SWK_SLOPE`, `SCI` (condition index),
`curb_type`, `SIDE`, `SEG_ID`, `SWK_AREA`, `INSP_DATE`. A separate **`Curbs`** polyline layer exists in the
same service.

**This moves the one feature class the accepted precedence matrix recorded as having no identified source
to: AUTHORITATIVE CANDIDATE FOUND — QUALITY / VINTAGE FITNESS UNVALIDATED.** It was not normalized — that
was not in scope — its geometry quality is **unassessed**, and its 2014 survey vintage is **not**, by itself,
a reason to promote it to canonical production input. MassGIS and OSM were not needed for this class.

---

## M. OSM comparison — comparison only

Bounded Overpass `make count` over the identical bbox. **Counts only; no geometry retrieved, normalized or
committed.**

| feature | OSM | authoritative | reading |
|---|---|---|---|
| buildings | **154** | 218 roof-break parts | different units; parts are finer than footprints |
| building `height` | **6 (3.9%)** | **193 (88.5%)** | **23× in favour of the City layer** |
| `building:levels` | 34 (22.1%) | — | OSM's better height proxy, still 22% |
| `highway=footway` | **184** | — | OSM strong, as the accepted matrix predicts |
| `footway=crossing` | **53** | — | OSM strong |
| `amenity` nodes | **176** | — | no official equivalent at this breadth |
| `tourism` | 22 | — | semantic signal |
| `historic` ways | 0 | — | none in this block |

This is the accepted matrix reproduced at block scale: **official GIS wins decisively on building height;
OSM wins decisively on pedestrian realm and semantics.** Nothing here changes the classification.

---

## N. Fixture / storage

| | |
|---|---|
| `fixture.json` | **153,339 bytes = 149.7 KiB** |
| gzip −9 / brotli | **33.5 KiB / 24.0 KiB** |
| features / ring vertices | 218 / 4,348 |
| bytes per feature | 703 |

**It exceeds the ~20 KiB target, and the data was not distorted to hit it.** The cause is measured: the
roof-break part carries a **mean 19.94 outer-ring vertices** — 2.7× the 7.5 measured for OSM Back Bay
footprints — because it traces roof-plane changes rather than building outlines. Pretty-printing was removed
(288 KiB of whitespace, no information) and file-level invariants were hoisted out of the per-feature records,
which together took it from 378 KiB to 150 KiB. Cutting further would mean dropping features or decimating
rings, which is exactly the distortion the brief forbids. 150 KiB remains a perfectly tractable committed test
artifact.

Raw downloads stay in `research/gis-stage1a/cache/`, **gitignored and uncommitted**.

---

## O. Risks

| # | risk | severity | note |
|---|---|---|---|
| R1 | **Roof-break parts are not buildings.** 95.0% share an edge with a sibling; median part 146.66 m²; 44 parts under the NEU `MICRO_M2 = 100` cutoff | **High** | a dissolve step is required and was not attempted. This is the main reason the verdict is PARTIAL |
| R2 | **M2's headline is convention-sensitive** — 12.81 m with Commonwealth Avenue, 6.52 m without | **Medium** | both reported; divided boulevards need their own rule |
| R3 | **40.8% of parts unmatched** (64 no-parcel-frontage, 25 interior) | Medium | alleys get no frontage by design; interior parts have no streetwall to compare to |
| R4 | **Vertical datum unresolved** | Medium | elevations kept in source feet; only the *difference* converted. Do not treat `GRND_ELEV_2010` as a game elevation |
| R5 | **Per-feature vintage absent** (0.5%) | Medium | a "missing" building may simply postdate the source; only dataset-level vintage exists |
| R6 | **±2 features at the box boundary** depending on which CRS the spatial test runs in | Low | boundary tangency, not data loss; documented in the manifest |
| R7 | **0.97 m NAD83/WGS84 datum offset** in every coordinate | Low | measured and isolated; smaller than everything else here |
| R8 | **One source height-identity failure** (2.52 m) | Low | recorded, not smoothed |
| R9 | Sidewalk Inventory geometry quality **unassessed** | Low | found and pinned; not fetched beyond a count |

---

## P. Successor handoff

`research/gis-stage1a/` — `README.md`, `manifest.json`, `schema-v0-candidate.json`, `fixture.json`,
`validation-report.json`, `metrics-report.json`, and six small deterministic scripts. Reproduce with three
commands; `normalize.mjs` needs no network.

Placed under `research/` rather than `tools/` deliberately: the accepted brief forbids `tools/` changes, and
research-local tooling signals non-runtime status unambiguously. **Removal is `rm -rf
research/gis-stage1a`** — nothing outside that directory was created or modified.

The one non-obvious enabler, documented in the README so nobody re-derives it: **`RoadNetwork.js` imports
zero THREE**, and `Terrain.bake()` / `stampRoads()` / `groundHeight()` / `Districts.bake()` touch THREE only
for module-scope scratch objects. The real production path up to `RoadNetwork.buildPlots()` therefore runs in
Node in ~420 ms with **no renderer and no canvas**. That is how the current world was measured without WebGL.

---

## Q. Verdict

# PARTIAL

Met: reproducible acquisition (byte-identical ×3) · licence and provenance resolved to the exact resource ·
deterministic fixture (byte-identical ×3) · structural validation clean (0 failures) · transform stable and
independently verified (0.03 mm) · M1 usable (99.48%) · M2/M3 show a material factual difference · successor
artifacts complete and removable.

Not met: **no fundamental schema blocker** — the part-vs-building dissolve (R1) is an important unresolved
gap, and matching ambiguity (R2, R3) keeps M2 from being decisive on its own.

---

## R. Stage 1B recommendation — **NOT an authorisation**

Stage 1B should be **considered**, but **not as currently specified**, and not before one piece of Stage 1A
follow-on work.

**Recommended before any Stage 1B:** a **dissolve experiment**, still data-only, still no `src/` — union
edge-adjacent roof-break parts into building-level polygons within the same box, then re-run M2/M3 on the
dissolved set. It is the single highest-value next measurement, it directly attacks R1, R3 and the
part/building unit problem, and it would likely move a large share of the 89 unmatched parts into the primary
distribution. Without it, Stage 1B would render the wrong unit.

**If the Owner authorises Stage 1B afterwards,** two amendments to its accepted specification are warranted on
Stage 1A evidence: the overlay should draw **dissolved building outlines**, not raw parts; and divided
boulevards (Commonwealth Avenue) need their own comparison rule, or should be excluded from the visual
comparison entirely.

**Nothing here authorises Stage 1B.** That decision is the Owner's.

---

*Stage 1A. Research only. No runtime change, no dependency, no `src/` modification, no WebGL. Stage 1B not
begun.*
