# CURRENT_STATE.md — living project state

**Update this file whenever you fix something or find something.** It is the handover
surface: a new agent should be able to read only this and know where to start.

Last verified: **2026-08-31, commit `b12497d`** (the B2 docs record; `1beada1` is B2 itself). Verify with `git rev-parse --short HEAD` rather than trusting this line. **The runtime figures below still date from that commit.** The lifecycle audit that followed (through `8e3a825`, see §Lifecycle audit) was static/Node-only and changed no rendering behaviour, so it neither refreshes nor invalidates them.

> **Canonical repository is `/Volumes/Projects/boston`, on an external SSD. If
> `/Volumes/Projects` is not mounted, STOP** — never fall back to or recreate another
> checkout. `~/Desktop/boston` was renamed `boston-OLD-DO-NOT-USE` and is stale.
>
> **`AI_HANDOFF.md` is now the primary cold-start document.** It carries the canonical
> repo rule, the current checkpoint, the attribution lessons, the full measurement-trap
> list, the resource policy, worktree safety and the prioritised open work with an
> explicit do-not-reopen list. Read it first; this file is the detailed living state
> behind it. Do not duplicate that content here — update it there.
>
> **Pushes are manual.** Local `HEAD` may be ahead of `origin/main`; check
> `git log --oneline origin/main..HEAD` rather than assuming.

> **Note on verification while several agents are running.** `capture()` runs the engine's
> `update()` chain, so a throw in *any* system aborts the shot. If you need a shot and
> someone else's system is mid-flight, stub its `update` at runtime rather than editing
> their file. Use the HMR-free verify server (`npm run verify`, port 5290, also in
> `.claude/launch.json` as `boston-verify`) rather than `npm run dev` — the shared dev
> server full-reloads every tab on every save. Do NOT `vite build` to get a stable target:
> this machine runs with ~7 GiB free and duplicate build artifacts are not affordable.
>
> **Pixels are unavailable while the Browser pane is hidden — verified 2026-08-30.** A
> hidden pane collapses the canvas (drawing buffer goes to 1x1, composer buffers report
> 0x0) and the GPU then produces nothing at all: `readPixels` on the default framebuffer,
> a same-task read with no `await`, and an offscreen FBO render are **all** solid black,
> and forcing `setSize`/`composer.setSize` up to 2880x1620 does not recover it. Any visual
> claim made in that state is fiction. Geometry, physics and point-in-polygon work are
> CPU-side and unaffected. `measureFps()` refuses by design when `document.hidden`; when
> the pane IS visible, drive frames synchronously and force GPU completion instead:
> ```js
> const b=window.__boston,r=b.engine.renderer,gl=r.getContext();
> function bench(n){const s=[];for(let i=0;i<n;i++){const t=performance.now();b.step(1/60);gl.finish();s.push(performance.now()-t);}s.sort((a,c)=>a-c);return s[Math.floor(s.length/2)];}
> ```
> Keep any one evaluation under ~40 `step()` calls; ~190 exceeds the tool timeout.
>
> **Sample road centrelines from `edge.pts`, never a node-to-node chord.** Streets are
> curved polylines (Beacon St edge 0 has 10 points); a chord cuts the corner and passes
> through the buildings on the inside of every bend. That mistake manufactured a false
> 7.9% buildings-in-road failure rate during this pass. Always include the self-test —
> 500 building centroids must test inside their own polygon — or the number means nothing.
>
> **Disk pressure here is swap, not transcripts.** Concurrent hidden WebGL contexts each
> hold a full city scene; three 1 GiB swapfiles appeared during one 3-agent wave and were
> reclaimed when the agents exited. Close browser tabs when done and keep waves to a maximum of 2 agents, and only 1 WebGL-heavy at a time (see AGENTS.md).

---

## Status at a glance
| | |
|---|---|
| Boots | Yes — `bootReport.failed` is `[]`. The "22 systems" figure here was stale: the runtime registers **26** (4 core + 22 optional), read from `engine.systems` at boot on 2026-09-01. A static source count in the D2 notes said 25 — it missed `Profiler.js` — `Missions.js` is the only `OPTIONAL` entry that does not exist. That is a source count, **not** a re-measured boot figure. |
| Console | `__boston.errors` is `[]` and `__boston.glFaults` is `[]`. The `glDrawArrays: Feedback loop formed between Framebuffer and active Texture` warning is **gone** — it was `LensPass`; see §Resolved. Stubbing every pass but one and reading `gl.getError()` now returns `NONE` for all ten. |
| Frame cost | **Inside budget. Perf is no longer the headline problem — stop optimising.** Settled medians at 1920×1080 `high`, measured 90 frames past the streaming catch-up window with `gl.finish()` (critic pass on `4311bd1`): `st_backbay` 4.7 ms · `st_northend` 6.7 · `st_southend` 6.9 · `night_neon` 6.6 · `st_beaconhill` 11.8 — all inside 16.7 ms. **Every absolute fps figure recorded before 2026-08-30 is void**, including "8 fps at 1080p high is now the headline problem" in PROGRESS iteration 6: they came from `engine.perf`, which times the throttled rAF cadence rather than work done and reported 71.74 ms on a frame that really costs 6.5 ms. `measureFps()` cannot help — `document.hidden` stays `true` for the embedded pane even when it is visible. Use the synchronous bench above. |
| Frame time (AO+SSR live) | **Re-verified 2026-08-30 at `da004e2`, the first measurement taken with AO and SSR actually in the compositor** — every earlier figure was taken while both were silently absent. Short-burst protocol, 1920×1080 preset `high`, two agreeing bursts per shot: `hero_skyline` 3.7 ms · `overcast_wide` 3.7 · `night_neon` 4.5 · `st_southend` 4.7 · `st_beaconhill` 5.0 · **`rain_street` 5.1 with AO, SSR and Velocity all live**. Worst case is **31% of the 16.7 ms budget**. AO's measured cost is **0.15 ms** — it had been restricted to `ultra` on the strength of a 7.6 ms figure measured against a double-render that cannot happen in this build. SSR and Velocity correctly self-gate off in dry weather, so only wet frames pay them. |
| Budgets | **All budgets are met as of `d925cc1`.** Draws 597–667 of 1200 (down from 712–775). Camera triangles 1.82–2.51M of 3.5M. Shadow triangles, the last breach, are now **peak 2.22M / mean 2.03M at `night_neon`** and **1.75M / 1.59M at `st_beaconhill`**, against 2.5M. Attributed per cascade: Buildings LOD-0 chunks 45%, **Props 34%**, LOD-2 shell 18% — the shell was blamed for ~2M by two separate analyses and was never the problem. **`src/world/Props.js` is now the largest single item at 1.20M**: each prop type is one city-wide `InstancedMesh`, so its bounding sphere intersects every cascade and all 400k triangles go to all three every frame. Fix by splitting per streaming tile, sorting instances by distance so a per-cascade `object.count` gates them, or wiring those meshes to `onBeforeShadow` and the `csmTexel` that `CascadedShadows` now publishes. |
| Draws / tris | 341 / 2.14M at boot default (2026-08-30, all of wave 1 in tree) — **inside** the 1200 / 3.5M budget. Buildings' facade-on-short-edge fix also cut LOD-0 opaque tris 30% (997,743 → 698,251 across 341 Beacon Hill buildings). |
| Cold boot | ~8 s (was ~45 s) |
| Visual quality | **6/10** as of the critic pass on `9bd5e55` (2026-08-31), up from 3/10. Content is real and materially complete; the remaining problem is surface quality and grade, not content. |
| Daylight range | **Fixed by B1 (`11c02f9`).** The cause was NOT auto-exposure: the HDR buffer entering the tone mapper carries 3.5 stops of sky structure and only 0.005% of the frame exceeds AgX's clip point, but the grade's straight-line contrast about pivot 0.435 mapped everything above AgX 0.930 to >= 1.0 and `clamp()` flattened the top 7%. A highlight shoulder replaces the clamp (`highlightKnee` 0.86). Independently re-measured: `st_southend` clipped **3.08% -> 0.000%** with p99 245.1; `street_level` **3.35% -> 0.000%** with p99 248.2; `overcast_wide` p01 **54.9 -> 37.3**, p99 **200.6 -> 227.2**, frame sd **46.2 -> 60.3**. Night unregressed (mean 46.38 vs 46.2; below-L2 3.583% vs 3.59%). |
| Dusk grade | **Fixed by B2 (`1beada1`).** The scene was already amber — at `gradeIntensity(0)` `downtown_dusk` reads ~130.3/94.8/78.2 — and the time-of-day grade was removing ~17 green and adding ~10 saturation. Only the 19.7 keyframe changed. Verified: **139.9/76.6/79.3 (R>B>G, sat 53.3%) → 132.4/88.2/76.6 (R>G>B, sat 46.9%)**, clipping 0.000% both; `golden_hour` unchanged (140.7/130.2/127.6, sat 18.1%); `st_southend` clip 0.000% / p99 245.1; `night_neon` mean 46.49, black 3.563%. Regression safety is structural, but state it correctly: key 7 is the `b` endpoint for h in (18.2, 19.7) and the `a` endpoint for h in [19.7, 21.2), so B2 changes the evaluated look across **the open interval (18.2, 21.2)** — not "only 19.4 and 20.0", which was true of the *named shots* rather than of the code. `ColorGrade.js:188-191` states this correctly. Interpolation is C1 in hour at every key (`smooth(t)=t²(3-2t)`) and wraps correctly across midnight, so no temporal jump is possible. |
| Daylight hue | **CLOSED — no defect, legitimate scene composition** (runtime, 2026-09-01, measured at `dbcb1d1`). The whole-frame reading reproduces (R 109.7 / G 103.5 / B 109.5) but does not indicate magenta. **The pavement classes are not neutral surfaces**: asphalt's baked albedo is −5.31% on M/mean and concrete's is +4.53%, so M on them measures the material. Pinning albedo to those known means with `setAtlas(0,1)` gives rendered M/mean of **−2.96%** (asphalt sunlit, n=223), **−4.12%** (asphalt shadowed, n=11) and **+0.66%** (concrete sunlit, n=35) — every region keeps its input's sign and shrinks its magnitude, so the pipeline compresses chroma toward neutral rather than adding a green deficiency. Concrete goes in green-positive and comes out green-positive. Sky is B>G>R (M +2.44); the upper frame is red brick. `gradeIntensity(0)` moves asphalt −3.65 → −2.75 and concrete +0.79 → +0.63 — opposite directions, i.e. the grade acts on each material's own hue. No source change; the daylight `ColorGrade` keys were NOT touched. See `AI_HANDOFF.md` §9. |
| Road surface | **Rebalanced by Wave A (`19f32f4`) on spatial scale, not magnitude.** macro 18.68 sd/256 px -> **6.96/128 px**; chip 12.57/256 -> **10.79/16**; grit 7.58/2 -> **9.38/2**. `macro`'s 2.7 m octave was the offender. See `AI_HANDOFF.md` §5 before touching this — `grit` has been wrongly blamed once already. |

## Northeastern hero district — Wave 3B, campus ground + PDDL arrival (2026-09-08, `b01ba90`, `f864aea`)

> ### THE RUNTIME GATE IS OPEN. NONE OF WAVE 3B HAS BEEN RENDERED.
>
> Both sibling agents (the park-understorey and foliage-sliver tasks) held the
> WebGL lane for this entire session — port 5290 and 5292 — and swap ran
> 5.0-6.1 GB of a swapfile that grew from 3 GB to 7 GB. Opening a third WebGL
> context would have broken the one-browser-agent rule that this repository
> already has a corrupted git object to show for, so it was not opened.
>
> Everything verifiable without a browser WAS verified, and it found a real defect
> (below). **Not verified: z-fighting, surface seams, the eye-level result,
> pedestrian traversal of the new ground, traffic, and frame cost.** The first
> session with a free lane should run Wave 3B's Phases 8-11 before anything else.

**The PDDL public-realm source is finally in the repo rather than described in
it.** `docs/neu/SOURCES.md` has recorded the City of Boston Sidewalk Centerline
layer since the audit, but only its statistics were committed — the geometry was
measured once by an ad-hoc session and thrown away, which is why every wave since
has deferred paths. `tools/neu-walks/` now fetches it and emits
`src/data/neu-walks.js`.

**163 m ships of 11,439 m available.** Five ways from the Huntington public
sidewalk to the Krentzman octagon boundary, two more as the single westward
continuation, chosen by tracing endpoint connectivity outward from the Huntington
sidewalk (97257) so the route is genuinely connected — consecutive ways share
endpoints. Every way is validated against existing geometry and a failure is
dropped with a reason rather than nudged to fit: no hero footprint crossed, no
carriageway entered, nothing running through the octagon where `ParkPaths` already
owns the circulation. All seven passed. 97257 itself is NOT drawn — `Roads`
already builds that pavement and a second surface on it is a z-fighting seam.

**Campus ground: the shape is constrained, not authored.** Contour = convex hull
of the nine footprints within 110 m of the quad, dilated 24 m radially (safe on a
convex hull). Holes = the octagon plus every enclosed footprint, so
building-to-ground edges are exact. Then evidence decides the rest: a triangle is
dropped if its centroid is outside the `northeastern` district, inside a road
corridor, or inside a procedural building. Measured headlessly: 302 faces
subdividing to 5,776 at a 7 m max edge, **4,612 kept — 2,863 lawn (16,643 m2) and
1,749 paved (3,443 m2)**, 691 dropped outside the district, 415 in road corridors,
zero degenerate triangles.

**Road keep-out must come from the road.** The first pass used a fixed 11 m from
the Huntington centreline and was wrong in a way only arithmetic catches:

| Huntington (arterial, 4 lanes) | from centreline |
|---|---|
| travel lanes | 0.00 – 7.00 m |
| shoulder | 7.00 – 7.30 m |
| **parking lane** | **7.30 – 9.80 m** |
| kerb | 9.80 – 9.96 m |
| footway (`corridorHalf` = 13.56 m) | 9.96 – 13.56 m |
| campus ground (corridor + 1.2 m verge) | from 14.76 m |

`halfRoad` is 9.8 m, not 7.0 — it already includes the shoulder and a 2.5 m
parking lane. An 11 m keep-out would have laid campus ground ON the footway. It
now reads `corridorHalf(e)` off every nearby edge, so it adapts per street.

**One defect the headless pass caught.** `holes` only punches footprints lying
ENTIRELY inside the contour, so a part straddling the boundary — Cabot and the
Richards/Hayden link both do — left its overlap triangulated: **58 triangles of
lawn under hero buildings.** There is now an unconditional per-triangle footprint
rejection behind the holes. This is the kind of thing the browser would have shown
immediately and arithmetic found anyway.

**Zone balance was tuned once.** The apron started at 3.5 m and the surface came
out 50% paved, reading as a service yard rather than a campus — the ground is
mostly a *band* between buildings, so a generous apron eats it. At 2.2 m it is 83%
lawn.

**Opening candidates re-measured (Phase 7), and Wave 2C's reasoning corrected.**

| | Wave 2C said | Wave 3B measures |
|---|---|---|
| player (−1883, 1677) | 20.1 m off centreline | 20.2 m, on campus ground, **3.7 m from factual walk 96013** |
| SUV (−1848, 1645) | "9.2 m lateral, 2.2 m clear of the 7.0 m half-carriageway" | 8.7 m — **inside the parking lane (7.30–9.80 m)**, which is where a parked car belongs |

Wave 2C reached the right answer by the wrong route: it compared against the
travel-lane edge, not the corridor. The candidate is correct kerbside parking, and
now it is correct for a stated reason. Line of sight player→SUV is clear, 47.4 m
apart, 34 s at 1.4 m/s. Looking into the quad the player sees Ell/Curry at 112 m
(−10°) and Mugar at 116 m (+27°).

**Not done in 3B:** entrance cues (Phase 4) and all browser QA. Nothing was
faked in their place.

## Northeastern hero district — Wave 3A, fenestration + Krentzman ground (2026-09-08, `c50810b`, `8fc0798`)

Wave 2C's two named defects are closed: the masses were blank and the quadrangle
was dirt. The district now reads as an institutional campus at pedestrian
distance, which was the whole success criterion.

**Windows come from `Facades.frontStorey`, not from anything new.** It and
`edgeFrame` are now exported; that is the entire change to `Facades.js` and the
generated path is untouched. `NeuHero` cannot go through
`makeSpec`/`buildBuilding` — those bring procedural roof clutter, chimneys and
fire escapes, and its footprints and heights are factual — so it builds a minimal
spec per part and calls the frontage primitive per edge per storey. Same shader,
same reveals, same two buffers, and the night-light path came free: `spec.lit`
makes individual windows glow at dusk with no lighting work at all.

**Floors come from evidence.** The generator emits graded storey evidence and
`NeuHero` reads it:

| basis | buildings | course |
|---|---|---|
| **C** — OSM levels corroborated by the factual height | Richards, Hayden, Dodge, Mugar, Dana (5); Ryder (4) | 3.69-4.33 m |
| **D** — assessor count in the package's own targeted validation | Hastings (7) | 3.98 m |
| **DERIVED** — conservative 3.8 m course, gross-area implication recorded | Ell/Curry (4), Cabot (3), Egan (6), Shillman (5) | 3.51-4.00 m |

A wing steps in its PARENT's course, so Ryder's 12.36 m lower wing is 3 storeys at
Ryder's 4.33 m rather than the 3.25 a nominal course would give. Two parts under
4.2 m of wall — a 2.21 m link and a 4.58 m canopy — are left plain: fenestrating
them would put a storey of windows into 2 m of wall.

**Three typologies, because one rhythm would be a lie.** The pre-1960 collegiate
core is deliberately ONE composition — same window kind, same reveal, stone ground
storey under a masonry body, modest cornice — with bay width varying only from
each part's own seed, so the quadrangle halls relate without matching. 1960+
research buildings take wider bays and a shallower reveal. Cabot takes neither: a
field house is not five storeys of windows, so it gets one high clerestory band on
9 m piers over a mostly solid wall, which keeps it reading wide and low. A shared
part takes its earliest claimant's typology, so 661061 is collegiate on Ell's 1947
rather than research on Curry's 1964 — the same rule the material family uses.

**Collision is built from its own plain prisms.** A trimesh cut from the visible
buffer would now include every jamb, sill and lintel: per-window collision by
accident, for surfaces the player can never touch. The collision buffer is
extruded separately and disposed once Rapier has copied it, which made colliders
*simpler* than Wave 2C — 1,776 triangles against 2,984, one wall per edge instead
of two stacked bands.

**Krentzman is a mown quadrangle, and it cost one data change.** It was already a
`reserveOnly` park ring, so dropping that and setting `kind: 'formal'` hands the
ground plane to production code — `Districts` grass, `ParkPaths` circulation,
`Props` furniture, `Vegetation` planting. `formal` needed no new table entries
anywhere: it already means stone walks on a regular geometry, which is what a
collegiate quadrangle is. Result: a 4.0 m stone loop, two 2.6 m minors, seven
specimen trees, benches. It stays no-build because `isReserved` reaches it through
`inPark` either way.

Three things came free, and they are the reason not to have written a bespoke
ground system: park surfaces already carry `polygonOffset -3/-6` so nothing
z-fights the terrain; `Districts._mesh` subdivides to a 26 m max edge so the
surface follows the ground; and parks have no collider, so the player keeps
walking on the terrain heightfield and a collision discontinuity is impossible.
Measured max vertical snap inside the quad: **12 mm**.

**`understorey`, and the defect behind it.** `Vegetation`'s understorey loops draw
a FLAT 340 shrubs and 260 flowers per park while the trees, furniture and hedges
around them are all area-derived — and the comment above them claims they are area
-derived too. They are not. A 0.26 ha quadrangle came out at ~1,100 shrubs/ha
against the Common's ~9 and vanished into a thicket. Re-rating by area is the real
fix and would thin the Public Garden and the Common by ~3x, so the blast radius
was kept at zero instead: an optional `understorey` multiplier on the park record,
Krentzman at 0.06. It had to be threaded through `Districts.parkPolys` and
`Props.parks`, both of which map park records field by field and dropped it
silently. This is the **fourth** instance of the constant-per-polygon bug this
codebase has had.

| | Wave 2C | Wave 3A |
|---|---|---|
| hero triangles | 2,984 | **102,098 opaque + 10,906 glass** |
| hero draw calls | 1 | **2** (+2 shadow cascades in `stats()`) |
| new materials | 0 | **0** — shares `matOpaque` and `matGlass` |
| colliders | 18 / 2,984 tris | **18 / 1,776 tris** |
| bays / storeys | — | 5,453 / 67, 16 of 18 parts fenestrated |
| frame at the quad | 2.1 ms | **3.2 ms** (agreeing bursts 3.7/3.2) |

Night and rain were sanity-checked only, with no exposure or lighting change:
windows light individually at 20:30, and the lawn and stone walks wet correctly
because the park surface is a registry variant that reaches `Assets.setWetness`.

**Remaining visual gaps.** The lawn stops at the reservation octagon and the
campus ground beyond it is still bare, so there is a hard mown/dirt boundary
visible from the quad's west side and from the chase camera. Phase 7's PDDL
sidewalk connector (Huntington -> Krentzman) and Phase 8's entrance cues were NOT
done — the quadrangle has circulation from `ParkPaths`, but the link across the
bare ground to the Huntington pavement does not exist. No parapets. The octagon's
shape is now visible and therefore asserted, and it is the recorded area about the
recorded centre, not a surveyed boundary.

**One pre-existing defect found and NOT fixed** (out of scope, spawned as a
separate task): thin dark slivers stick out of tree canopies wherever foliage
meets sky. Ruled out as wires (hiding all 44 `prop:wires` groups changes nothing)
and as hero geometry (hiding `neu_hero` changes nothing), so it is in
`Vegetation`'s foliage cards.

## Northeastern hero district — Wave 2C, Krentzman / Huntington massing (2026-09-08, `641f8cc`)

The opening cluster is survey geometry now. Eighteen volumes across the Krentzman
quadrangle and the Huntington frontage, each a PDDL roof-break polygon from the
City of Boston extruded to its own recorded height. `src/data/neu-hero.js` is
GENERATED from `docs/neu/HERO_FOOTPRINTS.json` by `tools/neu-hero/build.mjs` —
regenerate it, do not hand-edit it.

**The unit of geometry is the SOURCE PART, not the named building.** Three parts
are shared between two buildings each: 661061 is the dominant mass of BOTH Ell and
Curry, 666437 is a tier of both Richards and Hayden, 676669 of both Dodge and
Hastings. Emitting per building extrudes those twice — coincident surfaces and
doubled colliders. 12 buildings x 22 tiers de-duplicates to 22 parts: 11 PRIMARY,
7 SECONDARY, 4 MICRO withheld under 100 m2.

| | measured |
|---|---|
| parts rendered | 18 of 22 |
| triangles | **2,984** (568 of them roof caps) |
| draw calls | **1** — plus 2 shadow-cascade draws, so +3 in `stats()` |
| colliders | 18 trimesh, 2,984 collision triangles |
| materials | **0 new** — shares `buildings.matOpaque` |
| frame cost | 2.1 ms at 1920x1080 `high`, 424 draws / 1.01M tris at the quad |

**Suppression is at plot generation, which is what makes it durable.** A wrong
building is never built rather than built and hidden, so no collider, façade or
frontage prop can survive behind it, and no chunk refresh or LOD change can undo
it. Two gates, and both are needed:

- `Districts.inHeroFootprint` — exact point-in-footprint, consulted by
  `Districts.isReserved`, which `RoadNetwork.buildPlots` uses as its block test.
  The footprints live in `Districts.heroPolys`, NOT in `parkPolys`: they must not
  raster as `park`, grow grass, or attract park paths and planting.
- `Buildings.heroOverlap` — the exact polygon test, run on `city.plots` BEFORE
  `_superblocks` merges anything. Necessary because `buildPlots` tests exactly ONE
  point, the parcel mid-point, and the `northeastern` lot template is 46 x 54 m: a
  parcel centred in the gap between two halls can still reach 27 m into one. Run
  after merging it would delete legitimate surrounding campus with the offender.

Measured by re-running `buildPlots` with the hero test stubbed out: **10
procedural parcels would have stood on the factual footprints, 6 of them inside
Cabot's 7,926 m2 arena outline** — up to 40 m tall, since the district template is
midrise. Note `buildPlots` is not bit-reproducible across calls (re-running it
moved the total by 5 of ~10,950), so treat the parcel counts as +/-5.

**The two reservation octagons were capped a second time**, for the reason
`boston-geo.js` already establishes: survey footprints outrank an area-derived
octagon. Krentzman's 32.3 m radius reached 1.3 m into Richards and Centennial's
40.9 m reached 5.0 m into Ryder's lower wing and 2.1 m into Shillman. Same
octagons, same recorded centres, scaled to 30.1 m and 35.0 m. Krentzman keeps
2,565 m2 open — still the quadrangle. The freed annuli are 1-5 m wide against a
`MIN_DEPTH` of 8, so no parcel can appear in them.

**Material family is chosen by DOCUMENTED CONSTRUCTION YEAR**, from the
university's own inventory: pre-1960 brick over granite, 1960-79 concrete, 1980+
brick over limestone, and a shared part takes the earlier year. It is a broad era
cue, not a claim about any wall — `yearBuilt` cannot tell an original fabric from
a re-clad one, and Mugar reads later than its 1941 date. Being consistently wrong
from a stated rule beats being unevenly right from memory. One line to change in
`NeuHero.ERA` when façade evidence arrives.

**What the composition does.** Krentzman reads as a genuine three-sided
quadrangle: Ell/Curry closes the south-east end, Mugar and Hayden flank it,
Richards and Dodge frame the Huntington mouth, and the whole ensemble is low and
horizontal at 16-19 m — which is what the corrected heights say, and NOT the
24-25 m wall the superseded Boston 3D figures implied. Cabot reads wide and low at
11.61 m. Hastings at 27.83 m is the tallest thing there and sits off the
ceremonial axis, so it does not dominate the quad. The granite base course is what
makes the masses read as buildings at eye level; it is massing, not ornament.

**Before/after was done in ONE session by toggling the hero mesh**, at identical
cameras and identical atmosphere, because that isolates the hero contribution
exactly and sidesteps the capture-drift trap. Hero off at the quad centre is the
empty dirt plain `docs/neu/README.md` describes; hero on is an enclosed
quadrangle. A true procedural before — the 40 m midrise blocks that would have
stood there — was NOT rendered: the only routes to it were a destructive tree
operation or test-only code in a production path, so it is quantified above
instead.

