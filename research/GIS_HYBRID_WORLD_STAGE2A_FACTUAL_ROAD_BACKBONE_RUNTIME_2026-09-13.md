# Stage 2A — factual road backbone, Back Bay isolated runtime prototype

**Date** 2026-09-13 · **Baseline** `aa048447c4694900ad4b5cf3e8cf6b55cc6a4115` (HEAD == origin/main, clean, 0/0)
**Scope** Back Bay core only · default OFF · reversible · local, unpushed.
**No** citywide migration, production enablement, factual buildings, factual width, vertical GIS, or deployment.

---

## A. Executive summary

**Boston regenerates cleanly from factual street centrelines, and the city it builds lands much closer to the
real one.** One variable changed — the geographic centreline backbone inside a 400 × 400 m box. Every width,
class, frontage rule, parcel rule, facade, sidewalk, prop and collider is the code that was already there.

| measurement | control | candidate |
|---|---|---|
| **road line inside a factual building** | **42.35%** | **0.22%** |
| **procedural wall → factual wall, median** | **16.77 m** | **5.84 m** |
| … p75 / p90 | 26.21 / 37.71 m | 15.82 / 26.54 m |
| core road edges / nodes / junctions | 35 / 16 / 13 | 46 / 19 / 18 |
| core parcels / buildings | 389 / 361 | 423 / 400 |
| citywide buildings | 10,278 | 10,278 |

The second row is the one that matters and it is new. Stage 1E proved the *source* was better registered.
This proves the consequence: feeding those centrelines into Boston's unchanged procedural machinery moves
**Boston's own generated streetwall** from 16.77 m to 5.84 m from where the real wall is — a 65% reduction —
with no factual building data involved at all. Every street improves:

| street | control | candidate |
|---|---|---|
| Newbury | 18.89 m | **6.76 m** |
| Boylston | 14.38 | **5.20** |
| Exeter | 15.89 | **3.66** |
| Fairfield | 13.22 | **9.15** |
| Blagden | 38.30 | **3.46** |
| Huntington | 11.10 | **4.87** |
| Ring Road | 19.38 | **4.37** |
| Commonwealth Ave Inbound / Outbound | 11.41 / 18.17 | **6.91 / 6.20** |

**26 of 26 invariants hold**, including exact default-off parity and mutual exclusion with the Stage 1B
building experiment. The frozen Northeastern district is **untouched: 0 parcels changed**. No new landmark
keep-out violation.

The honest counterweight is the blast radius. Replacing the middle of a street re-subdivides the whole road
edge it belongs to, so **1,038 parcels outside the core move, a median 88 m and up to 284 m beyond its edge**,
across 14 of 107 streets. Every one of them is a Back Bay street or its immediate continuation, nothing is
lost citywide (10,278 buildings before and after), and Northeastern is clear — but it is more than the
"minimum seam" the authorization asks for, and it is reported as a limitation rather than a footnote.

---

## B–C. Baseline and resources

`HEAD == origin/main == aa04844`, clean, 0/0, no merge state, remote `EugeneYip/Boston`, three auxiliary
worktrees untouched. Static work ran at 28–32% memory free, 560–1,029 MB swap headroom, load 3.1–4.1, with
**three `xcodebuild` processes running throughout and untouched**. No App-development process was signalled.

## D. Source and provenance, carried forward unchanged

| | |
|---|---|
| dataset | **Boston Street Segments (SAM System)** — Boston Maps, City of Boston |
| licence | **ODC-PDDL-1.0**, `license_id: odc-pddl` from the Analyze Boston CKAN API |
| catalog | `https://data.boston.gov/dataset/boston-street-segments-sam-system` |
| service / layer | `gisportal.boston.gov/.../SAM/Live_SAM_Address/FeatureServer/3` · `SAM_Boston_Segments_tbl` |
| retrieved | 2026-09-13 · raw sha256 `647830c587888f61…` |
| projection | service EPSG:4326 (native EPSG:2249 ftUS), then production `src/core/Geo.js geo()` |
| research fixture | `research/gis-stage1e/backbay-roads.json` |
| **runtime candidate** | `src/data/gis-backbay-roads.js`, **23,401 bytes**, sha256 `f253aed9afa9a324…` |

No live network at runtime — the candidate is a static ES module. Managed Streets was **not** blended in; no
OSM; no DOIT.

