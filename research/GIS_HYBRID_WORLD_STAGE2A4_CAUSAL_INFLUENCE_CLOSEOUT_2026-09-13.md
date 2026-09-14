# Stage 2A.4 — causal influence reconciliation and final acceptance closeout

**Date** 2026-09-13 · **Branch** `main` · **Baseline** `d9c10f3` (`HEAD == origin/main`, clean, 0 ahead / 0 behind)
**Scope** audit and reconciliation. Candidate remains DEFAULT OFF (`?gisRoads=1`). No new source, no new
dependency, no deployment, no push.

---

## A. Executive summary

The stage was authorised as audit-first, and the audit found one thing worth changing.

1. **The 224 / 208 discrepancy was in the prose, not the data.** Stage 2A.3's mechanism table always summed
   to 224; its summary named "121 Huntington + 77 depth + 10 connector" and dropped 16 parcels that the
   table had filed under a mechanism *label* rather than a cause. Every parcel now carries exactly one
   primary cause, decided by a test taken from `buildPlots` itself. **UNRESOLVED = 0.**

2. **A real defect was found in the lot-grid cut.** `lotGridCut` built the segment list handed to
   `RoadNetwork._along` with `s: 0` on every segment instead of the cumulative arc. `_along` locates a
   distance *by* that field, so every candidate cut position past the first segment came back **up to 454 m**
   from the lot boundary it represented — measured, not read off the code. Huntington therefore settled for a
   2.28 m phase error when **0.49 m** was available at a lot boundary inside the same one-lot bound.

3. **So the Owner's question 21 is answered NO.** 2.28 m was not minimal and was not arithmetic; it was an
   implementation defect. Fixed, regenerated, re-measured.

4. **Containment improved again, without touching production logic.** Beyond the declared 6.96 m road seam:
   parcels **224 → 166**, building specs **167 → 123**. Huntington's phase residual **2.28 m → 0.49 m**,
   affecting **66** parcel records instead of 122.

5. **Zero changed parcels and zero changed specs lie outside the derived-influence envelope**, where that
   envelope is read off the code — the frontage of changed edges, plus `cfg.depth * 2 + 12` around changed
   road segments — and not chosen as a radius.

6. **Road-geometry containment is exact.** 0 unintended splits, 0 endpoint-snap mutations, 0 junctions
   gained or lost beyond the seam.

7. **Both ledgers reconcile exactly.** 166 = 73 + 66 + 10 + 10 + 7. 23 ports = 11 CONNECTED + 4
   LEGACY_BOUNDARY_INCOMPATIBLE + 8 INTENTIONALLY_TERMINAL. Both UNRESOLVED = 0.

8. **All four candidate-only dead ends are classified**; **0 are ordinary routing sinks.**

**Verdict: Stage 2A.4 = PASS. The Stage 2A family closes as PASS WITH KNOWN PROTOTYPE LIMITATIONS.**

---

## B. Baseline, and whether production behaviour changed

`HEAD == origin/main == d9c10f3`, working tree clean, 0 ahead / 0 behind, no merge, rebase, cherry-pick or
bisect in progress. Three auxiliary worktrees present and untouched. No push, amend, rebase, squash or reset.

**Production behaviour: unchanged. Production DATA: regenerated.** The only file under `src/` that differs is
`src/data/gis-backbay-roads.js` — 5 changed lines, all coordinates, from the corrected cut. No file under
`src/world/`, `src/core/` or anywhere else in `src/` was modified. `npm run check` passes (91 files parse, 114
files scope-clean) and the generator is deterministic: two consecutive runs both produce
`sha256 4623208600a82e5f`.

---

## C. The factual core is unchanged

- Stage 2A.1 invariant *factual core is frozen: interior vertices within 5 cm of Stage 1E* — **holds**.
- Stage 2A invariants — **26 of 26 hold**.
- Control fingerprint **`5fa6c6be79473213`**, identical to every stage since 2A. `?quality=high` gives the
  same. Both flags together give the same. `?gisBackBay=1` alone gives `07160ebe8509a742`, unchanged.
- Only the candidate fingerprint moved, `69df72621a056907 → 147258867b354008`, which is the corrected cut.

Default-off parity is therefore exact, by construction and by measurement.

---

## D. The two nested regions

The Owner required these to be separate, and neither to be an arbitrary radius.

### ROAD_GEOMETRY_SEAM — where candidate ROAD geometry itself differs