**Gaps, and none of them are hidden.** There is **no fenestration** — the masses
are blank brick, which is very apparent standing next to Hastings on Huntington,
and it is the single biggest remaining gap. There are **no parapets**, so walls end
abruptly at the roof line. The Krentzman ground plane is **bare terrain** — no
paving, no lawn, no paths — so the quad is an enclosed dirt yard. Phase 5's
minimum public realm was **deliberately deferred**: a factual path laid on bare
ground with no kerb or surface treatment would have to be distorted to look like
anything, and the brief's own rule is to defer rather than distort. The campus
interior beyond the cluster is still empty ground.

## Player hero mesh — rung 3, clothing volume (2026-09-08, `835fd48` + cuff fix)

Clothing was purely a per-vertex colour zone: `aZoneShade` selects `aTop`/`aBot`/
`aSkin` in the shader and no geometry knew a garment existed, so every clothing
boundary was a sharp colour change on a smooth surface.

**Solved with steps in the existing loft, not a shell.** The trouser rings end at
y=0.925, a near-horizontal annulus steps the radius out 22 mm, and the jacket
continues on the same surface — no coincident faces, nothing to z-fight. Trouser
cuff and sleeve cuff use the same trick. A shell was rejected on the rung-1
evidence: overlapping surfaces meet in a hard shading seam, which is why the head
still has no jaw.

**22 mm is a chase-distance number.** ~~150 px/m~~ — **superseded, do not reuse.**
The real chase camera (`CameraRig._dist` 3.35 m, `_fov` 62, pitch −0.16) measures
**252.3 px/m** at 1920x1080, so a 10 mm feature is 2.5 px and 22 mm is 5.6 px.
The features were sized against the low estimate and still pass, but any future
sizing decision must use 252 px/m.

| | before | after |
|---|---|---|
| triangles (one instance) | 1310 | **1474** |
| front silhouette | 0.290 m² | **0.311 m²** |
| side silhouette | 0.129 m² | **0.140 m²** |
| height / max width / max depth | 1.721 / 0.492 / 0.294 | **unchanged** |
| crowd LOD0 / LOD1 | 676 / 287 | **unchanged** |

**Verified on the CPU, with no browser.** The rig is deterministic, so
`scratchpad` tooling replicated the vertex shader — `p = position + girth *
(build-1)`, then a single rigid bone matrix decoded from the animation texture —
and posed every vertex through all six clips. Limb clearances moved by at most
3 mm and leg-to-leg was identical to three decimals; hem-to-hand holds 38 mm at
its closest (jog), hem-to-sleeve 29 mm, and the trouser cuff keeps an 18-20 mm gap
from the shoe while breaking 21 mm over it at rest. **This technique is worth
reusing** for any future rig-compatible change: it answers animation questions
without a WebGL context.

**CLOSED: the chase-distance visual gate passed, after one cuff correction
(2026-09-08).** Both revisions were loaded in one page session — the committed
`Character.js` and the rung-1 revision from `70dadfe` as a second module — so
before and after share one boot, one lighting state and one camera. Four
orientations were captured at the real chase camera: back (the gameplay view),
front, 3/4 and side.

**The jacket hem passed as committed.** The hip band 0.80–1.10 m changes 3.1–3.8%
of its pixels between revisions against a 0.5–1.4% capture-noise floor — 2.8x to
6.3x — in every orientation. At native chase pixels it reads as a hem lip and a
jacket/trouser break, not as an applied ring.

**The trouser cuff failed as committed, and the cause was arithmetic.** The band
ran `oy + 0.012` -> `oy + 0.075`: 12 mm above the *foot bone origin*, not above the
shoe. The shoe box is centred at 0.042 with a half-height of 0.042, so its top is
`oy + 0.084` — the whole cuff sat **inside the shoe**, spanning 0.071–0.133 m
against a shoe top of 0.142 m. Measured side-on it moved the silhouette by 0 px
and left the shin luminance gradient flat (±1) straight through the band. The
comment claiming it landed "12 mm proud of the shoe" was wrong, and so was the CPU
tooling's "breaking 21 mm over it": a surface-to-surface distance does not say
which surface is in front of which.

**One narrow adjustment, then a re-test.** The lip was lifted to `oy + 0.150` ->
`oy + 0.126`, 42 mm clear of the shoe top, and the last tube carries the hem down
to `oy + 0.012` inside the shoe so no notch opens at the ankle. Tube count — and
so triangle count — is unchanged at **1474**. After the lift the cuff zone
0.05–0.28 m changes 1.1–3.7% of its pixels against a **0.00%** noise floor in all
four orientations, and the lip shows a +13.9/−14.5 luminance ridge where the flat
reference band holds ±2.9. Nothing else was touched: no shell, no new material,
no accessory, no face, hair, finger or animation work.

Controls that make those numbers mean something: the untouched thigh and torso
zones measure signal ≈ noise (1.0x–1.9x) in the same frame pairs, and crowd
LOD0/LOD1 stay 676/287 with the attribute set and zone set identical to rung 1.
Clearance was re-run on the CPU after the lift — leg-to-leg identical across all
six clips, arm-to-torso within 3 mm. Integrated check with the real player: idle,
walk, jog, run, crouch, crouch-walk, and `sit` through an actual vehicle entry and
exit — `bootReport.failed` `[]`, `errors` `[]`, `glFaults` `[]`, `validate().ok`
true.

**Three measurement traps, each of which cost time here.**
`FX[LensFinal+FilmGrain]` is the only pass carrying `renderToScreen`. Disabling it
to remove grain silently blanks the default framebuffer, and `readPixels` then
returns identical black frames — which reads as a *perfect* determinism result and
as "the character does not render". Zero the `grainParams` uniform instead of
disabling the pass. Second: separate captures are **not** frame-deterministic even
with grain off and auto-exposure held, because clouds, water and AO drift — about
12% of the figure's own pixels differ between two identical renders, so an
absolute before/after difference proves nothing on its own; compare a changed zone
against an unchanged control zone instead. Third: `requestAnimationFrame` is
throttled to roughly 1 Hz while the preview pane is hidden, so a settle loop has
to drive `__boston.step()` synchronously or it will time out.

`__boston.groundedY` gives the walkable surface height directly. The plaza at
(168, 120) sits 0.61 m above `terrain.groundHeight`, so a figure placed at the
terrain height is buried to mid-thigh and its legs simply are not in frame.

## Player hero mesh — rung 1 (2026-09-07, `2197fef`)

The player was one instance of the pedestrian mesh. It now has its own geometry,
`buildHeroGeometry`, dispatched by `CrowdMesh` on the exported `HERO` lod id.

**Player and crowd share everything except surface.** Same 16 bones, rest pose,
animation texture, clips and `ped_body` material. That is the contract to keep.

| | crowd LOD 0 (before) | hero (after) |
|---|---|---|
| triangles | 676 | **1310** (one instance: +634 against a 2.1M frame) |
| side silhouette area | 0.163 m² | **0.222 m²** (+36%) |
| front silhouette area | 0.358 m² | **0.467 m²** (+30%) |
| side ÷ front | 0.455 | 0.475 |
| standing height | 1.712 | 1.722 |
| head width | 0.198 | **0.172** |

What was actually wrong, measured on the rest pose: the torso was a single centred
ellipse column, so **in profile the player was a plank** — no chest, no seat, no
front-to-back movement anywhere. The fix is a per-ring **z offset** on the torso
loft; radius alone cannot make a profile. Plus a real neck (there was a 0.10 m
tube reading as a gap), two-segment arms and thighs so bicep and calf can exceed
the joints below them, a mitten hand with a thumb pad, and a shoe with a tapered
toe and heel block.

**Crowd cost is unchanged and checked, not assumed:** peds_near 676 tris,
peds_far 287, and all three meshes share one material — no new draw call, no new
program. Chase frame 4.3 ms, two bursts agreeing inside 0.4 ms.

**No jaw, on purpose.** Three sizes were tried; every one read as a cracked egg or
a muzzle. Two overlapping ellipsoids meet in a hard shading seam and cannot blend,
and a chin needs the head as one surface — that is the face rung, last.

QA: all six clips render clean, crouch folds with no knee pinch or
interpenetration, and enter → sit → exit works with the seated pose correct at the
wheel.

## Wall props need a wall, not a zoning cap (2026-09-07, `cb9cba6`)

Everything mounted on a facade sized itself from `frontage.maxHeight`, the
district ZONING CAP. In the Financial District that is 240 m, so a 26 m building
could be handed a water stain 107 m up with nothing behind it.

Measured over the streamed set at spawn: **16 of 26 `waterWall` instances stood
above their own roof, worst by 142.9 m**, and `satDish` had the identical bug
(1 of 2, by 83.4 m) which nobody had looked for. `grimeWall` escaped only because
its floors term clamps at 7 storeys — a bound on the symptom, not a fix.

`makeWallHeight` (Props.js) resolves the building actually behind a frontage from
`buildings.specs`. **Probed, not joined by key** — `_superblocks` merges plots into
one building and `_clipParcel` insets the footprint, so a frontage and its
building share neither an id nor an edge. Four inset depths × three points along
the run resolve 95.1%; the rest have no building and callers skip them. Lazy and
memoised, because `Props.deps` lacks `buildings` and whichever consumer calls
`getLayout` first builds the layout.

After: zero wall props above their own roof across Northeastern, the Financial
District, the North End and Back Bay. Two survivors the audit flagged were the
audit's own error — at a party wall between a 57 m and a 93 m tower it credited
the shorter neighbour.

## Northeastern building heights — the gate, and the correction (2026-09-08)

`docs/CURRENT_STATE.md` had no record of this at all until now, which is itself
worth fixing: the height question is what gates all Hero building massing.

**Use `docs/neu/HERO_FOOTPRINTS.json`.** Boston Buildings with Roof Breaks, City
of Boston, **PDDL**, a 2010 snapshot. It carries footprint polygons split by roof
break, each part with `GRND_ELEV_2010` / `ROOF_ELEV_2010` / `BLDG_HGT_2010` — so
footprints and tiered heights come from one public-domain source.

**Do NOT use `docs/neu/HEIGHT_MEASUREMENTS.json` as individual building heights.**
It is Boston's 3D scene layer, and it reads systematically high — 233.6 m for the
Prudential against a known 228, and +3.2 to +8.8 m across the Northeastern opening
cluster. Its `Height_Ft` takes the top of the whole modelled mass, which is
defensible on a merged object and wrong for a named building. The file now carries
a `_SUPERSEDED` block saying so, emitted by its own generator so a rebuild cannot
quietly drop it.

**The Krentzman quadrangle measures ~18.5 m, not ~24.8 m.** An earlier mission
certified the higher figure and opened the massing gate on it; the next mission
caught it before anything was built, by checking against landmarks of known
height. Richards 18.65, Hayden 18.54, Dodge 18.47, Mugar 18.92, Dana 18.74, Ryder
17.30, Egan 21.39, Shillman 19.60, Ell/Curry 16.00 — storey ratios 3.69–4.33,
which is what a 1938 institutional building measures.

The lesson worth keeping: storey-ratio sanity checks and a modern-tower control
both passed on the bad data. **What found it was a landmark whose height is
independently known.** Validate a height source against something you can look up.

Boston 3D remains useful where the 2010 snapshot has nothing — ISEC (2017), EXP
(2024), East Village — and as an upper bound.

## Northeastern Wave 0 — road geography + campus district (2026-09-07, `659691a`)

The first hero-district wave that changes the world. Geography only: no building
massing, no transit, no public realm, no spawn move, terrain untouched.

**Source and licence.** Roads from MassGIS-MassDOT Roads; the campus ring from
MassGIS Massachusetts Property Tax Parcels. Both public domain — *"a public
resource and may be used by anyone for their purposes"*. OpenStreetMap is more
detailed here but is ODbL, and share-alike would attach to `boston-geo.js`, so it
was used only to cross-check. Every "after" figure below is measured against OSM,
i.e. against a source that had no part in producing the geometry.

| | before | after |
|---|---|---|
| Huntington centreline error (vs OSM) | median 107.6 m, max 157.3 | median **6.0 m**, max 11.1 |
| Huntington through the hero core (vs MassGIS) | — | median **0.8 m**, max 5.7 |
| Columbus centreline error | median 89.5 m | median **2.4 m** |
| campus within 40 m of a road | 10.9 % | **35.7 %** |
| campus within 300 m of a road | 77.2 % | **100 %** |
| named streets in the envelope | 7 | **10** |
| `districtAt` null on the audit probes | 6/8 | **1/8** |
| buildings under campus rules | 0 | **67/71** |
| brownstones inside the campus | most | **1** |
| Huntington junctions | 4 | **9** (all four originals preserved) |

**Seam policy, which is the part worth reusing.** The hero core gets pure survey
geometry; the seam is spent outside it. Huntington's first segment is held
exactly where it was because it carries the Dartmouth, Blagden and Ring Road
crossings at Copley; the correction eases in over the next 280 m and completes
230 m before the envelope. Columbus gets the same at Berkeley and Clarendon. The
Massachusetts Avenue crossing moved to within 7 m of the real Symphony junction,
which is a repair rather than a side effect.

**Two things that cost time and are worth knowing.** `Districts.IDS` must list a
new district id — `bake` stores `IDS.indexOf(id) + 1`, so an unregistered id
rasterises to 0 and reads back as `null`, which is indistinguishable from the bug
it was added to fix. And smoothing a short street can quietly cost a junction:
Gainsborough's smoothed line sat 22 m from Huntington against an `END_SNAP` of
21, so it is committed as stitched raw geometry instead.

**QA.** 545 downward ray samples along the five streets: 0 misses. 12 pedestrian
drop tests along the corridor and across the campus: all grounded, none fell. 7
vehicle seam tests: none sank, none launched. Traffic populates the corrected
corridor — 59 cars within 300 m of the campus frontage. All five streets sit in
the main 385-node component. `st_beaconhill` 5.2 ms, unchanged.

**Known defect made visible, NOT fixed here.** Seven `waterWall` decals hang
31–46 m in the air over the campus with no wall behind them. `Props.js:921`
builds decal frontages from PARCELS carrying the zoning height cap, and
`Decals.js:997` hangs the stain from that cap; 666 of 10,897 parcels have no
building at all. Latent everywhere — the cap is not the binding height constraint
in any district — and Wave 0's new frontage is what surfaced it. The fix belongs
to Props.

## Northeastern hero district — factual audit done, no geometry built (2026-09-07)

`docs/neu/` is the evidence package for the owner's Northeastern hero district;
`tools/neu-audit/` regenerates it. **No `src/` file changed** — this was a
source-of-truth mission, and gate item 1 of the six-point hero-district gate in
`AI_HANDOFF.md` §0b is now satisfied.

What it establishes, all machine-measured:

- **The projection was never the problem.** `src/core/Geo.js` is exact by
  construction and world content stores real lat/lon. The hand-traced *content*
  sits a **24.7 m median** from OSM footprint centroids across 11 city-wide
  anchors (p90 51.4 m definition-clean), with only a 15.4 m mean offset — so no
  rotation, scale or datum fault. External GIS geometry imports safely but lands
  25–50 m off the existing streets, which is why the district must **replace**
  the geography in its envelope rather than graft onto it.
- **Huntington Avenue is a 9-vertex polyline a median 107.6 m from its real
  centreline**, peaking at 152 m *at the campus*, and it does not enter the campus
  bounding box at all.
- **The campus is empty because the roads are.** Parcels come from road frontage,
  so with only 10.9% of campus within 40 m of a game road (median 182 m), the
  engine builds 118 generic buildings where 107 real ones stand.
- **`districtAt` is null over most of campus**, so `buildPlots` falls back to
  `Z.southEnd` and a university generates as South End brownstones. Cheapest fix
  in the district, highest leverage.
- **No authoritative building height exists anywhere.** The university's own layer
  publishes `Height_Relative` and `Levels_Above_Ground` as `0` for all 104 Boston
  rows; OSM tags 34 of 1,737. Storeys implied from gross area are an upper bound,
  marked confidence D and never promoted.

**Terrain here is CLOSED and this audit is the reason.** USGS 3DEP puts campus
relief at ~2.6 m against the game's 1.7 m — the campus genuinely is flat. Do not
open terrain work because the area looks featureless; it looks featureless because
nothing is built on it.

## Building collision — corrected 2026-09-05 (`4f85110`, `37f48bc`)

**Buildings were never non-solid, and are now solid in the right place.** The claim
that this build has no building colliders came from a stale comment in
`CaptureHarness.unstick` plus a collider inventory taken at `time.frame === 0`,
before any chunk had streamed to LOD 0. Step the engine before counting colliders.

The real defect was that `Buildings._addColliders` put the box in the wrong place:
it measured half-extents in the `+ang` frame and then rotated the collider by
`-ang`, mirroring it about the longest edge, and it took symmetric `max(|u|)`
extents about the centroid, inflating any off-centre footprint. Median 7.96 m of
real facade lay outside its own collider; 23.2% of open street in the Financial
District was blocked by invisible wall up to 9.66 m from any facade.

Both are fixed, and the representation is unchanged (one oriented box per building,
same collider count). Invisible walls 23.2% -> 0%; 1,200 of 1,200 interior points
now blocked; 40 walk trials, 0 entries, stop distance median 0.32 m = capsule radius
+ KCC offset. Drivable car at 13.3 m/s head-on and oblique never enters. Camera
inside a building 7 of 36 orbit angles -> 0 of 144, by flooring the third-person arm
at `camera.near + 0.02` instead of a fixed 0.42 m.

**Still not solid: landmarks.** No colliders at all, and `isReserved` keeps
procedural buildings off their footprints, so you can walk through 200 Clarendon,
the Prudential, the Custom House and the State House. Do not extrude `keepout` to
fix it — see CONTRACTS.md, "Building collision".

## Landmark collision — added 2026-09-05 (`57cdebe`)

**Landmarks are solid now.** They previously had no colliders of any kind, and
because `isReserved` keeps the procedural generator off their footprints there was
no building collider underneath either — you could walk through 200 Clarendon,
the Prudential, the Custom House, the State House, Faneuil Hall and Trinity
Church. That was the largest free-roam hole in the city.

Each landmark now carries one static trimesh collider cut from its own slice of
the merged opaque mesh, on a single shared fixed body. `keepout` is NOT used and
must never be — it is a generator exclusion radius of up to 150 m. See
CONTRACTS.md, "Landmark collision".

Measured: 60 player trials over all 20 landmarks, 56 of 58 valid stopped by the
landmark collider at a median 0.32 m from the nearest visible triangle (capsule
radius + KCC offset), 0 stopping more than 1 m out, 0 unable to retreat. Drivable
sedan at 14.1–14.4 m/s never enters and reverses out. Camera orbit intrusion fell
from 68 of 180 angles to 8 of 216. Cost is 20 colliders / 22,078 triangles / ~1 MB
and a physics step cost indistinguishable from noise.

**Pages production verification — DONE 2026-09-05 (`a1fc320` build).** The gate
the previous batch could not finish now passes: 26 systems, `bootReport.failed`
`[]`, errors `[]`, glFaults `[]`, `__boston.render.validate().ok === true`, Rapier
live, 16,060 colliders, landmark body present with **20 colliders / 22,078
collision tris**, and every resource 200 or 304 with zero 404s. Player controls in
production: 11 of 12 trials blocked by the landmark collider at 0.32 m, all six
named landmarks solid, 0 unable to retreat; Zakim under-deck traversable (3 walks,
full 11 m, 0 stalled frames); sedan at 13.3 m/s contacts and stops 2.40 m out,
tilt 5.2 degrees, reverses 8.17 m.

**Note on the previous batch's "wedge".** It was not a code failure and not swap.
Production boot on this machine takes about **four minutes**, and it was being
interrupted by repeated navigations — the network log showed three overlapping
`/Boston/` document loads each cancelling the previous one's module fetches. Load
once and wait.

**Scene-wide speckle — OWNED AND HALVED, 2026-09-05 (`2af3b1c`-era).** The
speckle on vehicles, road and flat surfaces is film grain, not vehicle material and
not sharpening (sharpen is 0 because TAA is off). With scene and camera frozen,
grain is 99% of all temporal crawl on flat surfaces (road per-pixel temporal RMS
0.006 off vs 0.99 on) and 48-80% of spatial high-frequency depending on light, worst
at night where `isoBoost` raises the amplitude 2.4x. `options.grain` 0.015 -> 0.0075.
Pages-verified: road hp 1.189 -> 0.798, wall 1.123 -> 0.758, sky 0.376 -> 0.254,
with high-detail regions unchanged (46.413 -> 46.321) and passes/programs identical.
See CONTRACTS.md, "Scene-wide speckle is film grain".

**Corner stickiness — NOT REPRODUCIBLE on this build, 2026-09-05.** Wedged in a
real re-entrant corner (150 press frames, three probe bearings returning two
overlapping building colliders, velocity 0.02), rotating input to a free direction
recovers to the full 3.40 m/s jog in **3 frames**, identical to a flat-facade
control and travelling slightly further. Not marked fixed — the change from what
earlier batches saw is probably `a70e884` but that is unproven. See CONTRACTS.md.

**Parked/moving paint consistency and far LOD — CLOSED 2026-09-05, no source
change needed.** Measured by substituting the two parameter tuples on one body
with geometry, camera, light, exposure and source colour all held: the
parked-moving gap was mean RGB 9.44 before the metalness fix and is 3.33 now,
about 1.6x the A/A noise floor of 2.1. `SURF.carPaint` metalness was deliberately
left at 0.05 — it has the better tonal range of the two, so matching it to the
moving 0.30 would trade quality for symmetry. Far/shell LOD is Traffic-owned
(`vf.pools` is always empty; a spawned car never reaches it) and uses the same
`carPaint` family at 0.30 with `instanceColor` preserving per-car tint, so colour
identity survives LOD. Batching intact: one `prop_surf` across 220 instanced prop
meshes, 2 carPaint instances behind all shells, 459 draws / 2.07M tris. See
CONTRACTS.md, "Parked and moving paint".

**Vehicle paint, 2026-09-05 — two owners fixed, one ruled out, one open.**

*Hidden-pane pixels are trustworthy now* — `Engine.resize()` floors a collapsed
container to 1280x720. The old "any visual claim while hidden is fiction" warning
is superseded; see CONTRACTS.md for the A/A + ablation proof protocol and the
auto-exposure trap (hold one car and one camera; respawning per colour gave a
wrong answer here).

*Fixed:* the linear-space colour snap (`f896627`, rendered inter-car distance for
navy vs dark green 0.2 -> 13.7), and `carPaint` metalness 0.78 -> 0.30
(`8cab8f6`, white-vs-black tonal range 22.0 -> 44.1, verified across five weather
conditions with 0% white clipping).

*Ruled out:* speckle is not the vehicle material — all micro terms off together
move body high-frequency energy by -1.9%, and flat road measures more of it than
the car body. Palette is not the pale owner either (55.7% neutral but median
luminance 0.125, 27.3% dark).

*Open and newly found:* parked cars use a different material path entirely —
`prop_surf` with `SURF.carPaint = [0.34, 0.05, 1.0, 1.25]`, i.e. metalness **0.05**
— so parked and moving cars have never matched despite a comment saying they
should. 0.30 narrows the gap; closing it needs its own verification and must not
be done by editing the shared `prop_surf` scalar.

**Parked-car bypass 3/4 classified, 2026-09-05.** Not a regression. Re-run at 14
production trials: the 12 with valid starts reach the pavement 12/12. The two
misses both start with the player teleported INSIDE a parked car's collider (12 of
12 probe bearings return `parkedCar`), and a kinematic controller cannot resolve an
initial penetration. Harness artifact, same cause as the original 3/4. A genuine
latent bug was found while classifying it and fixed separately (`a70e884`): `_move`
selected its request vector on `_byCar !== -1`, so after a bypass timeout it kept
reading a stale `_bypass` nobody had recomputed.

**Gameplay smoke controls re-run in the Pages build, 2026-09-05.** These were
reported NOT RUN when the camera solver shipped; they now pass.

* Kerb traversal, clear-path crossings: **0 s below 80% of approach speed, minimum
  speed 3.40 m/s** — the full jog, i.e. no measurable dip — pavement reached 2/2.
* Parked-car bypass, parked car in the path: pavement reached **3 of 4**, minimum
  speed 3.03–3.38 m/s, no dip.
* Stationary-player Traffic clamp: 7 proxies nearby, player held still 300 frames,
  **0 proxy-overlap frames**, closest proxy 3.42 m, player displaced 0.00 m.
* Vehicle cabin occluders: ray cast across the body at nine heights. Sedan and bus
  both give **4–8 surface crossings through the window band** against 2 through the
  solid lower body, so the interior shell is there.

Two measurement notes worth keeping. Sampling the kerb dip over a fixed 110-frame
window measures the END of the walk, not the step — he mounts the kerb and then
walks into whatever is beyond and stops, which reads as `minSpeed 0`. Window the
dip on the frame where he actually gains height. And ray-crossing counts cannot
tell an opaque panel from a glass pane: the van reads 2 crossings above its window
line, which is consistent with a solid panel body but is not evidence either way.

**Camera vs landmarks: CLOSED 2026-09-05 (`bce6c00`).** The residual 10 of 216
orbit angles are gone. The cause was not the vertical fan -- it was that `_sweep`
was passed the full `shoulder` while `_apply` placed the camera at
`shoulder * shrink`, so the sweep cleared a column the camera never occupied.
`_apply` now re-probes at the shoulder the camera actually lands on, monotonic and
capped at 2 passes. Pages build: 0 behind of 216 landmark angles, bus 0 of 36, open
street arm 3.35 with 0 at floor. Cost: at a building the arm sits at the 0.27 m
floor at 27 of 36 angles instead of 21. See CONTRACTS.md, "Landmark collision".

## What exists and works
- **Engine**: dependency-sorted system registry, fixed 60 Hz physics, clamped variable
  render step, `import.meta.glob` auto-loading of subsystems.
- **City**: 504 edges / 375 nodes, **96 km of street**, 11,219 parcels, 1,513 spawn points,
  real Boston geography via `geo(lat,lon)`. HUD reads real street names.
- **Buildings**: 6,942, placed on real parcels, **and they now actually rasterise** —
  facade banding, window grids and rooflines read at every LOD (see §Resolved). Roofs get
  a per-building surface, tone and re-covered field from `Facades.pickRoof`.
