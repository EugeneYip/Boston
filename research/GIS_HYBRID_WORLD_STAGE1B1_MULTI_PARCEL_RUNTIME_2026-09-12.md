# Stage 1B.1 — transactional replacement + safe multi-parcel association

**Date** 2026-09-13 · **Baseline** `2d05bc771343c5343a816d9ed48eed4def184ca4` (HEAD == origin/main, clean, 0/0)
**Scope** Back Bay only · X/Z only · default OFF · reversible · local, unpushed.
**No** citywide migration, North End runtime, road/sidewalk/terrain/collision migration, vertical GIS,
MapLibre, second renderer, new dependency, or deployment.

---

## A. Executive verdict

# FAIL

**The engineering worked. The city got worse.**

The transactional fix succeeded completely and the association model is sound, deterministic and
conservative. But when eight factual Back Bay footprints actually reached the screen, **two of the four
primary views were materially worse**, for a reason that no association gate can repair:

> **A factual footprint carries 52.6% of the mass of the procedural building it replaces.** Boston's
> road-derived lot is 22.2 m deep and its building fills it; the roof-break outline is 8.4–14.1 m deep.
> Suppressing the lot and drawing the outline **hollows out the block interior**. Measured per building the
> ratio is 0.46–0.65, median **0.49** — it is systematic, not a bad draw.

The streetwall itself survived: the frozen gate bounded street-facing voids to 26.8 m² across all eight, and
at eye level the change is barely legible. **The void appears behind the streetwall**, and from any camera
above eye level it reads as a large empty lot in the middle of a Back Bay block — 659 m² of bare ground where
the control has continuous rowhouse mass. That is visible in views A and C and it is not subtle.

| Stage 1B defect | Stage 1B.1 outcome |
|---|---|
| 2 accepted replacements suppressed parcels and rendered nothing | **Fixed.** 23 invariants hold; `361 − 8 + 8 = 361`; 0 suppressed-without-replacement. The failure mode cannot recur. |
| 77 of 110 candidates found no single parcel to replace | **Diagnosed, not cured.** Share-and-margin ownership finds claims for 19 candidates; the void audit then rejects 11. |
| 3.3% of Back Bay changed, too little to judge | **Enough to judge, and the judgement is negative.** 8 buildings on one Newbury face — **39.8% of its frontage**, longest run **41.3 m / 5 buildings** — which is exactly the coverage Stage 1B lacked. |

Two further results are worth as much as the verdict:

- **Multi-parcel association does not survive its own safety audit in Back Bay.** Every claim of 2 or more
  parcels leaves a streetwall void. At the frozen gate **zero multi-parcel replacements** are accepted, and the
  sweep in §H shows that holds at every threshold tested — it is not an artefact of the one chosen.
- **The procedural facade grammar is not the problem.** Irregular factual rings of 10–27 vertices went through
  clip, `_respec`, `makeSpec` and `_fitOrnament` with zero triangulation or facade failures, draw calls within
  1, and brick, cornices, stoops and mansards intact. Stage 1B's positive result stands and is reconfirmed.

**I was wrong about one thing in my own gate, and it is the thing that decided the stage.** I measured the
bare ground, found 62.8% of it lay 14 m or more behind the frontage, and reasoned that it was "invisible from
the street" — so the frozen gate bounds voids only within 4 m of the frontage line. That reasoning holds for a
pedestrian camera and fails for every other camera. The interior void was measured at 659 m² before any
capture was taken; it was classified as harmless, and it is not.

## B. Baseline

`/Volumes/Projects` mounted; toplevel `/Volumes/Projects/boston`; **HEAD == origin/main == `2d05bc7`**; clean;
0 ahead / 0 behind; no merge or rebase state; remote `EugeneYip/Boston`. Three auxiliary worktrees
(`affectionate-franklin-4c66db`, `distracted-euclid-84fb05`, `zen-wilson-f0bc3d`) present and **untouched**.

## C. Resource gate

Checked at entry, and again before the capture phase as the brief requires.

| | Stage 1B window (passed) | Stage 1B.1 blocked attempt | Stage 1B.1 entry | before capture |
|---|---|---|---|---|
| memory free | 48–49% | 30% | 32–36% | see §V |
| swap headroom | 1,422 MB | **306 MB** | **1,126–1,286 MB** | see §V |
| load 1-min | 3.01 settling | 6.43 settling | 4.20 → 3.79 settling | see §V |
| `xcodebuild` | absent | **running** | **absent** | see §V |

