# Stage 1C — streetwall hybrid: factual street-facing X/Z, procedural depth

**Date** 2026-09-13 · **Baseline** `e66f1d844bc3a7a6d37d984537add781bdb26871` (HEAD == origin/main, clean, 0/0)
**Scope** Back Bay only · default OFF · reversible · local, unpushed.
**No** full-footprint replacement, citywide migration, North End runtime, road/terrain/collision migration,
vertical GIS, MapLibre, second renderer, new dependency, or deployment.

---

## A. Executive verdict

# FAIL — before runtime, and for a reason worth having

**The two allowed sources agree with each other about where Back Bay's walls are. They cannot be used,
because what they agree about is a city whose streets are somewhere else.**

Stage 1C never reached WebGL, and not because of resources. It stopped at the frozen gate, which is the
outcome the authorization explicitly prefers: *"If no defensible street-facing constraint exists: Stage 1C may
FAIL before runtime. That is preferable to inventing facade truth."*

The measurement is in two halves and they point in opposite directions.

**The encouraging half.** Over 2,711 paired samples along 43 Back Bay block faces, PDDL Roof Breaks and
MassGIS Structures put the first street-facing wall in the **same place to within 0.25 m in 79.6% of
samples**, and agree on its direction to a median **0.25°**. The factual street-facing envelope is a real,
extractable, cross-validated thing. 48.0% of Back Bay frontage — 1,502 m of 3,132 m, in 17 runs of 25 m or
more, the longest 81.4 m — passes the source-agreement clause outright.

**The disqualifying half.** That envelope has no usable relationship to Boston's procedurally-placed roads.

| test | result |
|---|---|
| factual building area inside a Boston **road corridor** | **21.0%** (PDDL) · 13.1% (MassGIS) |
| factual building area inside a Boston **carriageway** | **14.0%** (PDDL) · 8.7% (MassGIS) |
| PDDL polygons wholly clear of every Boston road | **72 of 218** |
| per-face median displacement, current wall → factual wall | p50 **9.12 m**, p90 20.22 m, max 38.73 m |

And the clause that cannot be argued with. Taking both faces of one road and adding the two displacements
gives the street width the factual data implies:

| street | procedural width | **implied factual width** | agreement |
|---|---|---|---|
| Newbury (edge 42) | 17.5 m | **−0.15 m** | 100% |
| Fairfield (edge 167) | 17.5 m | **−6.31 m** | 100% |
| Fairfield (edge 169) | 17.5 m | **−4.09 m** | 100% |
| Fairfield (edge 168) | 17.5 m | **−5.31 m** | 95.7% |
| Exeter (edge 157) | 17.5 m | −0.20 m | 85% |
| Newbury (edge 41) | 17.5 m | 1.90 m | 84% |
| Boylston (edge 52) | 27.1 m | 31.81 m | 97.7% |

**A street cannot be −6 m wide.** The faces with the *best* source agreement are precisely the ones whose
implied street is impossible — because perfect agreement means both sources confidently place a real wall
inside Boston's carriageway. Boston's roads run through real Back Bay blocks.

Aligning Boston's building line to that envelope would not correct a setback error. It would move Boston's
houses into Boston's own street, and it would do so most confidently exactly where the data is best. The
brief forbids road migration, and correcting the road is the only thing that would make this constraint
meaningful.

**HIGH-CONFIDENCE faces: 0. Eligible runs: 0. No runtime code was written, no flag was added, and nothing
was rendered** — there was no defensible candidate to render.

---

## B–C. Baseline and resource state

`/Volumes/Projects` mounted; toplevel `/Volumes/Projects/boston`; **HEAD == origin/main == `e66f1d8`**; clean;
0 ahead / 0 behind; no merge or rebase state; remote `EugeneYip/Boston`. Three auxiliary worktrees present and
**untouched**. The Owner's push of the Stage 1B.1 negative-result checkpoint is confirmed.

Static work ran under the split policy the brief sets out: memory 29% free, swap headroom 1,258 MB, load
4.79 / 3.86 / 4.59, disk 118 GiB, with three `xcodebuild` processes running throughout. That is safe for
headless Node and no App-development process was touched. **The render gate was never reached** — not because
it was blocked, but because the analysis produced nothing to render. Resource state is therefore not the
reason for this verdict and must not be read as one.

## D. Area and sources

Canonical Stage 1A bbox, unchanged: WGS84 **42.347703, −71.082431, 42.351297, −71.077569**; Boston local
**x [−1380.46, −980.50], z [+454.52, +854.60]**.