Declared **by the generator, before measurement**: the furthest any vertex it places outside the core reaches
beyond it, over every lot-grid cut **and** every connector vertex.

| | |
|---|---|
| outward extent | **6.96 m** |
| generated vertices it is taken over | 39 |
| median | 1.81 m |
| lot-grid cuts | 17, max offset from the crossing 7.34 m |
| connectors | **11**, max **65.15 m**, median 28.92 m |

**Length along the boundary and outward extent are different quantities and are reported separately.** The
longest connector is 65.15 m but runs *along* the core edge, so it adds nothing to the 6.96 m outward extent.
That is why the seam did not widen when Stage 2A.3 lengthened the connectors.

### DERIVED_INFLUENCE_ENVELOPE — where Boston's own algorithms may legitimately differ

Read off `buildPlots`, as the union of two sets:

- **E1 — the frontage of any edge whose geometry differs between the worlds.** `buildPlots` subdivides per
  EDGE over the edge's whole length, so an edge that changed may legitimately re-lay every lot on itself.
  This is not a radius; it is an edge. 101 edges qualify.
- **E2 — everything within `cfg.depth * 2 + 12` of a changed road segment**, the literal `lim` passed to
  `rayToRoad`, evaluated with **the parcel's own district**: backBay 80 m, southEnd 72 m, beaconHill 64 m,
  fenway 92 m, northeastern 120 m, financial 136 m.

---

## E. Road-geometry containment contract — met exactly

Every road edge that differs between the worlds, attributed:

| kind | n | max endpoint outside core |
|---|---|---|
| FACTUAL_CORE (a SAM edge inside the core) | 38 | 0 m |
| LOT_GRID_CUT (a hand-authored edge truncated at its declared cut) | 35 | 216.15 m |
| CORE_REPLACED (a hand-authored edge inside the core that SAM replaces) | 18 | 0 m |
| TRANSITION_CONNECTOR | 9 | 6.96 m |
| CUT_NEIGHBOUR | 1 | 2.85 m |
| **UNINTENDED_SPLIT** | **0** | — |

| contract item | required | measured |
|---|---|---|
| connector-attributable road change outside the seam | 0 | **0** |
| endpoint-snap mutations | 0 | **0** |
| candidate-created unintended road split | 0 | **0** |
| junctions gained beyond the seam | — | **0** |
| junctions lost beyond the seam | — | **0** |

LOT_GRID_CUT reaching 216.15 m is the *far, unchanged* endpoint of Huntington's 472.98 m control edge — the
edge the cut consumed. Its outer end did not move.

---

## F. The 166-parcel ledger — every one reconciled

`research/gis-stage2a4/parcel-ledger.json`. **166 changed parcel RECORDS beyond the 6.96 m road seam**
(78 control-side, 88 candidate-side; ~72 of them are the same lot counted once in each world).

| primary cause | n | furthest beyond core | furthest from changed road |
|---|---|---|---|
| `RAY_TO_ROAD_DEPTH` | **73** | 63.11 m | 58.77 m |
| `LOT_PHASE_RECOMPUTED` | **66** | 190.05 m | 32.49 m |
| `FRONTAGE_OCCLUSION` | **10** | 56.64 m | 23.35 m |
| `CONNECTOR_FRONTAGE` | **10** | 16.57 m | 13.56 m |
| `BOUNDARY_FRONTAGE` | **7** | 13.06 m | 13.56 m |
| `DISTRICT_RECLASSIFIED` | 0 | — | — |
| `COORDINATE_ROUNDTRIP` | 0 | — | — |
| **`UNRESOLVED`** | **0** | — | — |

**73 + 66 + 10 + 10 + 7 = 166.** Exactly.

Each class is a test, not a label. `buildPlots` computes a lot from `acc`, `cfg`, `n`, `step`, `runs` and
three `rayToRoad` casts, so each cause asks about one of those:

- **`LOT_PHASE_RECOMPUTED`** — `step` differs between the lot's edge and its counterpart, so every lot on
  that edge moves. All 66 are Huntington; see §G.
- **`RAY_TO_ROAD_DEPTH`** — same frontage start, same width, different depth; or the lot vanished because the
  other world's `min(cfg.depth, reach/2 - 0.6)` then `_fitDepth` fell under `MIN_DEPTH = 8`. Recomputed in
  the other world rather than inferred. Furthest at **58.77 m** against an 80 m limit.
