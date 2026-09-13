# Stage 1D — road / street-frame registration diagnosis

**Date** 2026-09-13 · **Baseline** `5c4af658cd360cf7f9e3d2677c64fef7a95312ba` (HEAD == origin/main, clean, 0/0)
**Read-only.** No `src/` change, no runtime transform, no WebGL, no network, no new data source.

---

## A. Executive summary

# DIAGNOSIS STRONG · dominant cause **MIXED_LOCAL_GEOMETRY**

**Stage 1C's wording "it is the roads, not the buildings" is NARROWED, not rejected — and one clause of my
Stage 1C closing statement was wrong and is corrected below.**

The mismatch is real and it is on the road side. But it is **not a registration error in the sense of a
transform**, and that distinction changes the entire cost picture:

| hypothesis | verdict | evidence |
|---|---|---|
| **A. coordinate frame / projection** | **RULED OUT** | a global rigid fit over 2,165 samples buys (−0.15, −2.41) m and −1.15°, cutting the median residual 11.08 → 10.08 m — 9%. `docs/neu/ANCHORS.json` independently puts the systematic bias at 15.4 m against a median per-anchor error of 24.7 m and reads it as "authoring scatter rather than a rotation, scale or datum fault". |
| **B. centreline lateral placement** | **contributing, not dominant** | per-street lateral shift (25 params) leaves the median at 9.2 m and admissible frontage at **1.4% — unchanged from no correction at all**. |
| **C. road orientation** | **RULED OUT** | the best global rotation is 1.15°, worth almost nothing. |
| **D. street-section width model** | **contributing, largest single knob** | per-street width (25 params) cuts the median to 4.67 m and lifts admissible frontage to 30.3%. But a per-road-class width model makes things **worse** (11.78 m) and fails cross-validation. |
| **E/F. frontage / parcel generation offset, asymmetry** | **EXCLUDED ON CODE GROUNDS** | `_frontageLine` offsets the centreline by `corridorHalf(e) * side` with `side ∈ {−1,+1}` and nothing downstream moves the line laterally. The procedural wall midline **is** the centreline, identically. Asymmetric frontage generation is not merely unlikely, it is unrepresentable. |
| **G. local non-uniform geometry** | **DOMINANT** | the per-street corrections are idiosyncratic — lateral sd **4.29 m** about a mean of −2.52 m, width sd **8.36 m** about a mean of 1.95 m — and they **do not transfer between the two sides of the same street**: a width correction fitted on one side scores 16.4 m on the held-out side, *worse than applying no correction at all* (11.08 m). |
| **Intersections** | **RULED OUT as dominant** | near-junction median 11.99 m vs mid-block 10.79 m. |

**The root cause is documented in the repository itself.** `src/data/boston-geo.js` opens: *"Hand-authored
geography of Boston … measured against authoritative footprints it sits a median ~25 m from reality."* Back
Bay in particular is not traced at all — it is **generated from an idealised rotated grid** (`BB_OX −452.5`,
`BB_OZ 187.6`, `BB_BEARING 251.5°`) with hand-chosen street offsets, fitted so that it "lands on the real
Public Garden corners, Copley Square and Mass Ave × Comm Ave simultaneously (they disagree by ~50 m in the
sources; this is the least-squares compromise)".

So Boston's Back Bay streets are a regular grid fitted to **landmark anchors**, and the factual buildings sit
on the **real, irregular** street lines. Each street's position and each street's implied wall-to-wall width
therefore differ from reality independently. That is exactly what the fits show, and it is why no transform
touches it.

**The correction I must retract.** Closing Stage 1C I warned that road registration has "a far larger blast
radius than any stage to date — parcels, sidewalks, traffic, routing, props, spawns and the hero district are
all anchored to those roads." The dependency audit in §K shows that is **wrong in an important way**: every
one of those is *regenerated at `City.init()` from `STREETS`*. There is no persisted derived geometry to
migrate. The blast radius of changing a centreline is much smaller than I said. What is *not* bounded is the
correction itself — there is no transform to apply, only re-authoring, and the data says even perfect
per-street re-authoring would not be enough.

---

## B. Baseline · C. Resource state · D. Sources read

`/Volumes/Projects` mounted; toplevel `/Volumes/Projects/boston`; **HEAD == origin/main == `5c4af65`**; clean;
0 ahead / 0 behind; no merge or rebase state; remote `EugeneYip/Boston`; three auxiliary worktrees present and
**untouched**.

