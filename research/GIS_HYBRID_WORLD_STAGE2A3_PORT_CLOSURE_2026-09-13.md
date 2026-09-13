# Stage 2A.3 — final port-closure / seam-containment pass

**Date** 2026-09-13 · **Branch** `main` · **Baseline** `632e0fb` · **Candidate** DEFAULT OFF (`?gisRoads=1`)
**Scope** narrow closeout of the Stage 2A.2 seam. No new data source, no new dependency, no deployment.

---

## A. Executive summary

Stage 2A.2 left two open questions: why 14 of 23 factual boundary ports received no connector, and why
295 parcels still changed beyond the seam. Both are answered, and neither answer was the one Stage 2A.2
assumed.

1. **The symmetric connector pass could not have fired.** It applies the same 40 m Euclidean bound to the
   same pairs from the other side. Distance is symmetric, so a second pass over it cannot admit a pair the
   first refused. Instrumented: 34 stub ends, **0 emitted** — 17 rejected as far ends, 8 by the dedup key
   because pass 1 had already emitted that exact pair, 9 by the identical 40 m bound.

2. **No distance bound could have worked.** Boston's hand-authored error is per-street — 0.2 m on Boylston,
   8 m on Newbury, 31 m on Blagden, 44 m on Exeter, 57 m on Commonwealth Inbound — and a boundary crossing
   multiplies it by `1 / sin θ`. Back Bay's grid meets the core's north face at **18.5°**, so Commonwealth's
   30 m lateral offset becomes **94 m** of separation along the face. The 40 m gate was measuring the
   crossing angle as much as the registration error.

3. **Ports are now paired structurally**, on `(road concept, boundary face, order along that face)` with a
   one-way flow filter, resolved by an order-preserving alignment. Distance is a tie-break inside an already
   structural class, never the class itself. **11 of 23 ports connected** — and all 8 of Stage 2A.2's
   legitimate connectors survive unchanged, while its 9th (Commonwealth Inbound, `toBaselineNode: true`,
   joined to an arbitrary nearest graph node, not to Commonwealth) is gone.

4. **The Commonwealth cross-connect was real and is closed.** Stage 2A.2's candidate END_SNAPped
   Commonwealth Outbound onto Commonwealth **Inbound** at 16.06 m and Inbound onto Outbound at 14.47 m — the
   two carriageways of a divided boulevard joined through the seam. A connector-validity test that knows
   nothing about Commonwealth rejects it: two of its three rejections are exactly those joins.

5. **`boston-geo.js` draws Commonwealth's carriageways on the wrong sides of the mall.** At x = −1346,
   SAM has Inbound at z 525 and Outbound at 482; Boston has Inbound at 462 and Outbound at 511. Inbound is
   eastbound, so in right-hand traffic it belongs on the **south** side — where SAM puts it. This is why
   Commonwealth admits no honest handover at the north face, and it is a new finding about the authored data.

6. **Containment improved but the contract is not met.** Beyond the declared 6.96 m seam:
   parcels **295 → 224** (−24%), building specs **238 → 167** (−30%), road edges 17 → 16. The residual is
   fully attributed, and **121 of the remaining 224 are provably irreducible** under a lot-grid cut.

7. **Routing is closed.** Stage 2A.2's sink — junction 36, three incoming edges, none outgoing, reaching 2
   nodes of 428 — is gone. The candidate has **4 dead ends the control does not have, every one with forward
   reach 1**: ordinary terminal stubs, the same object the baseline already has 44 of. **0 traps** among 16
   core junctions; all 16 can be entered and exited.

**Verdict: PARTIAL.** Port ownership, the cross-connect and the routing sink are closed. The containment
contract (0 changed beyond the seam) is not met at 224, and section H shows why the largest part of that
cannot be met by choosing a better cut.

---

## B. Baseline and resources

