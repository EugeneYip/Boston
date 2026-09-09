# Current vs real — Northeastern hero district

Measurements from `tools/neu-audit/build.mjs`; the machine-readable form is in
`GAPS.json`.

> **Wave 0 landed 2026-09-07** (`659691a`). The numbers below are LIVE — re-running
> the audit measures the corrected world, so the street-deviation and coverage
> figures are post-Wave-0. The before/after is recorded in §0; the original audit
> baseline is preserved there and nowhere else.

## 0. Wave 0 — what changed, measured

Roads from **MassGIS-MassDOT Roads**, the campus district from **MassGIS
Massachusetts Property Tax Parcels**. Both are public domain: *"This GIS web
service is a public resource and may be used by anyone for their purposes."*
That licence is the reason they, and not OpenStreetMap, are the runtime source —
OSM is ODbL and share-alike would attach to `src/data/boston-geo.js` if its
geometry were copied in. OSM stayed a cross-check, and every figure in the
"after" column below is measured against **OSM**, i.e. against a source that had
no part in producing the geometry.

### Street centreline error, against OSM

| street | before | after | note |
|---|---|---|---|
| Huntington Avenue | median **107.6 m**, p90 149.1, max 157.3 | median **6.0 m**, p90 9.8, max 11.1 | the 6 m residual is the half-median offset to the nearest carriageway, not error |
| Columbus Avenue | median **89.5 m**, p90 96.6, max 97.3 | median **2.4 m**, p90 14.8, max 19.9 | also extended 540 m to the Ruggles frontage |
| Massachusetts Avenue | median 95.3 m | unchanged | not in scope |
| Tremont Street | median 37.5 m | unchanged | not in scope |

Measured against the MassGIS centreline the corrected Huntington sits **0.8 m**
median through the hero core (p90 2.9, max 5.7).

### Campus road coverage, over the OSM campus polygon

| | before | after |
|---|---|---|
| median distance to any game road | 182 m | **58.8 m** |
| within 40 m | 10.9 % | **35.7 %** |
| within 100 m | 27.3 % | **74.8 %** |
| within 200 m | 55.2 % | **99.2 %** |
| within 300 m | 77.2 % | **100 %** |

Named streets in the envelope: **7 → 10** of the 247 that really exist. The point
was never to import all 247; it was to stop the campus being unreachable.

### District identity

| | before | after |
|---|---|---|
| audit probe points returning `district: null` | **6 / 8** | **1 / 8** |
| that one | — | Ruggles station, correctly outside the campus (MBTA land) |
| buildings resolving under campus rules | 0 | **67 / 71** |
| brownstones inside the campus | most of them | **1** |
| parcels inside the two reservations | — | **0** |

The ring is the outline of the university's own COLLEGE-use tax parcels, closed
across internal service streets and reduced to its largest connected component:
29.2 ha, **96.3 % of it inside the campus polygon OSM publishes independently**.
It excludes Ruggles station and Carter Playground, which is right — those are
MBTA and city land, and the exclusions are a good sign the boundary is following
ownership rather than a drawn guess.

### Topology

Huntington now carries **9 junctions** where it carried 4, and every one of the
four it had is preserved. The Massachusetts Avenue crossing moved to within 7 m
of the real Symphony junction. All five Wave-0 streets sit entirely inside the
main 385-node component; the campus routes to downtown in 9 hops. The remaining
dead ends are genuine street termini.

### What Wave 0 did NOT do

No building massing — the height gate is unchanged and unresolved. No transit.
No public realm. No spawn move. Terrain untouched.

**One defect was made visible and is not fixed here.** Seven `waterWall` decals
hang 31–46 m in the air over the campus with no wall behind them. The cause is
that `Props.js:921` builds decal frontages from PARCELS using the zoning height
cap, and `Decals.js:997` hangs the stain from that cap — but 666 of 10,897
parcels carry no building at all. The bug is latent everywhere (the cap is not
the binding height constraint in any district); Wave 0's new frontage is what
made instances of it visible. Fixing it means teaching Props about built heights,
which is a Props change and not Wave 0's to make.

## 0b. Wave 1A — Ruggles, the public-realm licence gate, and the height gate

### Ruggles Street

| | before (Wave 0, rejected) | after |
|---|---|---|
| vs MassGIS raw | max **46 m** | median **0.5 m**, p90 1.2, max 1.5 |
| vs OSM (independent) | — | median 1.2 m, p90 3.3, max 3.8 |
| vertices | — | 5, max turn 15.6° |

Wave 0 blamed the street; the fault was the extractor. MassGIS publishes Ruggles
as 19 segments that chain end-to-end exactly, so an endpoint walk reproduces it —
no fitting, no principal axis, no carriageway pairing. It is **not divided**:
`OPP_LANES` and `MED_WIDTH` are 0 throughout.

The 94 m "gap" between its two runs is **Tremont Street**. Ruggles meets Tremont,
and its continuation leaves Tremont 94 m further along — a staggered crossing.
Only the Huntington-to-Tremont run is committed; it crosses the corrected
Huntington at (−2468, 1968), taking Huntington from 9 junctions to 10. The 642 m
east of Tremont is held back because its real junction is missing from the game
and it would instead snap to Columbus Avenue 20.2 m away, inventing a junction.

Campus road coverage within 40 m: **35.7% → 39.5%**; within 200 m now **100%**.
Named streets in the envelope 10 → 11.

### Public-realm source — gate cleared, import deferred

**Northeastern's ArcGIS is settled and the answer is no.** Every licence field is
empty at item and service level, and the university's published copyright policy
is permission-required. Absence of a stated restriction is not a grant.

**The City of Boston publishes what is needed, under PDDL** — a public-domain
dedication. Sidewalk Centerline carries `PWALK-CL` private walks: **4,914 m of
campus interior path inside the district, plus 5,928 m of sidewalk**, all public
domain. The licence question is therefore answered, and answered well.

**The import is still deferred, for a reason the brief could not have known.**
The campus currently holds ~70 *procedurally generated* buildings that do not
correspond to real ones. Importing real 2011 path geometry now would route real
paths through fake buildings, and every path that landed correctly would do so by
accident. **Paths and real footprints have to arrive together** — the constraint
is sequencing, not licensing. That is a Wave 2/3 job, and the source is now
banked for it.