## E. Core, seam, and what was filtered

**FACTUAL CORE** — the canonical Stage 1A box, unchanged: `x [−1380.46, −980.50], z [454.52, 854.60]`,
400.0 × 400.1 m. SAM features were selected by *intersects*, so they extend naturally a little past the
boundary; that overhang is the seam and nothing was extended on purpose.

**44 factual surface streets** emitted from 44 SAM surface features. **8 features excluded, not flattened:**

| excluded | why |
|---|---|
| `Massachusetts TPKE W` (`ZLEV −1,−1`) | the Turnpike runs in a **tunnel under Back Bay** |
| 4 unnamed ramps (`ZLEV 0,−1` · `−1,0` · `−1,−1` · `−2,−1`) | grade-separated approaches |
| `Exeter PLZ` (`CFCC A71`) | pedestrian plaza, not a road |

Pulling those onto the surface network would have driven an eight-lane highway through Newbury Street. The
filter is two published attributes applied generically, not a list of names.

**11 hand-authored streets clipped** to 15 outside-core runs; 2 removed entirely inside the core. 113
untouched streets pass through by reference.

## F. Semantic mapping — geometry, not a lookup table

Factual: centreline geometry, street identity, `ZLEV`, one-way sense. **Procedural and unchanged:** width,
lane count, road class, footway, kerb, parking, surface. SAM publishes no authoritative width and Stage 2A
invents none — the point is to isolate the geometry variable, so each factual street inherits the width
semantics Boston already uses for the street of that name.

Priority: normalised street identity → Boston's own concept → source class only where Boston has no such
street. **36 of 44 mapped to a Boston concept; 8 fell back on source class** (Public Alleys 432/433/434/440/441,
which Boston does not model, plus Clarendon Sq and two Stuart St segments). No address exceptions.

One-way is taken from SAM because the emitted path is SAM's own vertex order; Boston's flag refers to Boston's
authored direction and on a reversed line would send traffic backwards. That is consumed for graph
correctness, and it is the only routing attribute consumed.

> **Two mapping bugs found and fixed, recorded because both produced plausible output.** First, Boston splits
> Commonwealth Avenue into *Inbound*, *Outbound* and *West* while SAM calls all of it "Commonwealth AVE";
> taking the first name-prefix match sent **every** factual carriageway to Inbound and left Boston with
> 107 parcels on one side against 216 on the other, where the baseline has 167/168. Second, the replacement
> side test compared raw `z` to the group mean, which is only meaningful for a due-east-west street —
> Commonwealth runs west-southwest, so "along the street" leaked into "across" it. Both are now resolved by
> assigning each factual carriageway to the Boston carriageway it is geometrically **nearest** to, which also
> drops "West" — a different street a kilometre away — without naming it. Result: 1 Inbound / 2 Outbound, and
> parcel counts 151/172 against the baseline's 168/167.

## G. Runtime seam

One line in `RoadNetwork.build()`:

```js
let src = STREETS;
if (gisRoadsEnabled()) { const r = gisRoadsApply(STREETS); src = r.streets; this.gisRoadLedger = r.ledger; }
const streets = src.map(s => this._prepare(s));
```

Everything downstream is untouched. `_prepare`, crossing detection, `END_SNAP`, `GRADE_SEP`, `buildSidewalks`,
`buildPlots`, `buildSpawns`, `Buildings`, `Facades`, traffic, props and colliders all run exactly as before,
on different geometry.

Order inside `apply()` is load-bearing: hand-authored entries come first so `build()`'s pass-2 endpoint snap —
which **moves the endpoint it is processing** — pulls the clipped procedural stubs onto the factual lines
rather than the reverse. **The factual core is never warped, translated, rotated or rubber-sheeted.**

**Ledger:** 44 factual streets · 113 procedural kept · 11 clipped → 15 runs · 2 fully removed.

## H. Flag and default-off parity

`?gisRoads=1`. Absent ⇒ `apply()` never called.