`HEAD == origin/main == 632e0fb`, tree clean, 0 ahead / 0 behind. Three auxiliary worktrees
(`affectionate-franklin-4c66db`, `distracted-euclid-84fb05`, `zen-wilson-f0bc3d`) were left untouched.
No push, no amend, no rebase, no reset. No `npm install`; no dependency added. One WebGL context at a time,
stopped after use. No `xcodebuild` process was touched — none was running.

Resource pressure was real throughout (free + inactive 1.0–1.3 GB, swap free 0.4–1.4 GB). Headless Node was
used for everything that did not require rendering, and the two browser sessions were kept short.

---

## C. Phase 2 — why the Stage 2A.2 symmetric pass never fired

The generator was instrumented and every clipped stub end replayed against every predicate.

| outcome | stub ends |
|---|---|
| rejected `d0 > 25` (far end — the real city, 69–1722 m out) | 17 |
| rejected by the dedup key (pass 1 already emitted that exact pair) | 8 |
| rejected by the same 40 m bound as pass 1 | 9 |
| **emitted** | **0** |

The proof is stronger than the count. Pass 1 asks `min over stubs of d(port, ·) ≤ 40`; pass 2 asks
`min over ports of d(stub, ·) ≤ 40`. `d` is symmetric, so any pair satisfying one satisfies the other, and
the dedup key then suppresses it. The only way pass 2 could fire is nearest-neighbour asymmetry — a stub
whose nearest port is nearer than that port's nearest stub — and the trace shows no such case exists here.
Evidence: `research/gis-stage2a3/symmetric-trace.json`.

The pass is deleted rather than fixed. It was not a bug in the implementation; the design could not work.

---

## D. The port ledger and ownership model

23 ports, each with exactly one owner. Pre-fix ledger (Stage 2A.2 state):
`research/gis-stage2a3/port-ledger.json`. Post-fix: `portLedger` in `candidate-manifest.json`.