Static-only work: memory 29% free, swap headroom 995 MB, load 4.34 / 3.52 / 3.56, disk 118 GiB, **three
`xcodebuild` processes running throughout and untouched**. No WebGL was started, no rendering window was
required, and no App-development process was signalled. Total runtime of the whole diagnostic is a few
seconds of Node.

Read: the Stage 1C, 1B.1, 1B and 1A.2 reports and their `research/gis-stage1*/` artifacts; `RoadNetwork.js`,
`Buildings.js`, `Facades.js`, `City.js`; `src/data/boston-geo.js`, `landmarks.js`, `opening.js`,
`neu-hero.js`; `docs/neu/ANCHORS.json`.

**DOIT was not consumed.** `research/gis-stage1a/cache/doit_buildings_4326.json` and
`research/gis-stage1a2/cache/ne_doit_4326.json` remain on disk from the Stage 1A audit. No Stage 1D module
opens either path; the only sources loaded are PDDL Roof Breaks (`6d0e737fac9e0eab…`) and MassGIS Structures
(`8a48d7da4eac7a42…`) through `research/gis-stage1c/sources.mjs`. No new data source was sought and no
external request was made.

## E. Phase 1 — the geometry, reconstructed

The whole chain, with the quantity each step actually means:

| step | code | geometry |
|---|---|---|
| street source | `src/data/boston-geo.js` `STREETS` | **hand-authored real lat/lon**; Back Bay generated from the `bb(u,v)` frame |
| projection | `src/core/Geo.js` `geo()` | equirectangular, origin 42.35538 / −71.06565, `M_PER_DEG_LAT 111320` |
| road graph | `RoadNetwork.build()` | polylines `e.pts`, crossings hashed and split |
| section widths | `RoadNetwork.js:41–44`, `:230–235` | per **type**: `street` lane 3.30 / walk 2.70; `arterial` lane 3.50 / walk 3.60; `alley` 5.00 / 1.00 |
| **corridorHalf** | `RoadNetwork.js:60` | `e.halfRoad + KERB(0.16) + e.walk` — carriageway half + kerb + footway |
| **procedural front line** | `RoadNetwork._frontageLine(e, side)` | centreline offset by **`corridorHalf(e) * side`**, mitred at vertices |
| parcel | `RoadNetwork.buildPlots` | `[p0, p1, p1+out·depth, p0+out·depth]`; depth from `ZONING[district].depth`, then `rayToRoad`, then `_fitDepth` |
| visual unit | `Buildings._superblocks` | runs of lots fused along the frontage chain |
| emitted wall | `Buildings._specFor` → `_clipParcel` → `makeSpec` | clipped to the corridor, then faced |

Three consequences are load-bearing and all three are properties of the code, not of the data:

1. **`PROCEDURAL_WALL_TO_WALL = 2 × corridorHalf(e)`.** For a `street` that is 17.52 m; for an `arterial`,
   27.12 m. This is a **building-wall-to-building-wall** quantity — the back of one footway to the back of the
   other — and it is the correct counterpart to a factual wall-to-wall measurement. Stage 1C's comparison was
   therefore semantically matched, which this stage set out to verify rather than assume.
2. **`PROCEDURAL_WALL_MIDLINE ≡ CURRENT_ROAD_CENTERLINE`, identically.** The offset is `* side` with
   `side ∈ {−1,+1}`; `_clearFrontage` only deletes spans of the line; `_fitDepth` only shortens depth. Nothing
   moves a front line laterally. The brief's decomposition items A and B are therefore **the same number**, and
   hypothesis F is excluded by construction.
3. **The width model is per road *type*, not per street.** Every Back Bay `street` gets the same 17.52 m
   section and every `arterial` the same 27.12 m, regardless of what that street actually is.

## F. Phase 2 — coordinate-frame sanity: RULED OUT

Not re-derived from scratch; the existing canonical evidence is used and then tested against this stage's own
fit.

`docs/neu/ANCHORS.json` (generated by `tools/neu-audit/build.mjs`, committed) compares 11 game landmarks with
the same features in OpenStreetMap, both pushed through the game's own `geo()`. It is careful to say it
measures *authoring*, not projection, "which is exact by construction". Its numbers:

| | |
|---|---|
| all anchors | n 11, min 3 m, **median 24.7 m**, p90 132.8 m, max 183.1 m |
| definition-clean anchors | n 8, median 24.7 m, p90 51.4 m |
| **systematic bias** | dx 13.6, dz −7.3, **magnitude 15.4 m** |
| its own reading | *"small next to the per-anchor scatter, so the errors are authoring scatter rather than a rotation, scale or datum fault"* |

> That artifact was built against OSM. It is **pre-existing committed research**, cited here as evidence; no
> OSM data was loaded, requested or used as geometry by Stage 1D, consistent with the project's ODbL policy.

This stage's independent fit agrees. Over 2,165 Back Bay samples:

| model | params | median residual | p90 | rms | admissible frontage |
|---|---|---|---|---|---|
| **G0** no correction | 0 | 11.08 m | 32.74 | 17.01 | 43 m / 3,074 m (**1.4%**) |
| **G1** global translation | 2 | 10.59 | 31.87 | 16.82 | 1.4% |
| **G2** rigid (translation + rotation) | 3 | 10.08 | 33.87 | 16.73 | 1.4% |
| **G3** affine | 6 | 8.22 | 29.87 | 15.68 | **0.0%** |

Fitted parameters: G1 **(−0.92, −2.03) m**; G2 **(−0.15, −2.41) m with −1.15°** about (−1191, 612). A
two-metre translation and a one-degree rotation are the entire global signal, they remove 9% of the residual,
and they move admissible frontage not at all. The affine fit lowers the median further and takes admissibility
to **zero** — it is shearing the frame to chase scatter.

**Global frame registration is not the cause, and the Stage 1C measurement was not a frame mistake.**

## G. Phases 3–4 — semantically matched sections, and the street matrix

Definitions used throughout, kept deliberately distinct:

- **FACTUAL_WALL_MIDLINE** — midpoint of the two opposing factual first-hit walls. *Not* a road centreline;
  setbacks alone could move it.
- **FACTUAL_WALL_TO_WALL_WIDTH** — distance between opposing factual walls. Contains roadway, footways,
  setbacks, planting, stoops. *Not* carriageway width.
- **PROCEDURAL_WALL_MIDLINE** — the centreline, identically (§E).
- **PROCEDURAL_WALL_TO_WALL_WIDTH** — `2 × corridorHalf(e)`.
- `d` — signed distance from a procedural front line to the factual wall, **positive outward**, away from the
  carriageway.

Sample set: **2,165 points on 41 of 43 block faces**, every one a place where both allowed sources see a wall
and agree within Stage 1C's unchanged 0.5 m tolerance. 1,394 on `street` (corridorHalf 8.76 m), 771 on
`arterial` (13.56 m / 11.81 m).

Per-street corrections, fitted jointly (lateral where both sides are measured, width everywhere) — **diagnostic
only, applied to nothing**:

| street | edge | sides | n | lateral | width (half) |
|---|---|---|---|---|---|
| Newbury | 40 | 2 | 226 | −1.75 | +2.81 |
| Newbury | 41 | 2 | 292 | +0.94 | +0.86 |
| Newbury | 42 | 2 | 111 | −1.09 | −6.26 |
| Boylston | 51 | 2 | 182 | **−11.86** | +6.90 |
| Boylston | 52 | 2 | 253 | −7.10 | +8.02 |
| Boylston | 53 | 2 | 145 | −10.28 | +9.52 |
| Exeter | 156–159 | 2 | 9–78 | +2.25 … −2.53 | −6.97 … +11.16 |
| Fairfield | 167–170 | 2 | 42–82 | −0.66 … **−8.10** | −8.32 … +12.51 |
| Huntington | 483 | 2 | 166 | +0.56 | −5.28 |
| Ring Road | 202 | 2 | 35 | −0.44 | +18.70 |
| Comm Ave Outbound | 30–32 | 1 | 24–138 | — | +17.38 … +21.05 |
| Blagden | 199 | 1 | 30 | — | **+39.21** |

**Across the 16 two-sided roads: lateral mean −2.52 m, sd 4.29 m; width mean +1.95 m, sd 8.36 m.** If a global
translation explained this, the lateral column would share a sign and a magnitude. It does not. Three
neighbouring Newbury segments want +0.94, −1.09 and −1.75 m; Boylston wants −7 to −12 m; Fairfield's four
segments want widths from −8.3 m to +12.5 m.