Krentzman and Centennial therefore **stay reserve-only**, which is what the brief
asks for when precise geometry is blocked. Nothing was replaced by a guess.

### Height gate

See **HEIGHT_GATE.md**. In short: Hero-A is 14 corroborated / 11 inferred-only /
6 contradicted, and the eleven inferred are the Krentzman arrival quadrangle —
the evidence is inversely distributed against need. **Wave 2 may open for Hero-B
and not for Hero-A.**

### Ruggles rail cut — measured, still not modelled

An 18-point USGS 3DEP transect at 18 m spacing across the Southwest Corridor at
Ruggles resolves the cut that Wave 0's sparser sampling missed: a local minimum
of **0.58 m** against a surrounding grade of 3.0–4.6 m, i.e. a cut roughly
**2.5–4.0 m below adjacent grade**, with a 6.79 m reading 35 m away that is
structure rather than ground. Confidence **D** — one transect, one 1 m DEM, no
datum reconciliation. Enough to say the cut is real and roughly how deep;
**not** enough to model terrain from, and terrain stays closed.

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
| Street geography | **PARTIAL** (was MISSING) | 5 | 5 | 5 | 5 | 2 | **313** | Wave 0: 7 → 10 named streets, campus coverage within 40 m 10.9 % → 35.7 %. The campus-edge and spine streets exist; the interior service network does not. |
| Campus public realm | **MISSING** | 5 | 5 | 5 | 3 | 2 | **188** | 16.1 km of footway, 39 stair runs, 9 named greens. This *is* the campus at eye level. |
| Huntington Ave alignment | **CORRECT ENOUGH** (was WRONG) | 5 | 5 | 4 | 4 | 2 | — | Wave 0: median 107.6 m → 6.0 m against OSM, 0.8 m against MassGIS through the hero core. |
| Building footprints | **MISSING** | 5 | 4 | 4 | 4 | 2 | **160** | 104 official footprints available at confidence A. |
| District identity | **CORRECT ENOUGH** (was WRONG) | 3 | 3 | 5 | 5 | 1 | — | Wave 0: probe nulls 6/8 → 1/8, brownstones inside the campus → 1. |
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

| # | gate | status after Wave 2C (`641f8cc`) |
|---|---|---|
| 1 | real geography established in the envelope | **PASS** — Wave 0/1A |
| 2 | major roads correct, Huntington offset under ~10 m | **PASS** — 0.8 m from the MassGIS centreline |
| 3 | key campus building massing credible | **PARTIAL** (re-scored 2026-09-09) — 18 survey-derived volumes with sub-metre height validation, but Ell (1947) and Curry (1964) share ONE flat 5,970 m² / 16 m extrusion, and no modelled volume exceeds 27.8 m while East Village (2014, 17 storeys, ~60 m) stands 138 m from the opening. Massing is credible; it is not yet correct. |
| 4 | key campus public realm credible | **PARTIAL** (re-scored 2026-09-09) — traversable and correct as ground, but Krentzman is a regular 56 × 56 m octagon rather than the axial court open to Huntington; there is no seal ledge at the quad head, no building entrance anywhere in the district, and no rail transit at all (`TRANSIT.json`: `railStations 0, railAlignments 0, surfaceTrolley false`) although the Green Line E "Northeastern University" surface station sits **24 m from the spawn** at confidence A. Original 3B text: **PASS** (`c9bf5b0`) — Krentzman is a mown quadrangle with stone circulation, furniture and specimen trees, surrounded by ~20,000 m2 of maintained campus ground that abuts the octagon on all eight bearings, with 163 m of PDDL survey path from the Huntington footway into the quad. Rendered and traversed: 0 ungrounded frames, 14 mm max snap, no road intrusion, 4.0 ms. Caveat: the ground has a finite outer boundary, so a lawn-to-terrain transition still exists where it ends. |
| 5 | eye-level visual audit passes | **FAIL** (re-scored 2026-09-09, owner rejection) — it reads as *an* institutional campus, which is what the 3A wording claimed and all it ever established. It does not read as **Northeastern**. The 1938–56 front-quadrangle family is documented as light grey brick punctured by vertical strips of windows; the game renders it as red brick with punched square windows from one shared composition. See "ARCHITECTURAL FIDELITY" below. |
| 6 | player pedestrian access passes | **PASS** — 0 ungrounded frames, no walk-through, no ghost colliders, 8/8 bearings clear inside the quad; max vertical snap 12 mm on the new ground plane, 0.45 m at the real Huntington kerb |
| 7 | vehicle access passes | **PASS / MIGRATED** (`5c5e349`) — from a cold production boot, no teleport: hold forward, 35.89 m of path in 11.47 s, 688 grounded frames and **zero ungrounded**, 18 mm max snap, a continuous 0.996 m climb up the corrected verge, `ground` → `pavement` at t=10.0 s, ending 3.49 m from the car. Then F-enter, 0.000 m drift while seated, 18.86 m at 23.1 km/h with zero off-road frames, four wheels throughout, 1.4° peak pitch, no high-centring, no damage, F-exit back onto the pavement. |
| 8 | SUV placement passes | **PASS / MIGRATED** (`5c5e349`) — derived by the production solver from `OPENING_SUV_ANCHOR`, not pasted. Lands 2.80 m off the anchor at (−1856.164, 3.808, 1649.222) on edge 486 segment 9; lateral 8.55 m against a parking offset of exactly 8.55, surface `road`, heading 2.0675 against tangent 2.0675 (error 0.00°, dot 1.0000), four wheels, zero damage, 0.000 m drift over 3 s, 8.93 m clear of the nearest No Parking plate. Exactly one #f07318. |
| 9 | opening camera composition passes | **PASS / MIGRATED** (`5c5e349`) — rig yaw −2.007 gives forward (0.9064, 0.4225), bearing **65.01°**. The production first frame — no `setCamera` override — carries the quadrangle, its stone walks, benches, specimen trees and the hero brick range. One 71.0° turn puts the SUV at NDC **(−0.010, +0.242)**, dead centre, all four footprint corners on screen, and the only thing the sight line hits is the car's own collider. |