Entry gate **passed**: the disqualifier that blocked the previous attempt — an active Xcode build — was gone,
swap headroom had recovered to within 90% of the Stage 1B window, and load was settling. No App-development
process was touched at any point.

## D. The two Stage 1B defects, at root

**1. It suppressed before it knew.** `GisBackBay.apply()` took a `survives()` predicate that replayed the
corridor clip and `makeSpec`'s footprint minimums. `Buildings._buildSpecs` also runs `_respec`, `_districtOf`,
`orientOutward` and `_fitOrnament` afterwards, and none of those was replayed. Two candidates died in the
stages the predicate did not model, after their parcels had already been dropped from the plot array. The bug
is not that the predicate was too short. **Any predicate that enumerates the ways a pipeline can say no is one
refactor behind the pipeline.**

**2. It asked the wrong geometric question.** Association was `parcel centroid inside footprint, or ≥3 corners
inside`. Measured on the real parcels: Boston's Back Bay lots are **8.3 m wide and 22.2 m deep** (median) and
the factual rowhouses are comparable in area — median **146 m²** against **183 m²** — but laterally offset by a
median **5.0 m** (2.3 m along the street, 2.6 m across it). On geometry like that a real building routinely
holds half of one lot and a tenth of its neighbour, and centroid membership is close to a coin toss. That is
the whole of the "77 candidates had no parcel" result.

## E. Transactional replacement design

The seam moved, and it is smaller than Stage 1B's.

`Buildings._buildSpecs` had its per-parcel loop body extracted verbatim into **`_specFor(plot, seed)` →
`{spec, clipped, dropped}`**. Nothing else about it changed; the citywide baseline is bit-for-bit identical
(§Q). The GIS call then moved out of `_collectPlots` and into `_buildSpecs`, **after `_superblocks`**, and is
handed `_specFor` itself:

```js
const r = gisApply(parcels.slice(0, n), (plot, i) => this._specFor(plot, seedOf(plot, i)));
…
for (let i = 0; i < n; i++) {
  if (gisSuppressed && gisSuppressed.has(parcels[i]?.id)) continue;   // only what was replaced
  …
}
if (gisSpecs) for (const s of gisSpecs) specs.push(s);
```

Two things follow from that placement and both are load-bearing:

- **Materialisation is the real thing, not a model of it.** `apply()` calls `specFor` on the candidate plot and
  keeps the returned spec. A candidate that fails anywhere in the pipeline returns `null`, is recorded as
  `materialization-failed`, and **suppresses nothing**. The order is inverted rather than the prediction
  improved.
- **Association is against visual units, not lots.** `_superblocks` fuses runs of Back Bay lots into single
  buildings (26 of them in the prototype box). Stage 1B associated against raw lots and could therefore claim a
  lot that was not itself a building. Post-`_superblocks` parcels are exactly what the player sees.

## F. Proof the transactional holes are gone

`research/gis-stage1b1/validate.mjs` drives the production `_collectPlots` + `_buildSpecs` under Node — once
with no flag, once with `?gisBackBay=1` — and asserts 23 invariants. **All 23 hold.** The decisive ones:

| invariant | result |
|---|---|
| every accepted replacement materialised a spec | 8 = 8 |
| no suppression without a replacement | 8 suppressed, 8 claimed by replacements |
| no parcel suppressed by two replacements | 8 distinct |
| no duplicate factual replacement | 8 distinct ids |
| every candidate lands in exactly one bucket | 8 + 102 = 110 |
| **building-count identity** | **361 − 8 + 8 = 361** ✓ |
| zero materialization failures after the gate | 0 |
| factual buildings are the only non-quads in the box | 8 = 8 |
| no factual building rendered outside the prototype box | ✓ |
| nothing outside Back Bay changed | fingerprints equal |

**Transactional holes: 0. Duplicates: 0. Suppressed-without-replacement: 0.**

**That is not the same as "no visual hole", and the distinction decided this stage.** The invariant proved
above is that every suppressed procedural visual has a materialised factual replacement. It says nothing about
whether the replacement *occupies the same ground*. It does not: 1,381.8 m² of procedural building was
suppressed and 726.5 m² of factual building drawn, leaving **659.3 m² of bare ground**. Of that, 26.8 m² is
within 4 m of the street frontage — which the gate bounded — and the remainder is in the block interior,
which the gate ignored and the camera does not. Safety condition 10, *suppression produces no visual hole*, is
therefore **not satisfied**; see §A and §U.