Blagden Street's +39 m is not a street-section error at all — Boston's Blagden runs across ground where the
nearest real building is forty metres away.

## H. Phases 7–9 — counterfactuals

| model | params | median residual | admissible frontage | roads |
|---|---|---|---|---|
| centreline-only, global (G2) | 3 | 10.08 m | 43 m (1.4%) | 1/16 |
| **per-street lateral (PSL)** | 25 | 9.20 m | **43 m (1.4%)** | 1/16 |
| width-only, per road class (W) | 2 | 11.78 m | 0 m (0.0%) | 0/16 |
| **per-street width (PSW)** | 25 | **4.67 m** | **932 m (30.3%)** | 6/16 |
| rigid + class width (G2+W) | 5 | 11.34 m | 0 m (0.0%) | 0/16 |
| per-street lateral + width (PSL+PSW) | 41 | 7.36 m | 339 m (11.0%) | 3/16 |

Read carefully, because the algebra makes these exactly separable: admissibility needs both
`|r₀ + r₁| ≤ 4` (width) and `|(r₀ − r₁)/2| ≤ 2` (shift). A lateral correction moves **only** the shift term; a
width correction moves **only** the width term.

- **Per-street lateral alone leaves admissibility at 1.4% — identical to doing nothing.** Fifteen of sixteen
  roads still fail on width. Lateral placement is not the binding constraint.
- **Per-street width alone reaches 30.3%.** Ten of sixteen roads still fail on shift.
- The combined fit scoring *lower* than width alone (11.0% vs 30.3%) is an artefact of the robust trimming
  selecting different inliers at 41 parameters, and is reported rather than smoothed away. Setting both terms
  per street to their measured values would of course reach 100% — that is not a model, it is a lookup table
  with two free numbers per street fitted to the answer.

## I. Phase 5 — intersections, and Phase 6 — road class

**Intersections are not the story.** Splitting at the sample-distribution quartile, 21.45 m from the nearest
junction: near-junction median 11.99 m / p90 28.36; mid-block 10.79 m / p90 32.86. Corner construction and
junction widening are not responsible for a material share of the error.

**The per-class width model is not the story either.** Fitting one width correction per road type gives
`arterial +3.35 m`, `street +1.51 m` — and *raises* the median residual to 11.78 m. Boston's generic section
is not uniformly wrong; it is wrong by a different amount on every street, which a per-class parameter cannot
express.

## J. Phase 10 — cross-validation, and the finding that settles it

Fit on alternating block faces, evaluate on the held-out ones. For a two-sided street this trains on one side
and tests on the other.

| model | train median | **held-out median** | held-out p90 |
|---|---|---|---|
| G1 global translation | 11.51 | 10.35 | 28.52 |
| G2 rigid | 10.48 | 9.18 | 29.21 |
| W class width | 8.72 | **12.63** | 30.03 |
| G2+W | 7.57 | **14.61** | 31.44 |
| PSL per-street lateral | 8.16 | **12.91** | 36.79 |
| **PSW per-street width** | 8.16 | **16.40** | 29.84 |

The global models generalise and are useless. **Every fitted model that helps in-sample is worse than doing
nothing out-of-sample** — and the sharpest case is per-street width, which trains at 8.16 m and scores
**16.40 m** on held-out faces against G0's 11.08 m.

Since the procedural generator is exactly symmetric (§E), a width correction fitted on one side of a street
*must* apply identically to the other. It makes things worse. **The two sides of the same Boston street have
independent errors**, which no symmetric generator can express and no per-street parameter can capture. That
is the definition of non-uniform local geometry, and it is the strongest single piece of evidence in this
stage.

## K. Phase 12 — dependency audit, and a Stage 1C correction

`City.init()` order: `terrain.bake()` → `net.build()` → `terrain.stampRoads(net)` → `districts.bake()` →
`parkPaths` → `net.buildSidewalks()` → `net.buildPlots(...)` → `net.buildSpawns()` → roads/water → `_publish()`
→ colliders.