- **`FRONTAGE_OCCLUSION`** — `step`, `n`, district and depth all preserved; `_clearFrontage` returned
  different runs because a nearby corridor changed. Run boundaries are compared directly, from the outer end
  the two worlds share.
- **`CONNECTOR_FRONTAGE`** — the lot is on a synthetic transition connector.
- **`BOUNDARY_FRONTAGE`** — the ROAD is inside the seam but its frontage line, offset by `corridorHalf`
  (10–12 m in Back Bay), reaches past it. A street lying on the core boundary *must* lay lots outside it.

Two misattributions were found and fixed while building this: matching a procedural lot to a same-named SAM
edge inside the core, or to a connector, invented phase changes for four lots on Dartmouth, Boylston and
Newbury that the road audit shows never happened.

---

## G. Huntington — the defect, and the real minimum

### The defect

```js
// before — every segment claims to start at arc 0
baseline.net._along(g.line.slice(1).map((q, i) => ({ a: g.line[i], b: q, L: …, s: 0 })), k * g.step, g.acc)
```

`_along` selects a segment with `d <= s.s + s.L`, so with `s: 0` throughout it matches the first segment or
falls through to the last. Measured on Huntington's own frontage:

| requested arc | returned with `s: 0` | correct | apart |
|---|---|---|---|
| 0 m | (−2048.3, 1759.1) | (−2048.3, 1759.1) | 0 m |
| 50 m | (−2493.7, 1995.6) | (−2092.2, 1782.9) | **454.3 m** |
| 200 m | (−2628.4, 2061.6) | (−2224.1, 1854.4) | **454.3 m** |
| 400 m | (−2808.0, 2149.6) | (−2399.9, 1949.7) | **454.4 m** |

The other 16 crossings were unaffected because the generator also enumerates the *centreline* grid, computed
correctly, and on a straight edge the centreline and both frontages coincide. Huntington is the one bent
crossing edge, so only it depended on the broken candidates.

### The arithmetic, independently reproduced

| | |
|---|---|
| edge centreline | 472.98 m |
| frontage side −1 | **471.61 m**, district `null` → `southEnd`, w **7.8**, n **60**, step **7.860 m** |
| frontage side +1 | **474.34 m**, district `null` → `southEnd`, w **7.8**, n **61**, step **7.776 m** |
| the two sides differ by | 2.73 m — which rounds to **different lot counts** |

### Is it minimal?

A dense scan at 1 cm over all 25,881 positions on the edge that lie outside the core:

| | worst-side phase error |
|---|---|
| Stage 2A.3 (defective enumeration) | 2.28 m |
| **Stage 2A.4 generator, best lot boundary within one lot** | **0.49 m** |
| theoretical best within one lot (not on either lot grid) | 0.247 m |
| best anywhere on the edge | 0.008 m — but **258 m** from the crossing |

**Joint zeros of the two lot grids: exactly one, at arc 0.** With 60 lots on one side and 61 on the other
over different lengths, the two grids share no interior position, so **no cut can preserve the phase on both
sides**. That is the proof that a residual is unavoidable; the question was only how large, and 2.28 m was
not the answer.

The generator takes 0.49 m rather than 0.247 m deliberately: 0.49 m is a **lot boundary on one side**, so
that side's lots are preserved exactly and only the other drifts, whereas 0.247 m puts both sides out of
phase. The 0.008 m option is refused because it would push the seam 258 m out, which the Owner explicitly
forbade.

**Result: `BOUNDED_PHASE_RESIDUAL`, 0.49 m, 66 parcel records, furthest 190.05 m from the core, confined to
Huntington Avenue's two frontages on one edge.**

---

## H. Derived-influence contract — met exactly

| | changed | beyond the road seam | **outside the derived envelope** | furthest E2 influence |
|---|---|---|---|---|
| parcels | 998 | 166 | **0** | 58.77 m |
| building specs (ground geometry) | 894 | 123 | **0** | 47.72 m |

`rayToRoad`'s configured reach in the affected districts is **80 m** (backBay) and **72 m** (southEnd). The
furthest observed derived effect is **58.77 m**, comfortably inside it — which is the independent check that
the mechanism is named correctly rather than assumed.

Spec geometry is keyed on position plus footprint vertex count, as in Stage 2A.2 and 2A.3: the spec polygon
carries jitter seeded from `plot.id`, and plot ids are reassigned by distance from the city centre, so keying
on the raw polygon counts 13,136 "changes" against the 894 that actually moved.