## G. The multi-parcel overlap model

Intersections are computed with **Sutherland–Hodgman**, clipping the factual ring (arbitrary, 7–80 vertices)
against the parcel. The parcel is the clip polygon because convexity is guaranteed by construction, not
assumed: `RoadNetwork.buildPlots` emits `[p0, p1, p1+out·depth, p0+out·depth]` — a parallelogram — and
`Buildings._fuse` emits the same shape over a collinear run.

**Unions are rasterised at 0.5 m, not summed.** Summing looked obviously right and is wrong: Boston emits one
parcel per road frontage, so where two streets meet, the parcels published for each street **physically
overlap**. Candidate `bb-Bos_0501341000_B0` sums to **165% of its own footprint** across five parcels. A sum
would have over-counted exactly the corner cases where suppression is most dangerous.

Per (candidate, parcel) pair the model records: factual area, parcel area, intersection area,
intersection/factual, intersection/parcel, parcel mass outside the footprint, competing candidates; and per
candidate: claim size, claim union area, factual explained by the claim, and contiguity.

## H. Measured association distributions

110 candidates against 389 procedural visual units in the box (of which 361 render).

- **78 candidates overlap at least one parcel; 32 overlap none at all.** The 32 sit a median **22.3 m** from
  the nearest parcel centroid — about one lot depth. They are block-interior and alley structures, which
  Boston's road-frontage generator never creates. That is a structural absence, not a matching failure, and no
  gate can recover it.
- `intersection / parcel` over all 314 overlapping pairs: **p10 0.039, p25 0.083, p50 0.169, p75 0.264,
  p90 0.548**. Grazes are the common case.
- The histogram has a real break: the 20–25% bin holds **54** pairs and the next two hold **14** and **12**.
  The graze population ends at roughly a quarter of a lot.
- Claiming *every* overlapping parcel still leaves the median factual building **36% outside all parcels** —
  footprints reach into the road corridor and the block interior, where Boston has no lot.

**Where the bare ground goes.** With replacements accepted and rendered, the ground that was covered by a
procedural building and is covered by no factual one divides as:

| distance from the street frontage line | bare area | share |
|---|---|---|
| 0–4 m (**streetwall**) | 281 m² | **10.3%** |
| 4–8 m | 306 m² | 11.2% |
| 8–14 m | 431 m² | 15.8% |
| 14 m+ (block interior) | 1,718 m² | **62.8%** |

Nearly two thirds of it is behind the buildings, invisible from the street; a tenth is in the streetwall,
where it is a defect. **Those two must not be reported as one number**, and the gate acts only on the second.

## I. The frozen safety gate

`stage1b1-assoc/1.0.0`, frozen before any visual work:

| parameter | value | evidence |
|---|---|---|
| `minParcelShare` | **0.30** | above the measured graze population, which ends at the 20–25% bin. Condition 5. |
| `minOwnerMargin` | **0.35** | the constant already accepted in `stage1a2-gate/1.1.0` for the same share-and-margin shape, at zero false merges. Condition 4. |
| `minFactualExplained` | **0.25** | below this the mapping is incidental rather than a replacement. Condition 3. |
| `streetBandM` / `maxStreetBareM2` | **4 m / 12 m²** | the per-candidate street-void distribution is bimodal with a gap from **10.8 m² to 19.3 m²**; any threshold inside that gap selects the same set. Conditions 6 and 10. |
| `minRun` | **2** | an isolated factual building leaves the most bare ground and shows the least. |

**On not tuning.** `minOwnerMargin 0.20` would have produced 13 replacements and a contiguous run of **10**
instead of 5 — visually the better experiment. It was rejected: the two extra buildings are exactly the ones
the 0.35 margin calls contended, and choosing a looser contention rule *because it lengthens the run* is
selecting a threshold from its visual outcome, which the brief forbids. `minParcelShare 0.25` would have given
10 replacements with the same longest run of 5; the more conservative end of the measured break was taken.
Both alternatives are recorded here rather than quietly discarded.

## J. Contiguity

**Boston's own relation, not a new one.** `Buildings._superblocks` already walks runs of lots by exact
frontage-endpoint identity — `byStart.get(ptKey(p.frontage.b))`, bucketed by `edgeId` and `side` — and that
relation is already load-bearing in production. `GisAssociate.frontageChain` rebuilds exactly it, and
`isContiguousRun` accepts a claim only when it has a single member with no predecessor inside the set and
walking `next` from that member visits every member.

