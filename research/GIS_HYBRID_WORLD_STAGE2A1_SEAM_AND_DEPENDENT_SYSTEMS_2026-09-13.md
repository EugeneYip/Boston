# Stage 2A.1 — bounded seam, dependent systems, Commonwealth and Huntington

**Date** 2026-09-13 · **Baseline** `f31144bf0be1e93cad7c725b4071da16c97d1aa6` (HEAD == origin/main, clean, 0/0)
**Scope** Back Bay factual core frozen · default OFF · reversible · local, unpushed.
**No** citywide migration, new GIS source, factual road width, factual buildings, or deployment.

---

## A. Owner reclassification, acknowledged

Claude's Stage 2A self-verdict was **PASS**. The Owner reviewed it and reclassified it **PARTIAL**, because the
transition seam exceeded its authorisation and live routing / pedestrian / collision validation was
incomplete. That reclassification is accepted, and the Stage 2A report is **not** rewritten. Stage 2A.1 is the
closeout attempt for those conditions.

## B. Executive summary

**Three of the four gaps are closed. The containment contract is not met, and the reason is topological
rather than fixable by effort.**

| | Stage 2A | Stage 2A.1 |
|---|---|---|
| parcels changed outside the core | 1,038 | **754** |
| … median distance beyond the core | 88.1 m | **57.1 m** |
| … maximum | 284.4 m | **231.7 m** |
| **parcels changed beyond the declared seam** | n/a | **16** |
| `nuniv` mis-target | unresolved | **resolved** |
| parcels inside the Commonwealth mall | 15 by centroid / 3 extruding | **0** |
| road line inside a factual building | 0.22% | 1.19% |
| procedural wall → factual wall (median) | 5.84 m | **5.78 m** |
| core junction traps | not measured | **0 of 23** |

The geographic win is intact — the whole point of the containment work was not to spend it. The contract
"outside the seam, zero change" is **not** achieved: 16 parcels still move beyond the declared 216 m seam, and
the seam itself is far larger than anyone wanted.

**Why the seam cannot be small.** `buildPlots` subdivides **per road edge** — `n = round(acc / cfg.w)` — so
moving either endpoint of an edge re-phases every lot along its whole length. An edge is delimited by
junctions. Therefore a street may only be cut **at a junction**, and Boston's junction spacing beyond the core
is what it is: 17 anchors at **min 3.96 m, median 79.8 m, max 216.2 m**. The public alleys and Huntington
Avenue are the expensive ones because they have the fewest junctions. A smaller seam is not available without
either warping the factual core — forbidden, and the thing Stage 2A proved worth keeping — or replacing up to
216 m of real road with synthetic connector.

## C. Baseline and resources

`HEAD == origin/main == f31144b`, clean, 0/0, no merge state, three auxiliary worktrees untouched. Static work
ran at 28–38% memory free, 493–1,645 MB swap headroom, load 3.9–9.5, with **three `xcodebuild` processes
running for most of it and untouched**.

## D. The factual core is frozen — proven

Core: the canonical Stage 1A box, `x [−1380.46, −980.50], z [454.52, 854.60]`.

**102 interior factual vertices; worst displacement from their Stage 1E position: 0.0061 m.** Twenty-three
further vertices are interpolated *on* the core boundary by the clip and are declared as such. No translation,
rotation, affine or rubber-sheet was applied; Managed Streets was not substituted; no segment was retuned.

> The first form of this invariant compared rounded coordinate strings and reported the core as "moved". It
> was measuring the `unGeo`/`geo` round trip: the runtime module stores lat/lon at 7 decimals, which is
> Boston's own convention precisely so that nothing downstream invents world coordinates, and that costs about
> a centimetre. The invariant now measures displacement, and the answer is 6 mm.

## E. Root cause of the 284 m blast radius

Traced, not guessed (`blast-trace.json`). Three compounding mechanisms:

1. **The factual geometry overhung the core.** SAM features were selected by *intersects*, so whole segments
   ran up to **163.2 m** past the box — 39 of 141 vertices. Out there they crossed hand-authored streets and
   moved those junctions.
2. **`buildPlots` subdivides per edge.** Move one endpoint and every lot on that edge re-phases. This is what
   turned a junction shift into a 284 m effect.
