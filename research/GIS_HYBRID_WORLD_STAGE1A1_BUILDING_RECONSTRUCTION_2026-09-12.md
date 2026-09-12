# Stage 1A.1 — roof-break parts → defensible building units

**Date** 2026-09-12 · **Baseline** `c673135f3bf9e12b93fbc00edc83d28aa713470e` (HEAD == origin/main, clean, 0/0)
**Scope** Data only. No `src/` change, no runtime consumer, no WebGL, no dependency. **Stage 1B not begun.**

> **EXTENDED 2026-09-12 — see `research/GIS_HYBRID_WORLD_STAGE1A2_COVERAGE_SAFE_TRANSFER_2026-09-12.md`.**
> Stage 1A.2 closes B7, corrects the false-merge attribution and the `LOCAL_ID` documentation status,
> narrows the M3 vector claim, eliminates the four false merges, and transfers the method to the North End.
> Where the two disagree, Stage 1A.2 is canonical.
**Canonical on architecture** `research/GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md`.

---

## A. Result

# PARTIAL

**Yes, the parts can be grouped defensibly — but only because a *second* authoritative source supplies the
identity the PDDL layer omits, and that path has two measured defects that are source gaps rather than
algorithm faults.**

The three findings that matter:

1. **The PDDL roof-break layer has no parent-building identifier.** 12 fields on the FeatureServer,
   `relationships: []`, `tables: []`, and the PDDL CSV download carries the same 12. There is nothing to
   group on.
2. **Edge adjacency is catastrophic, exactly as the brief predicted.** Union on any shared edge collapses
   218 parts into 31 components, one of which swallows **20 distinct buildings**; **19 of 31 components span
   more than one building**. And no PDDL-only signal rescues it — shared-boundary length is a median
   **16.13 m within a building against 16.41 m between buildings**, i.e. no separation at all.
3. **MassGIS Building Structures (2-D) carries the City's own building identifier verbatim in `LOCAL_ID`**,
   on a layer that is a public record and freely redistributable. That is the licence-clean parent identity.
   218 parts → **147 units**, **0 false splits**, **4 residual false merges**, all attributable to MassGIS
   holding no structure for 6 of 140 City buildings.

Why not PASS: the 4 residual party-wall false merges are real, 16 parts remain `AMBIGUOUS`, and — the
finding that most disappoints the Stage 1A hypothesis — **grouping resolved only 15.7% of the unmatched
parts**, because the dominant cause was never fragmentation. Vertical datum is now **partly resolved**
(NAVD88, documented) but not for the fields actually consumed.

---

## B. Source semantics (Phase 1)

`Boston Buildings with Roof Breaks`, FeatureServer/9. **Every field is part-level. None can carry parent
identity.** Documented semantics are thin: the layer publishes no field-level description, and `IEL_TYPE`'s
meaning had to be recovered from a *different* City service (§C).