- **Landmarks**: 20, at true coordinates — 200 Clarendon, Prudential, State House dome,
  Custom House, Fenway/Green Monster, Citgo sign, Zakim Bridge, Old State House.
  23,882 tris in **4 draws** — the batching standard to aim for elsewhere.
- **Props / vegetation**: **~154,000 prop + decal instances (99 types), ~55,400 plants (19
  types)**, spread evenly over all 76.5 km of street rather than piled up around Boston
  Common (see §Resolved, "every prop that would carry a street"). Includes **~14,100 parked
  cars** in the city's own kerbside bays, built from `VehicleModels`' body loft — static
  instanced shells, not simulated vehicles. Measured within 80 m of the five level street
  cameras: 25–63 parked cars, 20 decal families live, shop signage / fascias / fire escapes
  / A/C units / standpipes all non-zero, hundreds of ground plants. Every one of those was
  **0** before. Parked-car triangles in frustum are 120–162k after per-instance near-tier
  LOD (`PropBatch.splitNear`).
- **Lighting**: 3 cascades @ 2048/2048/1536, ~2,300 street lamps, ~3,000 emissive sources.
  Hemisphere colours are normalised to unit luminance so `skyIntensity` is a real
  irradiance at every hour (see §Resolved). Both additive proxy meshes carry real instance
  bounds and frustum-cull; the halo minimum size is derived from the live viewport, so it
  is a fixed 1.1 px at any resolution or FOV rather than a constant tuned for one canvas.
  **Cast shadows are now 2.5 stops deep in the umbra** and the artificial lights obey the
  world clock (see §Resolved). There is a **shadow-casting key light at every hour of the
  day** — sun, then a twilight key on the sunset azimuth, then the moon, blended
  additively so no hour is lit by ambient alone.
- **Atmosphere**: the `atmosphere` pass is on and stays on (`render.validate()` → `ok:
  true`). Raymarched volumetric clouds now render at every hour — ~33% sky cover at
  `clear`, radiance 0.12 pre-dawn / 4.5 at noon / 25.6 at golden hour / 0.035 at
  midnight, none of them zero. Aerial perspective mixes ~10% sky into geometry at 300 m
  and ~29% at 1 km. Night carries a city light-pollution glow instead of pure black.
  Six weather states with 20 s transitions, real precipitation instancing, wetness
  published to `ctx.assets.setWetness()`, and lightning driving a real `DirectionalLight`
  plus `bus.emit('thunder', {distance})` at the correct speed-of-sound delay.
  Re-swept against **live** auto-exposure (it had been pinned when this was first
  tuned) — the night glow calibration holds and is now better than it was: **0% of pixels
  clipped at every hour**, where night previously clipped 2.5–3.1% to pure white. At
  `tod 23` the sky sits correctly between unlit and lit surfaces — sky p50 **56**, city
  p10 4.5 (unlit facades), city p99 **143** (lit windows) — rather than being a flat wash.
  Exposure settles inside one `capture()`: the same shot repeated reads 215.7 → 213.4 →
  213.4, so shot order does not contaminate a sweep.
- **Physics** (Rapier), **vehicles**, **audio**, **HUD/minimap/menu**, **profiler**.
- **Traffic** (`src/ai/Traffic.js`, `Navigation.js`): ~120 kinematic AI cars on the real
  lane graph. IDM car-following, two-phase signals on **108** junctions, priority + a
  single-slot junction reservation everywhere else, don't-block-the-box, discretionary
  lane changes, indicators, brake lights, headlights on the world clock. The player's car
  is injected into the lane lists as an obstacle, so traffic queues behind him.
  `traffic.takeOver(car, ctx)` swaps a kinematic car for a real physics `Vehicle` so the
  player can drive anything on the road.
- **Pedestrians** (`src/ai/Pedestrians.js`): ~100–150 people on `city.sidewalks`. They
  cross only at crossing links and only when the signal governing that junction is red for
  the traffic being crossed — reading the **same** `Navigation` instance the cars obey, so
  a queue of people and a queue of cars never both think they have right of way. Keep
  right, steer around each other and the player, stop and stand about, flee at
  `wanted >= 3`. Density scales with the *pavement in range* and with the district (thick
  at the Common, Faneuil Hall, Newbury St; thin in the Seaport). **Two draw calls** for the
  whole crowd.
- **Characters** (`src/gameplay/Character.js`): one procedural 16-bone humanoid shared by
  the crowd and the player. Idle / walk / jog / run / sit / crouch clips are solved offline
  and baked into a 48×150 half-float **GPU animation texture**; the vertex shader looks up
  its own clip and phase, so a whole crowd animates for no CPU at all. Rigid one-bone
  skinning with overlapping joint spheres (no candy-wrapper pinch, half the texture fetches
  of weighted skinning). Per-instance height, build, gait, palette, sleeve length and
  baked-in AO.
- **Player** (`src/gameplay/Player.js`): Rapier `KinematicCharacterController` capsule —
  walk / jog / sprint / crouch / jump with 45 cm autostep, snap-to-ground and a 52° climb
  limit. `F` enters and exits vehicles and emits `player:enterVehicle` /
  `player:exitVehicle`.
- **Camera** (`src/gameplay/CameraRig.js`): GTA-style chase rig. Instant rotation with a
  spring-damped pivot, a five-ray collision sweep that pulls in instantly and eases back
  out, speed-dependent distance and field of view, distinct on-foot and in-vehicle
  behaviour, auto-recentre behind the car when the mouse is idle, `V` toggles free-fly.
  Honours `enabled` for the capture harness and re-derives its orbit angles from wherever
  the harness left the camera.
- **Capture harness** (`window.__boston`): 8 named shots, deterministic stepping,
  `measureFps()` that refuses to lie about a backgrounded tab.

## Lifecycle audit (post-`5f0966d`) — CLOSED, do not reopen from the report
Seven static/Node-verified waves, no visual change in any of them. Every finding was
re-derived from source before editing; the audit report was wrong in detail more often
than it was right, so **the dispositions below supersede it.** Reopening any of these
requires new evidence measured against the current baseline.

| SHA | Wave | Pre-fix → post-fix | Disposition |
|---|---|---|---|
| `cecc01c` | D1 audio graph | 200 churn cycles left **2,222** shared-source edges → **0** | confirmed, fixed |
| `e5a83a5` | D4 props lights | **20 → 260** registrations over 12 rebuilds → 20 stable, 0 after teardown | real; audit overstated the resource (a selection candidate, not a pool quad or halo; `F_DYNAMIC`, so `STATIC_FLOOR` was never touched) |
| `d0bd886` | D5 instrumentation | failure injection **13/30 → 0/30** | real, narrower/different (camera-lock strand unreported; `pauseActors` corruption did not reproduce) |
| `09ea530` | D2 engine teardown | dependency-first order reversed; repeat-dispose, renderer double-dispose and kit paint ownership fixed | confirmed, mechanism and scope corrected |
| `5141c08` | dependency hardening | `Props → lighting` declared; init and teardown order **byte-identical** | follow-up, fixed |
| `af5a3b4` | D3 physics debug draw | 300 enabled frames → **300** attribute pairs → **1** | confirmed, fixed |
| `8e3a825` | D6 diagnostics | 10,000 appends → **10,000** entries → **64** | D6b real, lower severity (strings only); **D6a intentional, unchanged** |

Three things worth not rediscovering: **three is 0.171.0** and does not reclaim a
`BufferAttribute` displaced by `setAttribute` — only `onGeometryDispose` frees what is
still attached. **`Engine.dispose()` has no caller** and was repaired for contract, not
reachability. And the `console` interception is deliberate page-lifetime
instrumentation — **do not add restore-on-teardown**, since it could clobber a wrapper
another subsystem installed later. Full detail and the residual Traffic-ordering caveat
live in `AI_HANDOFF.md` §9.

## Physics ground truth — resolved, 2026-09-01 (`af773bd` … `c7954f6`)
A four-commit chain that started from one stray raycast during the daylight
attribution. All of it is measured; none of it changes rendering appearance.

**1. The terrain heightfield collider was transposed** (`af773bd`). It was written with
the sample for (x from `i`, z from `j`) at `heights[j*(N+1)+i]`; Rapier indexes rows along
Z and columns along X, so the world was mirrored about the x=z diagonal. Grid and span are
both square, so nothing about its size or placement looked wrong, and points near x=z read
correctly. Against Rapier's own raycast, mean error vs `groundHeight(x,z)` went **3.508 m →
0.042 m**. It was gameplay-reachable: invisible ground sat ABOVE the drivable road at
**38.2%** of road points (worst 29.4 m over a road at 4.6 m); now 0%.

**This also settles the resolution question** — 300×300 over 6.8 km (22.67 m cells) tracks
`groundHeight()` to a mean **0.039 m**, so heightfield resolution was never the problem.

**2. The road collider had holes at every junction** (`801554f`). `City._colliders` builds
it from `farMesh`, and the far LOD is emitted per-edge by `_stripChunked` over `e._span`,
which is trimmed back to clear junction corners — while `_emitNode`, `_crosswalk` and the
stop bars all wrote through `_batch()`, which returns the NEAR batch only. Miss rate for a
collider at the carriageway was **99.4% within 4 m of a node** and 0.1% beyond 32 m, with
89.5% of misses inside 12 m of a junction. `_emitNode` now emits into both batches:

| | before | after |
|---|---|---|
| carriageway with a collider at the surface | 84.1% | **95.4%** |
| pavement with a collider at the surface | 90.9% | **95.7%** |
| far-mesh triangles | 34,906 | 44,917 (**1.29×**) |

Building the colliders from `nearMesh` instead would have cost **375,881 triangles
(10.8×)** — this recovered most of the coverage for 1.29×, and no render regression: a
fresh-boot `st_southend` capture reports 440 draws (unchanged) and +649 triangles in frame,
since far chunks only draw past 290 m. The residual ~4.5% sits within 16 m of junctions and
is most likely the far LOD's 3× coarser longitudinal step cutting corners on bends.

**3. Player stood on the terrain raster, not the drawn surface** (`c7954f6`).
`City.surfaceHeight()` already existed and its docstring already said to use it rather than
`groundHeight`, which "is 0.4-0.6 m too low anywhere near a street"; Lighting and
LightManager followed it, Player did not. Placement error over 300 spawn points: **0.554 m
→ 0.000 m**. At the default spawn he sat **0.572 m under the pavement** and stayed there;
he now stands 0.118 m above it and holds across 45 stepped frames.

**Two traps worth not repeating.** Physics queries return nothing until `world.step()` has
run, which in a hidden pane means driving frames manually — that is why an early ray
"missed". And verifying a heights buffer by re-reading it with the same index formula that
wrote it is circular: it reported a perfect RMS 0.0000 match while the collider was in fact
transposed. Only Rapier's own raycast settles that convention.

