# Stage 2A.2 — seam closure, degree-2 boundary test, runtime acceptance

**Date** 2026-09-13 · **Baseline** `3aae33f436c3bde1e2e12319abb065c40c2a5ba9` (HEAD == origin/main, clean, 0/0)
**Scope** Back Bay factual core frozen · default OFF · reversible · local, unpushed.

---

## A. Executive summary

**The Stage 2A.1 "junction floor" is rejected. It was an implementation limit, not a topological requirement,
and the evidence was already inside Stage 2A.1's own table.**

`buildPlots` lays lots at `k · acc / round(acc / w)` along an edge. Stage 2A.1 concluded that only a junction
cut leaves the outside world alone, so Boston's junction spacing imposed a **216 m** seam. But its own
degree-2 probe showed a shift of **exactly zero** at `splitFrac 0.5` on even-lot edges, and that is the whole
answer: cut at `p = k · step` and `n₁ = round(k·step/w) = k`, so `step₁ = p/k = step` — and
`step₂ = (acc−p)/(n−k) = step` as well. **Both halves keep the baseline phase.** A junction is simply one lot
boundary among many.

Two conditions make it usable and both were measured before being relied on: the phase identity holds for
every real crossing-edge length, and **both sides of every crossing edge have the same frontage length —
delta 0.000 m**, because Back Bay streets are straight, so one cut serves both sides.

| | Stage 2A | Stage 2A.1 | **Stage 2A.2** |
|---|---|---|---|
| declared seam extent | — | 216.15 m | **6.96 m** |
| parcels changed outside the core | 1,038 | 754 | **337** |
| … beyond the declared seam | — | 16 | **295** |
| road-line inside a factual building | 0.22% | 1.19% | **0.22%** |
| procedural wall → factual wall, median | 5.84 m | 5.78 m | **5.83 m** |
| candidate-only dead-end-forward nodes | — | 1 | **2** |

The seam shrank by a factor of 31 and containment roughly halved, **but the contract is still not met**: 295
parcels change beyond the 6.96 m seam, concentrated on four streets. Measuring against the old 216 m envelope
those same changes number 26. Both figures are reported because neither alone is honest.

Registration came back to its best: pathology **0.22%**, matching Stage 2A and recovering the 1.19% that
Stage 2A.1's connectors cost.

## B. Baseline, resources, and the Stage 2A.1 reclassification

`HEAD == origin/main == 3aae33f`, clean, 0/0, three auxiliary worktrees untouched. Stage 2A.1 is accepted as
**PARTIAL**; Stage 2A.2 addresses its five open conditions and does not rewrite it.

Static work ran at 25–38% memory free, 411–1,660 MB swap headroom, load 3.7–13.6, with **three `xcodebuild`
processes running throughout and untouched**.

## C. The factual core is still frozen

Unchanged from Stage 2A.1: interior factual vertices sit within **6 mm** of their Stage 1E positions, the
residue of storing lat/lon at 7 decimals. No translation, rotation, affine, rubber-sheet or source
substitution. Commonwealth's factual carriageways and Huntington's geometry are untouched.

## D. Mission A — degree-2 segmentation

**Q1: can the graph carry a degree-2 segmentation node that is not a physical junction?**
**Yes.** Nothing in `RoadNetwork`, `Navigation` or `Traffic` branches on node degree, and there is no
`Intersection` type keyed to it. A degree-2 node creates no turn choice and no traffic control.

**Q2: does splitting there contain the blast radius?**
**Only if the split lands on the lot grid.** Measured over every edge crossing the core boundary, an
arbitrary interior cut shifts outside lots by **median 1.70 m, max 4.19 m** — against an 8.2 m lot, that
re-positions every building on the frontage. A cut at `k · step` shifts them by **zero**.

So the answer to the brief's question is **yes, with a condition**, and the condition is arithmetic rather
than topological. `DEGREE2_SEGMENTATION_SUPPORTED — on the lot grid.`

## E. Mission B — the seam, and what it did and did not close

**Final seam: the 17 lot-grid cuts, extent 6.96 m beyond the core.** Frozen by the generator before any
containment measurement. Cut offsets from the core crossing: **min 0.46 m, median 3.60 m, max 7.34 m**,
against junction anchors at up to 216.15 m.