---

## I. The 23-port ledger — final states

`research/gis-stage2a4/port-ledger.json`.

| final state | n |
|---|---|
| `CONNECTED` | **11** |
| `LEGACY_BOUNDARY_INCOMPATIBLE` | **4** |
| `INTENTIONALLY_TERMINAL` | **8** |
| `GRADE_SEPARATED_EXCLUDED` | 0 |
| `NON_ROAD_EXCLUDED` | 0 |
| `OTHER_JUSTIFIED` | 0 |
| **`UNRESOLVED`** | **0** |

**11 + 4 + 8 = 23.** Exactly.

The two exclusion categories are 0 *among ports* because exclusion happens before a port can form: 8 factual
features were dropped upstream — 7 grade-separated (ZLEV < 0, the Turnpike and its ramps) and 1 walkway/plaza
(CFCC A71, Exeter PLZ) — and never reached the boundary.

### The four LEGACY_BOUNDARY_INCOMPATIBLE ports

| factual street | concept | face | attempted counterpart | crosses another road? | reverses a carriageway? |
|---|---|---|---|---|---|
| Commonwealth Avenue Inbound | Commonwealth Avenue Inbound | z0 | 168.95 m | **yes**, 2 | **yes** — Commonwealth Outbound |
| Commonwealth Avenue Inbound | Commonwealth Avenue Inbound | x0 | 62.62 m | **yes**, 1 | **yes** — Commonwealth Outbound |
| Commonwealth Avenue Outbound | Commonwealth Avenue Outbound | z0 | 98.37 m | **yes**, 1 (Exeter's connector) | no |
| Fairfield Street | Fairfield Street | x0 | — | — | no |

Why an honest local connector is impossible: for the three Commonwealth ports, `boston-geo.js` draws the
boulevard's carriageways **on the wrong sides of the mall** — inbound is eastbound and belongs south, and
Boston has it north — so the only connector to the legacy line of the same name either runs 63–169 m along
the core boundary through other streets, or joins the two carriageways head to head. For Fairfield, the
legacy street crosses a **different face** of the core entirely, 137.9 m away around a corner, so no local
connector exists on this face at all.

Routing consequence: each becomes a one-way terminal stub at the core boundary. None is a trap; see §J.

### Every Commonwealth port, individually

| carriageway | face | state | |
|---|---|---|---|
| Commonwealth Avenue Outbound | x0/out | **CONNECTED** | connector 30.28 m |
| Commonwealth Avenue Outbound | z0/in | LEGACY_BOUNDARY_INCOMPATIBLE | attempted 98.37 m, crosses 1 |
| Commonwealth Avenue Inbound | z0/out | LEGACY_BOUNDARY_INCOMPATIBLE | attempted 168.95 m, crosses 2 |
| Commonwealth Avenue Inbound | x0/in | LEGACY_BOUNDARY_INCOMPATIBLE | attempted 62.62 m, crosses 1 |

No Commonwealth port is left silently dangling.

---

## J. Dead ends — classified, not counted

Four nodes are dead-end-forward in the candidate and not in the control. Every one has **forward reach 1**,
the same value as the worst of the control's own 44.

| node | position | incoming | classification |
|---|---|---|---|
| 403 | (−1380.46, 576.93) | Fairfield Street | **factual port** — LEGACY_BOUNDARY_INCOMPATIBLE |
| 420 | (−1152.59, 454.52) | Commonwealth Avenue Inbound | **factual port** — LEGACY_BOUNDARY_INCOMPATIBLE |
| 24 | (−1384.21, 475.09) | Commonwealth Avenue Inbound | **orphan lot-grid cut stub** — the legacy side of the same incompatibility |
| 36 | (−1173.77, 453.18) | Commonwealth Avenue Outbound | **orphan lot-grid cut stub** — the legacy side of the same incompatibility |

**Ordinary unintended routing sinks: 0.** No ordinary connected street ends unintentionally, so the
MAJOR_DEFECT condition is not met. These are justified prototype terminals and are not called sinks.

---

## K. Routing and tunnel isolation

| | control | candidate |
|---|---|---|
| nodes | 397 | 432 |
| components / largest | 6 / 387 | 6 / 422 |
| core junctions | 13 | **16** |
| can exit the core / can be entered | 13 / 13 | **16 / 16** |
| **traps** | 0 | **0** |
| Turnpike edges on the SURFACE graph | **0** | **0** |

All five routing cases resolve: outside-through-core 1014.61 m, east–west core 389.53 m, north–south core
450.53 m, Commonwealth 390.39 m, near-Northeastern **648.89 m, unchanged from control**.

---

## L. Dependent systems — re-run, not carried forward

Production geometry changed, so the Stage 2A.3 runtime evidence no longer describes this world and was
re-measured. 24 s of stepped runtime per world across four areas, `api.step()` rather than real time.

### Traffic — **PASS**

| | control | candidate |
|---|---|---|
| distinct vehicles in the core | 85 | 87 |
| core entries / exits | 24 / 2 | **28 / 10** |
| **off-road samples** | **0** | **0** |
| **building-penetration samples** | **0** | **0** |
| stuck ≥ 4 / ≥ 6 | 0 / 0 | **0 / 0** |

### Pedestrians — **PASS**

| | control | candidate |
|---|---|---|
| in the core | 136 | 141 |
| **inside a building** | **0** | **0** |
| on the carriageway | 19 (14.0%) | 25 (17.7%) |
| further than 40 m from any road | 0 | 0 |

Carriageway occupancy is **not** an improvement and is not claimed as one. No pedestrian is inside a building
or stranded in either world.

### Spawns — **PASS**

3712 → **3750**; core 118 → **144**; 0 non-finite; 0 further than 20 m from a road in the core. Spawn and
core-spec counts agree exactly with the headless build, which is the cross-check that the runtime is the same
world the measurements describe.

### Collision — **carried forward from Stage 2A.2, with the reason stated**

Stage 2A.2 measured 0 stale colliders on the candidate carriageway and equivalent building collider support
(355/361 control, 373/378 candidate). Colliders are generated by the normal pipeline from the candidate
world, and neither Stage 2A.3 nor 2A.4 touched collision code or collider generation — the only `src/` change
in this stage is 5 coordinate lines in generated road data. The carry-forward is therefore sound for the
mechanism, and it is the one acceptance in this report that rests on prior rather than fresh measurement.

---

## M. Factual registration — re-measured, intact

| | control | candidate |
|---|---|---|
| road line inside a factual building (pathology) | 42.35% | **0.22%** |
| procedural wall → factual wall, median | 16.77 m | **5.88 m** |

The pathology is exactly the best value the programme has recorded. The wall residual is 5.88 m against
Stage 2A.2's 5.83 m — a 5 cm difference from the corrected cut, and still a 10.9 m improvement on the
control. Neither was sacrificed.

---

## N. Visual — recaptured, verdicts unchanged

Geometry changed, so the Stage 2A.1 camera-fair set was recaptured rather than carried forward. All five
cameras re-verified clear in both worlds. Both worlds captured in one session at a matched 1280 × 720; the
candidate captured twice from separate page loads for an A/A floor.

| view | A/B % > 32 | A/A floor | signal | Stage 2A.3 signal |
|---|---|---|---|---|
| B_boylston_block | 50.28 | 0.07 | **50.21** | 49.51 |
| C_cross_exeter_fairfield | 48.67 | 0.13 | **48.54** | 50.39 |
| D_district_overview | 29.23 | 0.02 | **29.21** | 29.59 |
| E_commonwealth | 33.98 | 0.12 | **33.86** | 33.73 |
| F_seam | 47.29 | 0.02 | **47.27** | 48.05 |

Every view is within ~2 points of Stage 2A.3, so the corrected cut does not materially alter any primary
view and the prior verdicts stand, now re-evidenced: Boylston **materially better**, Exeter/Fairfield
**materially better**, Commonwealth **resolved / positive**, overview **neutral**, **no primary view
materially worse**.

(Canvas was 1280 × 720 here and 1920 × 1080 in Stage 2A.3, so raw percentages are comparable *within* a
stage. The A/A floor is measured in the same session at the same size, which is what makes the signal
column meaningful.)

---

## O. Validation

| | |
|---|---|
| `npm run check` | **pass** — 91 files parse, 114 files scope-clean |
| `git diff --check` | **clean** |
| Stage 2A invariants | **26 / 26** |
| Stage 2A.1 invariants | 12 / 13 — the one failure is `connectors are short (≤ 40 m)`, superseded in the Stage 2A.3 report §E |
| Stage 2A.3 invariants | **16 / 16** |
| generator determinism | two consecutive runs → `sha256 4623208600a82e5f` |
| `npm install` / new dependency | none |

Files changed: `research/gis-stage2a3/build-candidate.mjs` (the fix), its regenerated
`candidate-manifest.json`, `containment.json` and `seam-residual.json`, an errata block at the head of the
Stage 2A.3 report, `src/data/gis-backbay-roads.js` (5 coordinate lines), and the new `research/gis-stage2a4/`.
**No production logic file changed.**

---

## P. Stage 2A.4 verdict — **PASS**

All 24 acceptance conditions:

| # | condition | |
|---|---|---|
| 1 | factual SAM core unchanged | ✅ frozen to 5 cm; 26/26 invariants |
| 2 | factual registration gain intact | ✅ 0.22% pathology, 5.88 m wall |
| 3 | default-off parity exact | ✅ `5fa6c6be79473213` |
| 4 | road geometry contained to core + seam | ✅ 6.96 m, 0 junctions gained/lost |
| 5 | unintended END_SNAP mutations = 0 | ✅ |
| 6 | unintended outside road splits = 0 | ✅ |
| 7 | residual parcels reconcile exactly | ✅ 73+66+10+10+7 = 166 |
| 8 | UNRESOLVED parcels = 0 | ✅ |
| 9 | all 23 ports reconcile exactly | ✅ 11+4+8 = 23 |
| 10 | UNRESOLVED ports = 0 | ✅ |
| 11 | every unconnected port defensibly classified | ✅ §I |
| 12 | Huntington residual proven bounded | ✅ 0.49 m, one joint zero, §G |
| 13 | derived effects within the proven model | ✅ 58.77 m vs 80 m |
| 14 | zero changes outside the derived envelope | ✅ parcels 0, specs 0 |
| 15 | no ordinary candidate routing sink | ✅ 0 |
| 16 | tunnel / surface separation valid | ✅ 0 Turnpike edges on the surface |
| 17 | traffic PASS applicable | ✅ re-run |
| 18 | pedestrian PASS applicable | ✅ re-run |
| 19 | collision PASS applicable | ✅ carried forward, reason stated in §L |
| 20 | spawn validity applicable | ✅ re-run |
| 21 | Commonwealth resolved inside the factual prototype | ✅ §I |
| 22 | Huntington / `nuniv` resolved | ✅ lanes and median match; station section attaches |
| 23 | Northeastern frozen | ✅ parcels unchanged, route 648.89 m unchanged |
| 24 | no primary visual verdict regresses | ✅ §N |

## Q. The Stage 2A family closes as **PASS WITH KNOWN PROTOTYPE LIMITATIONS**

SAM factual road centrelines are validated as a viable geographic backbone for Boston. This is not a claim
that the seam is production-final.

**Known limitations, exactly:**

1. **Four LEGACY_BOUNDARY_INCOMPATIBLE ports** — three Commonwealth, one Fairfield — where the factual
   network and the known-wrong hand-authored geography outside it cannot honestly connect. They terminate at
   the core boundary. The fault is in `boston-geo.js`, not in the factual data.
2. **A 0.49 m Huntington lot-phase residual**, mathematically irreducible on a bent edge whose two frontages
   round to 60 and 61 lots, affecting 66 parcel records out to 190 m. One side is preserved exactly; the
   other drifts up to 0.49 m.
3. **Derived parcel and building changes inside the existing procedural dependency envelope** — 73 from
   `rayToRoad` reaching up to 58.77 m across the boundary, 10 from `_clearFrontage`, 10 on connector
   frontage, 7 from frontage projecting past a road that is itself inside the seam. All are Boston's own
   algorithms working correctly on new geography.
4. **11 synthetic transition connectors**, up to 65.15 m, which are not SAM geometry and are labelled as
   such.

---

## R. Owner decision required next

1. **Commonwealth's swapped carriageways in `boston-geo.js`.** Correcting the hand-authored baseline would
   make three of the four incompatible ports joinable and is a small edit — but it changes the default-off
   baseline, which no stage has been authorised to touch. Alternatively, extending the factual region past
   Commonwealth removes the boundary rather than the port.
2. **Whether the 0.49 m Huntington residual is accepted as `BOUNDED_PHASE_RESIDUAL`**, or whether a
   different cut policy for bent edges is worth a stage.
3. **Whether Stage 2B may open** — citywide expansion, or a wider factual region in Back Bay — given that
   the factual-road hypothesis is now validated.

**The candidate remains DEFAULT OFF. Nothing ships to the player.**