| | control | unrelated flag | **both flags** | candidate |
|---|---|---|---|---|
| `gisRoadLedger` | **null** | **null** | **null** | populated |
| road edges | 540 | 540 | 540 | 553 |
| plots | **10,944** | 10,944 | 10,944 | 10,937 |
| specs | **10,278** | 10,278 | 10,278 | 10,278 |
| clip stats | `{15,1,778,26}` | — | — | `{17,1,785,26}` |
| **city fingerprint** | `5fa6c6be79473213` | `5fa6c6be79473213` | **`5fa6c6be79473213`** | `83ff879addc0f720` |

**Flags are mutually exclusive and fail safe.** `?gisRoads=1&gisBackBay=1` disables **both** and returns the
exact baseline fingerprint — the Stage 1B candidate replaces buildings on parcels derived from the
hand-authored roads, so stacking it on a moved road graph would produce a result neither experiment could be
held responsible for. `?gisBackBay=1` alone still behaves exactly as committed (8 replacements) and leaves the
roads untouched.

**26 of 26 invariants hold** (`research/gis-stage2a/validate.json`), including finite coordinates, no
zero-length road, no self-loop, no tunnel line on the surface network, all 8 key streets present in the core,
and no network call in the runtime road path.

> One invariant was wrong when first written and is recorded: "no duplicate edge" **fails on the baseline
> too**. Boston already publishes streets that share a stretch of carriageway — Clarendon with Columbus, Ring
> Road with Huntington — giving the control 6 duplicate groups. The candidate has **5**. The invariant is now
> "introduces no new duplicate", which is the question that was actually meant.

## I. Structural regeneration

| | control | candidate |
|---|---|---|
| road edges city / core | 540 / 35 | 553 / 46 |
| road nodes city / core | 397 / 16 | 417 / 19 |
| core junctions | 13 | 18 |
| core road length | 3,213.5 m | 3,674.3 m |
| parcels city / core | 10,944 / 389 | 10,937 / **423** |
| buildings city / core | 10,278 / 361 | 10,278 / **400** |
| parcel width min/median/max | 4.49 / 8.26 / 8.50 m | 3.88 / 8.11 / 9.00 m |
| parcel depth min/median/max | 8.48 / 22.19 / 34.00 m | 8.03 / 20.67 / 34.00 m |
| clip stats | `{clipped 15, dropped 1, trimmed 778, superblocks 26}` | `{17, 1, 785, 26}` |
| core dangling nodes | — | **0** |
| sidewalk strands | 7 | 7 |
| spawns city / core | 3,712 / 118 | 3,740 / **137** |

Counts are not required to match — the geometry is supposed to change. They reconcile and stay plausible:
more streets in the core yields more parcels and more buildings, parcel dimensions stay inside the same
envelope, citywide building count is **identical**, and only one parcel is dropped by clipping.

## J. Factual registration, re-measured after normalization

The check the authorization insisted on: does SAM keep its Stage 1E alignment after passing through
`RoadNetwork.build()`'s crossing detection, endpoint snapping and resampling?

| | Stage 1E raw source | Stage 2A after normalization |
|---|---|---|
| road line inside a factual building | 0.23% | **0.22%** |

It does. Per street, the candidate is **0.00%** everywhere except Ring Road at 4.26%, against a control of
Commonwealth Avenue Inbound **100%**, Public Alley 435 93.5%, Blagden 90.0%, Huntington 66.7%, Exeter 60.0%,
Newbury 43.1%, Fairfield 41.0%, Ring Road 32.7%.

## K. Blast radius, Northeastern, landmarks

**1,859 parcels change; 1,038 lie outside the core**, a median 88.1 m and a maximum 284.4 m beyond its edge,
across **14 of 107 streets** — Blagden, Boylston, Clarendon Sq, both Commonwealth carriageways, Dartmouth,
Exeter, Fairfield, Gloucester, Huntington, Newbury, Ring Road, Saint James, Stuart.

The mechanism is `buildPlots` subdividing **per road edge**: clipping a street and adding crossings re-splits
edges that enter the core, and an edge can be hundreds of metres long, so its lot rhythm is re-phased along
its whole length. This is a consequence of the parcel generator, not of factual geometry leaking outward —
the factual lines themselves stop at the core. It is nevertheless wider than a minimum seam and is recorded
as such.

> An earlier reading of this put changes 284 m away on Monument Avenue and Louisburg Square, in Charlestown
> and Beacon Hill. That was an artefact of a parcel key rounded to 1 m producing false mismatches. With exact
> geometry keys both streets are **identical**, and the real answer is the 14 Back Bay streets above.