Each cut is derived generically: find the baseline edge carrying the crossing, reproduce `buildPlots`'
subdivision of it — including the district lookup, which puts Huntington's long edge in a `null` district
falling back to South End's 7.8 m rhythm — and take the nearest lot boundary lying outside the core. No magic
coordinate, no street-specific placement.

**Result against the frozen 6.96 m seam:**

| | changed | outside core | **beyond seam** | median | max |
|---|---|---|---|---|---|
| road edges | 99 | 31 | **17** | 15.2 m | 160.4 m |
| parcels | 1,123 | 337 | **295** | 41.0 m | 210.6 m |
| building specs | 1,004 | 269 | **238** | 27.7 m | 201.0 m |

Identity-only churn — same geometry, different plot id — is **6,356** and is reported separately, not counted
as movement. `buildPlots` reassigns every plot id by distance from the centre, so adding one parcel in Back Bay
re-seeds the whole city.

> Two measurement errors are recorded because each inflated the answer by an order of magnitude. Including
> spec height in the geometry key counted that seed churn as movement: 12,596 "changes" against 269 real ones.
> And matching parcels by exact millimetre keys called every outside parcel changed even where the edge had
> been restored to the identical whole number of baseline lots — cut points round-trip through 7-decimal
> lat/lon, which costs about a centimetre. Matching by displacement with a 5 cm tolerance, three orders below
> a lot width, is what the remaining numbers use.

**Where the 295 are:** Huntington Avenue 132 (max 210.6 m), Commonwealth Inbound 68 (154.9 m), Dartmouth
Street 53 (63.1 m), Commonwealth Outbound 41 (52.2 m), then Boylston 9, Fairfield 6, Newbury 4, Blagden 4,
Stuart 1. The streets where the lot-grid cut works cleanly — Newbury, Boylston, Fairfield — are down to single
digits from hundreds. The four that remain are those where a factual port still dangles and
`RoadNetwork.build()`'s 21 m endpoint snap pulls it onto an unclipped street, splitting that street mid-edge.
**9 of 23 ports carry a connector; 14 still dangle.** A symmetric second pass joining stub ends back to ports
was written and did not fire; it is left in the workspace as an unfinished lead rather than claimed as a fix.

## F. Mission C — the one-way seam sink, diagnosed

The baseline itself has **44** nodes that can reach ten or fewer nodes forward — map-edge terminations on
Beacon, Arlington, Hereford, Chestnut and others. The candidate has **46**. Both extras are on Commonwealth
Avenue at the southern core boundary:

| node | position | beyond core | forward reach | incoming | outgoing |
|---|---|---|---|---|---|
| **36** | (−1165.93, 450.56) | 3.96 m | 1 | Commonwealth Outbound, Exeter, Commonwealth Inbound | **none** |
| 414 | (−1152.59, 454.52) | 0 m | 2 | Commonwealth Inbound | Commonwealth Inbound |

Node 36 is the sink: three one-way streets arrive at a lot-grid cut and nothing leaves. Connectors exist for
both Commonwealth carriageways but attach at their *other* ports, so this end is unserved. **Not fixed.** The
brief forbids the easy escape — making the street two-way to pass the test — and the correct fix is a
symmetric connector pass that is written but not working.

**Core reachability is nevertheless intact:** all **18 core junctions can leave the core and all 18 can be
entered, 0 traps**, against the control's 13/13/0.

## G. Routing

| case | control | candidate |
|---|---|---|
| A outside → seam → core → seam → outside | 1,007 m | **1,014.6 m, 9 edges, 2 seam crossings** |
| B east/west across the core | 380 m | **389.5 m** |
| C north/south cross-street | 231 m | **not found** — starts at node 36 |
| D Commonwealth | 380 m | **889.6 m, 2 core edges** |
| E adjacent to frozen Northeastern | 648.9 m | **648.9 m, identical** |

Tunnel/surface isolation holds: **0 Turnpike edges on the surface graph** in either world, and no route uses
one. Graph components 6 in both.

## H. Spawns, Commonwealth and Huntington

**Spawns:** 3,712 → **3,744**, core 118 → 139, **0 non-finite, 0 further than 20 m from any road**.

**Commonwealth: no regression.** Both factual carriageways retained, semantic pairing by flow direction
intact, mall reservation still clear.