Centroid proximity is deliberately not used: two lots across an alley are near each other and are not a run. A
claim spanning two frontages — a building reaching from Newbury through to the alley behind — has two heads
and is rejected. **6 candidates fell back as `disconnected-run`.**

## K. Contention

Ownership is single-valued by construction, so a parcel cannot silently belong to two buildings. **5 parcels
were contended** (leader failed to beat runner-up by 35% of its own share); both affected candidates fell back
procedurally. No contested parcel was assigned.

## L. Overbroad-parcel handling

The `streetwall-void` audit is the overbroad protection, and it is measured on **rendered geometry after every
factual building is placed** — so attached neighbours legitimately cover for each other, which in Back Bay is
the normal case. It runs to a fixed point, dropping the worst offender one at a time and re-measuring, because
removing one candidate changes the evidence for its neighbours.

> An early version capped the loop at 8 rounds against ~20 proposals. It terminated on the cap rather than on
> the gate, and three different thresholds returned identical results — which is what exposed it. The cap is
> now 256.

**9 candidates rejected**, leaving 26.8 m² of street-facing void in total across the 8 accepted. Without this
audit the same association admits 19 replacements and leaves **332.8 m²** — an order of magnitude more. Stage
1B never measured this quantity at all.

## M. Hero / reserved

`heroOverlap` filtering in `_collectPlots` and `isReserved` inside `_specFor` are untouched and still run for
factual candidates exactly as for procedural ones. `apply()` additionally rejects a candidate whose own
centroid is reserved, before materialisation. At the frozen gate **0 candidates fell back for this reason** —
the accepted Newbury set is nowhere near a hero or landmark asset. No special-building rule was weakened.

## N. Candidate and fallback counts

| class | n |
|---|---|
| **total factual candidates** | **110** |
| single-parcel safe | **8** |
| **multi-parcel safe** | **0** |
| materialization failure | **0** |
| contended | 2 |
| weak overlap | 49 |
| overbroad parcel (`streetwall-void`) | 9 |
| disconnected run | 6 |
| incidental overlap | 2 |
| hero / reserved | 0 |
| run too short | 2 |
| **no procedural support** | **32** |
| **actually materialised** | **8** |

8 + 102 = 110, reconciled. Parcels per replacement: **8 × 1** — max 1, median 1.

## O. Street-facing coverage

| | |
|---|---|
| block faces touched | **1** (Newbury Street, `edgeId 40` side 1) of 43 in the box |
| that face's total frontage | **164.7 m** |
| factual frontage | **65.6 m** |
| **factual share of the face** | **39.8%** |
| **longest contiguous factual run** | **41.3 m / 5 buildings** |
| second run | 3 buildings |
| factual share of Back Bay building count | 8 / 361 = **2.2%** |

This is the one genuine improvement over Stage 1B's shape: Stage 1B's 12 buildings were scattered over
Newbury (8), Boylston (5) and Commonwealth Avenue (1) with no measured run; Stage 1B.1's 8 are all on one
block face, two fifths of it, in a run of five and a run of three.

## P. Replacement ledger reconciliation

Every materialised building records factual id, `LOCAL_ID`, donor plot, claimed plot ids, claim size,
`factualExplained`, ring and spec vertex counts, its own bare and street-bare areas, centroid, height and
storeys. The ledger's `audit.reconciles` asserts all three identities in-process. See
`research/gis-stage1b1/run.json` and `validate.json`.

| id | street | parcels | ring → spec verts | height | storeys | street void |
|---|---|---|---|---|---|---|
| `bb-Bos_0501364000_B0` | Newbury | 1 | 27 → 8 | 14.3 m | 4 | 7.5 m² |
| `bb-Bos_0501365000_B0` | Newbury | 1 | 25 → 7 | 18.0 m | 5 | 0 |
| `bb-Bos_0501366000_B0` | Newbury | 1 | 26 → 8 | 24.5 m | 7 | 0 |
| `bb-Bos_0501367000_B0` | Newbury | 1 | 20 → 8 | 17.1 m | 5 | 0 |
| `bb-Bos_0501368000_B0` | Newbury | 1 | 10 → 8 | 17.2 m | 5 | 8.0 m² |
| `bb-Bos_0501372000_B0` | Newbury | 1 | 22 → 13 | 17.8 m | 5 | 10.5 m² |
| `bb-Bos_0501373000_B0` | Newbury | 1 | 27 → 8 | 13.9 m | 4 | 0.3 m² |
| `bb-Bos_0501374000_B0` | Newbury | 1 | 27 → 5 | 17.7 m | 5 | 0.3 m² |