**Northeastern: 0 parcels changed** inside the hero envelope plus a 150 m margin. The district stays frozen.

**Landmarks: 16 keep-out violations in the control and the same 16 in the candidate** — pre-existing baseline
properties (Trinity 10.17 m against a 52 m keep-out, One Prudential 4.98 m against 40 m, and so on). Stage 2A
introduces none and removes none.

**One defect, candidate-only:** `[roads] local section "nuniv" on edge 446 would change lane count 4 → 2;
refused`. Boston's Northeastern lane-section rule is authored in world space and projected onto whichever
edge it lands on; clipping Huntington Avenue — which runs from Back Bay toward Northeastern — changes that
edge's extent, and the section now lands somewhere its lane count does not match. **The engine refused the
change**, which is the safe outcome, and no Northeastern geometry moved. It is a real seam defect and it is
reported, not fixed: Northeastern is frozen.

## L. Reproducibility

`node research/gis-stage2a/build-candidate.mjs` reads the committed Stage 1E fixture — never the network —
and regenerates `src/data/gis-backbay-roads.js` byte-identically. `headless.mjs` and `validate.mjs` drive the
production path by setting `globalThis.location`, so they exercise the real code rather than a copy.
Control-vs-control in one process is bit-perfect (0 differences of 10,944 parcels and 10,278 specs), which is
what makes the candidate deltas trustworthy.

## M. Render gate and boot

Checked immediately before WebGL. The three `xcodebuild` processes that had been running through the static
phase **finished**, and swap headroom recovered from 560 MB to a stable 0.9–1.1 GB across a bounded 5-minute
observation, with load flat at ~4.0 and Simulator idle at 6.1% CPU. That is comparable to the window in which
the Stage 1B.1 captures succeeded and clear of the 306 MB state that blocked them, so the session proceeded.
After capture: 28% memory free, 1,068 MB headroom, load 3.18, `xcodebuild` back to 3 — the builds restarted
*after* the evidence was taken. One WebGL context, no second renderer, no MapLibre.

**Boot gate, candidate:** `failed: []`, `glFaults: []`, no uncaught exception, graph builds, buildings
generate, every capture reported `settled: true`. Browser numbers match headless exactly — 553 road edges,
417 nodes, 10,937 plots, 10,278 specs, clip `{17, 1, 785, 26}` — and `gisLedger` is `null`, confirming the
Stage 1B building experiment is not stacked.

## N. Paired visual A/B

Six viewpoints, all derived from the **candidate** geometry and held ≥45 m inside the core so the transition
seam never enters a verdict frame. Identical camera, look, FOV, viewport (1350 × 840), `tod 10.5`,
`weather clear`, `quality high`, `warmup 26`, `holdActors true`. Paths, camera state and SHA-256s are in
`research/gis-stage2a/captures.json`; PNGs are local only.

> **A bias that must be stated before any verdict.** Because the cameras were placed on the *factual*
> carriageway, the control is systematically disadvantaged at street level: the camera lands where the real
> road is, which in the baseline is often inside or beside a block. Views A, C and F therefore evidence
> **registration**, not art direction — a camera placed on Boston's own baseline road would show a perfectly
> good street in the control too. The **camera-fair** pairs are D (elevated oblique) and E (district
> overview), where both worlds are fully visible, and B, where the two alignments happen to be close enough
> that both cameras land on a carriageway. The verdict leans on those.