| | |
|---|---|
| **Boston Buildings with Roof Breaks** | ODC-PDDL-1.0 · 218 polygons · sha256 `6d0e737fac9e0eab…` |
| **MassGIS Building Structures (2-D)** | MassGIS public record · 169 polygons · sha256 `8a48d7da4eac7a42…` |
| projection | production `src/core/Geo.js geo()`, unchanged, not reimplemented |

Both read from the existing Stage 1A / 1A.1 offline caches. **City `Assessing/DOIT_buildings` was not
loaded.** Its Back Bay extract is still on disk from the Stage 1A audit at
`research/gis-stage1a/cache/doit_buildings_4326.json`; it remains LEGAL-UNKNOWN, audit-only, and
`research/gis-stage1c/sources.mjs` never opens that path. No runtime request, no BUILDING_ID, no geometry.

MassGIS `LOCAL_ID` is blank or whitespace on **34 of 169** structures. Normalised to `null` on load, so the
Stage 1A.1 defect — whitespace being truthy in JS and collapsing 34 structures into one building — cannot
recur here.

## E. Phase 1 — the current procedural streetwall

389 procedural visual units in the box, of which 361 render, across **43 block faces** totalling **3,132 m**
of frontage; 42 of 43 faces are fully contiguous. A block face is one `(edgeId, side)`; its parcels are
ordered by **Boston's own frontage chain**, the same exact-endpoint relation `Buildings._superblocks` already
uses to walk a row of lots. No second street graph was invented. Each parcel's outward normal is taken from
its own construction, `polygon[3] − polygon[0]`, which is how `RoadNetwork.buildPlots` extrudes a lot away
from the road.

## F. Phase 2 — street-facing envelope extraction, and a method that had to be thrown away

**No step assumes the road-facing edge of a polygon is the ground facade.** What is extracted is a road-facing
*envelope*: a support position, a tangential span and an orientation.

The first implementation picked, for each polygon, its widest street-facing edge within a normal band. It was
wrong in a way worth recording: **for a building on the far side of a block, its rear wall's outward normal
points back toward this face**, so it scored as perfectly street-facing. The median current-to-factual
displacement came out at +15.6 m — a whole building depth — because half the measurements were of the backs
of other people's houses. The number looked plausible and was meaningless.

The replacement is a **first-hit ray profile**, and it cannot make that mistake because something is in the
way: from each point along the current procedural frontage, sampled every 1.0 m, walk outward and record the
first factual polygon boundary met, over `d ∈ [−15, +45] m`. The band's near end sits just inside the far
kerb, so opposite-side buildings are structurally excluded. Sign convention: `d > 0` is outward, away from the
street; `d < 0` is toward the carriageway.

3,151 samples. **Both sources see a wall at 86.0%** of them; one only at 3.8%; neither at 10.2%.

## G. Phase 3 — source-to-source agreement

| measurement | n | p10 | p50 | p90 | max |
|---|---|---|---|---|---|
| **\|PDDL − MassGIS\| first-wall disagreement** | 2,711 | 0 | **0** | 17.80 | 55.72 |
| \|PDDL − MassGIS\| face wall-slope | 41 | 0 | **0.25°** | 15.30° | 73.59° |
| current → factual displacement | 2,711 | −11.60 | 4.75 | 32.31 | 44.86 |
| PDDL first wall vs current wall | 2,805 | −12.72 | −0.40 | 30.75 | 44.86 |
| MassGIS first wall vs current wall | 2,736 | −11.74 | 5.72 | 34.62 | 44.86 |

**Agreement is sharply bimodal:** within 0.25 m on **79.6%** of samples, 0.5 m on 79.9%, 1 m on 80.0%, 2 m on
80.8%, 5 m on 82.0%. Either the two sources agree to a quarter of a metre or they miss each other by a
building; there is almost nothing in between. Neither source is treated as ground truth — the comparison is
symmetric and the disagreement is reported as a magnitude.

Tangential-span disagreement and orientation are likewise tight where the sources agree at all: face
wall-slope disagreement has a median of 0.25°, and the factual street-facing edges sit a median 1.62° off
Boston's own frontage tangent. **Direction is not the problem. Position relative to the road is.**

## H. The decisive diagnostic — building line, or road placement?