Heights are 13.9–24.5 m over 4–7 storeys, **all generated by `Facades.makeSpec`** from the donor parcel, as
for every other Boston building. No GIS elevation was consumed — the candidate records carry only
`id, localId, parts, areaM2, ring`, so there is no height or assessing attribute present to consume.

## Q. Default-off parity

| | control (flag absent) | unrelated flag | candidate |
|---|---|---|---|
| `gisLedger` | **null** | **null** | populated |
| citywide specs | **10,278** | 10,278 | 10,278 |
| Back Bay specs | **361** | 361 | **361** |
| in-box vertex histogram | **`{4: 361}`** | `{4: 361}` | `{4:353, 5:1, 7:1, 8:5, 13:1}` |
| non-quad in box | **0** | 0 | **8** |
| city fingerprint | `d11b7b148b2b5112` | `d11b7b148b2b5112` | `a914c97853649c2e` |
| clip stats | `{15, 1, 778, 26}` | — | see §R |

Control matches the pre-change baseline exactly — 10,278 / 10,944 / 361 / `{clipped 15, dropped 1, trimmed
778, superblocks 26}` — which is also the figure the Stage 1B browser run measured. `?gisBackBay=true` is
accepted as well as `=1`. **No GIS network request exists**: the data is a static ES module and the adapter
contains no `fetch`, `XMLHttpRequest` or dynamic `import`.

## R. Runtime structural validation

Ownership is proven primarily by **ledger reconciliation** (§P), with the non-quad histogram as a second,
independent channel: baseline Back Bay is 361 buildings and **every one is a 4-vertex quad**, because every
baseline building is a road-derived parcel. Any non-quad in the box is therefore necessarily factual. Observed:
**8 non-quads, one per ledger entry, each carrying its `gisCandidateId`**.

The Stage 1B detectors that proved misleading — centroid-in-ring, and exact vertex signature — are not used.


Two Stage 1B.1 measurement traps are recorded because each nearly produced a wrong conclusion:

1. **A whole-frame pixel diff localised nothing.** Every view reported a changed bounding box covering the
   entire frame at 11–14% of pixels. That is film grain — re-randomised every frame, as the capture harness
   itself documents — plus actors spawning differently across two page loads. The changed region was found
   instead by **projecting the eight buildings' world vertices through the shot camera**, which does not
   depend on pixels at all.
2. **An A/A floor was established before any A/B claim.** Two captures of the identical candidate state differ
   by mean 1.63 and 0.59% of pixels over 32. Control vs candidate differs by mean 9.05 and **7.78%** — 13× the
   floor on that metric. Without the floor the A/B number would have meant nothing.

## S. Fixed viewpoints

Derived **from the accepted geometry**, not chosen in advance — `research/gis-stage1b1/views.mjs`. Stage 1B
reused viewpoints fixed before the replacements were known and two of them contained no factual content.

All shots: `tod 10.5`, `weather clear`, `quality high`, `warmup 26`, `holdActors true`, canvas 1350×840
(CSS 900×560), server `npm run verify` on port 5290.

| id | brief class | pos | look | fov | factual vertices on screen |
|---|---|---|---|---|---|
| **A_overview_run5** | D higher / overview | −1076, 66, 545 | −1080, 2, 498 | 55 | 124 |
| **B_street_newbury** | A primary streetwall close | −1050, 13, 508.7 | −1098, 6, 506 | 58 | 103 |
| **C_overview_run3** | B second streetwall | −1124, 66, 562 | −1128, 2, 515 | 55 | 119 |
| **D_oblique_block** | C oblique block | −1030, 40, 520 | −1100, 4, 500 | 55 | 130 |

All eight replaced buildings are inside the frustum in **every** view, verified by projection rather than by
eye. Camera placement is constrained by the street itself: Newbury's corridor is ~18 m wide, so a camera more
than ~9 m off the centreline lands inside a block — three trial positions were discarded for standing inside a
parked truck or on a roof, and none of those frames is presented as evidence.

## T. Paired visual A/B