| field | type | populated | level | parent identity? | semantics |
|---|---|---|---|---|---|
| `OBJECTID` | OID | 100% | part | **no** — service-local, renumbers between services (0 of 218 overlap with the City's own copy) | UNSUPPORTED |
| `PART_USE` | String(2) | 87.6% | part | no | inferred from name; coded values undocumented here |
| `PART_BRA_U` | String(2) | 87.6% | part | no | as above |
| `GRND_ELEV_2010` | Double | 88.5% | part | no | ground elevation, feet, **no stated vertical datum** |
| `ROOF_ELEV_2010` | Double | 88.5% | part | no | roof elevation, feet, same |
| `BLDG_HGT_2010` | Double | 88.5% | part | no | = roof − ground; **misleadingly named**: it is a PART height, not a building height |
| `IEL_TYPE` | String(50) | 99.5% | part | no | **documented, but only on the City's `DOIT_buildings` service**: BLDG / OUTBLDG / FOUNDATION / RUINS |
| `Land_Use` | String(5) | 100% | part | no | replicated across siblings; 47% precision as a same-building predictor — useless |
| `BRA_Land_Use` | String(5) | 100% | part | no | has a coded-value domain "Building Use" |
| `Added` | Date | **0.5%** | part | no | effectively absent |
| `Shape__Area` / `Shape__Length` | Double | 100% | part | no | ft², ft |

**Grouping-key classification:** every candidate in this layer is **UNSUPPORTED**. `Land_Use`, `PART_USE`
and shared-edge topology were each tested and each fails (§E).

Observed in the bbox: `IEL_TYPE` = BLDG 212, OUTBLDG 4, OVHD-WALKWAY 1, null 1.

---

## C. Parent-ID gate (Phase 2) — the PDDL layer FAILS it

`relationships: []`, `tables: []`, no `BUILDING_ID`/`STRUCT_ID`/`PART_ID`/`PARCEL_ID`, no related table, no
subtypes. A bounded range-request on the **PDDL CSV download** (first 1,500 bytes, header only) returned the
identical 12 columns. **There is no parent identity in any PDDL-licensed resource found.**

**But the identity exists.** `gisportal.boston.gov/.../Assessing/DOIT_buildings/MapServer/2` is the same
dataset with the full field set:

- **`BUILDING_ID`** — e.g. `Bos_0501412000_B0`
- **`PART_ID`** — e.g. `Bos_0501412000_B0_M2`, which **embeds the BUILDING_ID as a prefix**; the hierarchy is explicit
- `PARCEL_ID`, `ADDRESS_ID`, `PART_ADDRESS`, `PART_FLOORS`
- the same `GROUND_ELEVATION_2010` / `ROOF_ELEVATION_2010` / `BUILDING_HEIGHT_2010` triple
- and `BASE_ELEVATION`, `ELEVATION_SEA_LEVEL`, `TOP_SEA_LEVEL`, `ELEVATION_GROUND_LEVEL`, `TOP_GROUND_LEVEL`,
  all documented by the publisher as **NAVD88**

**Its licence is LEGAL-UNKNOWN.** Its `copyrightText` is a warranty disclaimer, not a grant; no Analyze
Boston record names it. Under the acceptance rule — never infer a Boston dataset's licence from publisher
identity — it therefore **cannot be canonical input**. It is used here exactly as the Northeastern
university layer was: **non-runtime audit evidence, never committed.**

Join to the PDDL parts is geometric (OBJECTIDs do not correspond): **216 of 218 matched** on exact ring-0
vertex-0, all 216 agreeing on the full `*_2010` triple and on `PART_USE`, with 0 disagreements. 189 parts
carry a `BUILDING_ID` (86.7%), resolving to **139 buildings** — **118 of them singletons**.

| ground-truth distribution | parts per building |
|---|---|
| 118 buildings | 1 |
| 10 | 2 |
| 5 | 3 |
| 2 | 4 |
| 1 each | 5, 7 |
| 2 | 8 |

**84.9% of buildings are a single roof-break part.** Stage 1A's "95% share an edge" was therefore *not*
evidence of fragmentation — it was evidence of **party walls**. Conflicts: `PART_ID` has 180 unique values
over 189 parts, so **9 duplicate PART_IDs** exist. 29 parts have no `BUILDING_ID` at all.

---

## D. Authoritative cross-layer join (Phase 3) — MassGIS supplies it

**MassGIS Building Structures (2-D)**, hosted feature layer, item `607d9827695341deb11b44a686b45fa4`,
service `services1.arcgis.com/hGdibHYSPO59RG1h/.../Building_Structures/FeatureServer/0`, modified
2026-05-22, CRS **EPSG:26986**, `copyrightText` **"MassGIS, City of Boston"**.

| measure | value |
|---|---|
| features in bbox | **169** (every one `SOURCE = "City of Boston"`) |
| `STRUCT_ID` | 169 populated, **169 unique** |
| `LOCAL_ID` | 169 populated, **135 unique** |
| **`LOCAL_ID` ∩ City `BUILDING_ID`** | **134 of 140 = 95.7% verbatim** |
| City buildings with no MassGIS structure | **6 of 140 (4.3%)** |
| `LOCAL_ID`s carried by >1 structure | 2 (max **34** roofprints under one City building) |
| multi-ring features | 3 |

**`LOCAL_ID` carries the City's `BUILDING_ID` in the current Boston features.**
**[CORRECTED 2026-09-12 — Stage 1A.2]** stated here as though it were documented semantics. It is not: the
field's only published description is its alias, "Local ID". The durable form separates the two —
*Current Boston features were observed to preserve City `BUILDING_ID` in MassGIS `LOCAL_ID` for 134/140
audited Back Bay buildings and 462/462 audited North End buildings; this Boston-specific behaviour is
empirically verified in the current layer but is not established by the general MassGIS field-description
text.* Also undocumented and found only by defect: `LOCAL_ID` is **whitespace-only** on 34/169 Back Bay and
149/643 North End structures. That converts the identity from
LEGAL-UNKNOWN to a public record that is *"a matter of public record… may be freely redistributed and
integrated into commercial products and applications, including any derivative works"*, credit requested as
**"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"**. The MassGIS
internal-use exception recorded in the acceptance note does not apply to a layer MassGIS hosts publicly, but
that has not been separately confirmed for this layer and is flagged in §Q.

---

## E. Why edge adjacency alone was rejected (Phases 4–5)

**Measured, not assumed.** 215 adjacent pairs; shared boundary min 1.25 m, median 16.28 m, max 288.39 m.

| grouping rule | components | spanning >1 building (**false merge**) | clean | buildings split (**false split**) |
|---|---|---|---|---|
| **union on any shared edge** | 31 | **19** | 8 | 1 |
| no grouping (every part its own building) | 218 | 0 | 189 | 21 |
| **MassGIS `LOCAL_ID` (adopted)** | **131** | **4** | **127** | **0** |

The naive union's largest components swallow **20, 17, 13, 12** distinct buildings respectively. That is the
failure the brief names, and it is not marginal.

**Every PDDL-only signal was tested against the authoritative labels** (173 labelled adjacent pairs — 55
same-building, 118 different-building):

| evidence | same-building | different-building | verdict |
|---|---|---|---|
| shared boundary (m) | median **16.13** | median **16.41** | **no separation** |
| shared / min perimeter | median **0.33** | median **0.33** | **no separation** |
| \|Δ ground elevation\| (ft) | median 0.67 | median 0.46 | no separation, and the wrong way round |
| \|Δ roof elevation\| (ft) | median 8.79 | median 1.83 | wrong way round — a roof break exists *because* the roof changes |

| boolean predicate | precision | recall |
|---|---|---|
| any shared edge | **31.8%** | 100% |
| same `PART_USE` | 47.4% | 100% |
| same `Land_Use` | 46.6% | 100% |
| same `GRND_ELEV_2010` | 85.7% | **10.9%** |
| same ground **and** same roof elevation | 100% | **10.9%** |

**No PDDL-only rule is usable**: the only high-precision predicates catch 6 of 55 true pairs. A geometric
fallback was therefore **tested and rejected**, and the schema emits **no INFERRED grouping**.

---

## F. Grouping algorithm (Phase 4/6)

```
PDDL roof-break part  --[maximum-overlap containment, with an ambiguity margin]-->  MassGIS structure
                                                                                          |
                                                          group by MassGIS LOCAL_ID  <----+
```

Coverage = fraction of a part's vertices inside a structure; score = coverage + 0.5 if the part centroid is
inside. A part is grouped only when the top structure beats the runner-up by **margin ≥ 0.35** *and*
(coverage ≥ 0.50 or centroid inside); otherwise it is **AMBIGUOUS** and left ungrouped.

**The margin rule is load-bearing.** The two layers are different geometry lineages — MassGIS roofprints
were interpreted from 2011–12 imagery and NDSM-shifted; the City parts are roof-break polygons — so overlap
is genuinely partial: coverage median **0.47**, only 14 parts ≥ 0.90. Without the margin, straddling parts
are forced into whichever structure scores higher, which is precisely how adjacent Newbury Street houses
merge. Adding it moved false splits 2 → **0** and part-level identity accuracy 93.1% → **94.4%**.

---

## G. Party-wall test (Phase 5)

Scored against the authoritative `BUILDING_ID`, with an **independent** cross-check on distinct
`PART_ADDRESS` within a group.

| | result |
|---|---|
| parts grouped | 202 of 218 (16 AMBIGUOUS) |
| part-level identity correct | **169 of 179 = 94.4%** |
| groups | 131 |
| **false merges** | **4** |
| **false splits** | **0** of 136 |
| groups containing >1 distinct street address | **4 of 131** — the same 4, independently |

The four false merges are adjacent Back Bay rowhouses: `230+232 NEWBURY`, `208+214 NEWBURY`,
`226+228 NEWBURY`, and one Boylston pair.

**Attribution.** For `230 NEWBURY`, `226 NEWBURY` and `208 NEWBURY`, the City has a distinct `BUILDING_ID`
but **MassGIS holds no structure carrying it**: 6 of 140 City building ids have no MassGIS counterpart, so
the parts of a missing building fall into the neighbour's structure.

**[CORRECTED 2026-09-12 — Stage 1A.2]** This section called that "a parent-layer coverage gap, not a defect
in the containment rule", and concluded that "with complete parent coverage the method would be essentially
correct". **Both are too strong and are narrowed.** Measured in Stage 1A.2: for all three cases the MassGIS
structure area equals the **sum** of the two City buildings' part areas to a ratio of **exactly 1.00** —
MassGIS draws one roofprint over two City buildings. The correct classification is a
**SOURCE-LEVEL BUILDING-DELINEATION DISAGREEMENT**, surfacing as a
**source-coverage-triggered grouping failure mode**. It is not recoverable from either source, and North End
shows the same disagreement running the other way as false splits. See
`GIS_HYBRID_WORLD_STAGE1A2_COVERAGE_SAFE_TRANSFER_2026-09-12.md` §D.

No case merged an entire row: the largest false merge joins two houses. The brief's explicit FAIL trigger is
not met.

---

## H. Building units and validation (Phase 7)

| | |
|---|---|
| roof parts input | **218** |
| **building units output** | **147** |
| by basis | 131 `massgis-local-id`, 16 `ungrouped-ambiguous` |
| **singletons** | **126** |
| **multi-part** | **21** (distribution: 11×2, 3×3, 3×4, 1×5, 2×8, 1×28) |
| multipart geometry (interior rings) | 5 |
| parts preserved | **218 — every part in exactly one unit** |
| non-finite boundary coords / zero-area units | **0 / 0** |
| units with an open boundary | **0** — every dissolved boundary closes |
| source area conserved | **yes**, to < 0.05 m² total |
| invalid dissolves / rejected groupings | **0 / 0** |
| **validation result** | **PASS**, 0 failures, 0 warnings |

**Dissolve method:** a building's boundary is its parts' edges minus every edge shared with a sibling *of the
same building*. No polygon-union library, no invented geometry. Internal roof-break seams vanish; **party
walls and courtyards survive**, because a party wall is shared with a *different* building and is therefore
never cancelled. The 28-part unit is legitimate: MassGIS carries 34 roofprints under that one City
`LOCAL_ID`.

---

## I. Height semantics (Phase 8)

**No building height is collapsed.** Each unit carries `heightM: {min, max, n}` as a **range**, plus
`heightsByPartFt` preserving every constituent part's own `heightFt`, `groundElevFt` and `roofElevFt` in
source feet. A stepped building stays stepped in the data model. `BLDG_HGT_2010` is renamed in the schema's
intent: it is a **part** height, and the source's field name is misleading.

---

## J. Vertical datum (Phase 9) — partly resolved

**Resolved:** the City's `DOIT_buildings` service documents, verbatim, `BASE_ELEVATION`,
`ELEVATION_SEA_LEVEL`, `TOP_SEA_LEVEL`, `ELEVATION_GROUND_LEVEL` and `TOP_GROUND_LEVEL` as **NAVD88**,
one decimal place. That is orthometric, and it is publisher documentation rather than inference.

**Still unresolved, and it is the fields that matter:** those five NAVD88 fields are **not present in the
PDDL layer**. The fields Stage 1A actually consumes — `GRND_ELEV_2010`, `ROOF_ELEV_2010`, `BLDG_HGT_2010` —
carry **no stated vertical reference anywhere**, and the `*_2010` naming suggests a different epoch from the
NAVD88 fields. Units are feet; whether the `_2010` elevations share the NAVD88 reference is **not
established**.

Status: **VERTICAL-DATUM-PARTLY-RESOLVED.** Known: NAVD88 applies to the five documented fields on a
LEGAL-UNKNOWN service. Unknown: the datum of the three PDDL fields, and their relationship to Boston's
sea-level-zero convention. **No elevation was transformed.** Height *differences* remain datum-independent
and usable; absolute elevations do not.

---

## K. M1 at both levels (Phase 10)

| level | definition | result |
|---|---|---|
| **ROOF PART** | `roof − ground ≡ height` per part | **192 of 193 = 99.48%**; one failure, `bos-rb-676270`, Δ **8.259 ft**. Unchanged from Stage 1A and **not hidden** |
| **BUILDING** | a unit is consistent when **every** constituent part satisfies the identity | **141 of 142 units with elevations = 99.30%**; the single inconsistent part propagates to exactly one unit |

The definition necessarily changes at building level — the identity is a part property, so at building level
it becomes an all-parts conjunction. Both are reported; neither replaces the other. **Grouping does not
repair the source inconsistency, and must not appear to.**

---

## L. M2 at building level (Phase 11)

Same accepted definition, same occlusion-ray street-facing test as Stage 1A. Only the unit changed.

| bucket | building level | part level (Stage 1A) |
|---|---|---|
| PRIMARY | **44** | 67 |
| CORNER | **32** | 45 |
| UNMATCHED | **57** | 89 |
| outside box | 14 | 17 |

| distribution | N | min | p10 | p25 | median | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|---|---|---|
| PRIMARY signed | 44 | −8.39 | −5.75 | −3.26 | **+12.77** | 17.34 | 19.56 | 43.42 | 9.42 |
| **PRIMARY abs** | 44 | 0.19 | 3.26 | 5.33 | **12.77** | 17.34 | 19.56 | 43.42 | 12.52 |
| PRIMARY excl. Commonwealth, signed | 26 | −8.39 | −5.96 | −5.33 | **−2.93** | 6.99 | 17.25 | 43.42 | 4.24 |
| **PRIMARY excl. Commonwealth, abs** | 26 | 0.19 | 2.93 | 4.66 | **5.68** | 8.30 | 17.25 | 43.42 | 9.49 |
| CORNER abs | 32 | 0.97 | 2.60 | 3.72 | **7.81** | 8.66 | 17.89 | 42.17 | 9.12 |

Per street (PRIMARY, signed median): Commonwealth Outbound **+17.32** (n=18) · Boylston **+5.67** (n=4) ·
Fairfield **+4.86** (n=7) · Newbury **−4.66** (n=12) · Exeter −8.39 (n=1) · Ring Road +2.78 (n=2).

### Comparison to Stage 1A (Phase 11 requirement)

| | part level | building level | change |
|---|---|---|---|
| abs median, all | **12.81 m** | **12.77 m** | −0.04 m |
| abs median, excl. Commonwealth | **6.52 m** | **5.68 m** | −0.84 m |

**Grouping does not materially change the conclusion.** That is itself the finding: Stage 1A's displacement
result was **not an artefact of the roof-part unit**, and it survives building-level reconstruction intact.
No grouping rule was tuned to improve M2.

---

## M. M3 at building level (Phase 12)

Translation only. No rotation, no scale, no warp.

| | part level | building level |
|---|---|---|
| dx | +6.650 m | **−6.232 m** |
| dz | −11.304 m | **−7.188 m** |
| magnitude | 13.115 m | **9.514 m** |
| front-rank n | 59 | 39 |
| residual abs median | **8.59 m** | **8.36 m** |

**The systematic result survives.** A single rigid translation still absorbs only about a third of the
displacement (12.77 → 8.36 abs median), so the block remains **not merely offset**.

**[CORRECTED 2026-09-12 — Stage 1A.2]** The fitted vector reverses sign in x between the two levels. It is
**sensitive to match population and unit definition and must not be presented as a stable physical offset.**
The durable conclusion is narrower: *removing one rigid translation leaves a residual median of about
8.4–8.6 m in the measured Back Bay samples, so the discrepancy is not explained solely by one block-wide
translation.*

---

## N. Unmatched transition (Phase 13) — the central disappointment

Counted in **parts**, so the two levels are comparable.

| part-level bucket | n | → PRIMARY | → CORNER | → UNMATCHED (no frontage) | → UNMATCHED (interior) | → outside |
|---|---|---|---|---|---|---|
| PRIMARY | 67 | 47 | 4 | **16** | — | — |
| CORNER | 45 | — | 39 | **6** | — | — |
| UNMATCHED — no parcel frontage | 64 | — | **7** | 57 | — | — |
| UNMATCHED — interior | 25 | — | **4** | 3 | 15 | 3 |
| outside box | 17 | — | 1 | 2 | — | 14 |

- **Of 89 part-level unmatched, only 14 (15.7%) became matched.**
- **22 previously matched parts became unmatched** (16 from PRIMARY, 6 from CORNER) — dissolving removes the
  seam edges that were facing a street, so a part that fronted an alley through a sibling's gap no longer does.

**Grouping was not the fix.** The dominant cause — `no-parcel-frontage`, 64 → 57 — is a property of the
**current world**, not of the source unit: `RoadNetwork.buildPlots` grants no frontage to `alley` edges, and
Public Alleys 435 and 442 run through this block. No amount of building reconstruction creates a streetwall
where Boston never built one. This was the hypothesis Stage 1A's R1 rested on, and it is **not supported**.

---

## O. Commonwealth Avenue (Phase 14) — attributed, not solved

**Cause: the current road representation, dominantly.** Boston models Commonwealth Avenue as **two separate
one-way `street` edges** (`Inbound`, `Outbound`), each `lanes 2`, `halfRoad 5.90`, `walk 2.70`, giving
`corridorHalf 8.76` and a modelled width of 17.5 m per carriageway. Commonwealth Avenue is a boulevard with
a central mall and a right-of-way several times that. A building's frontage is therefore measured against
**one carriageway's** centreline, which is not the same quantity as on an undivided street.

The signature confirms it: all **18** Commonwealth primary units are **positive**, tightly clustered
(12.77–20.79, p25 14.30, p75 17.97). That is a systematic representation difference, not scattered error.
Excluding it moves the abs median from 12.77 m to **5.68 m**.

Not a building-geometry problem, not a matching-logic problem. **No road was modified and Commonwealth
Avenue was not solved** — only attributed well enough to stop it biasing the building decision.

---

## P. Sidewalk source status (Phase 15)

Unchanged from Stage 1A and **not extended**: City of Boston **Sidewalk Inventory**, polygon, EPSG:2249,
**68 polygons** in the bbox, **PDDL**, **2014** PWD survey, geometry quality **unassessed**.

The accepted precedence matrix entry moves from **NO IDENTIFIED SOURCE** to **AUTHORITATIVE CANDIDATE FOUND
— QUALITY / VINTAGE FITNESS UNVALIDATED**. It was not normalized. Existing is not the same as fit, and a
2014 layer is not promoted to canonical production input merely because it exists.

---

## Q. Artifacts, determinism, fixture (Phases 16–17)

`research/gis-stage1a1/` — `README.md`, `schema-v0.1-building-candidate.json`, `building-fixture.json`,
`validation-report.json`, `metrics-report.json`, and five deterministic scripts. `cache/` gitignored.

**Determinism: byte-identical across three consecutive runs**, fixture sha256 `c7e043f2dc34fc7e…`, metrics
`9eee8694c231d433…`. Unit ids, part ordering, grouping classifications, polygons and report statistics are
all stable; ArcGIS response ordering is canonicalised by sorting on source id before output.

**Fixture: `building-fixture.json`, 31.1 KiB, 7 selected cases**, each with every constituent part preserved
verbatim — the 28-part unit, an 8-part unit, a 3-part unit, a singleton with an authoritative parent, an
**AMBIGUOUS** straddle left deliberately ungrouped, a multipart geometry with an interior ring, and adjacent
Newbury Street party-wall neighbours kept separate. The Stage 1A fixture is **unchanged**; Stage 1A.1 is
additive and removable with `rm -rf research/gis-stage1a1`.

---

## R. Corrected datum wording (First Correction)

The Stage 1A report described the constant 0.971 m offset as isolating the "NAD83 → WGS84 datum shift".
**Withdrawn.** The exact geographic transformation ArcGIS applied was **not pinned** — the service publishes
no transformation metadata — and a constant difference between the server result and an independent inverse
projection does not establish which operation produced it. The narrow correction is applied on top of
`c673135`, not by amendment, and the durable wording is now:

> Observed constant offset between the ArcGIS EPSG:4326 transformation and the independent
> inverse-projection result; likely attributable to datum / geographic-transformation choice, exact
> transformation not yet pinned.

What survives unchanged: constant to 0.03 mm across 4,575 vertices, essentially all northing, present in
every fixture coordinate, and smaller than every other measured quantity. **No coordinate system changed.**

---

## S. Verdict and remaining blockers

# PARTIAL

**Met:** defensible, non-heuristic building identity · false-merge/false-split behaviour far better than any
alternative tested (4 and 0, against 19 and 1 for naive union) · deterministic fixture · all 218 source parts
preserved · M1/M2/M3 rerun at building level · no fundamental horizontal schema blocker.

**Not met:** 4 residual party-wall false merges · 16 AMBIGUOUS parts · vertical datum unresolved for the
fields actually consumed · and the unmatched population barely moved.

**Remaining blockers, exactly:**

| # | blocker | severity |
|---|---|---|
| B1 | **MassGIS lacks a structure for 6 of 140 City buildings (4.3%)**, which causes every residual false merge | **High** — bounds achievable accuracy |
| B2 | **The richest identity source (`DOIT_buildings`: `BUILDING_ID`, `PART_ADDRESS`, `PART_FLOORS`, NAVD88 elevations) is LEGAL-UNKNOWN** and cannot be canonical input without an Owner licensing review | **High** |
| B3 | **Vertical datum unresolved for `GRND_ELEV_2010` / `ROOF_ELEV_2010`**; NAVD88 is documented only for fields absent from the PDDL layer | **High for any future Y integration** |
| B4 | **57 units remain unmatched, 43 for no-parcel-frontage** — a current-world property (`buildPlots` grants no frontage to alleys), not fixable by grouping | Medium |
| B5 | Containment coverage is noisy (median 0.47) because the two layers are different geometry lineages | Medium |
| B6 | 9 duplicate `PART_ID`s and 29 parts with no `BUILDING_ID` in the audit source | Low |
| B7 | MassGIS internal-use licence exception not separately confirmed **for this layer** | Low — **CLOSED 2026-09-12 (Stage 1A.2 §B)**: layer published by MassGIS with download links, no layer-specific override found; residual is that the layer credits the contractor Rolta and mass.gov blocks automated retrieval |

---

## T. Stage 1B — should be CONSIDERED, not authorised

**This report does not authorise Stage 1B and none was begun.**

Stage 1B is now *technically* unblocked: there is a defensible building unit, it is deterministic, and it
preserves its parts. Two things should be settled first, and neither needs runtime work:

1. **B2, the licensing question**, because it decides whether the richer City identity can ever be used or
   whether MassGIS `LOCAL_ID` is the permanent ceiling — and MassGIS's 4.3% coverage gap is the thing
   capping accuracy.
2. **B1**, whether the 6 missing structures are a Back Bay accident or a systematic MassGIS property. That is
   one bounded query in a second neighbourhood.

If Stage 1B is later authorised, it should draw **dissolved building units**, not raw parts, and should
exclude Commonwealth Avenue from the visual comparison or give it its own rule (§O).

---

*Stage 1A.1. Research only. No runtime change, no dependency, no `src/` modification, no WebGL.
Stage 1B not begun.*