| view | verdict | evidence |
|---|---|---|
| **A_newbury** — primary streetwall | **MATERIALLY BETTER** *(camera-biased)* | The control is a blank brick wall filling the frame: the factual Newbury line is inside a block in the baseline. The candidate is a complete Back Bay street — rowhouse facades both sides, street trees, kerbside parking, lane markings, a clean receding vista. |
| **B_boylston** — second primary | **SLIGHTLY BETTER** *(camera-fair)* | Both read as convincing Boston. The candidate's section is slightly narrower and better enclosed, with a terminated vista on a tower at the end of the street; the control is a little wider and more open. A real but small difference. |
| **C_exeter** — cross street | **MATERIALLY BETTER** *(camera-biased)* | Control is wedged between two parked cars facing a doorway; candidate is a coherent street canyon. Same registration story as A. |
| **D_block_oblique** — elevated | **MATERIALLY BETTER** *(camera-fair)* | The decisive art-direction pair. The control block is a run of **detached rowhouse clumps with gaps between them**; the candidate is a **continuous party-walled terrace** with a consistent cornice line and chimney rhythm — the defining Back Bay character. Better parcels from better roads, with no factual building data involved. |
| **E_district_overview** — aerial | **SLIGHTLY WORSE** *(camera-fair)* | The control's street grid reads more clearly from above and Commonwealth Avenue's planted mall is legible as a wide green diagonal. The candidate is busier — more streets, smaller blocks — and the mall reads much less distinctly. This is the one camera-fair regression and it is not dismissed. |
| **F_commave** — divided-road diagnostic, **not verdict-driving** | candidate coherent, control an undifferentiated grey expanse | Both frames show the same pre-existing floating-cornice facade artefact, present in the baseline and neither caused nor fixed by Stage 2A. |

**No primary view is materially worse.** One camera-fair primary is materially better (D), one is slightly
better (B), one is slightly worse (E).

**Performance:** draws 617/663/599/589/458/639 → 631/634/608/580/572/605 — within ±14 except the overview,
which gains 114 draws because more streets are visible. Triangles move within the project's usual
shadow-cascade caveat. Candidate data 23,401 bytes. No material or batching explosion.

## O. Dependent-system verdicts

| system | verdict | evidence |
|---|---|---|
| road rendering | **PASS** | 553 edges render; no NaN; no geometry explosion; clean boot |
| sidewalks / public realm | **PASS** | 7 strands both sides; no inversion, self-overlap or impossible corner observed in any capture |
| parcels / frontage | **PASS** | 389 → 423 in core; widths 3.88–9.00 m, depths 8.03–34.00 m, inside the baseline envelope; 1 parcel dropped by clipping |
| procedural buildings | **PASS** | 361 → 400 in core, 10,278 citywide unchanged; **no block-hollowing** — the Stage 1B.1 pathology does not recur, because buildings remain wholly procedural |
| traffic / routing | **MINOR_DEFECT** | graph builds with 0 dangling core nodes, 18 core junctions, no tunnel line on the surface network, and no accidental tunnel/surface junction. Vehicles render and park correctly in every capture. **Not tested:** live route enter/traverse/exit of the core, and sustained traffic behaviour — neither is observable headlessly and the capture session was deliberately short |
| pedestrians | **NOT_TESTED** | none observed misplaced in captures, but no systematic audit was run |
| props / street furniture / parked vehicles | **PASS** | parked cars sit on the kerb, lamps and signs on the footway, awnings on facades in all six candidate frames; no prop in the carriageway observed |
| collision | **NOT_TESTED** | regenerates from the candidate world through the normal pipeline; no separate collision geometry was introduced. Internal consistency not independently verified |
| player spawn | **PASS, unchanged** | default-off spawn is untouched; spawn points regenerate 3,712 → 3,740 citywide and **118 → 137 inside the core**, so the prototype is enterable without any magic coordinate |
| terrain / water | **PASS, untouched** | not migrated; no crash guard needed; no new terrain/water conflict observed |

## P. Transition seam

**SEAM ACCEPTABLE_WITH_LIMITATIONS.**

Clean: the factual core is unwarped — no translation, rotation or rubber-sheeting was applied, and hand-authored
entries are ordered first so the endpoint snap moves the procedural stubs rather than the factual lines. Core
topology has **0 dangling nodes**, all 8 key streets present, no graph break, and no seam geometry enters a
verdict-driving frame (every camera is ≥45 m inside the core).

Limitations, all outside the core:

1. **Re-subdivision reaches further than a minimum seam** — 1,038 parcels outside the core, median 88 m, max
   284 m, on 14 of 107 streets (§K). Bounded to Back Bay and its continuations, nothing lost citywide.
2. **A Northeastern lane-section rule mis-targets** — clipping Huntington Avenue moves the edge that Boston's
   `nuniv` local section projects onto, and the engine **refuses** the lane change (4 → 2). Safe, logged,
   candidate-only, and **no Northeastern geometry moved**. Reported, not fixed: that district is frozen.
3. **Two hand-authored streets are removed entirely** inside the core and rely on their factual replacements.

## Q. Verdicts