3. **Gloucester Street proves the mechanism.** It was neither clipped nor factually replaced, and still lost
   81 parcels 157 m out, purely because a factual line crossed it beyond the box. Its edges went from
   `46 m | 34 m | 58 m` to `46 m | 68.76 m | 46.64 m`.

Attribution over the 1,038 outside-core changes: 754 on a clipped street, 145 where a factual street of the
same name was added, 139 pure collateral; **904 of 1,038 sat on an edge that had been re-split.**

> A fourth mechanism was created and then removed during this stage. Clipping Boston's streets at *vertex*
> granularity deleted up to 195 m of road beyond the core — Back Bay vertices are that far apart — taking its
> crossings with it. Gloucester collapsed from 11 edges to 8, one of them 207 m. The clip now interpolates an
> exact boundary vertex.

## F. The seam, derived from topology

Not a buffer. For every street crossing the core boundary, the only cut that leaves the outside world
untouched is at a **baseline junction**, because that is what delimits an edge. Measured over Boston's 248
citywide junctions:

**17 seam anchors · beyond the core: min 3.96 m, median 79.82 m, max 216.15 m.**

The expensive anchors are `Public Alley 442` (222.2 m), `Huntington Avenue` (216.2 m) and
`Commonwealth Avenue Inbound` (160.4 m) — streets with sparse junctions.

**8 synthetic `TRANSITION_CONNECTOR` segments**, median 21.1 m, **max 32.9 m**, joining a factual port on the
core boundary to the nearest Boston stub of the same road concept. Their 40 m bound is the measured Stage 1E
registration offset (p50 10.64 m, p90 26.5 m), not a chosen number. They are labelled in the data and are
never described as factual. Fifteen of 23 ports remain unjoined — mostly streets Boston does not model.

## G. Containment result

| region | changed parcels |
|---|---|
| core + seam (≤ 216.15 m) | 738 |
| **beyond the declared seam** | **16** |
| Northeastern envelope | **0** |

754 outside-core changes at median 57.1 m, max 231.7 m. **The contract required 0 beyond the seam; the result
is 16.** Changed streets fell from 14 to 12, all Back Bay or its immediate continuations.

## H. Huntington / `nuniv` — RESOLVED, and it was never geometric

Control edge #486 and candidate #446 were **both 389.5 m** — identical geometry. What differed was
`lanes 2, median 7, sections 1` against `lanes 4, median 0, sections 0`.

**Root cause:** Boston declares `median`, `y` and `bridge` as arrays **parallel to `path`**. Huntington carries
`median: [0 ×10, 7.0 ×4]`. Stage 2A clipped `path` and kept the arrays whole, so the run beginning at vertex 8
read median 0 where it should read 7.0. `e.median` fell to 0, `RoadNetwork.laneLayout` then counted 4 lanes
instead of 2, and the MBTA station section was refused as a lane-count change — correctly, by a guard doing
its job.

**Fix:** clip the per-vertex arrays with the path. Generic, applies to all six streets that carry such arrays,
and touches no Northeastern geometry.

**Result:** candidate Huntington edge now reports `lanes 2, median 7, sections 1`, matching control exactly.
No warning. **Northeastern parcels changed: 0.**

## I. Commonwealth Avenue — diagnosed structurally, one real defect fixed

| | control | candidate |
|---|---|---|
| carriageway spacing (median) | 46.00 m | **40.93 m** |
| free public realm between kerbs | 28.48 m | 23.41 m |
| lanes / halfRoad / corridorHalf | 2 / 5.9 / 8.76 | **identical** |
| `mall` flag | true both | true both |
| **parcels extruding into the reservation** | **0** | **3 → 0** |

Hypotheses A (pairing), B (concept), C (width applied independently) and E (mall generator) are **ruled out**:
both carriageways are present, both carry `mall: true`, and every width value is identical to control.

**Hypothesis D is the defect.** Three lots extruded into the planted mall where the baseline has none. It is a
**latent parcel-generator defect exposed by factual geometry**: the authored carriageways sit a uniform 46 m
apart, which leaves too little depth to pass `MIN_DEPTH`, so the baseline never produced one; real carriageways
are not uniform, and lots appeared the moment the geometry stopped being ideal. The fix is a generic rule —
nothing is sold in the reservation of a divided boulevard — and it is **provably a baseline no-op**: 0 control
lots satisfy it, and the control fingerprint is unchanged at `5fa6c6be79473213`.