**Huntington / `nuniv`: no regression.** The path-parallel array slice still holds; the candidate edge carries
`lanes 2, median 7, sections 1`, matching control. **Northeastern parcels changed: 0.**

## I. Invariants and parity

**Stage 2A: 26 of 26. Stage 2A.1: 13 of 13.** Control fingerprint `5fa6c6be79473213` — unchanged, identical
under an unrelated flag, and identical again when both experimental flags are supplied together, which
disables both.

## J. Missions D, E, F — runtime acceptance

**This is what Stage 2A.1 could not reach, and it is now done, every measure against a control run of the
same cameras and the same frame counts.** The deterministic harness `api.step()` was used rather than
wall-clock observation, which the brief permits: the Browser pane pauses `requestAnimationFrame` when hidden,
so real-time sampling measured a frozen world and reported every vehicle as stuck. Stepping advances the world
regardless.

### Traffic — **PASS**

**27 seconds of stepped candidate runtime across four areas** — core centre, eastern seam, western seam and
Commonwealth — against 22 seconds of control over the same cameras.

| | control | candidate |
|---|---|---|
| distinct vehicles observed in the core | 107 | **117** |
| core entries / exits | 63 / 34 | **87 / 57** |
| **off-road samples** | **0** | **0** |
| **building-penetration samples** | **0** | **0** |
| stuck ≥ 4 samples | 27 | 29 |
| stuck ≥ 6 samples | 21 | 25 |

Vehicles enter and leave the factual core freely. Nothing drives off-road or through a building. The stuck
counts are **the same as baseline** — and every long-stuck vehicle sits 4.2–8.0 m *inside* the corridor, i.e.
queued on the carriageway at a signal, not trapped or displaced. Had the control not been run, 25 stuck
vehicles would have looked like a candidate gridlock; it is ordinary Boston traffic.

### Pedestrians — **PASS** (and better than baseline)

| | control | candidate |
|---|---|---|
| pedestrians in the core | 455 | 433 |
| **inside a building** | **0** | **0** |
| on the carriageway | 111 | **62** |
| further than 40 m from any road | 0 | 0 |

No building-interior spawns in either world, and the candidate puts **44% fewer** pedestrians on the
carriageway than the baseline does. Appearance was not touched; this is geography and navigation only.

### Collision — **PASS**

Ownership: candidate colliders are generated by the **normal pipeline from the candidate world**. No GIS
collision was added and no collider was authored.

| | control | candidate |
|---|---|---|
| colliders in the core | 673 | 652 |
| core building specs | 361 | 378 |
| specs with collider support within 30 m | 355 | **373** |
| specs without | 6 | **5** |
| **carriageway samples with a collider within 1.5 m** | **0** | **0** |

**No obsolete baseline collision survives in the factual core** — zero collider mass sits on the candidate
carriageway, so there is no invisible old road. Building collider support is equivalent to baseline, and the
five unsupported specs all lie at the southern core boundary about 200 m from the camera, which is chunk
streaming rather than a defect: the control shows six of the same kind.

### Spawns — **PASS**

3,712 → **3,744**; core 118 → **139**; **0 non-finite, 0 further than 20 m from any road**.

## K. Camera-fair visual closeout

The Stage 2A.1 neutral camera set was reused unchanged — fixed world positions, verified to stand in open air
in both worlds — and recaptured because Stage 2A.2 moves the seam. Both sides at 1350 × 840.

> The first control set was captured at 600 × 337 because the pane had been resized for the runtime work. It
> was discarded and recaptured rather than compared against a 1350 × 840 candidate.

| view | verdict | evidence |
|---|---|---|
| **B_boylston_block** | **MATERIALLY BETTER** | The control's left third is a bare brown expanse where Boston's hand-authored Boylston leaves a gap; the candidate fills it with continuous rowhouse terraces and roof gardens. Unchanged from Stage 2A.1. |
| **C_cross_exeter_fairfield** | **MATERIALLY BETTER** | The control's bare open block interior is replaced by dense terraces. Unchanged from Stage 2A.1. |
| **E_commonwealth** | **NEUTRAL, Stage 2A.1 gain preserved** | Mall legible in both, trees, benches, central path, carriageways with kerbside parking, no buildings intruding. **No regression** — which is what the brief required, Commonwealth being frozen. |
| **D_district_overview** | **NEUTRAL** | Both read as Back Bay; the candidate is busier but the grid and mall are legible. |
| **F_seam** *(diagnostic)* | **MATERIALLY IMPROVED, bounded defect remains** | Stage 2A.1's bare-ground band is substantially narrower: buildings now reach the corridor where before there was exposed ground. A band remains — but the **control shows a comparable band at the same place**, so most of it is baseline, not seam. |