Wave 2C moved **3 and 6 to PASS** and **5 to PARTIAL**, and left 4 untouched
because a factual path on bare ground has to be distorted to read as anything.

Wave 3A was asked to advance **4, 5, 6 and 9**. It moved **5 to PASS** (fenestration
and a quadrangle floor), confirmed **6 at PASS** on the new ground plane, moved
**4 from NOT STARTED to PARTIAL** (Krentzman has lawn, stone circulation, trees
and furniture), and improved **9 within PARTIAL** without closing it.

Wave 3B was asked to move **4 to PASS** and strengthen **7, 8, 9**. It built the
work for 4 and strengthened 7 and 8 with corrected arithmetic, but **it could not
verify anything**: two sibling agents held the WebGL lane for the whole session and
swap ran 5.0-6.1 GB of a swapfile that grew to 7 GB, so a third browser context
was not opened. Gate 4 therefore stays PARTIAL.

**Still do not migrate, and the reason is now different.** The hard mown/dirt line
and the missing arrival path have been ADDRESSED IN CODE but never rendered. A
reviewer would be looking at unverified geometry. Entrance cues still do not exist.

Wave 3B's acceptance session ran on a free lane and **PASSED**, moving gate 4 to
PASS and improving 9 within PARTIAL. Two narrow corrections were needed: the road
keep-out was leaking ground onto the Huntington footway, and the ground contour
overshot at its elongated extremes.

## ARCHITECTURAL FIDELITY — SEPARATE FROM, AND BEHIND, THE TECHNICAL OPENING (2026-09-09)

The two things are not the same gate and must not be reported as one.

| | verdict |
|---|---|
| **Technical / gameplay opening** | **PASS** — live, and not to be rolled back |
| **Hero massing fidelity** | **PARTIAL** |
| **Public-realm fidelity** | **PARTIAL** |
| **Eye-level architectural likeness** | **FAIL** |

The opening works. Spawn, bearing, SUV, pedestrian and vehicle access, and the
verge crossing are all correct and measured. What fails is *likeness*: a person
who knows Northeastern would not recognise this place.

### What the sources say the front quadrangle is

The 1934 competition campus was designed by **Coolidge, Shepley, Bulfinch and
Abbott**. Richards Hall (1937–38) was the first building, and it is documented as
**light grey brick punctured by vertical strips of windows** — the point at which
"Beaux-Arts bulk and ornamentation had been replaced by Bauhaus surface effect and
choice of color". That treatment was then **replicated in Dodge Library, Hayden
Hall, Hurtig Hall, Mugar Sciences Building and Churchill Hall**, and the campus
"became a campus of grey brick, courtyards, gathering spaces, and axial symmetry".
Northeastern's own Architecture Program Report records Richards as Shepley,
Bulfinch, Richardson and Abbott, 1938, the first building on the front quadrangle,
in what became the campus **signature white brick**.

### What the game had before Wave A

Red brick and punched square windows, from one shared composition:

- `NeuHero.ERA[0].body = 'brick_red'`, `COL.brick_red = [0.74, 0.46, 0.38]`, applied
  to **every** pre-1960 hero building — the entire quadrangle.
- `TYPO.collegiate` — `bayW 2.95, winW 1.34, winH 2.18` — discrete punched openings,
  and its own comment says "deliberately ONE composition".
- `Facades.frontStorey` caps window height at `hgt - 0.95`, so a continuous
  vertical band is not expressible through it at all.

### The rest of the fidelity gap, measured

- **Coverage.** 103 buildings inventoried, 12 modelled. **47 are absent within 320 m
  of the opening**, including three near the view axis — Hurtig (8° off), Robinson
  (13°), Cullinane (17°) — and Snell Library (1990, 4,589 m², the largest missing
  footprint nearby).
- **Opening frame.** Only **three parts** fall inside the 62° FOV: Dodge, Mugar and
  one unnamed secondary. The Wave 4A claim that the first frame "carries six hero
  buildings" is superseded by that measurement.
- **Skyline.** Everything modelled is 16–21 m except Hastings at 27.8 m.

### WAVE A — DONE (2026-09-09, `110c6fc`)

The front-quadrangle family is now light grey glazed brick with vertical window
strips. `Facades.pierStorey` builds it the way the building is built — brick piers
at the wall plane, a 0.24 m recessed channel between them carrying the glazing and
its spandrels, nothing crossing the channel, so stacked storeys leave an unbroken
vertical line from plinth to cornice. `frontStorey` could never express it: it
caps the opening at `hgt - 0.95` and always leaves a metre of solid between head
and sill.

Applied by NAME — `NEU_HISTORIC` = Richards, Dodge, Hayden, Mugar (all on the
source's replicated list) plus **Ell at lower confidence** (a 1945–47 quadrangle
building of the same programme, not named in that list). A date rule would have
swept in Hastings and Ryder (1913) and Cabot (1954); those keep red brick, which is
what stops the quad becoming one grey material and is visible as the red Hastings
link beside grey Dodge.

| | before | after |
|---|---|---|
| hero triangles | 102,306 | **92,742** (−9.3%) |
| hero draw calls | 4 | **4** |
| glass triangles | 10,922 | 10,454 |
| colliders | 1,776 tris | 1,776 tris |
| new materials / textures / SURF layers | — | **none** (`brick_painted` + `limestone` already existed) |

Not clones: bay width comes from each building's own recorded course — Ell 4.00 m
over 4 storeys, Mugar 3.78 over 5, Richards 3.73, Hayden 3.71, Dodge 3.69 — giving
bays of 3.22–3.52 m, a 9.3% spread, with Ell reading four tall storeys against the
others' five.

Exposure measured, not eyeballed: near-clipping pixel fraction on a close Richards
facade is 0.011 at 14:30 and **0.006 at noon** — lower at noon, so the light
masonry does not blow out. Night keeps window light (peak −0.14); rain reads as wet
glazed brick.