The phase-3 profile says the factual wall sits metres from Boston's. Two explanations, and the stage turns on
which: *(a)* Boston's buildings are set back wrongly — the error Stage 1C exists to fix; or *(b)* Boston's
road is not where the real road is, so the factual wall lands inside the carriageway. Two tests separate them
(`research/gis-stage1c/roadcheck.mjs`).

**Test 1 — how much factual building area lies inside a Boston road?** Under *(a)* it should be near zero.

| source | polygons | area | inside corridor | inside carriageway | wholly clear |
|---|---|---|---|---|---|
| PDDL | 218 | 123,022 m² | **21.0%** | **14.0%** | 72 |
| MassGIS | 169 | 213,790 m² | 13.1% | 8.7% | 49 |

**Test 2 — decompose each road's two displacements** into a SHIFT component `(d₀ − d₁)/2` (centreline
misplacement) and a WIDTH component `(d₀ + d₁)/2` (genuine setback difference). Measured over the 16 roads
with both faces present: **\|SHIFT\| p50 2.50 m, p90 16.82 m**; **WIDTH p50 −0.72 m, p90 15.67 m**. Both
components are large, and a *negative* median width is the giveaway — see the implied-width table in §A.

The answer is *(b)*, decisively, and it is not marginal.

## I. Phase 4 — the frozen gate and the classification

`stage1c-streetwall/1.0.0`, frozen before any visual work, chosen after the distributions above:

| clause | value | evidence |
|---|---|---|
| `tolM` source agreement | **0.5 m** | agreement is bimodal; **any tolerance from 0.25 m to 2 m selects the same faces**, and 0.5 m is the middle of that dead band |
| `minBothPct` / `minAgreePct` | 80% / 70% | both sources must actually see a wall, and agree over most of the face |
| `maxSlopeDisagreeDeg` | 3° | median disagreement is 0.25°, so 3° is generous |
| `widthTolM` | **4.0 m** | the implied street must be possible |
| `maxShiftM` | **2.0 m** | the road must be where the data thinks it is |
| `minRunM` | 25 m | shorter than this cannot carry a visual verdict |

Clause 1 alone is not enough, and that is the finding of this stage.

| state | faces | frontage |
|---|---|---|
| **STREETWALL_ROAD_FRAME_INVALID** | **16** | **1,183 m** |
| STREETWALL_SOURCE_DISAGREEMENT | 10 | 919 m |
| STREETWALL_NO_OPPOSITE_FACE | 7 | 319 m |
| STREETWALL_SINGLE_SOURCE | 6 | 434 m |
| STREETWALL_ORIENTATION_AMBIGUOUS | 2 | 218 m |
| STREETWALL_NO_SUPPORT | 2 | 58 m |
| **STREETWALL_HIGH_CONFIDENCE** | **0** | **0 m** |

**Ambiguity was not promoted to increase coverage, and no individual street or address was tuned.** The gate
is three generic clauses applied identically to all 43 faces.

## J. Phase 5 — run selection

**Not reached: there is no high-confidence face to select a run from.** Eligible runs ≥ 25 m: **0**.

For completeness, the ranking the earlier clauses produce is recorded in `classify.json`, and the strongest
candidate by coherent frontage × displacement was **Newbury Street face `40|1`, s 83.4–164.7, 81.4 m, 10
parcels, displacement −4.46 m, MAD 1.52** — stable across every tolerance swept. It fails clause 2: Newbury's
`corridorHalf` is 8.76 m, so a −4.46 m correction would place the wall 4.30 m from the road centreline, inside
the 5.90 m carriageway. Boston is not choosing Newbury this time because prior stages did; Newbury simply
ranks first on the metrics, and then fails.

## K–P. Phase 6 and everything downstream — NOT REACHED

No transform was designed, implemented or run. Consequently and deliberately there is:

- **no runtime code, no `?gisStreetwall` flag, no generated data file, no `src/` change of any kind;**
- no run-level normal correction, no orientation or width policy to report;
- no polygon-validity, party-wall, shared-vertex, hero-split or collision result;
- no block-interior hollowing measurement — nothing was moved, so nothing could hollow;
- no headless candidate metrics, no captures, no camera metadata, no per-view verdicts.

Writing a transform whose own input gate reports zero eligible candidates would have produced code that can
never be safely enabled, and captures that show a change nobody has evidence for. Items 24–36 and 40–50 of
the final report are **N/A by that decision**, and are listed as such rather than filled in.