## Resolved root causes — do not re-debug these
| Symptom | Root cause | Fixed in |
|---|---|---|
| Whole frame renders black | `postprocessing`'s `SSAOEffect` reports full occlusion at city scale and `MULTIPLY`-blends the frame to nothing | Replaced with N8AO |
| Whole frame renders black (2nd time) | `CopyPass` ignores its `outputBuffer` argument and writes to its own target | RenderPipeline |
| `street_level` / `rain_street` mostly black -- long misread as a post-processing feedback loop | The shots were parked **underneath the road**. Authored as absolute heights before the city had elevation: `street_level` y=1.7 where ground is **3.10**, `rain_street` y=2.4 where ground is **7.99**. Shot heights are now resolved against `city.groundHeight()` and the aim point shifts with them. | this commit |
| Cloud buffer read `(0,0,0,1)` on all 60k texels, every hour, every weather | The raymarch **livelocked**: empty-space-skip rewound one coarse stride on first density hit without clearing the `miss` counter, so it oscillated between two samples until the step budget ran out. `densityFull()` was never once evaluated. | atmosphere agent |
| Clouds pure black at night | After sunset `sunCol` is 0 and sky ambient is 0, so the cloud deck had **no light source at all**. Added `uCityGlow`. | atmosphere agent |
| Capture harness shot the wrong place (camera not parked) | `setCamera` only stood down `cameraRig`; the newly-landed `player` system also drives the camera. Now hard-locks the transform inside `camera.updateMatrixWorld`, which runs immediately before rasterising, so it holds for **any** camera driver added later. | `6f7d861` |
| GL driver faults invisible to the critic | They arrive on `console.warn`, not `console.error`. The sampler-unit collision that hid the invisible city for a session was a warn. Now captured in `__boston.glFaults`. | `6f7d861` |
| Facade shader: ~500 duplicate `aTex`/`vLayer`/`vEmis`/`vWPosB` declarations | Mutual infinite recursion between two `onBeforeCompile` interceptors; the `RangeError` was swallowed by a bare `catch` | `BuildingKit.installPatch` + `Lighting.applyWindowLights`, commit `bafd01b` |
| Boot fails on a not-yet-written system | Vite statically resolves `import('./literal.js')` | `import.meta.glob` in `main.js` |
| "5 fps" / "83 fps" phantom numbers | Backgrounded-tab rAF throttling | `measureFps()` refuses when `document.hidden` |
| "Clouds cost 66 ms" | GPU-sync bracketing on a tile GPU forces a tile flush | Clouds actually cost ~3.6 ms; see `PERF_REPORT.md` §4 |
| **No clouds in any shot, at any hour or weather** — the cloud buffer read `(0,0,0,1)` on every texel | The empty-space-skipping march **livelocked**. On the first coarse-stride hit it rewound one stride and switched to the fine stride, but did not clear `miss`. The rewound sample is empty by construction, so the stale `miss` immediately tripped the back-to-coarse rule, the next coarse stride landed exactly back on the sample that triggered the rewind, and that rewound again. The march oscillated between two points until it burned all 28 steps. Confirmed by instrumenting the loop: every texel with density reported `iters = 28, hits = 0, maxDensityFull = 0` — `densityFull()` was **never once evaluated**, so `scat` stayed 0 and `T` stayed 1. Density itself was always fine (`maxLow` up to 0.71 over 38% of texels), which is why every check of the noise, the weather map, the shell intersection and the coverage calibration came back healthy. | `clouds.glsl.js`: clear `miss` on rewind, require 6 empty fine steps before reverting to coarse, and don't spend the step budget on a rewind |
| Night sky was a pure-black void with cloud-shaped holes in it | Past sunset `sunCol` is 0, the sky-view LUT ambient is 0 and the moon contributes ~1e-4, so the cloud march had **literally no light source** — measured cloud radiance was exactly `0.0000` at `tod 23`. Nothing was wrong with the march; there was simply no term for the city lighting its own cloud base. | `uCityGlow` in `Sky.js`, horizon-weighted in `skyDome.glsl.js` and base-weighted in `clouds.glsl.js` |
| **Night ambient arrived ~58× weaker than the number that authored it** | A `HemisphereLight`'s irradiance is `colour × intensity`. `SKY_NIGHT` (`#16233f`) has a linear luminance of **0.017**, so the authored night floor of `0.22` reached the shader as **0.0038**. Every night surface that was not directly lit was therefore two orders of magnitude too dark, and no amount of tuning the *intensity* could find it, because the intensity was never the problem. | `Lighting._update` now divides both hemisphere colours by the sky luminance (hue in the colour, level in the intensity) and folds that luminance back into the daylight term, so **daylight is unchanged** and only the night floor changes meaning. Probes get the same normalised colour. |
| Lit windows bloomed into one glowing slab per facade | `uWinBright` 4.2 sat two stops above the tone curve's shoulder at the pipeline's fixed exposure — measured 6.7% of a night street frame pinned at 255, mullions bloomed shut. | `WIN_BRIGHT = 1.5` in `Lighting.js`; clipping 6.7% → 0.1% |
| Cold boot 45 s | Per-pixel JS texture synthesis without `willReadFrequently`, redundant full-size octaves | materials 12,782→653 ms, props 12,672→600 ms |
| **Buildings do not rasterise — the whole city renders FLAT** | `BuildingKit.installPatch` defined `onBeforeCompile` as an **own accessor**, shadowing the `Material.prototype` accessor `CascadedShadows.installLightingShaders` installs. That prototype hook is the only thing injecting the shared `boston*` uniforms — one of which is `bostonProbeTex`, a **`sampler3D`** declared unconditionally by the patched `shadowmap_pars_fragment` chunk. Never receiving it, three never assigned it a texture unit, so it kept the default **unit 0** — the same unit the facade's `sampler2DArray` atlas lands on. The driver then rejected every building draw with `GL_INVALID_OPERATION: glDrawElements: Two textures of different types use the same sampler location`. Geometry, transforms, attributes, material flags and the compiled shader were all correct; the draw call simply never executed. Only buildings/landmarks were hit because every other system assigns `onBeforeCompile` normally and so goes through the prototype setter. | `BuildingKit.installPatch`, commit `d3de1e3` |
| **The irradiance volume never occluded the ambient — `bostonSkyOcc` was a measured no-op** | The probe block was injected onto three's `vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );` line. That is the FIRST of three statements that build `irradiance`; the light probe and then the whole `NUM_HEMI_LIGHTS` loop are added *after* it. So `irradiance *= mix(1.0, bostonSkyVis, bostonSkyOcc)` scaled the AmbientLight term only — and this game has no `AmbientLight` anywhere, so the multiply hit zero. The HemisphereLight, which is the entire controlled ambient, was never occluded at all: a courtyard, a tunnel and an open plaza all received identical skylight, which is precisely what the volume exists to prevent. Every value `bostonSkyOcc` has ever held was untested. | `CascadedShadows.installLightingShaders`: the probe is *sampled* at the `geometryViewDir` anchor and *applied* in `lights_fragment_end`, where `irradiance` carries ambient + probe + hemisphere + lightmap. Occlude first, then add the bounce — the bounce is the fill for occluded points and must not be occluded by its own visibility term. |
| **Shadows only 0.58-0.7 stops deep — "the whole frame is a milky wash"** | Not one bug: the ambient simply outweighed the sun. Decomposed by ablation inside the 09:30 shadow mask (mean output luminance, 1920×1080): everything on **60.4**, environment off **47.7**, bounce off **55.6**, street lamps off **54.3**, hemisphere off **47.9**. The *diffuse* half of the sky IBL was ~3× the hemisphere light and the largest single term, and it is the same skylight the HemisphereLight already delivers — counted twice. Its *specular* half was worth another ~8.6 on its own. | Ratio, not level: `SUN_PEAK` 5.2 → **6.0** (top of ARCHITECTURE's 3-6 band), `SKY_PEAK` 1.05 → **0.72**, a new `bostonIblDiffuse` uniform scaling `iblIrradiance` alone to **0.34** in daylight (specular untouched, so wet asphalt and glass keep their sky), `bostonIblOcc` 0.80 → **0.90**, and `bostonSkyOcc` made real. Frame mean is unchanged (77.2 → 73.9) while the contrast roughly doubles. |
| **15 point/spot lights burned at Σ~1026 intensity at every hour, including noon and 03:00** | The additive proxies had always been clock-gated — `POOL_VERT`/`GLOW_VERT` multiply the instance gain by `uNight` unless the source opts out — but `LightManager._applyPools` applied that gate only to `T_WINDOW`. Every street lamp's *real* `PointLight` therefore burned at full sodium intensity at high noon, and the fifteen pool slots were permanently occupied by lamps that could not be seen. | `_applyPools` reads `F_AUTONIGHT` (which `setEnabled()` already clears for hand-driven lights) and multiplies by `night`; `_select` skips clock-gated sources below `night < 0.02` so the pool is free for anything switched on by hand. Measured settled: Σ **0** at 06:00-18:00, 195 at 19:00, 1026 at 20:00-03:00. |
| **No shadow-casting directional light at all through dusk, or in the small hours** | The sun's term dies at an altitude of −0.9°, the moon ramp opens at −2.6°, and the moon branch additionally required the moon to be above the horizon. Measured: tod 19.5 → `sunIntensity` 0, `castShadow` false; tod 03:00 → the same, because the fallback moon path is below the horizon then. Whole bands of the day were lit by ambient alone, with nothing having a lit side and a shadow side. | `Lighting._update` now blends sun → twilight → moon **additively**, with the direction lifted continuously toward `KEY_MIN_Y` so nothing snaps and the cascade frusta stay bounded. Measured after: a casting key at every hour, `sunIntensity` ≥ 0.14, key altitude ≥ 0.066. |
| The daylight ambient was tinted warm and the dusk ambient cyan — backwards | `THREE.MathUtils.smoothstep(x, min, max)` tests `x <= min` **before** `x >= max`, so calling it with `min > max` does not reverse the ramp, it degenerates to `x > min ? 1 : 0`. `smoothstep(altDeg, 14, -3)` was therefore 1 only when the sun was *above* 14° — so the hemisphere light was 85% of the warm `SKY_DUSK` colour at noon and pure blue `SKY_DAY` at sunset. Measured on the live light: `#fff0e7` at tod 6/7/12/15/18, flipping to `#c8ffff` at 18.5. | `Lighting._update`: `(1 - smoothstep(altDeg, -3, 14)) * smoothstep(altDeg, -9, -1)`. **Never call `MathUtils.smoothstep` with `min > max`.** |
| Roofs read as bare pale planes from every elevated shot | The always-resident LOD-2 shell lidded its parapet (`cap` at `ty + parapet - 0.46`), putting that surface up to **0.9 m above** the LOD-0 roof deck. The shell is drawn even where a detailed chunk is loaded, so its lid covered every real roof in the city and hid all the roof furniture underneath. | `Facades.buildShell`, deck now caps at the shell drop plane with a proper inner parapet face |
| Skyline is a wall of same-height slabs | `plot.maxHeight` is **one flat number per district** (every Financial District parcel carries 240 m) and `makeSpec` did `storeys = max(storeys, floor(fit * 0.62))`, giving every tower the same fraction of the same number: 479 buildings inside one 20 m band with a hard gap from 100–140 m. Height now comes from a power law under a per-district ceiling (`Facades.DISTRICT_HEIGHT`), gated on parcel area and distance to Boston's two real tower clusters (`TOWER_CORES`). Caps stay under the landmarks so 200 Clarendon (241 m) and the Prudential (229 m) stay outliers. Result is monotonic: 5900 / 513 / 136 / 125 / 149 / 63 / 34 / 19 / 3 by 20 m bucket. | `Facades.makeSpec`, commit `9ed0f06` (swept in) |
| Every tower ends in the same flat parapet line at distance | The rooftop antenna mast — a **silhouette** element — was emitted at `lod === 0` only, so it was dropped exactly when the top edge became the only readable thing about a tower. Now emits for `lod < 2` and is mirrored into `shellRoofKit` off the same keyed hash. | `Facades.roofClutter` / `shellRoofKit`, commit `35c42fe` |
| **Every hour of the day tone-maps identically — exposure is a fixed 2.424 at noon and at midnight** | `RenderPipeline.options.minEV` was `-0.6`, and `AutoExposurePass` converts EV100 to a log-luminance clamp as `log2(L) = EV100 - 3`. That put the metering **floor at log2 L = -3.6**, which is *brighter than most of the game*: measured metered log-luminance is -1.4 at overcast noon but -4.4 at a 09:30 street and -5.8 at 22:00. Everything from mid-afternoon downwards sat pinned on the floor, so the adaptation had a constant to integrate and the exposure never moved. Boston's scene-referred radiances are simply nowhere near photographic cd/m², so a photographic EV floor clamps real scenes. Floor is now `minEV: -8.5` (log2 L = -11.5), ~3 stops below the darkest shot. Verified: exposure now spans **0.54 (overcast noon) to 3.47 (rain street)** across the eight review shots and nothing sits on the clamp. | `RenderPipeline.options.minEV` |
| Night rendered as bright as noon *after* the clamp was fixed | A meter with unit gain maps every scene onto the same middle grey by construction — that is what a meter is for. Fixing the clamp therefore made 22:00 render at frame p50 100/255, identical to 09:30. It also silently cancelled the lighting stage: any change to `NIGHT_SKY` was undone by the exposure stage within a second, which is why that constant had been pushed to a non-physical 0.9 chasing a visible result. `AutoExposurePass.setResponse(pivot, gainDown)` now compresses the metered value toward a pivot on the **dark side only** (full gain upwards, so a bright sky still stops down and cannot clip). At `meterGainDown: 0.55` night_neon lands 1.9 stops below its fully-adapted exposure while the four daylight shots move under a quarter of a stop. | `AutoExposurePass.setResponse` + `RenderPipeline.options.meterPivot`/`meterGainDown` |
| `LensPass` draw rejected with `GL_INVALID_OPERATION` (framebuffer feedback loop) every frame — the whole progressive-tent bloom halo silently missing | The upsample bound `mips[i-1]` as a `supportBuffer` sampler **while rendering into `mips[i-1]`**. Reading and writing one texture in the same draw is a feedback loop; the driver dropped the draw and reported it as a `console.warn`, so it never reached `__boston.errors`. The frame still looked plausible because `mips[0]` kept its plain downsample. The upsample now emits `vec4(col * scatter, scatter)` and the *blender* combines it with the destination (`src + dst*(1-srcA)` = `mix(dst, col, scatter)`), so the finer level is never sampled. Also energy-preserving, unlike the old unbounded `support + col`. Verified: stubbing every pass but one and reading `gl.getError()` now returns `NONE` for all ten passes, and binding a target as its own sampler still faults on this driver, so the test has not gone blind. | `LensPass.upMat` / `UP_FRAG` |
| Shadow recovery believed unnecessary because "the HDR probe shows no detail below the clip point" | The probe *was* the frozen meter. With metering live, `probeLuminance()` on the dusk downtown framing reports scene p05 at **-7.36** against an adapted key of -3.11 — 4.2 stops of real rendered detail under a curve that clips at ~5.5. Toe re-enabled at `shadowContrast: 0.62`. Dusk pure-black pixels 7.45% → 1.9%, p05 0.4 → 4.9, with p50/p90/p99 moving under 1.5/255. Note `shadowToeStops` is a **width**: widening it to 9 lifts the deepest shadows *less* (night_neon black 5.4% at 7 stops, 8.9% at 9). Tune the contrast, not the width. | `RenderPipeline.options.shadowContrast` |
| Hard horizontal step at the horizon of every **level-camera** frame (rows 540–542 at a 14 m camera) | The composite sampled the sky-view LUT with the raw view ray. `atmSkyViewUv` is the Hillaire parametrisation — `uy = 0.5 - 0.5*sqrt(1-c)` above the horizon, `0.5 + 0.5*sqrt(c)` below — so `duy/dθ` is unbounded exactly at the horizon **and the LUT's own sky/ground boundary sits at uy = 0.5**. In-scatter therefore switched content over a fraction of a degree instead of ramping with depth. At a 14 m camera the boundary lands at `rd.y = -0.0021`, two screen rows below the horizontal; walking `rd.y` from 0 to the old `-0.02` clamp moved `uy` 0.4817 → 0.5534 — seven texels of a 96-tall LUT, straight through it. **A directional, to-infinity LUT is the wrong source for a finite-path term**: aerial perspective depends on the path, not on which side of the horizontal the ray is on. | C1 elevation floor (`SKY_ELEV_FLOOR`) in `atmospherePass.glsl.js`, commit `39e5dc1` |
| Hard horizontal seam across the frame; the outer third of view distance kept its raw unfogged colour | `if (d > 0.99999)` in the atmosphere composite classified sky. That epsilon is worth **8108 m** at `near 0.25 / far 12000`, so it acted as a second, invisible far plane: geometry beyond it was treated as sky and skipped aerial perspective. Depth epsilons are distances, not tolerances — always convert one back to metres before trusting it. | `d >= 1.0` in `atmospherePass.glsl.js` + `clouds.glsl.js`, commit `d290e5e` |
| The `atmosphere` pass reported **zero** cost in every GPU profile | `_passNames` was captured inside `_rebuild`, which runs at init — before the atmosphere stage inserts its pass. `GpuTimer` round-robins over that list and `_instrument` is what makes a pass timable at all, so a pass added later was not merely mis-timed, it was invisible. `_syncPassList()` now re-reads the composer whenever the pass count changes. | `RenderPipeline._syncPassList` |
| Lateral chromatic aberration much heavier at night than authored | `LensFinalEffect` scales CA by `1 + stopsUnder * 0.22` off the adapted luminance, uncapped. That was harmless only while the meter was frozen at -3.6 (a constant 1.87×); with metering live it reached 2.8× and put ~3 px of fringing in every corner of a night frame. Capped at `apertureMax` 1.9, which leaves the day look unchanged. **Superseded 2026-08-30 (`06ed84c`):** a critic pass called the residual CA an automatic fail — every pole and cable fringed, the Zakim stays aliasing into a dashed rainbow. Two further faults: `r` was normalised so it **clamped to maximum from 62% of the way out to the corner**, and the base was 3–5× a real lens. Now `r` reaches 1.0 exactly at the corner, exponent 2→3, base 1.15→0.35 px, `apertureMax` 1.9→**1.3**. Corner R–B separation 3.28→0.60 px at `bridge`, 5.03→0.50 at `street_level`, and exactly 0.00 at frame centre. | `LensFinalEffect` |
| **AO and SSR reported `enabled: true` for iterations while being absent from the composer** | Preset gating, not the rebuild path: `BUDGET.high` carried `ao: false, ssr: false`, and `_rebuild` computes `_aoOn = s.ssao && q.ao`, so at the default `high` preset neither pass was ever added. It stayed hidden because `Pass.enabled` defaults `true` and nothing cleared it for a pass that was never added — so the flag reported the **opposite** of the truth. This is why SSR measured 0.00 contribution to the wet road in three consecutive critic passes (blamed each time on env-probe intensity) and why contact shadows did not exist anywhere in the build. `_rebuild` now clears `enabled` on every optional pass it omits. Two further faults found while wiring them in: `_adoptAoBeautyTarget()` was **dead code** targeting `N8AOPass` when we import `N8AOPostPass` (no `beautyRenderTarget`), so the 19.5 ms double-render it prevented was never being paid — **and the 7.6 ms figure that justified making AO `ultra`-only had been measured against a hazard that does not exist**; and N8AO's `autoDetectTransparency` cost **+121 draws / +151k triangles every frame** (note: setting `configuration.transparencyAware = false` does *not* work — the proxy only acts on change). | `RenderPipeline._rebuild`, commit `06ed84c` |
| **`freeze()` did not freeze the scene** — every pixel A/B was measuring pedestrians | It only set `timeScale = 0`. Traffic, vehicles and peds animate off their own `dt`, so two reads of a "frozen" frame differed and agents were comparing against an A/A noise floor nobody had established — one measured **40%** before working it out and stubbing the three systems by hand. `freeze()` now calls `pauseActors()`, which stubs `update`/`fixedUpdate`/`lateUpdate` on those three and restores the exact references on release. Deliberately **not** the streaming systems: `Buildings._pump` builds geometry from `update()`, so stubbing it would stop `capture()` ever settling — which is why `capture()` lets the actors run through warm-up and only re-freezes them for the frame it returns. Measured A/A floor: mean 3.809 → **1.708**/255, the residual being film grain at ~2.3 luma/frame. | `CaptureHarness.pauseActors`, commit `1c420c0` |
| **41–52 pure-white snow banks standing on a clear August street**, one with a handrail through it | Two independent bugs, both in props. (1) The weather gate worked, but `PropBatch.refresh()` ended with `m.visible = cnt > 0`, which overwrote `setVisible(false)` the next time the camera crossed a chunk boundary. `Props.update` only re-applied the gate `if (this._snow)` — i.e. never in the case that needed it. Suppression is now a durable `PropBatch.hidden` flag that `refresh()` honours. (2) They were authored at `halfRoad - 0.2`, i.e. **inside the carriageway**, which is why they sat mid-road and intersected pavement furniture; a plough throws snow onto the kerb, so they now sit at `halfRoad + 0.34`. Also re-coloured — ploughed city snow is grit-grey at the base, not `ffffff`. Same class of bug hid in `Decals.setWeather`, which showed road **salt** under `overcast`. | `PropBatch.hidden`, `Props._applySnow` |
| **Every prop that would carry a street placed zero instances city-wide**: `shopSignA/B`, `storeFasciaA/B`, `fireEscape`, `acUnit`, `flagUS/MA`, `satDish`, `standpipe`, all five `veg_*` and all fourteen decal families | Not missing — *piled up in one place*. Both placers drained a flat global counter (`take(k) => (quota[k] -= n) >= 0`) while walking segments and parcels that `finishLayout` sorts **by distance from Boston Common**, so the entire city-wide budget was spent within a few hundred metres of the origin and every `if (!take(k)) break;` then truncated the rest of the city. Measured from the live instance matrices: all wall props and wall decals inside a **340–413 m radius**; `decal_grimeWall` occupied **10 chunks of 436**; the whole `tarSeam` budget went on 29 of 488 segments. A second, compounding bug: `finishLayout` walked **all four** edges of each parcel polygon, so three quarters of the wall props that did exist were on the sides and back of the parcel, buried inside the block. Now a two-pass placer — pass 1 counts sites with the identical code path, pass 2 places with probability budget/sites — plus street-facing edges only, with the outward normal derived from the parcel's own depth vector rather than from polygon winding. Result: same families now reach a **3,300 m radius over 400–800 chunks**, and a Financial District street camera sees 14/14 decal families and non-zero signage where it previously saw none. | `Props.RATE`/`runPlacement`, `Decals.RATE`/`runDecals`, `finishLayout` |
| Props drew full-detail geometry hundreds of metres past their LOD range | `_registerTypes` used `def.far` as the cull distance for any type with no reduced level, silently ignoring the authored `def.near`. 984-triangle fire escapes drew to 215 m; 440-triangle tree grates, seen almost edge-on, drew to 130 m. Single-LOD types now cull at `min(far, near * 1.3)`, `fireEscape` gained a 78-triangle LOD1, and the two flat-on-the-ground props lost the 4×24 tori that were most of their triangle count. Measured at `night_neon` with instance counts held constant: props 514k → **277k** triangles, all four owned systems 736k → **498k**. | `Props._registerTypes`, `buildFireEscape`/`buildTreeGrate`/`buildManhole` |
| **Parked cars were 424-triangle featureless boxes at 3.7 m** — "the dominant foreground liability" | The first parked car was a hand-rolled stack of boxes: no wheel arches, painted-on glazing. Invisible as a problem while there were zero parked cars; the closest object to the camera in every street framing the moment the kerbs filled up. Fixed by *reusing* rather than remodelling — `VehicleModels.getVehicleGeometry` already lofts a proper body with arch lips, fascias, a greenhouse and baked wheels at three levels and caches per type, so a parked car and a moving car now share one geometry build. Parked cars take **LOD1** (mid tier, real glass, five material buckets) near and **LOD2** (the shell traffic already instances) far, fed through `GeoSet` onto the shared prop materials. Measured **424 → 3,532 triangles** close up, real dimensions (sedan 1.96 × 1.49 × 4.86), sitting exactly on the ground. VehicleModels is imported read-only; it imports nothing but three (no cycle) and `GeoSet` copies through `toNonIndexed()`, so `disposeSharedGeometry()` stays safe under VehicleFactory's control. | `buildCarFromVehicle` in `StreetFurniture.js` |
| **Every parked car in the city faced backwards** | `facing()` aims a model's local +Z along the street, but a VehicleModels body is lofted with its **front at −Z** — measured, head lamp anchors at z −2.31 against tail lamps at +2.34. The whole fleet was parked tail-lights-first. One half turn. | `Props` parked-car yaw |
| Kerb occupancy stuck at ~24% of natural — cars *sprinkled* along a street rather than parked on it | Not the budget number: the **LOD granularity**. `PropBatch` picks a level per 96 m chunk, so "LOD0 within 38 m" actually admits every instance in any chunk whose centre is within 38 + 67.9 m — ~120 cars at 3.5k triangles each. Density was paying for a coarse LOD test. `PropBatch` now does **per-instance LOD selection for the near tier**, opt-in via `splitNear` so the other ninety-odd types keep the bulk-copy path. Measured across the five street shots: parked-car triangles in frustum **372–622k → 120–162k** while the fleet went 11,000 → 14,138 and the near body went 424 → 3,532 triangles. | `PropBatch.refresh` / `splitNear` |
| Parked cars sat partly in the outer travel lane | There was no parking bay in the road graph, so the placer used a `halfRoad >= 2.9` width test to bound the intrusion. The city now publishes `edge.parking = { width, offset }`; cars sit in the bay, intrusion is zero by construction, and coverage goes from a width test to **450 of 509 segments**. | `Props` parked-car placement |
| **Street trees had 4.14 m thick trunks** (11.47 m on the Common's elms) | `buildTree` took `SPECIES.trunk` as a straight proportion of tree height and used `S.trunk * H` directly as the bole **radius**, so a 14.5 m London plane got a 2.07 m radius — eight to ten times life size. This is most of why vegetation read as "blobby broccoli": every tree was a canopy balanced on a concrete column, and it is also why the bark tiling was so conspicuous, because one 256 px tile was stretched over a five-metre cylinder. A street tree's DBH is roughly H/40 to H/25. Fixed with a `TRUNK_R = 0.13` factor. The three **park specimens** needed their own constants brought down as well, and were missed on the first pass — elm was left at H/16, beech H/14, willow H/13. Measured after both passes: plane **4.14 m → 0.71 m (H/20)**, elm **11.47 m → 1.14 m (H/22)**, beech H/16, pin oak 3.96 m → 0.74 m. Canopy cards additionally now cluster around 3–5 lobe centres with a quarter thrown past the crown radius at reduced size, so the silhouette is not a disc — same card count, same triangles. | `Vegetation.TRUNK_R` / `buildTree` |
| **The always-resident shell re-drew every near building, and stood behind their windows** | The LOD-2 shell is built for all 9,514 buildings and never turned off, so wherever a detailed chunk is loaded the same wall rasterises twice. Measured at `st_beaconhill`: the nearest in-frustum sector holds **733 buildings of which 704 already had a detailed mesh** — 61 k of the 63 k triangles that sector submits were hidden duplicates, in the part of the frame that covers the most pixels, and re-submitted to three shadow cascades on top. The shell is inset only **0.25 m** from its LOD-0 twin, which is *less than a window reveal*, so it was also standing behind every recessed pane in the near field and hiding the interior mapping and the sky reflection. Same class of bug as the shell roof lid fixed earlier — the inset/drop clears the *wall plane*, not the *openings*. Each sector's shell is now emitted in streaming-chunk order so every chunk owns a contiguous index run, and `_refreshShellMask` compacts the index buffer to drop the runs a loaded **LOD-0** chunk covers (LOD 1 keeps its shell: an LOD-1 chunk mesh is `castShadow = false`, so at that range the shell is the only thing casting the building's shadow). | `Buildings._buildShell` / `_refreshShellMask`, commit `2bdba51` |
| **Every building mesh sorted as if it were at the world origin** | `MeshBuf`/`GlassBuf` bake in world space and the meshes carried an identity matrix, so three's `painterSortStable` projected *all* of them to the same clip-space point and the opaque depth sort degenerated to `object.id` ascending, i.e. creation order. The shell is created in `init` and the streamed chunks much later, so the distant shell was drawn **first** and the near city painted over it — exactly back-to-front, the worst possible order for early-Z. `build(recenter)` now translates to the geometry's own bounding-box centre and publishes `geometry.userData.origin`, which `Buildings` puts back on `mesh.position`. Any other system that merges geometry in world space has the same defect. | `BuildingKit.MeshBuf.build` / `GlassBuf.build`, commit `2bdba51` |
| Buildings render as flat, pale, untextured white slabs beside properly-facaded neighbours ("floating with white outline boxes") | The slabs are the LOD 2 shell; the detailed LOD 0/1 chunks had not been built yet. `Buildings._pump` widened its per-frame build budget only while `ctx.time.frame < 200` and used 6 ms after that. A camera teleport invalidates every near chunk at once, a dense chunk is ~160 ms of emit on its own, and `capture()` warms up only ~24 frames — so 6 ms/frame could never converge. Whatever happened to be built already showed a full facade and everything else showed the shell, hence the mixture. `update` now detects a teleport (camera moved more than one CHUNK in a frame) and `_pump` spends 50 ms/frame for 45 frames. Normal driving moves ~0.5 m a frame and never trips it. Measured after a 2 km teleport and a single `capture()`: near chunks built 0/14 → **14/14**; frame changed by hiding the detailed meshes 1.5% → **66.1%** (noise 0.1%). | `Buildings._pump` / `update`, commit `a927ec9` |

### Handed to other systems by the props/vegetation pass
- **Kerbs are Roads.js geometry, not a props problem.** `Roads.js` already builds a real
  kerb: `KERB_H = 0.145`, a vertical face band at the road edge and a granite top band
  (`_section`, ~line 345). The face is textured with **`T_ASPHALT`**, not granite, which is
  why it reads at street level as a painted stripe rather than a kerb with a shadow line.
  Adding a second kerb from props would z-fight with it. *Owner: roads / materials.*
- **There is no parking bay anywhere in the road graph.** `RoadNetwork.PROFILE` spends the
  full kerb-to-kerb width on travel lanes and leaves a 0.5–0.7 m shoulder, so a car parked
  against the kerb necessarily overlaps the outer travel lane. Measured overlap by profile:
  `street` hw 3.80 / 2 lanes **0.64 m** (worst), `arterial` hw 5.95 / 3 lanes and hw 7.70 /
  4 lanes both **0.34 m**. Parked cars are therefore only placed where `halfRoad >= 2.9`
  (both sides at `>= 4.6`), which excludes the 94 one-lane streets and all alleys. To make
  this exact, either widen those profiles by a 2.2 m parking lane per parked side or inset
  the outermost lane centre. *Owner: city / traffic.*
- **Wet asphalt renders white — not a props bug.** `Roads.js:204` registers the road
  material with `wetnessRough = 0.92`, and `Assets.setWetness(v)` (`src/gfx/Assets.js`)
  drives every registered material to `roughness = lerp(rough, 0.06, v)`. At full wet the
  road is a near-mirror (0.06) under a bright sky, which is what blows it out. The four
  props/vegetation files only *register* their own materials into that same shared
  mechanism. *Owner: roads / materials + render.*
- **`prop:parkedCar` is a static shell, not a vehicle.** Nine variants sharing
  `VehicleModels`' own body loft (LOD1 near at ~3.5k tris, LOD2 shell far at ~430), real
  dimensions, no physics body and no simulation. If traffic wants parked cars that can be
  driven away, take them over the way `traffic.takeOver` does — the geometry is already
  the same cached build.

## Unresolved issues (ranked)
1. **The two street-level shots are parked *underneath the road*. This is not a render
   bug.** `street_level` sits at `y = 1.7` where `city.groundHeight(40, 120)` is **3.10**,
   and `rain_street` sits at `y = 2.4` where the ground is **7.99** — so both review shots
   render the underside of the terrain over a black lower half, which is what the earlier
   "low cameras collapse to black" table was measuring. Swept at the same x/z and the same
   look direction, the transition lands exactly on the ground plane, not on any camera
   height a post-processing bug could care about:

   | cam Y | 1.7 | 2.6 | 3.4 | 4.8 |
   |---|---|---|---|---|
   | above ground by | −1.40 | −0.50 | **+0.30** | +1.70 |
   | black frac | 0.283 | 0.285 | **0.006** | 0.012 |
   | mean lum | 47.6 | 49.7 | 81.4 | 73.3 |

   Raising `street_level` to `y ≈ 4.8` renders the Common correctly, rain and all. **Fix
   the shot definitions against `city.groundHeight()` rather than hunting the frame.**
   *Owner: capture harness / city. File: `src/core/CaptureHarness.js` `this.shots`.*

   ~~Separately, one fullscreen pass forms a framebuffer feedback loop (`LensPass
   INVALID_OPERATION`).~~ **Fixed** — see §Resolved. Re-derived after the critic could not
   reproduce it: the bisect now returns `NONE` for all ten passes, *and* deliberately
   re-creating the old shape at runtime (binding a render target as its own sampler) still
   returns `INVALID_OPERATION` on this driver — so the clean result is a fix, not a blind
   test.
2. ~~**The exposure chain never adapts — a fixed 2.424 at every hour.**~~ **Fixed.** Three
   separate defects, all in §Resolved: the `minEV` clamp floor sat above most of the game,
   a unit-gain meter then cancelled the day/night cycle once the clamp was lifted, and the
   shadow toe had been switched off on evidence produced by the frozen meter. Measured
   after, `high`, verified camera positions, full-frame readback:

   | shot | exposure | frame p50 | % below lum 2 | % clipped |
   |---|---:|---:|---:|---:|
   | `overcast_wide` 13:00 | **0.54** | 103.8 | 0.0% | 0.0% |
   | `hero_skyline` 17:48 | 0.78 | 111.7 | 0.0% | 0.0% |
   | `bridge` 08:12 | 0.94 | 73.0 | 0.0% | 0.2% |
   | dusk downtown 19:24 | 1.52 | 88.7 | 1.9% | 0.0% |
   | `street_level` 09:30 | 2.11 | 70.0 | 0.1% | 2.5% |
   | `golden_hour` 06:36 | 2.52 | 70.3 | 0.0% | 0.0% |
   | `night_neon` 22:00 | **2.78** | **32.8** | 7.0% | 0.1% |
   | `rain_street` 15:12 | **3.47** | 64.4 | 0.0% | 0.0% |

   Exposure spans **2.7 stops** across the review set and nothing sits on the clamp. Night
   median is now **~30% of overcast noon** (was ~70% end-to-end when the critic measured
   it), and the worst clipping in the set is 2.5% on the one shot with the sun in frame
   (was 15–16%). **For the lighting stage:** `NIGHT_SKY` can and should come back down to a
   physical value now. At `meterGainDown: 0.55` a two-stop cut to the night ambient will
   darken the frame by roughly 0.9 stops instead of being silently cancelled — so make the
   change in small steps and re-read `probeLuminance()` rather than the frame alone.
3. **Night is now genuinely night; how far down `NIGHT_SKY` should go is still open.**
   With the exposure clamp gone (issue 2) the night floor came down from the 0.9 that was
   compensating for it. Swept at Hanover St 21:30, 1920x1080 `high`, 45 frames of settling
   between samples so the meter converges, full-frame readback:

   | `NIGHT_SKY` | adapted log2 L | mean | p50 | % below lum 2 |
   |---|---:|---:|---:|---:|
   | 0.90 (old) | −4.58 | 44.8 | 35.8 | 2.2% |
   | 0.60 | −4.58 | 39.5 | 31.3 | 3.7% |
   | **0.50 (now)** | — | **42.1** | **33.2** | **3.5%** |
   | 0.45 | −4.64 | 37.8 | 29.8 | 4.7% |
   | 0.30 | −4.77 | 36.7 | 28.9 | 5.7% |
   | 0.20 | −4.88 | 36.0 | 28.1 | 6.5% |

   Note what the meter does **not** do: a 2.2-stop ambient cut moves the adapted
   log-luminance by only **0.3 stops**, because a night street is metered off its lamps,
   emissives and sky rather than off its ambient. So the render agent's `meterGainDown:
   0.55` estimate does not apply to this particular knob — the cut lands almost entirely on
   the frame, and the cost is a quadrupling of near-black pixels against a rubric that
   automatically fails "pure black with no detail". 0.50 takes night from 44% of noon's
   median to **37%** while keeping the bottom of the histogram alive. Going further is a
   joint decision with `toeParams` / the black point, not a lighting-only one.
   *Owner: lighting + render, together.*
4. ~~**A hard horizontal seam across the whole frame from the `atmosphere` pass.**~~
   **Fixed**, commit `d290e5e`. The render agent's diagnosis was exactly right: the
   composite classified sky with `if (d > 0.99999)`, and at `near 0.25 / far 12000` that
   epsilon is reached at **8108 m**, so all geometry past 8.1 km skipped aerial perspective
   while everything nearer got the full in-scatter. Now `d >= 1.0`: the sky dome writes no
   depth so sky pixels hold exactly 1.0, the most distant geometry inside the far plane
   still reads 0.99999983, and the depth texture is `FloatType` — the two cases cannot
   collide, and there is no second invisible far plane.

   Verified by A/B on one frame (the epsilon restored at runtime vs the fix), scoring each
   row by its **median** luminance step across 480 sampled columns together with sign
   coherence. A content edge such as a roofline moves only the columns it crosses, so its
   median is ~0; a classification seam moves every column identically. On `overcast_wide`:

   | | worst row | median step | coherence | seam rows |
   |---|---|---|---|---|
   | epsilon | 368 | **−90.7** | **1.00** | 5 |
   | `d >= 1.0` | 368 | *gone* | — | 2 |

   Positive confirmation, not just absence: the fix moves **28–35% of the frame**
   (`overcast_wide` 35.4%, max delta 125/255; `hero_skyline` 28.4%; `bridge` 30.3%) — the
   outer third of view distance, which is precisely the region that had been unfogged.
   The same exact test was applied to the volumetric shaft march and the cloud march's
   four-tap geometry reject so all three stages agree on what "sky" means.

   **Correction to what this entry first claimed.** The full-width rows left over after
   this fix were written up as "the horizon itself, a content edge". That was wrong for
   most of them. They were a *second, independent* horizon defect in the same pass — the
   in-scatter step recorded in the row above — which this A/B could not see, because both
   of its arms shared it. `street_level` row 542 and `downtown_dusk` row 477 are now
   fixed as well. The lesson: **an A/B only clears the variable you toggled.** Two defects
   can sit on the same row, and fixing the first makes the second look like leftover
   content.

   **Second horizon defect — also fixed**, commit `39e5dc1`: in-scatter stepped across
   the horizon of every level camera. Measured old-vs-fixed on the same frame, median
   row step with sign coherence over 480 columns:

   | shot | before | after |
   |---|---|---|
   | `st_backbay` | row 545, **+20.5**, coh 0.79 | −1.3, coh 0.25 |
   | `st_beaconhill` | row 548, **+21.0**, coh 0.90 | +2.4, coh 0.38 |
   | `st_northend` | row 539, **+12.9**, coh 0.69 | +1.6, coh 0.27 |
   | `st_southend` | row 543, **+8.5**, coh 0.61 | −1.0, coh 0.18 |
   | `street_level` | row 542, **+23.7**, coh 0.90 | +1.8, coh 0.28 |
   | `downtown_dusk` | row 477, **+14.9**, coh 0.64 | −1.9, coh 0.23 |
   | `st_backbay` @ tod 18.5 | row 545, **+40.1**, coh 0.91 | +1.4, coh 0.11 |

   Every one drops to zero seam rows. Dusk was the worst case and gains the most. A
   column through `st_backbay` went from a cliff — rows 536–543 holding ~`88,104,128`
   then falling to `52,60,88` — to a smooth ~1/255-per-row drift. The fix does not
   flatten the depth cue: removing in-scatter entirely still moves the frame 22.6/255
   above the horizon, while old → fixed moves it only 3.5/255 above and 7.7/255 below.
   `st_seaport` has no horizon in frame and never had it.

   **`overcast_wide` is the one shot this does not clean up, and it is not atmosphere.**
   Replacing the whole composite with a passthrough still leaves 3 full-width rows at
   **coherence 0.98**, so they are already in the scene buffer when the pass receives it.
   Those are the two `Terrain._patch` ring gaps (core ends 1506 / mid starts 1508, and
   mid ends 3200 / far starts 3300) showing the sky dome's back face at 9 km — already
   routed to city. The pass raises their contrast because the gap pixels sit at 9 km
   while the terrain either side is ~2 km, so they receive very different aerial
   perspective; that difference disappears once the gap is closed.

   **The separate pure-black horizon band the critic reported does not reproduce.**
   Asked to determine ownership: it is not atmosphere, and it appears to be gone. Scanned
   for rows where >50% of sampled columns are pure black across all 8 named shots and 8
   extra camera positions/pitches chosen to look out over the edge of the world
   (`[0,60,0]`, `[0,300,0]`, `[3000,120,0]`, `[0,900,0]` at pitches +2° to −5°):
   **0 such rows anywhere**, and 0 with the threshold loosened from pure black to
   luminance < 12.

   The detector is not blind — forcing the composite to emit black (`uMaxRadiance = 0`)
   makes it report **1068 of 1080 rows**, so a zero on a real frame is a real zero. Most
   likely already fixed by `45a312f` ("Buildings: fill the perimeter hole"), which is
   the same shape of defect. Water is no longer a suspect either: all five water bodies
   are now bounded `MeshStandardMaterial` polygons, not an infinite plane with a failing
   program. If the critic still sees it, it will need the exact camera to chase.
   *Owner: not atmosphere. Re-route to city/terrain only if it reappears.*

5. **Water shader fails to compile** — `nonPerturbedNormal` undeclared / `geometryNormal`
   redefined; three r171 renamed this varying. Two programs fail `VALIDATE_STATUS`.
   *Owner: city/materials. File: `src/world/Water.js`.*
6. ~~**Crushed blacks in daylight**~~ — **verified fixed and holding.** The double
   sRGB→linear conversion is gone from `LightProbes` (the albedo colours are constructed
   once and not re-converted). Full-frame readback at `golden_hour`: **0.6%** of pixels
   below luminance 2, 1.6% below 8, nothing clipped at the top; `downtown_dusk` 2.3% below
   2. Shadowed regions carry real gradient. Note `street_level` still reads 27.7% black —
   that is issue 1 (the camera is under the road), not the grade.
7. **Buildings at mid/far LOD** — **done, keep an eye on it.** Verified by parking the
   camera so the chunks in frame report `lod` 1 and 2 explicitly. The LOD-2 shell carries
   baked `fac_*` facade strips (one vertical repeat = one storey), a plinth, a coping
   line, a roof kit and now rooftop masts; roofs vary in surface and tone at every tier.
   Nothing reads as a bare box and nothing pops across a LOD boundary.
   *Owner: buildings.*
8. **Vegetation reads as "broccoli"** — blobby canopies, insufficient silhouette variety.
   *Owner: vegetation.*
9. **Not yet built at all**: `Missions.js`. Traffic, pedestrians, the player character and
   the chase camera all landed — see §What exists and works.
10. **Nothing reacts to being hit.** `player.health` never changes, cars drive through
   pedestrians (peds avoid the *player*, not traffic), and `player:wanted` is only ever
   raised by hand. Peds do flee at wanted ≥ 3 and traffic reads the level, but nothing
   sets it. *Owner: gameplay/missions.*
11. **Ped and car spawning still pops** at the streaming radius when the camera moves
    quickly, because a spawn is placed on the nearest pavement/lane sample rather than
    tested for visibility. Fine at walking pace, visible from a fast car.
    *Owner: AI.*
12. **Pedestrians almost never reach a junction, so crossings are rarely seen.**
    `RoadNetwork.buildSidewalks` emits **one walk edge per road edge per side**, and a
    Boston road edge is a whole street — mean **177 m**, up to **1.2 km**, and 430 m on the
    strands round the Common. A crossing link only exists at a junction, so a pedestrian
    dropped mid-block walks for two to five minutes before he can even decide to cross.
    The crossing machinery itself is correct and verified: `WalkNav.nextEdge` returns a
    crossing on **23.7%** of junction decisions (5,701 of 24,048 sampled), and pedestrians
    forced to an edge end do enter `cross`, walk the crossing and continue. What is missing
    is *opportunity*. `Pedestrians` already mitigates it from its own side — spawns take
    the best of four draws by distance-to-corner and then head for the nearer corner, which
    brought the median distance-to-junction from ~215 m down to **86 m** — but the real fix
    is to subdivide long pavement strands at, say, 60 m so the graph has decision points.
    *Owner: city (`RoadNetwork.buildSidewalks`), with AI to follow.*
13. **Static props sit ~0.55 m BELOW the pavement they stand on.** The critic's "peds
    +1.96 m / traffic shells +1.40 m above ground" reads the discrepancy the wrong way
    round, and the inference that drove it — *"all static props are perfectly aligned, so
    `groundHeight()` is the right reference"* — is exactly backwards. Props matching
    `groundHeight` is not evidence that `groundHeight` is the surface; it is evidence that
    props are buried.

    `Terrain.stampRoads` deliberately clamps the raster **below** the carriageway ("never
    above the gutter", "never above the kerb top") so the ground mesh cannot poke through
    the asphalt. `Roads.js` then builds the road from the *graph polyline* `y` and the
    pavement from that `+ KERB_H (0.145)`. So near any road, `groundHeight()` is a systematic
    **0.4–0.6 m below the surface that is actually drawn**, by design.

    Measured by raycasting the real collision geometry at `st_backbay` (origin 2 m above the
    strand, so no tree canopy), 10 pavement and 3 carriageway probes:

    | reference | vs. rendered surface (median) |
    |---|---|
    | pedestrian `y` (sidewalk strand) | **−0.02 m** — correct |
    | AI car `y` (lane polyline) | **+0.04 m** — correct |
    | `groundHeight()` at the pavement | **−0.58 m** |
    | `groundHeight()` at the carriageway | **−0.38 m** |

    Independently, sampling 600 prop instances: `prop.y − groundHeight()` has median
    **0.00** and min **0.00** — props sit exactly on the raster — while
    `prop.y − sidewalkStrandY` has median **−0.59 m**. A lamp post at (−142.6, −212.8) is at
    `y = 8.62` with `groundHeight = 8.62` and the pavement above it at `9.30`.

    So: **do not "fix" peds or traffic against `groundHeight()`** — that would sink them half
    a metre into the road. `Props.js` already anticipates this at line 495,
    `L.kerb = 0;   // sidewalk lip above groundHeight; see report — city may raise this`.
    Either props lift by the local kerb amount, or the city publishes a
    `city.surfaceHeight(x, z)` that returns the drawn surface rather than the raster.
    *Owner: props / street furniture, with city to publish the accessor.*

## Shadow depth, before and after — the number the critic scored

Same build, 1920x1080, `high`, Hanover St `pos [996.9, 4.73, -1109.2] look [1030.3, 4.73,
-1159.1] fov 55`, clear. "Before" is the pre-`3e36934` lighting reconstructed **at
runtime** (`SUN_PEAK` 5.2, `SKY_PEAK` 1.05, `bostonIblDiffuse` 1, `bostonSkyOcc` 0 — which
is what it effectively was, `bostonIblOcc` 0.80, `bostonSunAngular` 0.0093, street lamps
burning in daylight) so both halves come from one build and one frame of geometry. Ratio is
shadowed/lit over every pixel the shadow map changes, exactly as the critic measured it.

| | 09:30 before | 09:30 after | 12:00 before | 12:00 after |
|---|---:|---:|---:|---:|
| pixels changed by shadowing | 57.8% | 55.9% | 21.2% | 22.5% |
| mean darkening (of 255) | 34.0 | **49.2** | 13.8 | **17.0** |
| shadowed/lit p50 | 0.611 | **0.464** | 0.884 | **0.854** |
| **stops, p50** | 0.71 | **1.11** | 0.18 | **0.23** |
| shadowed/lit p05 (umbra) | 0.341 | **0.172** | 0.388 | **0.259** |
| **stops, p05 (umbra)** | 1.55 | **2.54** | 1.37 | **1.95** |
| frame mean | 77.2 | 73.9 | 83.5 | 79.9 |
| % below lum 2 | 0.03 | 0.11 | 0.01 | 0.08 |

**The deep umbra is now 2.5 stops** — inside the 2-3 stops real asphalt gives — and the
frame mean barely moved, which was the point: this is a sun/ambient *ratio* change, not a
level change, so it does not fight the exposure meter.

Read the p50 with care. It is taken over every pixel the shadow map touches, so it is
dominated by **penumbra**, not umbra — which is why it lags the p05 and why halving
`bostonSunAngular` moves it at all. The p05 is the physically meaningful figure.

Street lamps, settled 40 frames at each hour (`Sigma` over every live `PointLight` +
`SpotLight`):

| tod | 03:00 | 06:00 | 09:00 | 12:00 | 15:00 | 18:00 | 19:00 | 19:30 | 20:00 | 22:00 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lamps on | 15 | **0** | **0** | **0** | **0** | **0** | 15 | 15 | 15 | 15 |
| Sigma intensity | 1026 | **0** | **0** | **0** | **0** | **0** | 195 | 989 | 1026 | 1026 |
| key intensity | 0.14 | 4.37 | 5.87 | 6.06 | 5.87 | 4.37 | 1.66 | 0.45 | 0.52 | 0.27 |
| casts shadows | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |

Was `15 / 1026` at **every** one of those hours. Forcing them back on at noon costs
**+1.84 mean frame luminance** (81.3 → 83.1) for light nobody can see. The bottom two rows
are the dusk/small-hours dead zone closed — there is now a shadow-casting key at every hour.

## What the shadow cascades actually re-submit — measured, not estimated

Claimed elsewhere: "the whole always-resident city is submitted to every cascade, and
`Buildings._buildShell`'s `castShadow = true` on 54 sector meshes is the largest remaining
perf lever." Half right. Analytic frustum test at `night_neon`, replicating three's own
`_frustum.intersectsObject` (a bounding-**sphere** test against each cascade's ortho box):

| cascade | refresh | radius | shell sectors in | shell tris | other casters in | other tris |
|---|---|---:|---:|---:|---:|---:|
| 0 | every frame | 32 m | 5 of 54 | 184,706 | 4 | 885,386 |
| 1 | every 2nd | 115 m | 5 of 54 | 184,706 | 4 | 885,386 |
| 2 | every 3rd | 466 m | 11 of 54 | 361,888 | 4 | 885,386 |

Amortised over the refresh intervals that is **~2.02 M triangles per frame** of shadow
submission against a reported 8.34 M for the whole frame. But the shell is only **~400 k of
it (20%)**. The other 1.6 M is **three unnamed LOD-0 chunk meshes** (345 k + 291 k + 227 k
tris, bounding spheres 103–129 m) which sit on top of the camera and must cast — they are
the only shadows at a range the player can resolve.

The real inefficiency is granularity, not the flag. A 600 m shell sector's bounding sphere
is **~430 m** in radius, while cascade 0's ortho box is only **64 m** wide (and `back + r`
deep along the sun). Five sectors therefore pass a test that their actual geometry would
fail almost everywhere. `CascadedShadows.shadowReach()` is published for whoever wants to
distance-gate, but note that distance gating removes only far sectors, and three's frustum
test already rejects most of those — the sectors that hurt are the *near* ones.

**Do not expect fps from turning the shell's `castShadow` off.** The prize is ~400 k tris a
frame, ~5% of what is submitted, in a project that has twice measured removing 1.55 M
triangles as making the frame *slower*. If it is done anyway, do it for correctness (a
52 cm shadow texel at 380 m is mush) and measure with `measureFps`, not by assumption.

## Weather's intensity-0 `DirectionalLight` is not dead — leave it alone

Reported twice now as "a dead `DirectionalLight` with intensity 0 consuming a
`NUM_DIR_LIGHTS` slot". It is `Weather.js`'s lightning `bolt` (`#d6e4ff`, at
`(300, 900, -300)` until a strike moves it), and `_strike()` drives it to
`amp * atten * 26`. It is deliberately always resident because toggling a light's
`visible` changes the light count and recompiles every material in the scene — which would
happen *during* a lightning flash.

