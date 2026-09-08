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
| 3 | key campus building massing credible | **PASS** — 18 survey-derived volumes, heights validated sub-metre against two known towers |
| 4 | key campus public realm credible | **PASS** (3B acceptance, `c9bf5b0`) — Krentzman is a mown quadrangle with stone circulation, furniture and specimen trees, surrounded by ~20,000 m2 of maintained campus ground that abuts the octagon on all eight bearings, with 163 m of PDDL survey path from the Huntington footway into the quad. Rendered and traversed: 0 ungrounded frames, 14 mm max snap, no road intrusion, 4.0 ms. Caveat: the ground has a finite outer boundary, so a lawn-to-terrain transition still exists where it ends. |
| 5 | eye-level visual audit passes | **PASS** (3A) — fenestration on 16 of 18 parts from recorded storey counts, stone ground storeys, cornices, and a quadrangle floor. The district reads as an institutional campus at pedestrian distance. |
| 6 | player pedestrian access passes | **PASS** — 0 ungrounded frames, no walk-through, no ghost colliders, 8/8 bearings clear inside the quad; max vertical snap 12 mm on the new ground plane, 0.45 m at the real Huntington kerb |
| 7 | starting SUV physical placement passes | **EVIDENCE ONLY, now correctly reasoned** (3B) — the candidate at (−1848, 1645) is 8.7 m off the centreline, which puts it **inside the parking lane (7.30–9.80 m)**, where a parked car belongs. Wave 2C called it clear by comparing against the 7.0 m travel-lane edge rather than the 13.56 m corridor — right answer, wrong reason. Nothing placed. |
| 8 | vehicle exit/entry access passes | **EVIDENCE ONLY** — 47.4 m from the player candidate, 34 s at 1.4 m/s, line of sight clear against all hero footprints. The enter/exit flow itself was verified elsewhere, not here. |
| 9 | opening camera composition passes | **PARTIAL, improved** (3B) — from the player candidate the composition now reads as arrival at a campus: lawn underfoot, a factual stone walk crossing 3.7 m away, and the quadrangle framed by fenestrated halls. Not forced to PASS: there are no entrance cues, the SUV is not placed, and the outer ground boundary is visible from some angles. |

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

**Five of nine gates now PASS** (1, 2, 3, 5, 6, and 4). Gate 9 is PARTIAL; gates 7
and 8 remain evidence-only with nothing placed. **The remaining blockers are all
about the OPENING, not the district**: no entrance cues on any building, no SUV
placed, no opening camera authored. That is a coherent next mission, and it is the
last one before a migration could be argued.

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