**Default-off parity is nevertheless verified**, because Stage 1B/1B.1 code is still present: `src/` is
byte-identical to `e66f1d8`, and the Stage 1B.1 harness re-run confirms **all 23 invariants**, control
10,278 specs / 361 in box / histogram `{4: 361}` / fingerprint `d11b7b148b2b5112`. The failed whole-footprint
prototype remains **DEFAULT OFF** and untouched; nothing in Stage 1C enables it or depends on it.

## Q. What road registration would unlock

The useful number for the next decision. Applying **only** the source-agreement and orientation clauses, and
ignoring the road frame entirely:

| | |
|---|---|
| faces passing | **23 of 43** |
| frontage passing | **1,502 m of 3,132 m = 48.0%** |
| runs ≥ 25 m | **17** |
| longest run | **81.4 m** |

That is the value currently locked behind road placement, and **nothing short of road registration releases
it.** The size of the registration problem is also measured: per-face median displacement p50 **9.12 m**,
p90 20.22 m, max 38.73 m.

## R. Durable results, preserved and added to

Preserved from earlier stages, not re-proved: Boston's facade grammar consumes irregular factual geometry; no
second renderer or dependency is needed; offline normalised GIS enters the runtime cleanly; default-off parity
can be exact; hybrid fallback is architecturally viable; full factual footprint replacement is not viable with
Roof Breaks semantics.

Added by Stage 1C:

1. **The two allowed sources cross-validate each other at 0.25 m on 79.6% of Back Bay frontage.** That is new,
   and it is the first time either source has been checked against the other on geometry rather than identity.
2. **Boston's road network is not in registration with the factual layer** — 21% of factual building area
   falls inside a Boston road corridor, 14% inside a carriageway, and six Back Bay streets have an implied
   factual width between −6.3 m and +2.6 m against a procedural 17.5 m.
3. **A first-hit ray profile is the correct way to measure a streetwall** against a polygon layer; the
   nearest-edge method silently measures the backs of far-side buildings.

## S. Roads, terrain, collision, height

Untouched, all of them. No road, sidewalk, kerb, terrain, water, park, traffic or routing change. No absolute
GIS Y, no ground elevation, no height migration, no collision change. No new dependency, no `npm install`, no
second WebGL context — no WebGL context at all this stage.

**FACTUAL STREETWALL EXPOSES BASELINE ROAD ERROR** is recorded as the stage's principal finding rather than as
a footnote, and is deliberately not acted on.

## T. Stage 1C verdict — **FAIL**

Against the brief's own FAIL list, the first entry applies exactly: *"sources cannot support a defensible
street-facing constraint"*, and so does *"improvement requires road migration before it can be judged"*.

This is a FAIL of the hypothesis at its gate, not a failure of engineering, and not a resource block. The
question *"can factual GIS improve Back Bay streetwall X/Z placement without using factual building depth?"*
has a measured answer: **not while Boston's roads are where they are.** The constraint exists, both sources
agree on it, and it is expressed in a frame Boston does not share.

## U. Owner visual acceptance — **OUTSTANDING**

No captures exist to accept. Nothing here self-authorises anything.

## V. Exact next decision required

Stage 1C closes the streetwall-position line of attack for as long as the road network is unregistered. The
blocker has moved once again and is now named precisely: **it is the roads, not the buildings, and not the
building data.**

Three options; the Owner's decision is which, if any, to authorise:

1. **Stop the GIS hybrid programme here.** Four bounded stages have converted an open question into two
   specific negative results and one measured positive. The default-off Stage 1B/1B.1 prototype and these
   measurements remain as the record. *This is the recommendation.*
2. **Authorise a bounded ROAD-REGISTRATION study** — read-only, no runtime change — to measure whether Boston's
   Back Bay road graph could be brought into the factual frame at all, and at what cost to everything anchored
   to it (parcels, sidewalks, traffic, routing, props, spawns, the hero district). Stage 1C has quantified the
   prize (48.0% of frontage) and the gap (p50 9.12 m). Note this is explicitly *not* authorised by anything
   written so far, and it is a much larger blast radius than any stage to date.
3. **Use the factual data for something that does not need the road frame.** The source-agreement result is
   frame-independent: it says the two layers describe the same walls. Whether that is useful for anything
   other than streetwall placement is an open question this stage did not ask.

**Not authorised and not recommended under any option:** citywide rollout, North End, road migration, width or
orientation correction, factual Y, collision migration, default-on, or deployment.

---

*Stage 1C. No runtime code was added. Boston is bit-for-bit the city it was at `e66f1d8`. Not pushed, not
deployed, not enabled.*