**Curry is not addressed and could not be here.** It shares Ell's source part, the
boundary is not in the data, and the earliest-year rule resolves the part to Ell.
Curry's 1964 identity is absent and waits on the primary-volume wave.

### WAVE B — PARTIAL (2026-09-09, `979ce0c`, `d445599`)

**The Green Line was not built, and the reason is structural.** MassGIS models
Huntington as two directional carriageways either side of a median that widens to
48 ft across the campus — that median *is* the E reservation — and the game's
centreline is the corridor centre, the average of the pair. **The modelled
carriageway is drawn on top of the real reservation.** There is no median concept
in the road system, and `halfRoad` is derived from lane count, so freeing ~7 m of
median moves the kerb line in 3.5 m and takes the footway, the graded W_VERGE
crossing and the SUV's parking lane with it. Laying track anyway would put rails
at offsets −3.5…+3.5 with the four travelled lanes centred at −5.25, −1.75, +1.75
and +5.25: traffic driving down the reservation.

The factual geometry is now committed in `docs/neu/GREEN_LINE_E.json` — station
`place-nuniv` at (−1904.9, 1667.5), **23.9 m from the spawn**, two staggered side
platforms (70243 outbound, 70244 inbound) 90.6 m apart, route colour `#00843D`, all
confidence A from the MBTA V3 API. **Correction:** the earlier claim that
alignment data was "already in the repo" was wrong — `TRANSIT.json` holds way
counts, not geometry, and what it counted was ODbL OSM.

**Hurtig Hall was added** (19.57 m, 1,505 m², PDDL `OBJECTID 661069`, CONFIRMED)
but **it does not improve the opening**: all 42 sample points across its outline
fall inside the opening frustum and **zero are unoccluded** — Mugar and Dodge hide
it completely at 206 m. It was promoted on a bearing argument that was never
raycast. It closes the campus interior to the east; that is all.

It is `research`, **not** `neuHistoric`: the only Tier-A date (Northeastern's own
facilities record) says **1968**, thirty years after Richards and outside the 1944
master plan, while the SAH attribution is hedged ("appear to have replicated") and
unverifiable at source. One line in `TYPO_OF` to overrule.

| | before | after |
|---|---|---|
| hero parts | 18 | **19** |
| hero triangles | 92,742 | **96,996** |
| hero draw calls | 4 | **4** |
| colliders | 18 / 1,776 tris | 19 / 1,834 tris |

Canonical opening and first-minute smoke unchanged: 71.0° turn, 35.89 m in 11.47 s,
0 ungrounded frames, 18 mm snap, 0.996 m climb, F-enter, 13.46 m at 20.5 km/h with
0 off-road frames, F-exit onto pavement. Traffic 62 cars, 19/25 moving.

### WAVE B2A — HUNTINGTON RESERVED-MEDIAN ROAD CONTRACT CLOSED (2026-09-09, `8f57c2f`, `0f10c8f`)

**Green Line infrastructure is now unblocked.** The road contract the last mission
diagnosed as missing exists: a street may reserve a central median, the outer
corridor is held by `halfRoad`, and lanes are allocated inside it.

Huntington edges **486, 487, 488** carry a **7.0 m** reservation from the portal
vertex (−1811, 1615) west; the other **530** edges in the city carry none.

| | before | after |
|---|---|---|
| halfRoad | 9.80 m | **9.80 m** |
| parking offset | 8.55 m | **8.55 m** |
| lane centres | ±1.75, ±5.25 | **±5.25 only** |
| reservation | — | **\|o\| < 3.5 m** |
| road triangles | 386,377 | 384,865 |
| collider tris / bodies | 47,093 / 47 | **47,093 / 47** |
| live cars inside the reservation | n/a | **0** of 26 |
| starter SUV | (−1856.164, 3.810, 1649.222) | **identical** |
| canonical walk | 35.89 m / 11.47 s / 0 ungrounded | **identical** |

**Width evidence.** The "48 ft median" is a maximum ("widens to"), not the local
width — 14.6 m plus two carriageways plus two footways does not fit a 99 ft right
of way. The local measurement is the MBTA's own platform geometry: inbound 70244
sits **3.45 m** off this centreline, outbound 70243 **4.32 m** the other side, a
**7.77 m** span, and side platforms flank the tracks. Independently, 7.0 m is the
widest reservation that fits inside the frozen 9.80 m halfRoad with the parking bay
intact. The two agree, which is the only reason to trust either.

**Project-authored, stated as such:** the carriageway is represented as **1 travel
lane per direction** rather than the real 2+2, because 2+2 plus a reservation plus
parking does not fit in the 19.6 m the accepted corridor provides. And the
subway/surface boundary resolves to edge granularity — the frontage edge begins
~114 m east of the portal vertex and takes the reservation for its whole length.

**No rail was built** — no track, no platform, no catenary, no vehicle. Gate 4
stays PARTIAL and gate 5 stays FAIL.

### Scope note

Wave A closes the **historic-facade-idiom** subproblem only. **It does not close
gate 5**, which stays FAIL: coverage (47 buildings absent within 320 m), quad form,
entrances and transit are all untouched. Massing, coverage, public realm and
transit remain open and are Waves B–E.

### WAVE B2B / B2C — TRANSIT CLOSED (2026-09-09, `d545165`, `b11c98a`)

Two Green Line tracks and centre-pole catenary over 973 m of the Huntington
reservation, then the two staggered side platforms of the Northeastern University
surface station on a local station section that widens the reservation to 11.20 m
and suspends kerbside parking for 169 m. The cross-section is the MBTA's own
criteria, not authored guesses. See `docs/neu/GREEN_LINE_E.json`.

### WAVE D0 — COVERAGE IS NOT WHAT IS WRONG WITH THE OPENING (2026-09-09)

A rebaseline on the corrected world, and it overturns the coverage plan. Full
data in `docs/neu/COVERAGE_RANKING.json`; no runtime source changed.

**Nothing a player can see is missing.** Twenty-one un-modelled candidates were
tested for real line of sight — 13 sample points each on a box at the recorded
centroid, against all 815 visible scene meshes — from five gameplay viewpoints.
**At the canonical opening every single candidate is 0% unoccluded**, including
Gainsborough Garage and Robinson Hall at 13 of 13 samples *inside the frustum*.
The historic range encloses the view completely. Adding buildings will not change
the first frame.