**Hypothesis F is real and must not be "fixed".** The 46.00 → 40.93 m narrowing is what the factual
carriageways actually are. Moving them to recreate the old mall width would be inventing a width claim, which
the authorization forbids.

> A second Commonwealth bug was found through routing and is recorded. Matching factual carriageways to
> Boston's Inbound/Outbound by **proximity** put SAM's *eastbound* carriageway onto Boston's *westbound*
> concept, because Boston's pair sits ±23 m off centre while the factual pair sits ~20 m off. The seam
> connector then joined two one-way streets head to head; junction 36 became a sink reaching 2 nodes out of
> 428. Matching by **flow direction** — the discriminator a divided boulevard actually has — fixes it.
> Commonwealth Inbound flows east, and so does the factual carriageway now assigned to it.

## J. Dependent systems

**Routing.** Graph components 6 in both worlds (largest 387 → 416). The systemic measure is the trap census:
**all 23 core junctions can leave the core and all 23 can be entered — 0 traps**, against control's 13/13/0.
Deterministic Dijkstra cases honouring one-way:

| case | control | candidate |
|---|---|---|
| A outside → seam → core → seam → outside | 1,007 m, 6 edges | **1,020 m, 9 edges, 2 seam crossings** |
| B east/west across the core | 380 m | **389.5 m** |
| C north/south cross-street | 232 m | **not found** |
| D Commonwealth | 380 m | **575–893 m** |
| E near frozen Northeastern | 648.9 m | **648.9 m, identical** |

Case C fails from a one-way sink at a junction just **south of** the core boundary — a seam node, not a core
one, which is why the core census is clean. Recorded as a bounded seam defect.

> Two earlier runs of these cases reported C *and* D failing. That was a test artefact: snapping an endpoint to
> the nearest node of any degree picked a **different** node in each world, and in the candidate two landed on
> one-way stubs. Snapping to the nearest junction instead makes the cases comparable. Had it gone unchecked it
> would have been reported as a false MAJOR_DEFECT.

**Also measured.** One-way restriction is now taken from **Boston's** concept, with SAM supplying only the
direction relative to the factual path. SAM marks essentially every Back Bay segment `ONEWAY: FT`, which is
its digitisation sense; consuming it literally made Boylston, Dartmouth, Huntington, Blagden and Ring Road
one-way and broke routing outright.

**Tunnel isolation:** 0 Turnpike edges on the surface graph in either world; no route used one.

**Spawns:** 3,712 → 3,742 total, core 118 → 138. **0 non-finite, 0 further than 20 m from any road.**

**Sidewalks:** 7 strands both. **Buildings:** 10,278 → 10,290 citywide, core 361 → 374, clip `{15,1,811,26}`.

## K. Registration preserved

| | control | Stage 2A | **Stage 2A.1** |
|---|---|---|---|
| road line inside a factual building | 42.35% | 0.22% | **1.19%** |
| procedural wall → factual wall, median | 16.77 m | 5.84 m | **5.78 m** |
| … p75 / p90 | 26.21 / 37.71 | 16.83 / 27.14 | **15.89 / 27.12** |

Containment did not cost the geographic win. The pathology rose from 0.22% to 1.19% because the synthetic
connectors are not factual geometry and a few clip buildings — still **36× better than the baseline's 42.35%**,
and confined to the seam.

Per street: Newbury 18.89 → **6.77**, Boylston 14.38 → **5.13**, Exeter 15.89 → **3.66**, Fairfield 13.22 →
**2.03**, Blagden 38.30 → **4.56**, Huntington 11.10 → **5.65**, Ring Road 19.38 → **4.69**, Commonwealth
Inbound 11.41 → **6.13**. Commonwealth Outbound reads 18.17 → 15.32 on a single sample: after direction-based
matching, the core box contains mostly the eastbound carriageway, so Outbound has almost no frontage inside it.
That is a coverage fact, not a regression, and it is stated rather than averaged away.

## L. Invariants