**No primary view is materially worse.**

## L. Dependent-system final table

| system | status |
|---|---|
| ROAD GRAPH | **PASS** |
| SIDEWALKS | **PASS** |
| PARCEL / FRONTAGE | **PASS** |
| BUILDINGS | **PASS** |
| ROUTING | **MINOR_DEFECT** — core 18/18 reachable both ways, 0 traps; one seam sink at node 36 |
| TRAFFIC | **PASS** |
| PEDESTRIANS | **PASS** |
| COLLISION | **PASS** |
| SPAWNS | **PASS** |
| PARKED VEHICLES | **PASS** |
| PROPS | **PASS** |
| COMMONWEALTH BOULEVARD | **PASS** |
| HUNTINGTON / NUNIV | **PASS** |
| **TRANSITION SEAM** | **MINOR_DEFECT** — 295 parcels beyond the 6.96 m seam; 26 beyond Stage 2A.1's 216 m envelope |

## M. Stage 2A.2 verdict — **PARTIAL**

**Met:** factual core frozen to 6 mm · geographic gain retained and improved (pathology back to **0.22%**,
wall residual **5.83 m**) · degree-2 feasibility answered and the junction floor **rejected**, seam cut from
216.15 m to **6.96 m** · seam derived from topology and frozen before measurement · tunnel/surface isolation
holds · **traffic, pedestrians, collision and spawns all validated against a control and all PASS** ·
Commonwealth and Huntington regression-free · default-off parity exact · 26 + 13 invariants hold · camera-fair
result net positive with no primary view materially worse.

**Not met:** zero geometry change outside the seam. **295 parcels change beyond the 6.96 m seam**, concentrated
on Huntington (132), Commonwealth Inbound (68), Dartmouth (53) and Commonwealth Outbound (41), because 14 of
23 factual ports still dangle and the 21 m endpoint snap splits unclipped streets. And the one-way sink at
node 36 is diagnosed but **not fixed** — a symmetric connector pass was written and did not fire, and the
brief rightly forbids the shortcut of making the street two-way.

**Stage 2A FAMILY is therefore NOT closed as PASS.** Three of the five Stage 2A.1 conditions are closed
outright — traffic, pedestrians, collision — and the seam is 31× smaller, but two remain.

## N. Limitations

1. 295 parcels beyond the 6.96 m seam (26 beyond the older 216 m envelope), on four streets.
2. One-way sink at node 36, 3.96 m outside the core; routing case C fails from it. The baseline has 44
   comparable dead-end-forward nodes; the candidate adds 2.
3. 14 of 23 factual ports carry no connector.
4. Traffic observation is 27 s of stepped time, not 3–5 minutes of wall clock; the pane pauses rAF when hidden.
5. Identity-only churn is 6,356 parcels — every plot id shifts because ids are reassigned by distance from the
   centre. Geometry is unaffected, but any consumer keyed to plot id would see the whole city change.
6. Back Bay core only.

## O. Owner decision required next

1. **Accept PARTIAL and stop.** The geography is proven, all five dependent runtime systems now pass, and the
   seam floor has been cut from 216 m to 7 m. What remains is bounded engineering on four streets.
   *This is the recommendation.*
2. **Authorise one more narrow pass** to finish the connector work — join the remaining 14 ports, which should
   close both the 295 parcels and the node-36 sink, since both trace to the same dangling-port cause.
3. **Accept the candidate as-is for prototype purposes**, treating the 295 parcels and one sink as known
   bounded defects outside the verdict-driving core.

**Not authorised and not begun:** citywide migration, Stage 2B, factual widths, factual sidewalks, factual
parcels, factual buildings, traffic or collision redesign, terrain correction, Northeastern work, default-on,
deployment.

---

*Stage 2A.2. Candidate committed **DEFAULT OFF**. Without `?gisRoads=1`, Boston is bit-for-bit the city it was
at `3aae33f`. Not pushed, not deployed, not enabled.*