It also does **not** disturb cascade indexing, which is the thing worth knowing.
`bostonCascadeWeight` keys off `UNROLLED_LOOP_INDEX`, i.e. the light's index in
`directionalLights[]`, so a stray directional light ahead of the cascades would mis-band
every one of them. Three's `WebGLLights.setup` sorts with
`shadowCastingAndTexturingLightsFirst` before assigning indices, and `Array.sort` is
stable, so the casting cascades always land at 0..n-1. Verified by reading the uploaded
`directionalLights[i].color` cache off a linked program: 0/1/2 carry the sun colour with
the 2048/2048/1536 maps in order and the bolt is index 3 with colour `(0,0,0)` — even
though it sits at `scene.children[5]`, ahead of the `csm` group at `[7]`. Confirmed a
second way by giving the three cascades red/green/blue and killing all ambient: the near
band is red, i.e. cascade 0.

## Geometry really is free here — one more datum
Hiding the **entire** `buildings` root at `hero_skyline` (1920×1080 `high`) removed 1.55 M
triangles and made the frame **slower**, not faster: 7–8 fps with buildings, **3.5–5 fps
without**. Less occlusion means more sky and ground reaching the post chain, and the post
chain is the cost. This is `PERF_REPORT.md` §6 reproduced from the other direction — do not
attribute an fps change to building geometry without an A/B like this one.

## What the `buildings` frame actually contains — measured at `st_beaconhill`