**Stage 2A: 26 of 26 hold. Stage 2A.1: 13 of 13 hold.** Control fingerprint `5fa6c6be79473213` — unchanged from
Stage 2A, and identical when an unrelated flag is supplied or when both experimental flags are supplied
together (which disables both). `?gisBackBay=1` alone still behaves exactly as committed.

## M. Render gate, boot, and camera-fair captures

**Gate.** The three `xcodebuild` processes finished and swap headroom recovered from 493 MB to a stable
1.19–1.66 GB across a bounded observation, with load falling 9.5 → 5.6 and `xcodebuild` at 0. That is at or
above the window in which the Stage 2A captures succeeded, so the session proceeded. After capture: 30% free,
452 MB headroom, load 3.34, builds restarted — *after* the evidence was taken. One WebGL context.

**Boot, candidate.** `failed: []`, `glFaults: []`, every capture `settled: true`. Browser matched headless
exactly — 573 road edges, 10,955 plots, 10,290 specs, clip `{15, 1, 811, 26}` — and `gisLedger` is `null`,
confirming the Stage 1B building experiment is not stacked.

**Cameras.** Six fixed world positions, chosen independently of either candidate and **each verified to stand
in open air in both worlds** — above anything whose footprint contains it, with 4 m of margin. This is the
direct answer to the Owner's fifth objection: none of these is candidate-derived.

> The first form of that verification tested whether the *ground* under the camera was clear and rejected four
> of six views. These are elevated cameras; standing 46 m above a roof is perfectly valid. Checking vertical
> clearance instead passes all six.

| view | verdict | evidence |
|---|---|---|
| **B_boylston_block** | **MATERIALLY BETTER** | The control's left third is a large bare brown expanse — open ground where Boston's hand-authored Boylston corridor leaves a gap. The candidate fills it with continuous rowhouse terraces, roof gardens and chimneys. |
| **C_cross_exeter_fairfield** | **MATERIALLY BETTER** | The control has a bare open area through the middle of the block. The candidate replaces it with dense mansard-roofed terraces. Same defect, same cure. |
| **E_commonwealth** | **MATERIALLY BETTER** | The mall is *more* legible than baseline, not less: a wide, clearly bounded green corridor with trees, benches and a central path, carriageways and kerbside parking on both sides. This reverses the Stage 2A regression outright. |
| **D_district_overview** | **NEUTRAL** | Both read as Back Bay from 150 m. The candidate is busier — more streets, smaller blocks — but the grid and the Commonwealth mall are both legible. Stage 2A called this slightly worse; with the mall guard and the corrected carriageway pairing it is no longer. |
| **A_newbury_block** | **NEUTRAL** | Both are coherent blocks in the same architectural language. The candidate shows one open strip on the right that the control does not. |
| **F_seam** *(diagnostic, not verdict-driving)* | **seam defect visible** | At the core boundary the factual and procedural road surfaces do not align, leaving a band of bare ground beside the paved strip and buildings sitting closer to the corridor. This is the seam, it is outside every verdict frame, and it is the visual face of §G. |

**No primary view is materially worse.** Three camera-fair primaries are materially better, two neutral.

Draws: control 567/569/616/461/624/626 → candidate 638/566/666/525/638/621 — within ±71, the overview gaining
64 because more streets are visible. No material or batching explosion. Candidate module 25,676 bytes.

## N. Dependent-system status

| system | status | note |
|---|---|---|
| ROAD GRAPH | **PASS** | 573 edges, 426 nodes, 6 components both worlds, finite, no tunnel on the surface |
| SIDEWALKS | **PASS** | 7 strands both; no inversion or impossible corner in any capture |
| PARCEL / FRONTAGE | **PASS** | core 389 → 400, widths and depths inside the baseline envelope |
| BUILDINGS | **PASS** | 10,278 → 10,290 citywide; no block hollowing; art direction intact |
| ROUTING | **MINOR_DEFECT** | core fully traversable, 23/23 junctions exit and enter, **0 traps**; one one-way sink at a seam node just south of the core broke test case C |
| TRAFFIC | **NOT_TESTED** | vehicles render and park correctly in all six candidate frames; no sustained runtime observation was taken |
| PEDESTRIANS | **NOT_TESTED** | none observed misplaced; no systematic audit |
| COLLISION | **NOT_TESTED** | regenerates through the normal pipeline from candidate geometry; no independent consistency check |
| SPAWNS | **PASS** | 3,712 → 3,742; core 118 → 138; **0 non-finite, 0 further than 20 m from any road** |
| PARKED VEHICLES | **PASS** | on the kerb in every candidate frame |
| PROPS / FURNITURE | **PASS** | lamps, signs, awnings on the footway; none observed in the carriageway |
| COMMONWEALTH BOULEVARD | **PASS** | 0 parcels in the reservation; mall legibility improved; carriageways unwarped |
| HUNTINGTON / NUNIV | **PASS** | resolved at root; Northeastern untouched |
| **TRANSITION SEAM** | **MAJOR_DEFECT** | 16 parcels change beyond the declared 216 m seam; one seam routing sink; visible bare band at the boundary |