Across all five gameplay viewpoints only one candidate has real screen presence:
**337 Huntington Avenue, 7 of 13 samples unoccluded and 6.48% of the viewport,
and only from inside the quadrangle looking out.** 335A Huntington manages 0.97%;
the four St. Stephen houses and Robinson are one- or two-sample slivers at 0.00%.
Everything else — Snell Library, East Village, Speare, Marino, Churchill,
Cullinane, Stetson East and West, Forsyth, Knowles, Dockser, Fenway, Snell
Engineering — is **100% occluded from every gameplay viewpoint**.

**The standing list was wrong about its own top pick.** Snell Library was named
as the largest missing footprint nearby, and it is; it is also invisible from all
five viewpoints and only appears from a 60 m diagnostic camera. Footprint size was
never evidence of visibility. This is the Hurtig lesson a second time, and it is
now measured rather than assumed.

**What IS visible and generic**, from the corrected baseline:

- **Skyline.** From a raised view the campus is a field of near-identical
  flat-roofed slabs at 16–21 m with no event anywhere. East Village at 60 m is the
  only tall thing in the inventory and no gameplay viewpoint sees it.
- **Enclosure articulation.** The historic range reads as one continuous flat slab
  — no wing depth, no roofline break, no bay rhythm at massing scale.
- **Ground-floor articulation.** Buildings now meet a correct maintained lawn with
  no plinth, threshold or entrance. The ground fix made this *more* conspicuous,
  not less.

So the next wave should not be a coverage wave. The cheapest real gains are
articulation of what already stands, plus the single building that is actually
visible.

### WAVE C-2C — THE CAMPUS GROUND WAS NEVER DRAWN (2026-09-09, `26cbbb7`)

**This supersedes the conclusion in `dbf9299`.** C-2B decided that C-2's downward
raycast was simply a bad probe and that the world was fine. It was not. The probe
was misleading *because* the geometry was malformed, and the malformation is a
rendering defect.

`NeuHero._buildGround` triangulates with `ShapeUtils`, which works in 2-D with +y
up the page; mapping that y to world z flips the handedness, so a CCW 2-D triangle
comes out **downward-facing** in XZ and is back-face culled. It emitted
`tri[0], tri[1], tri[2]` and pushed a `+Y` normal attribute — which fixes the
lighting and does nothing about the winding, which is exactly why it survived
every check that looked at normals. **`Water.js` and `Districts.js` both already
reverse for this precise reason and both say so in comments.**

Measured, ignoring the stored normal and using `cross(p1−p0, p2−p0)` on actual
indexed positions: **`neu_ground_lawn` 0 up / 25 down**, `neu_ground_paved` 1/23,
against **`park_lawn` 24 up / 1 down**. Proved at raster level with an emissive
magenta tint at a locked camera and clock: ROI mean log-luminance **−4.085 at
FrontSide, −1.539 at DoubleSide**, a 2.55 log-unit jump. A material flag cannot
add geometry.

So the whole campus ground surface — 4,929 triangles across the hero district —
**has never been drawn since Wave 3A added it**, and the "dark mottled ground" I
flagged honestly at the canonical spawn in C-2B was the base terrain 0.02 m below
it. The fix is one line, `tri[0], tri[2], tri[1]`, at zero structural cost.

After: 25/25 faces up, downward ray hits, upward ray correctly misses, hiding the
mesh now moves the ROI by **1.967 log units** where the same test previously sat
below the frame's noise floor, and the canonical first frame shows maintained
campus lawn under the player.

### WAVE C-2B — KRENTZMAN FORM SHIPPED (2026-09-09, `e1fa294`)

The 24-vertex three-sided ring is in production. Krentzman is enclosed by
Richards, Dodge and Ell and open across 110 degrees toward Huntington; the
regular octagon and the arbitrary paved diagonal past the player's feet are gone,
and `districtAt` at the spawn reads `northeastern` instead of `park`.

**Risk B never existed.** C-2 reported no ground mesh under the canonical spawn
and reverted the ring for it. That was an instrument error: the ground triangles
are wound front-face-**down** and all seven ground materials are `FrontSide`, so
C-2's downward raycast hit the back face and `Raycaster` rejected it. The
`park_` meshes are wound the other way, so park surfaces answered and campus
surfaces did not — which reads exactly like a localised hole rather than a broken
probe. `neu_ground_lawn` owns the spawn at terrain **+0.0200 m**, the documented
emit offset, and `_buildGround`'s rule table shows every rule PASSING there.

**No ownership fix was needed.** `NeuHero.js` is byte-identical to `origin/main`.
The two C-2 probes that genuinely have no owner sit inside the Huntington keep-out
and are meant to: one has a corner 13.41 m from the centreline against a 14.76 m
keep radius. The keep-out itself holds to the centimetre — nearest campus-ground
vertex **14.77 m** over 3,512 vertices tested, 1.21 m clear of the city footway.

Cost: **+253 public-realm triangles**, no new draw, material or collider. Transit
and road triangles identical. KCC across the new boundary: 0 ungrounded, 40 mm
peak snap, no step and no seam. The canonical walk still climbs **0.995 m**
against a recorded 0.996.

### WAVE C — AUDIT ONLY, NOTHING SHIPPED (2026-09-09)

Wave C was scoped to correct the campus spatial identity: Krentzman's form, the
quad-facing entrances, and the Ell/Curry split. It ran entirely under its own
resource gate — swap 83–91% for the whole mission, load averages 8 to 59, two
users on the machine — and the gate says *factual/source analysis only, and do not
claim visual acceptance from an unreliable host*. So this wave produced evidence
and changed no runtime geometry. Everything below is in
`docs/neu/FRONT_QUAD.json`, with the derived ring ready to apply.

**Krentzman is the wrong shape, and the shape matters more than the area.** The
runtime is a regular octagon, area-derived about the recorded centre: 8 vertices,
circumradius 30.1 m, **2,564 m²** against the recorded **3,345 m²** — 23% short.
The centre is right to 0.3 m. But the real error is topological: a regular octagon
is closed on all eight sides, and the actual space is **enclosed on three sides
and open across a 100° sector toward Huntington**.