**Factual-geography verdict: MATERIALLY IMPROVED.** Road-line-inside-a-building 42.35% → 0.22%; procedural
wall-to-factual-wall median 16.77 m → 5.84 m; every measured street improves; no new landmark keep-out
violation; Northeastern untouched.

**Procedural-art-direction verdict: PRESERVED, and improved at the block.** Brick, cornices, bays, stoops,
mansards, awnings, shopfronts, street trees and kerbside parking are identical in kind — this stage added no
art. The one art-direction change is a consequence of better parcels: continuous party-walled terraces where
the baseline had detached clumps (view D). Against that, the district reads busier from above (view E).

# Stage 2A: PASS

Against the authorization's PASS list: Stage 1E source and provenance preserved · default-off parity exact
(identical fingerprint, and identical again when both flags are supplied) · factual core unwarped · seam
bounded and outside every verdict frame · topology valid, 26/26 invariants · grade separation respected, no
tunnel on the surface network · candidate boots cleanly with `failed: []` and `glFaults: []` · factual
alignment survives normalization (0.23% → 0.22%) · procedural registration materially improves (16.77 → 5.84 m)
· parcels and buildings regenerate without catastrophic defect · no block hollowing · hero and landmark
relations unchanged · routing graph builds with no dangling core node · no catastrophic traffic, sidewalk or
collision failure · paired evidence materially improves a camera-fair primary view (D) · no primary view
materially worse · Boston's procedural visual language survives intact.

The two PASS criteria that are **satisfied only partially, and are the reason a reasonable reviewer might
call this PARTIAL**: live routing traversal and collision consistency were not independently verified, and the
district overview is slightly worse. Neither is a defect in the geography; both are untested or bounded.

## R. Owner visual acceptance — **OUTSTANDING**

Technical PASS does not authorise production migration. The prototype is **DEFAULT OFF**, unpushed,
undeployed. Paired captures are local at the paths in `captures.json` for the Owner's own review, and the
camera-bias caveat in §N should be read before judging them.

## S. Limitations

1. **Back Bay core only** — 400 × 400 m, 44 streets. Nothing citywide is claimed or tested.
2. **Blast radius exceeds a minimum seam** — 1,038 parcels outside the core, up to 284 m (§K).
3. **`nuniv` lane-section mis-target**, refused safely, unfixed because Northeastern is frozen.
4. **Live traffic, routing traversal, pedestrians and collision are not verified** — headless cannot observe
   them and the capture session was kept short.
5. **The district overview is slightly worse**; the Commonwealth mall reads less clearly.
6. **Street-level cameras are candidate-derived** and therefore biased; only D, E and B are camera-fair.
7. **8 of 44 streets took a source-class fallback** (5 Public Alleys Boston does not model, Clarendon Sq, two
   Stuart St segments). Clarendon Sq as `arterial/4` is almost certainly too generous for a small square.
8. **SAM remains an addressing/routing centreline, not a surveyed pavement centreline**, and supplies no
   width. Widths stay procedural and unvalidated.
9. **The ~0.97 m NAD83↔WGS84 datum offset** measured in Stage 1E is unresolved; it is common to roads and
   buildings so it cancels in every comparison here.

## T. Owner decision required next

**Stage 2A stops here.** Nothing is enabled, nothing is pushed, `STREETS` is unchanged without the flag.

1. **Review the paired captures and decide whether the geography is worth the migration.** The measurements
   say yes; the district overview says the grid reads busier. That is a judgement about Boston, not about
   data, and it is the Owner's.
2. **If yes, the natural next stage** is a bounded *seam* stage: shrink the 284 m re-subdivision radius, and
   decide what to do about `nuniv` and the Commonwealth mall — not a citywide migration.
3. **If no**, the programme has still produced a complete, reproducible negative-and-positive record across
   six stages, and the prototype remains as default-off evidence.

**Not authorised and not begun:** citywide SAM migration, factual widths, factual sidewalks, factual parcels,
Stage 1C streetwall integration, factual buildings, traffic or collision redesign, terrain correction,
Northeastern work, default-on, deployment.

---

*Stage 2A. Candidate committed **DEFAULT OFF**. Without `?gisRoads=1`, Boston is bit-for-bit the city it was
at `aa04844`. Not pushed, not deployed, not enabled.*