| class | systems |
|---|---|
| **DIRECT geometry dependency** on `STREETS` / centrelines | `RoadNetwork` graph · `Terrain.stampRoads` · `buildSidewalks` · `buildPlots` · `buildSpawns` · `Roads` rendering · `Minimap` |
| **DERIVED / REGENERATABLE** — rebuilt every boot from the above, nothing persisted | parcels → superblocks → building specs → facades → chunks → colliders · kerbs and footways · traffic lanes and the routing graph · `Pedestrians` · `Props` · `StreetFurniture` · `Vegetation` · `Transit` · `VehicleFactory` parked cars · spawn points |
| **INDEPENDENT of roads, already in the factual frame** | `landmarks.js` (placed by real lat/lon through `geo()`, with `keepout` radii) · `neu-hero.js` (survey-derived PDDL massing, FROZEN) · terrain bake · district raster · weather / materials / lighting |
| **SEMANTIC ONLY** | street names, road class, zoning table lookups |

Two things follow.

**First, the retraction.** Stage 1C's closing claim that parcels, sidewalks, traffic, routing, props, spawns
and the hero district "are all anchored to those roads" implied a migration cost that does not exist. They are
**derived at init**, not stored. Changing a centreline in `boston-geo.js` regenerates all of them for free.
The genuinely non-regenerating items are few and small: `opening.js` (hand-measured player start, authored
against Northeastern's survey geometry), the seam continuity with adjacent hand-traced streets, and the
Northeastern district, which is FROZEN and already survey-accurate.

**Second, an irony worth recording.** `landmarks.js` and `neu-hero.js` are already in the *factual* frame,
while the hand-traced streets are not. Boston currently holds geo-accurate landmarks inside a hand-authored
street grid. Moving Back Bay's grid toward the factual frame would *reduce* that internal inconsistency — and
would break the hand-tuned seams with everything adjacent.

## L. Phase 11 — the source-disagreement tail

546 of 2,711 paired samples (**20.14%**) disagree by more than 0.5 m, with a median gap of 17.77 m — the tail
is large, not marginal, which is why it is characterised rather than waved at.

| class | n | share |
|---|---|---|
| MassGIS wall deeper, same building | 222 | 40.7% |
| MassGIS misses a structure PDDL sees | 203 | 37.2% |
| PDDL misses a structure MassGIS sees | 74 | 13.6% |
| PDDL wall deeper, same building | 21 | 3.8% |
| delineation difference under 2 m | 26 | 4.8% |

**78% of the tail is MassGIS's first wall sitting deeper than PDDL's.** That is granularity, not error: 218
PDDL roof-break parts against 169 MassGIS structures over the same ground. Every PDDL polygon has a MassGIS
counterpart; four MassGIS polygons (29,362 m²) have no PDDL counterpart — the large superblocks. This is the
same delineation disagreement Stage 1A.2 recorded, seen from the street instead of from above. **It is not a
projection problem, and it does not touch the main diagnosis**, which used only the agreeing 80%.

## M. Phase 13 — smallest plausible correction unit

**There is no bounded correction unit that reaches Stage 1C admissibility.** Ranked by what the evidence
supports:

| candidate unit | what the data says |
|---|---|
| global frame | **excluded** — 3 parameters buy 9% of the residual and 0% of admissibility |
| road orientation | **excluded** — 1.15° |
| per-road-class section width | **excluded** — makes it worse, fails cross-validation |
| intersection geometry | **excluded** — no mid-block/junction difference |
| frontage generator | **excluded on code grounds** — symmetric by construction |
| per-street lateral registration | insufficient alone — admissibility unchanged at 1.4% |
| per-street section width | best single knob — 30.3% — but **fails to transfer across the same street's two sides** |
| **per-street-segment re-authoring of centreline *and* an asymmetric section** | the only thing left, and it is not a correction — it is replacing the hand-authored geometry |

For Back Bay specifically the re-authoring surface is unusually small and worth naming: the grid is three
constants (`BB_OX`, `BB_OZ`, `BB_BEARING`) plus the `BB_U` / `BB_V` offset tables in `src/data/boston-geo.js`.
But §H and §J show that even a perfect per-street fit does not generalise, so moving those constants would not
deliver the Stage 1C frontage either. **The idealised-grid assumption is itself the problem**, and the real
Back Bay is not a regular grid.

## N. Estimated Stage 1C unlock

Against Stage 1C's 1,502 m / 48.0% of source-agreed frontage, and using its frozen admissibility clauses
unmodified:

| corrected layer | admissible frontage | share of two-sided frontage |
|---|---|---|
| nothing (today) | 43 m | 1.4% |
| global translation | 43 m | 1.4% |
| global rigid | 43 m | 1.4% |
| affine | 0 m | 0.0% |
| per-road-class width | 0 m | 0.0% |
| per-street lateral | 43 m | 1.4% |
| **per-street width** | **932 m** | **30.3%** |
| per-street lateral + width | 339 m | 11.0% |

**No evidence-supported coherent model exceeds ~30%**, and the one that reaches it fails to generalise across
a single street.

## O. Verdict

**DIAGNOSIS STRONG.**

- **Dominant cause:** `MIXED_LOCAL_GEOMETRY` — hand-authored street geometry with independent per-street, and
  per-*side*, error.
- **Secondary contributors:** `STREET_SECTION_WIDTH_MODEL` (a per-type constant where reality varies per
  street) and `ROAD_OR_MIDLINE_LATERAL_REGISTRATION` (real but not binding).
- **Ruled out:** `GLOBAL_FRAME_REGISTRATION`, `ROAD_ORIENTATION`, `INTERSECTION_GEOMETRY`,
  `FRONTAGE_GENERATION_OFFSET` (the last on code grounds, not statistics).

Confidence is strong because the frame was ruled in or out with two independent lines of evidence, the width
semantics were reconstructed from code rather than inherited, the decomposition is exactly separable, the
result generalises beyond one block face, the code-path attribution matches the geometry, and every
alternative model is materially weaker under cross-validation.

**Is Stage 1C's "the roads are wrong" supported?** *Narrowed.* The correct phrasing is **ROAD/FRONTAGE
REGISTRATION ERROR, non-uniform and per-street** — Boston's hand-authored streets and the factual buildings
are in materially different places, street by street, with no transform between them. It does **not** say any
particular centreline is geographically wrong by a known amount, and this stage deliberately does not claim
that.

**Is the factual building data still usable?** Yes — unchanged. Stage 1C showed the two sources cross-validate
to 0.25 m on 79.6% of frontage, and nothing here weakens that. The data is sound; the frame it would have to
live in is not.

**Is new factual road data necessary to proceed?** On this evidence, **yes** — a surveyed centreline source
would be required, and Stage 1D did not look for one. That is a separate Owner decision.

## P. Remaining unknowns

1. Whether a surveyed road centreline would actually collapse the residual — untestable without such a source,
   which this stage was forbidden to seek and did not.
2. Whether the per-*side* asymmetry is real-world (genuinely different setbacks on the two sides of a Back Bay
   street) or an artefact of first-hit sampling across gaps. The first-hit profile takes the nearest wall, so
   gaps bias `d` outward; a front-most-quantile estimator would test this.
3. Non-Back-Bay Boston is unmeasured. Every number here is from the 400 m Back Bay box.
4. The four large MassGIS-only structures (29,362 m²) are unexamined.

## Q. Validation

`npm run check` — 89 files parse, no undefined references in 112 files. `git diff --check` clean.
**`git diff -- src/` is empty**: no production file was touched at any point in this stage. Deterministic
rerun verified — `summary.json` and `tail.json` are byte-identical on a second run. No `npm install`, no new
dependency, no network access, no WebGL.

Reproduce with:

```
node research/gis-stage1d/run.mjs
node research/gis-stage1d/tail.mjs
```

## R. Owner decision required next

Stage 1D was diagnostic and the diagnosis is complete. **Nothing is implemented and nothing should be.**

1. **Close the GIS hybrid programme.** The chain has produced three precise negative results and two durable
   positives, and has now identified the blocker exactly. *This remains the recommendation.*
2. **Authorise a surveyed road-centreline source study** — read-only, licensing-first, in the shape of Stage
   1A. This is the only path the evidence supports, and it is a new source hunt, which every brief so far has
   forbidden. It would need its own authorization and its own licence clearance.
3. **Accept the divergence and use the factual data elsewhere.** The source-agreement result is frame-free;
   whether it is useful for anything that does not need the road frame is an open question this stage did not
   ask.

**Not authorised and not recommended under any option:** road migration, re-registration, width changes,
parcel regeneration, traffic/sidewalk/routing migration, default-on, citywide rollout, North End, or
deployment.

---

*Stage 1D. Read-only diagnosis. `src/` untouched; Boston is bit-for-bit the city it was at `5c4af65`.
Not pushed, not deployed, not enabled.*