Ray cast from the recorded centre every 10° against the PDDL roof-break faces
within 45 m: **24 of 36 bearings hit a building** — Richards 9, Dodge 8, Ell 7 —
and the gaps are **160°–250°** (100°, flanked by Dodge and Richards, the Huntington
opening) plus two 10° notches. The canonical spawn sits at bearing 219.8° from the
quad centre, in the middle of the principal opening, which is a good sign the
opening was placed on real ground rather than a chosen one.

The derived form is **24 vertices, 3,166 m², −5.4%** against the recorded area,
with no vertex inside any footprint. The truth is bracketed and the construction
that lands closest is also the only one with the right topology:

| construction | area m² | vs factual |
|---|---|---|
| runtime octagon | 2,564 | −23.3% |
| **derived, faces + chords** | **3,166** | **−5.4%** |
| recorded (OSM `leisure=park`, conf C) | 3,345 | — |
| faces closed by one chord | 3,726 | +11.4% |
| full void swept to the footway | 4,211 | +25.9% |

**Two runtime risks must be cleared before it is applied.** `NeuHero`'s campus
ground cuts the park ring as a hole only if *every* ring vertex lies inside the
dilated campus contour; the derived ring reaches 40.3 m where the octagon reached
30.1, and a dropped hole would double-surface the whole quadrangle — z-fighting
across the entire opening frame. And the canonical spawn falls *outside* the
derived ring, so it moves from `Districts` park grass to the `NeuHero` campus
ground surface. Both are real surfaces, so it should not be bare terrain, but it is
a first-frame material change. **Do not move the spawn to suit the ring.**

**The entrances phase produced a negative result, and it is the useful kind.**
Comparing, for each of the 82 official accessible-entrance points, the bearing from
its building's own footprint centroid to the entrance against the bearing to the
quad centre: **Richards has no accessible entrance at all**; Ell's two face away by
128° and 115°; Dodge's one faces away by 64°, sitting on the north face while the
quad lies at 299°. Hayden (Δ5.4°) and Mugar (Δ16.4°) *do* face the quad, but each
encloses the room at 1 of 180 rays — they face its direction from outside it.

So: **zero quad-facing accessible entrances on the three buildings that enclose the
quadrangle.** This refines the standing note in `NeuHero.js`, which says none of the
82 points are on the quadrangle frontage — very nearly right, slightly too strong.
There is therefore no evidence basis for portal architecture on the quad frontage,
and the licence ruling forbids copying those coordinates into `src/` anyway. The
existing modest PDDL-walk doorway cues are the correct level of claim.

**Ell/Curry: the blocker stands, and now it is measured.** Both records resolve to
the same PDDL roof-break part **661061** — 95 vertices, 5,970 m², one part, one
tier. The two official footprints, Ell 2,864 m² and Curry 3,271 m², **sum to 6,135
m², within 2.8% of that single part**: the PDDL part is the two of them as one
structure, which is what they are on the ground. Scanned for a waist on six axes,
the polygon is **a single lobe at essentially every cross-section**, narrowest
interior widths 23–95 m. The cut that would reproduce Ell's 2,864 m² lands where
the mass is **44.7 m wide and one continuous lobe** — straight through a solid
plate. MassGIS parcels are network-blocked from this environment; the Northeastern
layer does separate them and is exactly the source `SOURCES.md` rules out. **No
split was invented.**

One consolation, and it changes the priority. The quad centre projects to s = −83.6
on the mass's principal axis, whose span is −53.7 to +77.2 — the quadrangle lies
entirely off its low-s tip, and on the official-area reckoning **Ell occupies the
whole quad-facing end**. The Wave-A historic treatment is therefore correct on
every surface the quadrangle and the opening can see; the mislabelling is confined
to the far north-east end, which no existing gameplay view reaches. Correctness
debt, not an opening defect.

**The Wave-D candidate list was wrong, and the Hurtig lesson is why.** Ranking the
46 un-modelled buildings within 320 m by unoccluded projected solid angle from
three gameplay viewpoints: **Snell Library ranks 12th and falls in none of the
three frusta** at 220 m; Churchill likewise. The strongest candidates are 337 and
335A Huntington Avenue at 51–58 m, **East Village** — 60 m tall and the only tall
thing inside the opening frustum — Speare Hall, Marino, and the four HERO_A St.
Stephen Street houses at 88–100 m. Every figure is an **upper bound**: occlusion is
the missing term, and Hurtig was chosen at 8° off the view axis, built, and then
measured at 42 of 42 points in frustum and **zero unoccluded**. Bearing and solid
angle alone have a 0-for-1 record here, so the occlusion test is Wave D's gate, not
its afterthought.

## CANONICAL NORTHEASTERN OPENING IS LIVE (2026-09-08, `5c5e349`)

**All nine gates PASS. Gates 7, 8 and 9 are MIGRATED.** The game now opens at
Northeastern: player (−1883, 3.115, 1677) grounded on the campus side facing
65.01°, with the single #f07318 starter solved onto the Huntington kerbside.
**Boston Common is RETIRED as the normal production start.**

Gate 7 was BLOCKED and was closed by `35d56ae`; the prerequisite it named — a
walkable campus→footway transition — exists, and the opening did not have to
change to accommodate it. See "THE REACHABILITY BLOCKER — CLOSED" below for what
the obstacle actually was, which was not what it looked like.

Superseded text follows. **Eight of nine gates PASS or READY. Gate 7 is BLOCKED, and the canonical
migration was attempted and REVERTED on 2026-09-08.**

### THE REACHABILITY BLOCKER — CLOSED (2026-09-08, `35d56ae`)

**Superseded by `5c5e349`: Northeastern is now the production opening.** At the
time of writing, Boston Common still was, because that mission was not the
migration. What follows is the diagnosis, which stands.