| ownership | n | ports |
|---|---|---|
| `CONNECTED` | 11 | Boylston ×2, Newbury ×2, Blagden, Public Alley 442, Public Alley 435, Exeter, Huntington ×2, Commonwealth Outbound (x0) |
| `TERMINAL_NO_PROCEDURAL_COUNTERPART` | 6 | Dartmouth ×2, Public Alley No. 432, Public Alley No. 440, Stuart ST, Ring Road |
| `TERMINAL_HANDOVER_NOT_LOCAL` | 3 | Commonwealth Inbound ×2, Commonwealth Outbound (z0) |
| `TERMINAL_COUNTERPART_ALREADY_PAIRED` | 2 | Huntington ×2 (the factual line crosses those faces twice; Boston's crosses once) |
| `TERMINAL_COUNTERPART_CROSSES_ANOTHER_FACE` | 1 | Fairfield |

Plus 6 **orphan cut stubs** — the mirror case, a procedural cut with no factual counterpart.

Nothing here is street-specific. The classes fall out of `(concept, face, order)` and the validity test.

---

## E. The matcher

For each concept and each boundary face, procedural crossings and factual ports are sorted along that face
and aligned by an order-preserving DP that maximises compatible pairs, then minimises total separation, and
may leave either side unpaired. Registration error slides a crossing **along** a face; it does not move it to
another face and cannot reorder two crossings of the same face.

One-way streets must additionally agree on direction. Two-way streets carry no usable direction: Boston and
SAM authored their paths in whichever order they liked, and on Boylston's x0 crossing — the two lines
**0.2 m apart**, unambiguously the same crossing — the labels already disagree.

Every connector runs from the factual port to the **lot-grid cut stub**, never to an arbitrary graph node.
Invariant: *every connector ends on a lot-grid cut*.

### The validity test

A connector asserts two lines are the same street meeting. That is defensible only if the join is local, so
the test is: **a connector must cross no other road** — checked against all 44 factual streets, all 17
clipped runs, all 570 hand-authored streets, and the other connectors. No constant; crossing count measures
the thing that matters, and no length threshold exists to measure it with.

Rejected:

| connector | length | crosses |
|---|---|---|
| Commonwealth Inbound / z0 | 168.95 m | Commonwealth **Outbound**'s connector, Exeter's connector |
| Commonwealth Outbound / z0 | 98.37 m | Exeter's connector |
| Commonwealth Inbound / x0 | 62.62 m | Commonwealth **Outbound**'s connector |

Two of the three are the carriageway cross-connect the brief prohibits, found by a test with no knowledge of
Commonwealth. The accepted 11 run 1.86–65.15 m and cross nothing.

This **supersedes** the Stage 2A.1 invariant `connectors are short (lengthM ≤ 40)`, which encodes the same
bound this stage disproves. `research/gis-stage2a1/validate.mjs` is left exactly as it was — it is the record
of what Stage 2A.1 claimed, and rewriting it would hide that a claim was retired. It now reports 1 FAILED,
and that failure is this, named and intended.

---

## F. `noSnap` — the one production behaviour change

`RoadNetwork.build()`'s pass 2 pulls any dangling endpoint onto whatever edge lies within 21 m and **splits
that edge mid-edge**. `buildPlots` phases lots per edge, so a mid-edge split re-phases every lot along the
whole edge, hundreds of metres away.

```js
if (st.noSnap && st.noSnap.includes(endIdx === 0 ? 0 : 1)) continue;
```

`noSnap` lists the protected endpoint indices of one street. It is opt-in from generated data only; no
hand-authored street carries it, so the baseline cannot change — and does not: the control fingerprint is
`5fa6c6be79473213` before and after, and all 26 Stage 2A invariants hold. True crossings (pass 1) are
untouched; this suppresses adoption, not intersection.

Measured in isolation, same data, guard off vs on: **327 → 306** parcels beyond the seam.

It is applied to unpaired factual ports **and** to orphan cut stubs. The second half matters more than the
first: an orphan stub dangles exactly as a port does, and the nearest thing to it is factual geometry just
inside the core. Protecting the orphans took the residual **306 → 224** and removed Commonwealth Inbound's
70 changed parcels outright.

---

## G. Containment

**The seam is declared by the generator, before measurement**, as the furthest any vertex it places outside
the core reaches beyond it — over every lot-grid cut *and* every connector vertex. It is **6.96 m** over 39
vertices, unchanged from Stage 2A.2 because connectors run *along* the boundary, not away from it. A longer
connector does not widen the seam.

Measured with identical code against both candidates:

| beyond the 6.96 m seam | Stage 2A.2 | Stage 2A.3 |
|---|---|---|
| road edges | 17 | **16** |
| parcels | 295 | **224** |
| building specs | 238 | **167** |

Junctions gained or lost beyond the seam: **0 and 0**. The road *topology* outside the seam is identical.

---

## H. What the residual actually is

Each changed parcel beyond the seam is attributed to the edge `buildPlots` recorded on it (`edgeId` — nearest
centreline is not good enough; a Back Bay lot's frontage sits `corridorHalf` off its own street and the
alleys are ~30 m apart).

| mechanism | parcels | furthest |
|---|---|---|
| `EDGE_CHANGED` | 137 | 210.48 m |
| `DEPTH_COUPLING` | 77 | 63.11 m |
| `CONNECTOR_FRONTAGE` | 10 | 17.64 m |

**`EDGE_CHANGED` is 121 Huntington Avenue and 16 everything else.** Huntington is the one bent crossing edge
in Back Bay, and it is the refinement this stage makes to Stage 2A.2's phase theorem:

> The lot-boundary identity holds on the **frontage line**, not the centreline. Where an edge is straight the
> two coincide and the cut is exact. Huntington's centreline edge is 472.98 m while its two frontages are
> 471.61 m and 474.34 m, which round to **60 lots on one side and 61 on the other**. No cut position is a lot
> boundary on both, so the phase cannot be preserved on both.

The cut now searches the frontage grids directly and takes the position whose worst side is least out of
phase, bounded to one lot from the crossing. Result: **phase error exactly 0 on 16 of 17 cuts**, and on
Huntington the minimum achievable is **2.28 m**. Those 121 parcels are irreducible under a lot-grid cut.

**`DEPTH_COUPLING` is the other 77**, 55 of them Dartmouth. The edge is unchanged and the lot moved anyway,
because lot depth comes from `rayToRoad` cast up to `cfg.depth * 2 + 12` = 80 m, and inside that reach the ray
now hits factual geometry across the boundary. The furthest such parcel is at **63.11 m** — comfortably inside
80 m, which is the independent check that the mechanism is correctly identified. Replacing a road changes what
a lot 60 m away can see; that is a property of `buildPlots`, not of the seam.

**A hypothesis was tested and rejected.** That the residual came from junction destruction — a crossing
street's junctions lie *inside* the core, clipping deletes them, so the outside edge merges with its
neighbour — predicted Commonwealth Inbound, Public Alley 435, Fairfield and Huntington. Protecting the orphan
stubs then removed the first three entirely, so the prediction was wrong for 3 of its 4. Only Exeter shows the
effect (a 34 m control edge becoming 46 m), and it contributes nothing to the residual. The script is deleted
rather than kept.

---

## I. Routing

| | control | candidate |
|---|---|---|
| nodes | 397 | 432 |
| components / largest | 6 / 387 | 6 / 422 |
| core junctions | 13 | 16 |
| — can exit the core | 13 | **16** |
| — can be entered | 13 | **16** |
| — **traps** | 0 | **0** |
| dead ends (forward reach ≤ 10) | 44 | 48 |
| **worst forward reach** | **1** | **1** |

The 4 candidate-only dead ends are Fairfield's port, Commonwealth Inbound's port, and the two Commonwealth
orphan cut stubs — every one `forwardReach 1`, indistinguishable in kind from the control's Beacon, Newbury,
Arlington, Gloucester and Hereford Street stubs. Stage 2A.2's junction 36 (3 in, 0 out, reach 2 of 428) is
gone.

All five routing cases still resolve: outside-through-core 1014.61 m, east–west core 389.53 m, north–south
core 450.53 m, Commonwealth 390.39 m, near-Northeastern **648.89 m — unchanged from control**.

---

## J. Dependent systems

24 s of stepped runtime per world across four areas, actors released. `api.step()` rather than real time —
the Browser pane pauses `requestAnimationFrame` when hidden, which made every vehicle read as stuck in
Stage 2A.2. Spawn and core-spec counts agree exactly with the headless build, which is the cross-check that
the runtime is the same world the measurements describe.

| traffic | control | candidate |
|---|---|---|
| distinct vehicles in the core | 80 | 82 |
| core entries / exits | 27 / 2 | **32 / 9** |
| **off-road samples** | **0** | **0** |
| **building-penetration samples** | **0** | **0** |
| stuck ≥ 4 / ≥ 6 | 0 / 0 | **0 / 0** |

| pedestrians | control | candidate |
|---|---|---|
| in the core | 141 | 184 |
| **inside a building** | **0** | **0** |
| on the carriageway | 15 (10.6%) | 26 (14.1%) |
| further than 40 m from any road | 0 | 0 |

Pedestrians on the carriageway is **not** an improvement here and is not claimed as one; Stage 2A.2's "44%
fewer" does not carry over to this sampling. No pedestrian is inside a building or stranded in either world.

Spawns 3712 → **3750** (core 118 → 144), 0 non-finite, 0 further than 20 m from a road in the core.
Core building specs 361 → 386. Huntington's `nuniv` station section still attaches, with matching lanes and
median. Northeastern parcels unchanged; Northeastern remains CLOSED/FROZEN and was not touched.

---

## K. Visual

The Stage 2A.1 camera-fair set is reused unchanged and re-verified: all 5 cameras still stand in open air in
**both** worlds with 4 m vertical clearance. Each world captured from its own page load at a matched
1920 × 1080; the candidate captured **twice**, from two separate loads, to give an A/A noise floor — the
Stage 1B.1 lesson that an unanchored pixel percentage measures film grain.

| view | A/B % > 32 | A/A floor | signal | mean abs A/B |
|---|---|---|---|---|
| B_boylston_block | 49.83 | 0.32 | 49.51 | 43.78 |
| C_cross_exeter_fairfield | 50.77 | 0.38 | 50.39 | 47.71 |
| D_district_overview | 29.65 | 0.06 | 29.59 | 27.83 |
| E_commonwealth | 34.33 | 0.60 | 33.73 | 32.45 |
| F_seam | 48.14 | 0.09 | 48.05 | 42.09 |

Signal is 50–500× the floor. These are **not verdict-driving** — the verdict rests on the measured
containment, routing and system numbers — they confirm the change is where it should be and nowhere else.

---

## L. Invariants

- Stage 2A: **26 of 26 hold.** Control fingerprint `5fa6c6be79473213` unchanged; both flags together still
  disable both; `?gisBackBay` alone unchanged at `07160ebe8509a742`.
- Stage 2A.1: 12 of 13 hold. The one failure is `connectors are short (≤ 40 m)`, superseded in §E.
- Stage 2A.3: **16 of 16 hold**, including *Commonwealth Inbound and Outbound are never cross-connected*,
  *every connector crosses no other road*, *every connector ends on a lot-grid cut*, *every TERMINAL port and
  every orphan cut stub carries `noSnap`*, *no hand-authored street carries `noSnap`*, and *the only
  out-of-phase cut is the one bent edge*.

---

## M. Verdict — **PARTIAL**

Closed: the Phase 2 question, port ownership (23/23 classified), the arbitrary baseline-node join, the
Commonwealth carriageway cross-connect, and the routing sink.

Not closed: containment. 224 parcels and 167 specs still change beyond the declared 6.96 m seam. 121 of those
cannot be fixed by a better cut, 77 are `buildPlots`' own 80 m depth coupling, and 10 are frontage on
synthetic connectors.

**The candidate remains DEFAULT OFF.** Nothing ships to the player.

---

## N. Limitations

- SAM is an addressing/routing centreline set, not surveyed pavement. Only geometry, identity, ZLEV and
  one-way sense are factual; width, lanes, class, kerb and parking remain procedural.
- 12 of 23 ports are terminal. Four are one-way and therefore dead-end at the seam. They are ordinary dead
  ends, not traps, but they are not a finished street network.
- The `(concept, face, order)` key assumes a street's crossings keep their order around the boundary. That
  is safe for a registration error but would not survive a genuinely different street alignment.
- The connector-validity test is binary. It rejects the Commonwealth joins correctly, but it cannot say
  whether a *shorter* honest join exists — for Commonwealth none does, because the carriageways are swapped.
- The 2.28 m Huntington phase error is a minimum over the available cut positions, not a proof that no other
  cut policy does better.

---

## O. Owner decision required next

1. **Commonwealth's swapped carriageways.** Boston draws Inbound north of the mall and Outbound south;
   reality is the reverse. Correcting `boston-geo.js` would make the seam joinable and is a small authored
   change — but it edits the hand-authored baseline, which no stage has yet been authorised to do.
2. **Huntington's 121 parcels.** The only alternatives to a 2.28 m phase error are a junction cut (exact, but
   leaves a 216 m gap with no Huntington at all) or accepting the drift. This is a world-quality call.
3. **Whether `DEPTH_COUPLING` should count against containment at all.** 77 parcels change because
   `rayToRoad` sees across the boundary. That is `buildPlots` working correctly on new geography, and a
   containment contract that forbids it forbids the feature.