Counted analytically (three's own bounding-sphere-vs-frustum test replicated in JS), 1920x1080
`high`, camera `[-379.8, 5.2, -193.1]`, tod 16. These are structural facts, not timings, so
they are unaffected by the measurement problems below.

| | meshes in frustum | triangles in frustum |
|---|---:|---:|
| LOD-0/1 detail, opaque | 7 | **972,014** |
| LOD-0/1 detail, glass | 7 | 67,918 |
| LOD-2 shell (19 of 54 sectors) | 19 | 276,706 |

Per building: LOD 0 **3,003** tris (234 buildings inside 175 m), LOD 1 **741** (592 buildings
to 410 m), LOD 2 shell **79**. So the whole visible building set is ~1.32 M triangles in 33
draws — comfortably inside budget, which is why triangle count has never been the lever.

**The lever is per-fragment cost, and most of it is not owned by `buildings`.** The compiled
facade program at tod 16 declares `directionalLights[4]` (3 casting, each with the 16-tap
Poisson PCF from `CascadedShadows`), `pointLights[10]`, `spotLights[5]`, `hemisphereLights[1]`
and a `CUBEUV_MAX_MIP 8` IBL, on top of the facade's own 5 array/2D fetches and its derivative
tangent frame. Three unrolls those loops, so **every building fragment evaluates all fifteen
pooled point/spot BRDFs** — at a moment when `LightManager` has correctly driven every one of
them to **intensity 0** (verified live: Σ pooled intensity 0.0 at tod 16, matching the
"lamps off at noon" table above). Buildings cover most of a street-level frame, so buildings
pay most of that bill; but the pool size is `src/gfx/LightManager.js`'s, not
`src/world/Buildings.js`'s. *Owner: lighting, with render.* Note the standing warning: cutting
the pool changes `NUM_POINT_LIGHTS`/`NUM_SPOT_LIGHTS` and **recompiles every lit material**, so
it has to be a build-time decision, not a per-hour toggle.

### Frame timing was not obtainable during that pass — do not read a ms figure into it
Every instrument failed in the same way and for the same reason, and the failure is worth
recording because it will recur:

- All Boston tabs reported `document.hidden === true` for the entire session. The Browser
  pane was collapsed, so the page never composited and the engine's own rAF loop delivered
  **0 frames** (`engine.time.frame` did not advance across 244 rAF callbacks).
- `Profiler._sync()` — `gl.finish()` + a **1x1** `readPixels` — measured **311 ms** on its own
  in that state. Any `measureRender`/`measurePrefix` number taken then is that constant divided
  by the frame count: an empty scene "cost" 16–22 ms/frame at 16 frames.
- `EXT_disjoint_timer_query_webgl2` is present and returns results, but reported **257–395 ms
  per composed frame**, i.e. it was timing scheduler gaps, not work.
- Forcing compositing with a burst of screenshots does deliver rAF callbacks, but the gaps
  are 16.6 ms to 1023 ms on an unchanged frozen frame — a 60x spread.

**Conclusion: with the pane hidden there is no honest frame timing on this machine.** The
`measureFps` refusal is right and there is no way around it. What *is* still trustworthy while
hidden: draw/triangle counts, frustum tests, compiled shader source, uniform values, and
full-frame `readPixels` used for **image** comparison (~0.5 s each, and a same-build A/B has a
noise floor of 0.115/255 mean absolute on a 192x108 luminance grid).

## Debugging methodology — learned the hard way on issue #0
- **"The console is clean" is not the same as "the GL context is happy."** Driver-level
  `GL_INVALID_OPERATION` from `glDrawElements` arrives as a **`warn`**, not an `error`, so
  it never reaches `__boston.errors` and is easy to scroll past. Chrome then prints
  *"WebGL: too many errors, no more errors will be reported to the context"* and goes
  silent for the rest of the session. Always read console **warnings** when geometry that
  should be there isn't.
- A draw call that the driver rejects renders **nothing at all** — not black, not
  untextured. If geometry, transforms, bounds, attributes and material flags all check out
  and a plain material works, suspect the *program's* texture-unit state, not the mesh.
- **A `sampler` that three never uploads defaults to texture unit 0.** If any other sampler
  in the same program is a different type (`sampler2D` vs `sampler2DArray` vs `sampler3D`),
  WebGL kills the draw. Uniforms only reach a material through `onBeforeCompile`; if you
  shadow that property, you silently opt out of every prototype-level injector.
- **`material.needsUpdate = true` does NOT re-run `onBeforeCompile`.** Three caches the
  program per `(material, programCacheKey)`, so an unchanged key returns the old program
  without recompiling. Any bisect that swaps `onBeforeCompile` and sets `needsUpdate` is a
  **no-op** and proves nothing — this invalidated a whole earlier round of diagnosis. Vary
  `customProgramCacheKey` to force a real recompile.
- A `customProgramCacheKey` that returns a **constant** is not itself dangerous for program
  sharing (three appends it to a full parameter key), but it *does* freeze recompilation,
  and it makes two materials that differ only in chained-in GLSL share one program.
- **Never put a screen-space derivative — or a `texture()` that computes its own LOD — inside
  non-uniform control flow.** Both are *undefined* in GLSL ES 3.0 and this driver returns
  garbage rather than something plausible. Gating the facade's normal map on
  `if (dist < 140.0)` (a perfectly sensible saving: one atlas texel is far under a pixel by
  then) rendered **the entire near city as one flat colour**, while the distant shell stayed
  correct — because the shell is far and therefore fell *outside* the taken branch. The
  symptom looks nothing like a shader bug: no GL fault, no console error, `bootReport.failed`
  empty, and a frame that reads as "the atmosphere pass has lost its depth buffer". If a
  per-fragment cost has to come off the far geometry, do it with a **separate material whose
  block is compiled out with a `#define`**, so the control flow is uniform by construction.
- **A frame that is a smooth radial gradient is the lens vignette over a constant colour.**
  Contrast-stretch a downsampled luminance grid before concluding anything about a frame: at
  a 10-level ramp on raw 0–255 a scene with a 120–150 range and a broken scene with a
  120–150 range look identical.

## Corrections to docs/PERF_REPORT.md — believe these over the report
The report is broadly excellent but three of its specifics were later disproved by
direct measurement. Do not act on the originals.

| Report claim | Correction |
|---|---|
| §5: "~16.5 ms is `lightGlows`" at night | **Does not exist.** Derived by hiding the whole `lights` subtree, which also hides 15 pooled Point/SpotLights — `projectObject` returns early on `visible === false` *before* pushing a light, so the toggle silently changes the light count and recompiles every lit material (`renderer.info.programs` 61 → 81). Measured per-mesh instead: `lightGlows` **3.63 ms**, `lightPools` **2.75 ms**. |
| §4: cloud RT is 326x184 due to a stale canvas width | **Not a bug.** 326x184 is exactly `round(1920 x 0.17)`; `QUALITY.high.scale` is **0.17** (0.24 is `ultra`). The report assumed 0.25 from a class docstring. |
| §7 / issue #1: low cameras collapse to black = post-processing feedback loop | **Mostly the camera being underground.** `street_level` was parked 1.4 m below the road surface. Fixed in `9ed0f06`. A genuine `LensPass` GL fault does also exist, but it is a separate and smaller effect. |

**General lesson, now twice-proven:** never A/B a subsystem by toggling `visible` on a
group that also contains lights. It changes shader permutations, not just what is drawn.

## Performance methodology (read `PERF_REPORT.md` §0 in full before profiling)
**The headline: this is a fill-rate problem in post-processing, not a geometry problem.**
The entire scene render — every building, road, tree and prop — is ~4.8 ms of a ~48 ms
frame. Draws and triangles are inside budget at every shot and preset.
**Do not reduce building/road/prop/vegetation triangle counts. Do not rewrite the clouds.**

Trustworthy instruments: `__boston.measureFps()`, `Profiler.prefixCost()`.
Garbage instruments here: `engine.perf`/DevOverlay fps (CPU-only), disabling composer
passes (rewires ping-pong buffers), GPU-sync bracketing inside a pass (tile flush).

**The one geometry exception: `VehicleVisual` does not obey the "geometry is free" rule.**
An articulated car is ~19 separate meshes at LOD0, each with `frustumCulled = false`
(`VehicleModels` culls the parent `Group`, and **three does not frustum-cull Groups**), and
most of them cast into three shadow cascades. Sixteen of them measured **+600 draw calls
and +1.27M triangles** — more than the entire rest of the city, which was 335 draws and
2.2M triangles at the same moment. Anything that hands out `VehicleVisual`s in bulk must
cap them hard, deny them to cars behind the camera, and put everything else in an instanced
shell. `Traffic.js` now allows 3 at LOD0 / 10 total and cost drops to ~160 draws.

**Verifying anything while other agents are editing.** Vite full-reloads the page on every
save, which wipes `window.engine` mid-measurement and makes an `async` test script vanish.
`npx vite build && npx vite preview --port 5299 --outDir dist` gives a target that does not
move. Also: `measureFps()` correctly refuses when the tab is backgrounded, and a browser
tool call that is not a screenshot will not front it — re-front before every measurement or
you will collect a page of `hidden: true`.

## Next priorities — **ARCHIVED, DO NOT WORK THIS LIST**

> This is a **pre-2026-08-30 performance backlog**, retained only as history. Its
> figures are void (`docs/PERF_REPORT.md` is banner-marked SUPERSEDED), several items
> are already implemented in the tree, and at least one is disproved elsewhere in this
> same file. **The live priority list is `AI_HANDOFF.md` §9.**
| # | Action | Est. gain | File |
|---|---|---|---|
| 1 | `PRESETS.high.pixelRatioCap` 1.5 → 1.25 or 1.0 — on a DPR-2 display `high` renders 2.26× the pixels the budget is written against | **18–36 ms** | `src/core/Settings.js` |
| 2 | Fix resize so `pixelRatioCap` actually applies: call `renderer.setSize(w,h,false)` after `setPixelRatio` (`EffectComposer.setSize` skips it when CSS size is unchanged) | unblocks #1 | `src/gfx/RenderPipeline.js` ~146 |
| 3 | ~~Let `glowMesh` frustum-cull; lower/clamp `uMinPx`~~ **Done, but the 10–16 ms was never there** — see the correction below the table. Measured cost of the additive proxies at `night_neon`/`high`/1080p: `lightGlows` **3.6 ms**, `lightPools` **2.7 ms** | ~1–2 ms | `src/gfx/LightManager.js` |
| 4 | ~~Fix the black atmosphere pass, then re-check its render-target sizing~~ **Done.** Clouds, aerial perspective and the night sky all render; the pass survives `render.validate()` (`ok: true`, frame mean 17.58 → 19.39 across it). **The 326×184 sizing was never a bug** — see the note below the table | — | `src/gfx/Clouds.js`, `Fog.js` |
| 5 | Merge the final two `EffectPass`es / drop sharpen taps when TAA is off | up to 25 ms, unproven | `RenderPipeline._rebuild` |
| 6 | ~~Build Traffic, Pedestrians, Player~~ **Done.** All four systems (`traffic`, `peds`, `player`, `cameraRig`) are live. A/B at 1080p/`high` on the verify server: **7.3 → 6.9 fps**, +281 draws, +1.03M tris for the whole AI layer. **Pedestrians are effectively free** (2 draws, 76k tris, ~0.6 ms CPU); ~95% of the cost is traffic. Traffic is the first thing to trim if the triangle budget gets tight — lower `MAX_DETAIL`/`SHELL_SHADOW_CAP` in `Traffic.js` | the "density & life" rubric axis | `src/ai/`, `src/gameplay/` |
| 7 | Surface `measureFps` in the DevOverlay instead of `engine.perf` | stops future misdiagnosis | `src/ui/DevOverlay.js` |
| 8 | **`Settings.PRESETS.high` should declare `shadowCascades: 3, shadowMap: 2048`.** It asks for 4 @ 3072; `Lighting._cascadeCount`/`_shadowMapSize` deliberately cap it at 3 @ 2048 and that cap is correct — 4 @ 3072 is 26.5 M shadow texels against today's 10.8 M *plus* a fourth full geometry pass, on a frame that is far under its fps budget. Reconcile by fixing the **declaration**, not the runtime. `lighting.debug().csm` and the `[lighting]` boot line both print what actually runs | correctness | `src/core/Settings.js` |
| 9 | Shadow penumbra is now `bostonSunAngular = 0.0047`, the sun's real angular radius, having been 2x that "for softness". If shadow edges ever need to be softer, open `WEATHER[].soft` for the cloudy states — do **not** re-inflate the clear-sky figure; it costs shadow depth (median shadow depth measured 0.98 stops at 0.0093, 1.04 at 0.0062, 1.10 at 0.0047) | — | `src/gfx/Lighting.js` |

**Correction to `PERF_REPORT.md` §5 — "~16.5 ms is `lightGlows`" is an artefact of the
toggle, not a measurement of overdraw.** §5 derives the figure by subtracting `lightPools`
(2.6 ms) from "hide the whole `lights` subtree" (19.1 ms). But `LightManager`'s `lights`
group also holds the **fixed pool of 10 `PointLight`s and 5 `SpotLight`s**, and
`WebGLRenderer.projectObject` returns early on `visible === false` *before* it pushes a
light — so hiding the group silently changes `NUM_POINT_LIGHTS`/`NUM_SPOT_LIGHTS` and
recompiles every lit material in the scene. Verified: `renderer.info.programs.length` goes
**61 → 81** on that single toggle. The subtraction is therefore comparing two different
shader worlds.

Toggling each proxy mesh on its own — which changes no light count and recompiles nothing —
against a 97.1 ms `night_neon` frame (alternating A/B, median of 6 × 3 s `measureFps`,
1920×1080 `high`): `lightGlows` **3.63 ms**, `lightPools` **2.75 ms**. Real, worth having,
but an order of magnitude short of the estimate. The per-fragment cost of the 15 pooled
lights is the more interesting number and is still unmeasured — every attempt landed in a
window where sibling agent tabs had the GPU at 2–4 fps.

**Correction to `PERF_REPORT.md` §4 — the atmosphere render targets are the right size.**
326×184 is exactly `round(1920 × 0.17)` × `round(1080 × 0.17)`. The report expected 480×270
because it assumed a 0.25 scale from the class docstring, but `QUALITY.high.scale` in
`Clouds.js` is **0.17**; `ultra` is the 0.24 tier. Verified live: drawing buffer 1920×1080
→ 326×184, and at a 1282×800 buffer the same targets come out 218×136, so `setSize` does
track the buffer. `applyQuality` now reads `renderer.getDrawingBufferSize()` instead of
`domElement.width` anyway, so it can no longer capture a stale canvas size at init.

**Resolution ladder — verified working, and the earlier "`getPixelRatio()` reads 1 at every
preset" was the preset table, not the pipeline.** `_applyResolution` derives the ratio from
`min(devicePixelRatio, settings.pixelRatioCap, sqrt(budgetPixels / cssPixels))` and then
calls `renderer.setSize(w, h, true)` explicitly, because `EffectComposer.setSize` skips
`renderer.setSize` when the CSS size is unchanged. Measured in a 1280×720 CSS window after
the preset ladder was corrected to 1.0 / 1.25 / 1.5 / 2.0:

| preset | cap | `getPixelRatio()` | drawing buffer | `composer.inputBuffer` | passes |
|---|---:|---:|---|---|---:|
| low | 1.0 | 1.00 | 1280×720 | 1280×720 | 8 |
| medium | 1.25 | 1.25 | 1600×900 | 1600×900 | 9 |
| high | 1.5 | 1.50 | **1920×1080** | 1920×1080 | 10 |
| ultra | 2.0 | 2.00 | 2560×1440 | 2560×1440 | 13 |

The ratio, the canvas and every composer buffer all track the cap. While `high` was
capped at 1.0 every preset produced ratio 1.0 by construction, which is what made it look
like the cap never reached the buffer.

**Per-pass timing is currently unobtainable, not merely noisy.** Three back-to-back
`prefixCost({frames:6, repeats:4})` runs on one frozen frame returned `fullChainMs`
34.5 / 43.8 / 52.2 and three *mutually contradictory* rankings — run 1 said `TAAPass`
40.6 ms and `N8AO` 1.7; run 3 said `N8AO` 21.1 and `TAAPass` 21.0 with `AutoExposurePass`
at 10.8 ms, which is impossible (it renders a 128² and a 1×1). `measureFps(2)` on the same
locked scene returned 15.8 / 5.4 / 3.5 fps. Real GPU timer queries *are* available here
(`EXT_disjoint_timer_query_webgl2`, `gpuTimer.available === true`) but every pass reported
a ~9 ms floor, i.e. the begin/end pair was catching queued work from other tabs. **Do not
publish a per-stage millisecond table taken while sibling agent tabs are rendering** —
wait for a quiet machine, and prefer `gpuProfile(true)` + `gpuTimings()` over `prefixCost`
now that the timer extension is present.

**Another instrument that lies here: fps measured while other agents are rendering.**
Several agents run their own full-resolution instances in sibling browser tabs. Five
back-to-back `measureFps(2)` calls on an unchanged scene returned 19.9 / 9.8 / 10.3 / 8.3 /
5.4, and prefix timing returned *negative* per-pass costs. Skipping the cloud march
entirely (`clouds.skip = true`) measured **slower** than running it. Do not quote an fps
number without first confirming no other Boston tab is live.

## Building modelling pass — 2026-09-06 (`4802b01` … `a1b17e1`)

Five modelling commits behind one piece of infrastructure. Every one verified in
`tools/model-lab/` (see CONTRACTS.md, "Building modelling"); NONE verified in the
integrated runtime, because the Browser pane kept recycling the Boston tab. That
gate is **deferred, not passed** — see below.

| # | change | population | LOD 0 tris/bldg | LOD 1 tris/bldg |
|---|--------|-----------|-----------------|-----------------|
| `4802b01` | Model Lab | — | 2648 | 625 |
| `4061b58` | secondary elevations carry the shell's facade strip | all 10,048 | 2648 | 625 |
| `24ffe84` | `insetPoly` is a true edge offset | all | 2638 | 623 |
| `b9150eb` | mansard dormers survive to LOD 1 | 2,686 | 2638 | 631 |
| `e6b6003` | corner buildings address both streets | 464 | 2724 | 659 |
| `a1b17e1` | setback towers have a street elevation all the way up | 133 | 2748 | 686 |

Net cost: **+3.8% triangles at LOD 0, +9.8% at LOD 1, shell unchanged.** The
first change cost literally nothing — it swaps which atlas layer a quad samples.

What each fixed, in one line:

- **Blank secondary elevations.** `partyWall` painted raw wall surface on every
  cheap path, so a 181 m glass tower at LOD 1 — from 175 m away, most of
  downtown most of the time — was a plain white slab. `buildShell` already drew
  correctly-scaled window rows in two triangles a face; the cheap tiers now
  sample the same strip. Glass tower detail +183%, stone tower +38%.
- **`insetPoly` was a radial scale, not an offset**, so on Boston's long thin
  parcels the long sides got 31-43% of the inset asked for. Setbacks barely
  stepped in, the 1920s crown came out as four near-identical stacked slabs, and
  the shell's 0.25 m z-fight guard was really 0.078 m.
- **Mansard dormers** are the whole roofline of 27% of the city and were dropped
  at 175 m.
- **Corner buildings**: 460 buildings had two or more street-exposed edges and
  every single one received exactly one front. Now 3.
- **Setback towers** put ~47% of their height, all four faces, into `partyWall`.

### Integrated-runtime verification — PASSED at the end of the pass

The first attempt, at `24ffe84`, died the usual way: `performance.now()` reset
25 s -> 10 s, the tab recycled mid-boot. The attempt at the batch boundary
succeeded.

    22 systems loaded, 0 failed, 0 errors, 0 GL faults
    only `Missions.js` missing (pre-existing, unrelated)
    street level, Tremont Street: 60 fps, 302 draws, 1.66M triangles, quality high

The city rendered correctly with all five changes in it and no visual
corruption. Note the boot took under 20 s from `npm run build:pages`, not the
~4 minutes this project has been assuming -- that figure appears to come from a
cold dev server doing on-demand transforms, not from a production build. If you
need the runtime, build first and preview; do not fight the dev server.

The tab still recycles roughly every 30-90 s once running, so a long
interactive session is not yet possible; but a booted instance now lasts long
enough to query and photograph, which is all a verification gate needs. Write
each probe self-contained and tolerant of a reset `performance.now()`.

One datum on the cause. The Model Lab tab survived an entire session across
dozens of reloads while the Boston tab died repeatedly, and the lab's
distinguishing property is that it never blocks the main thread for more than a
few hundred ms. That points at an unresponsiveness watchdog rather than a timer,
which would mean the fix is to make Boston's boot yield — not to wait longer.
Untested.

**Still worth a proper look before deploying.** The changes are geometric and
population-wide, and one street-level frame plus a clean boot is a smoke test,
not an art-direction review.

### Next modelling priorities (ranked, after this pass)

1. Curtain-wall towers below 26 m only — `curtainStorey` at `lod === 0 &&
   y0 - spec.base < 26` is the same class of bug the setback fix just closed,
   on the 154 curtain-wall buildings.
2. Tower crowns and tops generally: every tower still ends in a flat parapet,
   and real Boston tops are distinctive.
3. Roof clutter at LOD 1 — water tanks, dishes and fan cowls are LOD-0 only;
   check whether any of them survive screen space at 175-410 m.
4. Vehicle silhouettes at LOD 1/2 — pillars, rails and wipers are dropped and
   LOD 2 collapses every material to `trim`. Not yet examined in the lab.
5. Street furniture repetition — signals, poles, hydrants, bins, benches.
6. `_clipParcel` emits one non-convex/sliver footprint per ~3,350 (e.g. #7074,
   a 5-gon with a 0.67 m edge). Cosmetically harmless so far; a correctness
   nuisance for any half-plane test.
7. Vegetation.
8. Landmark detail.
9. LOD shape continuity — silhouette pops between tiers, now that LOD 1 and the
   shell agree on facade texture.
10. Ground-floor/pavement interface: stoops and areaways project up to 2.8 m
    onto the footway by design; confirm that still reads correctly.

## Vehicle + street-world pass — 2026-09-06 (`c0d91e4` … `a78a3cd`)

Six source commits behind two infrastructure ones. Both families audited before
being touched; in both, the MODELS turned out to be sound and every real defect
was a rule about ownership, data or placement — the same shape as the building
pass before it.

| commit | change | effect |
|---|---|---|
| `c0d91e4` | Model Lab grows a vehicle bench | 9 vehicle scenes join the standing grid |
| `1d64e7d` | nose/tail caps are body colour, not underbody black | 11% of a sedan's frontal area, 0 triangles |
| `fff5afb` | vehicle close views scale with the vehicle | a bus is now framed, not a white wall |
| `ca18850` | street corners get corner furniture | junction 48 → 63 objects, 23 → 27 types |
| `5a8f813` | bus shelters are a spacing, not one per segment | 27 → 126, one per 360 m of arterial |
| `ee20d7d` | construction hoarding and scaffold were never placed | 0 → 204 and 0 → 67 |
| `45fe5b7` | ONE WAY arrows follow the street's direction | 46% of them pointed the wrong way |
| `a78a3cd` | DO NOT ENTER at one-way exits | 0 → 117, all facing the wrong-way driver |

### What was audited and found sound

- **Vehicle proportions**, all nine classes, against real dimensions.
- **The vehicle LOD ladder.** 32 m and 115 m switches; a 91% triangle drop costs
  6% of gradient energy.
- **Parked-car LOD.** `splitNear` already does per-instance selection for the
  near tier, so a car 3 m away is never drawn from a chunk-level decision.
- **Traffic signals, lamps, hydrants, meters, bins** as models.
- **Bus wheel arches.** `by = max(floorY, hub + sqrt(r² - dz²))` cuts a real
  0.695 m arch; the "no arches" reading was wrong.
- **Decal `crosswalk`/`stopBar`/`arrow`/`paintFaded` at zero.** Correct: road
  markings are coplanar geometry in `Roads.js`, and the decal path is a
  `paintOK` fallback for a city that has none.

### Production gate

Passed at the end of the pass with the corrected criteria (see CONTRACTS.md,
"The production boot gate"): 26 active systems, 22 optional loaded, `Missions.js`
missing as always, `failed []`, `errors []`, `glFaults []`, `validate().ok true`,
Rapier live with 15,996 colliders and 56 bodies, 150 traffic cars, 99 prop
batches. Boot took under 20 s and the tab survived 90 s.

Gameplay smoke only, not a re-proof: parked-car colliders present at ~16k,
traffic populated, physics live. Nothing in this pass touches collision,
traversal or the camera.

### Next modelling priorities

1. `density` applied twice in `populate` — inert at `high`, costs a cap-bound
   type 30% at `medium`. One line, but it changes every non-`high` preset.
2. Street lamps at 22/km, one per 45 m. Sparse against a real 25-35 m, but
   adding them adds `_lampSites` and light slots — owner-frozen territory.
3. Curtain-wall towers detailed below 26 m only (154 buildings) — the same class
   of bug the setback fix closed last pass.
4. Tower crowns and tops: every tower still ends in a flat parapet.
5. Vehicle nose/tail cap is a flat vertical disc; a real bumper is rounded in
   plan and section. Would mean adding a station ahead of the front key on each
   of the nine body types.
6. Bus side glazing is 3-4 large panes; a real transit bus has 8-10 bays.
7. Roof clutter at LOD 1 — water tanks, dishes, fan cowls are LOD-0 only.
8. Mid-block furniture spacing: hydrants every 70-130 m on one random side.
9. Vegetation — not yet audited at all.
10. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.

## World-density + vegetation pass — 2026-09-06 (`7439236` … `6556971`)

Seven commits, all rules and data rather than geometry — the fourth consecutive
pass where that is true. Nothing here adds an asset; the assets were fine.

| commit | change | effect |
|---|---|---|
| `7439236` | quality density applied once, not twice | medium +16.7%, low +71.3%, `high` bit-identical |
| `3f74be4` | street-tree budget is a stride, not a prefix | trees reach 3378 m instead of stopping at 2325 |
| `01a96a1` | tree sites follow the road, not the chord | 803 → 53 in carriageway, 784 → 0 in buildings |
| `857e5ff` | all 27 kerbside placements follow the road | segment-placed families now ~0% in the road |
| `dbfb926` | junction corners clear both carriageways | ped signals 682/696 → 132/696 |
| `0a3a73c` | junction legs use the leaving tangent | 444 → 403 (small; hypothesis was mostly wrong) |
| `6556971` | no street trees on a bridge | floaters 104 → 5, p99 9.93 m → 0.13 m |

### Headline

Every kerbside prop in Boston was positioned by chord arithmetic on segments
that are chords of curved roads. On a quarter of the network by length the drift
exceeded the road's own half-width. This is why pavements looked wrong: not too
few objects, but objects in the road, inside façades, and beside the wrong
kerb. See CONTRACTS.md, "Kerbside placement".

### Audited and found sound — do not re-derive

- **Mid-block furniture density.** Mean props within 12 m of a mid-block kerb
  point: Beacon Hill 5.6, North End 4.2, Back Bay 4.1, Financial 2.3. Only
  0-10% of sampled mid-block points have nothing within 12 m. Sidewalks are not
  empty between intersections.
- **Street-tree spacing rules.** District-aware and already realistic.
- **Vegetation density scaling.** Linear and single, unlike props/decals.
- **Tree species palette and per-instance variation.**
- **The default preset.** `high`, hardcoded, no auto-downgrade, density 1.0.

### Production gate

Passed twice during the pass and at the boundary: 26 active systems (4 core + 22
optional), `Missions.js` missing as always, `failed []`, `errors []`,
`glFaults []`, `validate().ok true`, Rapier live with 16,042 colliders and 56
bodies, 150 traffic cars, 157,879 props in 99 batches, 56,224 vegetation
instances. Gameplay smoke only; nothing here touches collision, traversal or the
camera.

### Remaining top 10

1. Junction-box overlap: 403 junction props still inside some carriageway at
   five- and six-way nodes, where several road surfaces genuinely overlap.
2. Five trees still floating (worst 6.68 m) and one buried.
3. Only 2 park areas exist (`L.parks`) — the Common and the Public Garden. The
   Esplanade, the Fens and Franklin Park are absent, so park planting is
   confined to two polygons.
4. 16 tree meshes for 6,750 instances; variants are two fixed heights per
   species. Cheap wins available in crown aspect and branch orientation.
5. Street lamps at 22/km, one per 45 m against a real 25-35 m. Physical model
   only — do not reopen light-slot allocation.
6. Curtain-wall towers detailed below 26 m only (154 buildings).
7. Tower crowns: every tower still ends in a flat parapet.
8. LOD 1 roof clutter — water tanks, dishes, fan cowls are LOD-0 only.
9. Vehicle bumper rounding; bus glazing bay rhythm.
10. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.

## Parks + green-space pass — 2026-09-06 (`988b0cb` … `8748a92`)

Three commits. The reported "only two parks" was real, and the cause was the
same ownership pattern as the last three passes: the data existed, was already
rendered by another system, and Props kept a private copy.

| commit | change | effect |
|---|---|---|
| `988b0cb` | parks come from `city.parks`, not a 2-entry private copy | 2 → 19 parks, 376 street trees out of parks |
| `ec9a1a1` | park content scales with park area and shape | furniture/ha spread 165x → 3.2x |
| `8748a92` | nothing is planted in the water | trees in water 105 → 13 |

    L.parks             2 -> 19        L.parkAreas       2 -> 18
    park area known   43.4% -> 100%    street trees in park  376 -> 0
    park trees          732 -> ~2000   vegetation     56,224 -> 76,081
    park benches        139 -> 775     park lamps        271 -> 657
    props           157,879 -> 158,785 prop batches       99 -> 99

### Vegetation count reconciliation (previous batch)

Both figures were right; they are different points in the batch.

    5,200 street + 732 park                              = 5,932   baseline
    + 1,191 pits the stride fix filled                   = 7,123   intermediate
    +    49 sites recovered by correct in-park testing    (kerbPoint)
    -   422 sites withdrawn from bridges                 = 6,750   final
    (6,018 street + 732 park = 6,750)

No source changed to make them agree; the arithmetic already did.

### Audited and found sound / closed

- **Junction-in-carriageway metric — CLOSED.** 96.4% of the 413 are legitimate
  junction-box overlap; only 15 are genuinely wrong. Do not target zero.
- **Park grounding.** Trees p50/p95/p99 all 0.00, none floating. Furniture p50
  0.00, p99 0.15, max 1.06.
- **Dead green content.** None. The 61-entry furniture library has no path,
  railing, fence, fountain or monument asset, so there was nothing dormant to
  activate — and nothing was invented.
- **Understorey scaling.** Grass draws its count from bbox area then rejects to
  the polygon, so its accepted total is already polygon-proportional.

### Remaining top 10 world-coverage priorities

1. **Street-graph coverage — OWNER DECISION.** Cambridge is 93% open at 0.8
   roadKm/km2 against Back Bay's 20.9; Charlestown 87%, Fenway 76%, Seaport 71%.
   Buildings follow parcels follow roads, so no amount of vegetation or prop work
   reaches them. Extending it means authoring real street geometry — content
   scope, not an autonomous call.
2. Park paths, edges and railings: no such asset exists, so parks are lawn +
   trees + furniture with no circulation language.
3. 13 trees and 27 junction props still over water at polygon boundaries.
4. 16 tree meshes for ~8,000 instances; measure adjacent-repeat visibility first.
5. Street lamps 22/km (physical model only; light pool is fixed at 20).
6. Curtain-wall towers detailed below 26 m only.
7. Tower crowns: every tower ends in a flat parapet.
8. LOD 1 roof clutter.
9. Vehicle bumper rounding; bus glazing bays.
10. `_clipParcel`'s one non-convex/sliver footprint per ~3,350.

## Park circulation + public realm — 2026-09-06 (`20e9bf3` … `4b7b966`)

Five commits. Parks had polygons, grass, trees and furniture and no
circulation at all; they now have walks, gates, a riverside promenade and
furniture that belongs to them. The fifth commit is the one that matters most
outside the parks.

| commit | change | effect |
|---|---|---|
| `20e9bf3` | parks get the walks that make them parks | 0 → 79 runs, 10,964 m |
| `b12b47f` | furniture belongs to the circulation | p50 1.84 m from a walk, 96.9% of benches face it |
| `15ca360` | the waterfront gets its walk | Esplanade 1,466 m promenade, lagoon 603 m |
| `5be68a2` | furniture keeps out of its own way | pairs under 1 m: 234 → 13 |
| `4b7b966` | street trees excluded by surface, not ring | 5,633 → 6,069 (+436) |

### Headline

`boston-geo.js` has claimed since it was written that `kind: 'formal'` "adds
paths and beds". No such code existed, and a search of the whole world pipeline
for path/walkway/promenade/footway/circulation semantics found nothing dormant
to switch on — the first time in five passes that the answer was genuinely "the
content is not here". So the circulation is procedural and Boston-inspired, but
every line of it is derived from authored geometry: the polygon decides the
topology, the `kind` decides the character, the street graph decides the gates,
and the water rings and carriageways clip it. See CONTRACTS.md.

Two measurements changed the design and are worth keeping:

- **The lawn is not the ground.** It floats up to 0.66 m over a rise, and a
  path on `groundHeight` would be buried in grass for 45% of its length.
- **An authored ring is not the park's edge.** 152 of the Common's 254
  boundary samples are within 0.5 m of a road centreline. That broke gate
  direction on 60% of the Common, and it had been stripping street trees off
  the pavement of every park-perimeter street in Boston.

### Numbers

    park walks             0 -> 83 runs, 13,101 m, 6.5% of park area
    park entrances         0 -> 34, derived from the street graph
    Esplanade promenade    1,466 m, 9.5-15.0 m from the Charles
    Public Garden lagoon     603 m, 5.6-5.9 m from the water
    street trees       5,633 -> 6,069        park trees        2,223
    vegetation        73,946 -> 74,310       props     158,785 -> 159,443
    park path meshes        +2 draws, 8,736 tris, 0 new materials/textures
    city build              +174 ms generation, +38 ms lawn sampling

Validated headlessly over 13,180 path samples: 0 boundary escapes, 0 in water,
0 on a carriageway, 0 inside a parcel footprint, min edge clearance 1.21 m.
0 park trees stand on a walk.

**Correction.** `15ca360`'s message quotes park-walk coverage as 7.1% -> 8.7%
of park area. That came from averaging the per-park percentages, and the
sampler drew a fixed 4,000 attempts per park regardless of size, so eight 0.4 ha
Comm Ave Mall blocks at 12% each outvoted a 25.8 ha Common at 4.9%. The
AREA-WEIGHTED figure is 4.7% -> 6.5%, and that is the one to quote. The
per-park numbers in that commit are unaffected and correct.

Per park, walk as a share of area: Comm Ave Mall blocks 11.6-12.4%, Esplanade
13.6% (a central spine AND a riverside promenade, which is what it has),
Post Office Square 10.5%, Columbus 7.5%, Public Garden 6.8%, Greenway 5.3%,
Boston Common 4.9%, Bunker Hill 4.7%, Back Bay Fens 3.4%, plazas 0%.

### Audited and found sound — do not re-derive

- **Tree repetition. CLOSED.** Visible clones are 0.14-0.36% of adjacent
  pairs. See CONTRACTS.md.
- **The park/pavement seam.** A material seam, not a gap: p50 and p75 of the
  distance from the back of the footway to the first lawn triangle are both
  0.0 m. No bare band around any park.
- **Park edge language.** The 61-entry furniture library has no fence, railing,
  gate or monument. Gates get a bollard pair; nothing else was invented.
- **Furniture inside park trees.** p50 8.12 m to the nearest tree, 21 of 2,159
  within 1 m — a bench under a tree, not inside one.
- **Curtain-wall coverage and mechanical penthouses.** `partyWall` already
  runs `curtainStorey` on all four elevations at LOD 0 and `stripWall` above;
  `glassTower`, `seaport` and `midrise` all carry `mech: true` and get a
  penthouse over 40 m. The old "detailed below 26 m only" item is closed.

### Production gate

Passed at every source commit and at the boundary: 26 active systems (4 core +
22 optional), `Missions.js` missing as always, `failed []`, `errors []`,
`glFaults []`, `validate().ok true`, 99 prop batches, 535 draws and 2.21M
triangles on the downtown shot. `npm run build:pages` clean.

### Three stale entries retired from the standing top 10

Each was carried forward across several passes and each is measurably false
now. Verified before writing them off, not assumed:

- **"LOD 1 roof clutter — LOD-0 only."** `flatRoof` calls `roofClutter` at
  `lod < 2`, and `buildShell` carries a matching version keyed identically. All
  three tiers have it.
- **"Curtain-wall towers detailed below 26 m only (154 buildings)."**
  `partyWall` runs `curtainStorey` on all four elevations at LOD 0 and
  `stripWall` above. Closed by the facade pass.
- **"Street lamps 22/km against a real 25-35 m."** Measured: **30.1 lamps/km**
  over 81.6 km of public street, and from any point on a street the nearest
  lamp is p50 14.3 m, p90 25.1 m. That is the real-world target, already met.

### Remaining top 10

1. **Street-graph coverage — OWNER DEFERRED.** Recorded in CONTRACTS.md; do
   not re-audit it each loop.
2. Tower crowns: 154 glass towers and 241 tall midrises end in a flat parapet
   plus a mechanical penthouse. `stoneTower` alone has setbacks and a stepped
   crown (79 of 136). Plain rather than wrong — this is an ART decision about
   what a crown should be, not a defect to repair.
3. Park walks are one flat ribbon: no kerb upstand, no granite edging, no
   junction paving. Would need a third path material family.
4. Vehicle bumper rounding; bus glazing bay rhythm.
5. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.
6. 58 street-tree sites inside a carriageway — junction-box class, the same
   96.4%-legitimate metric closed two passes ago.
7. 13 trees and 27 junction props over water at polygon boundaries.
8. Park hedge density is still floor-bound in the smallest parks: 15/ha in the
   Common against 151/ha in a 0.4 ha Comm Ave Mall block.
9. The Public Garden's axial walks dead-end at the lagoon on both sides. That
   is correct — no bridge is authored — but a real park would route around.
10. Park furniture cannot see park TREES: Props builds its layout before
    Vegetation plants. 21 of 2,159 items sit within 1 m of a trunk, which is a
    bench under a tree rather than in one, so this is cosmetic today.

## Park surface + edge detail — 2026-09-06 (`8d3cacb` … `1a8cb7c`)

Three commits, then a fresh whole-world audit that came back clean.

| commit | change | effect |
|---|---|---|
| `8d3cacb` | park walks get a granite kerb | 22,688 m of kerb for 7,240 tris |
| `fa96e92` | a gate that leads nowhere is not an entrance | spurs 11 → 25 |
| `1a8cb7c` | a connector that connects nothing is not a path | 7 orphan stubs removed |

### Headline

The question was whether the new walks read as physical public realm or as
flat coloured strips laid on grass. At eye level they were strips: a hard seam,
a value step, no thickness. They now sit in the lawn behind a granite kerb.

The previous pass stopped here believing a third path material family was
needed. It was not. `granite` was already registered and already used by
Landmarks and `stoneTower` trim — the inventory was the whole of the work, and
the cost is one texture set and one draw call.

Two other things were bugs of the same shape as the pass before:

- **`MIN_RUN = 18 m` was applied to spurs.** Right for a clipped fragment of a
  long walk, exactly wrong for a connector whose job is to be short. Every spur
  under 18 m was generated and thrown away, leaving 8 of 35 gates as a bollard
  pair on grass with nothing behind them — one of them 67.6 m from any path.
- **Connectors outliving what they connect.** Where a cross street clipped a
  ribbon's spine, the `cross` link at that point survived alone as a 12-54 m
  stub from grass to grass.

### Numbers

    kerb run           22,688 m over 11,344 m of centreline (86.6% of walks)
    kerb triangles      7,240   = 0.32 per metre of kerb (decimated;
                                  a flat 3 m span rate would be 1.33)
    park path meshes    8,736 -> 16,012 tris, +1 draw, +3 textures (granite)
    spur runs              11 -> 25       cross links     25 -> 22
    gates over 8 m from a walk   8 -> 2   over 15 m        3 -> 1
    gate to nearest walk   p50 1.3 m, p75 1.9 m, p90 2.2 m
    runs                   83 -> 92       walks   13,101 -> 13,041 m
    isolated connectors     7 -> 0

Validated on the emitted kerb geometry, all 5,772 vertices: 0 outside a park
(min 0.91 m in), **0 in water** (min 2.87 m — the lagoon control holds), 0 on a
carriageway (min 0.21 m), 0 degenerate triangles, no spikes. Checked in
daylight, dusk, night and rain.

### Fresh whole-world audit — nothing high-impact and safe remains

Ten views plus five measured audits. Every thread resolved to "already correct"
or "measurement artefact"; details and the traps are in CONTRACTS.md. In short:
bridge prop grounding is fully explained (47 of 47), road decal density is
1,097/km with a 1,010-1,255 district spread, tree scale is correct with all 334
trees over 30 m inside parks, path junctions need no hardscape, and `payStation`
at 18 is a shared-budget artefact rather than dead content.

### Remaining top 10 SAFE priorities

1. Park walk width hierarchy: the Esplanade promenade uses the same 3.4 m as an
   inland diagonal. Tuning, with no measured defect behind it.
2. Park hedge density is floor-bound in the smallest parks — 15/ha in the
   Common against 151/ha in a 0.4 ha Comm Ave Mall block. The mall blocks look
   right, so the metric may be the thing that is wrong.
3. The Public Garden's axial walks stop at the lagoon on both sides. Correct —
   no bridge is authored — but a real park would route around.
4. Park furniture cannot see park TREES: Props builds its layout before
   Vegetation plants. 21 of 2,159 items sit within 1 m of a trunk. Cosmetic.
5. Vehicle bumper rounding; bus glazing bay rhythm.
6. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.
7. 58 street-tree sites inside a carriageway — junction-box class, closed metric.
8. 13 trees and 27 junction props over water at polygon boundaries.
9. `payStation` shares the `meter` budget key, so ~9% of metered street faces
   draw a pay station, lose the roll, and end up with no kerbside equipment.
10. Mid-distance LOD 2 shells read flatter than the LOD 1 tier around them.

### Owner-deferred, unchanged

- **Street-graph expansion** (Cambridge / Charlestown / Fenway / Seaport).
- **Tower crown art direction.** Re-checked this pass for objective breakage —
  floating geometry, missing caps, holes, LOD dropout — and found none. Glass
  towers and tall midrises carry `mech: true` and get a mechanical penthouse
  over 40 m; `stoneTower` has setbacks and a stepped crown on 79 of 136. "Flat
  parapet is plain" is a style decision, not a defect.

## World sweep + outlier repair — 2026-09-06 (`0e8d347` … `94fba71`)

Three commits. The first replaces the instrument; the other two are what it
found in its first run.

| commit | change | effect |
|---|---|---|
| `0e8d347` | a deterministic 49-view world sweep | the detector stops being the limit |
| `736e2a8` | the shoreline is planted | 58% of it was bare |
| `94fba71` | road stamping is cut AND fill | Charlestown's roads get ground under them |

### Why the instrument changed

The hand-picked shot list reached thirteen cameras and all thirteen passed. Five
consecutive passes had ended in "suspicious visual -> investigation -> already
correct", and the last one had to retire three standing priority-list entries
that measurement contradicted. That is a saturated detector, not a finished
world. The sweep samples 49 viewpoints derived from production geometry —
street 14, junction 10, park 8, traffic 6, skyline 6, water 5, no district over
22% — so a defect can no longer hide in the 99.9% of Boston nobody aims a
camera at. Protocol and traps are in CONTRACTS.md.

It paid for itself on the first run.

### What it found

**The shoreline.** The four least-detailed views out of forty-nine were all
waterfront, mean gradient 0.029-0.037 against a street median of 0.071. Measured
over 2,130 stations 12 m inland, 58% of Boston's shoreline had no park, no
district, no road and no parcel on it. Now planted from the authored water
rings, into existing batches: vegetation 74,412 -> 86,180, batches 19 -> 19, no
new draw call, material or texture.

**Charlestown's roads.** A junction camera came out standing under a grey slab
10 m below the street. `unstick` reported zero movement for all 49 viewpoints,
so it was not a camera inside a building — the nearest road was 5.9 m away, not
bridged, and 10 m overhead. `stampRoads` only ever LOWERED terrain, which is
right for a cut and useless for an embankment.

    |road - ground| > 3 m    153 -> 102 of 5,903 samples
    |road - ground| > 6 m     88 -> 37
    Bunker Hill Street worst 13.5 -> 8.2 m

### Ruled out, with the measurement

- **Triangle "budget violations".** Sweep rows of 5.0M looked like a 43%
  overshoot. At `street_12`, shadows are **56.8%** of that; camera-only is
  2,194,298. Not a violation. See CONTRACTS.md.
- **Park lawn coverage.** 0.6% of park area is bare, Boston Common 96.0% lawn.
  The khaki plane in one park frame is road at a grazing angle.
- **935 unnamed meshes carrying 40% of a frame's triangles.** Traffic-vehicle
  part meshes and building chunks. Scene organisation, not a defect.
- **Night and rain.** Rain clips nothing at all — dark 0.000 and blown ~0 across
  five views. Night means 0.18-0.34, no grey collapse.

### Left alone deliberately

Pavement and facades wash out under street lamps at night; one view clips 2.1%
of its frame. That is tone mapping and exposure, which are closed, and the light
pool is frozen. Recorded, not touched.

### Production gate

Passed at every source commit: 26 systems, 22 optional, `Missions.js` missing,
`failed []`, `errors []`, `glFaults []`, `validate().ok`, `npm run build:pages`
clean. Regression sweep over Charlestown plus a ten-view spread after both
fixes: draws 90-843 (budget 1200), nothing anomalous, and the junction that
found the terrain bug now reads as an ordinary street.

### Remaining top 10 SAFE priorities

1. Night exposure under street lamps — CLOSED territory (tone mapping), listed
   only so the next sweep does not re-find it as new.
2. Open ground beyond the 24 m shore band is still bare. That is the deferred
   outer-world gap, and it needs street geography, not planting.
3. The remaining 102 road/ground steps are mostly the CUT direction, where the
   hill genuinely towers over a road below it. Real Charlestown.
4. Park walk width hierarchy: the Esplanade promenade uses the same 3.4 m as an
   inland diagonal. Tuning, no measured defect.
5. Park hedge density is floor-bound in the smallest parks.
6. Vehicle bumper rounding; bus glazing bay rhythm.
7. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.
8. `payStation` shares the `meter` budget key, so ~9% of metered street faces
   draw a pay station, lose the roll, and end up with no kerbside equipment.
9. Mid-distance LOD 2 shells read flatter than the LOD 1 tier around them.
10. The sweep itself: 49 views is enough to find systemic defects and too few to
    catch rare ones. Widening it is cheaper than any single fix on this list.

## Expanded sweep + regression baseline — 2026-09-06 (`c04612b` … )

The 49-view sweep found two systemic defects on its first run, which made
coverage the limiting factor. This triples it, gives it a durable baseline, and
uses it.

| commit | change | effect |
|---|---|---|
| `c04612b` | the sweep grows to 126 views | +`local` and `special`, poses stop drifting |
| `d706689` | embankment fill estimated per segment | spec chain 1,091 → 783 ms |

### The instrument

126 viewpoints — street 35, junction 22, local 15, park 14, traffic 12,
skyline 10, water 10, special 8 — no district over 17%, all 126 validating with
`unstick` moving zero of them. Two structural changes matter more than the
count:

- **Poses are terrain-independent.** Absolute Y made the canonical set drift
  under the world; the embankment fix had moved ten of the first forty-nine
  cameras, one by 11.3 m.
- **View clearance is checked at generation.** A pose aimed into a parcel within
  26 m is rejected, because `unstick` would otherwise silently RETREAT the
  camera — it was moving one Post Office Square camera 50 m.

Baseline schema, tolerance policy and the reasons there is no exact frame digest
are in CONTRACTS.md.

### What the 126-view daylight pass found

Nothing of the size of the last two. The strongest signals resolved as:

- **13 of 50 street/local views have under 8 buildings within 70 m, 4 have
  none.** Attributed: Constitution Road and North Washington Street in
  Charlestown, plus Charles Street South beside the Common. That is the
  deferred street-graph and parcel gap, not a repairable defect.
- **`park_03` has 14 props against a park median of 241.** The Esplanade shore
  walk — a 1.5 km linear park far from any street. The frame reads as finished
  riverside public realm. Correct, not sparse.
- **High `nVeg` outliers** (up to 778 against a street median of 90) are the
  shoreline planting from the previous pass, landing where it was meant to.

### Dusk and rain

Dusk, 14 views: mean 0.283, clipped-white median 0.0015 and worst 0.0064,
crushed-black median 0.0089 and worst 0.029. No low-sun blowout.

Rain, 12 views: mean 0.294, **crushed-black median AND maximum both 0.000**,
clipped-white median 0.000 and worst 0.0052. No wet glitter.

Condition matrix for the pass: 126 daylight + 25 night + 14 dusk + 12 rain =
177 captures.

### Night washout — attributed, and closed

A 25-view night subset stratified by lamp family shows no family and no context
repeating: cobra median 0.0002, acorn 0.0004, twin 0.0010, worst view 0.0081.
Re-measured at the coordinate of the 2.1% view that triggered this, `blown` is
now 0.0000, and its forward probe is 12.4 m where the flagged capture had a bus
shelter 1.4 m from the camera. One near-field object catching a lamp.

Per the decision rule: isolated, so documented and left alone. **Global
exposure, tone mapping and B1/B2 remain closed.**

### Road/ground residual, classified

C bridge/tunnel 212 (60.7%), B another road's stamp 88 (25.2%), D still-invalid
45 (12.9%), A legitimate cut/embankment 3, E sampling artefact 1. D is 45
samples of about 4 m on Rutherford Avenue, against 13.5 m shelves before the
fill. Not a fill underestimate and not water-guarded. Left alone deliberately.

### Shoreline follow-up — closed

The previous pass took vegetation 74,412 → 86,180. Ten waterfront views at
8-12 per district context show bank coverage present, no water intrusion, no
skyline obstruction and no repetition worth acting on. Not extended.

### Remaining top SAFE priorities

1. Widen the sweep again, or add a second condition pass to it. 126 views found
   no new systemic defect, which is either good news or a coverage ceiling, and
   only more coverage distinguishes those.
2. `payStation` shares the `meter` budget key, so ~9% of metered street faces
   end up with no kerbside equipment.
3. Vehicle bumper rounding; bus glazing bay rhythm.
4. `_clipParcel`'s one non-convex/sliver footprint per ~3,350 parcels.
5. Mid-distance LOD 2 shells read flatter than the LOD 1 tier around them.
6. Park walk width hierarchy and hedge density floor — tuning, no measured
   defect behind either.

## Dynamic traversal sweep — 2026-09-06 (`b45d2e7` … )

The static instrument was saturated: 126 settled views over four conditions
found nothing new. Movement is the other axis, and it found one real defect and
a great deal about the instrument.

| commit | change | effect |
|---|---|---|
| `b45d2e7` | views get world-derived ids | a per-view baseline becomes possible |
| `f257aa4` | hedge far LOD is a real simplification | -383,212 triangles a frame |
| `b35db48` | the traversal sweep, and its speed | 23 routes, 3,946 samples |

### The one real defect

`veg_hedge` had two LOD levels that were both `buildHedge(seed)` with only the
SEED differing — 70 triangles either side of the 85 m switch, against
`veg_shrub`'s honest 52 -> 18 and `veg_shrub2`'s 60 -> 20. The far tier bought a
second geometry, a second mesh and a second draw call, saved nothing, and
changed the silhouette at the boundary because the seed moved. 10,335 instances.

Fixed by giving `buildHedge` a card count and sharing the seed. Same camera,
same instance split (330 near / 618 far): frame triangles 4,793,902 ->
4,410,690, draws 702 -> 696, the two frames indistinguishable.

**Correction to `f257aa4`'s message:** it says `veg_hedge` was the loudest
`lodJump` source. It was not — every `lodJump` event was `veg_shrub`, which is
not in the watch list by name. The hedge was found by reading the LOD ladder of
every vegetation batch, which the sweep prompted but did not itself report.

### Everything else was the instrument

    events            310 -> 17        drawJump      209 -> 0
    unsettled mean   ~24% -> 0.9%      worst route  83.8% -> 8.3%

Three sampler faults, each caught by disbelieving the first result:

- **Speed.** 2 frames per 6 m sample is 3 m/frame — 648 km/h. `Buildings` is
  behind for 82.5% of Harrison Avenue at that velocity and 10% at 50 km/h.
- **Transients.** Stepping two extra frames at the same cameras made every
  `drawJump` vanish; they were chunk-rebuild frames.
- **Slope vs step.** Eleven ground "steps" were Bunker Hill Street descending
  16 m over 24 m.

### Preset contract — clean

Instances scale to 0.57 of high at medium and 0.35 at low, consistently across
street, junction and park; triangles 2.37M -> 1.47M -> 0.93M; SSAO off and
cascades 3 -> 2 at low; no class disappears; `errors []`, `glFaults []`,
`validate().ok` at every preset.

### Remaining SAFE priorities

1. Widen the dynamic route set, or add night/rain conditions to it. 23 routes at
   realistic speed produced 17 events; more coverage is the only way to know
   whether that is a clean world or a small sample.
2. `veg_shrub` LOD is chunk-granular, so a 96 m block swaps together. A real
   ladder, but `splitNear` (already used by parked cars) would make it
   per-instance if it ever reads as a pop.
3. `payStation` shares the `meter` budget key, so ~9% of metered faces get no
   kerbside equipment.
4. Vehicle bumper rounding; bus glazing bay rhythm.
5. `_clipParcel`'s one sliver footprint per ~3,350 parcels.
6. `setQuality` accepts an unknown preset name silently.

## Night + rain traversal — 2026-09-07 (`a6697e4` … )

Baseline `86182f2`. The dynamic axis got conditions, and the instrument got the
two things it needed before conditions could mean anything.

### Preludes

**Per-view static baseline.** The previous pass gave every viewpoint an identity
derived from its source object and stopped there, leaving the committed file as
category p10/median/p90. There are now 126 rows carrying pose, groundY, roadDy,
camera-only draws and triangles, shadow share, static neighbour counts,
luminance, detail, flatness and a 4x3 tile summary. No frame digest.

The rows reached the repo without passing through a conversation. A previous
pass abandoned this as too risky to transcribe by hand and was right; the
browser now POSTs to a local sink and Node builds the file from the bytes on
disk, in chunks, so an interruption costs a chunk rather than a pass.

**No traffic column.** It was designed, measured, and the measurement was of the
wrong thing: traffic is spawned in a ring around the CAMERA — with the camera
parked at one view, all 96 active cars lay within 332 m of it and 86 within
300 m — so counting cars near a view the camera is not standing at returns zero
by construction, which it did for 123 of 126 views. Vehicle density belongs on
the drive routes, which follow the carriageway.

**Speeds, from source.** `Player.js SPEED = { walk: 1.45, jog: 3.40,
sprint: 6.30 }`; `Navigation.js PROFILE[type].speed = 27.0 / 13.4 / 11.2 / 6.7`.
The previous pass called its pedestrian routes realistic walking at 18 km/h.
18 km/h is neither: it is above `jog` and below `sprint`. `routes.mjs` had asked
for 1.5 m/s and the RUNNER clamped frames-per-sample to 24, which on a 2 m step
is 5 m/s regardless of what was requested. The runner's own `kmh` field had been
reporting it correctly the whole time.

Every route now carries the NAME of its class and the constant behind it, the
runner records the speed it ACHIEVED, the cap is 240 frames and says so when it
binds, and drive speed comes from the road class rather than one global 14 m/s.
Checked against the live sim, not just the constants: 96 active cars measured
p10 3.05, median 10.38, p90 12.74, max 15.35 m/s.

**The previous batch stands.** Re-run at corrected speeds, all 23 routes,
daylight: `lodJump` 11, `groundKink` 3 (all Bunker Hill Street), `roadShelf` 3,
`drawJump` 0 — identical counts to the previous pass for every trigger that
existed then. Streaming improved, because pedestrians now move at 3.40 m/s
instead of 5.0: unsettled mean 0.9% -> 0.67%, worst 8.3% -> 2.9%. Only the
label was wrong. The drive results were never affected: 15.0 m/s against an
arterial's 13.4 is 12% fast, inside the spread of real traffic.

### Night — 12 routes, tod 22, no defect

Coverage: cobra-lit arterial, vehicle-heavy corridor, heritage pavement,
financial-district pavement, dark residential street, park path, waterfront
promenade, two junction sequences, curve, grade, bridge approach. Lamp families
seen, in both taxonomies the project uses: `cobra-led` and `acorn-led`.

| | night, 12 routes |
|---|---|
| clipped-white p90 | 0 on 10 of 12 routes, 0.01 on two |
| crushed-black p90 | <= 0.04 everywhere |
| `nReal` (real pooled lights) | **15 on every route, at every percentile** |
| `realSum` p50 | 1186 - 1338 |
| unsettled | 0 - 5% |
| errors / GL faults | 0 |

`LightManager` re-aims a FIXED pool of 15 real lights at the most important
sources near the camera each frame and stands the rest in with additive proxies,
which is the one lighting mechanism that only exists while the camera moves. It
does not misbehave: the pool is **saturated at constant total intensity** for
every night route, so re-aiming produces no brightness step. There is always
another strong candidate to take a freed slot.

Two `clipJump` events in ~480 night samples, **both transient** — 0.0002 ->
0.0419 -> 0.0002 in one case — both `cobra-led`, both the near-field-object
signature already attributed for the static washout. Per the standing decision
rule: isolated, not repeated across families or contexts. **Global exposure,
tone mapping and B1/B2 remain CLOSED.**

### No exposure pumping, measured rather than assumed

18 sustained luminance steps looked like pumping. They are not. `probeLuminance`
gives the meter's adapted log2 value and the scene BEFORE it; on
`walk:sidewalk:e247` the **scene moved 4.19 stops while the meter moved 1.25**,
which is `AutoExposurePass` deliberately under-following a darkening exactly as
its own comments describe. Frame p90 scene luminance reaches **-0.16 log2** when
a lamp fixture enters frame, and `blown` never exceeds 0.0008 with `dark` peaking
at 0.065. The output is not clipping; the frame mean is following the scene.

That telemetry is now part of the runner (opt-in, because the readback stalls
the pipeline), and `exposureJump` fires only when the meter moves and the scene
does not — the only version of the event that is a defect.

### Rain — the real finding

Wetness is a single global scalar applied through `Assets.setWetness`, which
iterates the Assets REGISTRY. Three places clone a library material to turn on
vertex colours — `City._terrainMaterial` and both of `Districts`'s surface
builders — and a clone is not in the registry. So six surfaces carried the
wetness opt-in and could never receive it.

Measured at wetness 0.9, before the fix:

| surface | was | table wants |
|---|---|---|
| `ground_terrain` (110,152 tris, 3 meshes) | 0.99 dry | 0.477 |
| `park_surface_lawn` | 0.96 | 0.591 |
| `park_surface_plaza`, `park_path_paved` | 0.97 | 0.367 |
| `park_path_stone` | 0.99 | 0.477 |
| `park_path_edge` | 0.95 | 0.365 |
| registry `asphalt`, for comparison | **0.331 correctly wet** | 0.331 |

The carriageway darkened and sheened in rain and the ground it runs across did
not, with a step at every kerb and every park path edge.

Found by auditing what is NOT in the registry, not by looking at a picture. An
earlier pass of the same audit counted only materials that were *unstamped* and
found exactly one (`trimDark`); these six are stamped, because they were cloned
from stamped sources, so the right predicate was registry membership.

`Assets.variant()` registers the clone and re-derives its dry colour — which
matters because `userData` comes through `clone()` as JSON and
`THREE.Color.toJSON()` returns a bare hex number, so `wetnessColor` arrived as a
number rather than a Color, and recorded the SOURCE's colour anyway.

Magnitude, same frame, only these six reverted: a park framing moves mean
luminance 0.265 -> 0.3226, **+21.7%**. A street framing moves +0.0% and a local
street +0.1%, because what you see of the ground on a street is road and
pavement and both were already registry materials. At wetness 0 the state is
identical to before, so dry daylight cannot have moved. No response was
invented — these surfaces get the response their own family already had.

**Rain state is otherwise coherent.** After a full rain traversal, all 20
wetness-capable registry materials sat exactly where the current wetness implies
(zero mismatches), and the registry did not grow during the traversal, so
streaming cannot produce an un-wetted surface. No wet -> dry -> wet, no sheen
reset, no material bank mismatch. Rain at night, 8 routes: crushed-black p90
**exactly 0 on every route**, clipped-white p90 0 on 7 of 8.

### `holdActors` was discarding the requested weather

`PAUSE_IDS` put `weather` alongside traffic, vehicles and peds, and
`capture({holdActors: true})` keeps that set frozen through warm-up. But
`Weather.update` is what applies the preset the caller just asked for.

Controlled A/B, identical call but for the flag: `holdActors: false` gave
wetness 0.900, rain 0.720, asphalt 0.331. `holdActors: true` gave **0.000,
0.000 and 0.970** — a clear dry day wearing the rain preset's name. Any
held-actor capture of any weather preset was measuring clear weather.

Weather is not an actor. Actors are the things whose POSITIONS make two captures
differ; Weather's update is already deterministic under a frozen clock, snapping
the preset blend and the wetness ramp instead of easing them, precisely so a
capture does not photograph a half-applied condition. It is now released even
when actors are held: both paths give 0.900 / 0.720 / 0.331 with traffic still
paused.

### The static regression could not be run, and that is a finding

126 views re-swept dry at tod 11 produced 217 tolerance violations — uniformly
brighter (+0.03 to +0.06 mean) and flatter (-0.008 to -0.015 detail) across all
eight categories, including `water` and `skyline`, which contain none of what
changed. It is not a regression. The captures did not finish:

| | baseline run | regression run |
|---|---|---|
| `settledFrames` p50 | **15** | **153** |
| views at the 180-frame cap | 2 | 55 |
| `camTris` p50 | 1,338,784 | 1,226,319 |

`Buildings._drain` spends a **wall-clock** millisecond budget per frame (6 ms,
24 during boot, 50 after a teleport), so how much of the world streams per frame
depends on machine load. Under memory pressure the settle loop runs out of
frames, the shot is taken mid-stream, and the buildings in it are LOD-2 shell —
pale and flat, and lighter in triangles.

Confirmed by A/A rather than argued: the same 12 views captured twice
back-to-back, same code, hit the settle cap on 10 of 12 in **both** repeats and
moved `mean` by up to **0.0797** against a tolerance of 0.06. The instrument
could not reproduce itself, so it could not detect a regression either way.

`baseline.json` is schema 3: every row is stamped with the `settled` cost it was
captured at, and pixel fields are comparable only for a row that CONVERGED. The
committed baseline was captured healthy — median 15 frames, 2 of 126 capped.
The sweep now records `converged` and `streamDone` per row.

**What can be asserted about the three source changes:** they are provably inert
at wetness 0, measured directly on material state (asphalt 0.97, ground 0.99,
wetness 0), and they add only material registration — nothing touches streaming
or the shading of unrelated surfaces. The rain magnitude was measured in a
single frame with only the six surfaces reverted, which isolates them from load
entirely. A clean full-sweep regression is owed on a healthy machine.

### Not run

Dusk. All three resource stop-conditions were met — free memory 38% -> 31%,
swap used 3.9 -> 5.3 GB with the swap file itself resized 5 -> 6 GB, and runtime
degraded to where the capture instrument no longer reproduced itself. Running a
condition sweep whose luminance numbers could not be trusted would have produced
data worth nothing. B2 remains closed.

### Remaining SAFE priorities

1. Re-run the 126-view static sweep on a healthy machine and confirm the three
   source changes against the schema-3 baseline. This is owed, not optional.
2. Dusk dynamic subset, 4-6 routes, once the machine can converge a capture.
3. `headJump` fires 38 times at night on a threshold of >2 headlights; cars
   entering and leaving a 120 m radius at 48 km/h routinely change the count by
   3-4. Either widen it or key it to screen-space size.
4. The real-light pool is saturated at 15 with `nAct` up to 141 near a junction.
   Nothing misbehaves, but the *selection* is never tested against a case where
   a genuinely important light loses its slot.
5. `veg_shrub` LOD is chunk-granular, so a 96 m block swaps together.
6. `payStation` shares the `meter` budget key, so ~9% of metered faces get no
   kerbside equipment.
7. Vehicle bumper rounding; bus glazing bay rhythm.
8. `_clipParcel`'s one sliver footprint per ~3,350 parcels.
9. `setQuality` accepts an unknown preset name silently — and `Materials.get`
   accepts an unknown material name almost as silently, warning once and
   returning a generic `_fallback`, which is how the first attempt at the
   `trimDark` fix put every vehicle's dark trim on the fallback material.

## Owed regression + vehicle acquisition audit — 2026-09-07 (`7126b5c` … )

Baseline `9d18d7b`.

### The owed static regression passes, and the previous diagnosis was wrong

126 views re-swept dry at tod 11: **123/126 converged**, settled median 18
against the baseline's 15, **zero count or geometry violations** — camDraws,
camTris, nProps, nVeg and nBuildings all inside tolerance on every view — and a
mean luminance bias of **-0.0007**. Twelve pixel deltas remained, all
single-field.

Those twelve are benign dynamic, by repeat capture rather than assertion:
`junction:n9:e8` read 0.4492 / 0.4497 / 0.4487 against a baseline of 0.4498 and
then 0.4124 with its top-right tile dropping 68 -> 36; `street:e8` oscillated
0.392 / 0.363 / 0.376 / 0.395 with that tile flipping 80 / 59 / 62 / 80, the
baseline inside the range. Moving occluders in one tile, with actors live.

So trimDark adoption, the six cloned ground/park wetness variants and releasing
weather from `holdActors` introduce **no static regression**.

**The 217 violations of the previous pass were the browser pane, not the code.**
It had collapsed to 302x36 CSS pixels: drawing buffer 453x54, camera aspect
**8.389**. Two independent failures follow and neither raises an error.

`fov` is VERTICAL, so the horizontal field is a function of aspect — at 8.4:1 a
street view frames a different scene than at 16:9, which is why one view read
0.233, 0.368 and 0.483 across three runs. Three different pictures.

And convergence becomes arithmetically impossible. The settle loop watches six
band means with a threshold of 0.05 on a 0..255 scale, relying on the band
average to cancel film grain at ~2.3 luma/pixel: 24,750 samples per band at
1920x1080 gives a frame-to-frame sigma of 0.021 and 2.4x of headroom, while 325
samples at 453x54 gives 0.180 — 3.6x the threshold. Grain alone runs the loop to
its cap every time, which is what 8/8 views did.

The previous pass blamed the wall-clock build budget in `Buildings._drain` under
memory pressure. The field added at the end of that pass disproves it: every
unconverged row also reported `streamDone: true`. Streaming had finished, and
held at one view the frame was stable to 0.001 with the adapted exposure pinned
at -4.000.

`viewportCheck()` now runs once per sweep and warns with the numbers; every row
carries buffer, aspect and `viewportOk`; `baseline.json` is schema 4 recording
the viewport it was captured at.

### Vehicle acquisition works, and is now discoverable

`Player._tryEnterVehicle` -> `Traffic.nearestCar` -> `Traffic.takeOver` ->
`VehicleFactory.spawn` was audited end to end in the running game.

**Takeover continuity is exact.** Five of six trials across stopped, slow and
normal-speed cars and across sedan, SUV, van and truck: position delta
**0.000 m**, heading delta **0.00 deg**, type and colour matched, the kinematic
car removed as the physical one appears. Momentum carries — `linvel` 12.00
immediately for a car doing 12.09, clamped by `takeOver`'s 12 m/s cap, with
`v.speed` catching up one frame later.

The sixth trial got a different car 4.0 m away: `nearestCar` is nearest by
distance and ignores facing, so with two cars close together the player can get
the one he is not looking at. Recorded, not fixed.

**Driving works.** Real `KeyW` through the normal routing drives the car
(0 -> 4.27 m/s), and `setPlayerVehicle` is wired through the bus at
`VehicleFactory._onEnter` — an earlier grep that excluded that file suggested
otherwise and was wrong. Road-following runs with real keyboard input reached
54 km/h and stayed on the carriageway (roadDist 0.1-11 m, zero samples beyond
16 m), across park, backBay and financial, with `errors []`, `glFaults []`,
`validate().ok` and a chase camera throughout.

**Exit is safe.** 28 lane-centre spots across arterial, street, alley and
highway: no building intrusion, worst height drop 0.61 m, exit always 1.75 m
from the car. Ten bridged edges: **10/10 stayed on the deck**, drop 0.56-0.60 m,
so `surfaceHeight(x, z, carY)` does its job and nobody falls to the street
below. Eight alleys hard against the left kerb: 8/8 clear.

Twelve kerb-side street exits found one — Marlborough Street edge 16 — where
`unstick` reports the player inside a building footprint and would move him
10 m. Measured in gameplay rather than by the oracle: he is grounded, is not
pushed by the solver, and walks away at 3.16 m in 1.5 s against an expected 5.1.
Back Bay brownstone footprints include rear yards, so the oracle overstates it.
Impeded, not blocked, and no exit-position search was added for it.

**Discoverability, measured.** From a standing start on 9 pavements the nearest
AI car was a median 61.9 m away, but standing still for six seconds brought one
to a median closest approach of **6.0 m**, and 5 of 9 spots put a car inside the
6.2 m reach within 3 seconds. Acquisition on any through road takes seconds, so
no dedicated spawned car is warranted. Quiet back streets need a walk to a
bigger road.

The HUD had no prompt of any kind, so the mechanic was undiscoverable. There is
now one restrained line driven by `Player.enterCandidate()` — the same call `F`
makes, so it cannot promise what the key will not deliver.

### Abandoned cars: three bugs behind one symptom

`Traffic.takeOver` is the only thing that ever spawns a physical vehicle and
nothing ever removed one. Twelve consecutive thefts: `list` +1.00 each, rigid
bodies +1.00, LightManager sources +4.33, never a despawn. `despawn()` was
already complete — it had no caller.

A reaper alone reclaimed almost nothing: 24 thefts still left 21 vehicles.
Instrumenting the reject reasons said all 32 candidates were "still moving", and
they were: a median 2.7 km behind the player, every one rolling at 2-5 m/s with
`isSleeping()` false, level and on the ground, indefinitely.

Two causes. `setInput` PERSISTS and nothing calls `_readInput` for a car that is
no longer `playerVehicle`, so it keeps whatever the player last held — step out
at full throttle and it drives itself across the city with the steering locked.
And neutralising the input is not enough: the clutch deliberately slips near
idle so a car creeps away from rest instead of stalling, which is right while
someone is driving and wrong the moment they get out. Linear damping of 1.4 did
nothing, measured flat at 2.3 m/s across 720 frames, because the drivetrain
replaced the energy every step.

`Vehicle.park()` — neutral, no input, no auto upshift — is what actually stops
it, without the brake lamps a handbrake input would leave burning. Measured:
abandoned at 12.05 m/s with the throttle held, it rolls 3.25 -> 0.84 -> 0.10 ->
0.00 and the body is asleep by frame 240; re-entering restores gear 1 and it
drives away at 5.16 m/s.

With cars that come to rest the lifecycle works: soft cap 8, hard ceiling 14,
and four invariants in both passes — never the player's car, never one moving,
never one in the view frustum, never one closer than 45 m. Cross-map loop, 15
thefts with the player driving between them: `list` plateaus at **8**, bodies at
~65, light sources at 4040, 5 of the 8 asleep.

Two tiers because the brief's own constraint makes a strict cap impossible:
"never delete a vehicle currently visible, occupied or moving materially" means
that if every car is near and on screen, none may go. Traffic spawns around the
camera, so joyriding one district left 24 thefts' worth of cars all inside the
protection radius.

### OWNER DECISION — the player's car can high-centre and never move again

Three independent road-following drives with real input all ended the same way
within 200-260 m: the car stops and **no input recovers it**. Measured on the
stuck car at (120.7, 348.6), 8.7 m from an arterial centreline:

- full throttle: engine **6279 rpm**, speed **0.00**;
- reverse: gear engages at **-1**, car moves **0.04 m**;
- steer-out plus throttle: **0.04 m** total.

Not wedged against anything. Only three colliders within 3.2 m — its own, and
the two world static trimeshes. The wheels say why:

| wheel | contact | suspension | omega |
|---|---|---|---|
| 0 front | **false** | 0.340 (full extension) | **46.8** |
| 1 front | **false** | 0.340 (full extension) | **46.8** |
| 2 rear | true | 0.202 | 0 |
| 3 rear | true | 0.173 | 0 |

The driven axle is in the air with the rear planted, so every newton-metre goes
into wheel spin. Ground normals are 1.0 throughout — it is balanced on flat
geometry, not a slope.

This sits on the do-not-reopen list twice over — core tyre model and world
collision — and a fix is a real design decision (a torque path to whichever axle
has grip, or an anti-high-centre nudge), so it is **left for the owner**.

The consequence is bounded rather than a soft lock: `F` still exits, and after
this batch the stranded car parks, sleeps and is reclaimed by the reaper. The
player loses a car, not the session.

### Parked cars: promotion is feasible, the blockers are ownership

Parked cars are `PropBatch` instances, ~17,282 of them, with one oriented cuboid
each on a **single global fixed body** built in one 98.5 ms pass, filtered
PROP -> CHARACTER only.

The encouraging half: `PARKED_MIX` already maps each prop name to a
VehicleFactory type and a colour index — `['carSedanA', 'sedan', 0]` — so type
and colour identity are recoverable with no new plumbing, and instance
transforms are readable from the batch's baked `mats`.

The blockers, precisely:

1. **No instance -> collider mapping.** `_buildCarColliders` keeps a count
   (`this._carColliders = made`) and nothing else. Suppressing one car's
   collision means retaining 17,282 handles or rebuilding the body — a ~100 ms
   hitch per theft.
2. **No per-instance suppression that survives `refresh()`.** `mats` is
   authoritative and LOD re-selection rebuilds per-chunk instance lists from it
   whenever the camera crosses a 96 m chunk, so hiding one instance needs a
   suppression set consulted inside that hot loop — 99 batches, ~159k instances.
3. **Geometry differs.** A parked car is merged prop geometry, not
   `buildVehicleVisual` output, so a promoted car would change shape on entry —
   the one thing takeover continuity is supposed to prevent.

Both (1) and (2) are changes to PropBatch identity and instance ownership, which
this brief explicitly does not authorise. **Not implemented.** Moving-traffic
acquisition remains the V1 transport mechanic, which the measurements above say
is adequate.

### Remaining vehicle-gameplay issues

1. **High-centring immobilises the player's car** (above). Owner decision.
2. `nearestCar` ignores facing, so two cars close together can hand the player
   the wrong one.
3. Parked-car promotion, blocked on PropBatch instance ownership.
4. Abandoned cars are reclaimed only when out of frustum and beyond 45 m, so a
   player who never leaves one district can hold more than the ceiling. The
   invariants are deliberately absolute; this is the price.
5. `Player.ctx` is not the engine ctx and has no `input` on it, which is
   confusing enough that it cost a debugging cycle here.

## High-centring / drivability — 2026-09-07 (`e44719d`)

Baseline `5849852`. The authorised defect is a road/terrain collision seam, and
it is not where the symptom pointed.

### Reproduction, and what it disproved

Three deterministic runs with a road-following controller on a spawned sedan:

| context | result |
|---|---|
| Beacon Street, arterial | **642 m, not stuck**, 4 wheels down, roadDist 0.33 |
| Berkeley Street, local | **642 m, not stuck**, 4 wheels down, roadDist 0.56 |
| Rutherford Avenue, grade | **stuck at 133 m** |

So ordinary on-carriageway driving does not high-centre. And the stuck case had
the OPPOSITE wheel state to the reported one: all four wheels in contact, front
suspension nearly fully compressed at 0.038-0.043 against a 0.34 rest, omega ~0,
and eleven contact manifolds on static geometry — four of them on the terrain
heightfield itself. Not a car balanced on its belly; a car jammed against
invisible ground.

### Attribution

Read from the actual contacts and a downward ray per collider class, not from
nearest-collider distance. The world's statics are one HeightField (terrain),
64 TriMesh colliders (roads, pavements, buildings) and 15,960 parked-car cuboids.

At the five worst points the **topmost collider at the road centreline was the
terrain heightfield**, standing above the road:

| point | road y | terrain collider | above road |
|---|---|---|---|
| Beacon Street East | 11.843 | 12.399 | **+0.60** |
| Myrtle Street | 12.690 | 13.602 | **+0.93** |
| Chestnut Street | 13.954 | 14.711 | **+0.78** |
| Mount Vernon Street | 13.932 | 14.464 | **+0.55** |
| Prince Street | 8.499 | 9.035 | **+0.55** |
| flat arterial (control) | 4.276 | 3.876 | −0.37, topmost = road trimesh |

Swept over the whole network: **116 of 3,535 road samples, 3.28%, up to
1.016 m**, all on Beacon Hill and North End streets.

### Root cause

Two independent contributions, both about resolution rather than logic.

`stampRoads` is correct and idempotent — re-running it changes nothing, and on
flat ground it is exact, with Beacon Street sitting at precisely `roadY - 0.40`,
its own cap value. But the cap is applied per RASTER CELL and the raster is
10 m; where a Beacon Hill street changes grade inside one cell, the bilinear
surface between two correctly capped cells still rises above the road between
them.

And the collider was built at 300x300 over 6.8 km — **22.7 m per cell, 2.27x
coarser than the 681x681 raster it samples**. A 10 m road corridor can pass
between two vertices of a 22.7 m grid without either of them knowing.

### Fix

`Terrain.addCollider` builds at the raster's own resolution and cuts the
carriageway out of the **collision** ground. Collision only: the drawn hillside
is untouched, so there is no visual change anywhere. Corridor is
`halfRoad + cell` so both bracketing vertices are cut; depth 0.5 m; bridged
edges skipped.

Deepening `stampRoads` would also have worked and was the wrong place — that cap
reaches 11 m past the kerb and feeds the raster the ground MESH is built from,
so it would have trenched every street in the city. The driving surface under a
road is the road's own trimesh, measured covering 98%+ of carriageway samples.

**Result: 0 of 3,535 samples with collision ground above the road, at any
threshold down to 5 cm.** At the worst five points the topmost collider is now
the road trimesh, with the heightfield 0.50-1.13 m below the asphalt.

### Chassis and drivetrain: audited, left alone

The chassis collider is honest — its bottom sits at local 0.2339 against a
visible underbody at 0.215, slightly ABOVE the skin:

| class | drive | clearance at rest | at bump stop |
|---|---|---|---|
| sedan | **fwd** | 0.254 | **0.033** |
| suv | awd | 0.353 | 0.112 |
| pickup | awd | 0.391 | 0.144 |

The sedan is both the only FWD class and the one with a third the hull clearance
at full compression, which is why the symptom found it first. No drivetrain
change: a FWD car with both front tyres genuinely airborne SHOULD lose drive.

### Acceptance

21 trials, **6,354 m**, across Beacon Hill, North End, Charlestown, Back Bay and
the Financial District, in sedan, SUV, pickup and van. `errors []`,
`glFaults []`, `validate().ok`.

**Zero unrecoverable events.** Four trials stopped against obstacles; every one
had all four wheels in contact with normal suspension travel — none high-centred
— and every one was freed by ordinary reverse and steer, recovering 16.9 m,
25.3 m and 19.6 m. One of the four was not even reproducible on a second run.
The harness never reverses; a player does.

Before: three of three drives unrecoverable within 200-260 m, reverse moving
0.04 m, full throttle at 6279 rpm and 0.00 m/s.

Deliberate kerb mounts at 15, 35, 60 and 90 degrees on the sedan: all four ended
four wheels down with both driven wheels in contact, and all four drove out.

Transient single-wheel lift remains on the steepest streets and is speed-driven,
not geometric: on an 8.1% grade the driven axle lost contact 4 times at 13 m/s
with the car briefly fully airborne, and **0 times at 7 m/s with all four wheels
down throughout**. Prince Street keeps 6 events at both speeds with 2-3 wheels
still down — body roll on camber. None of it strands the car.

### Costs and the one trade-off

Collider build 32 ms -> 136 ms once at boot; height buffer 0.36 MB -> 1.86 MB.

Measured by A/B against a collider built without the cut: pavement samples more
than 25 cm below their drawn surface go **15 -> 17 of 3,024**, two samples,
0.07%. The worst case, 2.60 m on Beacon Street, is pre-existing and identical
with and without the cut. Two marginal pavement dips against 116 places that
stranded the player's car.

### Acquisition and lifecycle regression

on foot -> prompt -> commandeer -> drive -> stop -> exit -> park -> repeat,
twice: prompt shown, type and colour matched, drove at 13.4 and 12.8 m/s, exited
to `onFoot`, `parked` true with gear 0 and rest speed 0.000 and the body asleep,
fleet bounded at 1 then 2. `errors []`, `glFaults []`, `validate().ok`.

## High-centring closeout + cross-map acceptance — 2026-09-07 (`9a8a8cd` … )

Baseline `9a8a8cd`. Validation only — no source change was needed or made.

### Resources

Started at 27% free memory, swap 6.27/7.17 GB, load 25.96/24.85/54.44, so the
cheap physics regressions ran first. By the time the visual work began the
machine had recovered to **47% free, swap 4.95/6.14 GB, load 4.42/5.00/8.91**,
and the viewport check passed (1920x1080, aspect 1.778, settle sigma 0.0207
against a 0.05 threshold), so the sweep was run rather than deferred.

### Phase 1 — static pixel regression: clean

126 views, **125 converged**, settled median 24, viewport valid. **Zero count or
geometry violations** — camDraws, camTris, nProps, nVeg, nBuildings all inside
tolerance on every view. Mean luminance bias **+0.0004**, max |dMean| 0.0221
against a 0.06 tolerance. No systematic movement, which is the expected result
for a collision-only change.

15 pixel deltas remained, 14 single-tile and one `blown`. Classified by repeat
capture rather than asserted:

- `street:e212 tile9` — repeats 40/47/55/53, spread 15: **benign dynamic**.
- `special:bridge:e403 tile7` — repeats 25/25/25/25 against a baseline of 25:
  the sweep row was the transient.
- `park:commonwealth-avenue-mall-2 blown` — stable at ~0.009 against a baseline
  0.0284, i.e. **less** clipping than the baseline.
- `street:e8 tile3` (+13), `traffic:e56 tile2` (+10), `local:e246 tile6` (+14) —
  **stable and reproducible**, spread 0-1 across four repeats.

Those last three are not from this mission, and that is measured rather than
argued: capturing the same views with the carriageway cut ON and OFF gives a
**worst tile delta of 2** against a tolerance of 8, `dBlown` 0.0000 everywhere
and `dMean` <= 0.0042. **The collision cut is pixel-invisible, as designed.**
`traffic:e56 tile2` was already recorded as a stable offset in the previous
mission, so it predates this one; the most likely origin is the previous
batch's material adoption, where the ground and park variants became adopted and
so began receiving `_applyEnv`'s day/night envMapIntensity curve instead of a
value frozen at clone time. Small, stable, pre-existing, and not chased.

### Phase 2 — pedestrian collision: the cut HELPS

The important missing acceptance check, and it came out better than neutral.

Capsule penetration, A/B with the cut on and off over the three suspect
Charlestown crossings: **0 penetrating frames in both configurations**, max
single-frame fall 0.267 m with the cut and 0.129 m without. No fall-throughs.

An earlier metric reported three "fall-throughs"; it was wrong. `surfaceAt`
returns the hillside *beside* a road cutting as the surface at the player's
position, so a player standing correctly on a road 7 m below the adjacent
terrain reads as 7 m under the surface. The penetration test is the honest one.

Crossing success, same 14 steepest junctions, A/B:

| | with cut | without cut |
|---|---|---|
| crossed | **9 / 14** | 8 / 14 |
| max vertical step | **0.394 m** | **6.803 m** |

Edge 496 (Rutherford Avenue) crosses **only** with the cut, 0.86 m from target
against 11.4 m without. Edge 499 (Main Street Charlestown) had a **6.8 m
pedestrian vertical snap without the cut**, 0.166 m with it. The same protruding
terrain that jammed cars was stepping pedestrians.

40 junction crossings overall: 29 crossed, **Beacon Hill 8/8 and Back Bay 7/7**
— the seam district and the control both perfect. Failures are identical with
and without the cut and are medians, unauthored Seaport frontage, and the
kerbside parked-car line, which is solid to characters by design.

The 38 mid-block crossings are reported as invalid rather than failing: their
`closest` values cluster at `width - 1.4 m`, i.e. the player walked 1.4 m and
stopped at the kerbside parked cars. Correct behaviour, wrong test.

### Pavement edge samples

The two extra samples from the previous A/B (15 -> 17 of 3,024 more than 25 cm
below their drawn surface) fall into class **A/B, not C**: no penetration
anywhere in the A/B, the player remains supported, and the worst pavement case
in the city (2.60 m, Beacon Street) is pre-existing and identical with and
without the cut. Not fixed, not optimised toward zero.

### Phase 3 — cross-map vehicle exploration

**27 trials, 10.63 km**, sedan / SUV / pickup / van, across backBay,
beaconHill, cambridge, charlestown, fenway, financial, northEnd, park and
southEnd. `errors []`, `glFaults []`, `validate().ok`, and `streamDone` true on
every trial.

Stuck classification, six events, every one with **all four wheels in contact at
the stop** — none high-centred:

| class | count |
|---|---|
| A/C recoverable obstacle or cutting wall | 6 |
| **D unrecoverable terrain/collision** | **0** |

Five freed on the first recovery pattern. The sixth, Charlestown Main Street,
did not — and that was the recovery pattern, not the world: a thorough attempt
reversed it **10.09 m straight back** and then 8.02 m forward-right, 8.62 m
total, freed. Its stop state also explains the earlier pedestrian anomaly on the
same edge: `roadY` 18.18, `surfaceAt` returning a road deck at 12.23 and terrain
at 26.37 — stacked decks in a cutting beside the I-93 interchange, not a hole.

### Wheel lift, recorded and not chased

51 driven-axle contact losses across 10.63 km, concentrated on Beacon Hill
(Chestnut 7, Mount Vernon 7, Hanover 22) and always transient. Established as
speed-driven in the previous mission — 4 events at 13 m/s and 0 at 7 m/s on an
8.1% grade — and no trial that recorded lift became unrecoverable. Per policy,
recorded and left alone.

### Phase 4 — acquisition and lifecycle regression

Three full rounds, all clean: prompt shown, type and colour matched
(taxi/taxi, truck/truck, sedan/sedan), chase camera, drove, exited to `onFoot`,
then **parked true, gear 0, throttle 0, rest speed 0.000, body asleep**, fleet
bounded 1 -> 2 -> 3. `errors []`, `glFaults []`, `validate().ok`. Momentum
handoff carried on two of three rounds (6.96 -> 6.27, 2.29 -> 2.98); the third
read 0 from a car doing 26.71 m/s, measured seven frames after the swap, and the
previous mission measured the handoff exactly at 12.00 for a 12.09 m/s car.

### Phase 5 — dusk, owed and now run

5 routes at tod 19.4. `errors []`, `glFaults []`, `validate().ok`. Clipped-white
p90 **0 on four routes and 0.01 on the fifth**; crushed-black p90 <= 0.03;
unsettled 0-2.5%; the real-light pool saturated at 15 on every route, so lamps
are up and the fixed pool is full at dusk; both `acorn-led` and `cobra-led`
families seen. No `winJump` — building window emissive is continuous.

32 events, all in the classes already established as benign: headJump 14 and
ovlJump 8 are traffic and lamps crossing a 120 m radius. The seven luminance
steps are all on pedestrian routes within 3-7 m of a lamp, the same scene-content
pattern the night mission proved with `probeLuminance` (scene 4.19 stops, meter
1.25). One crushJump reaches 8.6% locally against a route p90 of 0.02.
**B2 remains closed.**

### PLAYER VEHICLE HIGH-CENTRING / INVISIBLE ROAD TERRAIN — DURABLY CLOSED

Static clean, pedestrian crossings clean and improved, 10.63 km with D = 0,
acquisition clean, no new world collision hole. Do not re-audit without fresh
gameplay evidence.

## Starting vehicle, entry ranking, map audit — 2026-09-07 (`ec19ed8` … )

Baseline `f884844`.

### The car the player starts next to

The player spawns on the Tremont Street pavement at the edge of the Common —
district `park`, on `pavement`, with Tremont the only road within 60 m at
11.8 m and a parking bay at offset 8.55. There is now one orange SUV parked in
that bay, 3.21 m in front of him.

Placement is searched rather than authored. Kerbside bays are ~94% full of
parked props, so `spawnStarter` steps candidate kerb points along the bay on the
player's own side and rejects any where the SUV's footprint would touch a PROP
collider, preferring a slot with room on both sides. The clearance test goes
through the physics world, not PropBatch instance data, which keeps it clear of
the ownership model this project has deliberately deferred.

Measured at the chosen slot: **5.18 m** to the nearest parked car against the
4.86 m its own length needs, 17.3 m to the nearest traffic car, 2.62 m to the
nearest street furniture and that on the pavement 0.38 m above it, `road`
surface, and **3.21 m from the player** — inside the 4.6 m enter range, so the
prompt reads "Enter vehicle" the instant the world loads. `enterCandidate`
reports kind `vehicle`, so F takes it directly and never calls
`Traffic.takeOver`. It settles to sleep at speed 0.000 with 0.004 m of drift.

**Colour, measured not chosen.** Four warm oranges rendered on the actual SUV in
the actual slot, sampled from the frame in four conditions:

| candidate | hue range | min sat | min val |
|---|---|---|---|
| `#e2621b` | 10.4-19.0 | 0.539 | 93 |
| **`#f07318`** | **13.0-24.4** | **0.557** | **97** |
| `#d9541a` | 6.5-14.6 | 0.526 | 91 |
| `#e87a22` | 14.9-29.0 | 0.523 | 94 |

`#f07318` chosen: highest minimum saturation and value, and a hue band clear of
both hazards — Boston's traffic reds sit at hue 356-357 and its one golden car
at 46.6. `#d9541a` reaches hue 6.5 at night, which is red.

**No local colour rule was added, because none is needed.** Within 60 m of spawn
there are 35 vehicles, 26 parked and 9 traffic, and zero are orange-like. That is
structural: across all 36 distinct fleet palette colours none has hue 10-45 with
saturation >= 0.45 and value >= 120, and Traffic's jitter scales all channels
equally so it can only move value. The invariant is recorded in CONTRACTS
against a future palette edit.

Lifecycle verified end to end: prompt at spawn, F enters, unparks to gear 1,
drives at 10.3 m/s, exit returns it to parked / neutral / throttle 0 / asleep, it
stays ordinary afterwards, and the fleet never duplicates it.

### Entry candidates: ranked

Two flaws, both found by testing rather than reading. `enterCandidate` returned
any physical vehicle in range **before looking at traffic at all** — caught in
the starter lifecycle test, where standing 2.4 m from a taxi with a car parked
4.5 m behind gave the parked car. And it ignored facing entirely.

Both kinds now compete on one scale, with facing as a bias:
`d * (1 + 0.9 * (1 - cos))`. Four deterministic cases pass — two cars 3.2 m
either side pick whichever is faced; a car 1.2 m behind still beats one 4.3 m
ahead; 2.6 m ahead beats 3.4 m behind — and a fifth confirms the ordering fix,
with a traffic car in range now winning over a physical vehicle at 4.4 m.

HUD and F share one function, re-verified rather than assumed: prompt,
`enterCandidate` and the car F actually entered agree in both facings.

### Map and minimap: audited, no defect, no change

Measured, not redesigned.

**Minimap** follows the player with a tracking error of **0 m** while driving
(player position tracks the vehicle exactly), heading follows `player.heading`
with shortest-arc smoothing, location is preserved across onFoot ↔ driving, and
a north-lock toggle exists.

**`M` opens a real full map**, not a placeholder: a canvas centred on the player
when opened, drag pan, wheel zoom, a scale readout, click-to-set waypoint with
live distance, a legend separating Highway / Arterial / Street / Water / Park,
district naming under the cursor, and a white heading-rotated player arrow drawn
over route, blips and waypoint pins. GPS routing already exists.

One reading looked wrong and is not: the `x 0  z 0` readout is the **cursor**
position (`_cursorWorld`), not the player, and reads zero only until the mouse
moves over the map.

No objective defect found, so nothing was changed.

### Owner product direction recorded

`AI_HANDOFF.md` §0b now carries two standing programmes — the **Northeastern
University hero district** with its six-point quality gate and the spawn
migration that follows it, and the **player hero character** ladder from
silhouette to face-last. Neither is started here. The same file's claim that
"heightfield resolution is not a problem and needs no work" is struck and
corrected against `e44719d`, which proved resolution was half the high-centring
root cause.