Control `flag absent` and candidate `?gisBackBay=1`, identical camera, FOV, viewport, time of day, weather and
quality. Same-session toggling is impossible: the flag is read at boot, so the pair is two page loads, which
is why the A/A floor above was necessary. Raw PNGs are local only, in
`research/gis-stage1b1/captures/`; paths, sizes, SHA-256s and camera state are committed in
`research/gis-stage1b1/captures.json`.

| view | control | candidate | draws | tris |
|---|---|---|---|---|
| A_overview_run5 | `11c91228289458a5` | `d749020082bb83a0` | 581 → 580 | 3.86M → 3.71M |
| B_street_newbury | `15bd87ef9553408d` | `996d2139d9307a0b` | 608 → 608 | 3.92M → 3.91M |
| C_overview_run3 | `4c514d28757c782e` | `1d10c3abac6f9634` | 575 → 575 | 3.89M → 3.89M |
| D_oblique_block | `106fd1e8eaa491f4` | `b0eb5ef83eb50ef3` | 614 → 614 | 4.25M → 4.24M |

Both candidate captures of view A (original and after a forced extra settle) agree to within the A/A floor,
and at capture time `api.settled()` was **true**, all 15 in-area chunks were at their wanted LOD with **0
pending**, and `glFaults` was `[]`. **The void is geometry, not streaming.**

## U. Per-view verdicts

| view | verdict | evidence |
|---|---|---|
| **A_overview_run5** | **MATERIALLY WORSE** | The control block is a continuous run of rowhouses with party walls, back extensions and an unbroken roofline. The candidate opens a flat empty lot across the middle of the block, with pedestrians standing in it. The replaced buildings are visibly narrower and roughly half as deep. |
| **C_overview_run3** | **MATERIALLY WORSE** | Same defect on the second run: a large bare rectangle replaces roofs and chimneys on the right of frame. |
| **D_oblique_block** | **NEUTRAL** | Along the street the two read as the same city. Rooflines differ slightly and the candidate's massing is marginally more varied; no void is visible at this angle because the streetwall hides it. Art direction, brick, cornices, bays and mansards all intact. |
| **B_street_newbury** | **AMBIGUOUS — view failed** | Newbury's street trees fill the frame. The canopy is identical in both frames so the pair is valid, but it occludes the run and the view cannot support a judgement. Recorded as a failed view rather than dressed up as neutral. |

**Streetwall position, setback, corner geometry, facade rhythm, facade deformation, micro-facets, obviously
artificial polygons:** no defect found. The factual polygons are handled by the existing grammar as cleanly as
Stage 1B reported. **Building-to-building spacing, block rhythm, public-realm spacing and visual continuity:**
degraded, by the mass loss above. **Roofline:** slightly more varied in the candidate, a genuine small gain.
**Holes:** present, in the block interior. **Duplicates:** none.

No view was materially better. **The gain is real but small (roofline variety, footprint irregularity); the
regression is large and structural.**

## V. Performance / complexity, and the resource state

Draw calls move by **at most 1** across all four pairs; triangle counts move by ≤0.15M and, per the project's
own instrumentation caveats, are shadow-cascade-phase dependent and must not be read as a per-building cost.
No new material, mesh, renderer or dependency. Candidate data payload unchanged at 54.8 KiB for 110 buildings.
One WebGL context throughout.

`clipStats.trimmed` rose **778 → 852** with the flag on: factual footprints sit closer to the pavement, so
`_fitOrnament` shortens more stoops and bows. Expected, handled by existing machinery, recorded.

Resource state, checked before and after the capture session as the brief requires:

| | entry | before capture | after capture |
|---|---|---|---|
| memory free | 32–36% | 30–38% | 28% |
| swap headroom | 1,126–1,286 MB | **1,628 MB** | 790 MB |
| load 1-min / 5 / 15 | 4.20 → 3.79 | 9.71, falling from 19.95 | 3.86 / 7.21 / 11.07 |
| `xcodebuild` | absent | absent | **3 running** |

The gate was re-checked mid-stage when the machine deteriorated sharply — swap headroom fell to 426 MB with
three `xcodebuild` processes running — and the capture session was **held** until `xcodebuild` had finished and
headroom had recovered past the Stage 1B window's 1,422 MB. It then ran inside that window. A further Xcode
build started again *after* the captures were complete, which is why the "after" column is worse than the
"before" one; it did not touch the evidence. No App-development process was touched at any point, and the
preview server and the local capture sink were shut down immediately afterwards.