**What the obstacle actually was.** Not a 0.94 m wall. That number is
`surfaceHeight(footway) − groundHeight(campus)`, and the footway really is 0.94 m
up, but nothing about it was the obstacle. The obstacle was **0.32 m**, and it beat
a 0.45 m autostep because it is not a step.

`Roads.section()` has always drawn a **graded verge** behind every pavement — a
2.2 m sheet falling from kerb height to `roadY − 0.46`, in the far mesh and so in
the collider, whose documented job is to close the terrain-stamp seam. It works on
the ~96% of the network the stamp levels, where the toe lands 0.06 m *under* the
ground. On fill it does nothing: the stamp only ever cuts down, so on this frontage
(campus raster 0.76 m below the carriageway) the toe hung 0.32 m in mid-air as a
**naked trimesh boundary**. Measured contact normals at the jam: **ny = 0.001** — a
vertical wall — at 3.42 m, exactly the capsule's lower-sphere centre. An edge with
air under it offers nothing to step onto. Walking straight at it from 22.0 m out:
stopped at **16.09 m**, grounded, and no further in 9 s. The earlier mission's
16.11 m is the same measurement.

**Two older faults it exposed, both citywide:**

1. The verge's inner edge read `KERB_H`; the pavement's outer edge — the one it
   joins — is `KERB_H + WALK_FALL`. A **50 mm lip** at every verge join in Boston.
   Trivial on the flat; at the top of a 24° bank it presented at **52–55°**, the
   controller's own climb limit, and stopped him 0.26 m short after he had already
   climbed 0.86 m of 0.96 m.
2. `surfaceAt` returned `null` past the pavement, so callers fell back to the
   raster and **the surface contract denied 2.2 m of graded ground physics had all
   along.** That is why the frontage measured as a wall. It is also what stopped
   him *on* the bank: `Player._stepUpAhead` asks that function whether what is
   ahead is a step or a wall, got **rise = 0.000** on a climbable slope, and the
   anti-wall bleed took **3.40 m/s to 0.00 in five ticks** — the exact failure its
   own comment warns about for kerbs.

**The fix**, all in `Roads.js`, **zero triangles / draws / colliders added** (386,377
road tris, 47,093 collider tris, 62,147 collider verts, 47 bodies — identical before
and after; it moves vertices that already existed):

- `_vergeToe` finds the real ground per station and lands the toe on it, buried
  `VERGE_BURY`. It only ever goes DOWN, takes the lowest ground within half a
  far-LOD station either side (so the toe cannot surface between the 36 m collider
  stations and make a new edge), and stops at `VERGE_GRADE`.
- the verge's inner edge is `KERB_H + WALK_FALL`, so it meets the pavement it joins.
- `surfaceAt` reports the verge, `kind: 'ground'`, `max`-ed against the raster so a
  road cut into a hill still answers with the hillside. Also fixed in passing: the
  pavement cross-fall was inverted, and its span was short by the kerb width.

**Measured, station 200 of edge 486:**

| | before | after |
|---|---|---|
| `surfaceAt` vs downward raycast, offsets 10–17 m | −0.792 m | **0.007 m** |
| physical lip at the verge toe | 0.321 m | **0.000 m** |
| bank | a floating sheet | 0.956 m over 2.19 m = 43.7%, **23.6°** |
| bank smoothness along 90 m of road | — | 27 mm total, **3 mm** worst station jump |

**Traversal, real KCC, no teleport, 9 stations over 80 m:** campus→footway
**15/18** (the 3 misses walk into a hero building wall, ny = 0 — not a grade
defect); footway→campus **9/9**. Crossing 1.12–1.20 s in, 0.73–0.75 s out; minimum
speed in the zone 2.98 m/s. Day, night and rain all clean over it — it reads as the
earth bank it is, not a ramp. Traffic unaffected: 58 cars near the frontage, 19 of
20 sampled at 36–53 km/h.

**Residual:** on a perpendicular attack, 5 of 15 inward runs show 1–5 ungrounded
frames and up to a **0.379 m** single-tick rise. That is `Player._stepOver` doing
its documented kerb lift on a continuous slope; it is bounded by `AUTOSTEP` and it
never stops him (min speed 2.98 m/s). A diagonal approach — which is what the
arrival route actually is — shows 42 mm and zero ungrounded frames.

Superseded text follows.

### THE REACHABILITY BLOCKER — why Boston Common is still the production opening

The migration was implemented in full (four source edits, all four verified live)
and then reverted, because the opening it produced was functionally broken: **the
player cannot walk to the starter SUV.**

The Huntington footway is built **0.90–1.03 m above the adjacent campus ground**.
The player's autostep is **0.45 m** — deliberately sized so that "a 45 cm autostep
clears any kerb or stair in the city". Measured across **81 crossing stations
spanning ±160 m** of the arrival frontage, **80 are impassable**; the one that
passes has no campus ground on it at all, so it is not a campus→footway crossing.
Empirically, walking straight at the kerb for 12 s the player never got closer than
lat 16.11 m and was deflected along the wall out to lat 54 m.

So the locked opening gives a correct spawn, an excellent first frame and a
one-turn reveal of the orange SUV — and no way to reach it. Driving is
unreachable, not merely inconvenient.

**This is a pre-existing world defect, not one the migration introduced.** The
campus ground sits on the terrain raster at ~3.11 m; the pavement trimesh is at
~4.05 m. `Player._pickSpawn` already documents that `groundHeight` runs "0.4-0.6 m
too low near a street" — here the gap is roughly double that. It never surfaced
because the retired Boston Common opening spawns the player ON a sidewalk spawn
point, 3.2 m from the car, so nothing ever had to climb.

**Prerequisite for migration:** a graded transition — kerb ramp or regraded verge —
between the campus ground and the Huntington footway along the arrival frontage.
That is a world-geometry change and was explicitly out of scope for an atomic
migration, so it was not attempted.

An alternative the owner may prefer instead: spawn on the footway side rather than
on campus ground. From the pavement the player can walk to the car AND drop down
onto the campus ground (a 0.94 m fall is fine; only the climb is blocked). It costs
the locked composition, which is why it was not taken unilaterally.

### The migration patch, ready to re-apply

Four edits, all verified working before revert:

1. **`src/data/opening.js`** (new) — `OPENING_PLAYER {x:-1883, z:1677}`,
   `OPENING_YAW -2.007`, `OPENING_SNAP_R 6`, `OPENING_SUV_ANCHOR {x:-1858.6, z:1650.6}`.
2. **`Player._pickSpawn`** — anchor on `OPENING_PLAYER`, and bound the
   sidewalk snap to `OPENING_SNAP_R`; the retired opening snapped to the nearest
   sidewalk point at ANY distance, which would silently undo the lock.
3. **`Player`** — initial `this._yaw = OPENING_YAW`; **`CameraRig.init`** — initial
   `this.yaw = OPENING_YAW`. `Player._lookYaw()` prefers `rig.yaw`, so the rig is
   the authoritative facing owner.
4. **`Player.init`** — pass `OPENING_SUV_ANCHOR` to `spawnStarter` instead of the
   spawn, so the network still solves the slot and the heading.

**The yaw units are the trap.** `CameraRig._apply` builds forward as `(0,0,-1)`
rotated about +Y, i.e. `(-sin yaw, -cos yaw)`. A compass bearing measured as
`atan2(dx, dz)` is **π out**: the composition was authored at bearing 65° (1.134
rad) and the rig value that produces it is **1.134 − π = −2.007**. Verified live:
forward came out (0.906, 0.423), bearing 65.0°.

**Do not hard-code the SUV position or heading.** `Vehicles.spawnStarter` already
solves for a parking slot on the player's side of the street, over road surface,
clear of parked-car props, preferring a gap, and takes the heading from the road
tangent. Anchored at the locked coordinate it landed 2.8 m away at
(−1856.16, 1649.22), heading 2.068, tangent dot 1.000. Gates 7, 8 and 9
were live-validated rather than inferred: the SUV was temporarily repositioned at
runtime, entered with F, driven off inside the corridor, exited onto the footway,
and restored to canonical with 0.00 m offset — exactly one #f07318 identity
throughout, and a clean reboot from source confirmed spawn (166, 3.73, 128) and
SUV (169.09, 3.44, 128.9) untouched.

### The LOCKED migration target (candidate-lock mission, 2026-09-08)

**CANONICAL NORTHEASTERN OPENING MIGRATION IS DONE** (`5c5e349`). The targets
below were locked by the candidate-lock mission, survived the first attempt and
its revert, survived the blocker fix, and shipped unchanged — no value in this
section was altered to make the migration work. They now live in
`src/data/opening.js`, which is the authoritative source; this section is the
record of how they were chosen.

| | LOCKED value |
|---|---|
| **Player** | **(−1883, 1677)** |
| **Player initial yaw** | **65°** (1.134 rad) |
| **SUV** | **(−1858.6, 1650.6)** |
| **SUV heading** | **2.068 rad** — derive from the Huntington tangent at the final position rather than hard-coding; measured tangent dot **1.000** |

Player → SUV **35.9 m**; road band **PARKING LANE at 8.6 m** from the centreline
(travel lanes to 7.00, parking to 9.80, kerb to 9.96, footway to 13.56); nearest
regulatory sign **11.7 m**; nearest parked prop car 6.7 m; angular separation from
the opening facing **72°**; SUV **not** in the initial 62° frame, discoverable with
one ~72° turn.

**The SUV moved +12 m north-east along the same kerb from Wave 4A's candidate, and
it is strictly better.** Wave 4A's (−1848, 1645) sat **1.8 m** from a plate reading
"NO PARKING / ANY TIME / TOW ZONE" — semantically inert (nothing in `src/` reads
regulatory signs; the type is a 42% branch of a die roll at a random 22-46 m kerb
interval with a coin-flip 180° facing) but it legibly says the hero starter is
about to be towed. The locked position improves sign clearance to 11.7 m, shortens
the walk from 47.4 m, raises tangent alignment from 0.999 to 1.000, and departs on
straighter kerb (peak roll 0.023 rad against 0.211, never leaving the parking lane
over 14 m). The campus opening is **identical** at both — same 6 hero buildings,
same 2 arrival-walk points, same 2 entrance cues, quadrangle at the same pixel —
because the SUV is off-screen either way. Neither position is occluded from the
player's sight line.

**The Player candidate was NOT moved.** It is on maintained campus ground, 3.7 m
from the factual arrival walk, with the strongest available Krentzman composition;
no modest move improved the opening without weakening one of those.

The one thing the migration still inherits: the SUV cannot share the opening frame
with the quadrangle. From the player candidate they are ~72° apart, and a 62° fov
holds neither pair. One-turn discoverability is the accepted model — the campus is
the primary identity cue and was not sacrificed to force the car into frame.

Until every row passes, the spawn stays at world (166, 128) on the Boston Common
edge, 2,684 m from the campus centroid.

## 7. Open factual questions

1. ~~**No authoritative building heights exist.**~~ **RESOLVED** — City of Boston
   *Buildings with Roof Breaks* (PDDL, 2010 snapshot) carries `GRND_ELEV_2010`,
   `ROOF_ELEV_2010` and `BLDG_HGT_2010`, and validates sub-metre against two
   towers whose heights are independently known (Prudential 228 m against 228,
   111 Clarendon 240.2 against 241). It also SUPERSEDES the Boston 3D figures,
   which run a median +6.6 m high here. The opening cluster's heights are in
   `HERO_FOOTPRINTS.json` and shipped in `src/data/neu-hero.js`. Coverage beyond
   the opening cluster is not yet extracted.
2. **Licensing.** ODbL share-alike on anything OSM-derived that ships, and the
   university ArcGIS terms are unverified. An owner decision, not a technical one.
3. **The Ruggles rail cut is unmeasured.** USGS point sampling did not resolve it.
   The MBTA topology shows stair and ramp top/bottom pairs, so the grade separation
   is real; its depth is not established.
4. **Vertical datum** between USGS 3DEP and the game's sea-level-zero is not
   reconciled — a consistent ~1.5 m offset was observed but not explained.
5. **`PrimaryUse` is blank** for all 104 official rows, so building typology
   (residence / lab / athletics) currently rests on names and OSM tags.