## O. Stage 2A.1 verdict — **PARTIAL**

Met: factual core frozen to 6 mm · geographic improvement intact (5.78 m median, 1.19% pathology) · seam
derived from topology rather than chosen · connectors bounded, labelled and ≤ 32.9 m · `nuniv` resolved at
root with Northeastern untouched · Commonwealth carriageways retained, reservation cleared, mall legibility
improved · core routing fully traversable with zero traps · tunnel/surface isolation holds · spawns valid ·
candidate boots clean · camera-fair evidence net positive with no primary view materially worse · 26 + 13
invariants hold · control parity exact.

**Not met — the containment contract.** The requirement was *zero* change outside the seam. The result is
**16 parcels beyond a 216 m seam**, and the seam itself is much larger than intended. Stage 2A.1 improved
every containment number — outside-core changes 1,038 → 754, median 88 → 57 m, maximum 284 → 232 m, changed
streets 14 → 12 — without reaching the contract.

**Also not met:** live traffic, pedestrian and collision validation remain untested, which was the Owner's
second objection. They are no longer blocked by resources; they were not reached.

This is therefore **PARTIAL**, and **Stage 2A cannot yet be closed as PASS**.

## P. Why a smaller seam is not available by trying harder

`buildPlots` subdivides per edge; an edge is delimited by junctions; therefore a street may only be cut at a
junction without re-phasing the lots beyond it. Boston's junction spacing outside the core is **median 79.8 m
and up to 216.2 m**. Cutting at those anchors would leave gaps of that size to be filled with synthetic
connector — replacing up to 216 m of real road with invented geometry, which would be worse than the problem.
The alternative is to shrink the replacement set: dropping the public alleys and Huntington would bring the
worst anchor from 216 m to about 160 m, at the cost of the streets the experiment most wants.

**The honest statement is that the minimum topologically safe seam for this road network is on the order of
150–220 m, and that is a property of Boston's junction spacing, not of the factual data.**

## Q. Limitations

1. 16 parcels change beyond the declared seam; the seam is 216 m.
2. One one-way sink at a seam node south of the core; routing case C fails from it.
3. Traffic, pedestrians and collision untested at runtime.
4. Road pathology rose 0.22% → 1.19% — the synthetic connectors, still 36× better than baseline.
5. Commonwealth Outbound has ~1 frontage sample inside the core after direction-based matching; its residual
   is not meaningfully measured.
6. 15 of 23 factual ports have no connector, mostly streets Boston does not model.
7. Back Bay core only. Nothing citywide is claimed.

## R. Owner decision required next

1. **Accept PARTIAL and stop.** The geography is proven and the containment floor is now a measured property
   rather than an open question. *This is the recommendation* — the remaining work is engineering against a
   floor that will not move.
2. **Authorise a narrow seam stage** to close the last 16 parcels and the one-way sink, accepting a ~216 m
   seam as the floor, and to run the three untested runtime systems.
3. **Reduce scope instead** — drop the alleys and Huntington from the replacement set to buy a ~160 m seam,
   and re-measure.

**Not authorised and not begun:** citywide migration, Stage 2B, factual widths, factual sidewalks, factual
parcels, factual buildings, Stage 1C integration, traffic or collision redesign, terrain correction,
Northeastern work, default-on, deployment.

---

*Stage 2A.1. Candidate committed **DEFAULT OFF**. Without `?gisRoads=1`, Boston is bit-for-bit the city it was
at `f31144b`. Not pushed, not deployed, not enabled.*