Rendering was stable throughout: `glFaults` empty on both page loads, no context loss, every chunk at its
wanted LOD with 0 pending, `api.settled()` true at capture, and an A/A floor of 0.59% against an A/B signal of
7.78%. No capture was retried for instability and none was discarded after the fact.

## W. Roads / terrain / collision exclusions

**Nothing was migrated.** Roads, sidewalks, kerbs, terrain, water, parks, traffic, pedestrian routing and
landmarks are untouched. Y, storeys and base elevation remain procedural; no GIS elevation, no vertical datum
assumption, no City DOIT attribute — the candidate records carry only `id, localId, parts, areaM2, ring`, so
there is nothing of that kind present to consume.

**Collision was not migrated.** A replaced building's colliders still follow the baseline parcel and therefore
extend to the full 22.2 m lot depth while the visible mass stops at 8–14 m. Visual and collision geometry
differ by construction in this prototype. All judgement used fixed cameras; no free-roam validation was
attempted and no collision mismatch was read as a visual result.

**Road mismatch exposed:** none newly. Corridor clipping stayed at 15 (Stage 1B saw it rise to 24), because
the frozen gate happens to select footprints that sit clear of the carriageway. The Commonwealth Avenue
confounder never entered — no candidate there survived the gate.

## X. Stage 1B.1 verdict — **FAIL**

Against the brief's own criteria:

| PASS requirement | met? |
|---|---|
| resource gate healthy enough for reliable capture | yes |
| default-off parity preserved | yes — exact, fingerprint-identical |
| materialize-first / suppress-second enforced | yes |
| 0 suppression holes | **transactionally yes; visually no** (659 m² bare) |
| 0 duplicate replacements, 0 suppression without replacement | yes |
| multi-parcel association deterministic and conservative | yes — and it accepts nothing |
| contention handled fail-safe | yes |
| no unsupported factual identity introduced | yes |
| procedural fallback preserved | yes — 102 of 110 |
| one coherent block face at decision-useful coverage | **yes** — 39.8%, run of 41.3 m |
| paired A/B complete for primary views | yes, with view B failed and declared |
| **material improvement in at least one primary view** | **no** |
| **no primary view materially worse** | **no — two are** |
| existing procedural art direction survives | yes |
| no road / terrain / collision migration needed | yes |

The brief lists *"candidate looks materially worse"* under FAIL, and two primary views are. **FAIL.**

This is a FAIL of the hypothesis, not of the machinery. The question "does authoritative X/Z geometry produce
a visibly better Back Bay?" now has a measured answer — **no, it produces a visibly worse one** — and the
reason is a single number that any successor can check in one command: **52.6%**.

## Y. Owner visual acceptance — **OUTSTANDING**

Nothing here self-authorises anything. The prototype remains **DEFAULT OFF**, unpushed, undeployed. The
captures are local at the paths in `captures.json` for the Owner's own review; the Owner may disagree with the
per-view verdicts, which is exactly why the raw pairs were kept.

## Z. Exact next decision required

Stage 1B.1 closes the "replace a procedural building with a factual footprint" line of attack. The measured
blocker is **mass, not position**: the geometry is in the right place and is the wrong size, because a
roof-break outline is not a ground footprint — which Stage 1A.1 established and this stage has now confirmed
visually.

Three options, and the Owner's decision is which (if any) to authorise:

1. **Stop here.** The hybrid question has been answered for Back Bay at a cost of four bounded stages. The
   default-off prototype and its measurements remain as the record. *This is the recommendation.*
2. **Change what is replaced, not how.** A factual footprint could drive the **street-facing wall line only** —
   position, width and frontage angle — while the procedural system keeps lot-filling depth. That would take
   the part of the data that is trustworthy and leave the part that is not. It is a different experiment with
   a different runtime seam, and it is not authorised by anything written so far.
3. **Change the source.** Seek a true ground-footprint layer rather than a roof-break outline. Stage 1A's
   licensing work would have to be redone for whatever that source is, and the City `Assessing/DOIT_buildings`
   service remains **LEGAL-UNKNOWN** and must not become the answer by default.

**Not authorised and not recommended under any option:** citywide migration, default-on, North End runtime,
road/terrain/collision migration, push, or deployment.

---

*Stage 1B.1. Candidate code is committed **default OFF**. Not pushed, not deployed, not enabled. Boston
without the flag is bit-for-bit the city it was at `2d05bc7`.*
